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

describe("FsBackend.own (vault-folder.md §15)", () => {
  it("is a pid file: taken exclusively, refused while this process holds it, released by removing it", async () => {
    const dir = await tempDir();
    const backend = new FsBackend(dir);
    const held = await backend.own(`.estoc/${OWNER_FILE}`);
    expect((await readFile(path.join(dir, ".estoc", "local", "owner.pid"), "utf8")).trim()).toBe(String(process.pid));
    await expect(new FsBackend(dir).own(`.estoc/${OWNER_FILE}`)).rejects.toThrow(VaultOwned);
    await expect(new FsBackend(dir).own(`.estoc/${OWNER_FILE}`)).rejects.toThrow(/this process holds it already/);
    await held.release();
    expect(await readdir(path.join(dir, ".estoc", "local"))).toEqual([]);
    const again = await backend.own(`.estoc/${OWNER_FILE}`);
    await again.release();
  });

  it("a pid file naming a live process refuses; one naming a process that is gone is stale and taken over; the pid is read for liveness only", async () => {
    const dir = await tempDir();
    const file = path.join(dir, ".estoc", "local", "owner.pid");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${process.ppid}\n`); // the test runner's parent: alive, and not this process
    await expect(new FsBackend(dir).own(`.estoc/${OWNER_FILE}`)).rejects.toThrow(new RegExp(`process ${process.ppid} holds it`));
    await writeFile(file, "4194305\n"); // above Linux's largest pid: nobody
    const taken = await new FsBackend(dir).own(`.estoc/${OWNER_FILE}`);
    expect((await readFile(file, "utf8")).trim()).toBe(String(process.pid));
    await taken.release();
    await writeFile(file, "not a pid\n");
    const garbage = await new FsBackend(dir).own(`.estoc/${OWNER_FILE}`);
    await garbage.release();
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
