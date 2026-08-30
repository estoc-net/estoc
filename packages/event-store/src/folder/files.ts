/**
 * The vault's files over a folder (vault-folder.md §9.6): every path
 * under `.estoc/` that is not a segment, a blob, or `local/`, by the
 * shape of the path. Paths are relative to `.estoc/`.
 */

import type { VaultBackend } from "../backend/types.js";
import { walk } from "../backend/types.js";
import { checkPath, type FileStore } from "../files.js";
import { kindOf } from "./layout.js";

export class FolderFileStore implements FileStore {
  constructor(
    private readonly backend: VaultBackend,
    private readonly base: string
  ) {}

  /** A path this store may hold: relative, and shaped like a file, not a segment, a blob or `local/`. */
  private at(path: string): string {
    checkPath(path);
    const kind = kindOf(path);
    if (kind !== "file") {
      throw new Error(`not a file path (${kind}): ${path}`);
    }
    return `${this.base}/${path}`;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.backend.read(this.at(path));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    return this.backend.write(this.at(path), bytes);
  }

  async list(): Promise<string[]> {
    const prefix = `${this.base}/`;
    return (await walk(this.backend, this.base))
      .map((path) => path.slice(prefix.length))
      .filter((path) => kindOf(path) === "file");
  }
}
