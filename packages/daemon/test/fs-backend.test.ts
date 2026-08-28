import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

import { FsBackend } from "../src/node/index.js";
import { backendSuite } from "../../agent-core/test/backend-suite.js";

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
