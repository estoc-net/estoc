/**
 * Restore and import over `node:sqlite`: the cross-platform cases on
 * files, and what only a path shows — a restore into a destination
 * kept in either journal, reopening the same.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "../../../src/node.js";
import { SqliteVault, createRuntime, exportVault, openPortable, openRuntime, restoreVault, type OpenMode, type SqliteDriver } from "../../../src/v3/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { all } from "../suite/helpers.js";
import { importCases, type ImportHarness } from "./import-cases.js";
import { HELLO, HELLO_CID, draft, rootsOf } from "./vault-cases.js";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-import-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (target: string, mode: OpenMode): SqliteDriver => openNodeSqlite(target, { mode });

describe("the import cases on node:sqlite files", () => {
  const harness: ImportHarness = {
    fresh,
    open: async (target, mode) => open(target, mode),
    fileBytes: async (target) => new Uint8Array(await readFile(target)),
    importFile: (target, bytes) => writeFile(target, bytes),
  };
  for (const c of importCases) {
    it(c.name, async () => {
      const note = await c.run(harness);
      if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
    });
  }
});

describe("restoreVault on a path", () => {
  it("lays the runtime in whatever journal the destination was created with, and the same open reopens it", async () => {
    const vault = new SqliteVault(createRuntime(open(fresh(), "create"), { metadata: META, wrapped: WRAPPED }));
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const exported = fresh();
    await exportVault(vault, (mode) => open(exported, mode), { heldRoots: rootsOf });
    await vault.close();
    for (const journal of ["wal", "delete"] as const) {
      const snapshot = openPortable(open(exported, "readonly"));
      const target = fresh();
      let restored;
      try {
        restored = await restoreVault(snapshot, (mode) => openNodeSqlite(target, mode === "create" ? { mode, journal } : { mode }), { heldRoots: rootsOf, anchor: ANCHOR });
      } finally {
        snapshot.close();
      }
      expect(restored).toMatchObject({ events: 1, objects: 1, objectBytes: 5 });
      const first = new SqliteVault(restored.runtime);
      expect((await all(first.vault.events.scan())).map((e) => e.roots)).toEqual([[HELLO_CID]]);
      await first.close();
      const again = new SqliteVault(await openRuntime(open(target, "readwrite"), { anchor: ANCHOR }));
      try {
        expect([again.author, again.generation]).toEqual([restored.runtime.author, restored.runtime.generation]);
        expect((await all(again.vault.events.scan())).length).toBe(1);
      } finally {
        await again.close();
      }
    }
  });
});
