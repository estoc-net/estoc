import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openNodeSqlite } from "@estoc/event-store/node";
import { canonicalize, parseStrict, type JsonObject, type VaultRuntime } from "@estoc/event-store/v3";
import { scanVault, vaultDraft, type Did, type DidId, type Keys, type MediationId, type MessageId } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { ENCRYPTED_MIME, secretsResolverFor, type IMessage } from "../../src/protocol/didcomm.js";
import { RECIPIENT_QUERY } from "../../src/protocol/mediation.js";
import { FORWARD } from "../../src/protocol/spec.js";
import {
  AgentTrace,
  EXPIRED,
  Keyring,
  MediatorLink,
  Outbox,
  createDid,
  ensureRoute,
  establish,
  openVault,
  pinnedResolver,
  prepare,
  reconcile,
  send,
  submit,
  type Content,
  type Prepared,
  type SubmitOptions,
} from "../../src/v3/index.js";
import { didcomm, directParty, newMediator, party, posting, refuseSubmissions, type Party } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const ALICE_ENDPOINT = "https://alice.example/didcomm";
const BOB_ENDPOINT = "https://bob.example/didcomm";

const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };

const accepted = (): Response => new Response(null, { status: 202 });

type Holder = { runtime: VaultRuntime; keys: Keys };

/** A message from `DID` to `to`, sent and prepared. */
async function queued(a: Holder, to: Did, messageId: MessageId, content: Content = HELLO, now: () => number = Date.now): Promise<Extract<Prepared, { outcome: "prepared" }>> {
  await send(a.runtime, a.keys, { peerDid: to, sender: { didId: DID } }, content, { messageId });
  const prepared = await prepare(a.runtime, a.keys, messageId, { didcomm, now });
  if (prepared.outcome !== "prepared") throw new Error(`not prepared: ${JSON.stringify(prepared)}`);
  return prepared;
}

async function envelopeOf(a: Holder, prepared: Extract<Prepared, { outcome: "prepared" }>): Promise<string> {
  return new TextDecoder().decode((await a.runtime.vault.objects.read(prepared.prepared.data.envelopeCid, 1 << 20)) as Uint8Array);
}

/** The envelope opened as its recipient opens it: with the recipient's secrets, and the sender's documents as the sender holds them. */
async function openedBy(recipient: Holder, sender: Holder, packed: string): Promise<JsonObject> {
  const ring = await Keyring.load(recipient.keys, await scanVault(recipient.runtime.vault, recipient.keys));
  const [msg] = await didcomm.Message.unpack(packed, pinnedResolver(await scanVault(sender.runtime.vault, sender.keys)), secretsResolverFor(ring.secrets()), {});
  return msg.as_value() as unknown as JsonObject;
}

/** A mediated party with its arrangement granted and one communication DID, `DID`, on a route over it. */
async function mediatedParty(mediator: Awaited<ReturnType<typeof newMediator>>, fill: number): Promise<Party & { did: Did; longFormDid: Did }> {
  const p = await party(mediator, fill);
  await establish(p.link, p.runtime, p.keys, p.mediationId);
  const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
  const { minted } = await createDid(p.runtime, p.keys, routeId, DID);
  return { ...p, did: minted.did, longFormDid: minted.longFormDid };
}

/** A trace like `trace`, but for the `diag.reconcile` entries, which `append` writes instead. */
function divertingReconcile(trace: AgentTrace, append: AgentTrace["append"]): AgentTrace {
  const diverted = Object.create(trace) as AgentTrace;
  (diverted as { append: AgentTrace["append"] }).append = (stream, what, data) => (stream === "diag" && what === "reconcile" ? append(stream, what, data) : trace.append(stream, what, data));
  return diverted;
}

describe("submit to a direct endpoint", () => {
  const fetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = () => Promise.reject(new Error("the network is off"));
  });
  afterEach(() => {
    globalThis.fetch = fetch;
  });

  it("the exact envelope is posted, its acceptance committed as submitted, the message closed and its envelope released; a second call posts nothing", async () => {
    const a = await directParty(1, ALICE_ENDPOINT, DID);
    const b = await directParty(101, BOB_ENDPOINT, DID);
    const prepared = await queued(a, b.longFormDid, MESSAGE);
    const envelope = await envelopeOf(a, prepared);
    const wire = posting(accepted);
    const trace = await AgentTrace.open(a.runtime.local);
    const result = await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, trace });
    expect(result).toMatchObject({ outcome: "submitted", messageId: MESSAGE, packageId: prepared.packageId });
    if (result.outcome !== "submitted") return;
    expect(result.submitted.data).toEqual({ messageId: MESSAGE, packageId: prepared.packageId });
    expect(wire.posts).toHaveLength(1);
    expect(wire.posts[0]).toMatchObject({ url: BOB_ENDPOINT, body: envelope, init: { method: "POST", headers: { "Content-Type": ENCRYPTED_MIME }, redirect: "manual" } });

    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.outbound.outbounds.get(MESSAGE)).toMatchObject({ submitted: true, outcome: "submitted", acknowledged: false, work: { kind: "none", because: "submitted" } });
    expect(fold.held.has(prepared.prepared.data.envelopeCid)).toBe(false);
    expect(await openedBy(b, a, envelope)).toMatchObject({ id: MESSAGE, to: [b.did], body: { content: "hello" } });

    const entries = await trace.read({ stream: "wire" });
    expect(entries.map((entry) => entry.type)).toEqual(["wire.out", "wire.in"]);
    expect(entries[0]!.data).toMatchObject({ via: "http", endpoint: BOB_ENDPOINT, messageId: MESSAGE, packageId: prepared.packageId });
    expect(entries[1]!.data).toMatchObject({ parent: entries[0]!.seq, status: 202 });
    expect(await trace.traceOf(MESSAGE)).toEqual(entries);

    expect(await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch })).toEqual({ outcome: "none", messageId: MESSAGE, because: "submitted" });
    expect(await prepare(a.runtime, a.keys, MESSAGE, { didcomm })).toMatchObject({ outcome: "none", because: "submitted" });
    expect(wire.posts).toHaveLength(1);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("an attempt that may succeed later writes nothing to the vault and posts the same bytes every time: a line cut, a refusal for now, a redirect, then the acceptance", async () => {
    const a = await directParty(1, ALICE_ENDPOINT, DID);
    const b = await directParty(101, BOB_ENDPOINT, DID);
    const prepared = await queued(a, b.longFormDid, MESSAGE);
    const envelope = await envelopeOf(a, prepared);
    const answers: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new Error("connection reset")),
      () => new Response("later", { status: 503 }),
      () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }),
      accepted,
    ];
    const wire = posting(() => answers.shift()!());
    const trace = await AgentTrace.open(a.runtime.local);
    const before = [...(await scanVault(a.runtime.vault, a.keys)).set.applied()].length;
    const reasons = ["connection reset", "the endpoint answered 503", "the endpoint answered 307"];
    for (const reason of reasons) {
      expect(await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, trace })).toEqual({ outcome: "retry", messageId: MESSAGE, packageId: prepared.packageId, reason });
      const fold = await scanVault(a.runtime.vault, a.keys);
      expect([...fold.set.applied()]).toHaveLength(before);
      expect(fold.outbound.outbounds.get(MESSAGE)).toMatchObject({ outcome: "prepared", work: { kind: "submit", packageIds: [prepared.packageId] } });
    }
    expect((await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, trace })).outcome).toBe("submitted");
    expect(wire.posts.map((post) => post.body)).toEqual([envelope, envelope, envelope, envelope]);
    const diagnostics = await trace.read({ type: "diag.delivery" });
    expect(diagnostics.map((entry) => [entry.data["messageId"], entry.data["packageId"], entry.data["phase"], entry.data["reason"]])).toEqual(reasons.map((reason) => [MESSAGE, prepared.packageId, "post", reason]));
    const attempts = ["wire.out", "wire.error", "wire.out", "wire.in", "wire.out", "wire.in", "wire.out", "wire.in"];
    expect((await trace.read({ stream: "wire" })).map((entry) => entry.type)).toEqual(attempts);
    expect((await trace.traceOf(MESSAGE)).map((entry) => entry.type)).toEqual(attempts);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("an expiry that passed fails the message instead of posting it; a message submitted before its expiry stays submitted after it, with no failure added", async () => {
    const a = await directParty(1, ALICE_ENDPOINT, DID);
    const b = await directParty(101, BOB_ENDPOINT, DID);
    const expiring: Content = { ...HELLO, expiresTime: 2_000 };
    const before = () => 1_000 * 1000;
    await queued(a, b.longFormDid, MESSAGE, expiring, before);
    const wire = posting(accepted);
    const expired = await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, now: () => 2_000 * 1000 });
    expect(expired).toMatchObject({ outcome: "failed", messageId: MESSAGE, code: EXPIRED });
    if (expired.outcome !== "failed") return;
    expect(expired.failed.data).toEqual({ messageId: MESSAGE, scope: "message", packageId: null, code: EXPIRED });
    expect(wire.posts).toEqual([]);

    await queued(a, b.longFormDid, SECOND, expiring, before);
    expect((await submit(a.runtime, a.keys, SECOND, { didcomm, fetch: wire.fetch, now: () => 1_999 * 1000 })).outcome).toBe("submitted");
    expect(await submit(a.runtime, a.keys, SECOND, { didcomm, fetch: wire.fetch, now: () => 3_000 * 1000 })).toMatchObject({ outcome: "none", because: "submitted" });
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect([MESSAGE, SECOND].map((messageId) => fold.outbound.outbounds.get(messageId)?.outcome)).toEqual(["failed", "submitted"]);
    expect(fold.set.of("delivery.failed").map((event) => event.data.messageId)).toEqual([MESSAGE]);
    expect(wire.posts).toHaveLength(1);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("an acceptance whose record could not be committed is recorded before anything else is done with the message: nothing is posted again, and no expired failure takes its place", async () => {
    const a = await directParty(1, ALICE_ENDPOINT, DID);
    const b = await directParty(101, BOB_ENDPOINT, DID);
    const prepared = await queued(a, b.longFormDid, MESSAGE, { ...HELLO, expiresTime: 2_000 }, () => 1_000 * 1000);
    const wire = posting(accepted);
    const trace = await AgentTrace.open(a.runtime.local);
    const late = () => 2_000 * 1000;
    refuseSubmissions(a.runtime, 2);
    await expect(submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, trace, now: () => 1_500 * 1000 })).rejects.toThrow("the disk is full for now");
    expect((await trace.read({ stream: "wire" })).map((entry) => [entry.type, entry.data["status"]])).toEqual([
      ["wire.out", undefined],
      ["wire.in", 202],
    ]);
    await expect(prepare(a.runtime, a.keys, MESSAGE, { didcomm, now: late })).rejects.toThrow("the disk is full for now");
    const refused = await scanVault(a.runtime.vault, a.keys);
    expect([refused.set.of("delivery.submitted"), refused.set.of("delivery.failed")]).toEqual([[], []]);

    const recorded = await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, now: late });
    expect(recorded).toMatchObject({ outcome: "submitted", packageId: prepared.packageId, submitted: { data: { messageId: MESSAGE, packageId: prepared.packageId } } });
    expect((await scanVault(a.runtime.vault, a.keys)).outbound.outbounds.get(MESSAGE)).toMatchObject({ outcome: "submitted", failed: null });
    expect(await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, now: late })).toMatchObject({ outcome: "none", because: "submitted" });
    expect(wire.posts).toHaveLength(1);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("one message is submitted by one caller at a time: a second call waits for the first, finds the message submitted and posts nothing", async () => {
    const a = await directParty(1, ALICE_ENDPOINT, DID);
    const b = await directParty(101, BOB_ENDPOINT, DID);
    await queued(a, b.longFormDid, MESSAGE);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const paused = new Promise<void>((resolve) => (release = resolve));
    const wire = posting(async () => {
      entered();
      await paused;
      return accepted();
    });
    const first = submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch });
    await started;
    const second = submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wire.posts).toHaveLength(1);
    expect((await scanVault(a.runtime.vault, a.keys)).set.of("delivery.submitted")).toEqual([]);
    release();
    expect((await first).outcome).toBe("submitted");
    expect(await second).toMatchObject({ outcome: "none", because: "submitted" });
    expect(wire.posts).toHaveLength(1);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("a runtime gone between the acceptance and its record posts the same package again once reopened; after the record is committed, no reopening posts it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "estoc-c05-"));
    try {
      const file = path.join(dir, "alice.sqlite");
      const a = await directParty(1, ALICE_ENDPOINT, DID, openNodeSqlite(file, { mode: "create" }));
      const b = await directParty(101, BOB_ENDPOINT, DID);
      const prepared = await queued(a, b.longFormDid, MESSAGE);
      const envelope = await envelopeOf(a, prepared);
      const gone = posting(async () => {
        await a.runtime.close();
        return accepted();
      });
      await expect(submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: gone.fetch })).rejects.toThrow();

      const reopened = await openVault(openNodeSqlite(file, { mode: "readwrite" }), a.seedKey);
      expect((await scanVault(reopened.runtime.vault, reopened.keys)).outbound.outbounds.get(MESSAGE)?.work).toEqual({ kind: "submit", packageIds: [prepared.packageId] });
      const wire = posting(accepted);
      expect(await submit(reopened.runtime, reopened.keys, MESSAGE, { didcomm, fetch: wire.fetch })).toMatchObject({ outcome: "submitted", packageId: prepared.packageId });
      expect([...gone.posts, ...wire.posts].map((post) => post.body)).toEqual([envelope, envelope]);
      await reopened.runtime.close();

      const again = await openVault(openNodeSqlite(file, { mode: "readwrite" }), a.seedKey);
      expect(await submit(again.runtime, again.keys, MESSAGE, { didcomm, fetch: wire.fetch })).toMatchObject({ outcome: "none", because: "submitted" });
      expect(wire.posts).toHaveLength(1);
      await again.runtime.close();
      await b.runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("submit from a mediated address", () => {
  it("the sender's mediator is made to hold it before a package discloses it: without a line nothing is posted, a mediator that will not hold it leaves the message for later, one that does lets the package go", async () => {
    const mediator = await newMediator();
    const a = await mediatedParty(mediator, 1);
    const b = await directParty(101, BOB_ENDPOINT, DID);
    const prepared = await queued(a, b.longFormDid, MESSAGE);
    const wire = posting(accepted);
    const links = (mediationId: MediationId) => (mediationId === a.mediationId ? a.link : null);
    expect(await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch })).toMatchObject({ outcome: "none", because: expect.stringContaining(`which is to hold ${a.did}`) });
    mediator.refuse.add(a.did);
    expect(await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, links })).toEqual({ outcome: "retry", messageId: MESSAGE, packageId: prepared.packageId, reason: `the mediator of ${a.mediationId} does not hold ${a.did}` });
    expect(wire.posts).toEqual([]);
    expect(mediator.recipients.has(a.did)).toBe(false);
    mediator.refuse.delete(a.did);
    expect((await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, links })).outcome).toBe("submitted");
    expect(mediator.recipients.get(a.did)).toBe(a.created.data.me.did);
    expect(wire.posts).toHaveLength(1);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("the diagnostic of the reconciliation is observation only: one that never lands, or fails, still lets a sender the mediator holds post", async () => {
    const mediator = await newMediator();
    const a = await mediatedParty(mediator, 1);
    const b = await directParty(101, BOB_ENDPOINT, DID);
    await queued(a, b.longFormDid, MESSAGE);
    const wire = posting(accepted);
    const stalled = new MediatorLink({ ...a.linkOptions, trace: divertingReconcile(a.trace, () => new Promise(() => undefined)), timeoutMs: 300 });
    const outbox = new Outbox(a.runtime, a.keys, { didcomm, fetch: wire.fetch, links: () => stalled, timers: { set: () => null, clear: () => undefined } });
    const started = Date.now();
    expect((await outbox.drain()).map((step) => step.submitted?.outcome)).toEqual(["submitted"]);
    await outbox.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(a.log).toContain("trace not written: the deadline passed while noting");

    await queued(a, b.longFormDid, SECOND);
    const failing = new MediatorLink({ ...a.linkOptions, trace: divertingReconcile(a.trace, () => Promise.reject(new Error("the trace is full"))) });
    expect((await submit(a.runtime, a.keys, SECOND, { didcomm, fetch: wire.fetch, links: () => failing })).outcome).toBe("submitted");
    expect(a.log).toContain("trace not written: the trace is full");
    expect(mediator.recipients.get(a.did)).toBe(a.created.data.me.did);
    expect(wire.posts).toHaveLength(2);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("the fold is read again right before the post: a package retired while the mediator was asked is not posted", async () => {
    const mediator = await newMediator();
    const a = await mediatedParty(mediator, 1);
    const b = await directParty(101, BOB_ENDPOINT, DID);
    const prepared = await queued(a, b.longFormDid, MESSAGE);
    const wire = posting(accepted);
    mediator.intercept = async (msg) => {
      if (msg.type !== RECIPIENT_QUERY) return undefined;
      mediator.intercept = null;
      await a.runtime.vault.commit([], [vaultDraft("message.packageRetired", { messageId: MESSAGE, packageId: prepared.packageId, because: "withdrawn", replacementPackageId: null })]);
      return undefined;
    };
    expect(await submit(a.runtime, a.keys, MESSAGE, { didcomm, fetch: wire.fetch, links: () => a.link })).toEqual({ outcome: "none", messageId: MESSAGE, because: "no package is prepared" });
    expect(wire.posts).toEqual([]);
    expect((await scanVault(a.runtime.vault, a.keys)).set.of("delivery.submitted")).toEqual([]);
    await a.runtime.close();
    await b.runtime.close();
  });
});

describe("submit to a peer behind a mediator", () => {
  it("the package goes inside a forward carrying its ID and its exact envelope, sealed to the mediator by no one; a mediator that does not take it yet leaves the message for later, and the retry forwards the same package", async () => {
    const mediator = await newMediator();
    const b = await mediatedParty(mediator, 101);
    const a = await directParty(1, ALICE_ENDPOINT, DID);
    const prepared = await queued(a, b.longFormDid, MESSAGE);
    const envelope = await envelopeOf(a, prepared);
    const forwards: { msg: IMessage; from: string | null }[] = [];
    mediator.intercept = (msg, from) => {
      if (msg.type === FORWARD) forwards.push({ msg, from });
      return undefined;
    };
    const trace = await AgentTrace.open(a.runtime.local);
    const native = { made: 0, freed: 0 };
    const Counted = new Proxy(didcomm.Message, {
      construct(target, args: [IMessage]) {
        const message = new target(...args);
        native.made++;
        const free = message.free.bind(message);
        message.free = () => {
          native.freed++;
          free();
        };
        return message;
      },
    });
    const options: SubmitOptions = { didcomm: { ...didcomm, Message: Counted }, fetch: mediator.fetch, trace };

    expect(await submit(a.runtime, a.keys, MESSAGE, options)).toMatchObject({ outcome: "retry", packageId: prepared.packageId, reason: expect.stringContaining("unknown recipient") });
    await reconcile(b.link, b.runtime, b.keys, b.mediationId);
    expect(await submit(a.runtime, a.keys, MESSAGE, options)).toMatchObject({ outcome: "submitted", packageId: prepared.packageId });
    expect(native).toEqual({ made: 2, freed: 2 });

    expect(forwards).toHaveLength(2);
    for (const { msg, from } of forwards) {
      expect(from).toBeNull();
      expect(msg).toMatchObject({ id: prepared.packageId, type: FORWARD, to: [mediator.did], body: { next: b.did } });
      expect(msg.attachments).toHaveLength(1);
      const [attachment] = msg.attachments!;
      expect(attachment!.media_type).toBe(ENCRYPTED_MIME);
      expect(new TextDecoder().decode(canonicalize((attachment!.data as { json: JsonObject }).json))).toBe(envelope);
    }
    const queue = mediator.queues.get(b.created.data.me.did) ?? [];
    expect(queue.map((item) => new TextDecoder().decode(canonicalize(parseStrict(item.packed))))).toEqual([envelope]);
    expect(await openedBy(b, a, queue[0]!.packed)).toMatchObject({ id: MESSAGE, to: [b.did], body: { content: "hello" } });

    const onion = await trace.traceOf(MESSAGE);
    expect(onion.map((entry) => entry.type)).toEqual(["wire.out", "envelope.seal", "wire.error", "wire.out", "envelope.seal", "wire.in"]);
    expect(onion.filter((entry) => entry.type === "envelope.seal").map((entry) => [entry.data["kind"], entry.data["type"], entry.data["packageId"]])).toEqual([
      ["anoncrypt", FORWARD, prepared.packageId],
      ["anoncrypt", FORWARD, prepared.packageId],
    ]);
    await a.runtime.close();
    await b.runtime.close();
  });
});
