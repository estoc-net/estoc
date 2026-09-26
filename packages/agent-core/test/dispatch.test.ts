import { afterEach, describe, expect, it, test, vi } from "vitest";

import type { DIDDoc } from "@estoc/did-peer";
import { parseStrict, type Held, type JsonObject, type VaultRuntime } from "@estoc/event-store";
import { channelOf, scanVault, vaultDraft, type DidId, type MessageId, type VaultEvent, type VaultFold } from "@estoc/vault";

import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { ENCRYPTED_MIME, secretsResolverFor, type IMessage } from "../src/protocol/didcomm.js";
import { FORWARD } from "../src/protocol/spec.js";
import { RECIPIENT, RECIPIENT_QUERY } from "../src/protocol/mediation.js";
import { AgentTrace, Keyring, LiveAction, UnknownEntity, cancel, createVault, dispatch, pinnedResolver, prepare, reconcile, send, unpack, type Content, type DispatchOptions, type Dispatched } from "../src/index.js";
import { MEDIATOR_HTTP } from "./fake-mediator.js";
import { carrierWaitingForIssuer, delivered, didcomm, directParty, issuerRecovered, mediatedParty, memoryDriver, newMediator, posting, proofOfSuccession, received, refuseSubmissions, ticking, type DirectParty, type MediatedParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const THIRD = "019b0000-0000-7000-8000-000000000103" as MessageId;
const ALICE_ENDPOINT = "https://alice.example/didcomm";
const BOB_ENDPOINT = "https://bob.example/didcomm";

const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };

const accepted = (): Response => new Response(null, { status: 202 });

type Holder = Pick<DirectParty, "runtime" | "keys">;

const fold = (party: Holder): Promise<VaultFold> => scanVault(party.runtime.vault, party.keys);

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty }> {
  return { alice: await directParty(1, ALICE_ENDPOINT, ALICE), bob: await directParty(2, BOB_ENDPOINT, BOB) };
}

async function closeAll(...parties: Holder[]): Promise<void> {
  for (const party of parties) await party.runtime.close();
}

function submitted(result: Dispatched): Extract<Dispatched, { outcome: "submitted" }> {
  if (result.outcome !== "submitted") throw new Error(`not submitted: ${JSON.stringify(result)}`);
  return result;
}

/** The envelope the message's one package names, as the string the transport carries. */
async function envelopeOf(party: Holder, messageId: MessageId): Promise<string> {
  const outbound = (await fold(party)).outbound.outbounds.get(messageId)!;
  return new TextDecoder().decode((await party.runtime.vault.objects.read(outbound.package!.event.data.envelopeCid, 1 << 20)) as Uint8Array);
}

/** The envelope opened as its recipient opens it: with the recipient's secrets, the sender's documents as the sender holds them, and the recipient's own. */
async function openedBy(recipient: Holder, sender: Holder, packed: string): Promise<JsonObject> {
  const ring = await Keyring.load(recipient.keys, await fold(recipient));
  const mine = pinnedResolver(await fold(recipient));
  const theirs = pinnedResolver(await fold(sender));
  const resolver = { resolve: async (did: string): Promise<DIDDoc | null> => (await mine.resolve(did)) ?? theirs.resolve(did) };
  return (await unpack(didcomm, packed, resolver, secretsResolverFor(ring.secrets()))).plaintext as unknown as JsonObject;
}

describe("dispatch to a direct endpoint", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prepares a queued intent, carries the exact envelope, commits the acceptance, closes the message and releases the envelope; the action is spent, and nothing carries it again", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const wire = posting(accepted);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    expect(sent.action).toBeInstanceOf(LiveAction);
    expect(sent.action).toMatchObject({ messageId: MESSAGE, kind: "initial", spent: false });

    const result = submitted(await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch, trace }));
    expect(result.submitted.data).toEqual({ messageId: MESSAGE, packageId: result.packageId });
    expect(sent.action.spent).toBe(true);
    const envelope = await envelopeOf(alice, MESSAGE);
    expect(wire.posts).toHaveLength(1);
    expect(wire.posts[0]).toMatchObject({ url: BOB_ENDPOINT, body: envelope, init: { method: "POST", headers: { "Content-Type": ENCRYPTED_MIME }, redirect: "manual", cache: "no-store" } });
    expect(await openedBy(bob, alice, envelope)).toMatchObject({ id: MESSAGE, from: alice.longFormDid, to: [bob.did], body: { content: "hello" } });

    let f = await fold(alice);
    const outbound = f.outbound.outbounds.get(MESSAGE)!;
    expect(outbound).toMatchObject({ submitted: true, outcome: { status: "submitted" }, work: { kind: "none", because: "submitted" }, released: true });
    expect(outbound.package!.event.data.packageId).toBe(result.packageId);
    expect(f.held.has(outbound.package!.event.data.envelopeCid)).toBe(false);
    expect(f.held.has(sent.intent.data.bodyCid)).toBe(true);

    const entries = await trace.read({ stream: "wire" });
    expect(entries.map((entry) => entry.type)).toEqual(["wire.out", "wire.in"]);
    expect(entries[0]!.data).toMatchObject({ via: "http", endpoint: BOB_ENDPOINT, messageId: MESSAGE, packageId: result.packageId });
    expect(entries[1]!.data).toMatchObject({ parent: entries[0]!.seq, status: 202 });
    expect((await trace.traceOf(MESSAGE)).map((entry) => entry.type)).toEqual(["envelope.seal", "wire.out", "wire.in"]);

    expect(await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch })).toEqual({ outcome: "spent", messageId: MESSAGE });
    expect(await dispatch(alice.runtime, alice.keys, new LiveAction(MESSAGE, "manual"), { didcomm, fetch: wire.fetch })).toEqual({ outcome: "none", messageId: MESSAGE, because: "submitted" });
    expect(await prepare(alice.runtime, alice.keys, MESSAGE, { didcomm })).toEqual({ outcome: "none", messageId: MESSAGE, because: "submitted" });
    expect(wire.posts).toHaveLength(1);
    const again = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    expect(again).toMatchObject({ existed: true, action: { messageId: MESSAGE, kind: "manual" } });
    f = await fold(alice);
    expect(f.set.of("delivery.submitted")).toHaveLength(1);
    await closeAll(alice, bob);
  });

  test("a refusal or a lost line spends the action and writes nothing; each manual retry carries the same bytes, until the acceptance", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    await prepare(alice.runtime, alice.keys, MESSAGE, { didcomm });
    const envelope = await envelopeOf(alice, MESSAGE);
    const before = [...(await fold(alice)).set.applied()].length;
    const answers: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new Error("connection reset")),
      () => new Response("later", { status: 503 }),
      () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }),
      accepted,
    ];
    const wire = posting(() => answers.shift()!());
    const options: DispatchOptions = { didcomm, fetch: wire.fetch, trace };

    const lost = await dispatch(alice.runtime, alice.keys, sent.action, options);
    expect(lost).toMatchObject({ outcome: "uncertain", messageId: MESSAGE, reason: "connection reset" });
    expect(sent.action.spent).toBe(true);
    expect(await dispatch(alice.runtime, alice.keys, sent.action, options)).toEqual({ outcome: "spent", messageId: MESSAGE });
    for (const status of [503, 307]) {
      const refused = await dispatch(alice.runtime, alice.keys, new LiveAction(MESSAGE, "manual"), options);
      expect(refused).toMatchObject({ outcome: "failed", messageId: MESSAGE, reason: `the endpoint answered ${status}` });
    }
    let f = await fold(alice);
    expect([...f.set.applied()].length).toBe(before);
    expect(f.outbound.outbounds.get(MESSAGE)).toMatchObject({ outcome: { status: "prepared" }, work: { kind: "dispatch" } });
    expect(wire.posts).toHaveLength(3);

    submitted(await dispatch(alice.runtime, alice.keys, new LiveAction(MESSAGE, "manual"), options));
    expect(wire.posts).toHaveLength(4);
    expect(wire.posts.every((post) => post.url === BOB_ENDPOINT && post.body === envelope)).toBe(true);
    f = await fold(alice);
    expect(f.outbound.outbounds.get(MESSAGE)!.submitted).toBe(true);
    expect(f.set.of("message.prepared")).toHaveLength(1);
    const wireEntries = (await trace.read({ stream: "wire" })).map((entry) => [entry.type, entry.data.status ?? entry.data.error]);
    expect(wireEntries).toEqual([
      ["wire.out", undefined],
      ["wire.error", "connection reset"],
      ["wire.out", undefined],
      ["wire.in", 503],
      ["wire.out", undefined],
      ["wire.in", 307],
      ["wire.out", undefined],
      ["wire.in", 202],
    ]);
    await closeAll(alice, bob);
  });

  it("records what the vault owes before the call: a carrier the host's evidence left unadmitted is admitted by the manual retry of a package to the carrier's own address, once, and the package goes out as it is", async () => {
    const { alice, bob } = await parties();
    const { cid, prior } = await carrierWaitingForIssuer(alice, bob, BOB_PRIOR);
    await send(alice.runtime, alice.keys, { channel: channelOf(alice.did, bob.did), recipientDid: bob.longFormDid }, HELLO, { messageId: MESSAGE });
    expect((await prepare(alice.runtime, alice.keys, MESSAGE, { didcomm })).outcome).toBe("prepared");
    await issuerRecovered(alice, prior);
    let f = await fold(alice);
    expect([f.continuity.status(cid), f.dispositions.disposition(cid), f.outbound.outbounds.get(MESSAGE)!.work.kind]).toEqual([{ status: "verified" }, { status: "pending-admission", because: "the observation is not yet reconciled" }, "dispatch"]);
    const envelope = await envelopeOf(alice, MESSAGE);

    const wire = posting(accepted);
    submitted(await dispatch(alice.runtime, alice.keys, new LiveAction(MESSAGE, "manual"), { didcomm, fetch: wire.fetch }));
    f = await fold(alice);
    expect([f.dispositions.disposition(cid).status, f.set.of("message.admitted").map(({ data }) => data.sourceEventCid), f.set.of("message.prepared").length, f.set.of("message.out").length]).toEqual(["admitted", [cid], 1, 1]);
    expect(wire.posts.map((post) => [post.url, post.body])).toEqual([[BOB_ENDPOINT, envelope]]);
    await closeAll(alice, bob);
  });

  test("a peer address a verified replacement has moved on from is carried to no more: the queued intent gets no package, the prepared package is called by nothing, first or retried, a call already made records its acceptance, and the successor takes a new message", async () => {
    const { alice, bob } = await parties();
    const { prior, proof } = await proofOfSuccession(bob, BOB_PRIOR);
    const toPrior = { channel: channelOf(alice.did, prior.did), recipientDid: prior.longFormDid };
    await send(alice.runtime, alice.keys, toPrior, HELLO, { messageId: MESSAGE });
    const second = await send(alice.runtime, alice.keys, toPrior, HELLO, { messageId: SECOND });
    const third = await send(alice.runtime, alice.keys, toPrior, HELLO, { messageId: THIRD });
    expect((await prepare(alice.runtime, alice.keys, SECOND, { didcomm })).outcome).toBe("prepared");
    expect((await prepare(alice.runtime, alice.keys, THIRD, { didcomm })).outcome).toBe("prepared");
    const envelope = await envelopeOf(alice, THIRD);
    const wire = posting(async () => {
      await delivered(alice, bob, { from_prior: proof });
      return accepted();
    });
    submitted(await dispatch(alice.runtime, alice.keys, third.action, { didcomm, fetch: wire.fetch }));
    const replaced = (messageId: MessageId) => ({ outcome: "none", messageId, because: "the peer has replaced its DID" });
    let f = await fold(alice);
    expect([f.continuity.superseded(toPrior.channel), f.outbound.outbounds.get(THIRD)!.outcome, f.outbound.outbounds.get(SECOND)!.work.kind, f.outbound.outbounds.get(MESSAGE)!.work.kind]).toEqual([true, { status: "submitted" }, "none", "none"]);

    expect(await prepare(alice.runtime, alice.keys, MESSAGE, { didcomm })).toEqual(replaced(MESSAGE));
    expect(await dispatch(alice.runtime, alice.keys, second.action, { didcomm, fetch: wire.fetch })).toEqual(replaced(SECOND));
    expect(await dispatch(alice.runtime, alice.keys, new LiveAction(SECOND, "manual"), { didcomm, fetch: wire.fetch })).toEqual(replaced(SECOND));
    expect(await dispatch(alice.runtime, alice.keys, new LiveAction(THIRD, "manual"), { didcomm, fetch: wire.fetch })).toEqual({ outcome: "none", messageId: THIRD, because: "submitted" });
    await expect(send(alice.runtime, alice.keys, toPrior, HELLO)).rejects.toThrow("the peer has replaced its DID");
    f = await fold(alice);
    expect([wire.posts.map((post) => [post.url, post.body]), second.action.spent, f.set.of("message.prepared").length, f.set.of("delivery.submitted").length, f.set.of("message.out").length]).toEqual([[[BOB_ENDPOINT, envelope]], false, 2, 1, 3]);
    expect(f.outbound.outbounds.get(SECOND)).toMatchObject({ outcome: { status: "prepared" }, work: { kind: "none", because: "the peer has replaced its DID" } });

    const moved = await send(alice.runtime, alice.keys, { channel: channelOf(alice.did, bob.did), recipientDid: bob.longFormDid }, HELLO);
    submitted(await dispatch(alice.runtime, alice.keys, moved.action, { didcomm, fetch: wire.fetch }));
    expect(wire.posts).toHaveLength(2);
    await closeAll(alice, bob);
  });

  test("a prerequisite still to come leaves the action live and the wire untouched; the same action carries the message once it is there", async () => {
    const { alice, bob } = await parties();
    const wire = posting(accepted);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.did } }, HELLO, { messageId: MESSAGE });
    const waiting = await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch });
    expect(waiting).toMatchObject({ outcome: "pending", messageId: MESSAGE });
    expect((waiting as { because: string }).because).toMatch(/no long form of/);
    expect(sent.action.spent).toBe(false);
    expect(wire.posts).toEqual([]);
    expect((await fold(alice)).set.of("message.prepared")).toEqual([]);

    await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: SECOND });
    submitted(await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch }));
    expect(wire.posts).toHaveLength(1);
    const f = await fold(alice);
    expect(f.outbound.outbounds.get(MESSAGE)!.submitted).toBe(true);
    expect(f.outbound.outbounds.get(SECOND)!.outcome).toEqual({ status: "queued" });
    await closeAll(alice, bob);
  });

  test("one action is one call: two dispatches under it make one", async () => {
    const { alice, bob } = await parties();
    const wire = posting(accepted);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    const results = await Promise.all([dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch }), dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch })]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["spent", "submitted"]);
    expect(wire.posts).toHaveLength(1);
    await closeAll(alice, bob);
  });

  test("an acceptance the disk would not record is owed: recorded before the message is worked on again, without another call", async () => {
    const { alice, bob } = await parties();
    const wire = posting(accepted);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    await prepare(alice.runtime, alice.keys, MESSAGE, { didcomm });
    refuseSubmissions(alice.runtime, 1);
    await expect(dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch })).rejects.toThrow(/disk is full/);
    expect(wire.posts).toHaveLength(1);
    expect((await fold(alice)).outbound.outbounds.get(MESSAGE)!.submitted).toBe(false);

    const result = submitted(await dispatch(alice.runtime, alice.keys, new LiveAction(MESSAGE, "manual"), { didcomm, fetch: wire.fetch }));
    expect(wire.posts).toHaveLength(1);
    const f = await fold(alice);
    expect(f.outbound.outbounds.get(MESSAGE)).toMatchObject({ submitted: true, package: { event: { data: { packageId: result.packageId } } } });
    expect(await cancel(alice.runtime, alice.keys, MESSAGE)).toEqual({ outcome: "none", messageId: MESSAGE, because: "submitted" });
    await closeAll(alice, bob);
  });

  test("an acceptance still owed is recorded before a prepare looks at the expiry: the message is submitted, not expired, and one that cannot be recorded stops the prepare", async () => {
    const { alice, bob } = await parties();
    const wire = posting(accepted);
    const timed: Content = { ...HELLO, createdTime: 1_000, expiresTime: 2_000 };
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, timed, { messageId: MESSAGE });
    refuseSubmissions(alice.runtime, 2);
    await expect(dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch, now: () => 1_999_999 })).rejects.toThrow(/disk is full/);
    expect(wire.posts).toHaveLength(1);

    await expect(prepare(alice.runtime, alice.keys, MESSAGE, { didcomm, now: () => 2_000_000 })).rejects.toThrow(/disk is full/);
    let f = await fold(alice);
    expect(f.outbound.outbounds.get(MESSAGE)).toMatchObject({ submitted: false, terminal: null, outcome: { status: "prepared" } });
    expect(f.set.of("delivery.failed")).toEqual([]);

    expect(await prepare(alice.runtime, alice.keys, MESSAGE, { didcomm, now: () => 2_000_000 })).toEqual({ outcome: "none", messageId: MESSAGE, because: "submitted" });
    f = await fold(alice);
    expect(f.outbound.outbounds.get(MESSAGE)).toMatchObject({ submitted: true, outcome: { status: "submitted" } });
    expect(f.set.of("delivery.submitted")).toHaveLength(1);
    expect(f.set.of("delivery.failed")).toEqual([]);
    expect(wire.posts).toHaveLength(1);
    await closeAll(alice, bob);
  });

  test("an expiry that has come terminates the message before the call, before or after preparation", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const wire = posting(accepted);
    const timed: Content = { ...HELLO, createdTime: 1_000, expiresTime: 2_000 };
    const target = { channel: { localDid: alice.did, peerDid: bob.longFormDid } };
    const first = await send(alice.runtime, alice.keys, target, timed, { messageId: MESSAGE });
    const expired = await dispatch(alice.runtime, alice.keys, first.action, { didcomm, fetch: wire.fetch, trace, now: () => 2_000_000 });
    expect(expired).toMatchObject({ outcome: "expired", messageId: MESSAGE, failed: { data: { messageId: MESSAGE, code: "expired" } } });
    expect(first.action.spent).toBe(false);
    expect(await dispatch(alice.runtime, alice.keys, first.action, { didcomm, fetch: wire.fetch, now: () => 2_000_000 })).toEqual({ outcome: "none", messageId: MESSAGE, because: "terminated: expired" });

    const second = await send(alice.runtime, alice.keys, target, timed, { messageId: SECOND });
    expect(await prepare(alice.runtime, alice.keys, SECOND, { didcomm, now: () => 1_999_999 })).toMatchObject({ outcome: "prepared" });
    expect(await dispatch(alice.runtime, alice.keys, second.action, { didcomm, fetch: wire.fetch, trace, now: () => 2_000_000 })).toMatchObject({ outcome: "expired", messageId: SECOND });
    expect(wire.posts).toEqual([]);
    const f = await fold(alice);
    expect([MESSAGE, SECOND].map((id) => f.outbound.outbounds.get(id)!.outcome)).toEqual([
      { status: "terminal", code: "expired" },
      { status: "terminal", code: "expired" },
    ]);
    expect(f.set.of("message.prepared")).toHaveLength(1);
    expect((await trace.read({ stream: "diag" })).map((entry) => entry.data.reason)).toEqual(["the expiry passed before preparation", "the expiry passed before dispatch"]);
    await closeAll(alice, bob);
  });

  test("an expiry that has come terminates the message whatever else holds it up — a blocked channel, a resolution not here — and leaves a submitted or terminated message as it is", async () => {
    const { alice, bob } = await parties();
    const carol = await directParty(3, "https://carol.example/didcomm", CAROL);
    const wire = posting(accepted);
    const timed: Content = { ...HELLO, createdTime: 1_000, expiresTime: 2_000 };
    const before = { didcomm, fetch: wire.fetch, now: () => 1_999_999 };
    const after = { didcomm, fetch: wire.fetch, now: () => 2_000_000 };

    const blocked = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, timed, { messageId: MESSAGE });
    await prepare(alice.runtime, alice.keys, MESSAGE, before);
    const envelopeCid = (await fold(alice)).outbound.outbounds.get(MESSAGE)!.package!.event.data.envelopeCid;
    await alice.runtime.vault.commit([], [vaultDraft("channel.blocked", { localDid: alice.did, peerDid: bob.did, includeSuccessors: false })]);
    expect(await dispatch(alice.runtime, alice.keys, blocked.action, before)).toEqual({ outcome: "none", messageId: MESSAGE, because: "the channel is denied" });
    expect(await dispatch(alice.runtime, alice.keys, blocked.action, after)).toMatchObject({ outcome: "expired", messageId: MESSAGE, failed: { data: { code: "expired" } } });
    expect(await dispatch(alice.runtime, alice.keys, blocked.action, after)).toEqual({ outcome: "none", messageId: MESSAGE, because: "terminated: expired" });
    let f = await fold(alice);
    expect(f.outbound.outbounds.get(MESSAGE)).toMatchObject({ outcome: { status: "terminal", code: "expired" }, released: true });
    expect(f.held.has(envelopeCid)).toBe(false);

    await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: carol.longFormDid } }, timed, { messageId: SECOND });
    const packaged = await prepare(alice.runtime, alice.keys, SECOND, before);
    if (packaged.outcome !== "prepared") throw new Error(`not prepared: ${JSON.stringify(packaged)}`);
    const events: VaultEvent[] = [];
    for await (const event of alice.runtime.vault.events.scan()) events.push(event as VaultEvent);
    const partial = events.filter((event) => event.cid !== packaged.resolved.cid);
    const copy = await createVault(memoryDriver(), { seedKey: alice.seedKey, wrapped: alice.keystore, label: "without the resolution", now: ticking() });
    const ingested = await copy.runtime.locked((held) =>
      held.ingest(partial, async (stage) => {
        for (const root of new Set(partial.flatMap((event) => event.roots))) await stage.putObject(root, (await alice.runtime.vault.objects.read(root, 1 << 20)) as Uint8Array);
      })
    );
    expect(ingested.rejected).toEqual([]);
    const manual = new LiveAction(SECOND, "manual");
    expect(await dispatch(copy.runtime, copy.keys, manual, before)).toEqual({ outcome: "none", messageId: SECOND, because: "the resolution it names is not here" });
    expect(await dispatch(copy.runtime, copy.keys, manual, after)).toMatchObject({ outcome: "expired", messageId: SECOND });
    expect((await scanVault(copy.runtime.vault, copy.keys)).outbound.outbounds.get(SECOND)).toMatchObject({ outcome: { status: "terminal", code: "expired" }, released: true });
    expect(manual.spent).toBe(false);

    const carried = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: carol.longFormDid } }, timed, { messageId: THIRD });
    submitted(await dispatch(alice.runtime, alice.keys, carried.action, before));
    expect(await dispatch(alice.runtime, alice.keys, new LiveAction(THIRD, "manual"), after)).toEqual({ outcome: "none", messageId: THIRD, because: "submitted" });
    expect(await cancel(alice.runtime, alice.keys, THIRD)).toEqual({ outcome: "none", messageId: THIRD, because: "submitted" });
    f = await fold(alice);
    expect(f.set.of("delivery.failed").map((event) => event.data.messageId)).toEqual([MESSAGE]);
    expect(wire.posts).toHaveLength(1);
    await copy.runtime.close();
    await closeAll(alice, bob, carol);
  });

  test("a deadline that passes while the lock is waited for costs the action nothing: nothing is called, and the same action calls once the lock is free", async () => {
    const { alice, bob } = await parties();
    const wire = posting(accepted);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    await prepare(alice.runtime, alice.keys, MESSAGE, { didcomm });
    const locked = alice.runtime.locked.bind(alice.runtime);
    let holding: Promise<void> | null = null;
    vi.spyOn(alice.runtime, "locked").mockImplementation((async (work: (held: Held) => Promise<unknown>) => {
      const value = await locked(work);
      holding ??= locked(() => new Promise((resolve) => setTimeout(resolve, 80)));
      return value;
    }) as VaultRuntime["locked"]);
    expect(await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch, timeoutMs: 10 })).toEqual({ outcome: "pending", messageId: MESSAGE, because: "the deadline passed before the call" });
    expect(wire.posts).toEqual([]);
    expect(sent.action.spent).toBe(false);
    await holding;
    vi.restoreAllMocks();
    submitted(await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch }));
    expect(wire.posts).toHaveLength(1);
    expect(sent.action.spent).toBe(true);
    await closeAll(alice, bob);
  });

  it("cancels an unsubmitted message, before or after preparation, keeping its content and releasing its envelope; a submitted one is not cancelled", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const wire = posting(accepted);
    const target = { channel: { localDid: alice.did, peerDid: bob.longFormDid } };
    await expect(cancel(alice.runtime, alice.keys, MESSAGE)).rejects.toBeInstanceOf(UnknownEntity);

    const first = await send(alice.runtime, alice.keys, target, HELLO, { messageId: MESSAGE });
    expect(await cancel(alice.runtime, alice.keys, MESSAGE, { trace })).toMatchObject({ outcome: "cancelled", messageId: MESSAGE, failed: { data: { messageId: MESSAGE, code: "cancelled" } } });
    expect(await dispatch(alice.runtime, alice.keys, first.action, { didcomm, fetch: wire.fetch })).toEqual({ outcome: "none", messageId: MESSAGE, because: "terminated: cancelled" });
    expect(await cancel(alice.runtime, alice.keys, MESSAGE)).toEqual({ outcome: "none", messageId: MESSAGE, because: "terminated: cancelled" });

    const second = await send(alice.runtime, alice.keys, target, HELLO, { messageId: SECOND });
    await prepare(alice.runtime, alice.keys, SECOND, { didcomm });
    let f = await fold(alice);
    const envelopeCid = f.outbound.outbounds.get(SECOND)!.package!.event.data.envelopeCid;
    expect(f.held.has(envelopeCid)).toBe(true);
    expect(await cancel(alice.runtime, alice.keys, SECOND)).toMatchObject({ outcome: "cancelled" });
    f = await fold(alice);
    expect(f.outbound.outbounds.get(SECOND)).toMatchObject({ outcome: { status: "terminal", code: "cancelled" }, work: { kind: "none" }, released: true });
    expect(f.held.has(envelopeCid)).toBe(false);
    expect(f.held.has(second.intent.data.bodyCid)).toBe(true);

    const third = await send(alice.runtime, alice.keys, target, HELLO, { messageId: THIRD });
    submitted(await dispatch(alice.runtime, alice.keys, third.action, { didcomm, fetch: wire.fetch }));
    expect(await cancel(alice.runtime, alice.keys, THIRD)).toEqual({ outcome: "none", messageId: THIRD, because: "submitted" });
    expect(wire.posts).toHaveLength(1);
    expect((await trace.read({ stream: "diag" })).map((entry) => [entry.data.messageId, entry.data.code])).toEqual([[MESSAGE, "cancelled"]]);
    await closeAll(alice, bob);
  });
});

describe("dispatch through a mediator", () => {
  test("a recipient behind a mediator gets the envelope inside a forward sealed to the mediator alone, under the package's ID, and it arrives intact", async () => {
    const mediator = await newMediator();
    const bob = await mediatedParty(mediator, 2, BOB);
    await reconcile(bob.link, bob.runtime, bob.keys, bob.mediationId);
    const alice = await directParty(1, ALICE_ENDPOINT, ALICE);
    const trace = await AgentTrace.open(alice.runtime.local);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    const result = submitted(await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: mediator.fetch, trace }));

    expect(mediator.seenTypes).toContain(FORWARD);
    const queued = mediator.queues.get(bob.created.data.me.did) ?? [];
    expect(queued).toHaveLength(1);
    const envelope = await envelopeOf(alice, MESSAGE);
    expect(parseStrict(queued[0]!.packed)).toEqual(parseStrict(envelope));
    expect(await openedBy(bob, alice, queued[0]!.packed)).toMatchObject({ id: MESSAGE, to: [bob.did], body: { content: "hello" } });

    const entries = await trace.traceOf(MESSAGE);
    expect(entries.map((entry) => entry.type)).toEqual(["envelope.seal", "wire.out", "envelope.seal", "wire.in"]);
    const [, out, forward, answer] = entries;
    expect(out!.data).toMatchObject({ via: "http", endpoint: MEDIATOR_HTTP, messageId: MESSAGE, packageId: result.packageId });
    expect(forward!.data).toMatchObject({ parent: out!.seq, type: FORWARD, messageId: MESSAGE, packageId: result.packageId });
    expect(answer!.data).toMatchObject({ parent: out!.seq, status: 202 });
    expect((await fold(alice)).outbound.outbounds.get(MESSAGE)!.submitted).toBe(true);
    await closeAll(alice, bob);
  });

  test("a mediated sender the peer has not written to is made to be held by its mediator first; one the mediator does not hold, or cannot be asked, waits; a confirmed sender needs no mediator", async () => {
    const mediator = await newMediator();
    const alice = await mediatedParty(mediator, 1, ALICE);
    const carol = await mediatedParty(mediator, 3, CAROL);
    const bob = await directParty(2, BOB_ENDPOINT, BOB);
    const wire = posting(accepted);
    const links = (party: MediatedParty) => (mediationId: string) => (mediationId === party.mediationId ? party.link : null);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });

    const unlinked = await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch });
    expect(unlinked).toMatchObject({ outcome: "pending", messageId: MESSAGE });
    expect((unlinked as { because: string }).because).toMatch(/no link to the mediator/);
    alice.offline.reason = "no route to host";
    const unreachable = await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch, links: links(alice) });
    expect((unreachable as { because: string }).because).toMatch(/could not be asked to hold .*no route to host/);
    alice.offline.reason = null;
    expect(mediator.recipients.has(alice.did)).toBe(false);
    expect(wire.posts).toEqual([]);
    expect(sent.action.spent).toBe(false);

    submitted(await dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch, links: links(alice) }));
    expect(mediator.recipients.has(alice.did)).toBe(true);
    expect(wire.posts).toHaveLength(1);
    expect(wire.posts[0]!.url).toBe(BOB_ENDPOINT);
    expect(await openedBy(bob, alice, wire.posts[0]!.body)).toMatchObject({ id: MESSAGE, from: alice.longFormDid });

    mediator.refuse.add(carol.did);
    const fromCarol = await send(carol.runtime, carol.keys, { channel: { localDid: carol.did, peerDid: bob.longFormDid } }, HELLO, { messageId: SECOND });
    const refused = await dispatch(carol.runtime, carol.keys, fromCarol.action, { didcomm, fetch: wire.fetch, links: links(carol) });
    expect((refused as { because: string }).because).toMatch(/does not hold/);
    expect(wire.posts).toHaveLength(1);

    await received(carol as unknown as DirectParty, bob, "wire-1", { type: BASIC_MESSAGE, body: { content: "I know this address" } });
    expect((await fold(carol)).continuity.confirmedBy(carol.did, bob.did)).not.toBeNull();
    submitted(await dispatch(carol.runtime, carol.keys, fromCarol.action, { didcomm, fetch: wire.fetch }));
    expect(wire.posts).toHaveLength(2);
    expect(mediator.recipients.has(carol.did)).toBe(false);
    await closeAll(alice, carol, bob);
  });

  test("a mediator that pages its recipients without end holds up neither the message nor its cancellation: the attempt is refused after the page that made no progress, the action stays live, and the cancel goes through", async () => {
    const mediator = await newMediator();
    const alice = await mediatedParty(mediator, 1, ALICE);
    const bob = await directParty(2, BOB_ENDPOINT, BOB);
    const wire = posting(accepted);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    const established = mediator.seenTypes.filter((type) => type === RECIPIENT_QUERY).length;
    mediator.intercept = (msg: IMessage, from) =>
      msg.type === RECIPIENT_QUERY ? mediator.reply(RECIPIENT, from!, { dids: [{ recipient_did: alice.did }], pagination: { count: 1, offset: (msg.body as { paginate: { offset: number } }).paginate.offset, remaining: 1 } }, msg.id) : undefined;
    const attempt = dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch, links: () => alice.link });
    const cancelling = cancel(alice.runtime, alice.keys, MESSAGE);
    const refused = await attempt;
    expect(refused).toMatchObject({ outcome: "pending", messageId: MESSAGE });
    expect((refused as { because: string }).because).toMatch(/could not be asked to hold .*recipient-query lists .* again at offset 1/);
    expect(mediator.seenTypes.filter((type) => type === RECIPIENT_QUERY)).toHaveLength(established + 2);
    expect(sent.action.spent).toBe(false);
    expect(await cancelling).toMatchObject({ outcome: "cancelled", messageId: MESSAGE });
    expect(wire.posts).toEqual([]);
    await closeAll(alice, bob);
  });
});
