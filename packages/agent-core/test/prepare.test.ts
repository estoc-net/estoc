import { describe, expect, it } from "vitest";

import { decodeLongForm, encodeLongForm, longToShort, type DIDDoc } from "@estoc/did-peer";
import { canonicalize, parseStrict, type JsonObject } from "@estoc/event-store";
import {
  channelOf,
  didKeyName,
  plaintextHash,
  rawCidOfBytes,
  scanVault,
  signFromPrior,
  vaultDraft,
  type Channel,
  type Did,
  type DidId,
  type EventCid,
  type EventReference,
  type MessageId,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault";

import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { secretsResolverFor } from "../src/protocol/didcomm.js";
import { AgentTrace, Keyring, UnknownEntity, createDid, createVault, pinnedResolver, prepare, prepareAll, send, unpack, type Content, type PrepareOptions, type Prepared, type Unpacked } from "../src/index.js";
import { carrierWaitingForIssuer, didcomm, directParty, memoryDriver, received, refuseCommits, ticking, type DirectParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000b" as DidId;
const ALICE_NEXT = "019b0000-0000-7000-8000-00000000000c" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const THIRD = "019b0000-0000-7000-8000-000000000103" as MessageId;
const IAT = 1_757_700_000;

const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty; toBob: Channel }> {
  const alice = await directParty(1, "https://alice.example/didcomm", ALICE);
  const bob = await directParty(2, "https://bob.example/didcomm", BOB);
  return { alice, bob, toBob: channelOf(alice.did, bob.did) };
}

async function closeAll(...parties: DirectParty[]): Promise<void> {
  for (const party of parties) await party.runtime.close();
}

const fold = (party: DirectParty): Promise<VaultFold> => scanVault(party.runtime.vault, party.keys);

const options = (over: Partial<PrepareOptions> = {}): PrepareOptions => ({ didcomm, ...over });

function prepared(result: Prepared): Extract<Prepared, { outcome: "prepared" }> {
  if (result.outcome !== "prepared") throw new Error(`not prepared: ${JSON.stringify(result)}`);
  return result;
}

/** The envelope a package names, as the bytes the object store holds and as the string the transport would carry. */
async function envelopeOf(alice: DirectParty, result: Prepared): Promise<{ bytes: Uint8Array; packed: string }> {
  const bytes = (await alice.runtime.vault.objects.read(prepared(result).prepared.data.envelopeCid, 1 << 20)) as Uint8Array;
  return { bytes, packed: new TextDecoder().decode(bytes) };
}

/** The envelope opened on Bob's side: with Bob's keys, Alice's documents as she holds them (his own vault knows nothing of her), and his own. */
async function opened(alice: DirectParty, bob: DirectParty, packed: string): Promise<Unpacked> {
  const ring = await Keyring.load(bob.keys, await fold(bob));
  const mine = pinnedResolver(await fold(bob));
  const hers = pinnedResolver(await fold(alice));
  const resolver = { resolve: async (did: string): Promise<DIDDoc | null> => (await mine.resolve(did)) ?? hers.resolve(did) };
  return unpack(didcomm, packed, resolver, secretsResolverFor(ring.secrets()));
}

/** Alice continues `ALICE` as `ALICE_NEXT` toward `peer`, under the proof her seed signs, once the peer has written to `ALICE`: a verified local replacement. */
async function rotated(alice: DirectParty, peer: DirectParty): Promise<{ next: Did; longFormDid: Did; fromPrior: string; decision: EventCid }> {
  await received(alice, peer, `confirm-${ALICE}`, { type: BASIC_MESSAGE, body: { content: "I know this address" } });
  const routeId = (await fold(alice)).routes.dids.get(ALICE)!.created!.boundRouteId;
  const { minted } = await createDid(alice.runtime, alice.keys, routeId, ALICE_NEXT);
  const fromPrior = await signFromPrior(alice.keys, { didId: ALICE, longFormDid: alice.longFormDid }, minted.longFormDid, IAT);
  const [decision] = await alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE, peerDid: peer.did, toDidId: ALICE_NEXT, sourceEventCid: null, fromPrior })]);
  return { next: minted.did, longFormDid: minted.longFormDid, fromPrior, decision: decision!.cid };
}

describe("prepare", () => {
  it("makes the one package of a queued intent from local evidence, addressed to the recipient's short form, commits the envelope, the resolution and the package under one lock, and holds it from then on", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const content: Content = {
      ...HELLO,
      attachments: [
        { id: "a1", media_type: "text/plain", data: { base64: "aGVsbG8" } },
        { id: "a2", data: { links: ["https://files.example/x"], hash: "zQm1" } },
      ],
      thid: "thread-1",
      createdTime: 1_000,
      expiresTime: 2_000,
      pleaseAck: [""],
      headers: { lang: "en" },
    };
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, content, { messageId: MESSAGE });
    const result = prepared(await prepare(alice.runtime, alice.keys, MESSAGE, options({ trace, now: () => 1_999_999 })));
    const { data } = result.prepared;
    expect(data).toMatchObject({ messageId: MESSAGE, packageId: result.packageId, senderDidId: ALICE, localKeyName: didKeyName(ALICE, "key-agreement"), recipientDid: bob.did, peerResolutionEventCid: result.resolved.cid, fromPrior: null, intentHash: sent.intent.data.intentHash });
    expect(sent.intent.data.recipientDid).toBe(bob.longFormDid);
    expect(result.prepared.roots).toEqual([data.envelopeCid]);
    expect(result.resolved.data).toMatchObject({ localKeyName: didKeyName(ALICE, "key-agreement"), presentedDid: bob.longFormDid, did: bob.did });
    expect(result.resolved.at < result.prepared.at).toBe(true);

    const { bytes, packed } = await envelopeOf(alice, result);
    expect(rawCidOfBytes(bytes)).toBe(data.envelopeCid);
    expect(canonicalize(parseStrict(packed))).toEqual(bytes);
    const envelope = parseStrict(packed) as JsonObject;
    expect(envelope).toHaveProperty("ciphertext");
    expect((envelope.recipients as { header: { kid: string } }[]).map((r) => r.header.kid)).toEqual([`${bob.did}#key-2`]);

    const { plaintext, sender, fromPrior } = await opened(alice, bob, packed);
    expect(sender).toEqual({ did: alice.longFormDid, kid: `${alice.longFormDid}#key-2` });
    expect(fromPrior).toBeNull();
    expect(plaintext).toMatchObject({ id: MESSAGE, type: BASIC_MESSAGE, from: alice.longFormDid, to: [bob.did], thid: "thread-1", created_time: 1_000, expires_time: 2_000, please_ack: [""], lang: "en", body: { content: "hello" } });
    expect(plaintext).not.toHaveProperty("from_prior");
    expect(plaintext).not.toHaveProperty("ack");
    expect((plaintext as unknown as { attachments: { id: string; data: JsonObject }[] }).attachments.map((a) => [a.id, a.data])).toEqual([
      ["a1", { base64: "aGVsbG8" }],
      ["a2", { links: ["https://files.example/x"], hash: "zQm1" }],
    ]);
    expect(plaintextHash(plaintext as unknown as JsonObject)).toBe(data.plaintextHash);

    let f = await fold(alice);
    const outbound = f.outbound.outbounds.get(MESSAGE)!;
    expect(outbound.package?.status).toEqual({ status: "complete" });
    expect(outbound.outcome).toEqual({ status: "prepared" });
    expect(outbound.work).toEqual({ kind: "dispatch", package: outbound.package });
    expect((await trace.read({ stream: "envelope" })).map((entry) => [entry.type, entry.data.messageId, entry.data.packageId])).toEqual([["envelope.seal", MESSAGE, result.packageId]]);

    const again = await prepare(alice.runtime, alice.keys, MESSAGE, options({ now: () => 1_999_999 }));
    expect(again).toMatchObject({ outcome: "reused", messageId: MESSAGE, package: { event: { cid: result.prepared.cid } } });
    expect(await prepareAll(alice.runtime, alice.keys, options())).toEqual([]);
    f = await fold(alice);
    expect(f.set.of("message.prepared")).toHaveLength(1);
    expect(f.set.of("peer.resolved")).toHaveLength(1);
    await closeAll(alice, bob);
  });

  it("resolves the recipient locally only: a short form waits for its long form, which is not a key change; the same evidence serves every package at that key", async () => {
    const { alice, bob, toBob } = await parties();
    await send(alice.runtime, alice.keys, { channel: toBob }, HELLO, { messageId: MESSAGE });
    const waiting = await prepare(alice.runtime, alice.keys, MESSAGE, options());
    expect(waiting).toMatchObject({ outcome: "pending", messageId: MESSAGE });
    expect((waiting as { because: string }).because).toMatch(/no long form of/);
    let f = await fold(alice);
    expect(f.set.of("message.prepared")).toEqual([]);
    expect(f.set.of("peer.resolved")).toEqual([]);
    expect(f.outbound.outbounds.get(MESSAGE)!.work).toEqual({ kind: "prepare" });

    await send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid }, HELLO, { messageId: SECOND });
    const results = await prepareAll(alice.runtime, alice.keys, options());
    expect(results.map((r) => [r.messageId, r.outcome])).toEqual([
      [MESSAGE, "prepared"],
      [SECOND, "prepared"],
    ]);
    const [first, second] = results.map(prepared);
    expect(first!.prepared.data.recipientDid).toBe(bob.did);
    expect(first!.resolved.data).toMatchObject({ presentedDid: bob.did, did: bob.did });
    expect(second!.prepared.data.recipientDid).toBe(bob.did);
    expect(second!.resolved.data).toMatchObject({ presentedDid: bob.longFormDid, did: bob.did });
    expect(second!.resolved.cid).not.toBe(first!.resolved.cid);
    const { plaintext } = await opened(alice, bob, (await envelopeOf(alice, first!)).packed);
    expect(plaintext).toMatchObject({ from: alice.longFormDid, to: [bob.did] });

    await send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid }, HELLO, { messageId: THIRD });
    const third = prepared(await prepare(alice.runtime, alice.keys, THIRD, options()));
    expect(third.resolved.cid).toBe(second!.resolved.cid);
    f = await fold(alice);
    expect(f.set.of("peer.resolved")).toHaveLength(2);
    expect([...f.outbound.outbounds.values()].every((o) => o.package?.status.status === "complete")).toBe(true);
    await closeAll(alice, bob);
  });

  it("names the sender by its long form until the peer has written to that address, and by its short form after", async () => {
    const { alice, bob, toBob } = await parties();
    await send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid }, HELLO, { messageId: MESSAGE });
    const before = prepared(await prepare(alice.runtime, alice.keys, MESSAGE, options()));
    expect((await opened(alice, bob, (await envelopeOf(alice, before)).packed)).plaintext.from).toBe(alice.longFormDid);

    await received(alice, bob, "wire-1", { type: BASIC_MESSAGE, body: { content: "hi" } });
    expect((await fold(alice)).continuity.confirmed(alice.did, bob.did)).toBe(true);
    expect(await prepare(alice.runtime, alice.keys, MESSAGE, options())).toMatchObject({ outcome: "reused" });
    await send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid }, HELLO, { messageId: SECOND });
    const after = prepared(await prepare(alice.runtime, alice.keys, SECOND, options()));
    const { plaintext, sender } = await opened(alice, bob, (await envelopeOf(alice, after)).packed);
    expect(plaintext.from).toBe(alice.did);
    expect(sender).toEqual({ did: alice.did, kid: `${alice.did}#key-2` });
    await closeAll(alice, bob);
  });

  it("an unconfirmed successor carries the decision's frozen proof under its long form; once the peer writes to the successor, new packages go proof-free; the pre-rotation address stays as it was", async () => {
    const { alice, bob, toBob } = await parties();
    const { next, longFormDid, fromPrior } = await rotated(alice, bob);
    const toBobNext = channelOf(next, bob.did);
    await send(alice.runtime, alice.keys, { channel: toBobNext, recipientDid: bob.longFormDid }, HELLO, { messageId: MESSAGE });
    const proven = prepared(await prepare(alice.runtime, alice.keys, MESSAGE, options()));
    expect(proven.prepared.data).toMatchObject({ senderDidId: ALICE_NEXT, localKeyName: didKeyName(ALICE_NEXT, "key-agreement"), fromPrior });
    const first = await opened(alice, bob, (await envelopeOf(alice, proven)).packed);
    expect(first.plaintext).toMatchObject({ from: longFormDid, from_prior: fromPrior });
    expect(first.sender).toEqual({ did: longFormDid, kid: `${longFormDid}#key-2` });
    expect(first.fromPrior).toBe(fromPrior);
    expect(plaintextHash(first.plaintext as unknown as JsonObject)).toBe(proven.prepared.data.plaintextHash);

    await received(alice, bob, "wire-2", { type: BASIC_MESSAGE, body: { content: "got your new address" } }, { didId: ALICE_NEXT, did: next });
    expect((await fold(alice)).continuity.confirmed(next, bob.did)).toBe(true);
    expect(await prepare(alice.runtime, alice.keys, MESSAGE, options())).toMatchObject({ outcome: "reused", package: { event: { cid: proven.prepared.cid } } });
    await send(alice.runtime, alice.keys, { channel: toBobNext, recipientDid: bob.longFormDid }, HELLO, { messageId: SECOND });
    const confirmed = prepared(await prepare(alice.runtime, alice.keys, SECOND, options()));
    expect(confirmed.prepared.data.fromPrior).toBeNull();
    const second = await opened(alice, bob, (await envelopeOf(alice, confirmed)).packed);
    expect(second.plaintext.from).toBe(next);
    expect(second.plaintext).not.toHaveProperty("from_prior");

    await send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid, preRotation: true }, HELLO, { messageId: THIRD });
    const old = prepared(await prepare(alice.runtime, alice.keys, THIRD, options()));
    expect(old.prepared.data).toMatchObject({ senderDidId: ALICE, fromPrior: null });
    expect((await opened(alice, bob, (await envelopeOf(alice, old)).packed)).plaintext.from).toBe(alice.did);
    await closeAll(alice, bob);
  });

  it("a rotation to the sender whose predecessor creation has not arrived is history still to come, not no rotation: the package waits, then carries the frozen proof once", async () => {
    const { alice, bob } = await parties();
    const { next, longFormDid, fromPrior, decision } = await rotated(alice, bob);
    const events: VaultEvent[] = [];
    for await (const event of alice.runtime.vault.events.scan()) events.push(event as VaultEvent);
    const creation = events.find((event) => event.type === "did.created" && (event.data as { didId: DidId }).didId === ALICE)!;
    const partial = events.filter((event) => event.cid !== creation.cid);
    const copy = await createVault(memoryDriver(), { seedKey: alice.seedKey, wrapped: alice.keystore, label: "partial history", now: ticking() });
    const ingested = await copy.runtime.locked((held) =>
      held.ingest(partial, async (stage) => {
        for (const root of new Set(partial.flatMap((event) => event.roots))) await stage.putObject(root, (await alice.runtime.vault.objects.read(root, 1 << 20)) as Uint8Array);
      })
    );
    expect(ingested.rejected).toEqual([]);
    const later: DirectParty = { ...alice, ...copy };
    let f = await fold(later);
    expect(f.channels.decisions.get(decision)).toMatchObject({ channel: null, status: { status: "pending" } });

    await send(later.runtime, later.keys, { channel: channelOf(next, bob.did), recipientDid: bob.longFormDid }, HELLO, { messageId: MESSAGE });
    const waiting = await prepare(later.runtime, later.keys, MESSAGE, options());
    expect(waiting).toMatchObject({ outcome: "pending", messageId: MESSAGE });
    expect((waiting as { because: string }).because).toMatch(/pending: the predecessor entity has no consistent creation here/);
    expect((await fold(later)).set.of("message.prepared")).toEqual([]);

    expect((await later.runtime.ingest([creation])).rejected).toEqual([]);
    f = await fold(later);
    expect(f.continuity.status(decision)).toEqual({ status: "verified" });
    const proven = prepared(await prepare(later.runtime, later.keys, MESSAGE, options()));
    expect(proven.prepared.data).toMatchObject({ senderDidId: ALICE_NEXT, fromPrior });
    const { plaintext } = await opened(later, bob, (await envelopeOf(later, proven)).packed);
    expect(plaintext).toMatchObject({ from: longFormDid, from_prior: fromPrior });
    expect(await prepare(later.runtime, later.keys, MESSAGE, options())).toMatchObject({ outcome: "reused" });
    expect((await fold(later)).set.of("message.prepared")).toHaveLength(1);
    await copy.runtime.close();
    await closeAll(alice, bob);
  });

  it("seals to the first authorized key-agreement key the sender can agree with, passing over one it cannot; a document with none makes no package and does not stop the batch", async () => {
    const { alice, bob, toBob } = await parties();
    const mixed = decodeLongForm(bob.longFormDid);
    mixed.keyAgreement = ["#key-1", "#key-2"];
    const mixedDid = encodeLongForm(mixed) as Did;
    const mixedShort = longToShort(mixedDid) as Did;
    const signingOnly = decodeLongForm(bob.longFormDid);
    signingOnly.keyAgreement = ["#key-1"];
    const signingOnlyDid = encodeLongForm(signingOnly) as Did;
    const signingOnlyShort = longToShort(signingOnlyDid) as Did;
    await send(alice.runtime, alice.keys, { channel: channelOf(alice.did, mixedShort), recipientDid: mixedDid }, HELLO, { messageId: MESSAGE });
    await send(alice.runtime, alice.keys, { channel: channelOf(alice.did, signingOnlyShort), recipientDid: signingOnlyDid }, HELLO, { messageId: SECOND });
    await send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid }, HELLO, { messageId: THIRD });

    const results = await prepareAll(alice.runtime, alice.keys, options());
    expect(results.map((r) => [r.messageId, r.outcome])).toEqual([
      [MESSAGE, "prepared"],
      [SECOND, "none"],
      [THIRD, "prepared"],
    ]);
    const [toMixed, refused, toBobs] = results;
    const envelope = parseStrict((await envelopeOf(alice, toMixed!)).packed) as JsonObject;
    expect((envelope.recipients as { header: { kid: string } }[]).map((r) => r.header.kid)).toEqual([`${mixedShort}#key-2`]);
    expect((refused as { because: string }).because).toBe(`${signingOnlyDid} authorizes no key-agreement key ${alice.did} can seal to`);
    expect(prepared(toBobs!).prepared.data.recipientDid).toBe(bob.did);
    const f = await fold(alice);
    expect(f.set.of("message.prepared")).toHaveLength(2);
    expect(f.outbound.outbounds.get(SECOND)!.work).toEqual({ kind: "prepare" });
    await closeAll(alice, bob);
  });

  it("a rotation to the sender that is still waiting for its evidence stops the package rather than sending it proof-free", async () => {
    const { alice, bob } = await parties();
    const routeId = (await fold(alice)).routes.dids.get(ALICE)!.created!.boundRouteId;
    const { minted } = await createDid(alice.runtime, alice.keys, routeId, ALICE_NEXT);
    const fromPrior = await signFromPrior(alice.keys, { didId: ALICE, longFormDid: alice.longFormDid }, minted.longFormDid, IAT);
    const missing = rawCidOfBytes(new Uint8Array(32).fill(0xee)) as unknown as EventReference<"message.in">;
    await alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE, peerDid: bob.did, toDidId: ALICE_NEXT, sourceEventCid: missing, fromPrior })]);
    await send(alice.runtime, alice.keys, { channel: channelOf(minted.did, bob.did), recipientDid: bob.longFormDid }, HELLO, { messageId: MESSAGE });
    const result = await prepare(alice.runtime, alice.keys, MESSAGE, options());
    expect(result).toMatchObject({ outcome: "pending", messageId: MESSAGE });
    expect((result as { because: string }).because).toMatch(/pending: the source it names is not here/);
    expect((await fold(alice)).set.of("message.prepared")).toEqual([]);
    await closeAll(alice, bob);
  });

  it("a resolution it commits is evidence recovered: an observation whose proof waited for that issuer's document is admitted under the same lock, dispatching nothing, and the package stands", async () => {
    const { alice, bob } = await parties();
    const { cid, prior } = await carrierWaitingForIssuer(alice, bob, BOB_PRIOR);
    const carried = { cid };
    expect((await fold(alice)).dispositions.disposition(carried.cid)).toEqual({ status: "pending-admission", because: "the source's proof is not yet verified" });

    await send(alice.runtime, alice.keys, { channel: channelOf(alice.did, prior.did), recipientDid: prior.longFormDid }, HELLO, { messageId: MESSAGE });
    const trace = await AgentTrace.open(alice.runtime.local);
    const result = prepared(await prepare(alice.runtime, alice.keys, MESSAGE, options({ trace })));
    const after = await fold(alice);
    expect([after.continuity.status(carried.cid), after.dispositions.disposition(carried.cid).status, after.set.of("message.admitted").map(({ data }) => data.sourceEventCid)]).toEqual([{ status: "verified" }, "admitted", [carried.cid]]);
    expect([after.outbound.outbounds.get(MESSAGE)!.package!.event.cid, after.set.of("message.out").length, await trace.read({ type: "diag.admission" })]).toEqual([result.prepared.cid, 1, []]);
    await closeAll(alice, bob);
  });

  it("owes that pass at every preparation: a commit refused once the resolution is durable — the package's, or the pass's own — leaves the carrier to the next preparation, which admits it once, whether it makes the package or reuses it", async () => {
    for (const refused of ["message.prepared", "message.admitted"] as const) {
      const { alice, bob } = await parties();
      const { cid, prior } = await carrierWaitingForIssuer(alice, bob, BOB_PRIOR);
      await send(alice.runtime, alice.keys, { channel: channelOf(alice.did, prior.did), recipientDid: prior.longFormDid }, HELLO, { messageId: MESSAGE });
      const trace = await AgentTrace.open(alice.runtime.local);
      refuseCommits(alice.runtime, refused, 1);
      if (refused === "message.prepared") await expect(prepare(alice.runtime, alice.keys, MESSAGE, options({ trace }))).rejects.toThrow("the disk is full for now");
      else prepared(await prepare(alice.runtime, alice.keys, MESSAGE, options({ trace })));
      let f = await fold(alice);
      expect([f.continuity.status(cid), f.dispositions.disposition(cid), f.set.of("peer.resolved").filter(({ data }) => data.did === prior.did).length, f.set.of("message.prepared").length]).toEqual([{ status: "verified" }, { status: "pending-admission", because: "the observation is not yet reconciled" }, 1, refused === "message.prepared" ? 0 : 1]);
      expect((await trace.read({ type: "diag.admission" })).map((entry) => entry.data)).toEqual(refused === "message.prepared" ? [] : [{ messageId: MESSAGE, reason: "the pass the preparation runs stopped: the disk is full for now" }]);

      expect((await prepare(alice.runtime, alice.keys, MESSAGE, options({ trace }))).outcome).toBe(refused === "message.prepared" ? "prepared" : "reused");
      f = await fold(alice);
      expect([f.dispositions.disposition(cid).status, f.set.of("message.admitted").map(({ data }) => data.sourceEventCid), f.set.of("message.prepared").length, f.set.of("message.out").length]).toEqual(["admitted", [cid], 1, 1]);
      expect((await prepare(alice.runtime, alice.keys, MESSAGE, options({ trace }))).outcome).toBe("reused");
      expect((await fold(alice)).set.of("message.admitted")).toHaveLength(1);
      await closeAll(alice, bob);
    }
  });

  it("prepares nothing the fold asks no package for, and terminates an intent whose expiry has passed", async () => {
    const { alice, bob, toBob } = await parties();
    const carol = await directParty(3, "https://carol.example/didcomm", CAROL);
    await expect(prepare(alice.runtime, alice.keys, MESSAGE, options())).rejects.toBeInstanceOf(UnknownEntity);
    await send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid }, HELLO, { messageId: MESSAGE });
    await alice.runtime.vault.commit([], [vaultDraft("channel.blocked", { localDid: alice.did, peerDid: bob.did, includeSuccessors: false })]);
    expect(await prepare(alice.runtime, alice.keys, MESSAGE, options())).toEqual({ outcome: "none", messageId: MESSAGE, because: "the channel is blocked" });

    const timed: Content = { ...HELLO, createdTime: 1_000, expiresTime: 2_000 };
    await send(alice.runtime, alice.keys, { channel: channelOf(alice.did, carol.did), recipientDid: carol.longFormDid }, timed, { messageId: SECOND });
    expect(await prepare(alice.runtime, alice.keys, SECOND, options({ now: () => 1_999_999 }))).toMatchObject({ outcome: "prepared" });
    await send(alice.runtime, alice.keys, { channel: channelOf(alice.did, carol.did), recipientDid: carol.longFormDid }, timed, { messageId: THIRD });
    const expired = await prepare(alice.runtime, alice.keys, THIRD, options({ now: () => 2_000_000 }));
    expect(expired).toMatchObject({ outcome: "expired", messageId: THIRD, failed: { data: { messageId: THIRD, code: "expired" } } });
    const f = await fold(alice);
    expect(f.outbound.outbounds.get(THIRD)!.outcome).toEqual({ status: "terminal", code: "expired" });
    expect(await prepare(alice.runtime, alice.keys, THIRD, options({ now: () => 2_000_000 }))).toEqual({ outcome: "none", messageId: THIRD, because: "terminated: expired" });
    expect(f.set.of("message.prepared")).toHaveLength(1);
    await closeAll(alice, bob, carol);
  });
});
