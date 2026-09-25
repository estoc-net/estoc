import { SignJWT, importJWK } from "jose";
import { describe, expect, test } from "vitest";

import { encodeLongForm, type DIDDoc } from "@estoc/did-peer";
import { InvalidDidDocument, anonymousMessageId, canonicalDidOf, didKeyName, inboundMessageId, readPlaintext, scanVault, signFromPrior, vaultDraft, type DidId, type EventCid, type MediationId, type VaultEvent, type VaultEventType, type VaultFold, type WireMessageId } from "@estoc/vault";

import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { PLAIN_TYP, packEncrypted, secretsResolverFor, type IMessage } from "../src/protocol/didcomm.js";
import { AgentTrace, Keyring, MAX_CONTENT_BYTES, Pickup, Receiver, createDid, deliveryKey, receiptOf, reconcile, recordReceipt, type Authenticated, type Delivery, type ReceiverOptions, type Source } from "../src/index.js";
import { didcomm, directParty, freshVault, mediatedParty, newMediator, peerSealer, refuseCommits, reloaded, sealed, type DirectParty, type Fresh } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const MEDIATION = "019b0000-0000-7000-8000-000000000201" as MediationId;
const ALICE_ENDPOINT = "https://alice.example/didcomm";
const BOB_ENDPOINT = "https://bob.example/didcomm";
const CAROL_ENDPOINT = "https://carol.example/didcomm";
const IAT = 1_757_700_000;

const DIRECT: Source = { kind: "direct" };
const pickup = (deliveryId: string): Source => ({ kind: "pickup", mediationId: MEDIATION, deliveryId });

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty }> {
  return { alice: await directParty(1, ALICE_ENDPOINT, DID), bob: await directParty(2, BOB_ENDPOINT, BOB) };
}

async function closeAll(...parties: Fresh[]): Promise<void> {
  for (const p of parties) await p.runtime.close();
}

/** A receiver over the vault's own receipt, every delivery it hands the receipt kept in `seen`. */
async function receiving(holder: Fresh, options: Partial<ReceiverOptions> = {}): Promise<{ receiver: Receiver; seen: Authenticated[] }> {
  const seen: Authenticated[] = [];
  const record = receiptOf(holder.runtime, holder.keys);
  const ring = await Keyring.load(holder.keys, await scanVault(holder.runtime.vault, holder.keys));
  const receiver = new Receiver(holder.runtime, holder.keys, ring, {
    didcomm,
    receipt: (authenticated) => {
      seen.push(authenticated);
      return record(authenticated);
    },
    ...options,
  });
  return { receiver, seen };
}

/** What the gate makes of one message from `bob` to `alice`, without recording it: the receipt is then called by hand. */
async function authenticated(alice: DirectParty, bob: DirectParty, extra: Partial<IMessage> = {}): Promise<Authenticated> {
  const seen: Authenticated[] = [];
  const ring = await Keyring.load(alice.keys, await scanVault(alice.runtime.vault, alice.keys));
  const receiver = new Receiver(alice.runtime, alice.keys, ring, {
    didcomm,
    receipt: async (a) => {
      seen.push(a);
      return { outcome: "terminal", reason: "not recorded here" };
    },
  });
  await receiver.receive({ packed: await sealed(await peerSealer(bob), alice.longFormDid, extra), source: DIRECT });
  receiver.close();
  return seen[0] as Authenticated;
}

const foldOf = (holder: Fresh): Promise<VaultFold> => scanVault(holder.runtime.vault, holder.keys);

async function eventsOf<T extends VaultEventType>(holder: Fresh, type: T): Promise<readonly VaultEvent<T>[]> {
  return (await foldOf(holder)).set.of(type);
}

async function rawEventsOf(holder: Fresh, ...types: string[]): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of holder.runtime.vault.events.scan()) if (types.includes(event.type)) events.push(event);
  return events;
}

const ATTACHMENT = { id: "a1", media_type: "text/plain", data: { base64: "aGVsbG8gZmlsZQ==" } };

describe("the receipt", () => {
  test("a first message from a peer commits its resolution and then the observation naming it by the ID the commit returned, with its content held as objects; the fold places it in its channel; the next message reuses the resolution and takes the next ordinal", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const { receiver, seen } = await receiving(alice, { trace });
    const sealer = await peerSealer(bob);
    const wire = crypto.randomUUID() as WireMessageId;
    const delivery: Delivery = { packed: await sealed(sealer, alice.longFormDid, { id: wire, thid: "t1", created_time: IAT, please_ack: [""], attachments: [ATTACHMENT] }), source: DIRECT };

    const received = await receiver.receive(delivery);
    const [event, ...more] = await eventsOf(alice, "message.in");
    const [resolved] = await eventsOf(alice, "peer.resolved");
    expect([more, received]).toEqual([[], { outcome: "received", key: deliveryKey(delivery), cid: event!.cid, live: true }]);
    const read = readPlaintext(seen[0]!.plaintext);
    expect(event!.data).toEqual({
      messageId: inboundMessageId(bob.did, alice.did, wire),
      wireMessageId: wire,
      receiptOrdinal: "1",
      intentHash: read.intentHash,
      plaintextHash: read.plaintextHash,
      localKeyName: didKeyName(DID, "key-agreement"),
      msgType: BASIC_MESSAGE,
      peerResolutionEventCid: resolved!.cid,
      presentedDid: bob.longFormDid,
      did: bob.did,
      thid: "t1",
      pthid: null,
      createdTime: IAT,
      expiresTime: null,
      pleaseAck: [""],
      ack: [],
      headers: {},
      fromPrior: null,
      bodyCid: read.stored.bodyCid,
      attachmentCids: read.stored.attachmentCids,
      bytes: read.stored.bytes.length,
      receivedVia: { mediationId: null, deliveryId: null },
    });
    expect(resolved!.data).toMatchObject({ localKeyName: didKeyName(DID, "key-agreement"), presentedDid: bob.longFormDid, did: bob.did, peerPublicKey: seen[0]!.sender!.peerPublicKey });
    expect([event!.roots, read.stored.attachmentCids.length]).toEqual([read.stored.roots, 1]);
    for (const cid of read.stored.roots) expect(await alice.runtime.vault.objects.has(cid)).toBe(true);
    const fold = await foldOf(alice);
    const source = fold.channels.sources.get(event!.cid)!;
    expect([source.standing.status, source.channel, source.resolution?.cid]).toEqual(["complete", { localDid: alice.did, peerDid: bob.did }, resolved!.cid]);
    expect(fold.inbound.ofSource(event!.cid)).toMatchObject({ messageId: event!.data.messageId, status: { status: "complete" }, members: [{ source: { event: { cid: event!.cid } } }] });
    expect((await trace.read({ type: "diag.receive" })).map((entry) => entry.data)).toEqual([{ via: "direct", outcome: "received", cid: event!.cid }]);

    expect((await receiver.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    const events = await eventsOf(alice, "message.in");
    expect(events.map(({ data }) => [data.receiptOrdinal, data.peerResolutionEventCid])).toEqual([
      ["1", resolved!.cid],
      ["2", resolved!.cid],
    ]);
    expect(await eventsOf(alice, "peer.resolved")).toHaveLength(1);
    await closeAll(alice, bob);
  });

  test("the recipient is the key that opened the envelope, whatever the plaintext says of its audience: a message whose `to` names someone else and one with no `to` are recorded in the channel of the key that opened them", async () => {
    const { alice, bob } = await parties();
    const carol = await directParty(3, CAROL_ENDPOINT, CAROL);
    const { receiver, seen } = await receiving(alice);
    const sealer = await peerSealer(bob);
    const asIfCarol = { ...sealer, resolver: { resolve: (did: string) => (did === carol.longFormDid ? sealer.resolver.resolve(alice.longFormDid) : sealer.resolver.resolve(did)) } };
    const toCarol = await sealed(asIfCarol, carol.longFormDid);
    const plain = { id: crypto.randomUUID(), typ: PLAIN_TYP, type: BASIC_MESSAGE, from: bob.longFormDid, body: { content: "hello" } } as IMessage;
    const [toNoOne] = await packEncrypted(didcomm, plain, alice.longFormDid, bob.longFormDid, null, sealer.resolver, secretsResolverFor(sealer.secrets), { forward: false });

    expect((await receiver.receive({ packed: toCarol, source: DIRECT })).outcome).toBe("received");
    expect((await receiver.receive({ packed: toNoOne, source: DIRECT })).outcome).toBe("received");
    expect(seen.map(({ plaintext, recipient }) => [plaintext.to, recipient.did])).toEqual([
      [[carol.longFormDid], alice.did],
      [undefined, alice.did],
    ]);
    const fold = await foldOf(alice);
    const events = await eventsOf(alice, "message.in");
    expect(events.map(({ cid, data }) => [data.localKeyName, fold.channels.sources.get(cid)?.standing.status, fold.channels.sources.get(cid)?.channel])).toEqual([
      [didKeyName(DID, "key-agreement"), "complete", { localDid: alice.did, peerDid: bob.did }],
      [didKeyName(DID, "key-agreement"), "complete", { localDid: alice.did, peerDid: bob.did }],
    ]);
    await closeAll(alice, bob, carol);
  });

  test("a message delivered again is another observation of the same input under its own ordinal, live for the first alone, whichever receiver records the others: one execution, no second resolution; the same wire ID with other content is recorded, refused admission and listed as the contradiction it is", async () => {
    const { alice, bob } = await parties();
    const sealer = await peerSealer(bob);
    const wire = crypto.randomUUID();
    const messageId = inboundMessageId(bob.did, alice.did, wire as WireMessageId);
    const packed = await sealed(sealer, alice.longFormDid, { id: wire });
    const { receiver: first } = await receiving(alice);
    expect(await first.receive({ packed, source: pickup("d1") })).toMatchObject({ outcome: "received", live: true });
    first.close();

    const { receiver: again } = await receiving(alice);
    expect(await again.receive({ packed, source: pickup("d1") })).toMatchObject({ outcome: "received", live: false });
    expect(await again.receive({ packed: await sealed(sealer, alice.longFormDid, { id: wire }), source: DIRECT })).toMatchObject({ outcome: "received", live: false });
    const events = await eventsOf(alice, "message.in");
    expect(events.map(({ data }) => [data.receiptOrdinal, data.messageId, data.receivedVia])).toEqual([
      ["1", messageId, { mediationId: MEDIATION, deliveryId: "d1" }],
      ["2", messageId, { mediationId: MEDIATION, deliveryId: "d1" }],
      ["3", messageId, { mediationId: null, deliveryId: null }],
    ]);
    expect(await eventsOf(alice, "peer.resolved")).toHaveLength(1);
    const fold = await foldOf(alice);
    expect([fold.inbound.executions.size, fold.inbound.ofMessage(messageId)?.members.length, fold.inbound.ofMessage(messageId)?.status]).toEqual([1, 3, { status: "complete" }]);

    const other = await again.receive({ packed: await sealed(sealer, alice.longFormDid, { id: wire, body: { content: "other" } }), source: DIRECT });
    expect(other).toMatchObject({ outcome: "received", live: false });
    const contradicted = await foldOf(alice);
    const execution = contradicted.inbound.ofMessage(messageId)!;
    expect([contradicted.inbound.executions.size, execution.status, execution.members.map(({ admitted }) => admitted), execution.contradicting.map(({ source }) => source.event.cid)]).toEqual([1, { status: "complete" }, [true, true, true, false], [(other as { cid: string }).cid]]);
    expect(contradicted.dispositions.disposition((other as { cid: EventCid }).cid)).toEqual({ status: "pending-admission", because: "the observation contradicts the intent its input has admitted" });
    await closeAll(alice, bob);
  });

  test("an anonymous message is recorded with no resolution, under the ID its local key derives, and the fold lists it as anonymous; one carrying a from_prior is terminal, since nothing authenticates whom the proof is about", async () => {
    const { alice, bob } = await parties();
    const { receiver, seen } = await receiving(alice);
    const wire = crypto.randomUUID();
    expect((await receiver.receive({ packed: await sealed(null, alice.longFormDid, { id: wire }), source: DIRECT })).outcome).toBe("received");
    const [event] = await eventsOf(alice, "message.in");
    expect(event!.data).toMatchObject({ messageId: anonymousMessageId(didKeyName(DID, "key-agreement"), wire as WireMessageId), peerResolutionEventCid: null, presentedDid: null, did: null, localKeyName: didKeyName(DID, "key-agreement") });
    expect(await eventsOf(alice, "peer.resolved")).toEqual([]);
    const fold = await foldOf(alice);
    expect([fold.inbound.anonymous.map(({ event: { cid } }) => cid), fold.inbound.executions.size]).toEqual([[event!.cid], 0]);

    const anonymous = seen[0] as Authenticated;
    const withProof = { ...anonymous, plaintext: { ...anonymous.plaintext, from_prior: "not-a-proof" } as IMessage, fromPrior: "not-a-proof" };
    expect(await recordReceipt(alice.runtime, alice.keys, withProof)).toEqual({ outcome: "terminal", reason: "the envelope is anonymous, but its plaintext carries a from_prior" });
    expect(await eventsOf(alice, "message.in")).toHaveLength(1);
    await closeAll(alice, bob);
  });

  test("a carried proof is kept as the string it came as, one that verifies and one that is no JWT alike: the fold judges it, the receipt does not", async () => {
    const { alice, bob } = await parties();
    const { receiver } = await receiving(alice);
    const routeId = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, IAT);
    expect((await receiver.receive({ packed: await sealed(await peerSealer(bob), alice.longFormDid, { from_prior: proof }), source: DIRECT })).outcome).toBe("received");
    receiver.close();
    const plain = await authenticated(alice, bob);
    const bogus = await recordReceipt(alice.runtime, alice.keys, { ...plain, plaintext: { ...plain.plaintext, from_prior: "not-a-jwt" } as IMessage, fromPrior: "not-a-jwt" });
    expect(bogus.outcome).toBe("received");

    const [verified, unreadable] = await eventsOf(alice, "message.in");
    expect([verified!.data.fromPrior, unreadable!.data.fromPrior]).toEqual([proof, "not-a-jwt"]);
    const fold = await foldOf(alice);
    expect(fold.channels.carriers.get(verified!.cid)?.facts).toEqual([
      { kind: "peer-transition", id: `receipt:${verified!.cid}:transition`, at: { localDid: alice.did, peerDid: prior.did }, change: { kind: "rotate", successor: bob.did }, receipt: verified!.cid },
      { kind: "address-observed", id: `receipt:${verified!.cid}:observation`, at: { localDid: alice.did, peerDid: bob.did }, carriedTransition: `receipt:${verified!.cid}:transition`, receipt: verified!.cid },
    ]);
    expect(fold.channels.carriers.get(unreadable!.cid)).toMatchObject({ proof: { status: "invalid" }, facts: [] });
    expect([fold.channels.sources.get(verified!.cid)?.standing.status, fold.channels.sources.get(unreadable!.cid)?.standing.status]).toEqual(["complete", "complete"]);
    await closeAll(alice, bob);
  });

  test("a proof whose hash-valid issuer the vault could never retain a document for is received, recorded and judged by the fold like any other, and stops neither the scan nor the next message", async () => {
    const { alice, bob } = await parties();
    const { receiver } = await receiving(alice);
    const routeId = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const signing = await bob.keys.signing(didKeyName(BOB_PRIOR, "authentication"));
    const service = (serviceEndpoint: string) => ({ id: "#same", type: "DIDCommMessaging", serviceEndpoint });
    const twoServices = encodeLongForm({ ...prior.inputDocument, service: [service("https://one.example"), service("https://two.example")] });
    const untyped = encodeLongForm({ verificationMethod: [{ id: "#key-1", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: signing.privateJwk().x } }], authentication: ["#key-1"] });
    for (const iss of [twoServices, untyped]) expect(() => canonicalDidOf(iss)).toThrow(InvalidDidDocument);
    const key = await importJWK(signing.privateJwk(), "EdDSA");
    const carried = (iss: string) => new SignJWT({ iss, sub: bob.longFormDid, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: `${iss}#key-1` }).sign(key);
    const proofs = [await carried(twoServices), await carried(untyped)];

    // the sender's own packer verifies the proof before sealing, so a hostile sender answers its packer with a document of its predecessor's key under each issuer
    const honest = await peerSealer(bob);
    const priorDocument = JSON.stringify(await honest.resolver.resolve(prior.longFormDid));
    const sealer = {
      ...honest,
      resolver: {
        resolve: (did: string) => ([twoServices, untyped].includes(did) ? Promise.resolve(JSON.parse(priorDocument.replaceAll(prior.longFormDid, did)) as DIDDoc) : honest.resolver.resolve(did)),
      },
    };
    for (const from_prior of proofs) expect((await receiver.receive({ packed: await sealed(sealer, alice.longFormDid, { from_prior }), source: DIRECT })).outcome).toBe("received");
    const [first, second] = await eventsOf(alice, "message.in");
    expect([first!.data.fromPrior, second!.data.fromPrior]).toEqual(proofs);
    const fold = await foldOf(alice);
    const transitions = [first, second].map((event) => fold.channels.carriers.get(event!.cid)!.facts.map(({ kind, at }) => [kind, at.peerDid]));
    expect(transitions).toEqual([twoServices, untyped].map((iss) => [
      ["peer-transition", iss.slice(0, iss.lastIndexOf(":"))],
      ["address-observed", bob.did],
    ]));

    expect((await receiver.receive({ packed: await sealed(honest, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    expect((await foldOf(alice)).channels.sources.size).toBe(3);
    await closeAll(alice, bob);
  });

  test("the receipt admits the observation before the lock is released, judged among every other in first-receipt order: a message from the address the peer has since left is recorded and ignored, and deliveries recorded at once each have their admission decided before the next is recorded", async () => {
    const { alice, bob } = await parties();
    const { receiver } = await receiving(alice);
    const routeId = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, IAT);
    const carried = await receiver.receive({ packed: await sealed(await peerSealer(bob), alice.longFormDid, { from_prior: proof }), source: DIRECT });
    const fromOld = await receiver.receive({ packed: await sealed(await peerSealer(bob, prior.longFormDid), alice.longFormDid), source: DIRECT });
    if (carried.outcome !== "received" || fromOld.outcome !== "received") throw new Error("not received");
    const fold = await foldOf(alice);
    expect((await eventsOf(alice, "message.admitted")).map(({ data }) => data.sourceEventCid)).toEqual([carried.cid]);
    expect([fold.dispositions.disposition(carried.cid).status, fold.dispositions.disposition(fromOld.cid)]).toEqual(["admitted", { status: "ignored-superseded" }]);
    expect([fold.inbound.ofSource(carried.cid)!.status, fold.inbound.ofSource(fromOld.cid)!.status]).toEqual([{ status: "complete" }, { status: "pending", because: "no observation of the input is admitted" }]);
    receiver.close();

    const one = await authenticated(alice, bob);
    const other = await authenticated(alice, bob);
    const outcomes = await Promise.all([one, other].map((a) => recordReceipt(alice.runtime, alice.keys, a)));
    expect(outcomes.map(({ outcome }) => outcome)).toEqual(["received", "received"]);
    const inOrder = (await foldOf(alice)).set;
    const sequence = [...inOrder.all()]
      .filter((event) => event.type === "message.in" || event.type === "message.admitted")
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map((event) => event.type);
    expect(sequence).toEqual(["message.in", "message.admitted", "message.in", "message.in", "message.admitted", "message.in", "message.admitted"]);
    await closeAll(alice, bob);
  });

  test("a plaintext the vault does not record is terminal with nothing committed: a return_route header, a body that is not an object, content past what a message may carry, and a delivery ID the record cannot carry", async () => {
    const { alice, bob } = await parties();
    const plain = await authenticated(alice, bob);
    const withPlaintext = (patch: Record<string, unknown>): Authenticated => ({ ...plain, plaintext: { ...plain.plaintext, ...patch } as IMessage });
    const record = (a: Authenticated) => recordReceipt(alice.runtime, alice.keys, a);

    expect(await record(withPlaintext({ return_route: "all" }))).toEqual({ outcome: "terminal", reason: "the plaintext does not read: return_route is not allowed in a vault plaintext" });
    expect(await record(withPlaintext({ body: "text" }))).toEqual({ outcome: "terminal", reason: "the plaintext does not read: body must be a JSON object" });
    expect(await record(withPlaintext({ body: { content: "x".repeat(MAX_CONTENT_BYTES) } }))).toMatchObject({ outcome: "terminal", reason: expect.stringMatching(/^the body is \d+ bytes, past the 16777216 a message may carry$/) });
    const oversized = Buffer.from(new Uint8Array(MAX_CONTENT_BYTES + 1)).toString("base64");
    expect(await record(withPlaintext({ attachments: [{ id: "big", data: { base64: oversized } }] }))).toMatchObject({ outcome: "terminal", reason: expect.stringMatching(/^the attachment bafkr\S+ is 16777217 bytes, past the 16777216 a message may carry$/) });
    expect(await record({ ...plain, delivery: { ...plain.delivery, source: pickup("") } })).toMatchObject({ outcome: "terminal", reason: expect.stringMatching(/^the message does not record: /) });
    expect([await eventsOf(alice, "message.in"), await eventsOf(alice, "peer.resolved")]).toEqual([[], []]);
    await closeAll(alice, bob);
  });

  test("the receipt checks the recipient again under the lock: one still recovering defers the record with a watch that says something else once it can receive, and a route retired since the gate refuses it", async () => {
    const { alice, bob } = await parties();
    const plain = await authenticated(alice, bob);
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(await rawEventsOf(alice, "did.created"));
    const deferred = await recordReceipt(copy.runtime, copy.keys, plain);
    expect(deferred).toMatchObject({ outcome: "deferred", reason: `${alice.did} may not receive yet: the bound route is not configured` });
    const watch = (deferred as { watch: (fold: VaultFold) => string }).watch;
    const before = watch(await foldOf(copy));
    await copy.runtime.ingest(await rawEventsOf(alice, "route.configured"));
    expect(watch(await foldOf(copy))).not.toBe(before);
    expect((await recordReceipt(copy.runtime, copy.keys, plain)).outcome).toBe("received");
    expect(await eventsOf(copy, "message.in")).toHaveLength(1);

    const routeId = (await foldOf(alice)).routes.dids.get(DID)!.created!.boundRouteId;
    await alice.runtime.vault.commit([], [vaultDraft("route.retired", { routeId, because: "gone" })]);
    expect(await recordReceipt(alice.runtime, alice.keys, plain)).toEqual({ outcome: "terminal", reason: `${alice.did} may no longer receive` });
    expect(await eventsOf(alice, "message.in")).toEqual([]);
    await closeAll(alice, bob, copy);
  });

  test("over a pickup, the observation records where it arrived and is acknowledged once recorded: a record the disk refuses leaves the delivery queued, and the retry records it once, reusing the resolution the refused attempt committed", async () => {
    const mediator = await newMediator();
    const p = await mediatedParty(mediator, 1, DID);
    await reloaded(p);
    await reconcile(p.link, p.runtime, p.keys, p.mediationId);
    const bob = await directParty(2, BOB_ENDPOINT, BOB);
    const receiver = new Receiver(p.runtime, p.keys, p.ring, { didcomm, receipt: receiptOf(p.runtime, p.keys) });
    const drain = new Pickup(p.link, receiver.pickupHandle(p.mediationId));
    const account = p.created.data.me.did;
    mediator.queues.set(account, [{ id: "q1", packed: await sealed(await peerSealer(bob), p.longFormDid) }]);

    refuseCommits(p.runtime, "message.in", 1);
    expect(await drain.drain()).toMatchObject({ acked: 0 });
    expect([(await eventsOf(p, "message.in")).length, (await eventsOf(p, "peer.resolved")).length, mediator.queues.get(account)?.length]).toEqual([0, 1, 1]);

    expect(await drain.drain()).toEqual({ acked: 1, ended: "empty" });
    const [event, ...more] = await eventsOf(p, "message.in");
    const [resolved] = await eventsOf(p, "peer.resolved");
    expect([more, event!.data.receivedVia, event!.data.peerResolutionEventCid]).toEqual([[], { mediationId: p.mediationId, deliveryId: "q1" }, resolved!.cid]);
    expect([(await eventsOf(p, "peer.resolved")).length, mediator.queues.get(account) ?? []]).toEqual([1, []]);
    await closeAll(p, bob);
  });
});
