/**
 * The vault on a real disk: what the memory backend cannot show — a
 * pid file as ownership, a second process's stale pid taken over, a
 * reopen from another backend instance finding what the last one wrote,
 * and a whole-file write that leaves nothing beside the file.
 */

import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Worker, threadId } from "node:worker_threads";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { build } from "esbuild";

import { FsBackend } from "../../../src/node.js";
import { own, restore } from "../../../src/node/ownership.js";
import { FolderReader, FolderVault, OWNER_FILE, VaultOwned, utf8, type Cid, type Draft } from "../../../src/v3/index.js";
import { all, expectBytes, ids } from "../suite/helpers.js";
import { HELLO_CID } from "../suite/object-store-suite.js";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const JWE = "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwicDJjIjoyMjAwMDAsInAycyI6IkFCQ0QifQ.QUJDRA.QUJDRA.QUJDRA.QUJDRA";
const KEYSTORE = utf8(`${JSON.stringify({ version: 3, seedJwe: JWE }, null, 2)}\n`);
const HELLO = new TextEncoder().encode("hello");
const draft = (roots: Cid[] = []): Draft => ({ type: "test.event", roots, data: { n: 1 } });

const made: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "estoc-v3-vault-"));
  made.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

const LOCK = `.estoc/${OWNER_FILE}`;
const LINE = /^([1-9][0-9]*) ([0-9]+) ([1-9][0-9]*) ([0-9a-f]{16})\n$/;
/** A pid nobody has: above Linux's largest. */
const DEAD = 4194305;
/** A pid that is alive and not this process: the test runner's parent. */
const LIVE = process.ppid;
/** When this process began, as the module stamps its records: read here on its own, not through the module. */
const ORIGIN = Math.floor(performance.timeOrigin);
/** When some other process began: any origin, since only this thread's records are checked against this process's. */
const AGO = 1700000000000;

async function ownerFile(dir: string): Promise<string> {
  return readFile(path.join(dir, ".estoc", "local", "owner.pid"), "utf8");
}

async function localEntries(dir: string): Promise<string[]> {
  return (await readdir(path.join(dir, ".estoc", "local"))).sort();
}

describe("FsBackend.own", () => {
  it("is a pid file holding this process's pid and a token: taken whole, refused while this process holds it, removed at release with nothing left beside it", async () => {
    const dir = await tempDir();
    const backend = new FsBackend(dir);
    const held = await backend.own(LOCK);
    const line = await ownerFile(dir);
    expect(line).toMatch(LINE);
    expect(line.split(" ")[0]).toBe(String(process.pid));
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(VaultOwned);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
    await held.release();
    expect(await localEntries(dir)).toEqual([]);
    const again = await backend.own(LOCK);
    expect(await ownerFile(dir)).not.toBe(line); // a new take, a new token
    await again.release();
  });

  it("two takes racing in one process have exactly one winner, whichever backend instance each came through", async () => {
    for (let round = 0; round < 5; round++) {
      const dir = await tempDir();
      const attempts = await Promise.allSettled([new FsBackend(dir).own(LOCK), new FsBackend(dir).own(LOCK), new FsBackend(dir).own(LOCK)]);
      const winners = attempts.filter((a) => a.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const loser of attempts) if (loser.status === "rejected") expect(loser.reason).toBeInstanceOf(VaultOwned);
      expect((await ownerFile(dir)).split(" ")[0]).toBe(String(process.pid));
      for (const winner of winners) if (winner.status === "fulfilled") await winner.value.release();
      expect(await localEntries(dir)).toEqual([]);
    }
  });

  it("a file naming a live process refuses; one naming a process that is gone is reclaimed; the pid is read for liveness only", async () => {
    const dir = await tempDir();
    const file = path.join(dir, ".estoc", "local", "owner.pid");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${LIVE} 0 ${AGO} 0123456789abcdef\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect(await ownerFile(dir)).toBe(`${LIVE} 0 ${AGO} 0123456789abcdef\n`);
    await writeFile(file, `${DEAD} 0 ${AGO} 0123456789abcdef\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect((await ownerFile(dir)).split(" ")[0]).toBe(String(process.pid));
    expect(await localEntries(dir)).toEqual(["owner.pid"]); // the reclaim left no marker
    await taken.release();
  });

  it("an empty file, garbage, or another format is not a live holder: reclaimed and taken over", async () => {
    for (const residue of ["", "not a pid\n", "0 0 0123456789abcdef\n", `${process.pid}\n`, "-1 0 0123456789abcdef\n", `${LIVE}\n`, `${LIVE} 0123456789abcdef\n`, `${process.pid} 0123456789abcdef\n`, `${process.pid} ${threadId} 0123456789abcdef\n`, `${LIVE} 0 0 0123456789abcdef\n`]) {
      const dir = await tempDir();
      const file = path.join(dir, ".estoc", "local", "owner.pid");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, residue);
      const taken = await new FsBackend(dir).own(LOCK);
      expect(await ownerFile(dir), JSON.stringify(residue)).toMatch(LINE);
      await taken.release();
      expect(await localEntries(dir)).toEqual([]);
    }
  });

  it("a file naming this thread with another origin is a previous incarnation's, stale; one with this process's origin is live — written by hand, with no memory of it anywhere — as is one naming another thread of this process, whichever origin", async () => {
    const dir = await tempDir();
    const file = path.join(dir, ".estoc", "local", "owner.pid");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${process.pid} ${threadId} ${ORIGIN - 1} 0123456789abcdef\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect(await ownerFile(dir)).toBe((await ownerFile(dir)).replace(LINE, `${process.pid} ${threadId} ${ORIGIN} $4\n`)); // this incarnation's stamp
    await taken.release();
    // this thread's, this incarnation's: live by the disk's word alone
    await writeFile(file, `${process.pid} ${threadId} ${ORIGIN} 0123456789abcdef\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
    expect(await ownerFile(dir)).toBe(`${process.pid} ${threadId} ${ORIGIN} 0123456789abcdef\n`);
    // one naming another thread of this process is that thread's, live while the process is — its origin is not this thread's to check
    for (const origin of [ORIGIN, ORIGIN - 1]) {
      await writeFile(file, `${process.pid} ${threadId + 1000} ${origin} 0123456789abcdef\n`);
      await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`thread ${threadId + 1000} of this process holds it`));
      expect(await ownerFile(dir)).toBe(`${process.pid} ${threadId + 1000} ${origin} 0123456789abcdef\n`);
    }
    await rm(file);
  });

  it("release removes the file only while it is still this take's; a name that changed hands is left alone", async () => {
    const dir = await tempDir();
    const file = path.join(dir, ".estoc", "local", "owner.pid");
    const held = await new FsBackend(dir).own(LOCK);
    await rm(file);
    await writeFile(file, `${LIVE} 0 ${AGO} fedcba9876543210\n`); // another holder, by force
    await held.release();
    expect(await ownerFile(dir)).toBe(`${LIVE} 0 ${AGO} fedcba9876543210\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(VaultOwned);
    await rm(file);
  });

  it("what a reclaimer or taker that died left beside the file is swept — a marker holding a live holder's file gives that holder its name back", async () => {
    const dir = await tempDir();
    const local = path.join(dir, ".estoc", "local");
    await mkdir(local, { recursive: true });
    // a dead reclaimer moved a live holder's file aside and never put it back
    await writeFile(path.join(local, `owner.pid.reclaim.${DEAD}.0.${AGO}.0123456789abcdef`), `${LIVE} 0 ${AGO} 1111111111111111\n`);
    await writeFile(path.join(local, `owner.pid.claim.${DEAD}.0.${AGO}.2222222222222222`), `${DEAD} 0 ${AGO} 2222222222222222\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    expect(await ownerFile(dir)).toBe(`${LIVE} 0 ${AGO} 1111111111111111\n`);
    await rm(path.join(local, "owner.pid"));
    // a dead reclaimer's marker holding a dead holder's file is just removed
    await writeFile(path.join(local, `owner.pid.reclaim.${DEAD}.0.${AGO}.3333333333333333`), `${DEAD} 0 ${AGO} 3333333333333333\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    await taken.release();
    // a live reclaimer's marker is its own: a taker gives the name up and waits it out
    await writeFile(path.join(local, `owner.pid.reclaim.${LIVE}.0.${AGO}.4444444444444444`), `${DEAD} 0 ${AGO} 4444444444444444\n`);
    const waiting = new FsBackend(dir).own(LOCK);
    let done = false;
    void waiting.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      }
    );
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(done).toBe(false); // takes the name, sees the marker, gives it up, and looks again — never keeps it
    }
    await rm(path.join(local, `owner.pid.reclaim.${LIVE}.0.${AGO}.4444444444444444`)); // the reclaimer finishes
    const settled = await waiting;
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    await settled.release();
  });
});

/** The ownership module bundled on its own: another copy of it, as a worker loads, or a second bundle or realm in one thread. */
let bundle: string;
beforeAll(async () => {
  const dir = await tempDir();
  bundle = path.join(dir, "ownership.cjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../../src/node/fs.ts", import.meta.url))],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    outfile: bundle,
  });
});

/** The bundle loaded into this thread by the platform's own `require`, which the test runner's loader does not stand in for. */
const loadCopy = (): { FsBackend: typeof FsBackend } => createRequire(import.meta.url)(bundle) as { FsBackend: typeof FsBackend };

describe("ownership across threads and module copies", () => {

  /** A worker that takes `lock` in `dir` through the bundled copy on "take", reports the outcome, and releases on "release". */
  function worker(dir: string): { take: () => Promise<string>; release: () => Promise<void> } {
    const code = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { FsBackend } = require(workerData.bundle);
        let held = null;
        parentPort.on("message", async (message) => {
          if (message === "take") {
            try {
              held = await new FsBackend(workerData.dir).own(workerData.lock);
              parentPort.postMessage("acquired");
            } catch (err) {
              parentPort.postMessage(err.name + ": " + err.message);
            }
          } else {
            if (held) await held.release();
            parentPort.postMessage("released");
            parentPort.close();
          }
        });
      })();`;
    const w = new Worker(code, { eval: true, workerData: { bundle, dir, lock: LOCK } });
    const reply = (): Promise<string> => new Promise((resolve, reject) => {
      w.once("message", resolve);
      w.once("error", reject);
    });
    return {
      take: () => {
        const answer = reply();
        w.postMessage("take");
        return answer;
      },
      release: async () => {
        const answer = reply();
        w.postMessage("release");
        await answer;
      },
    };
  }

  it("a worker of this process — same pid, its own thread and module copy — is refused what this thread holds, and this thread what a worker holds", async () => {
    const dir = await tempDir();
    const held = await new FsBackend(dir).own(LOCK);
    const line = await ownerFile(dir);
    const other = worker(dir);
    expect(await other.take()).toMatch(new RegExp(`VaultOwned: .*thread ${threadId} of this process holds it`));
    expect(await ownerFile(dir)).toBe(line); // nothing took the name over
    await held.release();
    expect(await other.take()).toBe("acquired");
    expect((await ownerFile(dir)).split(" ")[0]).toBe(String(process.pid));
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(/thread [0-9]+ of this process holds it/);
    await other.release();
    expect(await localEntries(dir)).toEqual([]);
  });

  it("two workers of this process exclude each other", async () => {
    const dir = await tempDir();
    const first = worker(dir);
    const second = worker(dir);
    expect(await first.take()).toBe("acquired");
    expect(await second.take()).toMatch(/VaultOwned: .*of this process holds it/);
    await first.release();
    expect(await second.take()).toBe("acquired");
    await second.release();
    expect(await localEntries(dir)).toEqual([]);
  });

  it("a second copy of the module in this thread: what one copy holds the disk refuses the other, and a take through either has one winner", async () => {
    const dir = await tempDir();
    const copy = loadCopy();
    const held = await new FsBackend(dir).own(LOCK);
    await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
    await held.release();
    const attempts = await Promise.allSettled([new copy.FsBackend(dir).own(LOCK), new FsBackend(dir).own(LOCK)]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    for (const a of attempts) if (a.status === "fulfilled") await a.value.release();
    expect(await localEntries(dir)).toEqual([]);
  });
});

describe("a reclaim that cannot give a moved holder its name back", () => {
  /** The name and its directory, made; `attempts` small so a stalled taker exhausts a restore within the test. */
  async function place(): Promise<{ real: string; local: string }> {
    const dir = await tempDir();
    const local = path.join(dir, ".estoc", "local");
    await mkdir(local, { recursive: true });
    return { real: path.join(local, "owner.pid"), local };
  }
  const W = `${LIVE} 0 ${AGO} 1111111111111111\n`; // a live holder, moved aside
  const T = `${LIVE} 7 ${AGO} 2222222222222222\n`; // a live taker's file, standing at the name and not given up

  it("a restore that runs out of patience leaves the marker — the moved holder's record — in place; a taker meanwhile sees the live file, and one after the taker gave up is barred by the marker until the restore completes", async () => {
    const { real, local } = await place();
    const marker = `${real}.reclaim.${DEAD}.0.${AGO}.3333333333333333`;
    await writeFile(marker, W);
    await writeFile(real, T);
    expect(await restore(marker, 3)).toBe(false);
    expect((await readdir(local)).sort()).toEqual([`owner.pid`, `owner.pid.reclaim.${DEAD}.0.${AGO}.3333333333333333`]);
    expect(await readFile(marker, "utf8")).toBe(W);
    expect(await readFile(real, "utf8")).toBe(T);
    // a taker now: the live taker's file refuses it
    await expect(own(real, LOCK, 3)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    // the taker gives the name up (as one that sees a marker does); the marker's sweep gives W its name back, and W refuses the next taker
    await rm(real);
    await expect(own(real, LOCK, 3)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]);
    expect(await readFile(real, "utf8")).toBe(W);
  });

  it("the reclaimer whose restore gave up fails its take with the marker standing, and its next take — the marker its own, no longer in flight — restores first", async () => {
    const { real, local } = await place();
    const stale = `${DEAD} 0 ${AGO} 4444444444444444\n`;
    await writeFile(real, stale);
    // W took the name between this reclaimer's look and its move, and a taker T took it after the move: the state after the move
    // is laid out by hand — the marker, this thread's and no longer in flight, holds W, not what was seen; T stands at the name —
    // and the reclaimer's own restore is what `own` runs through `sweep`.
    const marker = `${real}.reclaim.${process.pid}.${threadId}.${ORIGIN}.5555555555555555`;
    await writeFile(marker, W);
    await writeFile(real, T);
    await expect(own(real, LOCK, 3)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect((await readdir(local)).sort()).toEqual(["owner.pid", `owner.pid.reclaim.${process.pid}.${threadId}.${ORIGIN}.5555555555555555`]); // the marker stands: W's record bars every taker
    await rm(real);
    await expect(own(real, LOCK, 3)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]);
    expect(await readFile(real, "utf8")).toBe(W);
  });

  it("a stale file at the name — a taker that died, a previous incarnation — is taken off it by the restore, which then completes; a marker gone from under it, or already linked back, is done", async () => {
    const { real, local } = await place();
    const marker = `${real}.reclaim.${DEAD}.0.${AGO}.6666666666666666`;
    await writeFile(marker, W);
    await writeFile(real, `${DEAD} 0 ${AGO} 7777777777777777\n`);
    expect(await restore(marker, 3)).toBe(true);
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]);
    expect(await readFile(real, "utf8")).toBe(W);
    await rm(real);
    await writeFile(marker, W);
    await writeFile(real, `${process.pid} ${threadId} ${ORIGIN - 1} 8888888888888888\n`); // this thread, another incarnation: a previous one's
    expect(await restore(marker, 3)).toBe(true);
    expect(await readFile(real, "utf8")).toBe(W);
    expect(await restore(marker, 3)).toBe(true); // no marker: nothing left to restore
    await writeFile(marker, W); // already linked back by another restore: the marker alone goes
    expect(await restore(marker, 3)).toBe(true);
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]);
  });

  it("a holder displaced by a reclaimer that gave up still releases: its line goes from the marker, and from the name if a restore put it back meanwhile", async () => {
    const { real, local } = await place();
    const held = await own(real, LOCK, 3);
    const line = await readFile(real, "utf8");
    const marker = `${real}.reclaim.${LIVE}.0.${AGO}.9999999999999999`; // a live reclaimer stuck in its restore
    await rename(real, marker);
    await writeFile(real, T);
    await held.release();
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]); // the marker went, the taker's file is not this holder's to touch
    await rm(real);
    const again = await own(real, LOCK, 3);
    const line2 = await readFile(real, "utf8");
    expect(line2).not.toBe(line);
    await rename(real, marker);
    await link(marker, real); // a restore that linked back just before the release looked
    await again.release();
    expect((await readdir(local)).sort()).toEqual([]);
  });

  it("a line its holder is withdrawing — a notice of the take stands beside the name — is linked back and taken off again, and the marker goes; the notice is the holder's to remove while it lives, and swept once its process is gone", async () => {
    const { real, local } = await place();
    const marker = `${real}.reclaim.${DEAD}.0.${AGO}.aaaaaaaaaaaaaaaa`;
    await writeFile(marker, W);
    const notice = `owner.pid.withdraw.${LIVE}.0.${AGO}.1111111111111111`;
    await writeFile(path.join(local, notice), "");
    expect(await restore(marker, 3)).toBe(true);
    expect((await readdir(local)).sort()).toEqual([notice]);
    const taken = await own(real, LOCK, 3); // a live holder's notice is left alone: the name is free
    expect((await readdir(local)).sort()).toEqual(["owner.pid", notice]);
    await taken.release();
    expect((await readdir(local)).sort()).toEqual([notice]);
    await rm(path.join(local, notice));
    await writeFile(`${real}.withdraw.${DEAD}.0.${AGO}.bbbbbbbbbbbbbbbb`, "");
    const again = await own(real, LOCK, 3);
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]);
    await again.release();
    expect((await readdir(local)).sort()).toEqual([]);
  });
});

describe("a stale file at the name, taken off it by two sweepers at once", () => {
  /** `node:fs/promises` as the bundled copy sees it: the platform's one module object, whose methods the bundle looks up at each call. */
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");

  it("a sweeper that read a dead taker's file at the name and is held up before taking it off finds, when it goes on, a live holder's there — given its name back by the other sweeper meanwhile — and leaves it standing: what moved is judged, not what was read", async () => {
    const dir = await tempDir();
    const local = path.join(dir, ".estoc", "local");
    await mkdir(local, { recursive: true });
    const real = path.join(local, "owner.pid");
    const W = `${LIVE} 0 ${AGO} 1111111111111111\n`; // a live holder, moved aside by a reclaimer that then died
    const T = `${DEAD} 0 ${AGO} 2222222222222222\n`; // a taker that died at the name
    await writeFile(`${real}.reclaim.${DEAD}.0.${AGO}.3333333333333333`, W);
    await writeFile(real, T);
    const copy = loadCopy();
    // The first move or removal of the name — sweeper A's, once it has read T there — is held up until let go; every later one goes straight through.
    const originals = { rename: fsp.rename, rm: fsp.rm };
    const gate: { letGo: (() => void) | null; paused: Promise<void> } = { letGo: null, paused: Promise.resolve() };
    gate.paused = new Promise<void>((paused) => {
      const holdUp = <F extends (...args: never[]) => Promise<unknown>>(f: F): F =>
        (async (...args: Parameters<F>) => {
          if (gate.letGo === null && String(args[0]) === real) {
            await new Promise<void>((letGo) => {
              gate.letGo = letGo;
              paused();
            });
          }
          return f(...args);
        }) as F;
      fsp.rename = holdUp(originals.rename);
      fsp.rm = holdUp(originals.rm);
    });
    try {
      const a = new copy.FsBackend(dir).own(LOCK);
      void a.catch(() => undefined);
      await gate.paused;
      expect(await readFile(real, "utf8")).toBe(T); // A has read T and is about to take it off the name
      // B sweeps meanwhile: takes T off, gives W its name back, removes the marker, and is refused by W
      await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
      expect(await readFile(real, "utf8")).toBe(W);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      gate.letGo?.();
      await expect(a).rejects.toThrow(new RegExp(`process ${LIVE} holds it`)); // A moves W by its stale reading of T, sees what moved, gives it back, and is refused
      expect(await readFile(real, "utf8")).toBe(W);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
    } finally {
      fsp.rename = originals.rename;
      fsp.rm = originals.rm;
    }
  });
});

describe("a take that is over leaves nothing of its line behind", () => {
  /** `node:fs/promises` as the bundled copy sees it: the platform's one module object, whose methods the bundle looks up at each call. */
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  type Op = "readFile" | "rename" | "link" | "rm";
  type Gate = { paused: Promise<void>; letGo: () => void };
  const originals = { readFile: fsp.readFile, rename: fsp.rename, link: fsp.link, rm: fsp.rm };

  /** The copy's `nth` call of `op` that `where` picks, held up — before it runs, after it ran, after it failed, or after it settled either way — until let go. */
  function holdUp(op: Op, when: "before" | "after" | "failed" | "settled", where: (from: string, to: string) => boolean, nth = 1): Gate {
    const original = fsp[op] as (...args: unknown[]) => Promise<unknown>;
    let letGo = (): void => undefined;
    const goOn = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let hit = (): void => undefined;
    const paused = new Promise<void>((resolve) => {
      hit = resolve;
    });
    let seen = 0;
    (fsp as unknown as Record<Op, unknown>)[op] = async (...args: unknown[]) => {
      if (!where(String(args[0]), String(args[1] ?? "")) || ++seen < nth) return original(...args);
      (fsp as unknown as Record<Op, unknown>)[op] = original;
      if (when === "before") {
        hit();
        await goOn;
        return (fsp[op] as (...args: unknown[]) => Promise<unknown>)(...args); // through whatever gate was armed meanwhile
      }
      let result: unknown;
      try {
        result = await original(...args);
      } catch (err) {
        if (when === "failed" || when === "settled") {
          hit();
          await goOn;
        }
        throw err;
      }
      if (when === "after" || when === "settled") {
        hit();
        await goOn;
      }
      return result;
    };
    return { paused, letGo };
  }

  async function place(): Promise<{ dir: string; real: string; local: string }> {
    const dir = await tempDir();
    const local = path.join(dir, ".estoc", "local");
    await mkdir(local, { recursive: true });
    const real = path.join(local, "owner.pid");
    await writeFile(real, `${DEAD} 0 ${AGO} 2222222222222222\n`); // a taker that died at the name
    return { dir, real, local };
  }
  const isMarker = (from: string, to: string): boolean => from.includes(".reclaim.") && to.endsWith("owner.pid");
  /** The copy's disk has no hard links from here: what a USB stick, or a network mount, refuses. */
  const noLinks = (): void => {
    fsp.link = async () => {
      throw Object.assign(new Error("EOPNOTSUPP: operation not supported, link"), { code: "EOPNOTSUPP" });
    };
  };

  it("a holder whose line a reclaimer moved by mistake releases — the marker found, not yet removed — while the restore is about to link: the line is not left at the name — the restore finds the notice of the withdrawal and takes it off again — and the reclaimer, then anyone, can take the name", async () => {
    const { dir, real, local } = await place();
    const copy = loadCopy();
    try {
      const move = holdUp("rename", "before", (from) => from === real);
      const r = new copy.FsBackend(dir).own(LOCK);
      await move.paused; // R has read the dead taker's file and is about to take it off the name
      const w = await new copy.FsBackend(dir).own(LOCK); // W takes the dead file off itself, and the name
      const wLine = await readFile(real, "utf8");
      const put = holdUp("link", "before", isMarker);
      move.letGo(); // R's move takes W's live file by its stale reading; R sees what moved and sets out to give it back
      await put.paused;
      const [marker] = await localEntries(dir);
      expect(marker).toMatch(/^owner\.pid\.reclaim\./);
      expect(await readFile(path.join(local, marker as string), "utf8")).toBe(wLine);
      const drop = holdUp("rm", "before", (from) => from === path.join(local, marker as string));
      const release = w.release(); // W's withdrawal: its notice is written, the marker holding its line found and about to be removed
      await drop.paused;
      expect(await localEntries(dir)).toEqual([marker, `owner.pid.withdraw.${wLine.replace(LINE, "$1.$2.$3.$4")}`]);
      put.letGo(); // R links W's line back, finds the notice, takes the line off again, and takes the free name
      const held = await r;
      const rLine = await readFile(real, "utf8");
      expect(rLine).not.toBe(wLine);
      drop.letGo(); // W's removal finds the marker gone; its look at the name finds R's line there: nothing holds its own, and the notice goes
      await release;
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      expect(await readFile(real, "utf8")).toBe(rLine);
      await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
      await held.release();
      expect(await localEntries(dir)).toEqual([]);
      await (await new copy.FsBackend(dir).own(LOCK)).release();
    } finally {
      Object.assign(fsp, originals);
    }
  });

  it("a take that had its line at the name, lost it to a reclaimer's mistaken move, and is then refused by a taker withdraws the line from the marker before failing: nothing of a failed take bars the next", async () => {
    const { dir, real, local } = await place();
    const copy = loadCopy();
    try {
      const move = holdUp("rename", "before", (from) => from === real);
      const r = new copy.FsBackend(dir).own(LOCK);
      void r.catch(() => undefined);
      await move.paused;
      const look = holdUp("readFile", "before", (from) => from === real, 3); // A's read-back of the name, after its take and its look for markers
      const a = new copy.FsBackend(dir).own(LOCK);
      void a.catch(() => undefined);
      await look.paused;
      const aLine = await readFile(real, "utf8");
      expect(aLine.split(" ")[0]).toBe(String(process.pid));
      const put = holdUp("link", "before", isMarker);
      move.letGo(); // R's move takes A's file by its stale reading
      await put.paused;
      const [marker] = await localEntries(dir);
      expect(await readFile(path.join(local, marker as string), "utf8")).toBe(aLine);
      const miss = holdUp("readFile", "failed", (from) => from === real);
      look.letGo(); // A's read-back finds nothing at the name
      await miss.paused;
      const took = holdUp("rm", "after", (from) => from.includes(".claim."));
      const t = new copy.FsBackend(dir).own(LOCK); // T takes the free name, and is held before its look for markers
      await took.paused;
      miss.letGo(); // A tries again, sees T live at the name, and fails — its line withdrawn from R's marker first
      await expect(a).rejects.toThrow(/this thread of this process holds it/);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      took.letGo(); // T finds no marker and keeps the name
      put.letGo(); // R's link finds its marker gone, and R is refused by T
      const held = await t;
      await expect(r).rejects.toThrow(/this thread of this process holds it/);
      expect((await readFile(real, "utf8")).split(" ")[3]).not.toBe(aLine.split(" ")[3]);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      await held.release();
      expect(await localEntries(dir)).toEqual([]);
      await (await new copy.FsBackend(dir).own(LOCK)).release(); // this thread again: the failed take left nothing to refuse it
    } finally {
      Object.assign(fsp, originals);
    }
  });

  it("a take that gave the name up and tries again is a new line: the restore that had linked the old line back, and is late taking it off again, finds the new line where it expected the old, and gives it back — the holder keeps the name, the reclaimer is refused", async () => {
    const { dir, real, local } = await place();
    const copy = loadCopy();
    try {
      const move = holdUp("rename", "before", (from) => from === real);
      const r = new copy.FsBackend(dir).own(LOCK);
      void r.catch(() => undefined);
      await move.paused; // R has read the dead taker's file and is about to take it off the name
      const took = holdUp("rm", "after", (from) => from.includes(".claim."), 2); // A's second take — the first found the dead file, and took it off — has its line at the name and has not yet looked for markers
      const a = new copy.FsBackend(dir).own(LOCK);
      await took.paused;
      const aLine = await readFile(real, "utf8");
      expect(aLine.split(" ")[0]).toBe(String(process.pid));
      const put = holdUp("link", "before", isMarker);
      move.letGo(); // R's move takes A's file by its stale reading
      await put.paused;
      const [marker] = await localEntries(dir);
      expect(await readFile(path.join(local, marker as string), "utf8")).toBe(aLine);
      const drop = holdUp("rm", "before", (from) => from === path.join(local, marker as string));
      took.letGo(); // A sees R's marker and gives the name up: its notice is written, the marker holding its line found and about to be removed
      await drop.paused;
      expect(await localEntries(dir)).toEqual([marker, `owner.pid.withdraw.${aLine.replace(LINE, "$1.$2.$3.$4")}`]);
      const late = holdUp("rename", "before", (from) => from === real);
      put.letGo(); // R links A's line back, finds the notice, reads the line at the name and is held before taking it off
      await late.paused;
      expect(await readFile(real, "utf8")).toBe(aLine);
      drop.letGo(); // A's withdrawal finds the marker gone and its line at the name, takes it off, and A takes the name again — as a new line
      const held = await a;
      const again = await readFile(real, "utf8");
      expect(again).not.toBe(aLine);
      expect(again.split(" ")[0]).toBe(String(process.pid));
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      late.letGo(); // R's move takes the new line, which is not the one it expected: given back, and R is refused by it
      await expect(r).rejects.toThrow(/this thread of this process holds it/);
      expect(await readFile(real, "utf8")).toBe(again);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
      await held.release();
      expect(await localEntries(dir)).toEqual([]);
    } finally {
      Object.assign(fsp, originals);
    }
  });

  it("two sweeps restoring one dead reclaimer's marker while the holder it moved releases: the one that finds the line already linked back honours the notice too, and takes the line off — nothing of the released holder stays at the name", async () => {
    const { dir, real } = await place();
    const copy = loadCopy();
    try {
      const w = await new copy.FsBackend(dir).own(LOCK);
      const wLine = await readFile(real, "utf8");
      const marker = `${real}.reclaim.${DEAD}.0.${AGO}.cccccccccccccccc`; // a reclaimer moved W's live file aside by its stale reading, and died
      await rename(real, marker);
      const drop = holdUp("rm", "before", (from) => from === marker);
      const release = w.release(); // W's notice is written; the marker holding its line is found, and about to be removed
      await drop.paused;
      const linked = holdUp("link", "after", (from, to) => from === marker && to === real);
      const s1 = new copy.FsBackend(dir).own(LOCK); // S1's sweep links W's line back, and is held before its look for the notice
      void s1.catch(() => undefined);
      await linked.paused;
      expect(await readFile(real, "utf8")).toBe(wLine);
      const s2 = await new copy.FsBackend(dir).own(LOCK); // S2's sweep finds the line linked back already, finds the notice, takes the line off, and takes the free name
      const s2Line = await readFile(real, "utf8");
      expect(s2Line).not.toBe(wLine);
      expect(await localEntries(dir)).toEqual(["owner.pid", `owner.pid.withdraw.${wLine.replace(LINE, "$1.$2.$3.$4")}`]);
      drop.letGo(); // W's removal finds the marker gone already, and its line nowhere: done
      await release;
      linked.letGo(); // S1 finds no notice left, and is refused by S2
      await expect(s1).rejects.toThrow(/this thread of this process holds it/);
      expect(await readFile(real, "utf8")).toBe(s2Line);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      await s2.release();
      expect(await localEntries(dir)).toEqual([]);
      await (await new copy.FsBackend(dir).own(LOCK)).release();
    } finally {
      Object.assign(fsp, originals);
    }
  });

  it("a take whose line reached the name but whose claim could not be removed fails, and withdraws line and claim before it does: the same thread takes the name next", async () => {
    const { dir, real } = await place();
    await rm(real); // nothing at the name: the first take links its line there
    const copy = loadCopy();
    try {
      fsp.rm = async (...args: Parameters<typeof fsp.rm>) => {
        fsp.rm = originals.rm; // once: the disk is fine again after
        if (!String(args[0]).includes(".claim.")) return originals.rm(...args);
        throw Object.assign(new Error("EIO: i/o error, unlink"), { code: "EIO" });
      };
      await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(/EIO/);
      expect(await localEntries(dir)).toEqual([]);
      const held = await new copy.FsBackend(dir).own(LOCK);
      expect((await readFile(real, "utf8")).split(" ")[0]).toBe(String(process.pid));
      await held.release();
      expect(await localEntries(dir)).toEqual([]);
    } finally {
      Object.assign(fsp, originals);
    }
  });

  it("where the file system has no hard links a take is an exclusive create and a restore a rename: taken, refused, released with nothing left; a live holder's line a dead reclaimer moved aside is given back by the next take's sweep, which the line then refuses", async () => {
    const { dir, real } = await place();
    const copy = loadCopy();
    try {
      noLinks();
      const w = await new copy.FsBackend(dir).own(LOCK);
      const wLine = await readFile(real, "utf8");
      expect(wLine).toMatch(LINE);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
      await rename(real, `${real}.reclaim.${DEAD}.0.${AGO}.cccccccccccccccc`); // a reclaimer moved W's live file aside by its stale reading, and died
      await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
      expect(await readFile(real, "utf8")).toBe(wLine);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      await w.release();
      expect(await localEntries(dir)).toEqual([]);
      await (await new copy.FsBackend(dir).own(LOCK)).release();
      expect(await localEntries(dir)).toEqual([]);
    } finally {
      Object.assign(fsp, originals);
    }
  });

  it("a holder releasing while a reclaimer without hard links is about to give its line back by a rename — which takes the marker away as the line reaches the name — finds the line whichever side of the rename its withdrawal runs, since it looks at the markers before the name: here the marker goes first, the rename finds nothing to move, and nothing of the holder is left; the reclaimer takes the name", async () => {
    const { dir, real, local } = await place();
    const copy = loadCopy();
    try {
      noLinks();
      const move = holdUp("rename", "before", (from) => from === real);
      const r = new copy.FsBackend(dir).own(LOCK);
      await move.paused; // R has read the dead taker's file and is about to take it off the name
      const w = await new copy.FsBackend(dir).own(LOCK); // W takes the dead file off itself, and the name
      const wLine = await readFile(real, "utf8");
      const put = holdUp("rename", "before", isMarker);
      move.letGo(); // R's move takes W's live file by its stale reading; R sees what moved and sets out to give it back, by a rename
      await put.paused;
      const [marker] = await localEntries(dir);
      expect(marker).toMatch(/^owner\.pid\.reclaim\./);
      expect(await readFile(path.join(local, marker as string), "utf8")).toBe(wLine);
      const miss = holdUp("readFile", "failed", (from) => from === real);
      const release = w.release(); // W's withdrawal: its notice written, the marker holding its line found and removed, its look at the name finds nothing there
      await miss.paused;
      const notice = `owner.pid.withdraw.${wLine.replace(LINE, "$1.$2.$3.$4")}`;
      expect(await localEntries(dir)).toEqual([notice]);
      const renamed = holdUp("rename", "settled", isMarker);
      put.letGo(); // R's rename finds no marker left to move
      await renamed.paused;
      expect(await localEntries(dir)).toEqual([notice]);
      miss.letGo(); // W's look at the name, that found nothing, is handed back: the line is nowhere, and the notice goes
      await release;
      expect(await localEntries(dir)).toEqual([]);
      renamed.letGo(); // R: nothing left to restore, and the name is free
      const held = await r;
      const rLine = await readFile(real, "utf8");
      expect(rLine).not.toBe(wLine);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
      await held.release();
      expect(await localEntries(dir)).toEqual([]);
      await (await new copy.FsBackend(dir).own(LOCK)).release();
    } finally {
      Object.assign(fsp, originals);
    }
  });

  it("the other side of that rename: the holder's withdrawal has found the marker and is about to remove it when the reclaimer's rename gives the line back — the marker gone, the line at the name — and the withdrawal's look at the name, after its look at the markers, finds it there and takes it off; nothing of the holder is left, the reclaimer takes the name", async () => {
    const { dir, real, local } = await place();
    const copy = loadCopy();
    try {
      noLinks();
      const move = holdUp("rename", "before", (from) => from === real);
      const r = new copy.FsBackend(dir).own(LOCK);
      await move.paused;
      const w = await new copy.FsBackend(dir).own(LOCK);
      const wLine = await readFile(real, "utf8");
      const put = holdUp("rename", "before", isMarker);
      move.letGo();
      await put.paused;
      const [marker] = await localEntries(dir);
      expect(await readFile(path.join(local, marker as string), "utf8")).toBe(wLine);
      const drop = holdUp("rm", "before", (from) => from === path.join(local, marker as string));
      const release = w.release(); // W's withdrawal: its notice written, the marker holding its line found and about to be removed
      await drop.paused;
      const notice = `owner.pid.withdraw.${wLine.replace(LINE, "$1.$2.$3.$4")}`;
      expect(await localEntries(dir)).toEqual([marker, notice]);
      const renamed = holdUp("rename", "after", isMarker);
      put.letGo(); // R's rename gives W's line back, and the marker goes with it
      await renamed.paused;
      expect(await localEntries(dir)).toEqual(["owner.pid", notice]);
      expect(await readFile(real, "utf8")).toBe(wLine);
      drop.letGo(); // W's removal finds the marker gone; its look at the name finds its line, and takes it off: nowhere now, and the notice goes
      await release;
      expect(await localEntries(dir)).toEqual([]);
      renamed.letGo(); // R finds no notice left and nothing at the name: its restore is done, and the name is free
      const held = await r;
      expect(await readFile(real, "utf8")).not.toBe(wLine);
      expect(await localEntries(dir)).toEqual(["owner.pid"]);
      await held.release();
      expect(await localEntries(dir)).toEqual([]);
      await (await new copy.FsBackend(dir).own(LOCK)).release();
    } finally {
      Object.assign(fsp, originals);
    }
  });
});

describe("ownership across realms of one thread", () => {
  it("a copy of the module in another realm of this thread — its own global object; the platform's process, require and modules — is refused what this realm holds, and this realm what it holds: the disk says who, not memory", async () => {
    const dir = await tempDir();
    const realm = { module: { exports: {} as { FsBackend: typeof FsBackend } }, exports: {}, require: createRequire(import.meta.url), process, Buffer, setTimeout, clearTimeout, ReadableStream };
    realm.exports = realm.module.exports;
    runInNewContext(await readFile(bundle, "utf8"), realm, { filename: bundle });
    const other = realm.module.exports;
    const held = await new FsBackend(dir).own(LOCK);
    const line = await ownerFile(dir);
    await expect(new other.FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
    expect(await ownerFile(dir)).toBe(line); // nothing took the name over
    await held.release();
    const theirs = await new other.FsBackend(dir).own(LOCK);
    expect(await ownerFile(dir)).toMatch(new RegExp(`^${process.pid} ${threadId} ${ORIGIN} `)); // the same stamp from the other realm
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(/this thread of this process holds it/);
    await theirs.release();
    expect(await localEntries(dir)).toEqual([]);
  });
});

describe("a version-3 vault on disk", () => {
  it("what one instance committed and wrote, the next finds — events, objects, a portable file, the replica — and a rewrite leaves nothing beside the file", async () => {
    const dir = await tempDir();
    const vault = await FolderVault.create(new FsBackend(dir), { anchor: DID, keystore: KEYSTORE });
    const [event] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await vault.vault.files.write("notes/today.md", utf8("first"));
    await vault.vault.files.write("notes/today.md", utf8("second"));
    await vault.local("agent").writeOptions({ theme: "dark" });
    await vault.close();
    expect(await readdir(path.join(dir, ".estoc", "notes"))).toEqual(["today.md"]);
    expect(await readdir(path.join(dir, ".estoc", "local"))).toEqual(["accepted", "agent", "replica.json", "staging"]); // no pid file after close

    const next = await FolderVault.openWritable(new FsBackend(dir), { anchor: DID });
    expect(next.replica).toEqual(vault.replica);
    expect(ids(await all(next.vault.events.scan()))).toEqual([event?.eventId]);
    expectBytes(await next.vault.objects.read(HELLO_CID, 1024), HELLO);
    expectBytes(await next.vault.files.read("notes/today.md"), utf8("second"));
    expect(await next.local("agent").readOptions()).toEqual({ theme: "dark" });
    expect(await next.vault.files.list()).toEqual(["config.json", "keystore.json", "notes/today.md"]);
    await next.close();

    const reader = await FolderReader.open(new FsBackend(dir));
    expect(ids(await all(reader.events.scan()))).toEqual([event?.eventId]);
    await reader.close();
  });

  it("a second writer from another backend instance is refused while the first holds the folder, and served after it closes", async () => {
    const dir = await tempDir();
    const first = await FolderVault.create(new FsBackend(dir), { anchor: DID, keystore: KEYSTORE });
    await expect(FolderVault.openWritable(new FsBackend(dir), { anchor: DID })).rejects.toThrow(VaultOwned);
    await expect(FolderReader.open(new FsBackend(dir), { ownership: "exclusive" })).rejects.toThrow(VaultOwned);
    const reader = await FolderReader.open(new FsBackend(dir));
    expect(await reader.files.list()).toEqual(["config.json", "keystore.json"]);
    await reader.close();
    await first.close();
    const second = await FolderVault.openWritable(new FsBackend(dir), { anchor: DID });
    await second.close();
  });

  it("an empty import/ directory is nothing pending; a file in it blocks the open", async () => {
    const dir = await tempDir();
    const vault = await FolderVault.create(new FsBackend(dir), { anchor: DID, keystore: KEYSTORE });
    await vault.close();
    await mkdir(path.join(dir, ".estoc", "import"), { recursive: true });
    const again = await FolderVault.openWritable(new FsBackend(dir), { anchor: DID });
    await again.close();
    await writeFile(path.join(dir, ".estoc", "import", "journal.json"), "{}");
    await expect(FolderVault.openWritable(new FsBackend(dir), { anchor: DID })).rejects.toThrow(/import\/ holds recovery state \(journal.json\)/);
    expect(await readdir(path.join(dir, ".estoc", "local"))).toEqual(["replica.json"]); // ownership released: no pid file left
  });
});
