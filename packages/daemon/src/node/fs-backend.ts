import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { segmentsOf, type VaultBackend } from "@estoc/agent-core";

/**
 * A vault in a folder on disk — the page the VaultBackend comment
 * promised. Whole-file writes go to a sibling temp file and are renamed
 * into place, which the filesystem does atomically, so a crash mid-write
 * never truncates a keystore. Appends are `appendFile`; a crash there can
 * leave a partial last line, which the log reader skips.
 *
 * Bytes come back as plain `Uint8Array` views, not Buffers: a Buffer
 * serialises itself as `{type, data}`, which is not what a wire wants.
 */
export class FsBackend implements VaultBackend {
  constructor(readonly root: string) {}

  private at(p: string): string {
    return path.join(this.root, ...segmentsOf(p));
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

function isMissing(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
