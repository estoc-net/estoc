import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { FsBackend } from "../src/node.js";
import { backendSuite } from "./backend-suite.js";

const made: string[] = [];
backendSuite("fs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "estoc-fs-"));
  made.push(dir);
  return new FsBackend(dir);
});
afterAll(async () => {
  for (const dir of made) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("fs backend on disk", () => {
  it("keeps the mode of a file it replaces", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "estoc-fs-"));
    made.push(dir);
    const backend = new FsBackend(dir);
    await backend.write(".estoc/keystore.json", new TextEncoder().encode("{}"));
    await chmod(path.join(dir, ".estoc", "keystore.json"), 0o600);
    await backend.write(".estoc/keystore.json", new TextEncoder().encode('{"v":2}'));
    expect((await stat(path.join(dir, ".estoc", "keystore.json"))).mode & 0o777).toBe(0o600);
  });
});
