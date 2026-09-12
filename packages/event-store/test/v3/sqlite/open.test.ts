/**
 * Creating and opening the vault over `node:sqlite`: the cross-platform
 * open cases on files; what only a file on disk can show — a second
 * process, a crash in the middle of a rewrap, the file untouched by a
 * refused open; and the counterexamples run here alone, in one place.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSeedKeystore } from "@estoc/keystore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "../../../src/node.js";
import {
  AnchorMismatch,
  DamagedControl,
  DatabaseBusy,
  DatabaseClosed,
  DatabaseExists,
  DatabaseMissing,
  NotAVault,
  ReadOnlyVault,
  VaultClosed,
  WriterLock,
  checkWrappedSeed,
  createRuntime,
  createTables,
  openInspector,
  openPortable,
  openRuntime,
  type Locked,
  type OpenMode,
  type RuntimeDatabase,
  type SqliteDriver,
  type VaultMetadata,
  type WrappedSeed,
} from "../../../src/v3/index.js";
import { ANCHOR, META, REWRAPPED, WRAPPED } from "../fixtures.js";
import { openCases, type OpenHarness } from "./open-cases.js";
import { utf16Forged, utf16Snapshot } from "./utf16.js";

const EVENT_ID = "01924f2e-8f6b-7c3a-9d1e-2b4c6a8e0f13";

let dir: string;
let utf16: { snapshot: Uint8Array; forged: Uint8Array };
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-open-"));
  utf16 = { snapshot: await utf16Snapshot(path.join(dir, "utf16-snapshot.sqlite")), forged: await utf16Forged(path.join(dir, "utf16-forged.sqlite")) };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (file: string, mode: OpenMode, journal?: "wal" | "delete"): SqliteDriver => openNodeSqlite(file, journal === undefined ? { mode } : { mode, journal });
const create = (file: string, journal?: "wal" | "delete"): RuntimeDatabase => createRuntime(open(file, "create", journal), { metadata: META, wrapped: WRAPPED });
const locked: Locked = (op) => new WriterLock().run(op);

function alter(file: string, sql: string): void {
  const db = open(file, "readwrite");
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** A database made by hand, in a rollback journal so it can be read as a snapshot too. */
function handmade(body: (db: SqliteDriver) => void): string {
  const file = fresh();
  const db = open(file, "create", "delete");
  try {
    body(db);
  } finally {
    db.close();
  }
  return file;
}

function fill(db: SqliteDriver, kind: "runtime" | "portable", meta: { format?: string; version?: number; ready?: number; anchor?: string } = {}): SqliteDriver {
  db.exec(`PRAGMA application_id = 1163088963; PRAGMA user_version = 1`);
  createTables(db, kind);
  db.prepare("INSERT INTO vault_meta VALUES (1, ?, ?, ?, ?, ?)").run(meta.format ?? "estoc-sqlite", meta.version ?? 3, kind, meta.ready ?? 1, meta.anchor ?? ANCHOR);
  db.prepare("INSERT INTO keystore VALUES (1, 3, ?)").run(new TextEncoder().encode(WRAPPED.seedJwe));
  if (kind === "runtime") db.exec(`INSERT INTO store_state VALUES (1, '${EVENT_ID}', '${EVENT_ID}', 0)`);
  return db;
}

/** The runtime's tables with the constraints the schema's DDL has left out, so values the constraints would stop can be put in. */
function fillLoose(db: SqliteDriver, format: string, version: number, kind: string, ready: number): void {
  db.exec("PRAGMA application_id = 1163088963; PRAGMA user_version = 1");
  db.exec("CREATE TABLE vault_meta (singleton INTEGER PRIMARY KEY, format TEXT NOT NULL, vault_version INTEGER NOT NULL, kind TEXT NOT NULL, ready INTEGER NOT NULL, anchor TEXT NOT NULL) STRICT");
  db.prepare("INSERT INTO vault_meta VALUES (1, ?, ?, ?, ?, ?)").run(format, version, kind, ready, ANCHOR);
}

async function rejectsWith(promise: Promise<unknown>, type: new (...args: never[]) => Error, message: string | RegExp, what?: string): Promise<void> {
  await expect(promise, what).rejects.toBeInstanceOf(type);
  await expect(promise, what).rejects.toThrow(message);
}

/** How many statements `driver` still holds: what a leak of one per call would grow. */
function retained(driver: SqliteDriver): number {
  return (driver as unknown as { statements: Set<unknown> }).statements.size;
}

describe("the open cases on node:sqlite files", () => {
  const harness: OpenHarness = {
    fresh,
    open: async (target, mode) => open(target, mode, mode === "create" ? "delete" : undefined),
    importFile: (target, bytes) => writeFile(target, bytes),
    get utf16() {
      return utf16;
    },
  };
  for (const c of openCases) {
    it(c.name, async () => {
      const note = await c.run(harness);
      if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
    });
  }
});

describe("createRuntime", () => {
  it("publishes schema, metadata, wrapper and fresh control in one step, and hands the runtime back open", async () => {
    const file = fresh();
    const vault = create(file);
    expect(vault.metadata).toEqual(META);
    expect(vault.writable).toBe(true);
    expect(vault.author).toMatch(/^[0-9a-f-]{36}$/);
    expect(vault.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(vault.author).not.toBe(vault.generation);
    expect(await vault.keystore(locked).read()).toEqual(WRAPPED);
    expect(vault.driver.prepare("PRAGMA application_id").get()).toEqual({ application_id: 0x45535443 });
    expect(vault.driver.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(vault.driver.prepare("SELECT * FROM vault_meta").get()).toEqual({ singleton: 1, format: "estoc-sqlite", vault_version: 3, kind: "runtime", ready: 1, anchor: ANCHOR });
    expect(vault.driver.prepare("SELECT replica_id, store_generation, last_seq FROM store_state").get()).toEqual({ replica_id: vault.author, store_generation: vault.generation, last_seq: 0 });
    vault.close();
    expect(Array.from((await readFile(file)).subarray(18, 20)), "a runtime is a WAL file").toEqual([2, 2]);
  });

  it("refuses a driver not opened to create, an existing target, and a database that already has a schema", () => {
    const file = fresh();
    create(file).close();
    expect(() => createRuntime(open(file, "readwrite"), { metadata: META, wrapped: WRAPPED })).toThrow(TypeError);
    expect(() => open(file, "create")).toThrow(DatabaseExists);
    const memory = open(":memory:", "create");
    memory.exec("CREATE TABLE t (x INTEGER) STRICT");
    expect(() => createRuntime(memory, { metadata: META, wrapped: WRAPPED })).toThrow(/already has a schema/);
    expect(() => memory.exec("SELECT 1"), "the driver is closed with the refusal").toThrow(DatabaseClosed);
  });

  it("checks the metadata and the wrapper before touching the database, and closes the driver with the refusal", async () => {
    const file = fresh();
    const first = open(file, "create");
    expect(() => createRuntime(first, { metadata: { version: 2, anchor: ANCHOR } as unknown as VaultMetadata, wrapped: WRAPPED })).toThrow(NotAVault);
    expect(() => first.exec("SELECT 1")).toThrow(DatabaseClosed);
    const left = open(file, "readwrite");
    expect(left.prepare("SELECT count(*) AS n FROM sqlite_master").get(), "nothing was made but the empty file the driver reserved").toEqual({ n: 0 });
    left.close();
    const memory = open(":memory:", "create");
    expect(() => createRuntime(memory, { metadata: META, wrapped: { version: 3, seedJwe: "not a jwe" } })).toThrow(NotAVault);
    expect(() => memory.exec("SELECT 1")).toThrow(DatabaseClosed);
  });
});

describe("openRuntime", () => {
  it("reopens what a create made, with the same identity and local IDs", async () => {
    const file = fresh();
    const made = create(file);
    const { author, generation } = made;
    made.close();
    const asked: WrappedSeed[] = [];
    const vault = await openRuntime(open(file, "readwrite"), {
      anchor: (wrapped) => {
        asked.push(wrapped);
        return ANCHOR;
      },
    });
    expect(asked, "the anchor is derived from the wrapper the vault holds").toEqual([WRAPPED]);
    expect(vault.metadata).toEqual(META);
    expect({ author: vault.author, generation: vault.generation }).toEqual({ author, generation });
    expect(vault.writable).toBe(true);
    vault.close();
    const again = await openRuntime(open(file, "readwrite"), { anchor: ANCHOR });
    expect({ author: again.author, generation: again.generation }, "an anchor given outright works the same").toEqual({ author, generation });
    again.close();
  });

  it("never creates: a missing file is refused by the driver", () => {
    expect(() => open(fresh(), "readwrite")).toThrow(DatabaseMissing);
  });

  it("refuses the wrong anchor before any write, closes the driver and releases the file as it was", async () => {
    const file = fresh();
    create(file).close();
    const before = await readFile(file);
    const driver = open(file, "readwrite");
    const failed = openRuntime(driver, { anchor: "did:key:z6MkOther" });
    await rejectsWith(failed, AnchorMismatch, "wrong seed for this vault");
    expect(() => driver.exec("SELECT 1")).toThrow(DatabaseClosed);
    expect(Array.from(await readFile(file))).toEqual(Array.from(before));
    const vault = await openRuntime(open(file, "readwrite"), { anchor: ANCHOR });
    vault.close();
  });

  it("a failing unlock fails the open the same way", async () => {
    const file = fresh();
    create(file).close();
    const driver = open(file, "readwrite");
    await rejectsWith(
      openRuntime(driver, {
        anchor: async () => {
          throw new Error("wrong passphrase");
        },
      }),
      Error,
      "wrong passphrase"
    );
    expect(() => driver.exec("SELECT 1")).toThrow(DatabaseClosed);
  });

  it("requires a driver opened readwrite", async () => {
    const file = fresh();
    create(file).close();
    const readonly = open(file, "readonly");
    await expect(openRuntime(readonly, { anchor: ANCHOR })).rejects.toBeInstanceOf(TypeError);
    expect(() => readonly.exec("SELECT 1"), "closed with the refusal").toThrow(DatabaseClosed);
  });

  it("tells a file that is not a vault from one by its header, metadata and schema, before asking for the seed", async () => {
    const cases: { name: string; file: string; message: RegExp }[] = [
      { name: "an empty database", file: handmade(() => undefined), message: /application_id 0 is not a vault's/ },
      { name: "another application's", file: handmade((db) => db.exec("PRAGMA application_id = 7")), message: /application_id 7/ },
      { name: "a later schema version", file: handmade((db) => db.exec("PRAGMA application_id = 1163088963; PRAGMA user_version = 2")), message: /schema version 2 is not supported/ },
      { name: "no metadata table", file: handmade((db) => db.exec("PRAGMA application_id = 1163088963; PRAGMA user_version = 1")), message: /vault_meta cannot be read/ },
      { name: "another format", file: handmade((db) => fillLoose(db, "estoc-other", 3, "runtime", 1)), message: /format "estoc-other"/ },
      { name: "another vault version", file: handmade((db) => fillLoose(db, "estoc-sqlite", 4, "runtime", 1)), message: /vault version 4/ },
      { name: "a portable snapshot", file: handmade((db) => fill(db, "portable")), message: /a portable one, not a runtime/ },
      { name: "an unready runtime", file: handmade((db) => fill(db, "runtime", { ready: 0 })), message: /not ready/ },
      { name: "no metadata row", file: handmade((db) => fill(db, "runtime").exec("DELETE FROM vault_meta")), message: /vault_meta has 0 rows/ },
      { name: "a metadata row keyed other than 1", file: handmade((db) => fill(db, "runtime").exec("PRAGMA ignore_check_constraints = ON; UPDATE vault_meta SET singleton = 2")), message: /vault_meta's row is keyed 2, not 1/ },
      { name: "a keystore row keyed other than 1", file: handmade((db) => fill(db, "runtime").exec("PRAGMA ignore_check_constraints = ON; UPDATE keystore SET singleton = 2")), message: /keystore's row is keyed 2, not 1/ },
      { name: "an anchor that is not a DID", file: handmade((db) => fill(db, "runtime", { anchor: "nobody" })), message: /anchor is a DID/ },
    ];
    for (const c of cases) {
      let asked = false;
      const driver = open(c.file, "readwrite");
      const failed = openRuntime(driver, {
        anchor: () => {
          asked = true;
          return ANCHOR;
        },
      });
      await rejectsWith(failed, NotAVault, c.message, c.name);
      expect(asked, `${c.name}: the seed is not asked for`).toBe(false);
      expect(() => driver.exec("SELECT 1"), `${c.name}: the driver is closed`).toThrow(DatabaseClosed);
    }
  });

  it("checks the schema structurally: what is missing, what is extra, what a runtime may add", async () => {
    const refused: [string, string, RegExp][] = [
      ["an extra table", "CREATE TABLE scratch (x INTEGER) STRICT", /table scratch is not in the runtime schema/],
      ["a table named like an inherited property", 'CREATE TABLE "constructor" (x INTEGER) STRICT', /table constructor is not in the runtime schema/],
      ["a view", "CREATE VIEW recent AS SELECT event_id FROM events", /the schema has a view, recent/],
      ["a trigger", "CREATE TRIGGER t AFTER INSERT ON events BEGIN SELECT 1; END", /the schema has a trigger, t/],
      ["a missing column", "ALTER TABLE events DROP COLUMN type", /table events is not schema version 1's/],
      ["an extra column", "ALTER TABLE objects ADD COLUMN note TEXT", /table objects is not schema version 1's/],
      ["a generated column", "ALTER TABLE objects ADD COLUMN twice INTEGER GENERATED ALWAYS AS (size * 2) VIRTUAL", /column twice is generated/],
      ["a renamed column", "ALTER TABLE keystore RENAME COLUMN seed_jwe TO jwe", /table keystore is not schema version 1's/],
      ["a dropped control table", "DROP TABLE event_positions", /table event_positions is missing/],
    ];
    for (const [name, sql, message] of refused) {
      const file = fresh();
      create(file).close();
      alter(file, sql);
      await rejectsWith(openRuntime(open(file, "readwrite"), { anchor: ANCHOR }), NotAVault, message, name);
    }
    const file = fresh();
    create(file).close();
    alter(file, "CREATE TABLE local_notes (k TEXT PRIMARY KEY, v BLOB) STRICT; CREATE INDEX events_by_author ON events (author, at); ANALYZE");
    const stats = open(file, "readonly");
    expect(stats.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get(), "ANALYZE left its table").toEqual({ n: 1 });
    stats.close();
    const vault = await openRuntime(open(file, "readwrite"), { anchor: ANCHOR });
    vault.close();
  });

  it("refuses a table whose type, collation, key or reference differs even when the names agree, and one that is not STRICT", async () => {
    const remade = (table: string, ddl: string): string =>
      handmade((db) => {
        fill(db, "runtime");
        db.exec(`DROP TABLE ${table}; ${ddl}`);
      });
    const cases: [string, string, RegExp][] = [
      ["a column of another type", remade("objects", "CREATE TABLE objects (cid TEXT PRIMARY KEY NOT NULL, size TEXT NOT NULL) STRICT"), /expected cid TEXT NOT NULL PK1, size INTEGER NOT NULL, KEY\(cid\); found cid TEXT NOT NULL PK1, size TEXT NOT NULL, KEY\(cid\)/],
      ["a table that is not STRICT", remade("objects", "CREATE TABLE objects (cid TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL)"), /table objects is not STRICT/],
      [
        "a reference without its ON DELETE",
        remade("object_chunks", "CREATE TABLE object_chunks (cid TEXT NOT NULL REFERENCES objects(cid), chunk_no INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (cid, chunk_no)) STRICT"),
        /ON UPDATE NO ACTION ON DELETE CASCADE; found .* ON UPDATE NO ACTION ON DELETE NO ACTION/,
      ],
      [
        "a reference with an ON UPDATE",
        remade("object_chunks", "CREATE TABLE object_chunks (cid TEXT NOT NULL REFERENCES objects(cid) ON UPDATE CASCADE ON DELETE CASCADE, chunk_no INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (cid, chunk_no)) STRICT"),
        /found .* ON UPDATE CASCADE ON DELETE CASCADE/,
      ],
      ["a key that collates NOCASE", remade("objects", "CREATE TABLE objects (cid TEXT COLLATE NOCASE PRIMARY KEY NOT NULL, size INTEGER NOT NULL) STRICT"), /found cid TEXT NOT NULL PK1, size INTEGER NOT NULL, KEY\(cid COLLATE NOCASE\)/],
      ["a key that orders descending", remade("objects", "CREATE TABLE objects (cid TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (cid DESC)) STRICT"), /KEY\(cid DESC\)/],
      [
        "a column that collates NOCASE",
        remade("events", "CREATE TABLE events (event_id TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL, author TEXT NOT NULL, type TEXT COLLATE NOCASE NOT NULL, canonical BLOB NOT NULL) STRICT"),
        /table events: column type does not compare as BINARY/,
      ],
      [
        "a column that collates RTRIM",
        remade("events", "CREATE TABLE events (event_id TEXT PRIMARY KEY NOT NULL, at TEXT COLLATE RTRIM NOT NULL, author TEXT NOT NULL, type TEXT NOT NULL, canonical BLOB NOT NULL) STRICT"),
        /table events: column at does not compare as BINARY/,
      ],
      ["a UNIQUE the schema does not have", remade("store_state", "CREATE TABLE store_state (singleton INTEGER PRIMARY KEY, replica_id TEXT NOT NULL UNIQUE, store_generation TEXT NOT NULL, last_seq INTEGER NOT NULL) STRICT"), /found .* KEY\(replica_id\)/],
    ];
    for (const [name, file, message] of cases) {
      await rejectsWith(openRuntime(open(file, "readwrite"), { anchor: ANCHOR }), NotAVault, message, name);
    }
    const spelled = handmade((db) => {
      fill(db, "runtime");
      db.exec("DROP TABLE objects; create   table objects(cid text collate binary not null primary key,size integer not null)strict");
    });
    const vault = await openRuntime(open(spelled, "readwrite"), { anchor: ANCHOR });
    vault.close();
  });

  it("refuses damaged control rather than making any up", async () => {
    const event = `INSERT INTO events VALUES ('${EVENT_ID}', '2026-09-12T00:00:00.000Z', '${EVENT_ID}', 'x', X'7B7D')`;
    const cases: [string, string, RegExp][] = [
      ["no control row", "DELETE FROM store_state", /store_state has 0 rows/],
      ["a control row keyed other than 1", "PRAGMA ignore_check_constraints = ON; UPDATE store_state SET singleton = 2", /store_state's row is keyed 2, not 1/],
      ["a replica ID that is not a UUIDv7", "UPDATE store_state SET replica_id = 'replica'", /replica_id "replica" is not a canonical UUIDv7/],
      ["a generation that is not a UUIDv7", `UPDATE store_state SET store_generation = '${EVENT_ID.replace("-7", "-4")}'`, /store_generation .* is not a canonical UUIDv7/],
      ["a last_seq above the positions", "UPDATE store_state SET last_seq = 5", /last_seq is 5 but the highest position is 0/],
      ["an event without a position", event, /1 events have 0 positions/],
      ["a position last_seq does not cover", `${event}; INSERT INTO event_positions VALUES (3, '${EVENT_ID}')`, /last_seq is 0 but the highest position is 3/],
      ["a position of zero", `PRAGMA ignore_check_constraints = ON; ${event}; INSERT INTO event_positions VALUES (0, '${EVENT_ID}'); UPDATE store_state SET last_seq = 0`, /position 0 is not positive/],
      [
        "a negative position beside a good one",
        `PRAGMA ignore_check_constraints = ON; ${event}; INSERT INTO events VALUES ('${EVENT_ID.replace("13", "14")}', '2026-09-12T00:00:00.000Z', '${EVENT_ID}', 'x', X'7B7D'); INSERT INTO event_positions VALUES (-1, '${EVENT_ID}'), (1, '${EVENT_ID.replace("13", "14")}'); UPDATE store_state SET last_seq = 1`,
        /position -1 is not positive/,
      ],
    ];
    for (const [name, sql, message] of cases) {
      const file = fresh();
      create(file).close();
      alter(file, sql);
      const driver = open(file, "readwrite");
      await rejectsWith(openRuntime(driver, { anchor: ANCHOR }), DamagedControl, message, name);
      expect(() => driver.exec("SELECT 1"), name).toThrow(DatabaseClosed);
    }
    const file = fresh();
    create(file).close();
    alter(file, `${event}; INSERT INTO event_positions VALUES (1, '${EVENT_ID}'); UPDATE store_state SET last_seq = 1`);
    const vault = await openRuntime(open(file, "readwrite"), { anchor: ANCHOR });
    vault.close();
  });

  it("is refused while another connection owns the file, in this process or another", async () => {
    const file = fresh();
    const owner = create(file);
    expect(() => open(file, "readwrite")).toThrow(DatabaseBusy);
    owner.close();
    const holder = await holdInAnotherProcess(file);
    try {
      expect(() => open(file, "readwrite")).toThrow(DatabaseBusy);
    } finally {
      await holder.quit();
    }
    (await openRuntime(open(file, "readwrite"), { anchor: ANCHOR })).close();
  });
});

describe("the wrapped seed", () => {
  it("is what the keystore package seals: a fresh one passes, and rewraps", async () => {
    const { doc } = await createSeedKeystore("a passphrase for this test only");
    const sealed: WrappedSeed = { version: 3, seedJwe: doc.seedJwe };
    expect(checkWrappedSeed(sealed)).toEqual(sealed);
    const file = fresh();
    const vault = createRuntime(open(file, "create"), { metadata: META, wrapped: sealed });
    await vault.keystore(locked).rewrap(WRAPPED);
    expect(await vault.keystore(locked).read()).toEqual(WRAPPED);
    vault.close();
  }, 30_000);

  it("is checked against the package's profile, not just its shape", () => {
    const header = (fields: Record<string, unknown>): string => Buffer.from(JSON.stringify(fields)).toString("base64url");
    const [good, encryptedKey, iv, ciphertext, tag] = WRAPPED.seedJwe.split(".") as [string, string, string, string, string];
    const profile = { alg: "PBES2-HS512+A256KW", enc: "A256GCM", p2c: 220000, p2s: "znUl9VydtY3Zu_3jCbgHEQ" };
    const rest = `${encryptedKey}.${iv}.${ciphertext}.${tag}`;
    const cases: [string, string, RegExp][] = [
      ["an empty header", `e30.${rest}`, /header has nothing/],
      ["an empty header with empty segments", "e30....", /header has nothing/],
      ["another key algorithm", `${header({ ...profile, alg: "PBES2-HS256+A256KW" })}.${rest}`, /alg "PBES2-HS256\+A256KW" is not PBES2-HS512\+A256KW/],
      ["direct encryption", `${header({ alg: "dir", enc: "A256GCM", p2c: 1, p2s: profile.p2s })}.${rest}`, /alg "dir"/],
      ["another content encryption", `${header({ ...profile, enc: "A128GCM" })}.${rest}`, /enc "A128GCM" is not A256GCM/],
      ["a missing iteration count", `${header({ alg: profile.alg, enc: profile.enc, p2s: profile.p2s })}.${rest}`, /header has alg, enc, p2s; the profile has alg, enc, p2c and p2s/],
      ["an extra header parameter", `${header({ ...profile, zip: "DEF" })}.${rest}`, /header has alg, enc, p2c, p2s, zip/],
      ["too many iterations", `${header({ ...profile, p2c: 5_000_001 })}.${rest}`, /p2c 5000001 is not an iteration count/],
      ["a fractional iteration count", `${header({ ...profile, p2c: 1.5 })}.${rest}`, /p2c 1.5/],
      ["a short salt", `${header({ ...profile, p2s: "AAAA" })}.${rest}`, /p2s is not a salt of at least 8 bytes/],
      ["a header that is not JSON", `${Buffer.from("{").toString("base64url")}.${rest}`, /header is not JSON/],
      ["a header that is an array", `${Buffer.from("[]").toString("base64url")}.${rest}`, /header is an object/],
      ["an empty encrypted key", `${good}..${iv}.${ciphertext}.${tag}`, /encrypted key is 0 bytes, not 40/],
      ["a short initialization vector", `${good}.${encryptedKey}.AAAA.${ciphertext}.${tag}`, /initialization vector is 3 bytes, not 12/],
      ["a ciphertext of another length", `${good}.${encryptedKey}.${iv}.${Buffer.alloc(33).toString("base64url")}.${tag}`, /ciphertext is 33 bytes, not 32/],
      ["a short tag", `${good}.${encryptedKey}.${iv}.${ciphertext}.AA`, /authentication tag is 1 bytes, not 16/],
      ["a segment that is not base64url", `${good}.${encryptedKey}.${iv}.${ciphertext}.${tag}=`, /segment 5 is not base64url/],
      ["four segments", `${good}.${encryptedKey}.${iv}.${ciphertext}`, /five segments/],
    ];
    for (const [name, seedJwe, message] of cases) {
      expect(() => checkWrappedSeed({ version: 3, seedJwe }), name).toThrow(NotAVault);
      expect(() => checkWrappedSeed({ version: 3, seedJwe }), name).toThrow(message);
    }
    const stored = handmade((db) => fill(db, "portable").prepare("UPDATE keystore SET seed_jwe = ?").run(new TextEncoder().encode("e30....")));
    expect(() => openPortable(open(stored, "readonly"))).toThrow(/header has nothing/);
  });
});

describe("the keystore", () => {
  it("reads the wrapper, and rewraps it in one transaction under the lock", async () => {
    const file = fresh();
    const vault = create(file);
    const calls: string[] = [];
    const keystore = vault.keystore(async (op) => {
      calls.push("locked");
      return op();
    });
    expect(await keystore.read()).toEqual(WRAPPED);
    await keystore.rewrap(REWRAPPED);
    expect(calls).toEqual(["locked"]);
    expect(await keystore.read()).toEqual(REWRAPPED);
    vault.close();
    const again = await openRuntime(open(file, "readwrite"), { anchor: ANCHOR });
    expect(await again.keystore(locked).read(), "the replacement was written").toEqual(REWRAPPED);
    again.close();
  });

  it("checks the replacement's shape before asking for the lock", async () => {
    const vault = create(fresh());
    let taken = false;
    const keystore = vault.keystore(async (op) => {
      taken = true;
      return op();
    });
    await expect(keystore.rewrap({ version: 3, seedJwe: "nope" })).rejects.toBeInstanceOf(NotAVault);
    expect(taken).toBe(false);
    expect(await keystore.read()).toEqual(WRAPPED);
    vault.close();
  });

  it("an interrupted rewrap leaves the old wrapper whole", async () => {
    const file = fresh();
    create(file).close();
    await interruptRewrapInAnotherProcess(file, REWRAPPED.seedJwe);
    const vault = await openRuntime(open(file, "readwrite"), { anchor: ANCHOR });
    expect(await vault.keystore(locked).read()).toEqual(WRAPPED);
    vault.close();
  });

  it("holds no statement past a call: a thousand reads and rewraps leave the connection as the open left it", async () => {
    const vault = create(fresh());
    const keystore = vault.keystore(locked);
    const opened = retained(vault.driver);
    for (let i = 0; i < 1000; i++) await keystore.read();
    for (let i = 0; i < 100; i++) await keystore.rewrap(i % 2 === 0 ? REWRAPPED : WRAPPED);
    expect(retained(vault.driver)).toBe(opened);
    expect(opened).toBe(0);
    vault.close();
  });

  it("refuses every call after close", async () => {
    const vault = create(fresh());
    const keystore = vault.keystore(locked);
    vault.close();
    vault.close();
    await expect(keystore.read()).rejects.toBeInstanceOf(VaultClosed);
    await expect(keystore.rewrap(REWRAPPED)).rejects.toBeInstanceOf(VaultClosed);
    expect(() => vault.driver.exec("SELECT 1")).toThrow(DatabaseClosed);
  });
});

describe("openInspector", () => {
  it("opens a runtime to read, writes nothing, mints nothing, and keeps a second owner out, in either journal mode", async () => {
    for (const journal of ["wal", "delete"] as const) {
      const file = fresh();
      const made = create(file, journal);
      const { author, generation } = made;
      made.close();
      const before = await readFile(file);
      const inspector = openInspector(open(file, "readwrite"));
      expect(inspector.writable, journal).toBe(false);
      expect({ author: inspector.author, generation: inspector.generation }, journal).toEqual({ author, generation });
      expect(inspector.metadata, journal).toEqual(META);
      expect(await inspector.keystore(locked).read(), journal).toEqual(WRAPPED);
      await expect(inspector.keystore(locked).rewrap(REWRAPPED), journal).rejects.toBeInstanceOf(ReadOnlyVault);
      expect(() => inspector.driver.exec("UPDATE store_state SET last_seq = 1"), journal).toThrow(/readonly/);
      expect(() => inspector.driver.exec("PRAGMA user_version = 2"), journal).toThrow(/readonly/);
      expect(() => open(file, "readwrite"), `${journal}: a second inspector`).toThrow(DatabaseBusy);
      expect(() => open(file, "readonly"), `${journal}: a reader`).toThrow(DatabaseBusy);
      expect(await probeInAnotherProcess(file), `${journal}: another process`).toEqual({ read: "code 5", write: "code 5" });
      expect(inspector.author, `${journal}: the inspector is unaffected by the refusals`).toBe(author);
      inspector.close();
      expect(Array.from(await readFile(file)), journal).toEqual(Array.from(before));
    }
  });

  it("takes only a driver opened readwrite, and applies the checks a run does", () => {
    const file = fresh();
    create(file, "delete").close();
    const readonly = open(file, "readonly");
    expect(() => openInspector(readonly), "a read-only driver may share a rollback-journal file with other readers").toThrow(TypeError);
    expect(() => readonly.exec("SELECT 1")).toThrow(DatabaseClosed);
    alter(file, "DELETE FROM store_state");
    expect(() => openInspector(open(file, "readwrite"))).toThrow(DamagedControl);
    const snapshot = handmade((db) => fill(db, "portable"));
    expect(() => openInspector(open(snapshot, "readwrite"))).toThrow(/a portable one, not a runtime/);
    expect(() => openInspector(open(fresh(), "create"))).toThrow(TypeError);
  });
});

describe("openPortable", () => {
  it("opens a snapshot read-only, as far as its metadata and wrapper, sharing it with other readers", async () => {
    const file = handmade((db) => fill(db, "portable"));
    const snapshot = openPortable(open(file, "readonly"));
    expect(snapshot.metadata).toEqual(META);
    expect(snapshot.wrapped).toEqual(WRAPPED);
    expect(() => snapshot.driver.exec("DELETE FROM events")).toThrow(/readonly/);
    const another = openPortable(open(file, "readonly"));
    another.close();
    expect(await probeInAnotherProcess(file)).toEqual({ read: "ok", write: "code 5" });
    snapshot.close();
    expect(() => snapshot.driver.exec("SELECT 1")).toThrow(DatabaseClosed);
  });

  it("requires a read-only driver", () => {
    const file = handmade((db) => fill(db, "portable"));
    expect(() => openPortable(open(file, "readwrite"))).toThrow(TypeError);
    expect(() => openPortable(open(fresh(), "create"))).toThrow(TypeError);
  });

  it("checks the file's identity and headers, then the schema, then the metadata, and reads nothing else", () => {
    const cases: [string, string, RegExp][] = [
      ["an empty database", handmade(() => undefined), /application_id 0/],
      ["a runtime", handmade((db) => fill(db, "runtime")), /table event_positions is not in the portable schema/],
      ["a runtime's kind", handmade((db) => fill(db, "portable").exec("UPDATE vault_meta SET kind = 'runtime'")), /a runtime one, not a portable/],
      ["an unready snapshot", handmade((db) => fill(db, "portable", { ready: 0 })), /not ready/],
      ["a metadata row keyed other than 1", handmade((db) => fill(db, "portable").exec("PRAGMA ignore_check_constraints = ON; UPDATE vault_meta SET singleton = 2")), /vault_meta's row is keyed 2, not 1/],
      ["a keystore row keyed other than 1", handmade((db) => fill(db, "portable").exec("PRAGMA ignore_check_constraints = ON; UPDATE keystore SET singleton = 2")), /keystore's row is keyed 2, not 1/],
      ["a view, before the bad metadata under it", handmade((db) => fill(db, "portable", { ready: 0 }).exec("CREATE VIEW v AS SELECT 1")), /the schema has a view, v/],
      ["a trigger", handmade((db) => fill(db, "portable").exec("CREATE TRIGGER t AFTER INSERT ON events BEGIN SELECT 1; END")), /the schema has a trigger, t/],
      ["an index a constraint did not make", handmade((db) => fill(db, "portable").exec("CREATE INDEX i ON events (author)")), /table events has an index a constraint did not make/],
      ["ANALYZE statistics", handmade((db) => fill(db, "portable").exec("ANALYZE")), /table sqlite_stat1 is not in the portable schema/],
      ["a local table", handmade((db) => fill(db, "portable").exec("CREATE TABLE local_notes (k TEXT) STRICT")), /table local_notes is not in the portable schema/],
      ["a table named __proto__", handmade((db) => fill(db, "portable").exec('CREATE TABLE "__proto__" (secret BLOB) STRICT')), /table __proto__ is not in the portable schema/],
      ["a wrapper that is not a compact JWE", handmade((db) => fill(db, "portable").exec("UPDATE keystore SET seed_jwe = X'00'")), /keystore.seed_jwe/],
      ["no wrapper", handmade((db) => fill(db, "portable").exec("DELETE FROM keystore")), /keystore has 0 rows/],
    ];
    for (const [name, file, message] of cases) {
      const driver = open(file, "readonly");
      expect(() => openPortable(driver), name).toThrow(NotAVault);
      const again = open(file, "readonly");
      expect(() => openPortable(again), name).toThrow(message);
      expect(() => driver.exec("SELECT 1"), `${name}: the driver is closed`).toThrow(DatabaseClosed);
    }
  });

  it("refuses a WAL file: a snapshot stands alone with rollback-format headers", async () => {
    const file = fresh();
    const db = open(file, "create");
    fill(db, "portable");
    db.close();
    expect(Array.from((await readFile(file)).subarray(18, 20))).toEqual([2, 2]);
    expect(() => openPortable(open(file, "readonly"))).toThrow(/a WAL file is not a portable snapshot/);
  });
});

/**
 * Another process on the file with `node:sqlite` alone. `hold` takes
 * SQLite's exclusive lock, says so and quits when told. `probe` tries a
 * read and a write and reports each as `ok` or the result code, with
 * its exit. `rewrap` begins a transaction, writes the replacement
 * wrapper and exits without committing: the interruption a crash is,
 * as far as the file can tell.
 */
const OTHER_PROCESS = `
  const { DatabaseSync } = require("node:sqlite");
  const [file, role, arg] = process.argv.slice(1);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 0");
  const attempt = (sql) => { try { db.exec(sql); return "ok"; } catch (err) { return "code " + err.errcode; } };
  if (role === "hold") {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE; COMMIT");
    process.stdout.write("held\\n");
    process.stdin.on("data", () => { db.close(); process.exit(0); });
    process.stdin.on("end", () => { db.close(); process.exit(0); });
  } else if (role === "probe") {
    const report = { read: attempt("SELECT count(*) FROM sqlite_master"), write: attempt("CREATE TABLE IF NOT EXISTS probe (x INTEGER) STRICT") };
    db.close();
    process.stdout.write(JSON.stringify(report) + "\\n");
  } else {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE keystore SET seed_jwe = ? WHERE singleton = 1").run(Buffer.from(arg));
    if (db.prepare("SELECT CAST(seed_jwe AS TEXT) AS s FROM keystore").get().s !== arg) process.exit(2);
    process.exit(0);
  }
`;

function otherProcess(file: string, role: string, arg = "", stdin: "pipe" | "ignore" = "ignore"): { child: ReturnType<typeof spawn>; exited: Promise<number | null>; output: () => string } {
  const child = spawn(process.execPath, ["--no-warnings", "-e", OTHER_PROCESS, file, role, arg], { stdio: [stdin, "pipe", "inherit"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((done, reject) => {
    child.on("error", reject);
    child.on("exit", done);
  });
  return { child, exited, output: () => output };
}

function holdInAnotherProcess(file: string): Promise<{ quit: () => Promise<void> }> {
  const { child, exited, output } = otherProcess(file, "hold", "", "pipe");
  return new Promise((resolve, reject) => {
    child.stdout?.on("data", () => {
      if (output().includes("\n")) {
        resolve({
          quit: async () => {
            child.stdin?.end("quit");
            await exited;
          },
        });
      }
    });
    void exited.then((code) => {
      if (code !== 0) reject(new Error(`the holder exited with ${code}`));
    }, reject);
  });
}

async function probeInAnotherProcess(file: string): Promise<{ read: string; write: string }> {
  const { exited, output } = otherProcess(file, "probe");
  const code = await exited;
  if (code !== 0) throw new Error(`the probe exited with ${code} saying ${JSON.stringify(output())}`);
  return JSON.parse(output()) as { read: string; write: string };
}

async function interruptRewrapInAnotherProcess(file: string, seedJwe: string): Promise<void> {
  const { exited } = otherProcess(file, "rewrap", seedJwe);
  const code = await exited;
  if (code !== 0) throw new Error(`the rewrap process exited with ${code}`);
}
