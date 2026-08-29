/**
 * @estoc/vault — the `.estoc` vault format as code.
 *
 * The contract is `docs/vault-format.md` at the repository root; this
 * package is its reference implementation, and nothing more: a
 * `VaultBackend` (bytes: OPFS, memory; a folder on disk via
 * `@estoc/vault/node`), the layout over it (config and keystore
 * singletons, contact and invitation records, message and delivery logs,
 * blobs, the trace log with its retention), snapshot and merge-import, and the `Vault` object that holds
 * the two singletons and mints keys by name. What a key is minted *as* —
 * a did:peer:4 with a mediator's routing DID as its service, say — is not
 * a format question: the caller hands `Vault` a `MintDid`, and the vault
 * records the DID it returns as the snapshot the contract asks for.
 */

export { MemoryBackend } from "./backend/memory.js";
export { OpfsBackend } from "./backend/opfs.js";
export { segmentsOf, walk, type VaultBackend } from "./backend/types.js";

export {
  BLOBS_DIR,
  CACHE_DIR,
  CONFIG_PATH,
  CONTACTS_DIR,
  DELIVERIES_DIR,
  ESTOC_DIR,
  INVITATIONS_DIR,
  KEYSTORE_PATH,
  MESSAGES_DIR,
  STATE_DIR,
  TRACE_DIR,
} from "./layout.js";
export { parseConfig, type KeyRef, type Mediation, type VaultConfig } from "./config.js";
export {
  ContactStore,
  contactFile,
  currentDid,
  currentMyDid,
  didPlaceholder,
  newContact,
  previousMyDid,
  parseContact,
  type ContactRecord,
  type DidUse,
  type MyDidUse,
} from "./contacts.js";
export {
  InvitationStore,
  isOpenInvitation,
  parseInvitationRecord,
  type InvitationRecord,
} from "./invitations.js";
export {
  MessageLog,
  counterpartyOf,
  newMessageRecord,
  parseSegment,
  type MessageRecord,
  type PlainMessage,
} from "./messages.js";
export { SegmentedLog, orderSegments, isSegment, newSegment, type DamagedLine, type LineParser } from "./log.js";
export {
  DeliveryLog,
  deliveryKey,
  deliveryStatusOf,
  foldDeliveries,
  type DeliveryEvent,
  type DeliveryState,
  type DeliveryStatus,
} from "./deliveries.js";
export {
  importVault,
  snapshotVault,
  type ImportOutcome,
  type VaultFiles,
} from "./transfer.js";
export { BlobStore } from "./blobs.js";
export {
  TRACE_NORMAL,
  TRACE_OFF,
  TRACE_STREAMS,
  TRACE_VERBOSE,
  TraceLog,
  isTracePath,
  isTraceStream,
  segmentTime,
  tracePolicy,
  type PruneReport,
  type StreamRetention,
  type TraceEvent,
  type TraceInput,
  type TraceLevel,
  type TracePolicy,
  type TraceStream,
} from "./trace.js";
export {
  KEY_ANCHOR,
  KEY_INVITE_PREFIX,
  KEY_MEDIATION_PREFIX,
  KEY_PAIRWISE_PREFIX,
  Vault,
  isRelationshipKey,
  mediationKeyName,
  type CreateVaultOptions,
  type MintDid,
  type MintedDid,
  type VaultOptions,
} from "./vault.js";
