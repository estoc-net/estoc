import { appendFile, chmod, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { VaultOwned, segmentsOf, type Ownership, type VaultBackend } from "../backend/types.js";

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

/** The pid files this process holds right now, by absolute path. */
const owned = new Set<string>();

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
          // A write may take fewer bytes than offered (r1-A): the rest
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

  /**
   * The pid file at `p`, taken exclusively (`wx`); a live holder is
   * `VaultOwned`, a dead one is cleared and the take tried again. Two
   * takers clearing the same stale file race on the `wx` and one loses
   * to the other's live pid, which is the right answer.
   */
  async own(p: string): Promise<Ownership> {
    const file = this.at(p);
    if (owned.has(file)) throw new VaultOwned(p, "this process holds it already");
    for (;;) {
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await writeFile(file, `${process.pid}\n`, { flag: "wx" });
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
      }
      const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) throw new VaultOwned(p, `process ${pid} holds it`);
      await rm(file, { force: true }); // stale: whoever wrote it is gone, or was this process before it restarted
    }
    owned.add(file);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        owned.delete(file);
        await rm(file, { force: true });
      },
    };
  }
}

/** Whether a process with this pid exists: signal 0 reaches it, or is refused for being someone else's. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
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
