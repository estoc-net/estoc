/**
 * `@estoc/vault/v3` — the version-3 vault's meaning as a library. What is
 * here so far: the identifier vocabulary, the deterministic identifiers,
 * the canonical public-key value, the schema of every event type, the
 * stored message document, the projections a message is hashed by,
 * the vault's own keys and DIDs, the retained peer document, the
 * `from_prior` proof, and the first folds: the event set they read,
 * the authors and label, the mediations, the routes and local DIDs,
 * the relationships with their chains and address index, the
 * invitations and the contacts' own decisions, the outbound messages
 * with their packages, deliveries and acknowledgments, the held roots
 * and the read state of a root, and the relationship profiles.
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

export { IdentityMismatch, InvalidDidDocument, InvalidFromPrior, InvalidIdentifier, InvalidPayload, InvalidPlaintext, InvalidPublicKey, Locked } from "./errors.js";

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

export {
  type OkpPrivateJwk,
  type LocalKey,
  type DidKeys,
  Keys,
  type RouteTarget,
  type LocalDid,
  type MintedDid,
  AUTHENTICATION_METHOD,
  KEY_AGREEMENT_METHOD,
  DIDCOMM_SERVICE,
  inputDocumentOf,
  mintDid,
  mintMediationDid,
  didDocumentOf,
  documentSendsTo,
  routeServiceUri,
  checkDidKeys,
  checkMediationKeys,
  checkDidCreated,
  checkMediationCreated,
} from "./identity.js";

export {
  type VerificationRelationship,
  type PeerResolution,
  canonicalDidOf,
  didcommServiceUris,
  peerResolution,
  splitDidUrl,
  authorizedMethodIds,
  methodPublicKey,
} from "./peer-document.js";

export { FROM_PRIOR_ALG, type FromPriorClaims, type VerifiedFromPrior, type PinnedResolution, signFromPrior, fromPriorClaims, verifyFromPrior } from "./from-prior.js";

export { VaultEventSet, type InvalidVaultEvent, type Resolved, latest, groupBy, samePayload } from "./fold/set.js";
export { type AuthorActivity, foldAuthors, foldLabel } from "./fold/author.js";
export {
  type KeyCheck,
  type IdentityCheck,
  type MediationStatus,
  type Mediation,
  type MediationFold,
  type MediationFoldOptions,
  foldMediations,
  verifyMediationKeys,
} from "./fold/mediation.js";
export {
  type Route,
  type LocalDidEntity,
  type DesiredRecipient,
  type ReceiptEligibility,
  type RouteFold,
  type RouteFoldOptions,
  foldRoutes,
  verifyDidKeys,
  foldWithSeed,
  requiredReceivingSet,
} from "./fold/routes.js";
export {
  type EvidenceCheck,
  type LocalNode,
  type PeerNode,
  type TransitionStatus,
  type Relationship,
  type PendingClaim,
  type RelationshipFold,
  type RelationshipFoldOptions,
  type ObservationScope,
  type ObservationGroup,
  type ReadObject,
  foldRelationships,
  bindingHolds,
  verifyResolutions,
  verifyTransitions,
  foldRelationshipsVerified,
} from "./fold/relationships.js";
export { type Consumability, type Invitation, type InvitationFold, foldInvitations } from "./fold/invitations.js";
export { type PeerDidSeed, type ContactDecisions, foldContacts } from "./fold/contacts.js";
export { type Membership, type Package, type Outcome, type Work, type Outbound, type OutboundFold, type OutboundFoldOptions, foldOutbound } from "./fold/outbound.js";
export { type Erasures, type ReadState, foldErasures, erased, retainEnvelope, heldRoots, readState } from "./fold/held.js";
export { type SourceKey, type NameClaim, type Share, type Profile, compareKeys, foldProfiles, profileOf } from "./fold/profile.js";
