/**
 * The version-3 vault's SQLite schema: the tables a runtime and a
 * portable snapshot share, the control tables only a runtime has, and
 * what a database must look like before a row of it is read. The
 * shape is checked structurally — table names, columns, types, keys
 * and references through SQLite's own pragmas — because the SQL a
 * table was spelled with is not fixed, only what it made. Every name
 * read out of the schema is read as its stored bytes and decoded, the
 * rule for text of a file another party wrote, since a portable
 * snapshot is exactly that.
 */

import { NotAVault } from "../errors.js";
import { decodeText, type SqliteDriver, type SqlValue } from "./driver.js";

/** `PRAGMA application_id`: the bytes `ESTC`. */
export const APPLICATION_ID = 0x45535443;
/** `PRAGMA user_version`: the SQLite schema this module makes and accepts. */
export const SCHEMA_VERSION = 1;

export type DatabaseKind = "runtime" | "portable";

const COMMON_DDL = [
  `CREATE TABLE vault_meta (
    singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
    format        TEXT NOT NULL CHECK (format = 'estoc-sqlite'),
    vault_version INTEGER NOT NULL CHECK (vault_version = 3),
    kind          TEXT NOT NULL CHECK (kind IN ('runtime', 'portable')),
    ready         INTEGER NOT NULL CHECK (ready IN (0, 1)),
    anchor        TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE keystore (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version   INTEGER NOT NULL CHECK (version = 3),
    seed_jwe  BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE events (
    event_id  TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
    at        TEXT COLLATE BINARY NOT NULL,
    author    TEXT COLLATE BINARY NOT NULL,
    type      TEXT COLLATE BINARY NOT NULL,
    canonical BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE objects (
    cid  TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0)
  ) STRICT`,
  `CREATE TABLE object_chunks (
    cid      TEXT COLLATE BINARY NOT NULL REFERENCES objects(cid) ON DELETE CASCADE,
    chunk_no INTEGER NOT NULL CHECK (chunk_no >= 0),
    bytes    BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),
    PRIMARY KEY (cid, chunk_no)
  ) STRICT`,
];

const CONTROL_DDL = [
  `CREATE TABLE store_state (
    singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
    replica_id       TEXT NOT NULL,
    store_generation TEXT NOT NULL,
    last_seq         INTEGER NOT NULL CHECK (last_seq >= 0)
  ) STRICT`,
  `CREATE TABLE event_positions (
    accepted_seq INTEGER PRIMARY KEY CHECK (accepted_seq > 0),
    event_id     TEXT NOT NULL UNIQUE REFERENCES events(event_id)
  ) STRICT`,
];

/** Creates the tables of `kind` in an empty database: the common five, and for a runtime the two control tables. */
export function createTables(driver: SqliteDriver, kind: DatabaseKind): void {
  for (const sql of kind === "runtime" ? [...COMMON_DDL, ...CONTROL_DDL] : COMMON_DDL) driver.exec(sql);
}

type ColumnType = "INTEGER" | "TEXT" | "BLOB";

interface Column {
  name: string;
  type: ColumnType;
  notNull: boolean;
  /** 0 when not part of the primary key, else its 1-based place in it. */
  pk: number;
}

interface ForeignKey {
  from: string;
  table: string;
  to: string;
  onDelete: string;
}

/** A table as the pragmas describe it: what the DDL above makes, and what a database must match. */
interface TableShape {
  columns: Column[];
  /** The column lists of the UNIQUE constraints, each in declaration order. */
  uniques: string[][];
  foreignKeys: ForeignKey[];
}

const column = (name: string, type: ColumnType, notNull = true, pk = 0): Column => ({ name, type, notNull, pk });

const COMMON_TABLES: Record<string, TableShape> = {
  vault_meta: {
    columns: [column("singleton", "INTEGER", false, 1), column("format", "TEXT"), column("vault_version", "INTEGER"), column("kind", "TEXT"), column("ready", "INTEGER"), column("anchor", "TEXT")],
    uniques: [],
    foreignKeys: [],
  },
  keystore: {
    columns: [column("singleton", "INTEGER", false, 1), column("version", "INTEGER"), column("seed_jwe", "BLOB")],
    uniques: [],
    foreignKeys: [],
  },
  events: {
    columns: [column("event_id", "TEXT", true, 1), column("at", "TEXT"), column("author", "TEXT"), column("type", "TEXT"), column("canonical", "BLOB")],
    uniques: [],
    foreignKeys: [],
  },
  objects: {
    columns: [column("cid", "TEXT", true, 1), column("size", "INTEGER")],
    uniques: [],
    foreignKeys: [],
  },
  object_chunks: {
    columns: [column("cid", "TEXT", true, 1), column("chunk_no", "INTEGER", true, 2), column("bytes", "BLOB")],
    uniques: [],
    foreignKeys: [{ from: "cid", table: "objects", to: "cid", onDelete: "CASCADE" }],
  },
};

const CONTROL_TABLES: Record<string, TableShape> = {
  store_state: {
    columns: [column("singleton", "INTEGER", false, 1), column("replica_id", "TEXT"), column("store_generation", "TEXT"), column("last_seq", "INTEGER")],
    uniques: [],
    foreignKeys: [],
  },
  event_positions: {
    columns: [column("accepted_seq", "INTEGER", false, 1), column("event_id", "TEXT")],
    uniques: [["event_id"]],
    foreignKeys: [{ from: "event_id", table: "events", to: "event_id", onDelete: "NO ACTION" }],
  },
};

/** A table a runtime may keep beside the schema's: its own local state, or the statistics `ANALYZE` leaves. */
const RUNTIME_EXTRA_TABLE = /^(local_[a-z0-9_]+|sqlite_stat[1-4])$/;

/**
 * Checks that the database holds exactly the schema of `kind` — every
 * table of it with the columns, types, keys and references of schema
 * version 1, all `STRICT` — and nothing that is not allowed beside it:
 * a portable snapshot has the five common tables and the indexes their
 * constraints made, no more; a runtime has the control tables too and
 * may add indexes, `local_*` tables and `ANALYZE` statistics. A view or
 * a trigger is refused in either. `NotAVault` names the first thing
 * that does not fit; nothing is read from any table.
 */
export function checkSchema(driver: SqliteDriver, kind: DatabaseKind): void {
  const expected = kind === "runtime" ? { ...COMMON_TABLES, ...CONTROL_TABLES } : COMMON_TABLES;
  const objects = driver
    .prepare("SELECT type, CAST(name AS BLOB) AS name FROM sqlite_master ORDER BY type, name")
    .all()
    .map((row) => ({ type: String(row["type"]), name: text(row["name"], "sqlite_master.name") }));
  for (const object of objects) {
    if (object.type !== "table" && object.type !== "index") throw new NotAVault(`the schema has a ${object.type}, ${object.name}: a vault has tables and their indexes only`);
  }
  const tables = new Set(objects.filter((object) => object.type === "table").map((object) => object.name));
  for (const name of Object.keys(expected)) {
    if (!tables.has(name)) throw new NotAVault(`table ${name} is missing`);
  }
  for (const name of tables) {
    if (name in expected) continue;
    if (kind === "runtime" && RUNTIME_EXTRA_TABLE.test(name)) continue;
    throw new NotAVault(`table ${name} is not in the ${kind} schema`);
  }
  for (const [name, shape] of Object.entries(expected)) checkTable(driver, name, shape, kind);
}

function checkTable(driver: SqliteDriver, name: string, expected: TableShape, kind: DatabaseKind): void {
  const strict = driver.prepare("SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(name);
  if (strict?.["strict"] !== 1) throw new NotAVault(`table ${name} is not STRICT`);
  const columns = driver
    .prepare('SELECT CAST(name AS BLOB) AS name, CAST(type AS BLOB) AS type, "notnull" AS not_null, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid')
    .all(name)
    .map((row): Column & { hidden: SqlValue } => ({
      name: text(row["name"], `${name} column`),
      type: text(row["type"], `${name} column type`).toUpperCase() as ColumnType,
      notNull: row["not_null"] === 1,
      pk: Number(row["pk"]),
      hidden: row["hidden"] ?? null,
    }));
  const hidden = columns.find((c) => c.hidden !== 0);
  if (hidden !== undefined) throw new NotAVault(`table ${name}: column ${hidden.name} is generated or hidden`);
  const uniques: string[][] = [];
  for (const index of driver.prepare("SELECT CAST(name AS BLOB) AS name, origin FROM pragma_index_list(?) ORDER BY seq").all(name)) {
    const origin = String(index["origin"]);
    if (origin === "u") {
      const indexName = text(index["name"], `${name} index`);
      uniques.push(driver.prepare("SELECT CAST(name AS BLOB) AS name FROM pragma_index_info(?) ORDER BY seqno").all(indexName).map((row) => text(row["name"], `${indexName} column`)));
    } else if (origin !== "pk" && kind === "portable") {
      throw new NotAVault(`table ${name} has an index a constraint did not make: a portable snapshot has none`);
    }
  }
  const foreignKeys = driver
    .prepare('SELECT CAST("table" AS BLOB) AS "table", CAST("from" AS BLOB) AS "from", CAST("to" AS BLOB) AS "to", on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq')
    .all(name)
    .map((row): ForeignKey => ({ from: text(row["from"], `${name} foreign key`), table: text(row["table"], `${name} foreign key`), to: text(row["to"], `${name} foreign key`), onDelete: String(row["on_delete"]) }));
  const actual: TableShape = { columns: columns.map(({ name: n, type, notNull, pk }) => ({ name: n, type, notNull, pk })), uniques, foreignKeys };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new NotAVault(`table ${name} is not schema version ${SCHEMA_VERSION}'s: expected ${describe(expected)}; found ${describe(actual)}`);
  }
}

function describe(shape: TableShape): string {
  const columns = shape.columns.map((c) => `${c.name} ${c.type}${c.notNull ? " NOT NULL" : ""}${c.pk > 0 ? ` PK${c.pk}` : ""}`);
  const uniques = shape.uniques.map((u) => `UNIQUE(${u.join(", ")})`);
  const references = shape.foreignKeys.map((f) => `${f.from} REFERENCES ${f.table}(${f.to}) ON DELETE ${f.onDelete}`);
  return [...columns, ...uniques, ...references].join(", ");
}

/** The stored bytes `value` as the text they spell: the schema's names, read the way a foreign file's text is; `NotAVault` when they spell none. */
export function text(value: SqlValue | undefined, what: string): string {
  if (!(value instanceof Uint8Array)) throw new NotAVault(`${what} is not text`);
  try {
    return decodeText(value, what);
  } catch (err) {
    throw new NotAVault(err instanceof Error ? err.message : String(err));
  }
}
