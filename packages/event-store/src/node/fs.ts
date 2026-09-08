import { appendFile, chmod, mkdir, open, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { segmentsOf, type Ownership, type VaultBackend } from "../backend/types.js";
import { own } from "./ownership.js";

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
 *
 * A streamed `create` goes the same way as `write` — to a sibling temp
 * file, renamed into place once the source has ended, removed when it
 * throws — and `rename` is the platform's, atomic over an existing
 * file. `open` reads through a file handle in fixed pieces, closed when
 * the stream ends or is cancelled.
 *
 * Ownership (vault-folder.md §15) is a pid file at the name given,
 * taken and kept as `./ownership.ts` says: created whole, read back,
 * live while the process it names is — a worker's record outlives the
 * worker until its process exits — or, naming this thread, while the
 * process's origin is this incarnation's; stale and reclaimed
 * otherwise, judged from the disk alone, with no advisory file lock
 * (decision 5 of the v3 plan).
 */
export interface FsBackendOptions {
  /**
   * The time a written file is stamped with, when given — what `modified`
   * then reads back from the disk; the platform's clock when left out.
   * For tests that age a file by the clock they pin.
   */
  clock?: () => Date;
}

/** How much of a file one pull of `open` reads. */
const READ_CHUNK = 64 * 1024;

export class FsBackend implements VaultBackend {
  private readonly clock: (() => Date) | null;

  constructor(
    readonly root: string,
    options: FsBackendOptions = {}
  ) {
    this.clock = options.clock ?? null;
  }

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
      if (isMissing(err) || isDirectory(err)) {
        return null;
      }
      throw err;
    }
  }

  async write(p: string, data: Uint8Array): Promise<void> {
    await this.replace(this.at(p), (tmp) => writeFile(tmp, data));
  }

  /**
   * `file` replaced by what `fill` writes to a sibling temp path: the
   * temp file takes the mode of the file it replaces, the clock's stamp
   * when there is one, and is renamed into place — or removed, when
   * `fill` throws.
   */
  private async replace(file: string, fill: (tmp: string) => Promise<void>): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fill(tmp);
      const mode = await modeOf(file);
      if (mode !== null) {
        await chmod(tmp, mode);
      }
      await this.stamp(tmp);
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** The clock's time onto `file`, when a clock was given: what `modified` reads back. */
  private async stamp(file: string): Promise<void> {
    if (this.clock === null) return;
    const now = this.clock();
    await utimes(file, now, now);
  }

  async create(p: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    await this.replace(this.at(p), async (tmp) => {
      const handle = await open(tmp, "wx");
      try {
        for await (const chunk of source) {
          // A write may take fewer bytes than offered: the rest
          // is offered again until the chunk is down, and no progress
          // at all is a failure, never a shorter file.
          let at = 0;
          while (at < chunk.length) {
            const { bytesWritten } = await handle.write(chunk.subarray(at));
            if (bytesWritten <= 0) throw new Error(`write to ${tmp} made no progress`);
            at += bytesWritten;
          }
        }
      } finally {
        await handle.close();
      }
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const target = this.at(to);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(this.at(from), target);
  }

  async open(p: string): Promise<ReadableStream<Uint8Array> | null> {
    let handle;
    try {
      handle = await open(this.at(p), "r");
    } catch (err) {
      if (isMissing(err)) {
        return null;
      }
      throw err;
    }
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      return null;
    }
    // One handle for the stream's life, closed on every way it ends:
    // the end of the file, a failed read, a cancel.
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await handle.close();
    };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const buffer = new Uint8Array(READ_CHUNK);
          const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, null);
          if (bytesRead === 0) {
            await close();
            controller.close();
            return;
          }
          controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (err) {
          await close();
          controller.error(err);
        }
      },
      cancel: () => close(),
    });
  }

  async append(p: string, data: Uint8Array): Promise<void> {
    const file = this.at(p);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, data);
    await this.stamp(file);
  }

  async remove(p: string): Promise<void> {
    await rm(this.at(p), { force: true });
  }

  async size(p: string): Promise<number | null> {
    try {
      const s = await stat(this.at(p));
      return s.isFile() ? s.size : null;
    } catch (err) {
      if (isMissing(err)) {
        return null;
      }
      throw err;
    }
  }

  async modified(p: string): Promise<number | null> {
    try {
      const s = await stat(this.at(p));
      return s.isFile() ? s.mtimeMs : null;
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

  /** The pid file at `p`, its directory made, taken by its real path so that two names of one place are one name. */
  async own(p: string): Promise<Ownership> {
    const file = this.at(p);
    await mkdir(path.dirname(file), { recursive: true });
    return own(path.join(await realpath(path.dirname(file)), path.basename(file)), p);
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

/** The path names a directory where a file was asked for. */
function isDirectory(err: unknown): boolean {
  return (err as { code?: string }).code === "EISDIR";
}
