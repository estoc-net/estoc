/**
 * `@estoc/event-store/v3` — the version-3 event model of
 * `docs/replica-model/event-store.md`, built beside version 2 until the
 * vault switches over: RFC 8785 canonical JSON and the strict parser
 * (§3.3), the six-field envelope and its validation (§3.4), identity,
 * time and canonical order (§4), the store interface (§5), and minting
 * — `at` from the clock, `eventId` from `uuid`'s standard UUIDv7
 * generator (§4.2); and the store in memory, the reference every other
 * store is measured against. Beside it the object model of
 * `dasl-objects.md`: raw DASL objects, the `ObjectStore` interface, the
 * read latch, and the store in memory. Portable files (§8.1) and the
 * vault itself (§10): the interfaces, the writer lock, the held view,
 * and the vault in memory. No event type.
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

export type { ByteSource, ObjectInfo, Collected, ObjectStore } from "./objects.js";
export { rawCidOf, rawCidFromDigest, compareCids, sortCids, chunksOf, hashSource, LatchRegistry } from "./objects.js";

export {
  MemoryObjectStore,
  type MemoryObjectStoreOptions,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_EXTENT_BYTES,
} from "./memory-objects.js";

export type { FileStore } from "./files.js";
export { OWNED_ROOTS, checkPath, checkFilePath, isOwnedPath, ancestorsOf, comparePaths, MemoryFileStore } from "./files.js";

export type { CommitObject, VaultEvents, VaultObjects, Vault, KeepUnderLock, Held, VaultRuntime, Stores } from "./vault.js";
export { WriterLock, Runtime, MemoryVault, type MemoryVaultOptions } from "./vault.js";

export {
  ESTOC_DIR,
  CONFIG_FILE,
  KEYSTORE_FILE,
  EVENTS_DIR,
  OBJECTS_DIR,
  IMPORT_DIR,
  LOCAL_DIR,
  REPLICA_FILE,
  isSegmentName,
  segmentPath,
  objectPath,
  authorDir,
  kindOf,
  type PathKind,
  utf8,
  text,
  prettyJson,
  concat,
} from "./folder/layout.js";
export { splitLines, acceptedLength, endsClean, decodeLine, decodeSegment, encodeLines, type Line, type Decoded, type SegmentEvent, type SegmentRead } from "./folder/lines.js";
export { DamagedReplica, mintReplica, parseReplica, encodeReplica, readReplica, openReplica, type Replica } from "./folder/replica.js";
export { FolderEventStore, ROTATE_BYTES, type FolderEventStoreOptions } from "./folder/events.js";
export { FolderObjectStore, STAGING_DIR, DAMAGED_DIR, type FolderObjectStoreOptions } from "./folder/objects.js";
export type { VaultBackend } from "../backend/types.js";
export { MemoryBackend, type MemoryBackendOptions } from "../backend/memory.js";

export { InvalidJson, InvalidEvent, ForkedAuthor, BadToken, InvalidCid, DigestMismatch, ObjectTooLarge, DamagedObject, MissingRoot, DamagedLayout } from "./errors.js";
