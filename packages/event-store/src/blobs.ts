/**
 * The blob store (event-store.md §5): a block store of the profile, and
 * its in-memory form.
 */

import { checkBlock, hashFile, readFile, reachable } from "./blocks.js";
import type { Cid } from "./event.js";

export interface BlobStore {
  // files — what an event's `body` and `attachments` name
  /** Hashes by the profile; returns the file's root. A caller cannot misname bytes. */
  put(bytes: Uint8Array): Promise<Cid>;
  /** The file's bytes, chunks rejoined; null if the root or any chunk is absent; throws on a node that is not a file. */
  get(root: Cid): Promise<Uint8Array | null>;
  // blocks — what the profile's trees are made of
  /** Checked against `cid` (§5.1); the only way in for a block minted elsewhere. */
  putBlock(cid: Cid, bytes: Uint8Array): Promise<void>;
  getBlock(cid: Cid): Promise<Uint8Array | null>;
  has(cid: Cid): Promise<boolean>;
  list(): Promise<Cid[]>;
  // removal — the only way bytes leave a store; serialised with everything above
  /** Unlinks every block no root in `keep` reaches that is older than the store's grace. */
  collect(keep: Cid[]): Promise<Collected>;
}

/** `young`: unreferenced but too recent to touch; the next collection sees them again. */
export interface Collected {
  unlinked: Cid[];
  young: Cid[];
}

/**
 * How old an unreferenced block must be before `collect` takes it (§5.3):
 * generous, because the write it may belong to is bounded by a process,
 * not a clock.
 */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000;

export interface MemoryBlobStoreOptions {
  clock?: () => Date;
  graceMs?: number;
}

interface Held {
  bytes: Uint8Array;
  /** when this copy last wrote the block (§5.3) */
  written: number;
}

export class MemoryBlobStore implements BlobStore {
  private readonly blocks = new Map<string, Held>();
  private readonly clock: () => Date;
  private readonly graceMs: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryBlobStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  }

  private serialise<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Store a block, or renew its write time if held: the clock moves either
   * way (§5.3). `bytes` must already be the store's own copy.
   */
  private hold(cid: string, bytes: Uint8Array): void {
    const have = this.blocks.get(cid);
    this.blocks.set(cid, { bytes: have?.bytes ?? bytes, written: this.clock().getTime() });
  }

  async put(bytes: Uint8Array): Promise<string> {
    // Copy before the first await: the chunks the hasher yields are views
    // of its input, and a caller may reuse the buffer once the call returns.
    const { root, blocks } = await hashFile(bytes.slice());
    return this.serialise(() => {
      for (const [cid, block] of blocks) {
        this.hold(cid, block);
      }
      return root;
    });
  }

  get(root: string): Promise<Uint8Array | null> {
    return this.serialise(() => readFile(root, async (cid) => this.blocks.get(cid)?.bytes ?? null));
  }

  async putBlock(cid: string, bytes: Uint8Array): Promise<void> {
    // One copy, taken before the first await, is what is checked and what is kept.
    const own = bytes.slice();
    await checkBlock(cid, own);
    return this.serialise(() => {
      this.hold(cid, own);
    });
  }

  getBlock(cid: string): Promise<Uint8Array | null> {
    return this.serialise(() => this.blocks.get(cid)?.bytes.slice() ?? null);
  }

  has(cid: string): Promise<boolean> {
    return this.serialise(() => this.blocks.has(cid));
  }

  list(): Promise<string[]> {
    return this.serialise(() => [...this.blocks.keys()].sort());
  }

  collect(keep: string[]): Promise<Collected> {
    return this.serialise(async () => {
      const kept = await reachable(keep, async (cid) => this.blocks.get(cid)?.bytes ?? null);
      const now = this.clock().getTime();
      const out: Collected = { unlinked: [], young: [] };
      for (const [cid, held] of [...this.blocks].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (kept.has(cid)) {
          continue;
        }
        if (now - held.written >= this.graceMs) {
          this.blocks.delete(cid);
          out.unlinked.push(cid);
        } else {
          out.young.push(cid);
        }
      }
      return out;
    });
  }
}
