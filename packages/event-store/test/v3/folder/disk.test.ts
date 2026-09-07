/**
 * The vault on a real disk (vault-folder.md §15, VF-32, VF-34): what the
 * memory backend cannot show — a pid file as ownership, a second process's
 * stale pid taken over, a reopen from another backend instance finding
 * what the last one wrote, and a whole-file write that leaves nothing
 * beside the file.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FsBackend } from "../../../src/node.js";
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
const LINE = /^([1-9][0-9]*) ([0-9a-f]{16})\n$/;
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
    await writeFile(file, `${LIVE} 0123456789abcdef\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect(await ownerFile(dir)).toBe(`${LIVE} 0123456789abcdef\n`);
    await writeFile(file, `${DEAD} 0123456789abcdef\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect((await ownerFile(dir)).split(" ")[0]).toBe(String(process.pid));
    expect(await localEntries(dir)).toEqual(["owner.pid"]); // the reclaim left no marker
    await taken.release();
  });

  it("r1-G: an empty file, garbage, or another format is not a live holder: reclaimed and taken over", async () => {
    for (const residue of ["", "not a pid\n", "0 0123456789abcdef\n", `${process.pid}\n`, "-1 0123456789abcdef\n", `${LIVE}\n`]) {
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
    await writeFile(file, `${process.pid} 0123456789abcdef\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect(await ownerFile(dir)).not.toBe(`${process.pid} 0123456789abcdef\n`);
    await taken.release();
  });

  it("r1-A: release removes the file only while it is still this take's; a name that changed hands is left alone", async () => {
    const dir = await tempDir();
    const file = path.join(dir, ".estoc", "local", "owner.pid");
    const held = await new FsBackend(dir).own(LOCK);
    await rm(file);
    await writeFile(file, `${LIVE} fedcba9876543210\n`); // another holder, by force
    await held.release();
    expect(await ownerFile(dir)).toBe(`${LIVE} fedcba9876543210\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(VaultOwned);
    await rm(file);
  });

  it("r1-A: what a reclaimer or taker that died left beside the file is swept — a marker holding a live holder's file gives that holder its name back", async () => {
    const dir = await tempDir();
    const local = path.join(dir, ".estoc", "local");
    await mkdir(local, { recursive: true });
    // a dead reclaimer moved a live holder's file aside and never put it back
    await writeFile(path.join(local, `owner.pid.reclaim.${DEAD}.0123456789abcdef`), `${LIVE} 1111111111111111\n`);
    await writeFile(path.join(local, `owner.pid.claim.${DEAD}.2222222222222222`), `${DEAD} 2222222222222222\n`);
    await expect(new FsBackend(dir).own(LOCK)).rejects.toThrow(new RegExp(`process ${LIVE} holds it`));
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    expect(await ownerFile(dir)).toBe(`${LIVE} 1111111111111111\n`);
    await rm(path.join(local, "owner.pid"));
    // a dead reclaimer's marker holding a dead holder's file is just removed
    await writeFile(path.join(local, `owner.pid.reclaim.${DEAD}.3333333333333333`), `${DEAD} 3333333333333333\n`);
    const taken = await new FsBackend(dir).own(LOCK);
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    await taken.release();
    // a live reclaimer's marker is its own: a taker gives the name up and waits it out
    await writeFile(path.join(local, `owner.pid.reclaim.${LIVE}.4444444444444444`), `${DEAD} 4444444444444444\n`);
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
    await rm(path.join(local, `owner.pid.reclaim.${LIVE}.4444444444444444`)); // the reclaimer finishes
    const settled = await waiting;
    expect(await localEntries(dir)).toEqual(["owner.pid"]);
    await settled.release();
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
