/**
 * A scene of two vaults: ours with three communication DIDs on a
 * mediated route, the peer's with four DIDs minted from another seed,
 * and the builders that record resolutions, bindings, receipts and
 * transitions between them, so a fold over relationships, outbounds
 * or profiles can be set up in a few lines.
 */
import type { Event } from "@estoc/event-store/v3";
import { v7 as uuidv7 } from "uuid";

import {
  authorizedMethodIds,
  automaticMessageId,
  decimalOrdinal,
  didKeyName,
  effectKey,
  foldMediations,
  foldRelationships,
  foldRelationshipsVerified,
  foldRoutes,
  inboundMessageId,
  methodPublicKey,
  mintDid,
  mintMediationDid,
  peerResolution,
  relationshipId,
  signFromPrior,
  verifyResolutions,
  verifyTransitions,
  VaultEventSet,
  type Cid,
  type ContactId,
  type Did,
  type DidId,
  type EventReference,
  type EffectTuple,
  type ExecutionId,
  type Keys,
  type MessageId,
  type MessageOut,
  type PackageId,
  type PeerResolution,
  type PublicKey,
  type RelationshipFold,
  type RelationshipId,
  type RouteFold,
  type VaultEventSet as EventSet,
  type VaultData,
  type VaultEvent,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { DID_ID, DID_ID2, DID_ID3, DIRECT, HASH, MEDIATED, MEDIATION, OTHER_SEED, ROUTE, Scene, type EventOptions, cidOf, createdDid, expectOrderFree, mediatedRoute, openKeys } from "./helpers.js";
export const PEER_ID0 = "019b7000-0000-7000-8000-000000000b00" as DidId;

export const PEER_ID1 = "019b7000-0000-7000-8000-000000000b01" as DidId;

export const PEER_ID2 = "019b7000-0000-7000-8000-000000000b02" as DidId;

export const PEER_ID3 = "019b7000-0000-7000-8000-000000000b03" as DidId;

export const CONTACT = "019b2a63-48bf-7214-961d-4c3f97cb95da" as ContactId;

export const CONTACT2 = "019b2a63-48bf-7214-961d-4c3f97cb95db" as ContactId;

export const IAT = 1_757_700_000;

export const WEB_DID = "did:web:bob.example" as Did;

export type Peer = { didId: DidId; did: Did; longFormDid: Did; resolution: PeerResolution; publicKey: PublicKey };

export async function peerDid(keys: Keys, didId: DidId): Promise<Peer> {
  const minted = await mintDid(keys, didId, DIRECT);
  const resolution = peerResolution(minted.longFormDid);
  const [keyAgreement] = authorizedMethodIds(resolution.document, "keyAgreement");
  return { didId, did: minted.did, longFormDid: minted.longFormDid, resolution, publicKey: methodPublicKey(resolution.document, keyAgreement!) };
}

export type Local = { didId: DidId; did: Did; longFormDid: Did };

/** The two vaults of a scene: ours with three communication DIDs on a mediated route, the peer's with four. */

export async function vaults() {
  const keys = await openKeys();
  const peerKeys = await openKeys(OTHER_SEED);
  const scene = new Scene();
  mediatedRoute(scene, { me: (await mintMediationDid(keys, MEDIATION)).longFormDid });
  const a0 = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
  const a1 = await createdDid(scene, keys, DID_ID2, ROUTE, MEDIATED);
  const a2 = await createdDid(scene, keys, DID_ID3, ROUTE, MEDIATED);
  const b0 = await peerDid(peerKeys, PEER_ID0);
  const b1 = await peerDid(peerKeys, PEER_ID1);
  const b2 = await peerDid(peerKeys, PEER_ID2);
  const b3 = await peerDid(peerKeys, PEER_ID3);
  return { keys, peerKeys, scene, a0, a1, a2, b0, b1, b2, b3 };
}

export type ResolvedOptions = Partial<VaultData["peer.resolved"]> & { short?: boolean };

export function resolved(scene: Scene, local: DidId, peer: Peer, options: ResolvedOptions = {}): VaultEvent<"peer.resolved"> {
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

export const ref = <T extends VaultEvent>(event: T) => event.eventId as EventReference<T["type"]>;

export function bound(scene: Scene, local: Local, peer: Peer, resolution: VaultEvent<"peer.resolved">, R = relationshipId(local.did, peer.did)) {
  const event = scene.add("relationship.bound", { relationshipId: R, localDidId: local.didId, peerResolutionEventId: ref(resolution) });
  return { R, bound: ref(event) };
}

export type Receipt = {
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

export function receipt(scene: Scene, r: Receipt, options: EventOptions = {}): VaultEvent<"message.in"> {
  const wire = (r.wire ?? uuidv7()) as WireMessageId;
  return scene.add(
    "message.in",
    {
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
    },
    options
  );
}

export type PeerEdge = {
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

export function peerEdge(scene: Scene, e: PeerEdge): VaultEvent<"relationship.peerTransitioned"> {
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

export function localEdge(scene: Scene, R: RelationshipId, from: DidId, to: DidId, jwt: string, trigger: EventReference<"message.in"> | null = null): VaultEvent<"relationship.localTransitioned"> {
  return scene.add("relationship.localTransitioned", { relationshipId: R, fromDidId: from, toDidId: to, fromPrior: jwt, triggerEventId: trigger });
}

export const routesOf = (set: VaultEventSet): RouteFold => foldRoutes(set, foldMediations(set));

export const noObjects = async () => null;

export async function fold(events: readonly Event[], readObject: (cid: Cid) => Promise<Uint8Array | null> = noObjects): Promise<RelationshipFold> {
  const set = VaultEventSet.of(events);
  return foldRelationshipsVerified(set, routesOf(set), readObject);
}

/** The document verdicts of a scene, computed once: they depend on the set, not on its order. */

export async function documentChecksOf(events: readonly Event[], readObject: (cid: Cid) => Promise<Uint8Array | null> = noObjects) {
  const set = VaultEventSet.of(events);
  return { resolutionChecks: await verifyResolutions(set, readObject), proofChecks: await verifyTransitions(set, routesOf(set), readObject) };
}

/** The fold with every snapshot verified but no proof checked. */

export async function foldUnproven(events: readonly Event[]): Promise<RelationshipFold> {
  const set = VaultEventSet.of(events);
  return foldRelationships(set, routesOf(set), { resolutionChecks: await verifyResolutions(set, noObjects) });
}

/** The verdicts of a scene computed once, then the fold checked over shuffles of the events. */

export async function expectFoldOrderFree(events: readonly Event[], check: (fold: RelationshipFold) => void, readObject: (cid: Cid) => Promise<Uint8Array | null> = noObjects): Promise<void> {
  const checks = await documentChecksOf(events, readObject);
  const foldWith = (s: EventSet) => foldRelationships(s, routesOf(s), checks);
  check(foldWith(VaultEventSet.of(events)));
  expectOrderFree(events, foldWith);
}

export const dids = (fold: RelationshipFold, R: RelationshipId) => ({
  local: fold.relationships.get(R)!.localChain.map((node) => node.didId),
  peer: fold.relationships.get(R)!.peerChain.map((node) => node.did),
});

/** A peer rotation B0 → B1 carried to one of our DIDs: the successor's resolution, the carrier and the edge. */

export async function peerRotation(scene: Scene, peerKeys: Keys, R: RelationshipId, local: DidId, from: Peer, to: Peer, prior: VaultEvent<"peer.resolved">, binding: EventReference<"relationship.bound"> | null, ordinal: number) {
  const jwt = await signFromPrior(peerKeys, { didId: from.didId, longFormDid: from.longFormDid }, to.longFormDid, IAT);
  const successor = resolved(scene, local, to);
  const carrier = receipt(scene, { local, peer: to, resolution: successor, binding, ordinal, fromPrior: jwt });
  const edge = peerEdge(scene, { R, local, from, to, jwt, prior, successor, messageId: carrier.data.messageId });
  return { jwt, successor, carrier, edge };
}


/** A locally initiated send in a relationship: one intent under a fresh message ID, nothing automatic. */
export function intent(scene: Scene, R: RelationshipId, overrides: Partial<MessageOut> = {}, options: EventOptions = {}): VaultEvent<"message.out"> {
  const messageId = (overrides.messageId ?? uuidv7()) as MessageId;
  return scene.add(
    "message.out",
    {
      messageId,
      relationshipId: R,
      birth: null,
      msgType: "https://didcomm.org/basicmessage/2.0/message",
      thid: null,
      pthid: null,
      createdTime: null,
      expiresTime: null,
      pleaseAck: null,
      ack: [],
      headers: {},
      bodyCid: cidOf(`body ${messageId}`),
      attachmentCids: [],
      intentHash: HASH as MessageOut["intentHash"],
      executionId: null,
      handlerId: null,
      effectKind: null,
      ordinal: null,
      effectKey: null,
      ...overrides,
    },
    options
  );
}

/** An automatic effect's intent: the tuple, its key and the message ID the key derives. */
export function automatic(scene: Scene, R: RelationshipId, tuple: { executionId: ExecutionId; handlerId?: string; effectKind?: string; ordinal?: number }, overrides: Partial<MessageOut> = {}): VaultEvent<"message.out"> {
  const full: EffectTuple = { executionId: tuple.executionId, handlerId: tuple.handlerId ?? "https://didcomm.org/empty/1.0", effectKind: tuple.effectKind ?? "empty", ordinal: decimalOrdinal(tuple.ordinal ?? 0) };
  const key = effectKey(full);
  return intent(scene, R, { messageId: automaticMessageId(key), msgType: "https://didcomm.org/empty/1.0/empty", executionId: full.executionId, handlerId: full.handlerId, effectKind: full.effectKind, ordinal: full.ordinal, effectKey: key, ...overrides });
}

export type PackageInput = { sender: DidId; recipient: Peer; resolution: VaultEvent<"peer.resolved">; fromPrior?: string | null; packageId?: PackageId; overrides?: Partial<VaultData["message.prepared"]> };

/** A package of an intent: sent from one of our DIDs to the peer's, under the resolution that selected the peer key. */
export function packageOf(scene: Scene, out: VaultEvent<"message.out">, input: PackageInput, options: EventOptions = {}): VaultEvent<"message.prepared"> {
  const packageId = (input.packageId ?? uuidv7()) as PackageId;
  return scene.add(
    "message.prepared",
    {
      messageId: out.data.messageId,
      packageId,
      senderDidId: input.sender,
      localKeyName: didKeyName(input.sender, "key-agreement"),
      recipientDid: input.recipient.did,
      peerResolutionEventId: ref(input.resolution),
      fromPrior: input.fromPrior ?? null,
      intentHash: out.data.intentHash,
      plaintextHash: HASH as VaultData["message.prepared"]["plaintextHash"],
      envelopeCid: cidOf(`envelope ${packageId}`),
      ...input.overrides,
    },
    options
  );
}
