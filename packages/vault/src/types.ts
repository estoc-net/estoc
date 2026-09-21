/**
 * The identifier vocabulary of the version-3 vault and the payload of
 * each event type. Every kind of value a payload or a runtime interface
 * names is a distinct nominal type over the validated string it
 * serializes as, with no wrapper and no prefix. Nothing here checks a
 * value: the parser or the derivation that produces one is the check,
 * and a cast is not. Event identity comes from `@estoc/event-store`,
 * content identity from `@estoc/dasl` through it.
 */

import type { AuthorId, Cid, EventId, JsonObject } from "@estoc/event-store";

export type { AuthorId, Cid, EventId };

export type EntityId<Kind extends string> = string & { readonly __entity: Kind };

/** A vault message entity, or an inbound observation group. */
export type MessageId = EntityId<"message">;
export type ContactId = EntityId<"contact">;
/** A local communication-DID entity, not the DID string. */
export type DidId = EntityId<"did">;
export type RouteId = EntityId<"route">;
export type MediationId = EntityId<"mediation">;
export type PackageId = EntityId<"package">;
/** A channel-scoped automatic execution. */
export type ExecutionId = EntityId<"execution">;
/** Deferred configuration events only. */
export type SyncId = EntityId<"sync">;
export type ReplicaId = AuthorId;

/** A received DIDComm plaintext `id`, in the sender's scope. */
export type WireMessageId = string & { readonly __wireMessageId: unique symbol };
/** A scoped mediator delivery. */
export type DeliveryId = string & { readonly __deliveryId: unique symbol };
export type KeyName = string & { readonly __keyName: unique symbol };
/** A complete canonical public-key value. */
export type PublicKey = string & { readonly __publicKey: unique symbol };
export type Did = string & { readonly __did: unique symbol };
/** A verification-method DID URL. */
export type DidUrl = string & { readonly __didUrl: unique symbol };
/** The derived idempotency key of one automatic effect. */
export type EffectKey = string & { readonly __effectKey: unique symbol };
/** An inbound observation's receipt ordinal as it is stored: canonical positive decimal. */
export type ReceiptOrdinal = string & { readonly __receiptOrdinal: unique symbol };
/** Unpadded base64url SHA-256 of a canonical projection or plaintext. */
export type MessageHash = string & { readonly __messageHash: unique symbol };

/** One of our DIDs and a peer's, both canonical short forms, as an ordered pair: the unit every receipt, intent and continuity fact is scoped to. */
export type Channel = { localDid: Did; peerDid: Did };

/**
 * A reference to one event whose type the referencing schema fixes. It
 * records what the target must be; it is no proof the target is
 * available or valid.
 */
export type EventReference<T extends string> = EventId & { readonly __eventType: T };

// ---- payloads -----------------------------------------------------------

/** An integer count of seconds since the Unix epoch, as DIDComm timing headers carry it. */
export type EpochSeconds = number;

export type RouteKind = "mediated" | "direct";
export type DisclosureAs = "oob" | "direct";
export type DisclosureUses = "one" | "many";
export type ContactOrigin = "user" | "automatic";
/** Why an unsubmitted outbound ended: its expiry was reached, or the user cancelled it. */
export type DeliveryFailureCode = "expired" | "cancelled";

/** The headers of a message that no dedicated field models; none of them a reserved DIDComm name. */
export type AdditionalHeaders = JsonObject;

/**
 * The intent an outbound event freezes: what the plaintext will carry,
 * and the channel it is fixed to. The three effect fields are all null
 * for a locally initiated send and all non-null for an automatic
 * effect, where they are the producing tuple and its key; the source
 * is the exact observation an effect derives from, the rotation the
 * decision a notification announces.
 */
export type MessageOut = {
  messageId: MessageId;
  senderDidId: DidId;
  recipientDid: Did;
  msgType: string;
  thid: string | null;
  pthid: string | null;
  createdTime: EpochSeconds | null;
  expiresTime: EpochSeconds | null;
  pleaseAck: string[] | null;
  ack: string[];
  headers: AdditionalHeaders;
  bodyCid: Cid;
  attachmentCids: Cid[];
  intentHash: MessageHash;
  executionId: ExecutionId | null;
  effectType: string | null;
  effectKey: EffectKey | null;
  sourceEventId: EventReference<"message.in"> | null;
  rotationEventId: EventReference<"did.rotationSelected"> | null;
};

/** Where an inbound observation arrived: both null for direct transport without them. */
export type ReceivedVia = { mediationId: MediationId | null; deliveryId: DeliveryId | null };

/**
 * One durable inbound observation. An anonymous observation has null
 * `peerResolutionEventId`, `did` and `presentedDid` together; every
 * other observation names its resolution evidence. `fromPrior` is the
 * original string off the wire, whatever it turns out to be.
 */
export type MessageIn = {
  messageId: MessageId;
  wireMessageId: WireMessageId;
  receiptOrdinal: ReceiptOrdinal;
  intentHash: MessageHash;
  plaintextHash: MessageHash;
  localKeyName: KeyName;
  msgType: string;
  peerResolutionEventId: EventReference<"peer.resolved"> | null;
  presentedDid: Did | null;
  did: Did | null;
  thid: string | null;
  pthid: string | null;
  createdTime: EpochSeconds | null;
  expiresTime: EpochSeconds | null;
  pleaseAck: string[] | null;
  ack: string[];
  headers: AdditionalHeaders;
  fromPrior: string | null;
  bodyCid: Cid;
  attachmentCids: Cid[];
  bytes: number;
  receivedVia: ReceivedVia;
};

/** The payload of each version-3 event type, by type name. */
export type VaultData = {
  "identity.label": { name: string };
  "peer.resolved": {
    localKeyName: KeyName;
    peerPublicKey: PublicKey;
    presentedDid: Did;
    did: Did;
    documentCid: Cid;
    authenticationMethodIds: DidUrl[];
    keyAgreementMethodIds: DidUrl[];
    service: string | null;
  };
  "mediation.created": { mediationId: MediationId; mediatorDid: Did; me: { keyName: KeyName; did: Did } };
  "mediation.granted": { mediationId: MediationId; routingDid: Did };
  "mediation.selected": { mediationId: MediationId };
  "mediation.retired": { mediationId: MediationId; because: string };
  "did.created": { didId: DidId; did: Did; longFormDid: Did; boundRouteId: RouteId };
  "route.configured":
    | { routeId: RouteId; kind: "mediated"; mediationId: MediationId; endpoint: null }
    | { routeId: RouteId; kind: "direct"; mediationId: null; endpoint: string };
  "route.retired": { routeId: RouteId; because: string };
  "did.disclosed": { didId: DidId; as: DisclosureAs; uses: DisclosureUses; oobId: string | null; goal: string | null };
  "did.retired": { didId: DidId; because: string };
  "invitation.consumed": { disclosureEventId: EventReference<"did.disclosed">; sourceEventId: EventReference<"message.in"> };
  "did.rotationSelected": { fromDidId: DidId; peerDid: Did; toDidId: DidId; sourceEventId: EventReference<"message.in"> | null; fromPrior: string };
  "channel.blocked": { localDid: Did; peerDid: Did; includeSuccessors: boolean };
  "contact.created": { contactId: ContactId; because: ContactOrigin };
  "contact.petname": { contactId: ContactId; name: string };
  "contact.flag": { contactId: ContactId; flag: string; value: boolean };
  "contact.useDid": { contactId: ContactId; didId: DidId; because: string };
  "contact.channelsSet": { contactId: ContactId; channels: Channel[] };
  "contact.merged": { contactId: ContactId; fromContactId: ContactId };
  "contact.deleted": { contactId: ContactId };
  "message.out": MessageOut;
  "message.prepared": {
    messageId: MessageId;
    packageId: PackageId;
    senderDidId: DidId;
    localKeyName: KeyName;
    recipientDid: Did;
    peerResolutionEventId: EventReference<"peer.resolved">;
    fromPrior: string | null;
    intentHash: MessageHash;
    plaintextHash: MessageHash;
    envelopeCid: Cid;
  };
  "delivery.submitted": { messageId: MessageId; packageId: PackageId };
  "delivery.failed": { messageId: MessageId; code: DeliveryFailureCode };
  "delivery.acknowledged": {
    messageId: MessageId;
    localKeyName: KeyName;
    peerPublicKey: PublicKey;
    ackMessageId: MessageId;
    ackWireMessageId: WireMessageId;
  };
  "message.in": MessageIn;
  "message.erased": { messageId: MessageId; dropCids: Cid[]; because: string };
};

export type VaultEventType = keyof VaultData;
