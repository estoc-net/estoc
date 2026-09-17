/**
 * `@estoc/vault/v3` — the version-3 vault's meaning as a library: the
 * identifiers and their vocabulary, the schema of every event type and
 * of the stored message document, the vault's own keys, DIDs and
 * proofs, the evidence it keeps of its peers, and the folds that read
 * an event set into what the vault knows.
 */

export type {
  AdditionalHeaders,
  AuthorId,
  Channel,
  Cid,
  ContactId,
  ContactOrigin,
  DeliveryFailureCode,
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
  channelOf,
  channelKey,
  sameChannel,
  compareChannels,
  inboundMessageId,
  anonymousMessageId,
  executionId,
  effectKey,
  automaticMessageId,
  ANCHOR_KEY_NAME,
  type DidKeyRole,
  didKeyName,
  mediationKeyName,
} from "./ids.js";

export { canonicalPublicKey, parsePublicKey, decodePublicKey, agreementKey, type KeyType, type DecodedPublicKey, type Jwk } from "./public-key.js";

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

export { FROM_PRIOR_ALG, type FromPriorClaims, type CarriedClaims, type VerifiedFromPrior, signFromPrior, fromPriorClaims, carriedClaims, issuerDocumentOf, verifyFromPrior, verifyLocalProof } from "./from-prior.js";

export { VaultEventSet, type InvalidVaultEvent, type Resolved, type SourceKey, latest, groupBy, samePayload, keyOf, compareKeys } from "./fold/set.js";
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
export { type EvidenceCheck, type ReadObject, resolvedDocumentOf, verifyResolutions } from "./fold/evidence.js";
export {
  type Standing,
  type Source,
  type ReceiptKey,
  type ReceiptIntegrity,
  type PeerLink,
  type Proof,
  type Carrier,
  type LocalLink,
  type DecisionStatus,
  type Decision,
  type ChannelEvidence,
  type ChannelChecks,
  foldChannelEvidence,
  foldSources,
  receiptOrderKey,
  compareReceiptKeys,
  foldReceipts,
  foldCarriers,
  foldDecisions,
  verifyProofs,
} from "./fold/channels.js";
export { type Replaced, type ContinuityLink, type Conflict, type Status, type Witness, type Continuity, foldContinuity } from "./fold/continuity.js";
export { type Erasures, type ReadState, foldErasures, erased, retainedRoots, heldRoots, readState } from "./fold/held.js";
export { type VaultChecks, type VaultFold, type ScanOptions, MAX_READ_BYTES, foldVault, objectReader, checkVault, foldVaultChecked, scanVault } from "./fold/vault.js";
export { type Committed, vaultRetention, vaultHeldRoots, collectGarbage, eraseDrafts, erasureClosure, eraseMessage, closeErasures } from "./procedures.js";
