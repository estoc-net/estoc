/**
 * `@estoc/vault/v3` — the version-3 vault's meaning as a library. What is
 * here so far: the identifier vocabulary, the deterministic identifiers
 * and the canonical public-key value.
 */

export type {
  AuthorId,
  Cid,
  ContactId,
  DecimalOrdinal,
  DeliveryId,
  Did,
  DidId,
  DidUrl,
  EffectKey,
  EntityId,
  EventId,
  EventReference,
  ExecutionId,
  KeyName,
  MediationId,
  MessageId,
  PackageId,
  PublicKey,
  RelationshipId,
  ReplicaId,
  RouteId,
  SyncId,
  WireMessageId,
} from "./types.js";

export { InvalidIdentifier, InvalidPublicKey } from "./errors.js";

export { encodeBase64Url, decodeBase64Url } from "./base64url.js";

export {
  NAMESPACE_PURPOSES,
  type NamespacePurpose,
  estocNamespace,
  compareUtf8,
  relationshipId,
  contactIdOf,
  earlyPrivateDidId,
  inboundMessageId,
  executionId,
  decimalOrdinal,
  parseDecimalOrdinal,
  type EffectTuple,
  effectKey,
  automaticMessageId,
  ANCHOR_KEY_NAME,
  type DidKeyRole,
  didKeyName,
  mediationKeyName,
} from "./ids.js";

export { canonicalPublicKey, parsePublicKey, decodePublicKey, type KeyType, type DecodedPublicKey, type Jwk } from "./public-key.js";
