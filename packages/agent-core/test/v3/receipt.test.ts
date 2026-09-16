import { describe, expect, it, vi } from "vitest";

import type { Held, VaultRuntime } from "@estoc/event-store/v3";
import {
  deleteContact,
  didKeyName,
  inboundMessageId,
  relationshipId,
  scanVault,
  signFromPrior,
  vaultDraft,
  type ContactId,
  type Did,
  type DidId,
  type DidUrl,
  type EventReference,
  type MediationId,
  type PublicKey,
  type RelationshipId,
  type VaultEvent,
  type VaultEventType,
  type VaultFold,
  type WireMessageId,
} from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { Keyring, Receiver, authorizedKeys, commitResolution, createDid, disclose, prepare, receiptOf, recordReceipt, resolutionData, retireDid, send, type Authenticated, type ReceiverOptions, type Resolution, type Source } from "../../src/v3/index.js";
import { didcomm, directParty, freshVault, handTimers, json, peerSealer, sealed, webFetch, webIdentity, webResolution, webSealer, type DirectParty, type Fresh } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const OTHER = "019b0000-0000-7000-8000-00000000000c" as DidId;
const SUCCESSOR = "019b0000-0000-7000-8000-0000000000c1" as DidId;
const STRANGER = "019b0000-0000-7000-8000-0000000000c2" as DidId;
const CONTACT = "019b0000-0000-7000-8000-000000000301" as ContactId;
const MEDIATION = "019b0000-0000-7000-8000-000000000201" as MediationId;
const ALICE_ENDPOINT = "https://alice.example/didcomm";
const CAROL_ENDPOINT = "https://carol.example/didcomm";
const BOB = "did:web:bob.example" as Did;
const BOB_URL = "https://bob.example/.well-known/did.json";
const EMPTY = "https://didcomm.org/empty/1.0/empty";
const IAT = 1_757_700_000;

const DIRECT: Source = { kind: "direct" };
const pickup = (deliveryId: string): Source => ({ kind: "pickup", mediationId: MEDIATION, deliveryId });

async function receiving(holder: Fresh, options: Partial<ReceiverOptions> = {}): Promise<Receiver> {
  const ring = await Keyring.load(holder.keys, await scanVault(holder.runtime.vault, holder.keys));
  return new Receiver(holder.runtime, holder.keys, ring, { didcomm, receipt: receiptOf(holder.runtime, holder.keys), timers: handTimers(), ...options });
}

function bobHost(document: Parameters<typeof json>[0]): ReturnType<typeof webFetch> {
  return webFetch({ [BOB_URL]: () => json(document) });
}

async function foldOf(holder: Fresh): Promise<VaultFold> {
  return scanVault(holder.runtime.vault, holder.keys);
}

async function eventsOf<T extends VaultEventType>(runtime: VaultRuntime, type: T): Promise<VaultEvent<T>[]> {
  const events: VaultEvent<T>[] = [];
  for await (const event of runtime.vault.events.scan()) if (event.type === type) events.push(event as VaultEvent<T>);
  return events;
}

async function allEvents(runtime: VaultRuntime, ...types: VaultEventType[]): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of runtime.vault.events.scan()) if ((types as string[]).includes(event.type)) events.push(event);
  return events;
}

/**
 * Every commit made under the runtime's lock, as the types it drafted, in
 * order; a commit `refuse` picks is refused as a full disk refuses it.
 */
function watchCommits(runtime: VaultRuntime, refuse: (types: string[]) => boolean = () => false): string[][] {
  const commits: string[][] = [];
  const watching = (held: Held): Held =>
    new Proxy(held, {
      get(target, key) {
        if (key === "commit") {
          return async (...args: Parameters<Held["commit"]>) => {
            const types = args[1].map((draft) => draft.type);
            if (refuse(types)) throw new Error("the disk is full for now");
            const events = await target.commit(...args);
            commits.push(types);
            return events;
          };
        }
        if (key === "locked") return (work: (inner: Held) => Promise<unknown>) => target.locked((inner) => work(watching(inner)));
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  const locked = runtime.locked.bind(runtime);
  vi.spyOn(runtime, "locked").mockImplementation(((work: (held: Held) => Promise<unknown>) => locked((held) => work(watching(held)))) as VaultRuntime["locked"]);
  return commits;
}

async function boundRouteOf(holder: DirectParty) {
  return (await foldOf(holder)).routes.dids.get(holder.didId)!.created!.boundRouteId;
}

async function everyEvent(runtime: VaultRuntime): Promise<VaultEvent<VaultEventType>[]> {
  const events: VaultEvent<VaultEventType>[] = [];
  for await (const event of runtime.vault.events.scan()) events.push(event as VaultEvent<VaultEventType>);
  return events;
}

async function bindTo(holder: DirectParty, resolution: Resolution): Promise<void> {
  const [peerPublicKey] = authorizedKeys(resolution, "keyAgreement").values();
  const root = await commitResolution(holder.runtime, { resolution, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: peerPublicKey as PublicKey });
  await holder.runtime.vault.commit([], [vaultDraft("relationship.bound", { relationshipId: relationshipId(holder.did, resolution.did), localDidId: DID, peerResolutionEventId: root.eventId as EventReference<"peer.resolved"> })]);
}

async function rotatedLocally(alice: DirectParty, carol: DirectParty, receiver: Receiver) {
  expect((await receiver.receive({ packed: await sealed(await peerSealer(carol), alice.longFormDid), source: DIRECT })).outcome).toBe("received");
  const { minted: successor } = await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), OTHER);
  const R = relationshipId(alice.did, carol.did) as RelationshipId;
  const proof = await signFromPrior(alice.keys, { didId: DID, longFormDid: alice.longFormDid }, successor.longFormDid, IAT);
  const [edge] = await alice.runtime.vault.commit([], [vaultDraft("relationship.localTransitioned", { relationshipId: R, fromDidId: DID, toDidId: OTHER, fromPrior: proof, triggerEventId: null })]);
  return { successor, edge: edge!, R };
}

describe("a pair born with its first message", () => {
  it("a first message from a pair nothing holds commits the sender's resolution, the binding and the observation each on its own, the observation naming the binding by the event ID its commit returned; the next message only adds its observation", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const receiver = await receiving(alice, { fetch: bobHost(bob.document).fetch });
    const commits = watchCommits(alice.runtime);

    const unknownType = await sealed(await webSealer(bob), alice.longFormDid, { type: "https://example.org/unheard-of/1.0/thing" });
    expect((await receiver.receive({ packed: unknownType, source: pickup("d1") })).outcome).toBe("received");
    expect(commits).toEqual([["peer.resolved"], ["relationship.bound"], ["message.in"]]);

    const R = relationshipId(alice.did, BOB);
    let fold = await foldOf(alice);
    const [resolved] = fold.set.of("peer.resolved");
    const [bound] = fold.set.of("relationship.bound");
    const [first] = fold.set.of("message.in");
    expect(bound!.data).toEqual({ relationshipId: R, localDidId: DID, peerResolutionEventId: resolved!.eventId });
    expect(first!.data).toMatchObject({
      receiptOrdinal: "1",
      msgType: "https://example.org/unheard-of/1.0/thing",
      localKeyName: didKeyName(DID, "key-agreement"),
      peerResolutionEventId: resolved!.eventId,
      relationshipBindingEventId: bound!.eventId,
      peerTransitionEventId: null,
      presentedDid: BOB,
      did: BOB,
      fromPrior: null,
      receivedVia: { mediationId: MEDIATION, deliveryId: "d1" },
    });
    expect(first!.roots).toEqual([first!.data.bodyCid]);
    expect(fold.relationships.observations.get(first!.eventId)).toEqual({ status: "scoped", relationshipId: R });

    expect((await receiver.receive({ packed: await sealed(await webSealer(bob), alice.longFormDid), source: pickup("d2") })).outcome).toBe("received");
    expect(commits.slice(3)).toEqual([["message.in"]]);
    fold = await foldOf(alice);
    expect(fold.set.of("message.in").map((event) => [event.data.receiptOrdinal, event.data.relationshipBindingEventId])).toEqual([
      ["1", bound!.eventId],
      ["2", bound!.eventId],
    ]);
    await alice.runtime.close();
  });

  it("a crash between the binding and the observation leaves the binding and consumes no invitation; the retry authenticates again and names the binding committed before, for a pure acknowledgement too", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const { disclosed } = await disclose(null, alice.runtime, alice.keys, DID, { as: "oob", uses: "one" });
    const oobId = disclosed.data.oobId as string;
    const bob = await webIdentity(BOB);
    const host = bobHost(bob.document);
    let refusals = 1;
    const commits = watchCommits(alice.runtime, (types) => types.includes("message.in") && refusals-- > 0);
    const receiver = await receiving(alice, { fetch: host.fetch });
    const ack = await sealed(await webSealer(bob), alice.longFormDid, { type: EMPTY, body: {}, ack: [crypto.randomUUID()], pthid: oobId } as never);

    expect(await receiver.receive({ packed: ack, source: pickup("d1") })).toMatchObject({ outcome: "deferred", wait: "local", reason: "the receipt failed: the disk is full for now" });
    let fold = await foldOf(alice);
    const [bound] = fold.set.of("relationship.bound");
    expect([fold.set.of("message.in"), fold.invitations.invitations.get(oobId)?.consumers]).toEqual([[], []]);

    expect(await receiver.localStateChanged()).toMatchObject([{ outcome: "received" }]);
    expect(host.calls).toEqual([BOB_URL, BOB_URL]);
    expect(commits).toEqual([["peer.resolved"], ["relationship.bound"], ["message.in"]]);
    fold = await foldOf(alice);
    expect(fold.set.of("relationship.bound")).toHaveLength(1);
    expect(fold.set.of("message.in").map((event) => [event.data.msgType, event.data.relationshipBindingEventId])).toEqual([[EMPTY, bound!.eventId]]);
    expect(fold.invitations.invitations.get(oobId)?.consumers).toEqual([relationshipId(alice.did, BOB)]);
    await alice.runtime.close();
  });

  it("a first message crossing a birth queued the other way binds the same relationship, and preparing the queued message reuses that binding", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const sent = await send(alice.runtime, alice.keys, { peerDid: carol.longFormDid, sender: { didId: DID } }, { type: BASIC_MESSAGE, body: { content: "hi" } });
    const receiver = await receiving(alice);

    expect((await receiver.receive({ packed: await sealed(await peerSealer(carol), alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    const fold = await foldOf(alice);
    const [bound] = fold.set.of("relationship.bound");
    expect(bound!.data.relationshipId).toBe(sent.relationshipId);
    expect(fold.set.of("message.in")[0]!.data.relationshipBindingEventId).toBe(bound!.eventId);

    const prepared = await prepare(alice.runtime, alice.keys, sent.messageId, { didcomm });
    expect(prepared).toMatchObject({ outcome: "prepared", bound: null });
    expect((await foldOf(alice)).set.of("relationship.bound")).toHaveLength(1);
    await alice.runtime.close();
    await carol.runtime.close();
  });

  it("an anonymous message is recorded with no resolution, binding or relationship, under the message ID its local key derives", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const receiver = await receiving(alice);
    const wire = crypto.randomUUID();

    expect((await receiver.receive({ packed: await sealed(null, alice.longFormDid, { id: wire }), source: DIRECT })).outcome).toBe("received");
    const fold = await foldOf(alice);
    expect([fold.set.of("peer.resolved"), fold.set.of("relationship.bound")]).toEqual([[], []]);
    expect(fold.set.of("message.in").map((event) => event.data)).toEqual([
      expect.objectContaining({
        messageId: inboundMessageId({ localKeyName: didKeyName(DID, "key-agreement") }, wire as WireMessageId),
        peerResolutionEventId: null,
        relationshipBindingEventId: null,
        peerTransitionEventId: null,
        presentedDid: null,
        did: null,
        receivedVia: { mediationId: null, deliveryId: null },
      }),
    ]);
    await alice.runtime.close();
  });
});

describe("the receipt's integrity checks", () => {
  it("a one-use invitation is taken by the first root-address receipt naming it: that relationship may name it again, another is terminal before anything is recorded, and the same thread ID at another local address takes nothing", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const { minted: other } = await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), OTHER);
    const { disclosed } = await disclose(null, alice.runtime, alice.keys, DID, { as: "oob", uses: "one" });
    const oobId = disclosed.data.oobId as string;
    const bob = await webIdentity(BOB);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const receiver = await receiving(alice, { fetch: bobHost(bob.document).fetch });
    const bobSealer = await webSealer(bob);
    const carolSealer = await peerSealer(carol);

    expect((await receiver.receive({ packed: await sealed(bobSealer, alice.longFormDid, { pthid: oobId }), source: DIRECT })).outcome).toBe("received");
    expect((await receiver.receive({ packed: await sealed(bobSealer, alice.longFormDid, { pthid: oobId }), source: DIRECT })).outcome).toBe("received");
    expect((await receiver.receive({ packed: await sealed(carolSealer, other.longFormDid, { pthid: oobId }), source: DIRECT })).outcome).toBe("received");
    const before = (await foldOf(alice)).set.of("message.in").length;

    const toCarol = relationshipId(alice.did, carol.did);
    expect(await receiver.receive({ packed: await sealed(carolSealer, alice.longFormDid, { pthid: oobId }), source: DIRECT })).toMatchObject({ outcome: "terminal", reason: `the invitation ${oobId} is not open to ${toCarol}` });
    const fold = await foldOf(alice);
    expect(fold.set.of("message.in")).toHaveLength(before);
    expect(fold.set.of("relationship.bound").map((event) => event.data.relationshipId)).not.toContain(toCarol);
    expect(fold.invitations.invitations.get(oobId)).toMatchObject({ consumers: [relationshipId(alice.did, BOB)], conflict: false });
    await alice.runtime.close();
    await carol.runtime.close();
  });

  it("a retired address keeps receiving in the relationship whose history holds it, and no new pair is born at it", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const receiver = await receiving(alice, { fetch: bobHost(bob.document).fetch });
    const bobSealer = await webSealer(bob);
    expect((await receiver.receive({ packed: await sealed(bobSealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    await retireDid(alice.runtime, alice.keys, DID, "rotated");

    expect((await receiver.receive({ packed: await sealed(bobSealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    expect(await receiver.receive({ packed: await sealed(await peerSealer(carol), alice.longFormDid), source: DIRECT })).toMatchObject({ outcome: "terminal", reason: `${alice.did} is retired and takes no new relationship` });
    const fold = await foldOf(alice);
    expect(fold.set.of("message.in")).toHaveLength(2);
    expect(fold.set.of("relationship.bound")).toHaveLength(1);
    await alice.runtime.close();
    await carol.runtime.close();
  });

  it("the same envelope received again is not recorded twice; a new delivery of the same message is a new observation with a new ordinal, and one under the same wire ID with other content is recorded as the conflict it is", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const host = bobHost(bob.document);
    const bobSealer = await webSealer(bob);
    const wire = crypto.randomUUID();
    const packed = await sealed(bobSealer, alice.longFormDid, { id: wire });

    const first = await receiving(alice, { fetch: host.fetch });
    expect((await first.receive({ packed, source: DIRECT })).outcome).toBe("received");
    first.close();
    const second = await receiving(alice, { fetch: host.fetch });
    expect((await second.receive({ packed, source: DIRECT })).outcome).toBe("received");
    expect((await foldOf(alice)).set.of("message.in")).toHaveLength(1);

    expect((await second.receive({ packed, source: pickup("d1") })).outcome).toBe("received");
    expect((await second.receive({ packed: await sealed(bobSealer, alice.longFormDid, { id: wire, body: { content: "something else" } }), source: pickup("d2") })).outcome).toBe("received");
    const fold = await foldOf(alice);
    const observations = fold.set.of("message.in");
    expect(observations.map((event) => event.data.receiptOrdinal)).toEqual(["1", "2", "3"]);
    expect(new Set(observations.map((event) => event.data.messageId)).size).toBe(1);
    expect(fold.relationships.groups.get(observations[0]!.data.messageId)?.status).toBe("conflict");
    await alice.runtime.close();
  });

  it("input in a relationship assigned to a deleted contact is recorded and then cleaned up: its content erased, the contact still deleted and not made again", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), OTHER);
    const bob = await webIdentity(BOB);
    const receiver = await receiving(alice, { fetch: bobHost(bob.document).fetch });
    const bobSealer = await webSealer(bob);
    expect((await receiver.receive({ packed: await sealed(bobSealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    const R = relationshipId(alice.did, BOB);
    await alice.runtime.vault.commit([], [vaultDraft("contact.created", { contactId: CONTACT, because: "user" }), vaultDraft("relationship.contactAssigned", { relationshipId: R, contactId: CONTACT })]);
    await deleteContact(alice.runtime, alice.keys, CONTACT);

    expect((await receiver.receive({ packed: await sealed(bobSealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    const fold = await foldOf(alice);
    const late = fold.set.of("message.in")[1]!;
    expect(fold.relationships.observations.get(late.eventId)).toEqual({ status: "scoped", relationshipId: R });
    expect(fold.set.of("message.erased").map((event) => event.data.messageId)).toContain(late.data.messageId);
    expect([fold.contacts.get(CONTACT)?.deleted, fold.set.of("contact.created")]).toEqual([true, [expect.anything()]]);
    await alice.runtime.close();
  });

  it("a proof-free message at a pair whose binding an earlier observation names, and which is not here yet, waits for it; once the binding arrives it is received under that binding", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const carolSealer = await peerSealer(carol);
    const receiver = await receiving(alice);
    expect((await receiver.receive({ packed: await sealed(carolSealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    receiver.close();

    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(await allEvents(alice.runtime, "did.created", "route.configured", "peer.resolved", "message.in"));
    const copied = await receiving(copy);
    const [earlier] = await eventsOf(alice.runtime, "message.in");
    const [binding] = await eventsOf(alice.runtime, "relationship.bound");
    expect(await copied.receive({ packed: await sealed(carolSealer, alice.longFormDid), source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the pair ${alice.did} / ${carol.did} awaits the standing of ${earlier!.eventId} at the same pair, which awaits its binding`,
    });
    expect((await foldOf(copy)).set.of("relationship.bound")).toEqual([]);

    await copy.runtime.ingest([binding]);
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    const fold = await foldOf(copy);
    expect(fold.set.of("relationship.bound")).toHaveLength(1);
    expect(fold.set.of("message.in").map((event) => event.data.relationshipBindingEventId)).toEqual([binding!.eventId, binding!.eventId]);
    await alice.runtime.close();
    await carol.runtime.close();
    await copy.runtime.close();
  });
});

describe("a peer's address changing", () => {
  /** Alice bound to Carol's first DID, and Carol with a successor DID and the proof her first DID signs over it. */
  async function rotating() {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const route = await boundRouteOf(carol);
    const { minted: successor } = await createDid(carol.runtime, carol.keys, route, SUCCESSOR);
    const { minted: stranger } = await createDid(carol.runtime, carol.keys, route, STRANGER);
    const proof = await signFromPrior(carol.keys, { didId: DID, longFormDid: carol.longFormDid }, successor.longFormDid, IAT);
    return { alice, carol, successor, stranger, proof, first: await peerSealer(carol), next: await peerSealer(carol, successor.longFormDid) };
  }

  it("a carrier is placed by its proof's issuer and checked against the snapshot there before it is recorded; it leaves its pair pending, so a proof-free message from the successor waits until the transition is committed, and then a new message from the superseded address is terminal while a repeat of one received from it before is recorded", async () => {
    const { alice, carol, successor, stranger, proof, first, next } = await rotating();
    const { minted: other } = await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), OTHER);
    const seen: Authenticated[] = [];
    const receipt = receiptOf(alice.runtime, alice.keys);
    const receiver = await receiving(alice, { receipt: (authenticated) => (seen.push(authenticated), receipt(authenticated)) });
    const R = relationshipId(alice.did, carol.did);
    const earlierWire = crypto.randomUUID();
    const earlier = { id: earlierWire, body: { content: "before" } };
    expect((await receiver.receive({ packed: await sealed(first, alice.longFormDid, earlier), source: DIRECT })).outcome).toBe("received");

    expect((await receiver.receive({ packed: await sealed(next, alice.longFormDid, { from_prior: proof }), source: DIRECT })).outcome).toBe("received");
    let fold = await foldOf(alice);
    const [root] = fold.set.of("relationship.bound");
    const carrier = fold.set.of("message.in").at(-1)!;
    expect(carrier.data).toMatchObject({ fromPrior: proof, presentedDid: successor.longFormDid, did: successor.did, relationshipBindingEventId: root!.eventId, peerTransitionEventId: null });
    expect(fold.relationships.pendingAt(alice.did, successor.did).map((claim) => claim.eventIds)).toEqual([[carrier.eventId]]);

    const carried = seen.at(-1)!;
    const tampered = `${proof.slice(0, -2)}${proof.at(-2) === "A" ? "B" : "A"}${proof.at(-1)}`;
    expect(await recordReceipt(alice.runtime, alice.keys, { ...carried, plaintext: { ...carried.plaintext, from_prior: tampered } })).toMatchObject({ outcome: "terminal", reason: expect.stringContaining(`does not verify against the snapshot ${R} pinned for ${carol.did}`) });
    const elsewhere = await signFromPrior(carol.keys, { didId: DID, longFormDid: carol.longFormDid }, stranger.longFormDid, IAT);
    expect(await recordReceipt(alice.runtime, alice.keys, { ...carried, plaintext: { ...carried.plaintext, from_prior: elsewhere } })).toMatchObject({ outcome: "terminal", reason: `the from_prior names ${stranger.longFormDid} as the successor, not the sender ${successor.longFormDid}` });

    const proofFree = await sealed(next, alice.longFormDid);
    expect(await receiver.receive({ packed: proofFree, source: DIRECT })).toMatchObject({ outcome: "deferred", wait: "relationship", reason: `the pair ${alice.did} / ${successor.did} awaits the evidence of ${carrier.eventId}` });
    expect((await foldOf(alice)).set.of("message.in")).toHaveLength(2);

    const successorResolution = fold.set.resolve(carrier.data.peerResolutionEventId!, "peer.resolved");
    if (successorResolution.status !== "present") throw new Error("the carrier's resolution is here");
    const [edge] = await alice.runtime.vault.commit([], [
      vaultDraft("relationship.peerTransitioned", {
        relationshipId: R,
        localKeyName: didKeyName(DID, "key-agreement"),
        peerPublicKey: successorResolution.event.data.peerPublicKey,
        fromDid: carol.did,
        presentedFromDid: carol.longFormDid,
        toDid: successor.did,
        presentedToDid: successor.longFormDid,
        fromPrior: proof,
        priorResolutionEventId: root!.data.peerResolutionEventId,
        peerResolutionEventId: carrier.data.peerResolutionEventId!,
        messageId: carrier.data.messageId,
      }),
    ]);
    expect(await receiver.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    fold = await foldOf(alice);
    const successorInput = fold.set.of("message.in").at(-1)!;
    expect(successorInput.data).toMatchObject({ relationshipBindingEventId: root!.eventId, peerTransitionEventId: edge!.eventId, fromPrior: null });
    expect(fold.relationships.observations.get(successorInput.eventId)).toEqual({ status: "scoped", relationshipId: R });

    expect(await receiver.receive({ packed: await sealed(first, alice.longFormDid), source: DIRECT })).toMatchObject({ outcome: "terminal", reason: expect.stringContaining(`${carol.did} is a peer address ${R} has moved on from`) });
    expect((await receiver.receive({ packed: await sealed(first, alice.longFormDid, earlier), source: pickup("again") })).outcome).toBe("received");
    expect((await receiver.receive({ packed: await sealed(first, other.longFormDid), source: DIRECT })).outcome).toBe("received");
    fold = await foldOf(alice);
    const observations = fold.set.of("message.in");
    expect(observations).toHaveLength(5);
    expect(observations[3]!.data).toMatchObject({ messageId: observations[0]!.data.messageId, receiptOrdinal: "4", peerTransitionEventId: null });
    expect(fold.relationships.observations.get(observations[4]!.eventId)).toEqual({ status: "scoped", relationshipId: relationshipId(other.did, carol.did) as RelationshipId });
    await alice.runtime.close();
    await carol.runtime.close();
  });

  it("a carrier whose issuer no relationship at its recipient holds waits for evidence at the issuer's pair, recording nothing; once that pair is bound it is retried and recorded as the carrier it is", async () => {
    const { alice, carol, successor, proof, first, next } = await rotating();
    const receiver = await receiving(alice);

    expect(await receiver.receive({ packed: await sealed(next, alice.longFormDid, { from_prior: proof }), source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `no relationship holds the pair ${alice.did} / ${carol.did} the from_prior continues`,
    });
    expect(await eventsOf(alice.runtime, "message.in")).toEqual([]);

    expect((await receiver.receive({ packed: await sealed(first, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    expect(await receiver.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    const fold = await foldOf(alice);
    const [root] = fold.set.of("relationship.bound");
    expect(fold.set.of("message.in").map((event) => [event.data.did, event.data.fromPrior, event.data.relationshipBindingEventId])).toEqual([
      [carol.did, null, root!.eventId],
      [successor.did, proof, root!.eventId],
    ]);
    expect(fold.set.of("relationship.bound")).toHaveLength(1);
    await alice.runtime.close();
    await carol.runtime.close();
  });
});

describe("recording before the vault answers", () => {
  it("a message whose content does not record is terminal with nothing committed", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const seen: Authenticated[] = [];
    const receiver = await receiving(alice, { receipt: async (authenticated) => (seen.push(authenticated), { outcome: "received" }) });
    await receiver.receive({ packed: await sealed(await peerSealer(carol), alice.longFormDid), source: DIRECT });

    const [authenticated] = seen;
    expect(await recordReceipt(alice.runtime, alice.keys, { ...authenticated!, plaintext: { ...authenticated!.plaintext, return_route: "all" } as never })).toMatchObject({ outcome: "terminal", reason: expect.stringContaining("the plaintext does not read") });
    expect(await eventsOf(alice.runtime, "peer.resolved")).toEqual([]);
    await alice.runtime.close();
    await carol.runtime.close();
  });
});

describe("a pair something already claims", () => {
  it("an import that lost only the local transition makes no second relationship at the same pair: the delivery waits for the standing of the observation already there, and the transition restored receives it where the pair belongs", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const sealer = await peerSealer(carol);
    const receiver = await receiving(alice);
    const { successor, edge, R } = await rotatedLocally(alice, carol, receiver);
    expect((await receiver.receive({ packed: await sealed(sealer, successor.longFormDid), source: DIRECT })).outcome).toBe("received");
    receiver.close();

    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest((await everyEvent(alice.runtime)).filter((event) => event.eventId !== edge.eventId));
    const copied = await receiving(copy);
    const [, earlier] = (await foldOf(copy)).set.of("message.in");

    expect(await copied.receive({ packed: await sealed(sealer, successor.longFormDid), source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the pair ${successor.did} / ${carol.did} awaits the standing of ${earlier!.eventId} at the same pair, which arrived at a key outside the local history`,
    });
    expect((await foldOf(copy)).set.of("relationship.bound")).toHaveLength(1);

    await copy.runtime.ingest([edge]);
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    const fold = await foldOf(copy);
    expect(fold.set.of("relationship.bound").map((event) => event.data.relationshipId)).toEqual([R]);
    expect(fold.relationships.claimants(successor.did, carol.did)).toEqual([R]);
    expect(fold.relationships.observations.get(fold.set.of("message.in").at(-1)!.eventId)).toEqual({ status: "scoped", relationshipId: R });
    await alice.runtime.close();
    await carol.runtime.close();
    await copy.runtime.close();
  });

  it("competing local transitions claim the pair each would have added: a delivery to one of those successor addresses waits for them to be settled and nothing is born there", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const receiver = await receiving(alice);
    const { successor, edge, R } = await rotatedLocally(alice, carol, receiver);
    const { minted: competitor } = await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), STRANGER);
    const competing = await signFromPrior(alice.keys, { didId: DID, longFormDid: alice.longFormDid }, competitor.longFormDid, IAT + 1);
    const [other] = await alice.runtime.vault.commit([], [vaultDraft("relationship.localTransitioned", { relationshipId: R, fromDidId: DID, toDidId: STRANGER, fromPrior: competing, triggerEventId: null })]);
    const transitions = (await foldOf(alice)).relationships.transitions;
    expect([transitions.get(edge.eventId)?.status, transitions.get(other!.eventId)?.status]).toEqual(["conflict", "conflict"]);

    expect(await receiver.receive({ packed: await sealed(await peerSealer(carol), successor.longFormDid), source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: expect.stringContaining(`the pair ${successor.did} / ${carol.did} awaits the claim of ${R}, which does not hold the pair yet: `),
    });
    const fold = await foldOf(alice);
    expect(fold.set.of("relationship.bound").map((event) => event.data.relationshipId)).toEqual([R]);
    expect(fold.set.of("message.in")).toHaveLength(1);
    await alice.runtime.close();
    await carol.runtime.close();
  });

  it("an import that lost the first of two local transitions leaves the second one in conflict for want of it: the delivery at the address it adds waits, takes no pickup acknowledgement, and is received in the same relationship once the first is back", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const sealer = await peerSealer(carol);
    const receiver = await receiving(alice);
    const { successor, edge, R } = await rotatedLocally(alice, carol, receiver);
    expect((await receiver.receive({ packed: await sealed(sealer, successor.longFormDid), source: DIRECT })).outcome).toBe("received");
    const trigger = (await foldOf(alice)).set.of("message.in").at(-1)!;
    const { minted: last } = await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), STRANGER);
    const proof = await signFromPrior(alice.keys, { didId: OTHER, longFormDid: successor.longFormDid }, last.longFormDid, IAT + 1);
    const [later] = await alice.runtime.vault.commit([], [vaultDraft("relationship.localTransitioned", { relationshipId: R, fromDidId: OTHER, toDidId: STRANGER, fromPrior: proof, triggerEventId: trigger.eventId as EventReference<"message.in"> })]);
    expect((await foldOf(alice)).relationships.transitions.get(later!.eventId)?.status).toBe("applied");
    receiver.close();

    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest((await everyEvent(alice.runtime)).filter((event) => event.eventId !== edge.eventId));
    expect((await foldOf(copy)).relationships.transitions.get(later!.eventId)?.status).toBe("conflict");
    const acknowledged: string[] = [];
    const copied = await receiving(copy, { acknowledge: async ({ deliveryId }) => void acknowledged.push(deliveryId) });
    const delivery = pickup("d1");

    expect(await copied.receive({ packed: await sealed(sealer, last.longFormDid), source: delivery })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: expect.stringContaining(`the pair ${last.did} / ${carol.did} awaits the claim of ${R}, which does not hold the pair yet: `),
    });
    expect([acknowledged, (await foldOf(copy)).set.of("relationship.bound")]).toEqual([[], [expect.anything()]]);

    await copy.runtime.ingest([edge]);
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    const fold = await foldOf(copy);
    expect(acknowledged).toEqual(["d1"]);
    expect(fold.set.of("relationship.bound").map((event) => event.data.relationshipId)).toEqual([R]);
    expect(fold.relationships.claimants(last.did, carol.did)).toEqual([R]);
    expect(fold.relationships.observations.get(fold.set.of("message.in").at(-1)!.eventId)).toEqual({ status: "scoped", relationshipId: R });
    await alice.runtime.close();
    await carol.runtime.close();
    await copy.runtime.close();
  });

  it("an import that lost only the root resolution keeps the pair a local transition names, though no history reaches it and nothing was ever received there: the delivery waits, and the resolution restored receives it in the same relationship", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const sealer = await peerSealer(carol);
    const receiver = await receiving(alice);
    const { successor, R } = await rotatedLocally(alice, carol, receiver);
    receiver.close();

    const events = await everyEvent(alice.runtime);
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(events.filter((event) => event.type !== "peer.resolved"));
    const copied = await receiving(copy);

    expect(await copied.receive({ packed: await sealed(sealer, successor.longFormDid), source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the pair ${successor.did} / ${carol.did} awaits the claim of ${R}, which does not hold the pair yet: 1 binding names a peer resolution that is not here`,
    });
    expect((await foldOf(copy)).set.of("relationship.bound")).toHaveLength(1);

    await copy.runtime.ingest(events.filter((event) => event.type === "peer.resolved"));
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    const fold = await foldOf(copy);
    expect(fold.set.of("relationship.bound").map((event) => event.data.relationshipId)).toEqual([R]);
    expect(fold.relationships.claimants(successor.did, carol.did)).toEqual([R]);
    expect(fold.relationships.observations.get(fold.set.of("message.in").at(-1)!.eventId)).toEqual({ status: "scoped", relationshipId: R });
    await alice.runtime.close();
    await carol.runtime.close();
    await copy.runtime.close();
  });

  it("an import that lost only the binding keeps the pair the local transition it left behind names: the delivery at the successor address waits, a pair nothing claims is still born beside it, and the binding restored receives it in the same relationship", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const dave = await directParty(4, CAROL_ENDPOINT, DID);
    const sealer = await peerSealer(carol);
    const receiver = await receiving(alice);
    const { successor, R } = await rotatedLocally(alice, carol, receiver);
    receiver.close();

    const events = await everyEvent(alice.runtime);
    const binding = events.find((event) => event.type === "relationship.bound")!;
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(events.filter((event) => event.eventId !== binding.eventId));
    const copied = await receiving(copy);

    expect(await copied.receive({ packed: await sealed(sealer, successor.longFormDid), source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the pair ${successor.did} / ${carol.did} awaits the claim of ${R}, which does not hold the pair yet: no binding`,
    });
    expect((await foldOf(copy)).set.of("relationship.bound")).toEqual([]);

    const withDave = relationshipId(successor.did, dave.did);
    expect((await copied.receive({ packed: await sealed(await peerSealer(dave), successor.longFormDid), source: DIRECT })).outcome).toBe("received");
    expect((await foldOf(copy)).set.of("relationship.bound").map((event) => event.data.relationshipId)).toEqual([withDave]);

    await copy.runtime.ingest([binding]);
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    const fold = await foldOf(copy);
    expect(new Set(fold.set.of("relationship.bound").map((event) => event.data.relationshipId))).toEqual(new Set([R, withDave]));
    expect(fold.relationships.claimants(successor.did, carol.did)).toEqual([R]);
    const received = fold.set.of("message.in").find((event) => event.data.localKeyName === didKeyName(OTHER, "key-agreement") && event.data.did === carol.did)!;
    expect(fold.relationships.observations.get(received.eventId)).toEqual({ status: "scoped", relationshipId: R });
    await alice.runtime.close();
    await carol.runtime.close();
    await dave.runtime.close();
    await copy.runtime.close();
  });

  it("a delivery at a pair whose bindings do not stand waits for the resolutions they name, and those resolutions showing the bindings disagree make it terminal, an observation still waiting at the same pair notwithstanding", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const sealer = await webSealer(bob);
    const first = await receiving(alice, { fetch: bobHost(bob.document).fetch });
    expect((await first.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    first.close();
    await bindTo(alice, await webResolution(await webIdentity(BOB, 78)));
    const events = await everyEvent(alice.runtime);
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(events.filter((event) => event.type !== "peer.resolved"));
    const receiver = await receiving(copy, { fetch: bobHost(bob.document).fetch });
    const packed = await sealed(sealer, alice.longFormDid);
    const R = relationshipId(alice.did, BOB);
    const [earlier] = (await foldOf(copy)).set.of("message.in");

    expect(await receiver.receive({ packed, source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the pair ${alice.did} / ${BOB} awaits the claim of ${R}, which does not hold the pair yet: 2 bindings name a peer resolution that is not here; the standing of ${earlier!.eventId} at the same pair, which awaits its resolution; arrived at a key not yet in the local history; awaits the root`,
    });
    expect((await receiver.receive({ packed, source: DIRECT })).outcome).toBe("deferred");

    await copy.runtime.ingest(events.filter((event) => event.type === "peer.resolved"));
    expect(await receiver.evidenceChanged()).toMatchObject([
      { outcome: "terminal", reason: `the pair ${alice.did} / ${BOB} is claimed by the binding of ${R}, which does not stand: bindings disagree on the root peer document` },
    ]);
    const fold = await foldOf(copy);
    expect([fold.set.of("message.in").length, fold.set.of("relationship.bound").length, fold.set.of("peer.resolved").length]).toEqual([1, 2, 2]);
    await alice.runtime.close();
    await copy.runtime.close();
  });

  it("a binding pinning a snapshot the document it names refutes claims the pair for good: the delivery waits while that document is not here, and the document arriving makes it terminal", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const resolved = await webResolution(bob);
    const [peerPublicKey] = authorizedKeys(resolved, "keyAgreement").values();
    const data = resolutionData({ resolution: resolved, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: peerPublicKey as PublicKey });
    const [snapshot] = await alice.runtime.vault.commit([{ cid: resolved.cid, source: resolved.bytes }], [vaultDraft("peer.resolved", { ...data, authenticationMethodIds: [...data.authenticationMethodIds, `${BOB}#absent` as DidUrl] })]);
    const R = relationshipId(alice.did, BOB);
    const [bound] = await alice.runtime.vault.commit([], [vaultDraft("relationship.bound", { relationshipId: R, localDidId: DID, peerResolutionEventId: snapshot!.eventId as EventReference<"peer.resolved"> })]);

    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(await everyEvent(alice.runtime));
    const receiver = await receiving(copy, { fetch: bobHost(bob.document).fetch });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);

    expect(await receiver.receive({ packed, source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the pair ${alice.did} / ${BOB} awaits the claim of ${R}, which does not hold the pair yet: no root resolution is yet verified against its document`,
    });

    await copy.runtime.locked((held) =>
      held.ingest([snapshot!], async (prepared) => {
        await prepared.putObject(resolved.cid, resolved.bytes);
      }),
    );
    expect(await receiver.evidenceChanged()).toMatchObject([
      { outcome: "terminal", reason: `the pair ${alice.did} / ${BOB} is claimed by the binding of ${R}, which does not stand: binding ${bound!.eventId} pins the snapshot ${snapshot!.eventId}, which is not the document it names` },
    ]);
    const fold = await foldOf(copy);
    expect(fold.checks.resolutionChecks.get(snapshot!.eventId)).toBe("invalid");
    expect([fold.set.of("message.in").length, fold.set.of("relationship.bound").length, fold.set.of("peer.resolved").length]).toEqual([0, 1, 1]);
    await alice.runtime.close();
    await copy.runtime.close();
  });

  it("an import that lost the binding and the first local transition keeps the pair the later transition names through the input that triggered it: the delivery at the address it adds waits, and the two events restored receive it in the same relationship", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const sealer = await peerSealer(carol);
    const receiver = await receiving(alice);
    const { successor, edge, R } = await rotatedLocally(alice, carol, receiver);
    expect((await receiver.receive({ packed: await sealed(sealer, successor.longFormDid), source: DIRECT })).outcome).toBe("received");
    const trigger = (await foldOf(alice)).set.of("message.in").at(-1)!;
    const { minted: last } = await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), STRANGER);
    const proof = await signFromPrior(alice.keys, { didId: OTHER, longFormDid: successor.longFormDid }, last.longFormDid, IAT + 1);
    const [later] = await alice.runtime.vault.commit([], [vaultDraft("relationship.localTransitioned", { relationshipId: R, fromDidId: OTHER, toDidId: STRANGER, fromPrior: proof, triggerEventId: trigger.eventId as EventReference<"message.in"> })]);
    expect((await foldOf(alice)).relationships.transitions.get(later!.eventId)?.status).toBe("applied");
    receiver.close();

    const events = await everyEvent(alice.runtime);
    const omitted = [events.find((event) => event.type === "relationship.bound")!.eventId, edge.eventId];
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(events.filter((event) => !omitted.includes(event.eventId)));
    const copied = await receiving(copy);

    expect(await copied.receive({ packed: await sealed(sealer, last.longFormDid), source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the pair ${last.did} / ${carol.did} awaits the claim of ${R}, which does not hold the pair yet: no binding`,
    });
    expect((await foldOf(copy)).set.of("relationship.bound")).toEqual([]);

    await copy.runtime.ingest(events.filter((event) => omitted.includes(event.eventId)));
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    const fold = await foldOf(copy);
    expect(fold.set.of("relationship.bound").map((event) => event.data.relationshipId)).toEqual([R]);
    expect(fold.relationships.claimants(last.did, carol.did)).toEqual([R]);
    const received = fold.set.of("message.in").find((event) => event.data.localKeyName === didKeyName(STRANGER, "key-agreement"))!;
    expect(fold.relationships.observations.get(received.eventId)).toEqual({ status: "scoped", relationshipId: R });
    await alice.runtime.close();
    await carol.runtime.close();
    await copy.runtime.close();
  });

  it("an import that lost the binding and the local transition keeps the pair the peer transition names through the key it arrived at: a delivery from the superseded peer address waits, and the two events restored make it terminal where the relationship has moved on", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const sealer = await peerSealer(carol);
    const receiver = await receiving(alice);
    const { successor, edge, R } = await rotatedLocally(alice, carol, receiver);
    const { minted: peerNext } = await createDid(carol.runtime, carol.keys, await boundRouteOf(carol), SUCCESSOR);
    const proof = await signFromPrior(carol.keys, { didId: DID, longFormDid: carol.longFormDid }, peerNext.longFormDid, IAT + 1);
    expect((await receiver.receive({ packed: await sealed(await peerSealer(carol, peerNext.longFormDid), successor.longFormDid, { from_prior: proof }), source: DIRECT })).outcome).toBe("received");
    const carried = await foldOf(alice);
    const binding = carried.set.of("relationship.bound")[0]!;
    const carrier = carried.set.of("message.in").at(-1)!;
    const resolved = carried.set.resolve(carrier.data.peerResolutionEventId!, "peer.resolved");
    if (resolved.status !== "present") throw new Error("the carrier's resolution is here");
    const [peerEdge] = await alice.runtime.vault.commit([], [
      vaultDraft("relationship.peerTransitioned", {
        relationshipId: R,
        localKeyName: didKeyName(OTHER, "key-agreement"),
        peerPublicKey: resolved.event.data.peerPublicKey,
        fromDid: carol.did,
        presentedFromDid: carol.longFormDid,
        toDid: peerNext.did,
        presentedToDid: peerNext.longFormDid,
        fromPrior: proof,
        priorResolutionEventId: binding.data.peerResolutionEventId,
        peerResolutionEventId: carrier.data.peerResolutionEventId!,
        messageId: carrier.data.messageId,
      }),
    ]);
    expect((await foldOf(alice)).relationships.transitions.get(peerEdge!.eventId)?.status).toBe("applied");
    const packed = await sealed(sealer, successor.longFormDid);
    expect(await receiver.receive({ packed, source: DIRECT })).toMatchObject({ outcome: "terminal", reason: expect.stringContaining(`${carol.did} is a peer address ${R} has moved on from`) });
    receiver.close();

    const events = await everyEvent(alice.runtime);
    const omitted = [binding.eventId, edge.eventId];
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(events.filter((event) => !omitted.includes(event.eventId)));
    const copied = await receiving(copy);

    expect(await copied.receive({ packed, source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the pair ${successor.did} / ${carol.did} awaits the claim of ${R}, which does not hold the pair yet: no binding`,
    });
    const held = await foldOf(copy);
    expect([held.set.of("relationship.bound").length, held.set.of("message.in").length]).toEqual([0, 2]);

    await copy.runtime.ingest(events.filter((event) => omitted.includes(event.eventId)));
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "terminal", reason: expect.stringContaining(`${carol.did} is a peer address ${R} has moved on from`) }]);
    const fold = await foldOf(copy);
    expect([fold.set.of("relationship.bound").length, fold.set.of("message.in").length]).toEqual([1, 2]);
    expect(fold.relationships.claimants(successor.did, carol.did)).toEqual([R]);
    await alice.runtime.close();
    await carol.runtime.close();
    await copy.runtime.close();
  });
});

describe("an invitation waiting for the evidence of who took it", () => {
  it("the delivery it holds is retried when that evidence arrives: another relationship's consumption makes it terminal", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const { disclosed } = await disclose(null, alice.runtime, alice.keys, DID, { as: "oob", uses: "one" });
    const oobId = disclosed.data.oobId as string;
    const receiver = await receiving(alice, { fetch: bobHost(bob.document).fetch });
    expect((await receiver.receive({ packed: await sealed(await webSealer(bob), alice.longFormDid, { pthid: oobId }), source: DIRECT })).outcome).toBe("received");
    receiver.close();

    const events = await everyEvent(alice.runtime);
    const binding = events.find((event) => event.type === "relationship.bound")!;
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(events.filter((event) => event.eventId !== binding.eventId));
    const copied = await receiving(copy, { fetch: bobHost(bob.document).fetch });

    expect(await copied.receive({ packed: await sealed(await peerSealer(carol), alice.longFormDid, { pthid: oobId }), source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the invitation ${oobId} awaits evidence of who took it`,
    });
    expect((await foldOf(copy)).set.of("message.in")).toHaveLength(1);

    await copy.runtime.ingest([binding]);
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "terminal", reason: `the invitation ${oobId} is not open to ${relationshipId(alice.did, carol.did)}` }]);
    expect((await foldOf(copy)).invitations.invitations.get(oobId)?.consumers).toEqual([relationshipId(alice.did, BOB)]);
    await alice.runtime.close();
    await carol.runtime.close();
    await copy.runtime.close();
  });

  it("the delivery it holds is retried when that evidence arrives: evidence that the earlier input only continued a relationship leaves it open, and the delivery is received and consumes it", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const receiver = await receiving(alice, { fetch: bobHost(bob.document).fetch });
    const { successor } = await rotatedLocally(alice, carol, receiver);
    const { disclosed } = await disclose(null, alice.runtime, alice.keys, OTHER, { as: "oob", uses: "one" });
    const oobId = disclosed.data.oobId as string;

    expect((await receiver.receive({ packed: await sealed(await peerSealer(carol), successor.longFormDid, { pthid: oobId }), source: DIRECT })).outcome).toBe("received");
    expect((await foldOf(alice)).invitations.invitations.get(oobId)?.available).toBe(true);
    receiver.close();

    const events = await everyEvent(alice.runtime);
    const binding = events.find((event) => event.type === "relationship.bound")!;
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(events.filter((event) => event.eventId !== binding.eventId));
    const copied = await receiving(copy, { fetch: bobHost(bob.document).fetch });
    const fromBob = await sealed(await webSealer(bob), successor.longFormDid, { pthid: oobId });

    expect(await copied.receive({ packed: fromBob, source: DIRECT })).toMatchObject({
      outcome: "deferred",
      wait: "relationship",
      reason: `the invitation ${oobId} awaits evidence of who took it`,
    });

    await copy.runtime.ingest([binding]);
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    expect((await foldOf(copy)).invitations.invitations.get(oobId)?.consumers).toEqual([relationshipId(successor.did, BOB)]);
    await alice.runtime.close();
    await carol.runtime.close();
    await copy.runtime.close();
  });
});
