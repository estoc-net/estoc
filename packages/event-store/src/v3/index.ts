/**
 * `@estoc/event-store/v3` — the version-3 event model of the replica
 * model, built beside version 2 until the vault switches over: RFC 8785
 * canonical JSON and the strict parser, the six-field envelope and its
 * validation, identity, time and canonical order, the store interface,
 * and minting — `at` from the clock, `eventId` from `uuid`'s standard
 * UUIDv7 generator; and the store in memory, the reference every other
 * store is measured against. Beside it the object model: raw DASL
 * objects, the `ObjectStore` interface, and the store in memory. Over
 * both the vault: its metadata and keystore, the interfaces, the writer
 * lock, the held view, and the vault in memory. Under it the SQLite
 * driver the persistent stores are written against — the contract and
 * the shared connection; the adapters live under `../node` and
 * `../browser` — and over it the vault's schema and how a database is
 * created, opened and checked before anything in it is trusted, and
 * the event store over that runtime. The object store comes next, and
 * with it the SQLite vault, export, restore and import. No event type.
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
export { rawCidOf, rawCidFromDigest, compareCids, sortCids, chunksOf, hashSource } from "./objects.js";

export { MemoryObjectStore, MemoryPreparation, type MemoryObjectStoreOptions, DEFAULT_MAX_OBJECT_BYTES, DEFAULT_EXTENT_BYTES } from "./memory-objects.js";

export type { VaultMetadata, WrappedSeed, KeystoreAccess } from "./keystore.js";
export { checkMetadata, checkWrappedSeed } from "./keystore.js";

export type { CommitObject, VaultEvents, VaultObjects, Vault, KeepUnderLock, Held, VaultRuntime, Stores, RuntimeOptions } from "./vault.js";
export { WriterLock, Runtime, MemoryVault, type MemoryVaultOptions } from "./vault.js";

export type { SqlValue, SqlRow, TransactionMode, OpenMode, SqliteStatement, SqliteDriver, RawConnection, RawStatement } from "./sqlite/driver.js";
export { Connection, checkParams, decodeText, exactInteger, ownBytes } from "./sqlite/driver.js";

export { APPLICATION_ID, SCHEMA_VERSION, createTables, checkSchema, type DatabaseKind } from "./sqlite/schema.js";

export type { Locked, RuntimeDatabase, PortableDatabase, CreateRuntimeOptions, OpenRuntimeOptions } from "./sqlite/open.js";
export { createRuntime, openRuntime, openInspector, openPortable } from "./sqlite/open.js";

export { SqliteEventStore, type SqliteEventStoreOptions, type EventStoreDatabase } from "./sqlite/events.js";

export {
  InvalidJson,
  InvalidEvent,
  ForkedAuthor,
  BadToken,
  InvalidCid,
  DigestMismatch,
  ObjectTooLarge,
  DamagedObject,
  MissingRoot,
  UnreferencedObject,
  UnsupportedOperation,
  InvalidSqlValue,
  SqliteError,
  DatabaseBusy,
  DatabaseExists,
  DatabaseMissing,
  DatabaseClosed,
  NotAVault,
  DamagedControl,
  AnchorMismatch,
  ReadOnlyVault,
  VaultClosed,
  IncompleteSnapshot,
  InvalidSnapshot,
  IncompleteImport,
} from "./errors.js";
