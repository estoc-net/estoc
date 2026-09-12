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
  decodeText,
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
  /** The OPFS directory the pool owns, such as `/estoc/vaults`: one or more path segments under the OPFS root, none `.` or `..`. Everything in it is the pool's: put nothing else there. */
  directory: string;
  /** Where `sqlite3.wasm` is served from, when not beside the script that bundles the module. */
  wasmUrl?: string;
}

/** A name in the pool: one path segment, no separators. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The file a name is stored as. SQLite names the files it keeps beside
 * a database by appending to the database's name — `-journal`, `-wal`
 * and so on — so the names of databases must not be able to spell
 * each other's sidecars: a database file always ends in the suffix, a
 * sidecar never does.
 */
const SUFFIX = ".sqlite";

const ROLLBACK_JOURNAL_SUFFIX = "-journal";

/**
 * The files a writable connection creates under names of SQLite's
 * choosing as it works, each taking a handle of the pool while it is
 * open: its temporary database — a file, since the wasm build would
 * otherwise keep it in memory — and that database's journal, both
 * held until the connection closes once made; the statement journal
 * a transaction opens when a statement that may fail partway outgrows
 * the memory it is buffered in, as the repair of a large object does,
 * closed with the transaction; and the file a sort spills to when the
 * rows outgrow the cache, as a scan of many events does, closed with
 * the sort. One sort at a time is assumed. Its rollback journal,
 * named after the database, is the fifth file it creates.
 */
const TEMPORARY_FILES = 4;

export interface SqlitePool {
  readonly directory: string;
  /** The databases in the pool, by name: the files SQLite keeps beside a database during a transaction are not among them. */
  names(): string[];
  /**
   * Opens `name` under `mode` and takes it: a second open of the same
   * name is refused with `DatabaseBusy` until the first closes. The
   * pool grows first when the database and what the connection may
   * create beside it need more handles than it has to spare, where the
   * handles the other open connections may still take are not spare:
   * a writable connection creates its rollback journal, its temporary
   * database, that database's journal, a statement journal and a
   * sort's spill file as it works, and no open or import in between
   * may take the handles they will need.
   */
  open(name: string, mode: OpenMode): Promise<SqliteDriver>;
  /** The complete bytes of the database file `name`, which no connection may hold open: what a portable snapshot is delivered as. */
  exportFile(name: string): Promise<Uint8Array>;
  /**
   * Puts `bytes`, a complete SQLite database file, into the pool as
   * `name`, which must not exist yet; the pool grows first when it has
   * no handle to spare. The bytes are the caller's to validate before
   * they come here: they are stored as they are except the two file
   * format version bytes, which the pool sets to the rollback journal's,
   * so whatever the source's headers were is not visible afterwards.
   */
  importFile(name: string, bytes: Uint8Array): Promise<void>;
  /** Deletes the database `name`, which no connection may hold open. */
  remove(name: string): void;
  /** Releases the pool's handles so another Worker may install over the directory. Every connection must be closed first. Afterwards every call is refused: the directory is the next owner's. */
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
  const directory = normalizeDirectory(options.directory);
  // One key names the directory to both the lock and the VFS registry, so two spellings of one directory contend for one lock and two directories never share a pool.
  const key = `estoc-sqlite-pool:${directory}`;
  const lock = await takeLock(key);
  if (lock === undefined) throw new DatabaseBusy(directory);
  try {
    const sqlite3 = await loadRuntime(options.wasmUrl);
    let util: SAHPoolUtil;
    try {
      const install = sqlite3.installOpfsSAHPoolVfs as (options: { name: string; directory: string; forceReinitIfPreviouslyFailed: boolean }) => Promise<SAHPoolUtil>;
      util = await install({ name: key, directory, forceReinitIfPreviouslyFailed: true });
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

function normalizeDirectory(input: string): string {
  const segments = input.split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${JSON.stringify(input)} is not a pool directory: one or more path segments under the OPFS root, none '.' or '..'`);
  }
  return `/${segments.join("/")}`;
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
  private readonly writableByName = new Map<string, boolean>();
  private pending = 0;
  private closed = false;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly util: SAHPoolUtil,
    readonly directory: string,
    private readonly releaseLock: () => void
  ) {}

  names(): string[] {
    this.live();
    return this.util
      .getFileNames()
      .filter((path) => path.startsWith("/") && path.endsWith(SUFFIX))
      .map((path) => path.slice(1, -SUFFIX.length))
      .filter((name) => NAME.test(name))
      .sort();
  }

  async open(name: string, mode: OpenMode): Promise<SqliteDriver> {
    const path = pathOf(name);
    const target = `${this.directory}/${name}`;
    return this.inTurn(async () => {
      const exists = this.has(path);
      if (mode === "create" && exists) throw new DatabaseExists(target);
      if (mode !== "create" && !exists) throw new DatabaseMissing(target);
      if (this.writableByName.has(name)) throw new DatabaseBusy(target);
      await this.reserve((exists ? 0 : 1) + (mode === "readonly" ? 0 : 1 + TEMPORARY_FILES));
      const PoolDb = this.util.OpfsSAHPoolDb as unknown as new (options: { filename: string; flags: string }) => Database;
      const db = sqlite(this.sqlite3, () => new PoolDb({ filename: path, flags: mode === "create" ? "c" : mode === "readwrite" ? "w" : "r" }));
      let connection: WasmConnection;
      try {
        sqlite(this.sqlite3, () => {
          db.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON");
          if (mode === "readonly") db.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON");
          else db.exec("PRAGMA temp_store = FILE");
          db.exec("PRAGMA application_id");
        });
        connection = new WasmConnection(this.sqlite3, db);
      } catch (err) {
        db.close();
        throw err;
      }
      this.writableByName.set(name, mode !== "readonly");
      return new Connection(connection, mode, () => this.writableByName.delete(name));
    });
  }

  async exportFile(name: string): Promise<Uint8Array> {
    const path = pathOf(name);
    this.live();
    this.requireClosed(name);
    if (!this.has(path)) throw new DatabaseMissing(`${this.directory}/${name}`);
    return ownBytes(await this.util.exportFile(path));
  }

  async importFile(name: string, bytes: Uint8Array): Promise<void> {
    const path = pathOf(name);
    return this.inTurn(async () => {
      if (this.has(path)) throw new DatabaseExists(`${this.directory}/${name}`);
      await this.reserve(1);
      await this.util.importDb(path, bytes);
    });
  }

  remove(name: string): void {
    const path = pathOf(name);
    this.live();
    this.requireClosed(name);
    if (!this.util.unlink(path)) throw new DatabaseMissing(`${this.directory}/${name}`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.writableByName.size > 0) throw new Error(`the pool still has ${this.writableByName.size} connection(s) open: close them before the pool`);
    if (this.pending > 0) throw new Error(`the pool still has ${this.pending} open or import in progress: let it finish before closing the pool`);
    this.util.pauseVfs();
    this.closed = true;
    this.releaseLock();
  }

  /**
   * Runs `body` once every open and import started before it has
   * finished: each looks at the names and the spare handles before it
   * takes a name and a handle, and two that looked together would both
   * find a name free or both count one spare handle as theirs.
   */
  private inTurn<T>(body: () => Promise<T>): Promise<T> {
    this.live();
    this.pending++;
    const result = this.turn.then(body).finally(() => this.pending--);
    this.turn = result.catch(() => undefined);
    return result;
  }

  /** Grows the pool until `handles` more files fit beside the files it holds and the ones its open connections may still create. Capacity persists in the directory, so the pool grows once. */
  private async reserve(handles: number): Promise<void> {
    const spare = Number(this.util.getCapacity()) - Number(this.util.getFileCount()) - this.outstanding();
    if (spare < handles) await this.util.addCapacity(handles - spare);
  }

  /**
   * The handles the open writable connections may still take: each
   * creates its rollback journal when a transaction first writes, and
   * its temporary files as it works. What is created already is among
   * the pool's files: a rollback journal is told by its name, and every
   * temporary file present is some open writable connection's, so what
   * they may still create between them is their count of temporary
   * files less those present.
   */
  private outstanding(): number {
    const files = this.util.getFileNames();
    let journals = 0;
    let writable = 0;
    for (const [name, writes] of this.writableByName) {
      if (!writes) continue;
      writable += 1;
      if (!files.includes(`${pathOf(name)}${ROLLBACK_JOURNAL_SUFFIX}`)) journals += 1;
    }
    const temporary = files.filter((path) => !path.endsWith(SUFFIX) && !path.endsWith(ROLLBACK_JOURNAL_SUFFIX)).length;
    return journals + Math.max(0, TEMPORARY_FILES * writable - temporary);
  }

  private has(path: string): boolean {
    return this.util.getFileNames().includes(path);
  }

  private live(): void {
    if (this.closed) throw new Error(`the pool over ${this.directory} is closed: the directory belongs to whoever opens it next`);
  }

  private requireClosed(name: string): void {
    if (this.writableByName.has(name)) throw new DatabaseBusy(`${this.directory}/${name}`);
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
  return `/${name}${SUFFIX}`;
}

class WasmConnection implements RawConnection {
  readonly version: string;

  constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly db: Database
  ) {
    this.version = String(sqlite(sqlite3, () => db.selectValue("SELECT sqlite_version()")));
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

  /** The current row, each INTEGER read as the 64-bit value it is and each TEXT as its stored bytes, both checked: an integer outside the safe range or text that is not text fails here instead of arriving rounded or repaired. */
  private row(): SqlRow {
    const { capi } = this.sqlite3;
    const pointer = this.statement.pointer as number;
    const out: SqlRow = {};
    this.columns.forEach((column, i) => {
      const type = capi.sqlite3_column_type(pointer, i);
      if (type === capi.SQLITE_INTEGER) out[column] = exactInteger(capi.sqlite3_column_int64(pointer, i), column);
      else if (type === capi.SQLITE_BLOB) out[column] = this.bytes(i);
      else if (type === capi.SQLITE_TEXT) out[column] = decodeText(this.bytes(i), column);
      else out[column] = this.statement.get(i) as SqlValue;
    });
    return out;
  }

  /** Column `i`'s stored bytes, copied out of wasm memory: the BLOB, or the UTF-8 of a TEXT, which SQLite hands over unconverted. */
  private bytes(i: number): Uint8Array {
    const { capi, wasm } = this.sqlite3;
    const pointer = this.statement.pointer as number;
    const n = capi.sqlite3_column_bytes(pointer, i);
    if (n === 0) return new Uint8Array(0);
    const at = Number(capi.sqlite3_column_blob(pointer, i));
    return wasm.heap8u().slice(at, at + n);
  }
}
