/**
 * The portable files over a folder: what `FileStore` reaches, by the
 * shape of the path — `config.json`, `keystore.json` and every opaque
 * portable path; never a segment, an object, or anything under `local/`
 * or `import/`. Reads reach the two singletons; writes reach only
 * opaque paths, whole, and refuse a path that would make one name both
 * a file and a directory. Paths are relative to the layout's directory.
 */

import type { VaultBackend } from "../../backend/types.js";
import { walk } from "../../backend/types.js";
import { ancestorsOf, checkFilePath, checkPath, comparePaths, type FileStore } from "../files.js";
import { WriterLock } from "../vault.js";
import { ESTOC_DIR, kindOf } from "./layout.js";

/** The kinds of path a file store reaches. */
const PORTABLE = new Set(["config", "keystore", "opaque"]);

export class FolderFileStore implements FileStore {
  private readonly base: string;
  /** writes one at a time: the check of the tree and the write it admits, with nothing between */
  private readonly serial = new WriterLock();

  constructor(
    private readonly backend: VaultBackend,
    base = ESTOC_DIR
  ) {
    this.base = base;
  }

  /** A path this store reads: conforming, and a portable file's by shape. */
  private readable(path: string): string {
    checkPath(path);
    if (!PORTABLE.has(kindOf(path))) throw new Error(`not a portable file path: ${path}`);
    return `${this.base}/${path}`;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.backend.read(this.readable(path));
  }

  /** An opaque portable path only; refused when it or an ancestor is taken by the other kind of entry. */
  async write(path: string, bytes: Uint8Array): Promise<void> {
    checkFilePath(path);
    if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes is a Uint8Array");
    const full = `${this.base}/${path}`;
    return this.serial.run(async () => {
      for (const ancestor of ancestorsOf(path)) {
        if ((await this.backend.size(`${this.base}/${ancestor}`)) !== null) throw new Error(`${ancestor} is a file: cannot write ${path}`);
      }
      if ((await this.backend.list(full)).length > 0 || (await this.backend.dirs(full)).length > 0) {
        throw new Error(`${path} is a directory: cannot write it as a file`);
      }
      await this.backend.write(full, bytes);
    });
  }

  /** `config.json`, `keystore.json` and every opaque portable file, in code-point order; nothing structural, nothing local. */
  async list(): Promise<string[]> {
    const prefix = `${this.base}/`;
    return (await walk(this.backend, this.base))
      .map((path) => path.slice(prefix.length))
      .filter((path) => PORTABLE.has(kindOf(path)))
      .sort(comparePaths);
  }
}
