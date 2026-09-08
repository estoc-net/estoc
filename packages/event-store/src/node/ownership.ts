/**
 * Writer-exclusive ownership of a folder on disk (vault-folder.md §15)
 * as a pid file, with no advisory file lock (decision 5 of the v3 plan):
 * what `O_EXCL`, `link` and `rename` can promise without one.
 *
 * The file holds one line, `<pid> <thread> <token>`: the process and
 * thread that took it — Node workers share a pid and differ in thread
 * id (r2-A) — and a token for this one take. It is created whole and
 * atomically, written to a claim file beside it and hard-linked into
 * place, so no taker ever sees an empty file of this module's making
 * (r1-G), then read back, since the name may have changed hands
 * meanwhile.
 *
 * A record — a holder's line, a claim, a marker — is live while the
 * process it names is, with one exception: a record naming this very
 * thread that this thread has no memory of is a previous incarnation's,
 * left by a process that died and whose pid came round again. This
 * thread keeps what it holds and what it is working on in one registry
 * shared by every copy of this module the thread has loaded (r2-A), so
 * the memory is complete: two takes in one thread cannot both pass
 * (r1-A), whichever copy each came through, and a line naming another
 * thread of this process is that thread's, live. A file naming a live
 * holder refuses the taker at once.
 *
 * A stale file — dead, previous incarnation, or not a holder's line at
 * all: empty, garbage (r1-G) — is reclaimed by moving it aside under a
 * marker naming the reclaimer, checking that what moved is exactly the
 * stale file seen (r1-A), and only then removing it and taking the free
 * name. A live holder moved by mistake — one that took the name between
 * the look and the move — is given its name back: linked back once the
 * name is free, since a taker that finds a marker beside the name it
 * just took gives the name up and looks again. The marker stands until
 * that has happened: a restore that runs out of patience — a taker
 * stalled between its take and its look, longer than the budget — leaves
 * the marker in place and fails the reclaimer's take, so the moved
 * holder's record still bars every taker (r2-C); the next sweep by this
 * thread, or by anyone once the reclaimer is gone, tries again. A taker's
 * file at the name that is itself stale is removed by the restore, and
 * a marker gone from under a restore was removed by the one entitled to:
 * the holder releasing, or a sweep that found the holder dead.
 *
 * Release removes the file only while it still holds this take's own
 * line, and a marker holding that line likewise — a holder displaced by
 * a reclaimer that gave up keeps its record there. The pid is read for
 * liveness only, never as an identity (ES-15).
 */

import { randomBytes } from "node:crypto";
import { link, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { threadId } from "node:worker_threads";

import { VaultOwned, type Ownership } from "../backend/types.js";

/** How many times a take is retried around reclaims and back-offs, and a restore around a taker giving the name up, before either gives up. */
export const ATTEMPTS = 200;
/** One holder's line: a positive pid, a thread id and the take's token. */
const HOLDER = /^([1-9][0-9]{0,9}) ([0-9]{1,9}) ([0-9a-f]{16})\n?$/;
/** A marker's or claim's name beside the pid file: `<pid file>.<kind>.<pid>.<thread>.<token>`. */
const SIDECAR = /^(reclaim|claim)\.([1-9][0-9]{0,9})\.([0-9]{1,9})\.([0-9a-f]{16})$/;

interface Registry {
  /** the pid files this thread holds or is taking right now, by real path */
  held: Set<string>;
  /** the claims and markers this thread is working on right now */
  working: Set<string>;
}

/** This thread's registry, one for every copy of this module it loads (r2-A). */
const registry: Registry = (() => {
  const key = Symbol.for("@estoc/event-store:ownership");
  const global = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (global[key] ??= { held: new Set(), working: new Set() });
})();

interface Who {
  pid: number;
  thread: number;
}

/**
 * The pid file at `real` (a real path, its directory made) taken as the
 * module comment says; `shown` is the name the caller gave, for
 * messages. `attempts` bounds the take's retries and each restore's.
 */
export async function own(real: string, shown: string, attempts = ATTEMPTS): Promise<Ownership> {
  // Check and record in one synchronous step: nothing awaited between them (r1-A).
  if (registry.held.has(real)) throw new VaultOwned(shown, "this process holds it already");
  registry.held.add(real);
  try {
    const token = randomBytes(8).toString("hex");
    const line = `${process.pid} ${threadId} ${token}\n`;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sweep(real, attempts);
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
      const who = holderOf(holder);
      if (who !== null && isLive(who)) throw new VaultOwned(shown, `${describe(who)} holds it`);
      // Stale: dead, unreadable, or this thread before its process restarted. Reclaim (r1-A).
      if (!(await reclaim(real, holder, token, attempts))) {
        throw new VaultOwned(shown, "a holder moved aside could not be given its name back in time; its record stands aside, and bars every taker until it is (r2-C)");
      }
      await sleep(backoff(attempt));
    }
    throw new VaultOwned(shown, "could not settle who holds it");
  } catch (err) {
    registry.held.delete(real);
    throw err;
  }
}

/** The ownership of a take that succeeded: released by removing the record — at the name, or aside under a marker — only while it is still this take's line (r1-A, r2-C), and by forgetting it. */
function held(real: string, line: string): Ownership {
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await unlinkIf(real, line);
        for (const side of await sidecars(real)) {
          if (side.kind === "reclaim" && (await readHolder(side.file)) === line) await rm(side.file, { force: true });
        }
        await unlinkIf(real, line); // a restore racing the removal above may have linked the line back meanwhile
      } finally {
        registry.held.delete(real);
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

/** Whether `who` is this very thread. */
function mine(who: Who): boolean {
  return who.pid === process.pid && who.thread === threadId;
}

/**
 * Whether a record naming `who` is live: its process is, unless it names
 * this thread — whose every live record is in the registry, so one that
 * reached this question is a previous incarnation's (r2-A).
 */
function isLive(who: Who): boolean {
  return mine(who) ? false : alive(who.pid);
}

function describe(who: Who): string {
  return who.pid === process.pid ? `thread ${who.thread} of this process` : `process ${who.pid}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number): number {
  return Math.min(2 + attempt * 2, 50);
}

/** Who a holder's line names, or null when the line is not a holder's — empty, garbage, another format (r1-G). */
function holderOf(line: string): Who | null {
  const m = HOLDER.exec(line);
  return m === null ? null : { pid: Number(m[1]), thread: Number(m[2]) };
}

/** Whether a holder's line is stale: not a holder's at all, or naming a holder that is not live. */
function stale(line: string): boolean {
  const who = holderOf(line);
  return who === null || !isLive(who);
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

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

function isMissing(err: unknown): boolean {
  const code = codeOf(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function noLinks(err: unknown): boolean {
  const code = codeOf(err);
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
  const claim = `${real}.claim.${process.pid}.${threadId}.${token}`;
  registry.working.add(claim);
  try {
    await writeFile(claim, line, { flag: "wx" });
    try {
      await link(claim, real);
      return true;
    } catch (err) {
      if (codeOf(err) === "EEXIST") return false;
      if (!noLinks(err)) throw err;
    } finally {
      await rm(claim, { force: true });
    }
  } finally {
    registry.working.delete(claim);
  }
  try {
    await writeFile(real, line, { flag: "wx" });
    return true;
  } catch (err) {
    if (codeOf(err) === "EEXIST") return false;
    throw err;
  }
}

/**
 * Move the stale file at `real` aside under a marker naming this
 * reclaimer, and remove it only if what moved is exactly the stale
 * `seen`; a holder that took the name meanwhile is given it back
 * (r1-A). False when that could not be done within `attempts`: the
 * marker then stands (r2-C).
 */
async function reclaim(real: string, seen: string, token: string, attempts: number): Promise<boolean> {
  const marker = `${real}.reclaim.${process.pid}.${threadId}.${token}`;
  registry.working.add(marker);
  try {
    try {
      await rename(real, marker);
    } catch (err) {
      if (isMissing(err)) return true; // someone else reclaimed it first
      throw err;
    }
    if ((await readHolder(marker)) === seen) {
      await rm(marker, { force: true });
      return true;
    }
    return restore(marker, attempts);
  } finally {
    registry.working.delete(marker);
  }
}

/**
 * Give `marker`'s file its name back — beside it, less the marker suffix
 * — and remove the marker: true once the name holds the line, or once
 * the marker is gone (removed by the holder releasing, or by a sweep
 * that found the holder dead: nothing left to restore). While a live
 * taker's file stands at the name, wait for it to give the name up; a
 * stale file there is removed. False when the name was not free within
 * `attempts`: the marker stands (r2-C).
 */
export async function restore(marker: string, attempts = ATTEMPTS): Promise<boolean> {
  const real = marker.slice(0, marker.lastIndexOf(".reclaim."));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await link(marker, real);
      await rm(marker, { force: true });
      return true;
    } catch (err) {
      const code = codeOf(err);
      if (isMissing(err)) return true; // the marker is gone: whoever removed it had nothing left to restore
      if (code === "EEXIST") {
        const moved = await readHolder(marker);
        if (moved === null) return true;
        const standing = await readHolder(real);
        if (standing === moved) {
          await rm(marker, { force: true }); // another restore linked it back already
          return true;
        }
        if (standing !== null && stale(standing)) {
          await unlinkIf(real, standing); // a taker that died holding the name, or a previous incarnation's
          continue;
        }
        await sleep(backoff(attempt));
        continue;
      }
      if (!noLinks(err)) throw err;
      await rename(marker, real); // no hard links: the file goes back by rename, which cannot wait for the name to be free
      return true;
    }
  }
  return false;
}

/** Whether a reclaim marker stands beside `real`. */
async function reclaiming(real: string): Promise<boolean> {
  return (await sidecars(real)).some((s) => s.kind === "reclaim");
}

interface Sidecar extends Who {
  file: string;
  kind: "reclaim" | "claim";
}

/** The claim and reclaim files beside `real`, with the process and thread that made each. */
async function sidecars(real: string): Promise<Sidecar[]> {
  const name = path.basename(real);
  let names: string[];
  try {
    names = await readdir(path.dirname(real));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const found: Sidecar[] = [];
  for (const entry of names) {
    if (!entry.startsWith(`${name}.`)) continue;
    const m = SIDECAR.exec(entry.slice(name.length + 1));
    if (m !== null) found.push({ file: path.join(path.dirname(real), entry), kind: m[1] as "reclaim" | "claim", pid: Number(m[2]), thread: Number(m[3]) });
  }
  return found;
}

/**
 * What a reclaimer or taker that is gone left beside `real` — dead, or
 * a previous incarnation of this thread (r2-A): a claim is removed; a
 * marker holding a live holder's file is that holder's name given back,
 * any other marker is removed. A sidecar this thread is working on, or
 * a live process's, is its own.
 */
async function sweep(real: string, attempts: number): Promise<void> {
  for (const side of await sidecars(real)) {
    if (registry.working.has(side.file) || isLive(side)) continue;
    if (side.kind === "claim") {
      await rm(side.file, { force: true });
      continue;
    }
    const moved = await readHolder(side.file);
    if (moved !== null && !stale(moved)) await restore(side.file, attempts);
    else await rm(side.file, { force: true });
  }
}

/** Remove `real` if it still holds `line`; a file that changed hands is left as it is. */
async function unlinkIf(real: string, line: string): Promise<void> {
  if ((await readHolder(real)) === line) await rm(real, { force: true });
}
