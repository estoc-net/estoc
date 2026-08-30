/**
 * The vault's stores as maps in memory (event-store.md §9): the vault a
 * fold is tested on, and the far end of the round trip (§10.1). No local
 * state and no `dispose`: what a copy keeps for itself is the folder's
 * business, and nothing here outlives the process.
 */

import { MemoryBlobStore } from "./blobs.js";
import { mintDeviceId, mintInstance } from "./event.js";
import { MemoryFileStore } from "./files.js";
import { isExtId } from "./folder/layout.js";
import { MemoryEventStore } from "./memory-events.js";
import type { Stores, VaultStores } from "./vault.js";

export interface MemoryVaultOptions {
  /** the device every store appends as; minted when left out */
  self?: string;
  /** the instance every store's tokens name; minted when left out */
  instance?: string;
  clock?: () => Date;
  graceMs?: number;
}

export class MemoryVault implements VaultStores {
  readonly self: string;
  readonly instance: string;
  readonly events: MemoryEventStore;
  readonly blobs: MemoryBlobStore;
  readonly files = new MemoryFileStore();
  private readonly exts = new Map<string, Stores>();

  constructor(private readonly options: MemoryVaultOptions = {}) {
    this.self = options.self ?? mintDeviceId();
    this.instance = options.instance ?? mintInstance();
    const { events, blobs } = this.stores("vault");
    this.events = events as MemoryEventStore;
    this.blobs = blobs as MemoryBlobStore;
  }

  private stores(store: string): Stores {
    const clock = this.options.clock === undefined ? {} : { clock: this.options.clock };
    const grace = this.options.graceMs === undefined ? {} : { graceMs: this.options.graceMs };
    return {
      events: new MemoryEventStore({ self: this.self, instance: this.instance, store, ...clock }),
      blobs: new MemoryBlobStore({ ...clock, ...grace }),
    };
  }

  extension(ext: string): Stores {
    if (!isExtId(ext)) {
      throw new Error(`not an extension id: ${ext}`);
    }
    let have = this.exts.get(ext);
    if (have === undefined) {
      have = this.stores(ext);
      this.exts.set(ext, have);
    }
    return have;
  }

  /** Every `ext` holding an event or a block (§8): a handle nothing was written through is not one. */
  async extensions(): Promise<string[]> {
    const found: string[] = [];
    for (const [ext, stores] of [...this.exts].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if ((await stores.blobs.list()).length > 0) {
        found.push(ext);
        continue;
      }
      for await (const _ of stores.events.scan()) {
        found.push(ext);
        break;
      }
    }
    return found;
  }
}
