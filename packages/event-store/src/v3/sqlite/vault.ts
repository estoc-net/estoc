/**
 * The version-3 vault over an open SQLite runtime: `SqliteEventStore`
 * and `SqliteObjectStore` on the runtime's one connection under one
 * `Runtime`, a commit's objects and events published in one
 * transaction, the keystore and the runtime's local state behind the
 * same admission guard as every other entry. What stops the vault, and
 * how far, `stopped` says; what a close waits for, `close` says.
 */

import { DamagedHistory, UncertainCommit, VaultClosed } from "../errors.js";
import type { Cid } from "../event.js";
import type { Collected } from "../objects.js";
import { Runtime, type Stores } from "../vault.js";
import { SqliteEventStore } from "./events.js";
import { SqliteLocalState, dropCache, type LocalState } from "./local.js";
import { SqliteObjectStore, type SqliteObjectStoreOptions, type SqlitePreparation } from "./objects.js";
import type { RuntimeDatabase } from "./open.js";

export interface SqliteVaultOptions extends SqliteObjectStoreOptions {
  /** the wall clock in Unix milliseconds, for `at` and the trace; default `Date.now`, pinned by tests */
  now?: () => number;
}

/**
 * The object store with its collection pass bound to the history: a
 * keep set is folded from the events, and while any of them is
 * damaged the fold is incomplete and deletes nothing.
 */
class HistoryBoundObjects extends SqliteObjectStore {
  constructor(
    db: RuntimeDatabase,
    options: SqliteObjectStoreOptions,
    private readonly history: SqliteEventStore
  ) {
    super(db, options);
  }

  override async collect(keep: Iterable<Cid>): Promise<Collected> {
    this.history.requireSound();
    return super.collect(keep);
  }
}

export class SqliteVault extends Runtime {
  declare readonly stores: Stores & { events: SqliteEventStore; objects: SqliteObjectStore };
  readonly local: LocalState;
  private readonly db: RuntimeDatabase;
  private readonly closing: { promise: Promise<void> | undefined };

  constructor(db: RuntimeDatabase, options: SqliteVaultOptions = {}) {
    const closing: { promise: Promise<void> | undefined } = { promise: undefined };
    // Admission: nothing new once closing has begun — what was admitted
    // before still runs, so the lock's turn is not asked — and nothing
    // at all after a commit of unknown outcome.
    const guard = (when: "enter" | "run" | "read"): void => {
      if (when !== "run" && closing.promise !== undefined) throw new VaultClosed();
      if (db.driver.uncertain !== undefined) throw db.driver.uncertain;
    };
    const { now, ...objectOptions } = options;
    const events = new SqliteEventStore(db, now === undefined ? {} : { now });
    const objects = new HistoryBoundObjects(db, objectOptions, events);
    // The cache is what was built from the accepted state; once that state changes under it — an object landed or repaired, an event accepted — it is dropped in the same transaction.
    const publish = (prepared: SqlitePreparation, adding: number): void => {
      if (prepared.publish() + adding > 0) dropCache(db.driver);
    };
    super({
      author: db.author,
      generation: db.generation,
      metadata: db.metadata,
      stores: {
        events,
        objects,
        transaction: async (body) => {
          const prepared = objects.prepare();
          try {
            const drafts = await body(prepared);
            const published = await events.appendAll(drafts, () => publish(prepared, drafts.length));
            prepared.settle();
            return published;
          } finally {
            prepared.discard();
          }
        },
        ingestion: async (body) => {
          const prepared = objects.prepare();
          try {
            const incoming = await body(prepared);
            const outcome = await events.ingest(incoming, (adding) => publish(prepared, adding));
            prepared.settle();
            return outcome;
          } finally {
            prepared.discard();
          }
        },
      },
      keystore: (runtime) => {
        const access = db.keystore((op) => runtime.locked(() => op()));
        return {
          read: async () => {
            guard("read");
            return access.read();
          },
          rewrap: (next) => access.rewrap(next),
        };
      },
      writable: db.writable,
      guard,
    });
    this.db = db;
    this.closing = closing;
    this.local = new SqliteLocalState(db.driver, db.writable, () => guard("read"), now ?? Date.now);
  }

  /**
   * Why the vault accepts no write, or `undefined` while it does:
   * closed; a commit whose outcome is unknown, which refuses reads too
   * until a reopen; or damage to the history, which reads go on under.
   * What a host shows before explaining that only a validated snapshot
   * restores the history.
   */
  get stopped(): VaultClosed | UncertainCommit | DamagedHistory | undefined {
    if (this.closing.promise !== undefined) return new VaultClosed();
    if (this.db.driver.uncertain !== undefined) return this.db.driver.uncertain;
    try {
      this.stores.events.requireSound();
      return undefined;
    } catch (err) {
      if (err instanceof DamagedHistory) return err;
      throw err;
    }
  }

  /**
   * Admits nothing more, waits for every operation already admitted
   * to finish, then closes the database and with it ownership.
   * Idempotent: every call resolves once the first has closed.
   */
  close(): Promise<void> {
    this.closing.promise ??= this.lock.idle().then(() => this.db.close());
    return this.closing.promise;
  }
}
