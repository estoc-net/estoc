/**
 * The identifier vocabulary of the version-3 vault and the payload of
 * each event type. Every kind of value a payload or a runtime interface
 * names is a distinct nominal type over the validated string it
 * serializes as, with no wrapper and no prefix. Nothing here checks a
 * value: the parser or the derivation that produces one is the check,
 * and a cast is not. Event identity comes from `@estoc/event-store/v3`,
 * content identity from `@estoc/dasl` through it.
 */

import type { AuthorId, Cid, EventId, JsonObject } from "@estoc/event-store/v3";

export type { AuthorId, Cid, EventId };

export type EntityId<Kind extends string> = string & { readonly __entity: Kind };

/** A vault message entity, or an inbound observation group. */
export type MessageId = EntityId<"message">;
export type ContactId = EntityId<"contact">;
export type RelationshipId = EntityId<"relationship">;
/** A local communication-DID entity, not the DID string. */
export type DidId = EntityId<"did">;
export type RouteId = EntityId<"route">;
export type MediationId = EntityId<"mediation">;
export type PackageId = EntityId<"package">;
/** A relationship-scoped automatic execution. */
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
/** A DID string. */
export type Did = string & { readonly __did: unique symbol };
/** A verification-method DID URL. */
export type DidUrl = string & { readonly __didUrl: unique symbol };
/** The derived idempotency key of one automatic effect. */
export type EffectKey = string & { readonly __effectKey: unique symbol };
/** An effect's ordinal as it is stored: canonical non-negative decimal. */
export type DecimalOrdinal = string & { readonly __decimalOrdinal: unique symbol };
/** An inbound observation's receipt ordinal as it is stored: canonical positive decimal. */
export type ReceiptOrdinal = string & { readonly __receiptOrdinal: unique symbol };
/** Unpadded base64url SHA-256 of a canonical projection or plaintext. */
export type MessageHash = string & { readonly __messageHash: unique symbol };

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
export type DisclosureAs = "oob" | "profile" | "direct";
export type DisclosureUses = "one" | "many";
export type ContactOrigin = "user" | "automatic";
export type FailureScope = "package" | "message";

/** The offline birth selection of an outbound whose binding is not yet committed. */
export type Birth = { localDidId: DidId; peerDid: Did };

/** The headers of a message that no dedicated field models; none of them a reserved DIDComm name. */
export type AdditionalHeaders = JsonObject;

/**
 * The intent an outbound event freezes: what the plaintext will carry.
 * The five effect fields are all null for a locally initiated send and
 * all non-null for an automatic effect, where they are the producing
 * tuple, its key and the message ID derived from that key.
 */
export type MessageOut = {
  messageId: MessageId;
  relationshipId: RelationshipId;
  birth: Birth | null;
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
  handlerId: string | null;
  effectKind: string | null;
  ordinal: DecimalOrdinal | null;
  effectKey: EffectKey | null;
};

/** Where an inbound observation arrived: both null for direct transport without them. */
export type ReceivedVia = { mediationId: MediationId | null; deliveryId: DeliveryId | null };

/**
 * One durable inbound observation. An anonymous observation has null
 * `peerResolutionEventId`, `did` and `presentedDid` together; every
 * other observation names its resolution evidence.
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
  relationshipBindingEventId: EventReference<"relationship.bound"> | null;
  peerTransitionEventId: EventReference<"relationship.peerTransitioned"> | null;
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
  signedBy: string | null;
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
  "relationship.bound": { relationshipId: RelationshipId; localDidId: DidId; peerResolutionEventId: EventReference<"peer.resolved"> };
  "relationship.contactAssigned": { relationshipId: RelationshipId; contactId: ContactId };
  "relationship.peerTransitioned": {
    relationshipId: RelationshipId;
    localKeyName: KeyName;
    peerPublicKey: PublicKey;
    fromDid: Did;
    presentedFromDid: Did;
    toDid: Did;
    presentedToDid: Did;
    fromPrior: string;
    priorResolutionEventId: EventReference<"peer.resolved">;
    peerResolutionEventId: EventReference<"peer.resolved">;
    messageId: MessageId;
  };
  "relationship.localTransitioned": {
    relationshipId: RelationshipId;
    fromDidId: DidId;
    toDidId: DidId;
    fromPrior: string;
    triggerEventId: EventReference<"message.in"> | null;
  };
  "contact.created": { contactId: ContactId; because: ContactOrigin };
  "contact.petname": { contactId: ContactId; name: string };
  "contact.flag": { contactId: ContactId; flag: string; value: boolean };
  "contact.useDid": { contactId: ContactId; didId: DidId; because: string };
  "contact.peerDidAdded": { contactId: ContactId; did: Did; because: string };
  "contact.peerDidRemoved": { contactId: ContactId; addEventId: EventReference<"contact.peerDidAdded"> };
  "contact.merged": { contactId: ContactId; fromContactId: ContactId };
  "contact.deleted": { contactId: ContactId };
  "profile.nameClaimed": { relationshipId: RelationshipId; sourceEventId: EventReference<"message.in">; name: string };
  "profile.shared": { relationshipId: RelationshipId; sourceEventId: EventReference<"message.out"> };
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
  "message.packageRetired": { messageId: MessageId; packageId: PackageId; because: string; replacementPackageId: PackageId | null };
  "delivery.submitted": { messageId: MessageId; packageId: PackageId };
  "delivery.failed": { messageId: MessageId; scope: FailureScope; packageId: PackageId | null; code: string };
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
