/**
 * A scene of two vaults: ours with three communication DIDs on a
 * mediated route, the peer's with four DIDs minted from another seed,
 * and the builders that record resolutions, receipts, intents and
 * packages between them, so a fold over messages can be set up in a
 * few lines.
 */
import { v7 as uuidv7 } from "uuid";

import {
  authorizedMethodIds,
  automaticMessageId,
  didKeyName,
  effectKey,
  inboundMessageId,
  methodPublicKey,
  mintDid,
  mintMediationDid,
  peerResolution,
  type Did,
  type DidId,
  type EventReference,
  type ExecutionId,
  type Keys,
  type MessageId,
  type MessageOut,
  type PackageId,
  type PeerResolution,
  type PublicKey,
  type VaultData,
  type VaultEvent,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { DID_ID, DID_ID2, DID_ID3, DIRECT, HASH, MEDIATED, MEDIATION, OTHER_SEED, ROUTE, Scene, type EventOptions, cidOf, createdDid, mediatedRoute, openKeys } from "./helpers.js";

export const PEER_ID0 = "019b7000-0000-7000-8000-000000000b00" as DidId;
export const PEER_ID1 = "019b7000-0000-7000-8000-000000000b01" as DidId;
export const PEER_ID2 = "019b7000-0000-7000-8000-000000000b02" as DidId;
export const PEER_ID3 = "019b7000-0000-7000-8000-000000000b03" as DidId;

export const PURE_ACK = "https://estoc.dev/distributed-delivery/1.0#pure-ack";

export type Peer = { didId: DidId; did: Did; longFormDid: Did; resolution: PeerResolution; publicKey: PublicKey };

export async function peerDid(keys: Keys, didId: DidId): Promise<Peer> {
  const minted = await mintDid(keys, didId, DIRECT);
  const resolution = peerResolution(minted.longFormDid);
  const [keyAgreement] = authorizedMethodIds(resolution.document, "keyAgreement");
  return { didId, did: minted.did, longFormDid: minted.longFormDid, resolution, publicKey: methodPublicKey(resolution.document, keyAgreement!) };
}

export type Local = { didId: DidId; did: Did; longFormDid: Did };

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

export type Receipt = {
  local: Local;
  peer: Peer;
  resolution: VaultEvent<"peer.resolved">;
  ordinal: number;
  fromPrior?: string | null;
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
      messageId: inboundMessageId(r.peer.did, r.local.did, wire),
      wireMessageId: wire,
      receiptOrdinal: String(r.ordinal) as VaultData["message.in"]["receiptOrdinal"],
      intentHash: HASH as VaultData["message.in"]["intentHash"],
      plaintextHash: HASH as VaultData["message.in"]["plaintextHash"],
      localKeyName: didKeyName(r.local.didId, "key-agreement"),
      msgType: "https://didcomm.org/basicmessage/2.0/message",
      peerResolutionEventId: ref(r.resolution),
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
      receivedVia: { mediationId: null, deliveryId: null },
      ...r.overrides,
    },
    options
  );
}

export const noObjects = async () => null;

/** A locally initiated send in a channel: one intent under a fresh message ID, nothing automatic. */
export function intent(scene: Scene, sender: Local, recipient: Peer, overrides: Partial<MessageOut> = {}, options: EventOptions = {}): VaultEvent<"message.out"> {
  const messageId = (overrides.messageId ?? uuidv7()) as MessageId;
  return scene.add(
    "message.out",
    {
      messageId,
      senderDidId: sender.didId,
      recipientDid: recipient.did,
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
      effectType: null,
      effectKey: null,
      sourceEventId: null,
      rotationEventId: null,
      ...overrides,
    },
    options
  );
}

/** An automatic effect's intent: the tuple, its key and the message ID the key derives, from the source it answers. */
export function automatic(scene: Scene, sender: Local, recipient: Peer, source: VaultEvent<"message.in">, executionId: ExecutionId, effectType = PURE_ACK, overrides: Partial<MessageOut> = {}): VaultEvent<"message.out"> {
  const key = effectKey(executionId, effectType);
  return intent(scene, sender, recipient, { messageId: automaticMessageId(key), msgType: "https://didcomm.org/empty/1.0/empty", executionId, effectType, effectKey: key, sourceEventId: ref(source), ...overrides });
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
