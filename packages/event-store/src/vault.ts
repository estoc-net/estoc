/**
 * The vault, to a program (event-store.md §9): its own three stores, a
 * store per extension, and `dispose`. The folder implements it
 * (`folder/vault.ts`); a map in memory implements the stores
 * (`memory-vault.ts`); export and import loop over them (§10).
 */

import type { BlobStore } from "./blobs.js";
import type { EventStore } from "./event.js";
import type { FileStore } from "./files.js";

/** An extension's two stores (§8): the vault's shape again, less files. */
export interface Stores {
  events: EventStore;
  blobs: BlobStore;
}

/** What export reads and import writes (§10): the stores, and the map from `ext` to an extension's. */
export interface VaultStores {
  events: EventStore;
  blobs: BlobStore;
  files: FileStore;
  /** A handle; bytes exist from the first write; rejects an `ext` this instance disposed of. */
  extension(ext: string): Stores;
  /** Every `ext` with bytes. */
  extensions(): Promise<string[]>;
}

export interface Vault extends VaultStores {
  /** Store and local state, whole; every handle dead (§8). */
  dispose(ext: string): Promise<void>;
}
