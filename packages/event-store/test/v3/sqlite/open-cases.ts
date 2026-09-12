/**
 * Creating and opening a vault on whatever the platform's driver is,
 * as cases free of any test framework: run over `node:sqlite` by
 * `open.test.ts` and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. What only a file on disk can show — a
 * second process, a crash mid-rewrap — is in the Node test, with the
 * counterexamples run there alone.
 */

import { createRuntime, createTables, openInspector, openPortable, openRuntime, type OpenMode, type SqliteDriver } from "../../../src/v3/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { assert, assertEqual, assertThrows } from "./driver-cases.js";

export interface OpenHarness {
  /** A target no database exists at yet. */
  fresh(): string;
  open(target: string, mode: OpenMode): Promise<SqliteDriver>;
  /** Puts `bytes`, a complete database file, at `target`. */
  importFile(target: string, bytes: Uint8Array): Promise<void>;
  /** Files declared UTF-16, which only Node's SQLite can make: a snapshot written in UTF-16, and a UTF-8 one whose header alone claims it. */
  utf16: { snapshot: Uint8Array; forged: Uint8Array };
}

export interface OpenCase {
  name: string;
  /** Returns a note for the report, or nothing. */
  run(harness: OpenHarness): Promise<string | void>;
}

/** The rows and tables of a ready portable snapshot, in the empty database `db`. */
export function fillPortable(db: SqliteDriver): void {
  db.exec("PRAGMA application_id = 1163088963; PRAGMA user_version = 1");
  createTables(db, "portable");
  db.prepare("INSERT INTO vault_meta VALUES (1, 'estoc-sqlite', 3, 'portable', 1, ?)").run(ANCHOR);
  db.prepare("INSERT INTO keystore VALUES (1, 3, ?)").run(new TextEncoder().encode(WRAPPED.seedJwe));
}

async function snapshot(h: OpenHarness, extra?: (db: SqliteDriver) => void): Promise<string> {
  const target = h.fresh();
  const db = await h.open(target, "create");
  try {
    fillPortable(db);
    extra?.(db);
  } finally {
    db.close();
  }
  return target;
}

export const openCases: OpenCase[] = [
  {
    name: "a runtime created here reopens with its identity and local IDs, and is inspected without a write",
    run: async (h) => {
      const target = h.fresh();
      const made = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const { author, generation } = made;
      made.close();
      const runtime = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        assertEqual(runtime.metadata, META, "metadata");
        assertEqual({ author: runtime.author, generation: runtime.generation }, { author, generation }, "local IDs");
        assertEqual(await runtime.keystore((op) => op()).read(), WRAPPED, "the wrapper");
      } finally {
        runtime.close();
      }
      const inspector = openInspector(await h.open(target, "readwrite"));
      try {
        assertEqual(inspector.writable, false, "an inspector is not writable");
        assertEqual(inspector.author, author, "the inspector sees the same replica");
        assertThrows(() => inspector.driver.exec("UPDATE store_state SET last_seq = 1"), "SqliteError", "a write through the inspector");
      } finally {
        inspector.close();
      }
    },
  },
  {
    name: "a snapshot made here opens as portable",
    run: async (h) => {
      const target = await snapshot(h);
      const opened = openPortable(await h.open(target, "readonly"));
      try {
        assertEqual(opened.metadata, META, "metadata");
        assertEqual(opened.wrapped, WRAPPED, "the wrapper");
      } finally {
        opened.close();
      }
    },
  },
  {
    name: "a file declared UTF-16 is refused by every open before its schema is read",
    run: async (h) => {
      const notes: string[] = [];
      for (const [what, bytes] of [
        ["written in UTF-16", h.utf16.snapshot],
        ["claiming UTF-16 in its header", h.utf16.forged],
      ] as const) {
        const target = h.fresh();
        await h.importFile(target, bytes);
        const refusals: string[] = [];
        for (const [how, attempt] of [
          ["portable", async () => openPortable(await h.open(target, "readonly"))],
          ["runtime", async () => openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR })],
          ["inspector", async () => openInspector(await h.open(target, "readwrite"))],
        ] as const) {
          try {
            (await attempt()).close();
          } catch (err) {
            assert(err instanceof Error, `${what}, ${how}: threw ${String(err)}`);
            if (err.name === "SqliteError") refusals.push("the driver could not read it");
            else if (err.name === "NotAVault" && /encoded UTF-16le/.test(err.message)) refusals.push("the open refused it");
            else throw new Error(`${what}, ${how}: refused with ${err.name}: ${err.message}`);
            continue;
          }
          throw new Error(`${what}, ${how}: opened`);
        }
        notes.push(`${what}: ${refusals.join(", ")}`);
      }
      return notes.join("; ");
    },
  },
  {
    name: "a schema object bearing the name of SQLite's page table, or one SQLite would resolve to it, is refused before SQLite's page table is queried",
    run: async (h) => {
      const rename = (as: "TEXT" | "BLOB", suffix: string): string =>
        `UPDATE sqlite_master SET name = CAST(CAST(name AS BLOB) || x'${suffix}' AS ${as}), tbl_name = CAST(CAST(tbl_name AS BLOB) || x'${suffix}' AS ${as}) WHERE name = 'sqlite_dbpage'`;
      const namesake = (name = "sqlite_dbpage"): string => `the schema has an object named ${name}: a name reserved for SQLite's own`;
      const nul = "column sqlite_master.name: the stored text has a NUL and cannot cross a SQLite text boundary intact";
      const table = "CREATE TABLE sqlite_dbpage (pgno INTEGER, data BLOB); INSERT INTO sqlite_dbpage VALUES (1, zeroblob(56) || x'00000001')";
      const view = "CREATE VIEW sqlite_dbpage AS SELECT 1 AS pgno, abs(-9223372036854775808) AS data";
      for (const [what, ddl, refusal] of [
        ["a table", table, namesake()],
        ["a table in capitals", "CREATE TABLE SQLITE_DBPAGE (pgno INTEGER, data BLOB)", namesake("SQLITE_DBPAGE")],
        ["a view whose SQL cannot be run", view, namesake()],
        ["a table whose name is stored as a blob", `${table}; ${rename("BLOB", "")}`, namesake()],
        ["a table whose stored name runs past a NUL", `${table}; ${rename("TEXT", "0078")}`, nul],
        ["a table whose stored name ends in a NUL", `${table}; ${rename("TEXT", "00")}`, nul],
        ["a view whose stored name runs past a NUL", `${view}; ${rename("TEXT", "0078")}`, nul],
        ["a view whose blob name runs past a NUL", `${view}; ${rename("BLOB", "0078")}`, nul],
      ]) {
        const target = await snapshot(h, (db) => db.exec(`PRAGMA writable_schema = ON; ${ddl}; PRAGMA writable_schema = OFF`));
        for (const [how, attempt] of [
          ["portable", async () => openPortable(await h.open(target, "readonly"))],
          ["runtime", async () => openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR })],
          ["inspector", async () => openInspector(await h.open(target, "readwrite"))],
        ] as const) {
          try {
            (await attempt()).close();
          } catch (err) {
            assert(err instanceof Error && err.name === "NotAVault", `${what}, ${how}: threw ${String(err)}`);
            assert(err.message === refusal, `${what}, ${how}: refused with ${err.message}`);
            continue;
          }
          throw new Error(`${what}, ${how}: opened`);
        }
      }
    },
  },
  {
    name: "a table named like an object's inherited property is an extra table like any other",
    run: async (h) => {
      for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        const target = await snapshot(h, (db) => db.exec(`CREATE TABLE "${name}" (secret BLOB) STRICT`));
        const driver = await h.open(target, "readonly");
        const refused = assertThrows(() => openPortable(driver), "NotAVault", name);
        assert(refused.message === `table ${name} is not in the portable schema`, `${name}: ${refused.message}`);
      }
    },
  },
  {
    name: "a column that compares other than byte for byte is not the schema's, in either kind",
    run: async (h) => {
      const nocase = await snapshot(h, (db) =>
        db.exec("DROP TABLE events; CREATE TABLE events (event_id TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL, author TEXT NOT NULL, type TEXT COLLATE NOCASE NOT NULL, canonical BLOB NOT NULL) STRICT")
      );
      const driver = await h.open(nocase, "readonly");
      const refused = assertThrows(() => openPortable(driver), "NotAVault", "NOCASE");
      assert(refused.message === "table events: column type does not compare as BINARY", refused.message);
    },
  },
];
