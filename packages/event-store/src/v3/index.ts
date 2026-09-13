/**
 * `@estoc/event-store/v3` — the version-3 replica model as a library:
 * canonical JSON, the event envelope and its store, raw DASL objects
 * and theirs, the vault over both, and, for what persists, the SQLite
 * driver contract, the runtime's schema, opening, stores, local
 * state and vault, and the portable snapshot's export, validation,
 * reader, restore and import. The platform adapters live under `../node` and
 * `../browser`. No event type is defined here.
 */

export type { JsonPrimitive, JsonValue, JsonObject } from "./json.js";
export { isJsonObject, isJsonPrimitive, deepFreeze } from "./json.js";

export { canonicalize, canonicalText, parseStrict, forbiddenIn, compareCodeUnits, MAX_DEPTH } from "./jcs.js";

export type {
  Cid,
  EventId,
  AuthorId,
  Event,
  Draft,
  Filter,
  ChangeToken,
  Conflict,
  EventTally,
  Rejected,
  Damaged,
  Ingested,
  EventStore,
} from "./event.js";
export {
  isUuidv7,
  isEventId,
  isAuthorId,
  isRawCid,
  timestampOf,
  isCanonicalAt,
  atOf,
  MAX_T,
  validateEvent,
  validateDraft,
  canonicalEvent,
  canonicalEventBytes,
  compareEvents,
  matches,
  matchesData,
} from "./event.js";

export { mint, type Minted } from "./mint.js";

export { MemoryEventStore, type MemoryEventStoreOptions } from "./memory-events.js";

export type { ByteSource, ObjectInfo, Collected, ObjectStore, Preparation } from "./objects.js";
export { rawCidOf, rawCidFromDigest, compareCids, sortCids, chunksOf, hashSource, Packer } from "./objects.js";

export { MemoryObjectStore, MemoryPreparation, type MemoryObjectStoreOptions, DEFAULT_MAX_OBJECT_BYTES, DEFAULT_EXTENT_BYTES } from "./memory-objects.js";

export type { VaultMetadata, WrappedSeed, KeystoreAccess } from "./keystore.js";
export { checkMetadata, checkWrappedSeed } from "./keystore.js";

export type { CommitObject, VaultEvents, VaultObjects, Vault, KeepUnderLock, HeldRoots, Retained, RetainedRoots, Stage, Held, VaultRuntime, Stores, RuntimeOptions } from "./vault.js";
export { WriterLock, Runtime, MemoryVault, heldRootsOf, type MemoryVaultOptions } from "./vault.js";

export type { SqlValue, SqlRow, TransactionMode, OpenMode, SqliteStatement, SqliteDriver, RawConnection, RawStatement } from "./sqlite/driver.js";
export { Connection, checkParams, decodeText, decodeUtf8, exactInteger, ownBytes } from "./sqlite/driver.js";

export { APPLICATION_ID, SCHEMA_VERSION, createTables, checkSchema, type DatabaseKind } from "./sqlite/schema.js";

export type { Locked, RuntimeDatabase, PortableDatabase, CreateRuntimeOptions, OpenRuntimeOptions } from "./sqlite/open.js";
export { createRuntime, publishedRuntime, openRuntime, openInspector, openPortable, type OpenPortableOptions } from "./sqlite/open.js";

export { SqliteEventStore, type SqliteEventStoreOptions, type EventStoreDatabase } from "./sqlite/events.js";

export { SqliteObjectStore, SqlitePreparation, CHUNK_BYTES, type SqliteObjectStoreOptions, type ObjectStoreDatabase } from "./sqlite/objects.js";

export type { LocalOptions, LocalCache, LocalTrace, LocalState, TraceEntry, TraceFilter, TracePolicy } from "./sqlite/local.js";

export { SqliteVault, type SqliteVaultOptions } from "./sqlite/vault.js";

export { PortableVault, validatePortable, type ValidateOptions, type Validated } from "./sqlite/portable.js";

export { exportVault, type OpenDestination, type ExportOptions, type Exported } from "./sqlite/export.js";

export { restoreVault, type RestoreOptions, type Restored } from "./sqlite/restore.js";

export { importVault, type ImportOptions, type Imported } from "./sqlite/import.js";

export {
  InvalidJson,
  InvalidEvent,
  ForkedAuthor,
  BadToken,
  InvalidCid,
  DigestMismatch,
  ObjectTooLarge,
  DamagedObject,
  InterruptedRead,
  StagingFull,
  MissingRoot,
  UnreferencedObject,
  UnsupportedOperation,
  InvalidSqlValue,
  SqliteError,
  DatabaseBusy,
  DatabaseExists,
  DatabaseMissing,
  DatabaseClosed,
  UncertainCommit,
  NotAVault,
  DamagedControl,
  DamagedHistory,
  AnchorMismatch,
  ReadOnlyVault,
  VaultClosed,
  IncompleteSnapshot,
  SnapshotTooLarge,
  InvalidSnapshot,
  IncompleteImport,
} from "./errors.js";
