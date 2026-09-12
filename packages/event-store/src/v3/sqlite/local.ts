/**
 * This runtime's own state beside the vault: options, a cache and a
 * trace, in `local_*` tables of the runtime database that no snapshot
 * carries, no import reads and no synchronization moves. Options are
 * what the host chose, JSON by key, kept through every reopen and
 * every clearing; the cache is what can be rebuilt, bytes by namespace
 * and key, dropped whole when the identity is reset since what it was
 * built for may have changed; the trace is what happened here —
 * delivery attempts, diagnostics — one row an entry in the order
 * written, pruned by age and by count, each entry's place given out
 * once and never again, so a reader that kept the place it reached
 * misses nothing written after it. Each table is made on the first
 * write to it, so a runtime that uses none writes none; an inspector
 * reads what is there and writes nothing.
 */

import { ReadOnlyVault } from "../errors.js";
import { atOf } from "../event.js";
import { canonicalize, parseStrict } from "../jcs.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import type { SqliteDriver, SqlValue } from "./driver.js";
import { hasTable, query, run } from "./schema.js";

export interface LocalOptions {
  get(key: string): Promise<JsonValue | undefined>;
  /** Sets `key` to `value`, which must serialize as canonical JSON. */
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface LocalCache {
  get(namespace: string, key: string): Promise<Uint8Array | undefined>;
  put(namespace: string, key: string, bytes: Uint8Array): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  /** Drops every entry of `namespace`, or of every namespace. */
  clear(namespace?: string): Promise<void>;
}

/** One entry of the trace: its place in the trace, which no entry before or after it shares, when it was written by the runtime's clock, what it is and what it says. */
export type TraceEntry<D extends JsonObject = JsonObject> = { seq: number; at: string; type: string; data: D };

/** The entries of `type`, after the one at `after`; either left out constrains nothing. A place is never given out twice — not after a prune, a clearing or a reopen — so `after` a place reached earlier skips nothing written since. */
export type TraceFilter = { type?: string; after?: number };

/** What a prune keeps: entries no older than `keepMs`, and no more than the newest `capRows` of them. */
export interface TracePolicy {
  keepMs: number;
  capRows: number;
}

export interface LocalTrace {
  append(type: string, data: JsonObject): Promise<TraceEntry>;
  /** The entries `filter` selects, in the order written, over a fixed cut. */
  scan(filter?: TraceFilter): AsyncIterable<TraceEntry>;
  prune(policy: TracePolicy): Promise<{ pruned: number }>;
}

export interface LocalState {
  readonly options: LocalOptions;
  readonly cache: LocalCache;
  readonly trace: LocalTrace;
  /** Empties the cache and the trace; the next trace entry still takes the place after the last one written. The options, the identity, the control and the keystore stay. */
  clearCaches(): Promise<void>;
}

const OPTIONS = "local_options";
const CACHE = "local_cache";
const TRACE = "local_trace";
const TRACE_STATE = "local_trace_state";

const DDL: Record<string, string> = {
  [OPTIONS]: `CREATE TABLE IF NOT EXISTS local_options (
    key   TEXT PRIMARY KEY NOT NULL,
    value BLOB NOT NULL
  ) STRICT`,
  [CACHE]: `CREATE TABLE IF NOT EXISTS local_cache (
    namespace TEXT NOT NULL,
    key       TEXT NOT NULL,
    bytes     BLOB NOT NULL,
    PRIMARY KEY (namespace, key)
  ) STRICT`,
  [TRACE]: `CREATE TABLE IF NOT EXISTS local_trace (
    seq  INTEGER PRIMARY KEY,
    at   TEXT NOT NULL,
    type TEXT NOT NULL,
    data BLOB NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS local_trace_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    last_seq  INTEGER NOT NULL CHECK (last_seq >= 0)
  ) STRICT;
  INSERT OR IGNORE INTO local_trace_state (singleton, last_seq) SELECT 1, coalesce(max(seq), 0) FROM local_trace`,
};

/** Drops the cache, where there is one: what an identity reset does to the state built for the old generation. Inside the caller's transaction. */
export function dropCache(driver: SqliteDriver): void {
  if (hasTable(driver, CACHE)) run(driver, `DELETE FROM ${CACHE}`);
}

/**
 * The local state of one runtime, over its connection. `check` is
 * asked before every call, as the vault's reads ask its guard: a
 * closed or stopped vault refuses here too. Writes are refused on an
 * inspector before anything is made.
 */
export class SqliteLocalState implements LocalState {
  readonly options: LocalOptions;
  readonly cache: LocalCache;
  readonly trace: LocalTrace;
  private readonly made = new Set<string>();

  constructor(
    private readonly driver: SqliteDriver,
    private readonly writable: boolean,
    private readonly check: () => void,
    private readonly now: () => number
  ) {
    this.options = {
      get: async (key) => {
        const row = this.madeTable(OPTIONS) ? query(this.driver, `SELECT value FROM ${OPTIONS} WHERE key = ?`, key)[0] : undefined;
        return row === undefined ? undefined : (parseStrict(row["value"] as Uint8Array) as JsonValue);
      },
      set: async (key, value) => {
        const bytes = canonicalize(value);
        this.ensureTable(OPTIONS, "options.set");
        run(this.driver, `INSERT OR REPLACE INTO ${OPTIONS} (key, value) VALUES (?, ?)`, key, bytes);
      },
      delete: async (key) => {
        this.ensureTable(OPTIONS, "options.delete");
        run(this.driver, `DELETE FROM ${OPTIONS} WHERE key = ?`, key);
      },
      keys: async () => (this.madeTable(OPTIONS) ? query(this.driver, `SELECT key FROM ${OPTIONS} ORDER BY key`).map((row) => row["key"] as string) : []),
    };
    this.cache = {
      get: async (namespace, key) => {
        const row = this.madeTable(CACHE) ? query(this.driver, `SELECT bytes FROM ${CACHE} WHERE namespace = ? AND key = ?`, namespace, key)[0] : undefined;
        return row === undefined ? undefined : (row["bytes"] as Uint8Array);
      },
      put: async (namespace, key, bytes) => {
        this.ensureTable(CACHE, "cache.put");
        run(this.driver, `INSERT OR REPLACE INTO ${CACHE} (namespace, key, bytes) VALUES (?, ?, ?)`, namespace, key, bytes);
      },
      delete: async (namespace, key) => {
        this.ensureTable(CACHE, "cache.delete");
        run(this.driver, `DELETE FROM ${CACHE} WHERE namespace = ? AND key = ?`, namespace, key);
      },
      clear: async (namespace) => {
        this.ensureTable(CACHE, "cache.clear");
        if (namespace === undefined) run(this.driver, `DELETE FROM ${CACHE}`);
        else run(this.driver, `DELETE FROM ${CACHE} WHERE namespace = ?`, namespace);
      },
    };
    this.trace = {
      append: async (type, data) => {
        if (typeof type !== "string" || type === "") throw new TypeError("a trace entry's type is a non-empty string");
        if (!isJsonObject(data)) throw new TypeError("a trace entry's data is a JSON object");
        const bytes = canonicalize(data);
        this.ensureTable(TRACE, "trace.append");
        const at = atOf(this.now());
        const seq = this.driver.transaction("immediate", () => {
          const [state] = query(this.driver, `UPDATE ${TRACE_STATE} SET last_seq = last_seq + 1 RETURNING last_seq`);
          const seq = state?.["last_seq"] as number;
          run(this.driver, `INSERT INTO ${TRACE} (seq, at, type, data) VALUES (?, ?, ?, ?)`, seq, at, type, bytes);
          return seq;
        });
        return { seq, at, type, data: parseStrict(bytes) as JsonObject };
      },
      scan: (filter) => this.scanTrace(filter),
      prune: async (policy) => {
        const { keepMs, capRows } = policy;
        if (!Number.isSafeInteger(keepMs) || keepMs < 0 || !Number.isSafeInteger(capRows) || capRows < 0) throw new RangeError("keepMs and capRows are non-negative integers");
        this.ensureTable(TRACE, "trace.prune");
        const cutoff = atOf(Math.max(0, this.now() - keepMs));
        return this.driver.transaction("immediate", () => ({
          pruned: run(this.driver, `DELETE FROM ${TRACE} WHERE at < ?`, cutoff) + run(this.driver, `DELETE FROM ${TRACE} WHERE seq <= (SELECT seq FROM ${TRACE} ORDER BY seq DESC LIMIT 1 OFFSET ?)`, capRows),
        }));
      },
    };
  }

  async clearCaches(): Promise<void> {
    this.check();
    this.requireWritable("clearCaches");
    this.driver.transaction("immediate", () => {
      dropCache(this.driver);
      if (hasTable(this.driver, TRACE)) run(this.driver, `DELETE FROM ${TRACE}`);
    });
  }

  private async *scanTrace(filter?: TraceFilter): AsyncIterable<TraceEntry> {
    if (!this.madeTable(TRACE)) return;
    const conditions: string[] = [];
    const bound: SqlValue[] = [];
    if (filter?.type !== undefined) {
      conditions.push("type = ?");
      bound.push(filter.type);
    }
    if (filter?.after !== undefined) {
      conditions.push("seq > ?");
      bound.push(filter.after);
    }
    const rows = query(this.driver, `SELECT seq, at, type, data FROM ${TRACE}${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`} ORDER BY seq`, ...bound);
    const entries = rows.map((row): TraceEntry => {
      const data = parseStrict(row["data"] as Uint8Array);
      if (!isJsonObject(data)) throw new Error(`local_trace/${String(row["seq"])}: data is not a JSON object`);
      return { seq: row["seq"] as number, at: row["at"] as string, type: row["type"] as string, data };
    });
    for (const entry of entries) yield entry;
  }

  private madeTable(table: string): boolean {
    this.check();
    return this.made.has(table) || hasTable(this.driver, table);
  }

  private ensureTable(table: string, what: string): void {
    this.check();
    this.requireWritable(what);
    if (this.made.has(table)) return;
    this.driver.exec(DDL[table] as string);
    this.made.add(table);
  }

  private requireWritable(what: string): void {
    if (!this.writable) throw new ReadOnlyVault(what);
  }
}
