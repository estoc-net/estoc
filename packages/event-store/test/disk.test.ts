/**
 * The folder on a real disk: what the memory backend cannot show — a
 * rename-into-place rewrite renewing a modification time, a reopen
 * finding what the last process wrote, a fragment healed on disk.
 */

import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DEVICE_MINTED, FolderVault, isSegmentName } from "../src/index.js";
import { FsBackend } from "../src/node.js";
import { HELLO_CID } from "./suite/blob-suite.js";
import { all } from "./suite/helpers.js";

const enc = new TextEncoder();
const made: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "estoc-vault-"));
  made.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of made) {
    await rm(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("a vault on disk", () => {
  it("writes files beside each other and over themselves: a directory on disk is not a file in the way", async () => {
    const backend = new FsBackend(await tempDir());
    const vault = await FolderVault.create(backend, {});
    await vault.files.write("state/a.json", enc.encode("a"));
    await vault.files.write("state/b.json", enc.encode("b"));
    await vault.files.write("state/b.json", enc.encode("b2"));
    await vault.files.write("config-notes/x", enc.encode("x")); // a sibling of config.json, not under it
    expect(await vault.files.list()).toEqual(["config-notes/x", "config.json", "state/a.json", "state/b.json"]);
    await expect(vault.files.write("state", enc.encode(""))).rejects.toThrow(/is a directory/);
    await expect(vault.files.write("config.json/x", enc.encode(""))).rejects.toThrow(/is a file/);
    expect(await vault.files.read("state")).toBeNull();
  });

  it("lays the tree out as vault-folder.md §3 draws it, and a second process carries on", async () => {
    const dir = await tempDir();
    const backend = new FsBackend(dir);
    const vault = await FolderVault.create(backend, { identity: { anchor: { key: "anchor", did: "did:key:z6MkTest" } } });
    const first = await vault.events.append({ type: "t", data: { n: 1 } });
    expect(await vault.blobs.put(enc.encode("hello"))).toBe(HELLO_CID);
    await vault.files.write("keystore.json", enc.encode("{}"));
    await vault.local("agent").writeOptions({ trace: "off" });

    expect((await readdir(path.join(dir, ".estoc"))).sort()).toEqual(["blobs", "config.json", "devices", "keystore.json", "local"]);
    expect(await readdir(path.join(dir, ".estoc", "devices"))).toEqual([vault.self]);
    const segments = await readdir(path.join(dir, ".estoc", "devices", vault.self));
    expect(segments).toHaveLength(1);
    expect(isSegmentName(segments[0] as string)).toBe(true);
    expect(await readdir(path.join(dir, ".estoc", "blobs"))).toEqual([HELLO_CID]);
    expect(await readFile(path.join(dir, ".estoc", "blobs", HELLO_CID), "utf8")).toBe("hello");
    expect((await readdir(path.join(dir, ".estoc", "local"))).sort()).toEqual(["agent", "self.json"]);
    const lines = (await readFile(path.join(dir, ".estoc", "devices", vault.self, segments[0] as string), "utf8")).split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: DEVICE_MINTED, author: vault.self });
    expect(JSON.parse(lines[1] as string)).toEqual(first);

    // the next process: same device, same segment, what was written is there
    const again = await FolderVault.open(new FsBackend(dir));
    expect(again.self).toBe(vault.self);
    await again.events.append({ type: "t", data: { n: 2 } });
    expect(await readdir(path.join(dir, ".estoc", "devices", vault.self))).toEqual(segments);
    expect((await all(again.events.scan({ type: "t" }))).map((e) => e.data["n"])).toEqual([1, 2]);
    expect(await again.blobs.get(HELLO_CID)).toEqual(enc.encode("hello"));
    expect(await again.local("agent").readOptions()).toEqual({ trace: "off" });
    expect(await again.files.list()).toEqual(["config.json", "keystore.json"]);
  });

  it("renews a block's modification time by rewriting it in place", async () => {
    const backend = new FsBackend(await tempDir());
    // the disk's mtime is real; the store's idea of now is the wall clock plus what the test adds
    let offset = 0;
    const HOUR = 60 * 60 * 1000;
    const vault = await FolderVault.create(backend, {}, { graceMs: HOUR, clock: () => new Date(Date.now() + offset) });
    await vault.blobs.put(enc.encode("hello"));
    const first = await backend.modified(`.estoc/blobs/${HELLO_CID}`);
    await sleep(25);
    await vault.blobs.put(enc.encode("hello"));
    const second = await backend.modified(`.estoc/blobs/${HELLO_CID}`);
    expect(second).toBeGreaterThan(first as number);
    expect(await vault.blobs.collect([])).toEqual({ unlinked: [], young: [HELLO_CID] });
    offset = HOUR + 1000;
    expect(await vault.blobs.collect([])).toEqual({ unlinked: [HELLO_CID], young: [] });
  });

  it("heals a fragment on disk before the first append of the next process", async () => {
    const dir = await tempDir();
    const vault = await FolderVault.create(new FsBackend(dir), {});
    const segment = (await readdir(path.join(dir, ".estoc", "devices", vault.self)))[0] as string;
    const file = path.join(dir, ".estoc", "devices", vault.self, segment);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, '{"eid":"0199');
    const next = await FolderVault.open(new FsBackend(dir));
    await next.events.append({ type: "t", data: {} });
    const text = await readFile(file, "utf8");
    expect(text).toMatch(/\n\{"eid":"0199\n\{"eid"/);
    expect(text.endsWith("\n")).toBe(true);
    expect(await all(next.events.scan())).toHaveLength(2);
    expect(next.events.damaged()).toHaveLength(1);
  });
});
