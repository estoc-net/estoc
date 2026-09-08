/**
 * The vault on a real disk (vault-folder.md §15, VF-32, VF-34): what the
 * memory backend cannot show — a pid file as ownership, a second process's
 * stale pid taken over, a reopen from another backend instance finding
 * what the last one wrote, and a whole-file write that leaves nothing
 * beside the file.
 */

import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
const LINE = /^([1-9][0-9]*) ([0-9]+) ([0-9a-f]{16})\n$/;
/** A pid nobody has: above Linux's largest. */
const DEAD = 4194305;
/** A pid that is alive and not this process: the test runner's parent. */
const LIVE = process.ppid;

async function ownerFile(dir: string): Promise<string> {
  return readFile(path.join(dir, ".estoc", "local", "owner.pid"), "utf8");
}

async function localEntries(dir: string): Promise<string[]> {
  return (await readdir(path.join(dir, ".estoc", "local"))).sort();
}

describe("FsBackend.own (vault-folder.md §15)", () => {
  it("is a pid file holding this process's pid and a token: taken whole, refused while this process holds it, removed at release with nothing left beside it", async () => {
    const dir = await tempDir();
    const backend = new FsBackend(dir);
    const held = await backend.own(LOCK);
    const line = await ownerFile(dir);
    expect(line).toMatch(LINE);
    expect(line.split(" ")[0]).toBe(String(process.pid));
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(VaultOwned);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(/this process holds it already/);
    await held.release();
    expect(await localEntries(dir)).toEqual([]);
    const again = await backend.own(LOCK);
    expect(await ownerFile(dir)).not.toBe(line); // a new take, a new token
    await again.release();
  });

  it("r1-A: two takes racing in one process have exactly one winner, whichever backend instance each came through", async () => {
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
    await writeFile(file, `${LIVE} 0 0123456789abcdef\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect(await ownerFile(dir)).toBe(`${LIVE} 0 0123456789abcdef\n`);
    await writeFile(file, `${DEAD} 0 0123456789abcdef\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect((await ownerFile(dir)).split(" ")[0]).toBe(String(process.pid));
    expect(await localEntries(dir)).toEqual(["owner.pid"]); // the reclaim left no marker
    await taken.release();
  });

  it("r1-G: an empty file, garbage, or another format is not a live holder: reclaimed and taken over", async () => {
    for (const residue of ["", "not a pid\n", "0 0 0123456789abcdef\n", `${process.pid}\n`, "-1 0 0123456789abcdef\n", `${LIVE}\n`, `${LIVE} 0123456789abcdef\n`, `${process.pid} 0123456789abcdef\n`]) {
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

  it("r1-A: a file naming this process without this process's record is a previous incarnation's, stale", async () => {
    const dir = await tempDir();
    const file = path.join(dir, ".estoc", "local", "owner.pid");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${process.pid} ${threadId} 0123456789abcdef\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect(await ownerFile(dir)).not.toBe(`${process.pid} ${threadId} 0123456789abcdef\n`);
    await taken.release();
    // r2-A: one naming another thread of this process is that thread's, live
    await writeFile(file, `${process.pid} ${threadId + 1000} 0123456789abcdef\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`thread ${threadId + 1000} of this process holds it`));
    expect(await ownerFile(dir)).toBe(`${process.pid} ${threadId + 1000} 0123456789abcdef\n`);
    await rm(file);
  });

  it("r1-A: release removes the file only while it is still this take's; a name that changed hands is left alone", async () => {
    const dir = await tempDir();
    const file = path.join(dir, ".estoc", "local", "owner.pid");
    const held = await new FsBackend(dir).own(LOCK);
    await rm(file);
    await writeFile(file, `${LIVE} 0 fedcba9876543210\n`); // another holder, by force
    await held.release();
    expect(await ownerFile(dir)).toBe(`${LIVE} 0 fedcba9876543210\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(VaultOwned);
    await rm(file);
  });

  it("r1-A: what a reclaimer or taker that died left beside the file is swept — a marker holding a live holder's file gives that holder its name back", async () => {
    const dir = await tempDir();
    const local = path.join(dir, ".estoc", "local");
    await mkdir(local, { recursive: true });
    // a dead reclaimer moved a live holder's file aside and never put it back
    await writeFile(path.join(local, `owner.pid.reclaim.${DEAD}.0.0123456789abcdef`), `${LIVE} 0 1111111111111111\n`);
    await writeFile(path.join(local, `owner.pid.claim.${DEAD}.0.2222222222222222`), `${DEAD} 0 2222222222222222\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    expect(await ownerFile(dir)).toBe(`${LIVE} 0 1111111111111111\n`);
    await rm(path.join(local, "owner.pid"));
    // a dead reclaimer's marker holding a dead holder's file is just removed
    await writeFile(path.join(local, `owner.pid.reclaim.${DEAD}.0.3333333333333333`), `${DEAD} 0 3333333333333333\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    await taken.release();
    // a live reclaimer's marker is its own: a taker gives the name up and waits it out
    await writeFile(path.join(local, `owner.pid.reclaim.${LIVE}.0.4444444444444444`), `${DEAD} 0 4444444444444444\n`);
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
    await rm(path.join(local, `owner.pid.reclaim.${LIVE}.0.4444444444444444`)); // the reclaimer finishes
    const settled = await waiting;
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    await settled.release();
  });
});

describe("ownership across threads and module copies (r2-A)", () => {
  /** The ownership module bundled on its own: another copy of it, as a worker loads, or a second bundle in one thread. */
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

  it("r2-A: a worker of this process — same pid, its own thread and module copy — is refused what this thread holds, and this thread what a worker holds", async () => {
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

  it("r2-A: two workers of this process exclude each other", async () => {
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

  it("r2-A: a second copy of the module in this thread shares its registry: what one copy holds the other refuses at once, and a take through either has one winner", async () => {
    const dir = await tempDir();
    const copy = loadCopy();
    const held = await new FsBackend(dir).own(LOCK);
    await expect(new copy.FsBackend(dir).own(LOCK)).rejects.toThrow(/this process holds it already/);
    await held.release();
    const attempts = await Promise.allSettled([new copy.FsBackend(dir).own(LOCK), new FsBackend(dir).own(LOCK)]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    for (const a of attempts) if (a.status === "fulfilled") await a.value.release();
    expect(await localEntries(dir)).toEqual([]);
  });
});

describe("a reclaim that cannot give a moved holder its name back (r2-C)", () => {
  /** The name and its directory, made; `attempts` small so a stalled taker exhausts a restore within the test. */
  async function place(): Promise<{ real: string; local: string }> {
    const dir = await tempDir();
    const local = path.join(dir, ".estoc", "local");
    await mkdir(local, { recursive: true });
    return { real: path.join(local, "owner.pid"), local };
  }
  const W = `${LIVE} 0 1111111111111111\n`; // a live holder, moved aside
  const T = `${LIVE} 7 2222222222222222\n`; // a live taker's file, standing at the name and not given up

  it("r2-C: a restore that runs out of patience leaves the marker — the moved holder's record — in place; a taker meanwhile sees the live file, and one after the taker gave up is barred by the marker until the restore completes", async () => {
    const { real, local } = await place();
    const marker = `${real}.reclaim.${DEAD}.0.3333333333333333`;
    await writeFile(marker, W);
    await writeFile(real, T);
    expect(await restore(marker, 3)).toBe(false);
    expect((await readdir(local)).sort()).toEqual([`owner.pid`, `owner.pid.reclaim.${DEAD}.0.3333333333333333`]);
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

  it("r2-C: the reclaimer whose restore gave up fails its take with the marker standing, and its next take — the marker its own, no longer in flight — restores first", async () => {
    const { real, local } = await place();
    const stale = `${DEAD} 0 4444444444444444\n`;
    await writeFile(real, stale);
    // W took the name between this reclaimer's look and its move, and a taker T took it after the move: the state after the move
    // is laid out by hand — the marker, this thread's and no longer in flight, holds W, not what was seen; T stands at the name —
    // and the reclaimer's own restore is what `own` runs through `sweep`.
    const marker = `${real}.reclaim.${process.pid}.${threadId}.5555555555555555`;
    await writeFile(marker, W);
    await writeFile(real, T);
    await expect(own(real, LOCK, 3)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect((await readdir(local)).sort()).toEqual(["owner.pid", `owner.pid.reclaim.${process.pid}.${threadId}.5555555555555555`]); // the marker stands: W's record bars every taker
    await rm(real);
    await expect(own(real, LOCK, 3)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]);
    expect(await readFile(real, "utf8")).toBe(W);
  });

  it("r2-C: a stale file at the name — a taker that died, a previous incarnation — is removed by the restore, which then completes; a marker gone from under it, or already linked back, is done", async () => {
    const { real, local } = await place();
    const marker = `${real}.reclaim.${DEAD}.0.6666666666666666`;
    await writeFile(marker, W);
    await writeFile(real, `${DEAD} 0 7777777777777777\n`);
    expect(await restore(marker, 3)).toBe(true);
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]);
    expect(await readFile(real, "utf8")).toBe(W);
    await rm(real);
    await writeFile(marker, W);
    await writeFile(real, `${process.pid} ${threadId} 8888888888888888\n`); // this thread, no record of it: a previous incarnation's
    expect(await restore(marker, 3)).toBe(true);
    expect(await readFile(real, "utf8")).toBe(W);
    expect(await restore(marker, 3)).toBe(true); // no marker: nothing left to restore
    await writeFile(marker, W); // already linked back by another restore: the marker alone goes
    expect(await restore(marker, 3)).toBe(true);
    expect((await readdir(local)).sort()).toEqual(["owner.pid"]);
  });

  it("r2-C: a holder displaced by a reclaimer that gave up still releases: its line goes from the marker, and from the name if a restore put it back meanwhile", async () => {
    const { real, local } = await place();
    const held = await own(real, LOCK, 3);
    const line = await readFile(real, "utf8");
    const marker = `${real}.reclaim.${LIVE}.0.9999999999999999`; // a live reclaimer stuck in its restore
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
});

describe("a version-3 vault on disk", () => {
  it("VF-32, VF-34: what one instance committed and wrote, the next finds — events, objects, a portable file, the replica — and a rewrite leaves nothing beside the file", async () => {
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

  it("§15: a second writer from another backend instance is refused while the first holds the folder, and served after it closes", async () => {
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
