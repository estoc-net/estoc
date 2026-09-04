/**
 * The blob store over a folder (vault-folder.md §8): one file per block
 * under `blobs/<cid>`, flat; a block's age is its file's modification
 * time; a block found damaged is moved aside and is absent from then on.
 */

import type { BlobStore, Collected } from "../blobs.js";
import { DEFAULT_GRACE_MS } from "../blobs.js";
import { checkBlock, hashFile, readFile, reachable } from "../blocks.js";
import { isCid } from "../cid.js";
import { BLOBS_DIR } from "./layout.js";
import type { StoreContext } from "./serial.js";

export class FolderBlobStore implements BlobStore {
  constructor(
    private readonly ctx: StoreContext,
    private readonly graceMs: number = DEFAULT_GRACE_MS
  ) {}

  private get dir(): string {
    return `${this.ctx.base}/${BLOBS_DIR}`;
  }

  private path(cid: string): string {
    return `${this.dir}/${cid}`;
  }

  /**
   * A block's bytes as the file holds them, checked against the name
   * (§8): a file that is not its name's block is moved aside, out of
   * `blobs/`, and reads as absent.
   */
  private async readBlock(cid: string): Promise<Uint8Array | null> {
    if (!isCid(cid)) {
      return null;
    }
    const bytes = await this.ctx.backend.read(this.path(cid));
    if (bytes === null) {
      return null;
    }
    try {
      await checkBlock(cid, bytes);
    } catch {
      await this.ctx.backend.write(`${this.ctx.aside}/${cid}`, bytes);
      await this.ctx.backend.remove(this.path(cid));
      return null;
    }
    return bytes;
  }

  async put(bytes: Uint8Array): Promise<string> {
    this.ctx.guard();
    // Copy before the first await: the block kept is the input itself.
    const { root, blocks } = await hashFile(bytes.slice());
    return this.ctx.serial.run(async () => {
      this.ctx.alive();
      // one raw block; a block already here is rewritten so its time is renewed (§8)
      for (const [cid, block] of blocks) {
        await this.ctx.backend.write(this.path(cid), block);
      }
      return root;
    });
  }

  async get(root: string): Promise<Uint8Array | null> {
    this.ctx.guard();
    return this.ctx.serial.run(() => {
      this.ctx.alive();
      return readFile(root, (cid) => this.readBlock(cid));
    });
  }

  async putBlock(cid: string, bytes: Uint8Array): Promise<void> {
    this.ctx.guard();
    const own = bytes.slice();
    await checkBlock(cid, own);
    return this.ctx.serial.run(async () => {
      this.ctx.alive();
      await this.ctx.backend.write(this.path(cid), own);
    });
  }

  async getBlock(cid: string): Promise<Uint8Array | null> {
    this.ctx.guard();
    return this.ctx.serial.run(() => {
      this.ctx.alive();
      return this.readBlock(cid);
    });
  }

  async has(cid: string): Promise<boolean> {
    this.ctx.guard();
    return this.ctx.serial.run(async () => {
      this.ctx.alive();
      return isCid(cid) && (await this.ctx.backend.size(this.path(cid))) !== null;
    });
  }

  async list(): Promise<string[]> {
    this.ctx.guard();
    return this.ctx.serial.run(async () => {
      this.ctx.alive();
      return (await this.ctx.backend.list(this.dir)).filter(isCid).sort();
    });
  }

  async collect(keep: string[]): Promise<Collected> {
    this.ctx.guard();
    return this.ctx.serial.run(async () => {
      this.ctx.alive();
      const kept = await reachable(keep, (cid) => this.readBlock(cid));
      const now = this.ctx.clock().getTime();
      const out: Collected = { unlinked: [], young: [] };
      for (const cid of (await this.ctx.backend.list(this.dir)).filter(isCid).sort()) {
        if (kept.has(cid)) {
          continue;
        }
        const written = await this.ctx.backend.modified(this.path(cid));
        if (written === null) {
          continue;
        }
        if (now - written >= this.graceMs) {
          await this.ctx.backend.remove(this.path(cid));
          out.unlinked.push(cid);
        } else {
          out.young.push(cid);
        }
      }
      return out;
    });
  }
}
