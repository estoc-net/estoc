/**
 * Export, portable validation and inspection over `node:sqlite`: the
 * cross-platform export cases on files, and what only a path on disk
 * can show — the file standing alone, no sidecar beside it, shared by
 * two readers; an inspector's export; a destination that is not
 * fresh; a file torn under its schema.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "../../../src/node.js";
import {
  DatabaseClosed,
  InvalidSnapshot,
  NotAVault,
  SqliteVault,
  createRuntime,
  exportVault,
  openInspector,
  openPortable,
  validatePortable,
  type OpenDestination,
  type OpenMode,
  type SqliteDriver,
} from "../../../src/v3/index.js";
import { META, WRAPPED } from "../fixtures.js";
import { all } from "../suite/helpers.js";
import { exportCases, type ExportHarness } from "./export-cases.js";
import { HELLO, HELLO_CID, draft, rootsOf } from "./vault-cases.js";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-export-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (target: string, mode: OpenMode): SqliteDriver => openNodeSqlite(target, { mode });
const at = (target: string): OpenDestination => (mode) => open(target, mode);

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** A vault at a fresh file holding one commit, closed. */
async function seeded(): Promise<string> {
  const file = fresh();
  const vault = new SqliteVault(createRuntime(open(file, "create"), { metadata: META, wrapped: WRAPPED }));
  await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
  await vault.close();
  return file;
}

describe("the export cases on node:sqlite files", () => {
  const harness: ExportHarness = {
    fresh,
    open: async (target, mode) => open(target, mode),
    fileBytes: async (target) => new Uint8Array(await readFile(target)),
  };
  for (const c of exportCases) {
    it(c.name, async () => {
      const note = await c.run(harness);
      if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
    });
  }
});

describe("exportVault on a path", () => {
  it("leaves a standalone rollback-journal file with no sidecar, whatever journal the destination was created with, that two readers may hold at once", async () => {
    const vault = new SqliteVault(createRuntime(open(fresh(), "create"), { metadata: META, wrapped: WRAPPED }));
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    for (const journal of ["wal", "delete"] as const) {
      const target = fresh();
      expect(await exportVault(vault, (mode) => openNodeSqlite(target, mode === "create" ? { mode, journal } : { mode }), { heldRoots: rootsOf })).toEqual({ events: 1, eventBytes: expect.any(Number), objects: 1, objectBytes: 5 });
      expect(await exists(`${target}-journal`), `${journal}: no journal beside the file`).toBe(false);
      expect(await exists(`${target}-wal`), `${journal}: no WAL beside the file`).toBe(false);
      expect(await exists(`${target}-shm`), `${journal}: no shm beside the file`).toBe(false);
      expect(Array.from((await readFile(target)).subarray(18, 20)), `${journal}: rollback-format headers`).toEqual([1, 1]);
      const first = openPortable(open(target, "readonly"));
      const second = openPortable(open(target, "readonly"));
      try {
        expect(await validatePortable(first, { heldRoots: rootsOf })).toEqual({ events: 1, eventBytes: expect.any(Number), objects: 1, objectBytes: 5 });
        expect(await validatePortable(second, { heldRoots: rootsOf })).toEqual({ events: 1, eventBytes: expect.any(Number), objects: 1, objectBytes: 5 });
      } finally {
        first.close();
        second.close();
      }
    }
    await vault.close();
  });

  it("exports through an inspector, which writes nothing to the runtime", async () => {
    const file = await seeded();
    const before = await readFile(file);
    const inspector = new SqliteVault(openInspector(open(file, "readwrite")));
    const target = fresh();
    try {
      expect(await exportVault(inspector, at(target), { heldRoots: rootsOf })).toEqual({ events: 1, eventBytes: expect.any(Number), objects: 1, objectBytes: 5 });
    } finally {
      await inspector.close();
    }
    expect(Buffer.compare(await readFile(file), before), "the runtime file is untouched").toBe(0);
    const snapshot = openPortable(open(target, "readonly"));
    try {
      expect((await all(snapshot.vault.events.scan())).map((e) => e.roots)).toEqual([[HELLO_CID]]);
    } finally {
      snapshot.close();
    }
  });

  it("refuses a destination that is not fresh, or not opened to create, and closes what it was given", async () => {
    const vault = new SqliteVault(createRuntime(open(fresh(), "create"), { metadata: META, wrapped: WRAPPED }));
    const used = await seeded();
    const before = await readFile(used);
    let given: SqliteDriver | undefined;
    await expect(exportVault(vault, (mode) => (given = open(used, mode === "create" ? "readwrite" : mode)), { heldRoots: rootsOf })).rejects.toThrow(TypeError);
    expect(() => given?.exec("SELECT 1"), "the driver given is closed").toThrow(DatabaseClosed);
    const empty = fresh();
    await writeFile(empty, "");
    const filled = open(empty, "readwrite");
    filled.exec("CREATE TABLE t (x INTEGER) STRICT");
    filled.close();
    await expect(exportVault(vault, () => open(empty, "readwrite"), { heldRoots: rootsOf })).rejects.toThrow(TypeError);
    await expect(
      exportVault(vault, (mode) => (mode === "create" ? Object.assign(open(empty, "readwrite"), { mode: "create" as const }) : open(empty, mode)), { heldRoots: rootsOf }),
      "a create driver over a database with a schema"
    ).rejects.toThrow(/already has a schema/);
    expect(Buffer.compare(await readFile(used), before), "the used file is untouched").toBe(0);
    await vault.close();
  });

  it("a snapshot torn under its schema is refused: by the open where SQLite cannot read it, else by validation", async () => {
    const vault = new SqliteVault(createRuntime(open(fresh(), "create"), { metadata: META, wrapped: WRAPPED }));
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const target = fresh();
    await exportVault(vault, at(target), { heldRoots: rootsOf });
    await vault.close();
    const bytes = await readFile(target);
    const pageSize = bytes.readUInt16BE(16);
    const refusals: string[] = [];
    // every page but the first, its header and cell area overwritten
    for (let page = 1; page * pageSize < bytes.length; page++) {
      const torn = Buffer.from(bytes);
      torn.fill(0xff, page * pageSize, page * pageSize + 64);
      await writeFile(target, torn);
      let snapshot;
      try {
        snapshot = openPortable(open(target, "readonly"));
      } catch (err) {
        expect(err, `page ${page}: the open`).toSatisfy((e: unknown) => e instanceof NotAVault || (e as Error).name === "SqliteError");
        refusals.push(`page ${page}: refused at open (${(err as Error).name})`);
        continue;
      }
      try {
        const err = await validatePortable(snapshot, { heldRoots: rootsOf }).then(
          () => undefined,
          (e: unknown) => e
        );
        expect(err, `page ${page}: validation`).toBeInstanceOf(InvalidSnapshot);
        refusals.push(`page ${page}: refused at validation (${(err as InvalidSnapshot).problems[0]?.where}: ${(err as InvalidSnapshot).problems[0]?.error})`);
      } finally {
        snapshot.close();
      }
    }
    expect(refusals.length).toBeGreaterThan(2);
    console.info(`torn pages: ${refusals.join("; ")}`);
  });
});
