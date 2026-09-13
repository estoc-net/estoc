/**
 * The three conformance suites' openers over whatever the platform's
 * driver is, the same on `node:sqlite` and in the Worker over the wasm
 * pool: each opens a runtime created at the harness's next target,
 * authored as the suite asks, and hands the runner a way to close what
 * it opened, since the suites close nothing themselves and the pool
 * refuses to close over an open connection.
 */

import { SqliteEventStore, SqliteObjectStore, SqliteVault, createRuntime, type AuthorId, type OpenMode, type RuntimeDatabase, type SqliteDriver } from "../../../src/v3/index.js";
import { META, WRAPPED } from "../fixtures.js";
import type { OpenStore } from "../suite/event-store-suite.js";
import type { OpenObjectStore } from "../suite/object-store-suite.js";
import type { OpenVault } from "../suite/vault-suite.js";
import { corruptChunk, exec } from "./vault-cases.js";

export interface SuiteHarness {
  /** A target no database exists at yet. */
  fresh(): string;
  open(target: string, mode: OpenMode): Promise<SqliteDriver> | SqliteDriver;
  /** Given a way to close each runtime opened; left out where what a test leaves open does not matter. */
  opened?(close: () => Promise<void>): void;
}

/** `db` as the runtime of `author`: the control row rewritten, as a suite names its replicas. */
function authoredAs(db: RuntimeDatabase, author: AuthorId | undefined): RuntimeDatabase {
  if (author === undefined || author === db.author) return db;
  exec(db.driver, "UPDATE store_state SET replica_id = ?", author);
  return { driver: db.driver, metadata: db.metadata, author, generation: db.generation, writable: db.writable, keystore: (locked) => db.keystore(locked), close: () => db.close() };
}

async function created(h: SuiteHarness, author?: AuthorId): Promise<RuntimeDatabase> {
  return authoredAs(createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED }), author);
}

export function eventStoreOpener(h: SuiteHarness): OpenStore {
  return async (options = {}) => {
    const db = await created(h, options.author);
    h.opened?.(async () => db.close());
    return new SqliteEventStore(db, options.now === undefined ? {} : { now: options.now });
  };
}

export function objectStoreOpener(h: SuiteHarness): OpenObjectStore {
  return async (options = {}) => {
    const db = await created(h);
    h.opened?.(async () => db.close());
    const store = new SqliteObjectStore(db, options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes });
    return { store, corrupt: async (cid) => corruptChunk(db.driver, cid) };
  };
}

export function vaultOpener(h: SuiteHarness): OpenVault {
  return async ({ author, now }) => {
    const db = await created(h, author);
    const vault = new SqliteVault(db, { now });
    h.opened?.(() => vault.close());
    return { vault, corrupt: async (cid) => corruptChunk(db.driver, cid) };
  };
}
