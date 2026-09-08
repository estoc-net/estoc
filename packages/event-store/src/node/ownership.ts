/**
 * Writer-exclusive ownership of a folder on disk (vault-folder.md §15)
 * as a pid file, with no advisory file lock (decision 5 of the v3 plan):
 * what `O_EXCL`, `link` and `rename` can promise without one.
 *
 * The file holds one line, `<pid> <thread> <origin> <token>`: the
 * process and thread that took it — Node workers share a pid and differ
 * in thread id — the millisecond the process began, and a token
 * for this one take. It is created whole and atomically, written to a
 * claim file beside it and hard-linked into place, so no taker ever sees
 * an empty file of this module's making, then read back, since
 * the name may have changed hands meanwhile.
 *
 * A record — a holder's line, a claim, a marker — is judged live from
 * the disk alone; no memory of this module's decides it, since a copy
 * of the module in another realm of this thread has no share in that
 * memory. A record naming another process is live while that
 * process is. One naming this process and another thread is live while
 * this process is: a worker's record outlives the worker until the
 * process exits, or that thread reclaims it. One naming this very
 * thread is live when its origin is this process's — the platform's
 * `performance.timeOrigin`, fixed when the process began and the same
 * in every realm and copy — and a previous incarnation's otherwise:
 * left by a process that died and whose pid came round again. So two
 * takes in one thread cannot both pass, whichever copy each came
 * through, and a file naming a live holder refuses the
 * taker at once.
 *
 * Nothing is removed from the name after a read: what stands there
 * may have changed between the read and the removal. A file is
 * taken off the name only by moving it aside — atomically, under a
 * marker naming the mover — and what moved is then judged: exactly the
 * stale file seen, or stale anyway (dead, previous incarnation, not a
 * holder's line at all: empty, garbage), and it is removed with the
 * marker; a live holder's file that got there meanwhile, and it
 * is given its name back, linked back once the name is free, since a
 * taker that finds a marker beside the name it just took gives the
 * name up — the same way — and looks again. The marker stands until
 * that has happened: a restore that runs out of patience — a taker
 * stalled between its take and its look, longer than the budget —
 * leaves the marker in place and fails the mover's take, so the moved
 * holder's record still bars every taker; the next sweep by this
 * thread, or by anyone once the mover is gone, tries again. A file at
 * the name that is itself stale is taken off it the same way, and a
 * marker gone from under a restore was removed by the one entitled to:
 * the holder withdrawing, or a sweep that found the holder dead.
 *
 * A holder withdraws — releasing, or giving up a name it took beside a
 * marker — by taking its own line off the name the same way, and off
 * every marker holding it, until a pass finds it nowhere: a restore
 * racing the withdrawal cannot then leave the line standing. The pid is
 * read for liveness only, never as an identity (ES-15).
 */

import { randomBytes } from "node:crypto";
import { link, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { threadId } from "node:worker_threads";

import { VaultOwned, type Ownership } from "../backend/types.js";

/** How many times a take is retried around reclaims and back-offs, and a restore around a taker giving the name up, before either gives up. */
export const ATTEMPTS = 200;
/**
 * When this process began, in whole milliseconds of Unix time: fixed
 * at start, read the same by every copy of this module in this thread
 * whatever realm loaded it, and different for every incarnation of a
 * pid.
 */
const ORIGIN = Math.floor(performance.timeOrigin);
/** One holder's line: a positive pid, a thread id, the process's origin and the take's token. */
const HOLDER = /^([1-9][0-9]{0,9}) ([0-9]{1,9}) ([1-9][0-9]{0,15}) ([0-9a-f]{16})\n?$/;
/** A marker's or claim's name beside the pid file: `<pid file>.<kind>.<pid>.<thread>.<origin>.<token>`. */
const SIDECAR = /^(reclaim|claim)\.([1-9][0-9]{0,9})\.([0-9]{1,9})\.([1-9][0-9]{0,15})\.([0-9a-f]{16})$/;

/**
 * The markers this copy of the module is moving files under right now,
 * skipped by its own sweeps. A convenience, not what safety rests on:
 * another copy in this thread has its own set, and what it does to a
 * marker of this incarnation — restore, or remove a stale file — is what
 * this copy would do.
 */
const working = new Set<string>();

interface Who {
  pid: number;
  thread: number;
  origin: number;
}

/** What a move of a file off the name came to. */
type Moved = "removed" | "kept" | "stuck";

const STUCK = "a holder moved aside could not be given its name back in time; its record stands aside, and bars every taker until it is";

/**
 * The pid file at `real` (a real path, its directory made) taken as the
 * module comment says; `shown` is the name the caller gave, for
 * messages. `attempts` bounds the take's retries and each restore's.
 */
export async function own(real: string, shown: string, attempts = ATTEMPTS): Promise<Ownership> {
  const token = randomBytes(8).toString("hex");
  const line = `${process.pid} ${threadId} ${ORIGIN} ${token}\n`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sweep(real, attempts);
    if (!(await take(real, line, token))) {
      const holder = await readHolder(real);
      if (holder === null) continue; // absent now: take it
      if (holder !== line) {
        const who = holderOf(holder);
        if (who !== null && isLive(who)) throw new VaultOwned(shown, `${describe(who)} holds it`);
        // Stale: dead, a previous incarnation, unreadable. Off the name by a move and a look at what moved.
        if ((await evict(real, holder, attempts)) === "stuck") throw new VaultOwned(shown, STUCK);
        await sleep(backoff(attempt));
        continue;
      }
      // This take's own line stands at the name: a mover took it aside by mistake and gave it back.
    }
    // Taken; but a reclaim in flight beside it may be about to give the name back to a holder it moved: give it up and look again.
    if (await reclaiming(real)) {
      if ((await withdraw(real, line, attempts)) === "stuck") throw new VaultOwned(shown, STUCK);
      await sleep(backoff(attempt));
      continue;
    }
    if ((await readHolder(real)) !== line) continue; // gone or changed hands between the take and the look: try again
    return held(real, line);
  }
  throw new VaultOwned(shown, "could not settle who holds it");
}

/** The ownership of a take that succeeded: released by withdrawing this take's line — from the name, and from any marker holding it. */
function held(real: string, line: string): Ownership {
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await withdraw(real, line, ATTEMPTS);
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

/** Whether `who` is this very thread of this very incarnation of the process. */
function mine(who: Who): boolean {
  return who.pid === process.pid && who.thread === threadId && who.origin === ORIGIN;
}

/**
 * Whether a record naming `who` is live, from the disk alone:
 * another process's while that process is; another thread's of this
 * process while this process is, since only that thread could check its
 * origin; this thread's when the origin is this incarnation's, whichever
 * copy of the module wrote it — a previous incarnation's otherwise.
 */
function isLive(who: Who): boolean {
  if (who.pid !== process.pid) return alive(who.pid);
  if (who.thread !== threadId) return true;
  return who.origin === ORIGIN;
}

function describe(who: Who): string {
  if (who.pid !== process.pid) return `process ${who.pid}`;
  return who.thread === threadId ? "this thread of this process" : `thread ${who.thread} of this process`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number): number {
  return Math.min(2 + attempt * 2, 50);
}

/** Who a holder's line names, or null when the line is not a holder's — empty, garbage, another format. */
function holderOf(line: string): Who | null {
  const m = HOLDER.exec(line);
  return m === null ? null : { pid: Number(m[1]), thread: Number(m[2]), origin: Number(m[3]) };
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

/** A fresh sidecar name of `kind` beside `real`, naming this thread and incarnation. */
function sidecar(real: string, kind: "reclaim" | "claim", token = randomBytes(8).toString("hex")): string {
  return `${real}.${kind}.${process.pid}.${threadId}.${ORIGIN}.${token}`;
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
  const claim = sidecar(real, "claim", token);
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
  try {
    await writeFile(real, line, { flag: "wx" });
    return true;
  } catch (err) {
    if (codeOf(err) === "EEXIST") return false;
    throw err;
  }
}

/**
 * Take the file at `real` off the name, when it is `expected` or stale:
 * moved aside, atomically, under a marker naming this mover, and judged
 * by what moved, never by what was read. `removed` when what
 * moved was `expected` or stale, and went with the marker; `kept` when
 * a live holder's file other than `expected` stands there — left as it
 * is — or got there between the look and the move and was given its
 * name back; `stuck` when that could not be done within
 * `attempts`: the marker then stands.
 */
async function evict(real: string, expected: string, attempts: number): Promise<Moved> {
  const standing = await readHolder(real);
  if (standing === null || (standing !== expected && !stale(standing))) return "kept";
  const marker = sidecar(real, "reclaim");
  working.add(marker);
  try {
    try {
      await rename(real, marker);
    } catch (err) {
      if (isMissing(err)) return "kept"; // someone else took it off the name first
      throw err;
    }
    const moved = await readHolder(marker);
    if (moved === null || moved === expected || stale(moved)) {
      await rm(marker, { force: true });
      return "removed";
    }
    return (await restore(marker, attempts)) ? "kept" : "stuck";
  } finally {
    working.delete(marker);
  }
}

/**
 * Take this holder's `line` off the name and off every marker holding
 * it — a mover that took it aside by mistake may be giving it back
 * meanwhile — until a pass finds it nowhere. `stuck` when a live file
 * of someone else's, moved on the way, could not be given its name
 * back in time.
 */
async function withdraw(real: string, line: string, attempts: number): Promise<"done" | "stuck"> {
  for (;;) {
    const moved = await evict(real, line, attempts);
    if (moved === "stuck") return "stuck";
    let found = moved === "removed";
    for (const side of await sidecars(real)) {
      if (side.kind === "reclaim" && (await readHolder(side.file)) === line) {
        await rm(side.file, { force: true });
        found = true;
      }
    }
    if (!found) return "done";
  }
}

/**
 * Give `marker`'s file its name back — beside it, less the marker suffix
 * — and remove the marker: true once the name holds the line, or once
 * the marker is gone (removed by the holder withdrawing, or by a sweep
 * that found the holder dead: nothing left to restore). While a live
 * taker's file stands at the name, wait for it to give the name up; a
 * stale file there is taken off it by a move and a look at what moved,
 * on the budget left. False when the name was not free within
 * `attempts`: the marker stands.
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
          if ((await evict(real, standing, attempts - attempt)) === "stuck") return false;
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

/** The claim and reclaim files beside `real`, with the process, thread and origin that made each. */
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
    if (m !== null) {
      found.push({ file: path.join(path.dirname(real), entry), kind: m[1] as "reclaim" | "claim", pid: Number(m[2]), thread: Number(m[3]), origin: Number(m[4]) });
    }
  }
  return found;
}

/**
 * What a mover or taker that is gone left beside `real` — dead, or a
 * previous incarnation — and what this thread left on purpose: a claim
 * is removed; a marker holding a live holder's file is that holder's
 * name given back, any other marker is removed. A sidecar this copy is
 * working on, and a live process's or another thread's, is its own. A
 * marker of this very thread not in hand stands from a restore that
 * gave up, or is another copy's, in flight; either way the
 * same steps serve, and are safe beside that copy's own.
 */
async function sweep(real: string, attempts: number): Promise<void> {
  for (const side of await sidecars(real)) {
    if (working.has(side.file)) continue;
    if (side.kind === "claim") {
      if (!isLive(side)) await rm(side.file, { force: true });
      continue;
    }
    if (isLive(side) && !mine(side)) continue;
    const moved = await readHolder(side.file);
    if (moved !== null && !stale(moved)) await restore(side.file, attempts);
    else await rm(side.file, { force: true });
  }
}
