import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, it } from "vitest";

import { FsBackend } from "../../../src/node.js";
import { MemoryBackend } from "../../../src/v3/index.js";
import { folderObjectCases, type Fresh } from "../suite/folder-object-cases.js";

/** The folder object cases as a vitest suite: memory and disk run them here, OPFS runs the same cases in a browser (`../../opfs.test.ts`). */
function suite(name: string, fresh: Fresh): void {
  describe(`FolderObjectStore ${name}: folderObjectCases`, () => {
    for (const c of folderObjectCases) {
      it(c.name, () => c.run(fresh));
    }
  });
}

suite("over MemoryBackend", async () => new MemoryBackend());

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
suite("over FsBackend", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "estoc-v3-object-cases-"));
  dirs.push(dir);
  return new FsBackend(dir);
});
