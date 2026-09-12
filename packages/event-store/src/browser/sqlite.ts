/**
 * The SQLite driver over `@sqlite.org/sqlite-wasm` and its OPFS
 * access-handle pool (`opfs-sahpool`): one pool per OPFS directory, one
 * connection per database in it. The pool runs in a Worker only — the
 * synchronous access handles it is built on exist nowhere else — and
 * holds a handle on every file in its directory for as long as it is
 * installed. Ownership is a Web Lock named for the directory, taken
 * before the pool is installed and held until it is closed: a second
 * Worker — another tab's, or this one's — finds the lock taken and is
 * refused before it touches the directory. The access handles would
 * refuse it too, but the pool's own failure path then tries to remove
 * its directory, and the lock keeps that path from ever running against
 * a directory in use. No cross-origin isolation is needed.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, PreparedStatement, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { DatabaseBusy, DatabaseExists, DatabaseMissing, SqliteError } from "../v3/errors.js";
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

export interface SqlitePoolOptions {
  /** The OPFS directory the pool owns, such as `/estoc/vaults`. Everything in it is the pool's: put nothing else there. */
  directory: string;
  /** Where `sqlite3.wasm` is served from, when not beside the script that bundles the module. */
  wasmUrl?: string;
}

/** A name in the pool: one path segment, no separators. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SqlitePool {
  readonly directory: string;
  /** The databases in the pool, by name. */
  names(): string[];
  /** Opens `name` under `mode` and takes it: a second open of the same name is refused with `DatabaseBusy` until the first closes. The pool grows first when the database and its journal need more handles than it has. */
  open(name: string, mode: OpenMode): Promise<SqliteDriver>;
  /** The complete bytes of the database file `name`, which no connection may hold open: what a portable snapshot is delivered as. */
  exportFile(name: string): Promise<Uint8Array>;
  /** Puts `bytes`, a complete SQLite database file, into the pool as `name`, which must not exist yet. */
  importFile(name: string, bytes: Uint8Array): Promise<void>;
  /** Deletes the database `name`, which no connection may hold open. */
  remove(name: string): void;
  /** Releases the pool's handles so another Worker may install over the directory. Every connection must be closed first. */
  close(): Promise<void>;
}

let runtime: Promise<Sqlite3Static> | undefined;

function loadRuntime(wasmUrl: string | undefined): Promise<Sqlite3Static> {
  if (runtime === undefined) {
    const init = sqlite3InitModule as unknown as (config: object) => Promise<Sqlite3Static>;
    runtime = init({
      print: () => {},
      printErr: () => {},
      ...(wasmUrl === undefined ? {} : { locateFile: (file: string, prefix: string) => (file.endsWith(".wasm") ? wasmUrl : prefix + file) }),
    }).then((sqlite3) => {
      // A failed step reaches the caller as `SqliteError`; the runtime's own console warning for it would only repeat that.
      sqlite3.config.warn = () => {};
      return sqlite3;
    });
  }
  return runtime;
}

/**
 * Takes the lock on `directory`, installs the pool over it and returns
 * the pool. Refused outside a Worker; refused with `DatabaseBusy` while
 * another pool, in any Worker of this origin, holds the directory.
 */
export async function openSqlitePool(options: SqlitePoolOptions): Promise<SqlitePool> {
  if (!("WorkerGlobalScope" in globalThis) || "window" in globalThis) {
    throw new Error("the SQLite pool runs in a Worker only: OPFS synchronous access handles are not available on the main thread");
  }
  const directory = options.directory.replace(/\/+$/, "");
  const lock = await takeLock(`estoc-sqlite-pool:${directory}`);
  if (lock === undefined) throw new DatabaseBusy(directory);
  try {
    const sqlite3 = await loadRuntime(options.wasmUrl);
    let util: SAHPoolUtil;
    try {
      const install = sqlite3.installOpfsSAHPoolVfs as (options: { name: string; directory: string; forceReinitIfPreviouslyFailed: boolean }) => Promise<SAHPoolUtil>;
      util = await install({ name: `estoc${directory.replace(/[^A-Za-z0-9]+/g, "-")}`, directory, forceReinitIfPreviouslyFailed: true });
      if (util.isPaused()) await util.unpauseVfs();
    } catch (err) {
      if ((err as { name?: string }).name === "NoModificationAllowedError") throw new DatabaseBusy(directory);
      throw err;
    }
    return new Pool(sqlite3, util, directory, lock);
  } catch (err) {
    lock();
    throw err;
  }
}

/** The lock `name`, held until the returned release is called; `undefined` when someone holds it already. */
function takeLock(name: string): Promise<(() => void) | undefined> {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(name, { ifAvailable: true }, (granted) => {
        if (granted === null) {
          resolve(undefined);
          return;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}

class Pool implements SqlitePool {
  private readonly open_ = new Set<string>();

  constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly util: SAHPoolUtil,
    readonly directory: string,
    private readonly releaseLock: () => void
  ) {}

  names(): string[] {
    return this.util
      .getFileNames()
      .filter((path) => path.startsWith("/") && NAME.test(path.slice(1)))
      .map((path) => path.slice(1))
      .sort();
  }

  async open(name: string, mode: OpenMode): Promise<SqliteDriver> {
    const path = pathOf(name);
    const target = `${this.directory}/${name}`;
    const exists = this.util.getFileNames().includes(path);
    if (mode === "create" && exists) throw new DatabaseExists(target);
    if (mode !== "create" && !exists) throw new DatabaseMissing(target);
    if (this.open_.has(name)) throw new DatabaseBusy(target);
    await this.reserve(exists ? 1 : 2);
    if (this.open_.has(name)) throw new DatabaseBusy(target);
    const PoolDb = this.util.OpfsSAHPoolDb as unknown as new (options: { filename: string; flags: string }) => Database;
    const db = sqlite(this.sqlite3, () => new PoolDb({ filename: path, flags: mode === "create" ? "c" : mode === "readwrite" ? "w" : "r" }));
    try {
      sqlite(this.sqlite3, () => {
        db.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON");
        if (mode === "readonly") db.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON");
        db.exec("PRAGMA application_id");
      });
    } catch (err) {
      db.close();
      throw err;
    }
    this.open_.add(name);
    return new Connection(new WasmConnection(this.sqlite3, db), mode, () => this.open_.delete(name));
  }

  async exportFile(name: string): Promise<Uint8Array> {
    this.requireClosed(name);
    return ownBytes(await this.util.exportFile(pathOf(name)));
  }

  async importFile(name: string, bytes: Uint8Array): Promise<void> {
    const path = pathOf(name);
    if (this.util.getFileNames().includes(path)) throw new DatabaseExists(`${this.directory}/${name}`);
    await this.util.importDb(path, bytes);
  }

  remove(name: string): void {
    this.requireClosed(name);
    if (!this.util.unlink(pathOf(name))) throw new DatabaseMissing(`${this.directory}/${name}`);
  }

  async close(): Promise<void> {
    if (this.open_.size > 0) throw new Error(`the pool still has ${this.open_.size} connection(s) open: close them before the pool`);
    this.util.pauseVfs();
    this.releaseLock();
  }

  /** Grows the pool until `handles` more files fit: a database takes one, its rollback journal another while a transaction is open. Capacity persists in the directory, so the pool grows once. */
  private async reserve(handles: number): Promise<void> {
    const spare = Number(this.util.getCapacity()) - Number(this.util.getFileCount());
    if (spare < handles) await this.util.addCapacity(handles - spare);
  }

  private requireClosed(name: string): void {
    if (this.open_.has(name)) throw new DatabaseBusy(`${this.directory}/${name}`);
  }
}

/** `body`'s result, with what SQLite refused rethrown as `SqliteError`. */
function sqlite<T>(sqlite3: Sqlite3Static, body: () => T): T {
  try {
    return body();
  } catch (err) {
    if (err instanceof sqlite3.SQLite3Error) throw new SqliteError(err.resultCode, err.message);
    throw err;
  }
}

function pathOf(name: string): string {
  if (!NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a database name: one path segment of letters, digits, '.', '_' and '-'`);
  return `/${name}`;
}

class WasmConnection implements RawConnection {
  readonly version: string;

  constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly db: Database
  ) {
    this.version = String(db.selectValue("SELECT sqlite_version()"));
  }

  exec(sql: string): void {
    sqlite(this.sqlite3, () => this.db.exec(sql));
  }

  prepare(sql: string): RawStatement {
    return new WasmStatement(this.sqlite3, this.db, sqlite(this.sqlite3, () => this.db.prepare(sql)));
  }

  close(): void {
    this.db.close();
  }
}

class WasmStatement implements RawStatement {
  private readonly columns: string[];

  constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly db: Database,
    private readonly statement: PreparedStatement
  ) {
    this.columns = statement.columnCount > 0 ? statement.getColumnNames() : [];
  }

  run(params: readonly SqlValue[]): number {
    return sqlite(this.sqlite3, () => {
      this.bind(params);
      try {
        while (this.statement.step()) {
          // A statement run for its effect may still return rows; they are not the caller's concern.
        }
        return Number(this.db.changes());
      } finally {
        this.statement.reset(true);
      }
    });
  }

  *rows(params: readonly SqlValue[]): IterableIterator<SqlRow> {
    const step = (): boolean => sqlite(this.sqlite3, () => this.statement.step());
    sqlite(this.sqlite3, () => this.bind(params));
    try {
      while (step()) yield this.row();
    } finally {
      this.statement.reset(true);
    }
  }

  finalize(): void {
    this.statement.finalize();
  }

  private bind(params: readonly SqlValue[]): void {
    this.statement.reset(true);
    if (params.length > 0) this.statement.bind([...params]);
  }

  /** The current row, each INTEGER read as the 64-bit value it is and checked, so a stored integer outside the safe range fails here instead of arriving rounded. */
  private row(): SqlRow {
    const { capi } = this.sqlite3;
    const pointer = this.statement.pointer as number;
    const out: SqlRow = {};
    this.columns.forEach((column, i) => {
      const type = capi.sqlite3_column_type(pointer, i);
      if (type === capi.SQLITE_INTEGER) out[column] = exactInteger(capi.sqlite3_column_int64(pointer, i), column);
      else if (type === capi.SQLITE_BLOB) out[column] = ownBytes(this.statement.getBlob(i) ?? new Uint8Array(0));
      else out[column] = this.statement.get(i) as SqlValue;
    });
    return out;
  }
}
