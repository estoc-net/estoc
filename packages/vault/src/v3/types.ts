/**
 * The identifier vocabulary of the version-3 vault: every kind of value
 * a vault-event payload or a runtime interface names is a distinct
 * nominal type over the validated string it serializes as, with no
 * wrapper and no prefix. Nothing here checks a value: the parser or
 * the derivation that produces one is the check, and a cast is not.
 * Event identity comes from `@estoc/event-store/v3`, content identity
 * from `@estoc/dasl` through it.
 */

import type { AuthorId, Cid, EventId } from "@estoc/event-store/v3";

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
/** One prepared package. */
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
/** A vault keystore name. */
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

/**
 * A reference to one event whose type the referencing schema fixes. It
 * records what the target must be; it is no proof the target is
 * available or valid.
 */
export type EventReference<T extends string> = EventId & { readonly __eventType: T };
