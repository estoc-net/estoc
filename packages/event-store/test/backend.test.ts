import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { tempName, unfinishedWriteOf } from "../src/backend/types.js";
import { MemoryBackend } from "../src/index.js";
import { FsBackend } from "../src/node.js";
import { backendSuite } from "./suite/backend-suite.js";
import { clock } from "./suite/helpers.js";

backendSuite("memory", async () => new MemoryBackend());

const made: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "estoc-es-"));
  made.push(dir);
  return dir;
}
backendSuite("fs", async () => new FsBackend(await tempDir()));
afterAll(async () => {
  for (const dir of made) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("memory backend", () => {
  it("a Node Buffer written, first-appended or read is copied — `Buffer#slice` is a view, so the file would otherwise follow the caller's later writes", async () => {
    for (const method of ["write", "append"] as const) {
      const b = new MemoryBackend();
      const input = Buffer.from([1, 2, 3]);
      await b[method]("f", input);
      input[0] = 9;
      const read = (await b.read("f")) as Uint8Array;
      expect(Array.from(read)).toEqual([1, 2, 3]);
      read[1] = 8;
      expect(Array.from((await b.read("f")) as Uint8Array)).toEqual([1, 2, 3]);
      expect(b.files.get("f")).not.toBeInstanceOf(Buffer);
    }
  });

  it("dates a write by the clock it was given", async () => {
    const c = clock("2026-08-30T10:00:00Z");
    const b = new MemoryBackend({ clock: c.now });
    await b.write("a", new Uint8Array([1]));
    expect(await b.modified("a")).toBe(c.now().getTime());
    c.advance(1000);
    await b.append("a", new Uint8Array([2]));
    expect(await b.modified("a")).toBe(c.now().getTime());
  });
});

describe("fs backend on disk", () => {
  it("writes a whole file beside its place under the name `tempName` gives, which `unfinishedWriteOf` reads back, so that what a process that dies mid-write leaves is known by name", async () => {
    const dir = await tempDir();
    const b = new FsBackend(dir);
    let beside: string[] = [];
    await b.create("a/b.txt", (async function* () {
      yield new Uint8Array([1]);
      beside = await b.list("a");
      yield new Uint8Array([2]);
    })());
    expect(beside.length).toBe(1);
    expect(unfinishedWriteOf(beside[0] as string)).toBe("b.txt");
    expect(await b.list("a")).toEqual(["b.txt"]);
    expect(unfinishedWriteOf(tempName("b.txt"))).toBe("b.txt");
    expect(unfinishedWriteOf(tempName("journal.json"))).toBe("journal.json");
    expect(tempName("b.txt")).not.toBe(tempName("b.txt"));
    for (const other of ["b.txt", "b.txt.tmp", "b.txt.abc.tmp", "b.txt.0123456789ab.tmp.1", ".0123456789ab.tmp"]) expect(unfinishedWriteOf(other), other).toBeNull();
  });

  it("keeps the mode of a file it replaces", async () => {
    const dir = await tempDir();
    const backend = new FsBackend(dir);
    await backend.write(".estoc/keystore.json", new TextEncoder().encode("{}"));
    await chmod(path.join(dir, ".estoc", "keystore.json"), 0o600);
    await backend.write(".estoc/keystore.json", new TextEncoder().encode('{"v":2}'));
    expect((await stat(path.join(dir, ".estoc", "keystore.json"))).mode & 0o777).toBe(0o600);
  });
});
