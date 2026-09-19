import { afterEach, describe, expect, it, vi } from "vitest";

import type { DIDDoc } from "@estoc/did-peer";
import { parseStrict, type JsonObject } from "@estoc/event-store/v3";
import { scanVault, type DidId, type MessageId, type VaultFold } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { ENCRYPTED_MIME, secretsResolverFor } from "../../src/protocol/didcomm.js";
import { FORWARD } from "../../src/protocol/spec.js";
import { AgentTrace, Keyring, LiveAction, UnknownEntity, cancel, dispatch, pinnedResolver, prepare, reconcile, send, unpack, type Content, type DispatchOptions, type Dispatched } from "../../src/v3/index.js";
import { MEDIATOR_HTTP } from "../fake-mediator.js";
import { didcomm, directParty, mediatedParty, newMediator, posting, received, refuseSubmissions, type DirectParty, type MediatedParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
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

  it("a refusal or a lost line spends the action and writes nothing; each manual retry carries the same bytes, until the acceptance", async () => {
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

  it("a prerequisite still to come leaves the action live and the wire untouched; the same action carries the message once it is there", async () => {
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

  it("one action is one call: two dispatches under it make one", async () => {
    const { alice, bob } = await parties();
    const wire = posting(accepted);
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    const results = await Promise.all([dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch }), dispatch(alice.runtime, alice.keys, sent.action, { didcomm, fetch: wire.fetch })]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["spent", "submitted"]);
    expect(wire.posts).toHaveLength(1);
    await closeAll(alice, bob);
  });

  it("an acceptance the disk would not record is owed: recorded before the message is worked on again, without another call", async () => {
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

  it("an expiry that has come terminates the message before the call, before or after preparation", async () => {
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
  it("a recipient behind a mediator gets the envelope inside a forward sealed to the mediator alone, under the package's ID, and it arrives intact", async () => {
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

  it("a mediated sender the peer has not written to is made to be held by its mediator first; one the mediator does not hold, or cannot be asked, waits; a confirmed sender needs no mediator", async () => {
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
    expect((await fold(carol)).continuity.confirmed(carol.did, bob.did)).toBe(true);
    submitted(await dispatch(carol.runtime, carol.keys, fromCarol.action, { didcomm, fetch: wire.fetch }));
    expect(wire.posts).toHaveLength(2);
    expect(mediator.recipients.has(carol.did)).toBe(false);
    await closeAll(alice, carol, bob);
  });
});
