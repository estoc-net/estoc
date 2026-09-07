import { appendFile, chmod, link, mkdir, open, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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
 *
 * Ownership (vault-folder.md §15) is a pid file at the name given,
 * holding `<pid> <token>`: created whole and atomically — written to a
 * claim file and hard-linked into place, so no taker ever sees an
 * empty file of this backend's making (r1-G) — then read back, since
 * the name may have changed hands meanwhile. A file naming a live
 * process refuses the taker at once. One naming a process that is
 * gone, or that cannot be read as a holder at all — empty, garbage —
 * is stale (r1-G) and is reclaimed by moving it aside under a marker
 * naming the reclaimer, checking that what moved is exactly the stale
 * file seen (r1-A), and only then removing it and taking the free name;
 * a live holder moved by mistake — one that took the name between the
 * look and the move — is linked back, and a taker that finds a marker
 * beside the name it just took gives the name up and tries again, so
 * the moved holder has its name back before anyone keeps it. A marker
 * or claim left by a reclaimer or taker that died is swept by the next
 * taker. This process keeps the names it holds or is taking, checked
 * and recorded in one synchronous step, so two takes in one process
 * cannot both pass (r1-A); a file naming this process without that
 * record is a previous incarnation's, stale. Release removes the file
 * only while it still holds this taker's own line. The pid is read for
 * liveness only, never as an identity (ES-15). There is no advisory
 * file lock (decision 5 of the v3 plan), and the protocol above is what
 * `O_EXCL`, `link` and `rename` can promise without one.
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

/** The pid files this process holds or is taking right now, by real path. */
const claimed = new Set<string>();

/** How many times a take is retried around reclaims and back-offs before it gives up. */
const ATTEMPTS = 200;
/** One holder's line: a positive pid and this take's token. */
const HOLDER = /^([1-9][0-9]{0,9}) ([0-9a-f]{16})\n?$/;
/** A marker's or claim's name beside the pid file: `<pid file>.<kind>.<pid>.<token>`. */
const SIDECAR = /^(reclaim|claim)\.([1-9][0-9]{0,9})\.([0-9a-f]{16})$/;

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
   * The pid file at `p`, taken as the class comment says: recorded in
   * this process first, then created whole, read back, and kept only
   * when no reclaim is in flight beside it; a live holder is
   * `VaultOwned`, a stale one is reclaimed and the take tried again.
   */
  async own(p: string): Promise<Ownership> {
    const file = this.at(p);
    await mkdir(path.dirname(file), { recursive: true });
    const real = path.join(await realpath(path.dirname(file)), path.basename(file));
    // Check and record in one synchronous step: nothing awaited between them (r1-A).
    if (claimed.has(real)) throw new VaultOwned(p, "this process holds it already");
    claimed.add(real);
    try {
      const token = randomBytes(8).toString("hex");
      const line = `${process.pid} ${token}\n`;
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        await sweep(real);
        if (await take(real, line, token)) {
          // Taken; but a reclaim in flight beside it may be about to give the name back to a holder it moved (r1-A): give it up and look again.
          if (await reclaiming(real)) {
            await unlinkIf(real, line);
            await sleep(backoff(attempt));
            continue;
          }
          if ((await readHolder(real)) !== line) continue; // gone or changed hands between the take and the look: try again
          return held(real, line);
        }
        const holder = await readHolder(real);
        if (holder === null) continue; // absent now: take it
        const pid = pidOf(holder);
        if (pid !== null && pid !== process.pid && alive(pid)) throw new VaultOwned(p, `process ${pid} holds it`);
        // Stale: dead, unreadable, or this process before it restarted (this process holds no record of it). Reclaim (r1-A).
        await reclaim(real, holder, token);
        await sleep(backoff(attempt));
      }
      throw new VaultOwned(p, "could not settle who holds it");
    } catch (err) {
      claimed.delete(real);
      throw err;
    }
  }
}

/** The ownership of a take that succeeded: released by removing the file, only while it is still this take's (r1-A), and by forgetting the record. */
function held(real: string, line: string): Ownership {
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await unlinkIf(real, line);
      } finally {
        claimed.delete(real);
      }
    },
  };
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number): number {
  return Math.min(2 + attempt * 2, 50);
}

/** The pid a holder's line names, or null when the line is not a holder's — empty, garbage, another format (r1-G). */
function pidOf(line: string): number | null {
  const m = HOLDER.exec(line);
  return m === null ? null : Number(m[1]);
}

/** The pid file's text, or null when there is none. Decoded loosely: garbage is a holder's line no more than empty is. */
async function readHolder(real: string): Promise<string | null> {
  try {
    return (await readFile(real)).toString("utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function noLinks(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EINVAL";
}

/**
 * Create the pid file whole at `real` with `line`, only if absent: written
 * to a claim file beside it and hard-linked into place, the claim then
 * removed. Where the file system has no hard links, an exclusive create
 * and a write — the window between them is this taker's own to lose,
 * since an empty file reads as stale and a reclaimed take fails its
 * read-back. True when the name was taken now, false when something
 * stood there.
 */
async function take(real: string, line: string, token: string): Promise<boolean> {
  const claim = `${real}.claim.${process.pid}.${token}`;
  await writeFile(claim, line, { flag: "wx" });
  try {
    await link(claim, real);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") return false;
    if (!noLinks(err)) throw err;
  } finally {
    await rm(claim, { force: true });
  }
  try {
    await writeFile(real, line, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Move the stale file at `real` aside under a marker naming this
 * reclaimer, and remove it only if what moved is exactly the stale
 * `seen`; a holder that took the name meanwhile is given it back
 * (r1-A).
 */
async function reclaim(real: string, seen: string, token: string): Promise<void> {
  const marker = `${real}.reclaim.${process.pid}.${token}`;
  try {
    await rename(real, marker);
  } catch (err) {
    if (isMissing(err)) return; // someone else reclaimed it first
    throw err;
  }
  if ((await readHolder(marker)) === seen) await rm(marker, { force: true });
  else await restore(marker);
}

/** Give `marker`'s file its name back — beside it, less the marker suffix — waiting out a taker that has to give the name up first; then remove the marker. */
async function restore(marker: string): Promise<void> {
  const real = marker.slice(0, marker.lastIndexOf(".reclaim."));
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      await link(marker, real);
      break;
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") {
        await sleep(backoff(attempt));
        continue;
      }
      if (!noLinks(err)) throw err;
      await rename(marker, real); // no hard links: the file goes back by rename, which cannot wait for the name to be free
      return;
    }
  }
  await rm(marker, { force: true });
}

/** Whether a reclaim marker stands beside `real`. */
async function reclaiming(real: string): Promise<boolean> {
  return (await sidecars(real)).some((s) => s.kind === "reclaim");
}

/** The claim and reclaim files beside `real`, with the pid of the process that made each. */
async function sidecars(real: string): Promise<{ file: string; kind: "reclaim" | "claim"; pid: number }[]> {
  const name = path.basename(real);
  let names: string[];
  try {
    names = await readdir(path.dirname(real));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const found: { file: string; kind: "reclaim" | "claim"; pid: number }[] = [];
  for (const entry of names) {
    if (!entry.startsWith(`${name}.`)) continue;
    const m = SIDECAR.exec(entry.slice(name.length + 1));
    if (m !== null) found.push({ file: path.join(path.dirname(real), entry), kind: m[1] as "reclaim" | "claim", pid: Number(m[2]) });
  }
  return found;
}

/**
 * What a reclaimer or taker that died left beside `real`: a claim is
 * removed; a marker holding a live holder's file is that holder's name
 * given back, any other marker is removed. A sidecar of a live process
 * is its own.
 */
async function sweep(real: string): Promise<void> {
  for (const side of await sidecars(real)) {
    if (side.pid === process.pid || alive(side.pid)) continue;
    if (side.kind === "claim") {
      await rm(side.file, { force: true });
      continue;
    }
    const moved = await readHolder(side.file);
    const pid = moved === null ? null : pidOf(moved);
    if (pid !== null && alive(pid)) await restore(side.file);
    else await rm(side.file, { force: true });
  }
}

/** Remove `real` if it still holds `line`; a file that changed hands is left as it is. */
async function unlinkIf(real: string, line: string): Promise<void> {
  if ((await readHolder(real)) === line) await rm(real, { force: true });
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
