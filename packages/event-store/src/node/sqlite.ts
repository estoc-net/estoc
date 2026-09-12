/**
 * The SQLite driver over `node:sqlite`: a `DatabaseSync` per connection,
 * ownership by SQLite's own exclusive locking mode. Node 22.13 is the
 * first to ship the module without a flag; it still prints an
 * ExperimentalWarning on first use.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DatabaseBusy, DatabaseExists, DatabaseMissing, InvalidSqlValue, SqliteError } from "../v3/errors.js";
import {
  Connection,
  exactInteger,
  ownBytes,
  type OpenMode,
  type RawConnection,
  type RawStatement,
  type SqlRow,
  type SqliteDriver,
  type SqlValue,
} from "../v3/sqlite/driver.js";

export interface NodeSqliteOptions {
  mode: OpenMode;
  /**
   * The journal a `create` leaves the new database in. `wal` with
   * `synchronous=NORMAL` is the runtime's; `delete` with
   * `synchronous=FULL` is the portable snapshot's, whose file must
   * stand alone with rollback-format headers. A `readwrite` open keeps
   * the journal the file has and sets `synchronous` to match; a
   * `readonly` open changes no page and leaves the journal mode alone.
   */
  journal?: "wal" | "delete";
}

const SQLITE_BUSY = 5;
const MEMORY = ":memory:";

/**
 * Opens the database at `path` (`:memory:` for a private one that
 * ends with the connection) and takes ownership of it under SQLite's
 * exclusive locking mode, which keeps a lock once taken until `close`.
 * A writable open takes the write lock with an empty immediate
 * transaction — no page is written — so a second open anywhere, this
 * process or another, meets `SQLITE_BUSY` at its first statement and
 * is refused with `DatabaseBusy`. A `readonly` open of a rollback-journal
 * file — a portable snapshot — is a read-only handle that keeps the
 * shared lock its first read takes: writers are excluded for as long as
 * it is open, other readers are not. A `readonly` open of a WAL file
 * takes the write lock exactly as a writable open does, since a WAL
 * reader keeps no lock that a writer would meet, and then forbids every
 * write through `query_only`; SQLite recovers the WAL on open and
 * checkpoints it on close, as it would for any last connection. Either
 * disables extension loading and trusts no schema.
 */
export function openNodeSqlite(path: string, options: NodeSqliteOptions): SqliteDriver {
  requireNodeSqlite();
  const { mode } = options;
  const inMemory = path === MEMORY;
  if (!inMemory) {
    if (mode === "create") reserve(path);
    else if (!exists(path)) throw new DatabaseMissing(path);
  }
  const readOnlyHandle = mode === "readonly" && (inMemory || !isWal(path));
  const db = sqlite(() => new DatabaseSync(path, { readOnly: readOnlyHandle, allowExtension: false, enableForeignKeyConstraints: true }));
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE");
    if (readOnlyHandle) {
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON");
      probe(path, () => db.prepare("PRAGMA application_id").get());
    } else {
      probe(path, () => db.exec("BEGIN IMMEDIATE; COMMIT"));
      if (mode === "readonly") db.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON");
      else {
        if (mode === "create" && !inMemory) db.exec(`PRAGMA journal_mode = ${options.journal ?? "wal"}`);
        db.exec(`PRAGMA synchronous = ${journalMode(db) === "wal" ? "NORMAL" : "FULL"}`);
      }
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return new Connection(new NodeConnection(db), mode);
}

function requireNodeSqlite(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`node:sqlite needs Node 22.13 or later; this is ${process.versions.node}`);
  }
}

/** Creates the file at `path` empty, or throws `DatabaseExists`: SQLite reads an empty file as an empty database, and the exclusive create makes the check and the claim one step. */
function reserve(path: string): void {
  try {
    closeSync(openSync(path, "wx"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new DatabaseExists(path);
    throw err;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Whether the file's header says WAL: byte 18, the file format write version, is 2 for WAL and 1 for a rollback journal. A file too short to have a header is an empty database, which is not in WAL. */
function isWal(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const header = new Uint8Array(19);
    return readSync(fd, header, 0, header.length, 0) === header.length && header[18] === 2;
  } finally {
    closeSync(fd);
  }
}

function journalMode(db: DatabaseSync): string {
  return String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
}

/** `touch`'s result, or `DatabaseBusy` when the lock another connection holds is what it met. */
function probe<T>(path: string, touch: () => T): T {
  try {
    return sqlite(touch);
  } catch (err) {
    if (err instanceof SqliteError && err.code === SQLITE_BUSY) throw new DatabaseBusy(path);
    throw err;
  }
}

/** `body`'s result, with what SQLite refused rethrown as `SqliteError`, and an integer Node would not hand out as `InvalidSqlValue`. */
function sqlite<T>(body: () => T): T {
  try {
    return body();
  } catch (err) {
    const { code, errcode, message } = err as { code?: string; errcode?: number; message: string };
    if (code === "ERR_SQLITE_ERROR" && typeof errcode === "number") throw new SqliteError(errcode, message);
    if (code === "ERR_OUT_OF_RANGE") throw new InvalidSqlValue(`a stored integer is outside the safe range and cannot be read exactly: ${message}`);
    throw err;
  }
}

class NodeConnection implements RawConnection {
  readonly version: string;

  constructor(private readonly db: DatabaseSync) {
    this.version = String((db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v);
  }

  exec(sql: string): void {
    sqlite(() => this.db.exec(sql));
  }

  prepare(sql: string): RawStatement {
    return new NodeStatement(sqlite(() => this.db.prepare(sql)));
  }

  close(): void {
    this.db.close();
  }
}

class NodeStatement implements RawStatement {
  constructor(private readonly statement: StatementSync) {}

  run(params: readonly SqlValue[]): number {
    return Number(sqlite(() => this.statement.run(...asInt64(params))).changes);
  }

  *rows(params: readonly SqlValue[]): IterableIterator<SqlRow> {
    const iterator = sqlite(() => this.statement.iterate(...asInt64(params)));
    try {
      for (;;) {
        const next = sqlite(() => iterator.next());
        if (next.done === true) return;
        yield exact(next.value as Record<string, unknown>);
      }
    } finally {
      iterator.return?.();
    }
  }

  finalize(): void {
    // `StatementSync` has no finalize: the statement is released with its database.
  }
}

/** Integral numbers as bigints, which Node binds as INTEGER; a number it binds as REAL, whatever its value. Already checked: every integer here is safe. */
function asInt64(params: readonly SqlValue[]): (SqlValue | bigint)[] {
  return params.map((value) => (typeof value === "number" && Number.isInteger(value) ? BigInt(value) : value));
}

/**
 * The row with every value in the driver's vocabulary: integers are
 * already checked (Node throws before handing out one it cannot
 * represent), bytes own their buffer. Text arrives as a string Node has
 * already made — cut at a NUL, invalid UTF-8 replaced — and nothing of
 * the stored bytes is left to check; text of a file another party wrote
 * is read as `CAST(column AS BLOB)` and decoded with `decodeText`.
 */
function exact(row: Record<string, unknown>): SqlRow {
  const out: SqlRow = {};
  for (const [column, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) out[column] = ownBytes(value);
    else if (typeof value === "bigint") out[column] = exactInteger(value, column);
    else out[column] = value as SqlValue;
  }
  return out;
}
