import type { VaultBackend } from "../backend/types.js";
import { BLOBS_DIR } from "./layout.js";

/**
 * `blobs/<cid>`: content-addressed bytes lifted out of messages — the
 * blocks of every object shared with us or by us (`protocol/object-share`).
 * A blob is immutable and named by what it is, so writing one that exists
 * is a no-op and two vaults merge by union (`docs/vault-format.md` §6.8).
 * Whether the bytes match the name is checked by whoever puts them here;
 * a reader that cares re-checks (signed-dir's `resolvePath` does).
 */
export class BlobStore {
  constructor(private readonly backend: VaultBackend) {}

  private pathOf(cid: string): string {
    if (!/^[a-z0-9]+$/.test(cid)) {
      throw new Error(`not a CID: ${cid}`);
    }
    return `${BLOBS_DIR}/${cid}`;
  }

  async get(cid: string): Promise<Uint8Array | null> {
    return this.backend.read(this.pathOf(cid));
  }

  async has(cid: string): Promise<boolean> {
    return (await this.get(cid)) !== null;
  }

  /** Store bytes under their CID; already there means already done. */
  async put(cid: string, bytes: Uint8Array): Promise<void> {
    if (await this.has(cid)) {
      return;
    }
    await this.backend.write(this.pathOf(cid), bytes);
  }

  /** Every CID held, unsorted. */
  async list(): Promise<string[]> {
    return this.backend.list(BLOBS_DIR);
  }
}
