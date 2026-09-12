/**
 * The SQLite driver the version-3 stores are written against: one
 * synchronous connection, prepared statements with positional
 * parameters, and transactions. Two adapters implement it — `node:sqlite`
 * under `@estoc/event-store/node`, `@sqlite.org/sqlite-wasm` over the
 * OPFS access-handle pool under `@estoc/event-store/browser` — and both
 * carry values the same way: text, safe integers, doubles, bytes and
 * null, exactly or not at all. What a value must be to cross is decided
 * here, once, before the statement runs; what comes back is checked the
 * same way, so a stored integer the platform cannot represent fails the
 * read instead of rounding.
 */

import { DatabaseClosed, InvalidSqlValue } from "../errors.js";

/** What a parameter or column value can be. An integral `number` in the safe range binds as INTEGER, any other finite `number` as REAL. */
export type SqlValue = string | number | Uint8Array | null;

export type SqlRow = Record<string, SqlValue>;

export type TransactionMode = "deferred" | "immediate" | "exclusive";

/**
 * How a database is opened. `create` needs a target nothing is at and
 * makes it; `readwrite` and `readonly` need one that exists. A writable
 * open takes ownership: a second open of the same target, in this
 * process or another, is refused with `DatabaseBusy` until this one
 * closes. A `readonly` open excludes writers for as long as it is open
 * and hardens the connection for a file another party wrote — no
 * writes, no extension loading, untrusted schema — but shares the file
 * with other readers where the platform can: an immutable snapshot may
 * be validated and delivered at once.
 */
export type OpenMode = "create" | "readwrite" | "readonly";

export interface SqliteStatement {
  /** Runs the statement to completion; the number of rows it changed. */
  run(...params: SqlValue[]): { changes: number };
  /** The first row, or `undefined` when there is none. */
  get(...params: SqlValue[]): SqlRow | undefined;
  /** Every row, in the order SQLite returns them. */
  all(...params: SqlValue[]): SqlRow[];
  /** The rows one at a time, stepped as consumed; returning early resets the statement. A statement iterates one query at a time, and an iterator it hands out is consumed or returned before the next call. */
  iterate(...params: SqlValue[]): IterableIterator<SqlRow>;
  /** Releases the statement; further use is an error. */
  finalize(): void;
}

export interface SqliteDriver {
  readonly mode: OpenMode;
  /** The version SQLite reports, such as `3.47.2`. */
  readonly version: string;
  /** Runs one or more statements that take no parameters and return nothing of interest. */
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * `BEGIN <mode>`, `body`, `COMMIT`; a throw from `body` rolls back and
   * rethrows. Transactions do not nest: a `transaction` inside one is
   * an error, so a routine that needs a transaction either owns it or
   * runs inside its caller's. `body` is synchronous, as the whole driver
   * is: a transaction never spans an `await`.
   */
  transaction<T>(mode: TransactionMode, body: () => T): T;
  /** Whether a transaction opened by `transaction` is in progress. */
  readonly inTransaction: boolean;
  /** Finalizes every statement, closes the connection and releases ownership. Idempotent. */
  close(): void;
}

/**
 * What an adapter provides: the platform's connection, unguarded. The
 * shared `Connection` above it checks values, tracks statements, keeps
 * transactions from nesting and refuses use after close.
 */
export interface RawConnection {
  readonly version: string;
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

export interface RawStatement {
  /** Binds `params` — already checked and copied — runs to completion, and reports the change count. */
  run(params: readonly SqlValue[]): number;
  /**
   * Binds `params`, steps as the iterator is pulled, and resets when it
   * finishes or is returned early. Column values arrive as `SqlValue`s
   * the adapter has already made exact: an integer the platform cannot
   * represent throws `InvalidSqlValue` from the step that meets it.
   */
  rows(params: readonly SqlValue[]): IterableIterator<SqlRow>;
  finalize(): void;
}

const LONE_SURROGATE = /\p{Cs}/u;

/** `params` as the adapter may bind them, or `InvalidSqlValue` naming the first that cannot cross exactly. Bytes are copied, so a caller may reuse its buffer once the call returns. */
export function checkParams(params: readonly unknown[]): SqlValue[] {
  return params.map((value, i) => checkValue(value, i + 1));
}

function checkValue(value: unknown, index: number): SqlValue {
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.includes("\u0000")) throw new InvalidSqlValue(`parameter ${index}: a string with a NUL cannot cross a SQLite text boundary intact`);
    if (LONE_SURROGATE.test(value)) throw new InvalidSqlValue(`parameter ${index}: an unpaired surrogate is not UTF-8 and would not come back as it went in`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidSqlValue(`parameter ${index}: ${value} is not a finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new InvalidSqlValue(`parameter ${index}: ${value} is outside the safe integer range and would not round-trip exactly`);
    }
    return value;
  }
  if (value instanceof Uint8Array) return new Uint8Array(value);
  const kind = typeof value === "bigint" ? "a bigint" : typeof value === "boolean" ? "a boolean" : value === undefined ? "undefined" : `a ${typeof value}`;
  throw new InvalidSqlValue(`parameter ${index}: ${kind} is not a SQL value; bind text, a safe integer, a finite double, bytes or null`);
}

/** The `number` a stored INTEGER becomes, or `InvalidSqlValue` when the platform's integer is outside the safe range. */
export function exactInteger(value: number | bigint, column: string): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new InvalidSqlValue(`column ${column}: the stored integer ${value} is outside the safe range and cannot be read exactly`);
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value)) {
    throw new InvalidSqlValue(`column ${column}: the stored integer ${value} is outside the safe range and cannot be read exactly`);
  }
  return value;
}

/** `bytes` owning exactly its own buffer: a view over a larger one is copied so the caller never holds a slice of platform memory. */
export function ownBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
}

/** The driver over a `RawConnection`: what both adapters share. */
export class Connection implements SqliteDriver {
  readonly version: string;
  private readonly statements = new Set<Statement>();
  private closed = false;
  private transacting = false;

  constructor(
    private readonly raw: RawConnection,
    readonly mode: OpenMode,
    private readonly released: () => void = () => {}
  ) {
    this.version = raw.version;
  }

  get inTransaction(): boolean {
    return this.transacting;
  }

  exec(sql: string): void {
    this.check();
    this.raw.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    this.check();
    const statement = new Statement(this.raw.prepare(sql), () => this.check(), (s) => this.statements.delete(s));
    this.statements.add(statement);
    return statement;
  }

  transaction<T>(mode: TransactionMode, body: () => T): T {
    this.check();
    if (this.transacting) throw new Error("a transaction is already in progress: transactions do not nest");
    this.raw.exec(`BEGIN ${mode.toUpperCase()}`);
    this.transacting = true;
    let result: T;
    try {
      result = body();
    } catch (err) {
      this.rollback();
      throw err;
    }
    try {
      this.raw.exec("COMMIT");
    } catch (err) {
      this.rollback();
      throw err;
    }
    this.transacting = false;
    return result;
  }

  private rollback(): void {
    this.transacting = false;
    try {
      this.raw.exec("ROLLBACK");
    } catch {
      // A failed COMMIT has usually rolled back already; the transaction is over either way.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const statement of [...this.statements]) statement.finalize();
    try {
      this.raw.close();
    } finally {
      this.released();
    }
  }

  private check(): void {
    if (this.closed) throw new DatabaseClosed();
  }
}

class Statement implements SqliteStatement {
  private finalized = false;
  private iterating = false;

  constructor(
    private readonly raw: RawStatement,
    private readonly connectionOpen: () => void,
    private readonly onFinalize: (s: Statement) => void
  ) {}

  run(...params: SqlValue[]): { changes: number } {
    this.check();
    return { changes: this.raw.run(checkParams(params)) };
  }

  get(...params: SqlValue[]): SqlRow | undefined {
    for (const row of this.iterate(...params)) return row;
    return undefined;
  }

  all(...params: SqlValue[]): SqlRow[] {
    return [...this.iterate(...params)];
  }

  iterate(...params: SqlValue[]): IterableIterator<SqlRow> {
    this.check();
    if (this.iterating) throw new Error("the statement is already iterating: finish or return that iteration first");
    const bound = checkParams(params);
    this.iterating = true;
    return this.pull(bound);
  }

  private *pull(bound: SqlValue[]): IterableIterator<SqlRow> {
    try {
      yield* this.raw.rows(bound);
    } finally {
      this.iterating = false;
    }
  }

  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.onFinalize(this);
    this.raw.finalize();
  }

  private check(): void {
    this.connectionOpen();
    if (this.finalized) throw new Error("the statement is finalized");
  }
}
