/**
 * One folder store — the vault's, or an extension's — over a backend
 * (vault-folder.md §9): its event store and blob store, sharing one
 * serialisation. What `FolderVault` opens per store; also what a test,
 * or an export that renders into a backend, opens without a vault.
 */

import type { VaultBackend } from "../backend/types.js";
import { DEFAULT_GRACE_MS } from "../blobs.js";
import { EidMinter, mintDeviceId, mintInstance } from "../event.js";
import { FolderBlobStore } from "./blobs.js";
import { FolderEventStore, ROTATE_BYTES } from "./events.js";
import { BLOBS_DIR, ESTOC_DIR, LOCAL_DIR } from "./layout.js";
import { Serial, type StoreContext } from "./serial.js";

export interface FolderStoreOptions {
  /** the store's directory, relative to the vault root; `.estoc` when left out */
  base?: string;
  /** where a damaged block is moved aside to (§8); `.estoc/local/damaged/blobs` when left out */
  aside?: string;
  /** the device this store appends as; minted when left out */
  self?: string;
  /** the instance its tokens name; minted when left out */
  instance?: string;
  /** which store of the instance this is; `vault` when left out */
  store?: string;
  clock?: () => Date;
  graceMs?: number;
  /** the writer's own rotation (§5); `ROTATE_BYTES` when left out */
  rotateBytes?: number;
  /** throws once `dispose` has been called on the store (§3.1) */
  guard?: () => void;
  /** throws once the disposal has run in the store's chain */
  alive?: () => void;
}

export interface FolderStore {
  events: FolderEventStore;
  blobs: FolderBlobStore;
  /** the store's serialisation, for whoever must run after everything in flight (`dispose`) */
  serial: Serial;
}

export function folderStore(backend: VaultBackend, options: FolderStoreOptions = {}): FolderStore {
  const ctx: StoreContext = {
    backend,
    base: options.base ?? ESTOC_DIR,
    aside: options.aside ?? `${ESTOC_DIR}/${LOCAL_DIR}/damaged/${BLOBS_DIR}`,
    self: options.self ?? mintDeviceId(),
    instance: options.instance ?? mintInstance(),
    store: options.store ?? "vault",
    clock: options.clock ?? (() => new Date()),
    serial: new Serial(),
    segments: new EidMinter(),
    guard: options.guard ?? (() => undefined),
    alive: options.alive ?? (() => undefined),
    rotateBytes: options.rotateBytes ?? ROTATE_BYTES,
    generation: 0,
  };
  return { events: new FolderEventStore(ctx), blobs: new FolderBlobStore(ctx, options.graceMs ?? DEFAULT_GRACE_MS), serial: ctx.serial };
}
