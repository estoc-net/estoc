/**
 * Writer-exclusive ownership of a folder on disk (vault-folder.md §15)
 * as a pid file, with no advisory file lock (decision 5 of the v3 plan):
 * what `O_EXCL`, `link` and `rename` can promise without one.
 *
 * The file holds one line, `<pid> <thread> <origin> <token>`: the
 * process and thread that took it — Node workers share a pid and differ
 * in thread id — the millisecond the process began, and a token for
 * this one take. It is created whole and atomically (`take`) and read
 * back, since the name may have changed hands meanwhile.
 *
 * Three rules hold the rest together, each kept where named:
 *
 * - A record is judged live from the disk alone (`isLive`): no memory
 *   of this module's decides it, since a copy of the module in another
 *   realm of this thread has no share in that memory.
 * - Nothing is removed from the name after a read (`evict`): what
 *   stands there may have changed in between. A file leaves the name
 *   only by an atomic move under a marker naming the mover, and what
 *   moved is then judged; a live holder's file moved by mistake is
 *   given its name back (`restore`), and the marker stands, barring
 *   every taker, until it has been.
 * - A take that is over is withdrawn (`withdraw`): a holder releasing,
 *   a taker giving the name up, or failing once it had published its
 *   line, leaves nothing of that line behind — at the name, under any
 *   marker, or with a restore about to put it back.
 *
 * The pid is read for liveness only, never as an identity (ES-15).
 */

import { randomBytes } from "node:crypto";
import { access, link, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
/** A sidecar's name beside the pid file: `<pid file>.<kind>.<pid>.<thread>.<origin>.<token>`. */
const SIDECAR = /^(reclaim|claim|withdraw)\.([1-9][0-9]{0,9})\.([0-9]{1,9})\.([1-9][0-9]{0,15})\.([0-9a-f]{16})$/;

/**
 * What stands beside the pid file: a `claim` is a take's line on its
 * way to the name; a `reclaim` marker holds a file moved off the name
 * until it is judged or given back; a `withdraw` notice says the take
 * named is over, so a restore about to put its line back drops it.
 */
type Kind = "reclaim" | "claim" | "withdraw";

/**
 * The markers this copy of the module is moving files under right now,
 * skipped by its own sweeps. A convenience, not what safety rests on:
 * another copy in this thread has its own set, and what it does to a
 * marker of this incarnation — restore, or remove a stale file — is what
 * this copy would do.
 */
const working = new Set<string>();

/** Whom a record names, and which take. */
interface Who {
  pid: number;
  thread: number;
  origin: number;
  token: string;
}

type Moved = "removed" | "kept" | "stuck";

const STUCK = "a holder moved aside could not be given its name back in time; its record stands aside, and bars every taker until it is";

/**
 * The pid file at `real` (a real path, its directory made) taken as the
 * module comment says; `shown` is the name the caller gave, for
 * messages. `attempts` bounds the take's retries and each restore's.
 * A take that fails once its line has been at the name withdraws the
 * line before throwing, since the disk would otherwise hold this
 * thread as a live holder that no one can release.
 */
export async function own(real: string, shown: string, attempts = ATTEMPTS): Promise<Ownership> {
  const me: Who = { pid: process.pid, thread: threadId, origin: ORIGIN, token: randomBytes(8).toString("hex") };
  const line = lineOf(me);
  let published = false;
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sweep(real, attempts);
      if (await take(real, me)) {
        published = true;
      } else {
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
        if ((await withdraw(real, me, attempts)) === "stuck") throw new VaultOwned(shown, STUCK);
        published = false;
        await sleep(backoff(attempt));
        continue;
      }
      if ((await readHolder(real)) !== line) continue; // gone or changed hands between the take and the look: try again
      return held(real, me);
    }
    throw new VaultOwned(shown, "could not settle who holds it");
  } catch (err) {
    if (published) await withdraw(real, me, attempts);
    throw err;
  }
}

/** The ownership of a take that succeeded: released by withdrawing the take's line. */
function held(real: string, me: Who): Ownership {
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await withdraw(real, me, ATTEMPTS);
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

function lineOf(who: Who): string {
  return `${who.pid} ${who.thread} ${who.origin} ${who.token}\n`;
}

/** Who a holder's line names, or null when the line is not a holder's — empty, garbage, another format. */
function holderOf(line: string): Who | null {
  const m = HOLDER.exec(line);
  return m === null ? null : { pid: Number(m[1]), thread: Number(m[2]), origin: Number(m[3]), token: m[4] as string };
}

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

function sidecar(real: string, kind: Kind, who: Who): string {
  return `${real}.${kind}.${who.pid}.${who.thread}.${who.origin}.${who.token}`;
}

/** A fresh marker name beside `real`, naming this thread and incarnation. */
function marker(real: string): string {
  return sidecar(real, "reclaim", { pid: process.pid, thread: threadId, origin: ORIGIN, token: randomBytes(8).toString("hex") });
}

/**
 * Create the pid file whole at `real` with `me`'s line, only if absent:
 * written to a claim file beside it and hard-linked into place, the
 * claim then removed, so no taker ever sees an empty file of this
 * module's making. Where the file system has no hard links, an
 * exclusive create and a write — the window between them is this
 * taker's own to lose, since an empty file reads as stale and a
 * reclaimed take fails its read-back. True when the name was taken
 * now, false when something stood there.
 */
async function take(real: string, me: Who): Promise<boolean> {
  const line = lineOf(me);
  const claim = sidecar(real, "claim", me);
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
 * `attempts`: a marker then stands.
 */
async function evict(real: string, expected: string, attempts: number): Promise<Moved> {
  const standing = await readHolder(real);
  if (standing === null || (standing !== expected && !stale(standing))) return "kept";
  const aside = marker(real);
  working.add(aside);
  try {
    try {
      await rename(real, aside);
    } catch (err) {
      if (isMissing(err)) return "kept"; // someone else took it off the name first
      throw err;
    }
    const moved = await readHolder(aside);
    if (moved === null || moved === expected || stale(moved)) {
      await rm(aside, { force: true });
      return "removed";
    }
    return (await restore(aside, attempts)) ? "kept" : "stuck";
  } finally {
    working.delete(aside);
  }
}

/**
 * Take `me`'s line off the name and off every marker holding it — a
 * mover that took it aside by mistake may be giving it back meanwhile —
 * until a pass finds it nowhere. A notice of the withdrawal stands
 * beside the name throughout: a restore that had already looked for it
 * when it linked the line back looks again afterwards, and takes the
 * line off the name itself, keeping its marker until it has, so a pass
 * that finds no marker holding the line has no restore left to fear.
 * The notice goes with the last pass; `stuck` — a live file of someone
 * else's, moved on the way, could not be given its name back in time —
 * leaves it standing, and the sweep removes it once this process is
 * gone.
 */
async function withdraw(real: string, me: Who, attempts: number): Promise<"done" | "stuck"> {
  const line = lineOf(me);
  const notice = sidecar(real, "withdraw", me);
  await writeFile(notice, "");
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
    if (!found) break;
  }
  await rm(notice, { force: true });
  return "done";
}

/** Whether the take that wrote `line` is being withdrawn: its notice stands beside `real`. */
async function withdrawing(real: string, line: string): Promise<boolean> {
  const who = holderOf(line);
  if (who === null) return false;
  try {
    await access(sidecar(real, "withdraw", who));
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * Give `marker`'s file its name back — beside it, less the marker suffix
 * — and remove the marker: true once the name holds the line, or once
 * the marker is gone (removed by the holder withdrawing, or by a sweep
 * that found the holder dead: nothing left to restore). While a live
 * taker's file stands at the name, wait for it to give the name up; a
 * stale file there is taken off it by a move and a look at what moved,
 * on the budget left. A line whose holder is withdrawing it is taken
 * off the name again once linked, and the marker goes only then.
 * False when the name was not free within `attempts`, or a file moved
 * on the way could not be given its name back: a marker then stands.
 */
export async function restore(marker: string, attempts = ATTEMPTS): Promise<boolean> {
  const real = marker.slice(0, marker.lastIndexOf(".reclaim."));
  const moved = await readHolder(marker);
  if (moved === null) return true;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await link(marker, real);
    } catch (err) {
      const code = codeOf(err);
      if (isMissing(err)) return true; // the marker is gone: whoever removed it had nothing left to restore
      if (code === "EEXIST") {
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
    }
    let given = true;
    if (await withdrawing(real, moved)) given = (await evict(real, moved, attempts - attempt)) !== "stuck";
    await rm(marker, { force: true });
    return given;
  }
  return false;
}

async function reclaiming(real: string): Promise<boolean> {
  return (await sidecars(real)).some((s) => s.kind === "reclaim");
}

interface Sidecar extends Who {
  file: string;
  kind: Kind;
}

/** The sidecars beside `real`, with the process, thread, origin and token each names. */
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
      found.push({ file: path.join(path.dirname(real), entry), kind: m[1] as Kind, pid: Number(m[2]), thread: Number(m[3]), origin: Number(m[4]), token: m[5] as string });
    }
  }
  return found;
}

/**
 * What a mover, taker or withdrawer that is gone left beside `real` —
 * dead, or a previous incarnation — and what this thread left on
 * purpose: a claim or notice is removed; a marker holding a live
 * holder's file is that holder's name given back, any other marker is
 * removed. A sidecar this copy is working on, and a live process's or
 * another thread's, is its own. A marker of this very thread not in
 * hand stands from a restore that gave up, or is another copy's, in
 * flight; either way the same steps serve, and are safe beside that
 * copy's own.
 */
async function sweep(real: string, attempts: number): Promise<void> {
  for (const side of await sidecars(real)) {
    if (working.has(side.file)) continue;
    if (side.kind !== "reclaim") {
      if (!isLive(side)) await rm(side.file, { force: true });
      continue;
    }
    if (isLive(side) && !mine(side)) continue;
    const moved = await readHolder(side.file);
    if (moved !== null && !stale(moved)) await restore(side.file, attempts);
    else await rm(side.file, { force: true });
  }
}
