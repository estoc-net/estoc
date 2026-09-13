import type { Event } from "@estoc/event-store/v3";
import { canonicalize } from "@estoc/event-store/v3";
import { importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import {
  authorizedMethodIds,
  didKeyName,
  foldMediations,
  foldRelationships,
  foldRelationshipsVerified,
  foldRoutes,
  inboundMessageId,
  methodPublicKey,
  mintDid,
  peerResolution,
  rawCidOfBytes,
  relationshipId,
  signFromPrior,
  verifyResolutions,
  verifyTransitions,
  VaultEventSet,
  type Cid,
  type ContactId,
  type Did,
  type DidId,
  type EventId,
  type EventReference,
  type Keys,
  type MessageId,
  type PeerResolution,
  type EvidenceCheck,
  type PublicKey,
  type RelationshipFold,
  type RelationshipId,
  type RouteFold,
  type VaultEventSet as EventSet,
  type VaultData,
  type VaultEvent,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { DID_ID, DID_ID2, DID_ID3, DIRECT, HASH, MEDIATED, OTHER_SEED, ROUTE, Scene, cidOf, createdDid, expectOrderFree, mediatedRoute, openKeys, shuffled, snapshot } from "./helpers.js";

const PEER_ID0 = "019b7000-0000-7000-8000-000000000b00" as DidId;
const PEER_ID1 = "019b7000-0000-7000-8000-000000000b01" as DidId;
const PEER_ID2 = "019b7000-0000-7000-8000-000000000b02" as DidId;
const PEER_ID3 = "019b7000-0000-7000-8000-000000000b03" as DidId;
const CONTACT = "019b2a63-48bf-7214-961d-4c3f97cb95da" as ContactId;
const CONTACT2 = "019b2a63-48bf-7214-961d-4c3f97cb95db" as ContactId;
const IAT = 1_757_700_000;
const WEB_DID = "did:web:bob.example" as Did;

type Peer = { didId: DidId; did: Did; longFormDid: Did; resolution: PeerResolution; publicKey: PublicKey };

async function peerDid(keys: Keys, didId: DidId): Promise<Peer> {
  const minted = await mintDid(keys, didId, DIRECT);
  const resolution = peerResolution(minted.longFormDid);
  const [keyAgreement] = authorizedMethodIds(resolution.document, "keyAgreement");
  return { didId, did: minted.did, longFormDid: minted.longFormDid, resolution, publicKey: methodPublicKey(resolution.document, keyAgreement!) };
}

type Local = { didId: DidId; did: Did; longFormDid: Did };

/** The two vaults of a scene: ours with three communication DIDs on a mediated route, the peer's with four. */
async function vaults() {
  const keys = await openKeys();
  const peerKeys = await openKeys(OTHER_SEED);
  const scene = new Scene();
  mediatedRoute(scene, { me: "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc" as Did });
  const a0 = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
  const a1 = await createdDid(scene, keys, DID_ID2, ROUTE, MEDIATED);
  const a2 = await createdDid(scene, keys, DID_ID3, ROUTE, MEDIATED);
  const b0 = await peerDid(peerKeys, PEER_ID0);
  const b1 = await peerDid(peerKeys, PEER_ID1);
  const b2 = await peerDid(peerKeys, PEER_ID2);
  const b3 = await peerDid(peerKeys, PEER_ID3);
  return { keys, peerKeys, scene, a0, a1, a2, b0, b1, b2, b3 };
}

type ResolvedOptions = Partial<VaultData["peer.resolved"]> & { short?: boolean };

function resolved(scene: Scene, local: DidId, peer: Peer, options: ResolvedOptions = {}): VaultEvent<"peer.resolved"> {
  const { short, ...data } = options;
  return scene.add("peer.resolved", {
    localKeyName: didKeyName(local, "key-agreement"),
    peerPublicKey: peer.publicKey,
    presentedDid: short ? peer.did : peer.longFormDid,
    did: peer.did,
    documentCid: peer.resolution.cid,
    authenticationMethodIds: authorizedMethodIds(peer.resolution.document, "authentication"),
    keyAgreementMethodIds: authorizedMethodIds(peer.resolution.document, "keyAgreement"),
    service: null,
    ...data,
  });
}

const ref = <T extends VaultEvent>(event: T) => event.eventId as EventReference<T["type"]>;

function bound(scene: Scene, local: Local, peer: Peer, resolution: VaultEvent<"peer.resolved">, R = relationshipId(local.did, peer.did)) {
  const event = scene.add("relationship.bound", { relationshipId: R, localDidId: local.didId, peerResolutionEventId: ref(resolution) });
  return { R, bound: ref(event) };
}

type Receipt = {
  local: DidId;
  peer: Peer;
  resolution: VaultEvent<"peer.resolved">;
  binding: EventReference<"relationship.bound"> | null;
  ordinal: number;
  fromPrior?: string | null;
  transition?: EventReference<"relationship.peerTransitioned"> | null;
  wire?: string;
  presentedDid?: Did;
  overrides?: Partial<VaultData["message.in"]>;
};

/** An authenticated receipt from the peer at one of our DIDs, with or without a proof. */
function receipt(scene: Scene, r: Receipt): VaultEvent<"message.in"> {
  const wire = (r.wire ?? uuidv7()) as WireMessageId;
  return scene.add("message.in", {
    messageId: inboundMessageId(r.peer.publicKey, wire),
    wireMessageId: wire,
    receiptOrdinal: String(r.ordinal) as VaultData["message.in"]["receiptOrdinal"],
    intentHash: HASH as VaultData["message.in"]["intentHash"],
    plaintextHash: HASH as VaultData["message.in"]["plaintextHash"],
    localKeyName: didKeyName(r.local, "key-agreement"),
    msgType: "https://didcomm.org/basicmessage/2.0/message",
    peerResolutionEventId: ref(r.resolution),
    relationshipBindingEventId: r.binding,
    peerTransitionEventId: r.transition ?? null,
    presentedDid: r.presentedDid ?? r.resolution.data.presentedDid,
    did: r.peer.did,
    thid: null,
    pthid: null,
    createdTime: null,
    expiresTime: null,
    pleaseAck: null,
    ack: [],
    headers: {},
    fromPrior: r.fromPrior ?? null,
    bodyCid: cidOf(`body ${wire}`),
    attachmentCids: [],
    bytes: 100,
    signedBy: null,
    receivedVia: { mediationId: null, deliveryId: null },
    ...r.overrides,
  });
}

type PeerEdge = {
  R: RelationshipId;
  local: DidId;
  from: Peer;
  to: Peer;
  jwt: string;
  prior: VaultEvent<"peer.resolved">;
  successor: VaultEvent<"peer.resolved">;
  messageId: MessageId;
  overrides?: Partial<VaultData["relationship.peerTransitioned"]>;
};

function peerEdge(scene: Scene, e: PeerEdge): VaultEvent<"relationship.peerTransitioned"> {
  return scene.add("relationship.peerTransitioned", {
    relationshipId: e.R,
    localKeyName: didKeyName(e.local, "key-agreement"),
    peerPublicKey: e.to.publicKey,
    fromDid: e.from.did,
    presentedFromDid: e.from.longFormDid,
    toDid: e.to.did,
    presentedToDid: e.to.longFormDid,
    fromPrior: e.jwt,
    priorResolutionEventId: ref(e.prior),
    peerResolutionEventId: ref(e.successor),
    messageId: e.messageId,
    ...e.overrides,
  });
}

function localEdge(scene: Scene, R: RelationshipId, from: DidId, to: DidId, jwt: string, trigger: EventReference<"message.in"> | null = null): VaultEvent<"relationship.localTransitioned"> {
  return scene.add("relationship.localTransitioned", { relationshipId: R, fromDidId: from, toDidId: to, fromPrior: jwt, triggerEventId: trigger });
}

const routesOf = (set: VaultEventSet): RouteFold => foldRoutes(set, foldMediations(set));

const noObjects = async () => null;

async function fold(events: readonly Event[], readObject: (cid: Cid) => Promise<Uint8Array | null> = noObjects): Promise<RelationshipFold> {
  const set = VaultEventSet.of(events);
  return foldRelationshipsVerified(set, routesOf(set), readObject);
}

/** The document verdicts of a scene, computed once: they depend on the set, not on its order. */
async function checksOf(events: readonly Event[], readObject: (cid: Cid) => Promise<Uint8Array | null> = noObjects) {
  const set = VaultEventSet.of(events);
  return { resolutionChecks: await verifyResolutions(set, readObject), proofChecks: await verifyTransitions(set, routesOf(set), readObject) };
}

/** The fold with every snapshot verified but no proof checked. */
async function foldUnproven(events: readonly Event[]): Promise<RelationshipFold> {
  const set = VaultEventSet.of(events);
  return foldRelationships(set, routesOf(set), { resolutionChecks: await verifyResolutions(set, noObjects) });
}

/** The verdicts of a scene computed once, then the fold checked over shuffles of the events. */
async function expectFoldOrderFree(events: readonly Event[], check: (fold: RelationshipFold) => void, readObject: (cid: Cid) => Promise<Uint8Array | null> = noObjects): Promise<void> {
  const checks = await checksOf(events, readObject);
  const foldWith = (s: EventSet) => foldRelationships(s, routesOf(s), checks);
  check(foldWith(VaultEventSet.of(events)));
  expectOrderFree(events, foldWith);
}

const dids = (fold: RelationshipFold, R: RelationshipId) => ({
  local: fold.relationships.get(R)!.localChain.map((node) => node.didId),
  peer: fold.relationships.get(R)!.peerChain.map((node) => node.did),
});

/** A peer rotation B0 → B1 carried to one of our DIDs: the successor's resolution, the carrier and the edge. */
async function peerRotation(scene: Scene, peerKeys: Keys, R: RelationshipId, local: DidId, from: Peer, to: Peer, prior: VaultEvent<"peer.resolved">, binding: EventReference<"relationship.bound"> | null, ordinal: number) {
  const jwt = await signFromPrior(peerKeys, { didId: from.didId, longFormDid: from.longFormDid }, to.longFormDid, IAT);
  const successor = resolved(scene, local, to);
  const carrier = receipt(scene, { local, peer: to, resolution: successor, binding, ordinal, fromPrior: jwt });
  const edge = peerEdge(scene, { R, local, from, to, jwt, prior, successor, messageId: carrier.data.messageId });
  return { jwt, successor, carrier, edge };
}

describe("the binding", () => {
  it("pins the root local DID and the exact peer document; equivalent bindings are one, and the roots derive the ID", async () => {
    const { scene, a0, b0 } = await vaults();
    const first = resolved(scene, a0.didId, b0);
    const second = resolved(scene, a0.didId, b0, { short: true });
    const { R } = bound(scene, a0, b0, first);
    bound(scene, a0, b0, second);
    await expectFoldOrderFree(scene.events, (fold) => {
      const r = fold.relationships.get(R)!;
      expect(r.binding).toEqual({ relationshipId: R, localDidId: a0.didId, peerResolutionEventId: first.eventId });
      expect(r.bindingEventIds).toHaveLength(2);
      expect(r.faults).toEqual([]);
      expect(r.deferred).toEqual([]);
      expect(dids(fold, R)).toEqual({ local: [a0.didId], peer: [b0.did] });
      expect(r.currentLocalDidId).toBe(a0.didId);
      expect(r.currentPeerDid).toBe(b0.did);
      expect(r.recipientKeyNames).toEqual(new Set([didKeyName(a0.didId, "authentication"), didKeyName(a0.didId, "key-agreement")]));
      expect(fold.claimants(a0.did, b0.did)).toEqual([R]);
      expect(fold.retainedDidIds).toEqual(new Set([a0.didId]));
    });
  });

  it("conflicts when bindings disagree on the local DID, the peer DID or the peer document", async () => {
    const { scene, a0, a1, b0, b1 } = await vaults();
    const otherDocument = { ...b0.resolution.document, service: [] };
    const otherCid = rawCidOfBytes(canonicalize(otherDocument));
    const cases: [string, () => VaultEvent<"relationship.bound">][] = [
      ["local", () => scene.add("relationship.bound", { relationshipId: R, localDidId: a1.didId, peerResolutionEventId: ref(resolved(scene, a1.didId, b0)) })],
      ["peer", () => scene.add("relationship.bound", { relationshipId: R, localDidId: a0.didId, peerResolutionEventId: ref(resolved(scene, a0.didId, b1)) })],
      ["document", () => scene.add("relationship.bound", { relationshipId: R, localDidId: a0.didId, peerResolutionEventId: ref(resolved(scene, a0.didId, b0, { documentCid: otherCid })) })],
    ];
    const root = resolved(scene, a0.didId, b0);
    const { R } = bound(scene, a0, b0, root);
    const base = scene.events.length;
    for (const [what, add] of cases) {
      scene.events.length = base;
      add();
      const fold = await fold_(scene.events);
      const r = fold.relationships.get(R)!;
      expect(r.binding, what).toBeNull();
      expect(r.conflict, what).toBe(true);
      expect(r.localChain, what).toEqual([]);
      expect(fold.claimants(a0.did, b0.did), what).toEqual([]);
    }
  });

  it("conflicts when the binding does not hold: resolution at another key, or roots that derive another ID", async () => {
    const { scene, a0, a1, b0 } = await vaults();
    const atA1 = resolved(scene, a1.didId, b0);
    const { R: wrongKey } = bound(scene, a0, b0, atA1);
    const atA0 = resolved(scene, a0.didId, b0);
    const wrongId = relationshipId(a1.did, b0.did);
    bound(scene, a0, b0, atA0, wrongId);
    const fold = await fold_(scene.events);
    expect(fold.relationships.get(wrongKey)!.faults).toEqual([expect.stringMatching(/^binding .* does not hold: its resolution, local DID and relationship ID disagree$/)]);
    expect(fold.relationships.get(wrongId)!.faults).toEqual([expect.stringMatching(/^binding .* does not hold: its resolution, local DID and relationship ID disagree$/)]);
  });

  it("defers while the peer resolution or the root local DID is not here, without a chain or an index entry", async () => {
    const { keys, scene, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const { R } = bound(scene, a0, b0, root);
    const withoutResolution = scene.events.filter((event) => event !== root);
    let fold = await fold_(withoutResolution);
    expect(fold.relationships.get(R)!.binding).toBeNull();
    expect(fold.relationships.get(R)!.deferred).toEqual(["1 binding names a peer resolution that is not here"]);
    expect(fold.relationships.get(R)!.conflict).toBe(false);
    const withoutCreation = scene.events.filter((event) => !(event.type === "did.created" && (event.data as VaultData["did.created"]).didId === a0.didId));
    fold = await fold_(withoutCreation);
    expect(fold.relationships.get(R)!.binding).not.toBeNull();
    expect(fold.relationships.get(R)!.deferred).toEqual([`the root local DID ${a0.didId} is not created`]);
    expect(fold.claimants(a0.did, b0.did)).toEqual([]);
    expect(keys).toBeDefined();
  });
});

const fold_ = fold;

describe("contact assignment", () => {
  it("is zero or one, may precede the binding, and never changes the chains", async () => {
    const { scene, a0, b0 } = await vaults();
    const R = relationshipId(a0.did, b0.did);
    scene.add("relationship.contactAssigned", { relationshipId: R, contactId: CONTACT });
    let fold = await fold_(scene.events);
    expect(fold.relationships.get(R)!.contactId).toBe(CONTACT);
    expect(fold.relationships.get(R)!.binding).toBeNull();
    expect(fold.relationships.get(R)!.deferred).toEqual(["no binding"]);
    expect(fold.relationships.get(R)!.conflict).toBe(false);

    bound(scene, a0, b0, resolved(scene, a0.didId, b0));
    scene.add("relationship.contactAssigned", { relationshipId: R, contactId: CONTACT });
    fold = await fold_(scene.events);
    expect(fold.relationships.get(R)!.contactId).toBe(CONTACT);
    expect(fold.relationships.get(R)!.conflict).toBe(false);

    scene.add("relationship.contactAssigned", { relationshipId: R, contactId: CONTACT2 });
    await expectFoldOrderFree(scene.events, (f) => {
      expect(f.relationships.get(R)!.contactId).toBeNull();
      expect(f.relationships.get(R)!.faults).toEqual(["assigned to 2 contacts"]);
      expect(dids(f, R)).toEqual({ local: [a0.didId], peer: [b0.did] });
    });
  });
});

describe("the local chain", () => {
  async function rotated() {
    const v = await vaults();
    const { scene, keys, a0, a1, b0 } = v;
    const root = resolved(scene, a0.didId, b0);
    const { R, bound: binding } = bound(scene, a0, b0, root);
    const confirmation = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const jwt = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    const edge = localEdge(scene, R, a0.didId, a1.didId, jwt, ref(confirmation));
    return { ...v, R, binding, root, confirmation, jwt, edge };
  }

  it("applies a verified edge from the confirmed root, freezing successor, proof and trigger; the root and the peer end stay", async () => {
    const { scene, R, a0, a1, b0, edge } = await rotated();
    await expectFoldOrderFree(scene.events, (fold) => {
      const r = fold.relationships.get(R)!;
      expect(dids(fold, R)).toEqual({ local: [a0.didId, a1.didId], peer: [b0.did] });
      expect(r.localChain[1]!.edgeEventIds).toEqual([edge.eventId]);
      expect(r.currentLocalDidId).toBe(a1.didId);
      expect(r.currentPeerDid).toBe(b0.did);
      expect(r.recipientKeyNames.has(didKeyName(a1.didId, "key-agreement"))).toBe(true);
      expect(fold.claimants(a1.did, b0.did)).toEqual([R]);
      expect(fold.claimants(a0.did, b0.did)).toEqual([R]);
      expect(fold.retainedDidIds).toEqual(new Set([a0.didId, a1.didId]));
      expect(fold.transitions.get(edge.eventId)).toEqual({ status: "applied" });
      expect(r.faults).toEqual([]);
      expect(r.deferred).toEqual([]);
    });
  });

  it("is idempotent under equal edges, and conflicts on competing successors, a cycle or an invalid proof in every order", async () => {
    const { scene, keys, R, a0, a1, a2, jwt, confirmation } = await rotated();
    const base = scene.events.length;
    localEdge(scene, R, a0.didId, a1.didId, jwt, ref(confirmation));
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(dids(fold, R).local).toEqual([a0.didId, a1.didId]);
      expect(fold.relationships.get(R)!.conflict).toBe(false);
    });

    scene.events.length = base;
    const toA2 = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a2.longFormDid, IAT);
    const competing = localEdge(scene, R, a0.didId, a2.didId, toA2, ref(confirmation));
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(dids(fold, R).local).toEqual([a0.didId]);
      expect(fold.relationships.get(R)!.faults).toEqual([`competing successors of ${a0.didId}`]);
      expect(fold.transitions.get(competing.eventId)!.status).toBe("conflict");
      expect(fold.claimants(a1.did, fold.relationships.get(R)!.peerChain[0]!.did)).toEqual([]);
    });

    scene.events.length = base;
    const back = await signFromPrior(keys, { didId: a1.didId, longFormDid: a1.longFormDid }, a0.longFormDid, IAT);
    const cycle = localEdge(scene, R, a1.didId, a0.didId, back);
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(dids(fold, R).local).toEqual([a0.didId, a1.didId]);
      expect(fold.relationships.get(R)!.faults).toEqual([`local edge ${a1.didId} → ${a0.didId}: ${a0.didId} is already in the local chain`]);
      expect(fold.transitions.get(cycle.eventId)!.status).toBe("conflict");
    });

    scene.events.length = base;
    const forged = await signFromPrior(keys, { didId: a2.didId, longFormDid: a2.longFormDid }, a1.longFormDid, IAT);
    scene.events.pop();
    const invalid = localEdge(scene, R, a0.didId, a1.didId, forged, ref(confirmation));
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(dids(fold, R).local).toEqual([a0.didId]);
      expect(fold.transitions.get(invalid.eventId)).toEqual({ status: "conflict", because: "the proof does not verify against the predecessor's document" });
    });
  });

  it("defers an edge whose prefix, successor creation, confirmation or proof check is not here, and never applies it", async () => {
    const { scene, keys, R, a0, a1, a2, confirmation, edge } = await rotated();
    const secondHop = await signFromPrior(keys, { didId: a1.didId, longFormDid: a1.longFormDid }, a2.longFormDid, IAT);
    const unreached = localEdge(scene, R, a1.didId, a2.didId, secondHop);
    let fold = await fold_(scene.events.filter((event) => event !== edge));
    expect(dids(fold, R).local).toEqual([a0.didId]);
    expect(fold.transitions.get(unreached.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("no rooted prefix reaches the edge") });
    expect(fold.relationships.get(R)!.conflict).toBe(false);

    fold = await fold_(scene.events);
    expect(dids(fold, R).local).toEqual([a0.didId, a1.didId]);
    expect(fold.transitions.get(unreached.eventId)).toEqual({ status: "deferred", because: `${a1.didId} is not confirmed by input in this relationship` });

    fold = await fold_(scene.events.filter((event) => !(event.type === "did.created" && (event.data as VaultData["did.created"]).didId === a1.didId)));
    expect(dids(fold, R).local).toEqual([a0.didId]);
    expect(fold.transitions.get(edge.eventId)!.status).toBe("deferred");
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ because: expect.stringContaining(`successor ${a1.didId} is not created`) });

    fold = await fold_(scene.events.filter((event) => event !== confirmation));
    expect(dids(fold, R).local).toEqual([a0.didId]);
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("the trigger") });

    const unchecked = await foldUnproven(scene.events);
    expect(dids(unchecked, R).local).toEqual([a0.didId]);
    expect(unchecked.transitions.get(edge.eventId)).toEqual({ status: "deferred", because: "the proof is not yet verified" });
  });

  it("conflicts on a trigger that is not a confirmation of the predecessor", async () => {
    const { scene, R, a0, a1, b0, root, jwt, edge, binding } = await rotated();
    const elsewhere = receipt(scene, { local: a1.didId, peer: b0, resolution: root, binding, ordinal: 2 });
    scene.events.splice(scene.events.indexOf(edge), 1);
    const wrongTrigger = localEdge(scene, R, a0.didId, a1.didId, jwt, ref(elsewhere));
    const fold = await fold_(scene.events);
    expect(dids(fold, R).local).toEqual([a0.didId]);
    expect(fold.transitions.get(wrongTrigger.eventId)).toEqual({ status: "conflict", because: `the trigger ${elsewhere.eventId} does not confirm ${a0.didId}` });
  });
});

describe("the peer chain", () => {
  async function bornAtRoot() {
    const v = await vaults();
    const { scene, a0, b0 } = v;
    const root = resolved(scene, a0.didId, b0);
    const { R, bound: binding } = bound(scene, a0, b0, root);
    return { ...v, R, binding, root };
  }

  it("applies a verified proof carried to the root, pinning the successor document; a repeated proof reuses the edge", async () => {
    const { scene, peerKeys, R, a0, b0, b1, root, binding } = await bornAtRoot();
    const { edge, successor, carrier } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const again = resolved(scene, a0.didId, b1);
    receipt(scene, { local: a0.didId, peer: b1, resolution: again, binding, ordinal: 2, fromPrior: edge.data.fromPrior, wire: carrier.data.wireMessageId });
    const repeated = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt: edge.data.fromPrior, prior: root, successor: again, messageId: carrier.data.messageId });
    await expectFoldOrderFree(scene.events, (fold) => {
      const r = fold.relationships.get(R)!;
      expect(dids(fold, R)).toEqual({ local: [a0.didId], peer: [b0.did, b1.did] });
      expect(r.peerChain[1]).toMatchObject({ did: b1.did, documentCid: b1.resolution.cid, keyAgreementMethodIds: successor.data.keyAgreementMethodIds });
      expect(r.currentPeerDid).toBe(b1.did);
      expect(r.currentLocalDidId).toBe(a0.didId);
      expect(fold.transitions.get(edge.eventId)).toEqual({ status: "applied" });
      expect(fold.transitions.get(repeated.eventId)).toEqual({ status: "applied" });
      expect(fold.claimants(a0.did, b1.did)).toEqual([R]);
      expect(fold.pendingClaims).toEqual([]);
      expect(r.faults).toEqual([]);
      expect(r.deferred).toEqual([]);
    });
  });

  it("extends the same relationship from a proof carried to a historical local address, root or successor", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, b2, root, binding } = await bornAtRoot();
    const confirmation = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const toA1 = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    localEdge(scene, R, a0.didId, a1.didId, toA1, ref(confirmation));
    const first = await peerRotation(scene, peerKeys, R, a1.didId, b0, b1, root, binding, 2);
    const second = await peerRotation(scene, peerKeys, R, a0.didId, b1, b2, first.successor, null, 3);
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(dids(fold, R)).toEqual({ local: [a0.didId, a1.didId], peer: [b0.did, b1.did, b2.did] });
      expect(fold.transitions.get(second.edge.eventId)).toEqual({ status: "applied" });
      for (const local of [a0, a1]) for (const peer of [b0, b1, b2]) expect(fold.claimants(local.did, peer.did)).toEqual([R]);
    });
  });

  it("cannot be extended by a forged signature, a wrong sub, a wrong recipient relationship, an unauthorized signing key or an incompatible pinned document", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, b2, root, binding } = await bornAtRoot();
    const base = scene.events.length;
    const expectConflict = async (edge: VaultEvent<"relationship.peerTransitioned">, because: string) => {
      const fold = await fold_(scene.events);
      expect(dids(fold, R).peer).toEqual([b0.did]);
      expect(fold.transitions.get(edge.eventId)).toEqual({ status: "conflict", because });
      expect(fold.relationships.get(R)!.conflict).toBe(true);
    };

    const forged = await signFromPrior(peerKeys, { didId: b2.didId, longFormDid: b2.longFormDid }, b1.longFormDid, IAT);
    let successor = resolved(scene, a0.didId, b1);
    let carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: forged });
    let edge = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt: forged, prior: root, successor, messageId: carrier.data.messageId });
    await expectConflict(edge, "the proof does not verify against the pinned predecessor document");

    scene.events.length = base;
    const toB2 = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b2.longFormDid, IAT);
    successor = resolved(scene, a0.didId, b1);
    carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: toB2 });
    edge = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt: toB2, prior: root, successor, messageId: carrier.data.messageId });
    await expectConflict(edge, "the proof does not verify against the pinned predecessor document");

    scene.events.length = base;
    const good = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b1.longFormDid, IAT);
    successor = resolved(scene, a1.didId, b1);
    carrier = receipt(scene, { local: a1.didId, peer: b1, resolution: successor, binding: null, ordinal: 1, fromPrior: good });
    edge = peerEdge(scene, { R, local: a1.didId, from: b0, to: b1, jwt: good, prior: root, successor, messageId: carrier.data.messageId });
    await expectConflict(edge, `${didKeyName(a1.didId, "key-agreement")} is not in the local history`);

    scene.events.length = base;
    const [agreement] = authorizedMethodIds(b0.resolution.document, "keyAgreement");
    const signer = await peerKeys.signing(didKeyName(b0.didId, "authentication"));
    const unauthorized = await new SignJWT({ iss: b0.longFormDid, sub: b1.longFormDid, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: agreement! }).sign(await importJWK(signer.privateJwk(), "EdDSA"));
    successor = resolved(scene, a0.didId, b1);
    carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: unauthorized });
    edge = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt: unauthorized, prior: root, successor, messageId: carrier.data.messageId });
    await expectConflict(edge, "the proof does not verify against the pinned predecessor document");

    scene.events.length = base;
    const otherDocument = { ...b0.resolution.document, service: [] };
    const otherPin = resolved(scene, a0.didId, b0, { short: true, documentCid: rawCidOfBytes(canonicalize(otherDocument)) });
    successor = resolved(scene, a0.didId, b1);
    carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: good });
    edge = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt: good, prior: otherPin, successor, messageId: carrier.data.messageId });
    const fold = await fold_(scene.events, async () => canonicalize(otherDocument));
    expect(dids(fold, R).peer).toEqual([b0.did]);
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ status: "conflict", because: expect.stringContaining("the prior resolution is not its document's") });
    expect(keys).toBeDefined();
  });

  it("conflicts on competing successors, a cycle, a proof whose successor document differs, or a carrier bound elsewhere", async () => {
    const { scene, peerKeys, R, a0, a1, b0, b1, b2, root, binding } = await bornAtRoot();
    const base = scene.events.length;
    const first = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const rotated = scene.events.length;

    const competing = await peerRotation(scene, peerKeys, R, a0.didId, b0, b2, root, binding, 2);
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(dids(fold, R).peer).toEqual([b0.did]);
      expect(fold.relationships.get(R)!.faults).toEqual([`competing successors of ${b0.did}`]);
      expect(fold.transitions.get(first.edge.eventId)!.status).toBe("conflict");
      expect(fold.transitions.get(competing.edge.eventId)!.status).toBe("conflict");
    });

    scene.events.length = rotated;
    const back = await peerRotation(scene, peerKeys, R, a0.didId, b1, b0, first.successor, binding, 2);
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(dids(fold, R).peer).toEqual([b0.did, b1.did]);
      expect(fold.transitions.get(back.edge.eventId)).toMatchObject({ status: "conflict", because: expect.stringContaining(`${b0.did} is already in the peer chain`) });
    });

    scene.events.length = rotated;
    const enlarged = { ...b1.resolution.document, keyAgreement: [...(b1.resolution.document["keyAgreement"] as string[]), "#key-1"] };
    const enlargedBytes = canonicalize(enlarged);
    const enlargedResolution = resolved(scene, a0.didId, b1, { short: true, documentCid: rawCidOfBytes(enlargedBytes), keyAgreementMethodIds: [...first.successor.data.keyAgreementMethodIds, ...first.successor.data.authenticationMethodIds] });
    const enlargingCarrier = receipt(scene, { local: a0.didId, peer: b1, resolution: enlargedResolution, binding, ordinal: 2, fromPrior: first.jwt, wire: first.carrier.data.wireMessageId });
    const enlarging = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt: first.jwt, prior: root, successor: enlargedResolution, messageId: first.carrier.data.messageId });
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(dids(fold, R).peer).toEqual([b0.did]);
      expect(fold.transitions.get(enlarging.eventId)).toMatchObject({ status: "conflict", because: expect.stringContaining("presents another spelling") });
      expect(fold.transitions.get(enlarging.eventId)).toMatchObject({ because: expect.stringContaining("the successor's resolution is not its document's") });
      expect(fold.transitions.get(first.edge.eventId)).toEqual({ status: "conflict", because: `observation ${enlargingCarrier.eventId} of message ${first.carrier.data.messageId} contradicts its resolution` });
      expect(fold.relationships.get(R)!.conflict).toBe(true);
    }, async (wanted) => (wanted === enlargedResolution.data.documentCid ? enlargedBytes : null));

    scene.events.length = base;
    const other = bound(scene, a1, b0, resolved(scene, a1.didId, b0));
    const jwt = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b1.longFormDid, IAT);
    const successor = resolved(scene, a0.didId, b1);
    const carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding: other.bound, ordinal: 1, fromPrior: jwt });
    const elsewhere = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId });
    const fold = await fold_(scene.events);
    expect(fold.transitions.get(elsewhere.eventId)).toEqual({ status: "conflict", because: `observation ${carrier.eventId} of message ${carrier.data.messageId} is bound to another relationship` });
  });

  it("defers while the prior resolution, the successor resolution, the carrier or the proof check is not here, and never applies", async () => {
    const { scene, peerKeys, R, a0, b0, b1, root, binding } = await bornAtRoot();
    const { edge, successor, carrier } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const without = (event: Event) => scene.events.filter((e) => e !== event);
    const bindingWithoutRoot = without(root).filter((e) => e.type !== "relationship.bound");
    scene.events.length = 0;
    scene.events.push(...bindingWithoutRoot);
    const root2 = resolved(scene, a0.didId, b0);
    const rebound = scene.add("relationship.bound", { relationshipId: R, localDidId: a0.didId, peerResolutionEventId: ref(root2) });
    let fold = await fold_(scene.events);
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("the prior resolution is not here") });
    expect(fold.relationships.get(R)!.conflict).toBe(false);
    expect(rebound).toBeDefined();

    fold = await fold_(without(successor));
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("the successor's resolution is not here") });

    fold = await fold_(without(carrier));
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining(`no observation of message ${carrier.data.messageId} is here`) });

    const unchecked = await foldUnproven(scene.events);
    expect(unchecked.transitions.get(edge.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("the proof is not yet verified") });
    for (const f of [fold, unchecked]) {
      expect(dids(f, R).peer).toEqual([b0.did]);
      expect(f.claimants(a0.did, b1.did)).toEqual([]);
      expect(f.pendingAt(a0.did, b1.did).map((claim) => claim.because)).toContain("edge");
    }
  });

  it("verifies against a retained did:web document read from the object store, and waits while the object is not here", async () => {
    const { scene, peerKeys, a0, b1 } = await vaults();
    const signer = await peerKeys.signing(didKeyName(PEER_ID0, "authentication"));
    const method = { id: `${WEB_DID}#key-1`, type: "Multikey", controller: WEB_DID, publicKeyMultibase: signer.publicKey };
    const document = { id: WEB_DID, verificationMethod: [method], authentication: [`${WEB_DID}#key-1`], keyAgreement: [`${WEB_DID}#key-1`] };
    const bytes = canonicalize(document);
    const cid = rawCidOfBytes(bytes);
    const web: Peer = { didId: PEER_ID0, did: WEB_DID, longFormDid: WEB_DID, resolution: { did: WEB_DID, presentedDid: WEB_DID, document, bytes, cid }, publicKey: signer.publicKey };
    const root = resolved(scene, a0.didId, web);
    const { R, bound: binding } = bound(scene, a0, web, root);
    const jwt = await new SignJWT({ iss: WEB_DID, sub: b1.longFormDid, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: `${WEB_DID}#key-1` }).sign(await importJWK(signer.privateJwk(), "EdDSA"));
    const successor = resolved(scene, a0.didId, b1);
    const carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: jwt });
    const edge = peerEdge(scene, { R, local: a0.didId, from: web, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId, overrides: { presentedFromDid: WEB_DID } });

    let fold = await fold_(scene.events);
    expect(fold.relationships.get(R)!.binding).not.toBeNull();
    expect(fold.relationships.get(R)!.deferred).toContain("no root resolution is yet verified against its document");
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("the relationship's binding does not stand") });
    const objects = new Map([[cid, bytes]]);
    fold = await fold_(scene.events, async (wanted) => objects.get(wanted) ?? null);
    expect(fold.transitions.get(edge.eventId)).toEqual({ status: "applied" });
    expect(dids(fold, R).peer).toEqual([WEB_DID, b1.did]);

    const revised = { ...document, service: [] };
    const revisedBytes = canonicalize(revised);
    objects.set(rawCidOfBytes(revisedBytes), revisedBytes);
    const revisedPin = resolved(scene, a0.didId, web, { documentCid: rawCidOfBytes(revisedBytes) });
    scene.events.splice(scene.events.indexOf(edge), 1);
    const fromRevised = peerEdge(scene, { R, local: a0.didId, from: web, to: b1, jwt, prior: revisedPin, successor, messageId: carrier.data.messageId, overrides: { presentedFromDid: WEB_DID } });
    fold = await fold_(scene.events, async (wanted) => objects.get(wanted) ?? null);
    expect(fold.transitions.get(fromRevised.eventId)).toEqual({ status: "conflict", because: "the prior resolution is not the chain's document" });
    expect(dids(fold, R).peer).toEqual([WEB_DID]);
  });
});

describe("crossed changes of the two ends", () => {
  it("fold to A1/B1 in one birth relationship whatever the order, with every historical pair in the index", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1, b2 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const { R, bound: binding } = bound(scene, a0, b0, root);
    const confirmation = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    localEdge(scene, R, a0.didId, a1.didId, await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT), ref(confirmation));
    const first = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 2);
    const atA1 = receipt(scene, { local: a1.didId, peer: b1, resolution: resolved(scene, a1.didId, b1), binding, ordinal: 3, transition: ref(first.edge) });
    localEdge(scene, R, a1.didId, a2.didId, await signFromPrior(keys, { didId: a1.didId, longFormDid: a1.longFormDid }, a2.longFormDid, IAT), ref(atA1));
    await peerRotation(scene, peerKeys, R, a2.didId, b1, b2, first.successor, binding, 4);
    const set = VaultEventSet.of(scene.events);
    const checks = await checksOf(scene.events);
    const expected = snapshot(foldRelationships(set, routesOf(set), checks));
    for (let seed = 1; seed <= 8; seed++) {
      const shuffledSet = VaultEventSet.of(shuffled(scene.events, seed));
      const fold = foldRelationships(shuffledSet, routesOf(shuffledSet), checks);
      expect(snapshot(fold)).toBe(expected);
      expect(dids(fold, R)).toEqual({ local: [a0.didId, a1.didId, a2.didId], peer: [b0.did, b1.did, b2.did] });
      expect(fold.relationships.get(R)!.currentLocalDidId).toBe(a2.didId);
      expect(fold.relationships.get(R)!.currentPeerDid).toBe(b2.did);
      expect(fold.relationships.get(R)!.conflict).toBe(false);
      for (const local of [a0, a1, a2]) for (const peer of [b0, b1, b2]) expect(fold.claimants(local.did, peer.did)).toEqual([R]);
      expect(fold.relationships.size).toBe(1);
    }
  });
});

describe("the address index", () => {
  it("lets one local DID serve several relationships, and conflicts every claimant of a pair two relationships reach", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b3 } = await vaults();
    const rootB0 = resolved(scene, a0.didId, b0);
    const R = bound(scene, a0, b0, rootB0).R;
    const rootB3 = resolved(scene, a0.didId, b3);
    const shared = bound(scene, a0, b3, rootB3).R;
    let fold = await fold_(scene.events);
    expect(fold.claimants(a0.did, b0.did)).toEqual([R]);
    expect(fold.claimants(a0.did, b3.did)).toEqual([shared]);
    expect([...fold.relationships.values()].every((r) => !r.conflict)).toBe(true);

    const rootB1 = resolved(scene, a1.didId, b1);
    const { R: born, bound: binding } = bound(scene, a1, b1, rootB1);
    const confirmation = receipt(scene, { local: a1.didId, peer: b1, resolution: rootB1, binding, ordinal: 1 });
    localEdge(scene, born, a1.didId, a0.didId, await signFromPrior(keys, { didId: a1.didId, longFormDid: a1.longFormDid }, a0.longFormDid, IAT), ref(confirmation));
    await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, rootB0, null, 2);
    await expectFoldOrderFree(scene.events, (f) => {
      expect(f.claimants(a0.did, b1.did)).toEqual([R, born].sort());
      expect(f.relationships.get(R)!.faults).toEqual([`the pair ${a0.did} / ${b1.did} is also claimed by ${born}`]);
      expect(f.relationships.get(born)!.faults).toEqual([`the pair ${a0.did} / ${b1.did} is also claimed by ${R}`]);
      expect(f.relationships.get(shared)!.conflict).toBe(false);
      expect(dids(f, R).peer).toEqual([b0.did, b1.did]);
      expect(dids(f, born).local).toEqual([a1.didId, a0.didId]);
    });
    fold = await fold_(scene.events);
    expect(fold.relationships.get(R)!.currentPeerDid).toBe(b1.did);
  });
});

describe("pending claims", () => {
  it("hold the exact pair of a committed carrier whose proof names its sender, until a transition applies; a conflicted transition marks the claim", async () => {
    const { scene, peerKeys, a0, a1, b0, b1, b2 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const { R, bound: binding } = bound(scene, a0, b0, root);
    const jwt = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b1.longFormDid, IAT);
    const successor = resolved(scene, a1.didId, b1);
    const carrier = receipt(scene, { local: a1.didId, peer: b1, resolution: successor, binding: null, ordinal: 1, fromPrior: jwt });
    let fold = await fold_(scene.events);
    expect(fold.pendingAt(a1.did, b1.did)).toEqual([{ localKeyName: didKeyName(a1.didId, "key-agreement"), localDid: a1.did, peerDid: b1.did, because: "carrier", eventIds: [carrier.eventId], conflict: false }]);
    expect(fold.pendingAt(a0.did, b1.did)).toEqual([]);
    expect(fold.claimants(a1.did, b1.did)).toEqual([]);

    const unrelated = receipt(scene, { local: a0.didId, peer: b2, resolution: resolved(scene, a0.didId, b2), binding: null, ordinal: 2, fromPrior: jwt });
    fold = await fold_(scene.events);
    expect(fold.pendingAt(a0.did, b2.did)).toEqual([]);
    expect(unrelated.data.fromPrior).toBe(jwt);

    const edge = peerEdge(scene, { R, local: a1.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId });
    fold = await fold_(scene.events);
    expect(fold.transitions.get(edge.eventId)!.status).toBe("conflict");
    expect(fold.pendingAt(a1.did, b1.did)).toEqual([expect.objectContaining({ because: "carrier", conflict: true })]);

    scene.events.splice(scene.events.indexOf(edge), 1);
    const successorAtRoot = resolved(scene, a0.didId, b1);
    const atRoot = receipt(scene, { local: a0.didId, peer: b1, resolution: successorAtRoot, binding, ordinal: 3, fromPrior: jwt });
    const applied = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor: successorAtRoot, messageId: atRoot.data.messageId });
    await expectFoldOrderFree(scene.events, (f) => {
      expect(f.transitions.get(applied.eventId)).toEqual({ status: "applied" });
      expect(f.pendingAt(a0.did, b1.did)).toEqual([]);
      expect(f.pendingAt(a1.did, b1.did)).toEqual([expect.objectContaining({ because: "carrier", eventIds: [carrier.eventId], conflict: false })]);
    });
  });

  it("name a deferred local edge's successor against every peer node, by the successor's key", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const { R } = bound(scene, a0, b0, root);
    const edge = localEdge(scene, R, a0.didId, a1.didId, await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT));
    const fold = await fold_(scene.events);
    expect(fold.transitions.get(edge.eventId)!.status).toBe("deferred");
    expect(fold.pendingAt(a1.did, b0.did)).toEqual([{ localKeyName: didKeyName(a1.didId, "key-agreement"), localDid: a1.did, peerDid: b0.did, because: "edge", eventIds: [edge.eventId], conflict: false }]);
  });
});

describe("verifyTransitions", () => {
  it("gives a verdict only where the predecessor document is here, one per event, the same for equal events", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const { R, bound: binding } = bound(scene, a0, b0, root);
    const confirmation = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const jwt = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    const local = localEdge(scene, R, a0.didId, a1.didId, jwt, ref(confirmation));
    const twin = localEdge(scene, R, a0.didId, a1.didId, jwt, ref(confirmation));
    const peer = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 2);
    const set = VaultEventSet.of(scene.events);
    const checks = await verifyTransitions(set, routesOf(set), noObjects);
    expect(checks).toEqual(new Map<EventId, EvidenceCheck>([[local.eventId, "verified"], [twin.eventId, "verified"], [peer.edge.eventId, "verified"]]));

    const withoutPredecessor = VaultEventSet.of(scene.events.filter((event) => event !== root && !(event.type === "did.created" && (event.data as VaultData["did.created"]).didId === a0.didId)));
    expect(await verifyTransitions(withoutPredecessor, routesOf(withoutPredecessor), noObjects)).toEqual(new Map());
  });

  it("finds a peer proof whose iss or sub is not the presented spelling invalid, whatever the signature", async () => {
    const { scene, peerKeys, a0, b0, b1, b2 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const { R, bound: binding } = bound(scene, a0, b0, root);
    const jwt = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b1.longFormDid, IAT);
    const successor = resolved(scene, a0.didId, b1);
    const carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: jwt });
    const wrongSub = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId, overrides: { presentedToDid: b2.longFormDid } });
    const wrongIss = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId, overrides: { presentedFromDid: b0.did } });
    const set = VaultEventSet.of(scene.events);
    const checks = await verifyTransitions(set, routesOf(set), noObjects);
    expect(checks.get(wrongSub.eventId)).toBe("invalid");
    expect(checks.get(wrongIss.eventId)).toBe("invalid");
  });
});

describe("evidence that authorizes nothing", () => {
  async function bornAtRoot() {
    const v = await vaults();
    const { scene, a0, b0 } = v;
    const root = resolved(scene, a0.didId, b0);
    const { R, bound: binding } = bound(scene, a0, b0, root);
    return { ...v, R, binding, root };
  }

  it("a receipt whose resolution is missing, or contradicts it, confirms no local predecessor", async () => {
    const { scene, keys, R, a0, a1, b0, root, binding } = await bornAtRoot();
    const jwt = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    const edge = localEdge(scene, R, a0.didId, a1.didId, jwt);
    const unresolved = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { peerResolutionEventId: uuidv7() as EventReference<"peer.resolved"> } });
    const elsewhere = receipt(scene, { local: a0.didId, peer: b0, resolution: resolved(scene, a1.didId, b0), binding, ordinal: 2 });
    let fold = await fold_(scene.events);
    expect(fold.transitions.get(edge.eventId)).toEqual({ status: "deferred", because: `${a0.didId} is not confirmed by input in this relationship` });
    expect(dids(fold, R).local).toEqual([a0.didId]);
    scene.events.splice(scene.events.indexOf(unresolved), 1);
    scene.events.splice(scene.events.indexOf(elsewhere), 1);
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 3 });
    fold = await fold_(scene.events);
    expect(fold.transitions.get(edge.eventId)).toEqual({ status: "applied" });
  });

  it("a carrier confirms the predecessor only through the applied transition it witnesses, bound or not", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, root } = await bornAtRoot();
    const toA1 = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    const local = localEdge(scene, R, a0.didId, a1.didId, toA1);
    const proof = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b1.longFormDid, IAT);
    const successor = resolved(scene, a0.didId, b1);
    const carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding: null, ordinal: 1, fromPrior: proof });
    let fold = await fold_(scene.events);
    expect(fold.transitions.get(local.eventId)).toEqual({ status: "deferred", because: `${a0.didId} is not confirmed by input in this relationship` });
    expect(fold.pendingAt(a0.did, b1.did)).toHaveLength(1);

    const peer = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt: proof, prior: root, successor, messageId: carrier.data.messageId });
    await expectFoldOrderFree(scene.events, (f) => {
      expect(f.transitions.get(peer.eventId)).toEqual({ status: "applied" });
      expect(f.transitions.get(local.eventId)).toEqual({ status: "applied" });
      expect(dids(f, R)).toEqual({ local: [a0.didId, a1.didId], peer: [b0.did, b1.did] });
      expect(f.pendingAt(a0.did, b1.did)).toEqual([]);
    });
  });

  it("a snapshot that is not its document's — another CID, other methods — conflicts what pins it, root or successor", async () => {
    const { scene, peerKeys, R, a0, b0, b1, b2, root, binding } = await bornAtRoot();
    const jwt = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b1.longFormDid, IAT);
    const forged = resolved(scene, a0.didId, b1, { documentCid: b2.resolution.cid, keyAgreementMethodIds: authorizedMethodIds(b2.resolution.document, "keyAgreement") });
    const carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: forged, binding, ordinal: 1, fromPrior: jwt });
    const edge = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor: forged, messageId: carrier.data.messageId });
    let fold = await fold_(scene.events);
    expect(fold.transitions.get(edge.eventId)).toEqual({ status: "conflict", because: `the successor's resolution is not its document's; observation ${carrier.eventId} of message ${carrier.data.messageId} contradicts its resolution` });
    expect(dids(fold, R).peer).toEqual([b0.did]);

    const set = VaultEventSet.of(scene.events);
    expect((await verifyResolutions(set, noObjects)).get(forged.eventId)).toBe("invalid");
    expect((await verifyResolutions(set, noObjects)).get(root.eventId)).toBe("verified");

    scene.events.splice(scene.events.indexOf(root), 1, resolved(scene, a0.didId, b0, { authenticationMethodIds: [] }));
    scene.events.pop();
    const rootEvent = scene.events.find((event) => event.type === "peer.resolved" && (event.data as VaultData["peer.resolved"]).did === b0.did)!;
    scene.events.splice(scene.events.indexOf(scene.events.find((event) => event.type === "relationship.bound")!), 1);
    scene.add("relationship.bound", { relationshipId: R, localDidId: a0.didId, peerResolutionEventId: rootEvent.eventId as EventReference<"peer.resolved"> });
    fold = await fold_(scene.events);
    expect(fold.relationships.get(R)!.faults).toContain(`the root resolution ${rootEvent.eventId} is not its document's`);
    expect(fold.relationships.get(R)!.binding).toBeNull();
    expect(fold.transitions.get(edge.eventId)!.status).toBe("conflict");
  });

  it("a duplicate of an applied transition with a contradiction of its own stays a conflict, whichever sorts first", async () => {
    const { scene, peerKeys, R, a0, b0, b1, root, binding } = await bornAtRoot();
    const { edge, successor, carrier, jwt } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const corrupted = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId, overrides: { presentedFromDid: b0.did } });
    const check = (fold: RelationshipFold) => {
      expect(fold.transitions.get(edge.eventId)).toEqual({ status: "applied" });
      expect(fold.transitions.get(corrupted.eventId)).toEqual({ status: "conflict", because: "the proof does not verify against the pinned predecessor document" });
      expect(dids(fold, R).peer).toEqual([b0.did, b1.did]);
      expect(fold.relationships.get(R)!.conflict).toBe(true);
    };
    await expectFoldOrderFree(scene.events, check);
    const swapped = scene.events.map((event) => (event === edge ? { ...event, at: corrupted.at } : event === corrupted ? { ...event, at: edge.at } : event));
    await expectFoldOrderFree(swapped, check);
  });

  it("an applied transition at one local address does not clear a carrier's claim at another", async () => {
    const { scene, peerKeys, R, a0, a2, b0, b1, root, binding } = await bornAtRoot();
    const { jwt, carrier } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const unrelated = receipt(scene, { local: a2.didId, peer: b1, resolution: resolved(scene, a2.didId, b1), binding: null, ordinal: 2, fromPrior: jwt, wire: carrier.data.wireMessageId });
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(fold.pendingAt(a0.did, b1.did)).toEqual([]);
      expect(fold.pendingAt(a2.did, b1.did)).toEqual([expect.objectContaining({ because: "carrier", eventIds: [unrelated.eventId], conflict: false })]);
      expect(fold.claimants(a2.did, b1.did)).toEqual([]);
    });
  });

  it("a deferred peer transition claims its successor against every validated local address of its relationship", async () => {
    const { scene, keys, peerKeys, R, a0, a1, a2, b0, b1, root, binding } = await bornAtRoot();
    const confirmation = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    localEdge(scene, R, a0.didId, a1.didId, await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT), ref(confirmation));
    const { edge } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 2);
    const withoutPrior = scene.events.map((event) => (event === edge ? { ...event, data: { ...edge.data, priorResolutionEventId: uuidv7() as EventReference<"peer.resolved"> } } : event));
    const fold = await fold_(withoutPrior);
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("the prior resolution is not here") });
    for (const local of [a0, a1]) expect(fold.pendingAt(local.did, b1.did)).toContainEqual(expect.objectContaining({ because: "edge", eventIds: [edge.eventId] }));
    expect(fold.pendingAt(a1.did, b1.did)).toHaveLength(1);
    expect(fold.pendingAt(a2.did, b1.did)).toEqual([]);
  });

  it("a second binding whose resolution was taken at another key is a conflict, whichever sorts first", async () => {
    const { scene, a0, a2, b0, root, R } = await bornAtRoot();
    const wrong = scene.add("relationship.bound", { relationshipId: R, localDidId: a0.didId, peerResolutionEventId: ref(resolved(scene, a2.didId, b0)) });
    const check = (fold: RelationshipFold) => {
      expect(fold.relationships.get(R)!.faults).toEqual([`binding ${wrong.eventId} does not hold: its resolution, local DID and relationship ID disagree`]);
      expect(fold.claimants(a0.did, b0.did)).toEqual([]);
    };
    await expectFoldOrderFree(scene.events, check);
    const first = scene.events.find((event) => event.type === "relationship.bound")!;
    await expectFoldOrderFree(scene.events.map((event) => (event === first ? { ...event, at: wrong.at } : event === wrong ? { ...event, at: first.at } : event)), check);
    expect(root).toBeDefined();
  });

  it("an observation that does not derive the message ID it claims conflicts its group, and a group in intent conflict witnesses nothing", async () => {
    const { scene, peerKeys, R, a0, b0, b1, b2, root, binding } = await bornAtRoot();
    const jwt = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b1.longFormDid, IAT);
    const successor = resolved(scene, a0.didId, b1);
    const wire = uuidv7();
    const misnamed = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: jwt, wire, overrides: { messageId: inboundMessageId(b2.publicKey, wire as WireMessageId) } });
    const edge = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: misnamed.data.messageId });
    let fold = await fold_(scene.events);
    expect(fold.transitions.get(edge.eventId)).toEqual({ status: "conflict", because: `observation ${misnamed.eventId} of message ${misnamed.data.messageId} contradicts its resolution` });

    scene.events.splice(scene.events.indexOf(misnamed), 1);
    scene.events.splice(scene.events.indexOf(edge), 1);
    const carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: jwt, wire });
    receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 2, fromPrior: jwt, wire, overrides: { intentHash: cidOf("other intent").slice(0, 43) as VaultData["message.in"]["intentHash"] } });
    const disputed = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId });
    fold = await fold_(scene.events);
    expect(fold.transitions.get(disputed.eventId)).toEqual({ status: "conflict", because: `the observations of message ${carrier.data.messageId} disagree on the intent` });
    expect(dids(fold, R).peer).toEqual([b0.did]);
  });

  it("a successor reference of another type, and an invalid proof beside a missing successor, are conflicts, not waits", async () => {
    const { scene, peerKeys, R, a0, b0, b1, b2, root, binding } = await bornAtRoot();
    const jwt = await signFromPrior(peerKeys, { didId: b0.didId, longFormDid: b0.longFormDid }, b1.longFormDid, IAT);
    const successor = resolved(scene, a0.didId, b1);
    const carrier = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 1, fromPrior: jwt });
    const mistyped = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId, overrides: { peerResolutionEventId: binding as unknown as EventReference<"peer.resolved"> } });
    const forged = await signFromPrior(peerKeys, { didId: b2.didId, longFormDid: b2.longFormDid }, b1.longFormDid, IAT);
    const invalid = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt: forged, prior: root, successor, messageId: carrier.data.messageId, overrides: { peerResolutionEventId: uuidv7() as EventReference<"peer.resolved"> } });
    const fold = await fold_(scene.events);
    expect(fold.transitions.get(mistyped.eventId)).toMatchObject({ status: "conflict", because: expect.stringContaining("the successor's resolution is a relationship.bound") });
    expect(fold.transitions.get(invalid.eventId)).toMatchObject({ status: "conflict", because: expect.stringContaining("the proof does not verify against the pinned predecessor document") });
    expect(dids(fold, R).peer).toEqual([b0.did]);
  });

  it("a numalgo-4 document read back must be what its long form derives: another key's document under this DID's id is no snapshot of it", async () => {
    const { scene, a0, b0, b2 } = await vaults();
    const forgedDocument = { ...b2.resolution.document, id: b0.longFormDid, alsoKnownAs: [b0.did] };
    const forgedBytes = canonicalize(forgedDocument);
    const forged = resolved(scene, a0.didId, b0, { short: true, documentCid: rawCidOfBytes(forgedBytes), peerPublicKey: b2.publicKey, authenticationMethodIds: authorizedMethodIds(forgedDocument, "authentication"), keyAgreementMethodIds: authorizedMethodIds(forgedDocument, "keyAgreement") });
    const { R } = bound(scene, a0, b0, forged);
    const objects = new Map([[forged.data.documentCid, forgedBytes], [b0.resolution.cid, b0.resolution.bytes]]);
    const readObject = async (wanted: Cid) => objects.get(wanted) ?? null;
    let fold = await fold_(scene.events, readObject);
    expect((await verifyResolutions(VaultEventSet.of(scene.events), readObject)).get(forged.eventId)).toBe("invalid");
    expect(fold.relationships.get(R)!.faults).toEqual([`the root resolution ${forged.eventId} is not its document's`]);
    expect(fold.relationships.get(R)!.binding).toBeNull();

    scene.events.splice(scene.events.indexOf(forged), 1);
    scene.events.pop();
    const genuine = resolved(scene, a0.didId, b0, { short: true });
    bound(scene, a0, b0, genuine);
    fold = await fold_(scene.events, readObject);
    expect(fold.relationships.get(R)!.faults).toEqual([]);
    expect(dids(fold, R).peer).toEqual([b0.did]);
    expect(fold.relationships.get(R)!.peerChain[0]!.documentCid).toBe(b0.resolution.cid);
  });

  it("a resolution found not to be its document's authenticates no observation and verifies no proof: the group it is in conflicts", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, b2, root, binding } = await bornAtRoot();
    const wire = uuidv7() as WireMessageId;
    const wrongKey = resolved(scene, a0.didId, b0, { peerPublicKey: b2.publicKey });
    const input = receipt(scene, { local: a0.didId, peer: b0, resolution: wrongKey, binding, ordinal: 1, wire, overrides: { messageId: inboundMessageId(b2.publicKey, wire) } });
    const jwt = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    const edge = localEdge(scene, R, a0.didId, a1.didId, jwt, ref(input));
    let fold = await fold_(scene.events);
    expect((await verifyResolutions(VaultEventSet.of(scene.events), noObjects)).get(wrongKey.eventId)).toBe("invalid");
    expect(fold.transitions.get(edge.eventId)).toMatchObject({ status: "conflict", because: expect.stringContaining(`the trigger ${input.eventId} does not confirm ${a0.didId}`) });
    expect(dids(fold, R).local).toEqual([a0.didId]);

    scene.events.length = scene.events.indexOf(wrongKey);
    const noMethods = resolved(scene, a0.didId, b0, { authenticationMethodIds: [] });
    const { edge: peer } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, noMethods, binding, 2);
    fold = await fold_(scene.events);
    expect(fold.transitions.get(peer.eventId)).toEqual({ status: "conflict", because: "the prior resolution is not its document's" });
    expect(dids(fold, R).peer).toEqual([b0.did]);
    expect(root).toBeDefined();
  });

  it("an observation of the message whose resolution is not here defers the whole group: no witness, no confirmation, until it arrives", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const { edge: peer, successor, carrier, jwt } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const missing = uuidv7() as EventReference<"peer.resolved">;
    const unresolved = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 2, fromPrior: jwt, wire: carrier.data.wireMessageId, overrides: { peerResolutionEventId: missing } });
    const toA1 = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    const local = localEdge(scene, R, a0.didId, a1.didId, toA1, ref(carrier));
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(fold.transitions.get(peer.eventId)).toEqual({ status: "deferred", because: `observation ${unresolved.eventId} of message ${carrier.data.messageId} awaits its resolution` });
      expect(fold.transitions.get(local.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining(`the trigger ${carrier.eventId} awaits its evidence`) });
      expect(dids(fold, R)).toEqual({ local: [a0.didId], peer: [b0.did] });
      expect(fold.relationships.get(R)!.conflict).toBe(false);
    });
    scene.events.push({ ...successor, eventId: missing });
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(fold.transitions.get(peer.eventId)).toEqual({ status: "applied" });
      expect(fold.transitions.get(local.eventId)).toEqual({ status: "applied" });
      expect(dids(fold, R)).toEqual({ local: [a0.didId, a1.didId], peer: [b0.did, b1.did] });
    });
  });

  it("every applied equal transition names its node: a proof-free successor scoped by any of them confirms, whichever sorts first", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const { edge: first, successor, carrier, jwt } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const duplicate = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId });
    const proofFree = receipt(scene, { local: a0.didId, peer: b1, resolution: successor, binding, ordinal: 2, transition: ref(duplicate) });
    const local = localEdge(scene, R, a0.didId, a1.didId, await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT), ref(proofFree));
    const check = (fold: RelationshipFold) => {
      expect(fold.transitions.get(first.eventId)).toEqual({ status: "applied" });
      expect(fold.transitions.get(duplicate.eventId)).toEqual({ status: "applied" });
      expect(fold.transitions.get(local.eventId)).toEqual({ status: "applied" });
      expect([...fold.relationships.get(R)!.peerChain[1]!.edgeEventIds].sort()).toEqual([first.eventId, duplicate.eventId].sort());
      expect(dids(fold, R)).toEqual({ local: [a0.didId, a1.didId], peer: [b0.did, b1.did] });
    };
    await expectFoldOrderFree(scene.events, check);
    await expectFoldOrderFree(scene.events.map((event) => (event === first ? { ...event, at: duplicate.at } : event === duplicate ? { ...event, at: first.at } : event)), check);
  });

  it("equal transitions whose successor snapshot is not here share one wait, never compete; one proof pinning two documents here is a conflict", async () => {
    const { scene, peerKeys, R, a0, b0, b1, b2, root, binding } = await bornAtRoot();
    const { edge, successor, carrier, jwt } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const missing = uuidv7() as EventReference<"peer.resolved">;
    const overrides = { peerResolutionEventId: missing };
    const twins = [peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId, overrides }), peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId, overrides })];
    const withoutEdge = scene.events.filter((event) => event !== edge);
    await expectFoldOrderFree(withoutEdge, (fold) => {
      for (const twin of twins) expect(fold.transitions.get(twin.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("the successor's resolution is not here") });
      expect(fold.relationships.get(R)!.conflict).toBe(false);
      expect(dids(fold, R).peer).toEqual([b0.did]);
    });
    await expectFoldOrderFree(scene.events, (fold) => {
      expect(fold.transitions.get(edge.eventId)).toEqual({ status: "applied" });
      for (const twin of twins) expect(fold.transitions.get(twin.eventId)!.status).toBe("deferred");
      expect(fold.relationships.get(R)!.conflict).toBe(false);
      expect(dids(fold, R).peer).toEqual([b0.did, b1.did]);
    });
    const recovered = [{ ...successor, eventId: missing }, { ...carrier, eventId: uuidv7() as EventId, data: { ...carrier.data, peerResolutionEventId: missing, receiptOrdinal: "2" as VaultData["message.in"]["receiptOrdinal"] } }];
    await expectFoldOrderFree([...withoutEdge, ...recovered], (fold) => {
      for (const twin of twins) expect(fold.transitions.get(twin.eventId)).toEqual({ status: "applied" });
      expect(dids(fold, R).peer).toEqual([b0.did, b1.did]);
    });

    const other = resolved(scene, a0.didId, b1, { documentCid: b2.resolution.cid, keyAgreementMethodIds: authorizedMethodIds(b2.resolution.document, "keyAgreement") });
    const forgedTwin = [...scene.events.filter((event) => !twins.includes(event as VaultEvent<"relationship.peerTransitioned">)), { ...twins[0]!, data: { ...twins[0]!.data, peerResolutionEventId: ref(other) } }];
    await expectFoldOrderFree(forgedTwin, (fold) => {
      expect(fold.transitions.get(twins[0]!.eventId)).toEqual({ status: "conflict", because: "the successor's resolution is not its document's" });
      expect(fold.transitions.get(edge.eventId)).toEqual({ status: "applied" });
      expect(dids(fold, R).peer).toEqual([b0.did, b1.did]);
    });

    const signer = await peerKeys.signing(didKeyName(b0.didId, "authentication"));
    const method = { id: `${WEB_DID}#key-1`, type: "Multikey", controller: WEB_DID, publicKeyMultibase: signer.publicKey };
    const versions = [{ id: WEB_DID, verificationMethod: [method], authentication: [`${WEB_DID}#key-1`], keyAgreement: [`${WEB_DID}#key-1`] }, { id: WEB_DID, verificationMethod: [method], authentication: [`${WEB_DID}#key-1`], keyAgreement: [`${WEB_DID}#key-1`], service: [] }].map((document) => {
      const bytes = canonicalize(document);
      return { bytes, cid: rawCidOfBytes(bytes), peer: { didId: PEER_ID0, did: WEB_DID, longFormDid: WEB_DID, resolution: { did: WEB_DID, presentedDid: WEB_DID, document, bytes, cid: rawCidOfBytes(bytes) }, publicKey: signer.publicKey } as Peer };
    });
    const objects = new Map(versions.map((version) => [version.cid, version.bytes]));
    const [kid] = authorizedMethodIds(b0.resolution.document, "authentication");
    const toWeb = await new SignJWT({ iss: b0.longFormDid, sub: WEB_DID, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: kid! }).sign(await importJWK(signer.privateJwk(), "EdDSA"));
    scene.events.length = scene.events.indexOf(successor);
    const pinned = versions.map((version, i) => {
      const snapshot = resolved(scene, a0.didId, version.peer);
      const witness = receipt(scene, { local: a0.didId, peer: version.peer, resolution: snapshot, binding, ordinal: i + 1, fromPrior: toWeb, wire: "one-wire" });
      return peerEdge(scene, { R, local: a0.didId, from: b0, to: version.peer, jwt: toWeb, prior: root, successor: snapshot, messageId: witness.data.messageId, overrides: { presentedToDid: WEB_DID } });
    });
    await expectFoldOrderFree(scene.events, (fold) => {
      for (const one of pinned) expect(fold.transitions.get(one.eventId)).toEqual({ status: "conflict", because: "one proof pins two successor documents" });
      expect(dids(fold, R).peer).toEqual([b0.did]);
    }, async (wanted) => objects.get(wanted) ?? null);
  });

  it("control input — Empty, a ping response, a problem report — starts no rotation, even at the exact predecessor", async () => {
    const { scene, keys, R, a0, a1, b0, root, binding } = await bornAtRoot();
    const jwt = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    const base = scene.events.length;
    for (const msgType of ["https://didcomm.org/empty/1.0/empty", "https://didcomm.org/trust-ping/2.0/ping-response", "https://didcomm.org/report-problem/2.0/problem-report"]) {
      scene.events.length = base;
      const control = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { msgType } });
      const edge = localEdge(scene, R, a0.didId, a1.didId, jwt, ref(control));
      const fold = await fold_(scene.events);
      expect(fold.transitions.get(edge.eventId)).toEqual({ status: "conflict", because: `the trigger ${control.eventId} is control input, which starts no rotation` });
      expect(dids(fold, R).local).toEqual([a0.didId]);
    }
    scene.events.length = base;
    const ping = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { msgType: "https://didcomm.org/trust-ping/2.0/ping" } });
    const edge = localEdge(scene, R, a0.didId, a1.didId, jwt, ref(ping));
    expect((await fold_(scene.events)).transitions.get(edge.eventId)).toEqual({ status: "applied" });
  });

  it("while the binding does not stand, an edge's own contradictions are still conflicts, and only what needs the root waits", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const { edge: genuine, successor, carrier, jwt } = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    const invalid = peerEdge(scene, { R, local: a0.didId, from: b0, to: b1, jwt, prior: root, successor, messageId: carrier.data.messageId, overrides: { presentedFromDid: b0.did } });
    const control = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2, overrides: { msgType: "https://didcomm.org/empty/1.0/empty" } });
    const local = localEdge(scene, R, a0.didId, a1.didId, await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT), ref(control));
    const unbound = scene.events.filter((event) => event.type !== "relationship.bound");
    await expectFoldOrderFree(unbound, (fold) => {
      expect(fold.relationships.get(R)!.binding).toBeNull();
      expect(fold.transitions.get(invalid.eventId)).toEqual({ status: "conflict", because: "the proof does not verify against the pinned predecessor document" });
      expect(fold.transitions.get(local.eventId)).toMatchObject({ status: "conflict", because: expect.stringContaining("is control input") });
      expect(fold.transitions.get(genuine.eventId)).toMatchObject({ status: "deferred", because: expect.stringContaining("the relationship's binding does not stand") });
      expect(fold.relationships.get(R)!.conflict).toBe(true);
    });
  });
});
