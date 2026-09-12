/**
 * Opening the version-3 vault in SQLite: what a database must show
 * before anything in it is trusted, and what the caller gets once it
 * has. A runtime is created whole in one transaction and opened by
 * checking, in order, the file's own identity (application ID,
 * encoding, schema version), the metadata that says what it is, the
 * schema, the wrapped seed, the anchor the caller derives from it, and
 * the local control. A portable snapshot is opened read-only and its
 * schema checked before any row of it is read. Ownership is the
 * driver's: what these functions add is that nothing is read out of
 * order and nothing is written before the checks have passed. A create
 * or open that fails, for any reason, closes the driver it was given,
 * since ownership must not stay with a handle nobody can use.
 */

import { v7 } from "uuid";

import { AnchorMismatch, DamagedControl, NotAVault, ReadOnlyVault, SqliteError, VaultClosed } from "../errors.js";
import { isUuidv7, type AuthorId } from "../event.js";
import { checkMetadata, checkWrappedSeed, type KeystoreAccess, type VaultMetadata, type WrappedSeed } from "../keystore.js";
import type { SqliteDriver, SqlValue } from "./driver.js";
import { APPLICATION_ID, SCHEMA_VERSION, checkSchema, createTables, text, type DatabaseKind } from "./schema.js";

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

/** A portable snapshot, open read-only and checked as far as its metadata and wrapper: what validation and inspection go on from. */
export interface PortableDatabase {
  readonly driver: SqliteDriver;
  readonly metadata: VaultMetadata;
  readonly wrapped: WrappedSeed;
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
  return guarded(driver, () => {
    requireMode(driver, "create");
    const metadata = checkMetadata(options.metadata);
    const wrapped = checkWrappedSeed(options.wrapped);
    const author = v7() as AuthorId;
    const generation = v7();
    if (count(driver, "sqlite_master") > 0) throw new Error("a runtime is created in an empty database: this one already has a schema");
    driver.transaction("immediate", () => {
      driver.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
      createTables(driver, "runtime");
      driver.prepare("INSERT INTO vault_meta (singleton, format, vault_version, kind, ready, anchor) VALUES (1, ?, ?, 'runtime', 1, ?)").run(FORMAT, VAULT_VERSION, metadata.anchor);
      driver.prepare("INSERT INTO keystore (singleton, version, seed_jwe) VALUES (1, 3, ?)").run(new TextEncoder().encode(wrapped.seedJwe));
      driver.prepare("INSERT INTO store_state (singleton, replica_id, store_generation, last_seq) VALUES (1, ?, ?, 0)").run(author, generation);
    });
    return new Opened(driver, metadata, author, generation, true);
  });
}

/**
 * Opens the runtime in `driver`, which was opened `readwrite` and so
 * owns the file, with SQLite's journal recovery already done. Nothing
 * is written: the checks run in order, the anchor last but for the
 * control, and a failure at any of them closes the driver.
 */
export async function openRuntime(driver: SqliteDriver, options: OpenRuntimeOptions): Promise<RuntimeDatabase> {
  try {
    requireMode(driver, "readwrite");
    const metadata = checkRuntime(driver);
    const wrapped = readWrapped(driver);
    const derived = typeof options.anchor === "string" ? options.anchor : await options.anchor(wrapped);
    if (derived !== metadata.anchor) throw new AnchorMismatch(metadata.anchor, derived);
    const { author, generation } = checkControl(driver);
    return new Opened(driver, metadata, author, generation, true);
  } catch (err) {
    driver.close();
    throw err;
  }
}

/**
 * Opens the runtime in `driver` to look at, never to write: the same
 * checks as a run, without the seed — an inspector uses no identity —
 * and with the connection set to refuse every write, whatever mode the
 * driver was opened in. The driver's ownership is the inspector's: a
 * `readwrite` driver owns the file outright, and a `readonly` one as
 * the platform lets it.
 */
export function openInspector(driver: SqliteDriver): RuntimeDatabase {
  return guarded(driver, () => {
    if (driver.mode === "create") throw new TypeError("an inspector opens an existing runtime: the driver is in create mode");
    driver.exec("PRAGMA query_only = ON");
    const metadata = checkRuntime(driver);
    readWrapped(driver);
    const { author, generation } = checkControl(driver);
    return new Opened(driver, metadata, author, generation, false);
  });
}

/**
 * Opens the portable snapshot in `driver`, which was opened `readonly`
 * — no writes, no extensions, an untrusted schema — and checks it as
 * far as its metadata and wrapper: the file's identity and
 * rollback-format headers first, then the schema, and only then the
 * two rows that say what it is. Whether its events and objects are
 * what they claim is the validation that comes after, on the same
 * handle.
 */
export function openPortable(driver: SqliteDriver): PortableDatabase {
  return guarded(driver, () => {
    requireMode(driver, "readonly");
    checkHeader(driver);
    if (String(driver.prepare("PRAGMA journal_mode").get()?.["journal_mode"]) === "wal") {
      throw new NotAVault("a WAL file is not a portable snapshot: one stands alone with rollback-format headers");
    }
    checkSchema(driver, "portable");
    const metadata = checkMeta(driver, "portable");
    const wrapped = readWrapped(driver);
    return new OpenedPortable(driver, metadata, wrapped);
  });
}

function requireMode(driver: SqliteDriver, mode: SqliteDriver["mode"]): void {
  if (driver.mode !== mode) throw new TypeError(`the driver is in ${driver.mode} mode, not ${mode}`);
}

/** `body`'s result, or its failure with the driver closed. */
function guarded<T>(driver: SqliteDriver, body: () => T): T {
  try {
    return body();
  } catch (err) {
    driver.close();
    throw err;
  }
}

/** The file's identity, then what the metadata says it is, then the schema: the order a runtime is checked in, so a snapshot or an unready file is told apart before its tables are. */
function checkRuntime(driver: SqliteDriver): VaultMetadata {
  checkHeader(driver);
  const metadata = checkMeta(driver, "runtime");
  checkSchema(driver, "runtime");
  return metadata;
}

function checkHeader(driver: SqliteDriver): void {
  const applicationId = driver.prepare("PRAGMA application_id").get()?.["application_id"];
  if (applicationId !== APPLICATION_ID) throw new NotAVault(`application_id ${String(applicationId)} is not a vault's`);
  const encoding = driver.prepare("PRAGMA encoding").get()?.["encoding"];
  if (encoding !== "UTF-8") throw new NotAVault(`the database is encoded ${String(encoding)}, not UTF-8`);
  const version = driver.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version !== SCHEMA_VERSION) throw new NotAVault(`schema version ${String(version)} is not supported; this reader opens version ${SCHEMA_VERSION}`);
}

/** The one metadata row, checked to say a ready database of `kind`, as `VaultMetadata`. */
function checkMeta(driver: SqliteDriver, kind: DatabaseKind): VaultMetadata {
  let rows;
  try {
    rows = driver.prepare("SELECT CAST(format AS BLOB) AS format, vault_version, CAST(kind AS BLOB) AS kind, ready, CAST(anchor AS BLOB) AS anchor FROM vault_meta").all();
  } catch (err) {
    if (err instanceof SqliteError) throw new NotAVault(`vault_meta cannot be read: ${err.message}`);
    throw err;
  }
  if (rows.length !== 1) throw new NotAVault(`vault_meta has ${rows.length} rows, not one`);
  const row = rows[0] as Record<string, SqlValue>;
  const format = text(row["format"], "vault_meta.format");
  if (format !== FORMAT) throw new NotAVault(`format ${JSON.stringify(format)} is not ${FORMAT}`);
  if (row["vault_version"] !== VAULT_VERSION) throw new NotAVault(`vault version ${String(row["vault_version"])} is not ${VAULT_VERSION}`);
  const found = text(row["kind"], "vault_meta.kind");
  if (found !== kind) throw new NotAVault(`the database is a ${found} one, not a ${kind}`);
  if (row["ready"] !== 1) throw new NotAVault("the database is not ready: its construction did not complete");
  return checkMetadata({ version: VAULT_VERSION, anchor: text(row["anchor"], "vault_meta.anchor") });
}

function readWrapped(driver: SqliteDriver): WrappedSeed {
  const rows = driver.prepare("SELECT version, seed_jwe FROM keystore").all();
  if (rows.length !== 1) throw new NotAVault(`keystore has ${rows.length} rows, not one`);
  const row = rows[0] as Record<string, SqlValue>;
  return checkWrappedSeed({ version: row["version"], seedJwe: text(row["seed_jwe"], "keystore.seed_jwe") });
}

/** The control row, checked against the positions and events it accounts for; `DamagedControl` when they disagree. */
function checkControl(driver: SqliteDriver): { author: AuthorId; generation: string } {
  const rows = driver.prepare("SELECT CAST(replica_id AS BLOB) AS replica_id, CAST(store_generation AS BLOB) AS store_generation, last_seq FROM store_state").all();
  if (rows.length !== 1) throw new DamagedControl(`store_state has ${rows.length} rows, not one`);
  const row = rows[0] as Record<string, SqlValue>;
  const author = text(row["replica_id"], "store_state.replica_id");
  const generation = text(row["store_generation"], "store_state.store_generation");
  if (!isUuidv7(author)) throw new DamagedControl(`replica_id ${JSON.stringify(author)} is not a canonical UUIDv7`);
  if (!isUuidv7(generation)) throw new DamagedControl(`store_generation ${JSON.stringify(generation)} is not a canonical UUIDv7`);
  const lastSeq = row["last_seq"];
  if (typeof lastSeq !== "number" || !Number.isSafeInteger(lastSeq) || lastSeq < 0) throw new DamagedControl(`last_seq ${String(lastSeq)} is not a count`);
  const highest = Number(driver.prepare("SELECT coalesce(max(accepted_seq), 0) AS n FROM event_positions").get()?.["n"]);
  if (highest !== lastSeq) throw new DamagedControl(`last_seq is ${lastSeq} but the highest position is ${highest}`);
  const events = count(driver, "events");
  const positions = count(driver, "event_positions");
  if (positions !== events) throw new DamagedControl(`${events} events have ${positions} positions: every accepted event has one`);
  const unplaced = Number(driver.prepare("SELECT count(*) AS n FROM events WHERE event_id NOT IN (SELECT event_id FROM event_positions)").get()?.["n"]);
  if (unplaced !== 0) throw new DamagedControl(`${unplaced} event(s) have no position`);
  return { author: author as AuthorId, generation };
}

function count(driver: SqliteDriver, table: string): number {
  return Number(driver.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
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
            const { changes } = this.driver.prepare("UPDATE keystore SET seed_jwe = ? WHERE singleton = 1").run(new TextEncoder().encode(clean.seedJwe));
            if (changes !== 1) throw new DamagedControl("the keystore row is gone");
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
  constructor(
    readonly driver: SqliteDriver,
    readonly metadata: VaultMetadata,
    readonly wrapped: WrappedSeed
  ) {}

  close(): void {
    this.driver.close();
  }
}
