/**
 * Creating and opening the version-3 vault in SQLite: what a database
 * must show before anything in it is trusted, checked in an order that
 * reads nothing ahead of what vouches for it, and what the caller gets
 * once it has. Ownership is the driver's. A create or open that fails,
 * for any reason, closes the driver it was given: ownership must not
 * stay with a handle nobody can use.
 */

import { v7 } from "uuid";

import { AnchorMismatch, DamagedControl, NotAVault, ReadOnlyVault, SnapshotTooLarge, SqliteError, VaultClosed } from "../errors.js";
import { isUuidv7, type AuthorId } from "../event.js";
import { checkMetadata, checkWrappedSeed, type KeystoreAccess, type VaultMetadata, type WrappedSeed } from "../keystore.js";
import type { Vault } from "../vault.js";
import type { SqliteDriver, SqlValue } from "./driver.js";
import { dropCache } from "./local.js";
import { PortableVault } from "./portable.js";
import { APPLICATION_ID, SCHEMA_VERSION, checkSchema, createTables, query, run, text, type DatabaseKind } from "./schema.js";

/** Runs `op` under the vault's operation lock: what a rewrap is serialized by. */
export type Locked = <T>(op: () => Promise<T>) => Promise<T>;

/** A runtime database, open and checked: what the stores are built over. */
export interface RuntimeDatabase {
  readonly driver: SqliteDriver;
  readonly metadata: VaultMetadata;
  /** The local replica, `store_state.replica_id`: the author of every event committed here. */
  readonly author: AuthorId;
  /** `store_state.store_generation`: what change tokens are bound to. */
  readonly generation: string;
  /** Whether writes are admitted: a runtime opened to run, or an inspector that makes none. */
  readonly writable: boolean;
  /** The wrapped seed over `locked`: `read` any time, `rewrap` one transaction under the lock. */
  keystore(locked: Locked): KeystoreAccess;
  /** Closes the driver and with it ownership. Idempotent; afterwards every call is `VaultClosed`. */
  close(): void;
}

/**
 * A portable snapshot, open read-only and checked as far as its
 * metadata and wrapper: what validation and inspection go on from.
 * `vault` reads it as a `Vault` — scans in canonical order, objects
 * under their read and damage rules — that refuses `commit` and
 * `changes`; whether it is complete is `validatePortable`'s to say.
 */
export interface PortableDatabase {
  readonly driver: SqliteDriver;
  readonly metadata: VaultMetadata;
  readonly wrapped: WrappedSeed;
  readonly vault: Vault;
  /** Closes the driver; afterwards every read through `vault` is `VaultClosed`, `commit` and `changes` refused as ever. Idempotent. */
  close(): void;
}

export interface CreateRuntimeOptions {
  metadata: VaultMetadata;
  wrapped: WrappedSeed;
}

export interface OpenRuntimeOptions {
  /**
   * The anchor DID the seed derives, given outright when the seed is in
   * hand, or as the function that unlocks the wrapped seed the vault
   * holds and derives it — a wrong passphrase fails there. Either way
   * it is compared with the vault's before anything is written or the
   * identity used: `AnchorMismatch` closes the open.
   */
  anchor: string | ((wrapped: WrappedSeed) => string | Promise<string>);
  /**
   * Give the runtime a fresh replica ID and store generation, its
   * history untouched: the recovery from `ForkedAuthor`, where two
   * writable copies shared one replica ID. Once the anchor is verified
   * and the control checked, one transaction replaces both IDs and
   * drops the cache, which may hold what was built for the old
   * generation; events, positions, options and the keystore stay, and
   * every change token of the old generation is refused from then on.
   */
  resetIdentity?: boolean;
}

const FORMAT = "estoc-sqlite";
const VAULT_VERSION = 3;

/**
 * Makes a runtime in the empty database `driver` was opened to create:
 * schema, metadata, the wrapped seed and fresh local control, published
 * `ready` in one transaction, so an interruption leaves an empty file
 * that opens as nothing. Returns the runtime open, on the same
 * connection.
 */
export function createRuntime(driver: SqliteDriver, options: CreateRuntimeOptions): RuntimeDatabase {
  return closingOnFailure(driver, () => {
    requireMode(driver, "create");
    const metadata = checkMetadata(options.metadata);
    const wrapped = checkWrappedSeed(options.wrapped);
    const author = v7() as AuthorId;
    const generation = v7();
    if (count(driver, "sqlite_master") > 0) throw new Error("a runtime is created in an empty database: this one already has a schema");
    driver.transaction("immediate", () => {
      driver.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
      createTables(driver, "runtime");
      run(driver, "INSERT INTO vault_meta (singleton, format, vault_version, kind, ready, anchor) VALUES (1, ?, ?, 'runtime', 1, ?)", FORMAT, VAULT_VERSION, metadata.anchor);
      run(driver, "INSERT INTO keystore (singleton, version, seed_jwe) VALUES (1, 3, ?)", new TextEncoder().encode(wrapped.seedJwe));
      run(driver, "INSERT INTO store_state (singleton, replica_id, store_generation, last_seq) VALUES (1, ?, ?, 0)", author, generation);
    });
    return new Opened(driver, metadata, author, generation, true);
  });
}

/**
 * Opens the runtime in `driver`, which was opened `readwrite` and so
 * owns the file, with SQLite's journal recovery already done. Nothing
 * is written unless the identity is to be reset, and that only after
 * every check has passed; the anchor is checked before the control,
 * and a failure at any check closes the driver.
 */
export async function openRuntime(driver: SqliteDriver, options: OpenRuntimeOptions): Promise<RuntimeDatabase> {
  try {
    requireMode(driver, "readwrite");
    const metadata = checkRuntime(driver);
    const wrapped = readWrapped(driver);
    const derived = typeof options.anchor === "string" ? options.anchor : await options.anchor(wrapped);
    if (derived !== metadata.anchor) throw new AnchorMismatch(metadata.anchor, derived);
    const control = checkControl(driver);
    const { author, generation } = options.resetIdentity === true ? renewIdentity(driver) : control;
    return new Opened(driver, metadata, author, generation, true);
  } catch (err) {
    driver.close();
    throw err;
  }
}

/**
 * Opens the runtime in `driver` to look at, never to write: the same
 * checks as a run, without the seed — an inspector uses no identity —
 * on the connection set to refuse every write. The driver must have
 * been opened `readwrite`, the one mode that owns the file outright on
 * every platform: a `readonly` driver may share a rollback-journal
 * file with other readers, which a runtime's inspector must not.
 */
export function openInspector(driver: SqliteDriver): RuntimeDatabase {
  return closingOnFailure(driver, () => {
    requireMode(driver, "readwrite");
    driver.exec("PRAGMA query_only = ON");
    const metadata = checkRuntime(driver);
    readWrapped(driver);
    const { author, generation } = checkControl(driver);
    return new Opened(driver, metadata, author, generation, false);
  });
}

export interface OpenPortableOptions {
  /**
   * The most bytes the file may hold, as its header states them — the
   * page count times the page size, which is all SQLite will read of
   * it — checked before anything else is: what every row, column,
   * chunk and check after it, the validation included, lies within.
   * `SnapshotTooLarge` past it. Unbounded when left out.
   */
  maxFileBytes?: number;
}

/**
 * Opens the portable snapshot in `driver`, which was opened `readonly`
 * — no writes, no extensions, an untrusted schema, no constraint of
 * the file's evaluated — and checks it as far as its metadata and
 * wrapper: its size within `maxFileBytes`, the file's identity and
 * rollback-format headers, then the schema, then the two rows that say
 * what it is, and nothing else. Whether its events and objects are
 * what they claim is the validation that comes after, on the same
 * handle.
 */
export function openPortable(driver: SqliteDriver, options: OpenPortableOptions = {}): PortableDatabase {
  return closingOnFailure(driver, () => {
    requireMode(driver, "readonly");
    // A CHECK the file declares is SQL the file supplied: not run, even by `integrity_check`. Every value it would have constrained is checked by the reader itself.
    driver.exec("PRAGMA ignore_check_constraints = ON");
    if (options.maxFileBytes !== undefined) {
      const bytes = Number(pragma(driver, "page_count")) * Number(pragma(driver, "page_size"));
      if (!(bytes <= options.maxFileBytes)) throw new SnapshotTooLarge(options.maxFileBytes, bytes);
    }
    checkHeader(driver);
    if (pragma(driver, "journal_mode") === "wal") throw new NotAVault("a WAL file is not a portable snapshot: one stands alone with rollback-format headers");
    checkSchema(driver, "portable");
    const metadata = checkMeta(driver, "portable");
    const wrapped = readWrapped(driver);
    return new OpenedPortable(driver, metadata, wrapped);
  });
}

function requireMode(driver: SqliteDriver, mode: SqliteDriver["mode"]): void {
  if (driver.mode !== mode) throw new TypeError(`the driver is in ${driver.mode} mode, not ${mode}`);
}

function closingOnFailure<T>(driver: SqliteDriver, body: () => T): T {
  try {
    return body();
  } catch (err) {
    driver.close();
    throw err;
  }
}

/** The file's identity, then what its metadata says it is, then the schema: a snapshot or an unready file is told apart before its tables are. */
function checkRuntime(driver: SqliteDriver): VaultMetadata {
  checkHeader(driver);
  const metadata = checkMeta(driver, "runtime");
  checkSchema(driver, "runtime");
  return metadata;
}

function checkHeader(driver: SqliteDriver): void {
  const applicationId = pragma(driver, "application_id");
  if (applicationId !== APPLICATION_ID) throw new NotAVault(`application_id ${String(applicationId)} is not a vault's`);
  const reported = pragma(driver, "encoding");
  if (reported !== undefined) requireUtf8(reported);
  checkNames(driver);
  if (reported === undefined) requireUtf8(headerEncoding(driver));
  const version = pragma(driver, "user_version");
  if (version !== SCHEMA_VERSION) throw new NotAVault(`schema version ${String(version)} is not supported; this reader opens version ${SCHEMA_VERSION}`);
}

function pragma(driver: SqliteDriver, name: string): SqlValue | undefined {
  return query(driver, `PRAGMA ${name}`)[0]?.[name];
}

function requireUtf8(encoding: SqlValue): void {
  if (encoding !== "UTF-8") throw new NotAVault(`the database is encoded ${String(encoding)}, not UTF-8`);
}

const PAGE_TABLE = /^sqlite_dbpage$/i;

/**
 * Every name in the schema, main and temp, read as its stored bytes.
 * SQLite resolves a name as a NUL-terminated string compared without
 * regard to ASCII case, so what a query reaches is decided by the bytes
 * before any NUL: a name that does not decode as text, or that is the
 * page table's, is refused as one only `writable_schema` could have
 * written. Runs ahead of the header read that consults that table, and
 * where no such read is needed all the same, so every platform refuses
 * the same file for the same reason. The pattern's `i` folds ASCII
 * only, as SQLite does.
 */
function checkNames(driver: SqliteDriver): void {
  for (const row of query(driver, "SELECT CAST(name AS BLOB) AS name FROM sqlite_master UNION ALL SELECT CAST(name AS BLOB) AS name FROM sqlite_temp_master")) {
    const name = text(row["name"], "sqlite_master.name");
    if (PAGE_TABLE.test(name)) throw new NotAVault(`the schema has an object named ${name}: a name reserved for SQLite's own`);
  }
}

const ENCODINGS: Record<number, string> = { 1: "UTF-8", 2: "UTF-16le", 3: "UTF-16be" };

/**
 * The text encoding the file's header declares, for a build of SQLite
 * without UTF-16 support: it reads every file as UTF-8 and `PRAGMA
 * encoding` reports nothing, so the declaration is read from the
 * header itself through `sqlite_dbpage`, where that build has it. A
 * platform with neither is not trusted with a file this reader did not
 * write.
 */
function headerEncoding(driver: SqliteDriver): string {
  let header: SqlValue | undefined;
  try {
    header = query(driver, "SELECT substr(data, 57, 4) AS encoding FROM sqlite_dbpage WHERE pgno = 1")[0]?.["encoding"];
  } catch (err) {
    if (!(err instanceof SqliteError)) throw err;
  }
  if (!(header instanceof Uint8Array) || header.length !== 4) throw new NotAVault("the database's text encoding cannot be read on this platform: neither PRAGMA encoding nor sqlite_dbpage reports it");
  const code = new DataView(header.buffer, header.byteOffset, 4).getUint32(0);
  return ENCODINGS[code] ?? `code ${code}`;
}

/** The one metadata row, checked to say a ready database of `kind`, as `VaultMetadata`. */
function checkMeta(driver: SqliteDriver, kind: DatabaseKind): VaultMetadata {
  let rows;
  try {
    rows = query(driver, "SELECT singleton, CAST(format AS BLOB) AS format, vault_version, CAST(kind AS BLOB) AS kind, ready, CAST(anchor AS BLOB) AS anchor FROM vault_meta");
  } catch (err) {
    if (err instanceof SqliteError) throw new NotAVault(`vault_meta cannot be read: ${err.message}`);
    throw err;
  }
  const row = single(rows, "vault_meta", NotAVault);
  const format = text(row["format"], "vault_meta.format");
  if (format !== FORMAT) throw new NotAVault(`format ${JSON.stringify(format)} is not ${FORMAT}`);
  if (row["vault_version"] !== VAULT_VERSION) throw new NotAVault(`vault version ${String(row["vault_version"])} is not ${VAULT_VERSION}`);
  const found = text(row["kind"], "vault_meta.kind");
  if (found !== kind) throw new NotAVault(`the database is a ${found} one, not a ${kind}`);
  if (row["ready"] !== 1) throw new NotAVault("the database is not ready: its construction did not complete");
  return checkMetadata({ version: VAULT_VERSION, anchor: text(row["anchor"], "vault_meta.anchor") });
}

function readWrapped(driver: SqliteDriver): WrappedSeed {
  const row = single(query(driver, "SELECT singleton, version, seed_jwe FROM keystore"), "keystore", NotAVault);
  return checkWrappedSeed({ version: row["version"], seedJwe: text(row["seed_jwe"], "keystore.seed_jwe") });
}

/** The one row of the singleton table `table`, and that it is keyed 1: the file's own constraints are not trusted to have kept it so. */
function single(rows: Record<string, SqlValue>[], table: string, Refused: new (message: string) => Error): Record<string, SqlValue> {
  if (rows.length !== 1) throw new Refused(`${table} has ${rows.length} rows, not one`);
  const row = rows[0] as Record<string, SqlValue>;
  if (row["singleton"] !== 1) throw new Refused(`${table}'s row is keyed ${String(row["singleton"])}, not 1`);
  return row;
}

/** The control row, checked against the positions and events it accounts for; `DamagedControl` when they disagree. */
function checkControl(driver: SqliteDriver): { author: AuthorId; generation: string } {
  const row = single(query(driver, "SELECT singleton, CAST(replica_id AS BLOB) AS replica_id, CAST(store_generation AS BLOB) AS store_generation, last_seq FROM store_state"), "store_state", DamagedControl);
  const author = text(row["replica_id"], "store_state.replica_id");
  const generation = text(row["store_generation"], "store_state.store_generation");
  if (!isUuidv7(author)) throw new DamagedControl(`replica_id ${JSON.stringify(author)} is not a canonical UUIDv7`);
  if (!isUuidv7(generation)) throw new DamagedControl(`store_generation ${JSON.stringify(generation)} is not a canonical UUIDv7`);
  const lastSeq = row["last_seq"];
  if (typeof lastSeq !== "number" || !Number.isSafeInteger(lastSeq) || lastSeq < 0) throw new DamagedControl(`last_seq ${String(lastSeq)} is not a count`);
  const [bounds] = query(driver, "SELECT coalesce(min(accepted_seq), 1) AS lowest, coalesce(max(accepted_seq), 0) AS highest FROM event_positions");
  if (Number(bounds?.["lowest"]) < 1) throw new DamagedControl(`position ${String(bounds?.["lowest"])} is not positive: positions count up from 1`);
  if (Number(bounds?.["highest"]) !== lastSeq) throw new DamagedControl(`last_seq is ${lastSeq} but the highest position is ${String(bounds?.["highest"])}`);
  const events = count(driver, "events");
  const positions = count(driver, "event_positions");
  if (positions !== events) throw new DamagedControl(`${events} events have ${positions} positions: every accepted event has one`);
  const unplaced = count(driver, "events WHERE event_id NOT IN (SELECT event_id FROM event_positions)");
  if (unplaced !== 0) throw new DamagedControl(`${unplaced} event(s) have no position`);
  return { author: author as AuthorId, generation };
}

function renewIdentity(driver: SqliteDriver): { author: AuthorId; generation: string } {
  const author = v7() as AuthorId;
  const generation = v7();
  driver.transaction("immediate", () => {
    if (run(driver, "UPDATE store_state SET replica_id = ?, store_generation = ? WHERE singleton = 1", author, generation) !== 1) throw new DamagedControl("the control row is gone");
    dropCache(driver);
  });
  return { author, generation };
}

function count(driver: SqliteDriver, from: string): number {
  return Number(query(driver, `SELECT count(*) AS n FROM ${from}`)[0]?.["n"]);
}

class Opened implements RuntimeDatabase {
  private closed = false;

  constructor(
    readonly driver: SqliteDriver,
    readonly metadata: VaultMetadata,
    readonly author: AuthorId,
    readonly generation: string,
    readonly writable: boolean
  ) {}

  keystore(locked: Locked): KeystoreAccess {
    const open = (): void => {
      if (this.closed) throw new VaultClosed();
    };
    return {
      read: async () => {
        open();
        return readWrapped(this.driver);
      },
      rewrap: async (next) => {
        const clean = checkWrappedSeed(next);
        if (!this.writable) throw new ReadOnlyVault("rewrap");
        open();
        await locked(async () => {
          open();
          this.driver.transaction("immediate", () => {
            const changed = run(this.driver, "UPDATE keystore SET seed_jwe = ? WHERE singleton = 1", new TextEncoder().encode(clean.seedJwe));
            if (changed !== 1) throw new DamagedControl("the keystore row is gone");
          });
        });
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.driver.close();
  }
}

class OpenedPortable implements PortableDatabase {
  readonly vault: Vault;
  private closed = false;

  constructor(
    readonly driver: SqliteDriver,
    readonly metadata: VaultMetadata,
    readonly wrapped: WrappedSeed
  ) {
    this.vault = new PortableVault(driver, metadata, () => {
      if (this.closed) throw new VaultClosed();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.driver.close();
  }
}
