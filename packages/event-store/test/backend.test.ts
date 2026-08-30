import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
  it("keeps the mode of a file it replaces", async () => {
    const dir = await tempDir();
    const backend = new FsBackend(dir);
    await backend.write(".estoc/keystore.json", new TextEncoder().encode("{}"));
    await chmod(path.join(dir, ".estoc", "keystore.json"), 0o600);
    await backend.write(".estoc/keystore.json", new TextEncoder().encode('{"v":2}'));
    expect((await stat(path.join(dir, ".estoc", "keystore.json"))).mode & 0o777).toBe(0o600);
  });
});
