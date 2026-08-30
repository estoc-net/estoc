import { appendFile, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { segmentsOf, type VaultBackend } from "../backend/types.js";

/**
 * A vault in a folder on disk. Whole-file writes go to a sibling temp file
 * and are renamed into place, which the filesystem does atomically, so a
 * crash mid-write never truncates a keystore; the rename also gives the
 * file a fresh modification time, which is what a blob rewrite is for. A
 * replaced file keeps its mode (a keystore the CLI made 0600 stays 0600
 * across rewrites). Appends are `appendFile`, which does not `fsync`; a
 * crash there can leave a partial last line, which the folder store
 * reports and heals.
 *
 * Bytes come back as plain `Uint8Array` views, not Buffers: a Buffer
 * serialises itself as `{type, data}`, which is not what a wire wants.
 */
export class FsBackend implements VaultBackend {
  constructor(readonly root: string) {}

  /** The file `p` names, checked once more to lie under the root whatever the platform made of the segments. */
  private at(p: string): string {
    const file = path.join(this.root, ...segmentsOf(p));
    const rel = path.relative(this.root, file);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`path escapes the vault root: ${JSON.stringify(p)}`);
    }
    return file;
  }

  async read(p: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.at(p));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if (isMissing(err)) {
        return null;
      }
      throw err;
    }
  }

  async write(p: string, data: Uint8Array): Promise<void> {
    const file = this.at(p);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, data);
      const mode = await modeOf(file);
      if (mode !== null) {
        await chmod(tmp, mode);
      }
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async append(p: string, data: Uint8Array): Promise<void> {
    const file = this.at(p);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, data);
  }

  async remove(p: string): Promise<void> {
    await rm(this.at(p), { force: true });
  }

  async size(p: string): Promise<number | null> {
    try {
      return (await stat(this.at(p))).size;
    } catch (err) {
      if (isMissing(err)) {
        return null;
      }
      throw err;
    }
  }

  async modified(p: string): Promise<number | null> {
    try {
      return (await stat(this.at(p))).mtimeMs;
    } catch (err) {
      if (isMissing(err)) {
        return null;
      }
      throw err;
    }
  }

  list(dir: string): Promise<string[]> {
    return this.entries(dir, "file");
  }

  dirs(dir: string): Promise<string[]> {
    return this.entries(dir, "directory");
  }

  private async entries(dir: string, kind: "file" | "directory"): Promise<string[]> {
    try {
      const all = await readdir(this.at(dir), { withFileTypes: true });
      return all.filter((e) => (kind === "file" ? e.isFile() : e.isDirectory())).map((e) => e.name);
    } catch (err) {
      if (isMissing(err)) {
        return [];
      }
      throw err;
    }
  }
}

async function modeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mode & 0o777;
  } catch (err) {
    if (isMissing(err)) {
      return null;
    }
    throw err;
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
