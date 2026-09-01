/**
 * @estoc/event-store — the vault as an event store (docs/event-store.md).
 *
 * The event and its envelope, canonical order, the filter; the three
 * store interfaces (events, blobs, files) and their in-memory forms; the
 * local-event shape a trace uses. No event type is known here: what an
 * event means, and the folds that read it, are `@estoc/vault`'s.
 */

export type { JsonPrimitive, JsonValue, JsonObject } from "./json.js";
export { isJsonObject, isJsonPrimitive, sameJson, jsonClean, deepFreeze, NotJson } from "./json.js";

export type {
  Cid,
  Event,
  Draft,
  Filter,
  ChangeToken,
  Conflict,
  Rejected,
  DamagedLine,
  Ingested,
  EventStore,
} from "./event.js";
export {
  isUuidv7,
  isDeviceId,
  isRfc3339Utc,
  atKey,
  compareEvents,
  mintDeviceId,
  mintInstance,
  EidMinter,
  validateEvent,
  cleanDraft,
  matches,
  matchesData,
} from "./event.js";

export { InvalidEvent, ForkedSelf, BadToken, BadBlock, NotAFile, Disposed, NotAVault, NotSameVault } from "./errors.js";

export { MemoryEventStore, type MemoryEventStoreOptions } from "./memory-events.js";
export type { Stores, VaultStores, Vault } from "./vault.js";
export { MemoryVault, type MemoryVaultOptions } from "./memory-vault.js";

export { RAW_CODE, DAG_PB_CODE, parseCid, isCid, nameOf } from "./cid.js";
export {
  PROFILE,
  MAX_RAW_BYTES,
  checkBlock,
  decodeNode,
  linksOf,
  hashFile,
  readFile,
  reach,
  reachable,
  type Reach,
  type GetBlock,
  type Node,
  type HashedFile,
} from "./blocks.js";
export { DEFAULT_GRACE_MS, MemoryBlobStore, type BlobStore, type Collected, type MemoryBlobStoreOptions } from "./blobs.js";

export { checkPath, MemoryFileStore, type FileStore } from "./files.js";

export { compareLocalEvents, isLocalEvent, matchesLocal, type LocalEvent, type LocalFilter, type LocalEventStore } from "./local.js";

// ---- the folder (vault-folder.md) ---------------------------------------

export { walk, segmentsOf, type VaultBackend } from "./backend/types.js";
export { MemoryBackend, type MemoryBackendOptions } from "./backend/memory.js";
export { OpfsBackend } from "./backend/opfs.js";
export {
  ESTOC_DIR,
  CONFIG_FILE,
  KEYSTORE_FILE,
  DEVICES_DIR,
  BLOBS_DIR,
  EXTENSIONS_DIR,
  LOCAL_DIR,
  SELF_FILE,
  isSegmentName,
  isExtId,
  kindOf,
  type PathKind,
} from "./folder/layout.js";
export { decodeEvent, splitLines } from "./folder/lines.js";
export { FolderEventStore, ROTATE_BYTES } from "./folder/events.js";
export { FolderBlobStore } from "./folder/blobs.js";
export { FolderFileStore } from "./folder/files.js";
export {
  FolderLocalEventStore,
  LocalOwner,
  DEFAULT_ROTATION,
  segmentTime,
  type RetentionPolicy,
  type PruneReport,
  type Rotation,
  type FolderLocalEventStoreOptions,
  type LocalCache,
} from "./folder/local.js";
export { folderStore, type FolderStore, type FolderStoreOptions } from "./folder/store.js";
export { FORMAT, VERSION, readConfig } from "./folder/config.js";
export { FolderVault, DEVICE_MINTED, type ExtensionStore, type OpenVaultOptions } from "./folder/vault.js";

// ---- interchange (event-store.md §10) -------------------------------------

export {
  CONFIG_PATH,
  isSnapshotPath,
  snapshot,
  exportVault,
  importVault,
  restoreFolder,
  type VaultFiles,
  type ExportOptions,
  type ImportPolicy,
  type Imported,
} from "./interchange.js";
export { zipFiles, filesFromZip } from "./zip.js";
