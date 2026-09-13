/**
 * `@estoc/vault/v3` — the version-3 vault's meaning as a library. What is
 * here so far: the identifier vocabulary, the deterministic identifiers,
 * the canonical public-key value, the schema of every event type, the
 * stored message document and the projections a message is hashed by.
 */

export type {
  AdditionalHeaders,
  AuthorId,
  Birth,
  Cid,
  ContactId,
  ContactOrigin,
  DecimalOrdinal,
  DeliveryId,
  Did,
  DidId,
  DidUrl,
  DisclosureAs,
  DisclosureUses,
  EffectKey,
  EntityId,
  EpochSeconds,
  EventId,
  EventReference,
  ExecutionId,
  FailureScope,
  KeyName,
  MediationId,
  MessageHash,
  MessageId,
  MessageIn,
  MessageOut,
  PackageId,
  PublicKey,
  ReceiptOrdinal,
  ReceivedVia,
  RelationshipId,
  ReplicaId,
  RouteId,
  RouteKind,
  SyncId,
  VaultData,
  VaultEventType,
  WireMessageId,
} from "./types.js";

export { InvalidIdentifier, InvalidPayload, InvalidPlaintext, InvalidPublicKey } from "./errors.js";

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

export {
  type StoredAttachmentData,
  type StoredAttachment,
  type StoredMessageDocument,
  type StoredObject,
  type StoredMessage,
  rawCidOfBytes,
  messageRoots,
  storeMessage,
  readStoredDocument,
  wireAttachment,
} from "./document.js";

export {
  PLAINTEXT_TYP,
  RESERVED_HEADERS,
  type Intent,
  type ReadPlaintext,
  type Addressing,
  checkHeaders,
  semanticProjection,
  intentProjection,
  intentHash,
  plaintextHash,
  expandPleaseAck,
  requestsAck,
  intentOfOutbound,
  readPlaintext,
  wirePlaintext,
} from "./projection.js";

export { type VaultEvent, type VaultDraft, VAULT_EVENT_TYPES, isVaultEventType, readVaultEvent, readVaultDraft, vaultDraft } from "./schema.js";
