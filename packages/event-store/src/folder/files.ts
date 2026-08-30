/**
 * The vault's files over a folder (vault-folder.md §9.6): every path
 * under `.estoc/` that is not a segment, a blob, or `local/`, by the
 * shape of the path. Paths are relative to `.estoc/`.
 */

import type { VaultBackend } from "../backend/types.js";
import { walk } from "../backend/types.js";
import { ancestorsOf, checkFilePath, type FileStore } from "../files.js";
import { kindOf } from "./layout.js";

export class FolderFileStore implements FileStore {
  constructor(
    private readonly backend: VaultBackend,
    private readonly base: string
  ) {}

  /** A path this store may hold: a file's (`checkFilePath`), under the base. */
  private at(path: string): string {
    return `${this.base}/${checkFilePath(path)}`;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.backend.read(this.at(path));
  }

  /** Refuses a path that with what the folder holds would be a file and a directory of one name (§9.6). */
  async write(path: string, bytes: Uint8Array): Promise<void> {
    const full = this.at(path);
    for (const ancestor of ancestorsOf(path)) {
      if ((await this.backend.size(`${this.base}/${ancestor}`)) !== null) {
        throw new Error(`${ancestor} is a file: cannot write ${path}`);
      }
    }
    if ((await this.backend.list(full)).length > 0 || (await this.backend.dirs(full)).length > 0) {
      throw new Error(`${path} is a directory: cannot write it as a file`);
    }
    return this.backend.write(full, bytes);
  }

  async list(): Promise<string[]> {
    const prefix = `${this.base}/`;
    return (await walk(this.backend, this.base))
      .map((path) => path.slice(prefix.length))
      .filter((path) => kindOf(path) === "file");
  }
}
