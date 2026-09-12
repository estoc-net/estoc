/**
 * The version-3 event store over an open SQLite runtime: the `events`
 * table, the local control that gives every accepted event a position
 * — what a change token names — and a local table of the values
 * `ingest` rejected, for `conflicting()`. The connection is the
 * runtime's, synchronous and owned outright, so a write is one
 * transaction on it, atomic as SQLite makes it, and two writes never
 * interleave: no lock of the store's own is needed. What is handed out
 * is always what the stored canonical bytes parse to, decoded fresh
 * for each call; a row that no longer decodes to the event its columns
 * name is damage, left out of every scan, reported by `damaged()`, and
 * from the moment it is found — or looked for, which every write does
 * once — the reason no write is accepted: the history is incomplete.
 */

import { BadToken, DamagedControl, DamagedHistory, ForkedAuthor, ReadOnlyVault } from "../errors.js";
import {
  matches,
  validateDraft,
  validateEvent,
  type AuthorId,
  type ChangeToken,
  type Conflict,
  type Damaged,
  type Draft,
  type Event,
  type EventId,
  type EventStore,
  type EventTally,
  type Filter,
  type Ingested,
} from "../event.js";
import { canonicalize, parseStrict } from "../jcs.js";
import type { JsonObject } from "../json.js";
import { mint } from "../mint.js";
import { decodeText, decodeUtf8, type SqliteDriver, type SqliteStatement, type SqlRow, type SqlValue } from "./driver.js";
import type { RuntimeDatabase } from "./open.js";
import { hasTable, query, run } from "./schema.js";

export interface SqliteEventStoreOptions {
  /** the wall clock in Unix milliseconds; default `Date.now`, pinned by tests */
  now?: () => number;
}

export type EventStoreDatabase = Pick<RuntimeDatabase, "driver" | "author" | "generation" | "writable">;

/** One accepted event and the canonical bytes it is equal by. */
interface Held {
  event: Event;
  bytes: Uint8Array;
}

type IngestInput = { held: Held } | { rejected: { value: unknown; error: string } };

export type DecodedEventRow = { event: Event } | { damage: Damaged };

/**
 * The columns of `events` as `decodeEventRow` reads them, from the
 * table as `e`: text as its stored bytes, since a JSON string may hold
 * what a SQLite text value cannot carry across the boundary, a NUL.
 */
export const EVENT_COLUMNS = "e.rowid AS rowid, CAST(e.event_id AS BLOB) AS event_id, CAST(e.at AS BLOB) AS at, CAST(e.author AS BLOB) AS author, CAST(e.type AS BLOB) AS type, e.canonical AS canonical";

const CONFLICTS_DDL = `CREATE TABLE IF NOT EXISTS local_conflicts (
  seen     INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  rejected BLOB NOT NULL,
  UNIQUE (event_id, rejected)
) STRICT`;

const UTF8 = new TextEncoder();

export class SqliteEventStore implements EventStore {
  readonly author: AuthorId;
  /** `store_state.store_generation`: what every token this store issues is bound to, the same across reopens. */
  readonly generation: string;
  private readonly driver: SqliteDriver;
  private readonly writable: boolean;
  private readonly now: () => number;
  /** The first damage any read of this store met, or the survey found; once set, no write is accepted. */
  private damage: Damaged | undefined;
  private surveyed = false;

  constructor(db: EventStoreDatabase, options: SqliteEventStoreOptions = {}) {
    this.driver = db.driver;
    this.author = db.author;
    this.generation = db.generation;
    this.writable = db.writable;
    this.now = options.now ?? Date.now;
  }

  async append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>> {
    const [event] = await this.appendAll([draft]);
    return event as Event<D>;
  }

  /**
   * `drafts` appended as one transaction; `publish`, when given, runs
   * inside it, after the batch is minted and before any of it is
   * accepted, on the same connection and so without a transaction of
   * its own: what it writes and the events land together. How the
   * SQLite vault publishes a commit's objects with its events. A throw
   * before the commit — from a draft, the clock, the generator,
   * `publish`, a damaged history or SQLite — accepts no event and
   * takes what `publish` wrote with it. A commit whose outcome SQLite
   * could not report comes back as its error, and what landed is
   * learned by reopening: stopping work until then is the runtime's.
   */
  async appendAll<D extends JsonObject>(drafts: Draft<D>[], publish?: () => void): Promise<Event<D>[]> {
    // `Array.from` visits every index, so a hole in a sparse array is refused as a draft that is not an object.
    const clean = Array.from(drafts, (draft) => validateDraft(draft));
    if (clean.length === 0 && publish === undefined) return [];
    this.requireWritable("append");
    const { at, eventIds } = mint(clean.length, this.now);
    const held = clean.map((draft, i) => canonical({ eventId: eventIds[i], at, author: this.author, type: draft.type, roots: draft.roots, data: draft.data }));
    return this.driver.transaction("immediate", () => {
      this.requireSound();
      publish?.();
      this.accept(held);
      return held.map((h) => h.event) as Event<D>[];
    });
  }

  /** Inserts `held`, giving each the next position and advancing `last_seq` by as many; nothing for none. Inside the caller's transaction. */
  private accept(held: Held[]): void {
    if (held.length === 0) return;
    const last = this.lastSeq();
    const insertEvent = this.driver.prepare("INSERT INTO events (event_id, at, author, type, canonical) VALUES (?, ?, ?, CAST(? AS TEXT), ?)");
    const insertPosition = this.driver.prepare("INSERT INTO event_positions (accepted_seq, event_id) VALUES (?, ?)");
    try {
      held.forEach(({ event, bytes }, i) => {
        insertEvent.run(event.eventId, event.at, event.author, UTF8.encode(event.type), bytes);
        insertPosition.run(last + i + 1, event.eventId);
      });
    } finally {
      insertEvent.finalize();
      insertPosition.finalize();
    }
    if (run(this.driver, "UPDATE store_state SET last_seq = ? WHERE singleton = 1", last + held.length) !== 1) throw new DamagedControl("the control row is gone");
  }

  /** `store_state.last_seq`: the position accepted last, or 0. */
  private lastSeq(): number {
    const [row] = query(this.driver, "SELECT last_seq FROM store_state WHERE singleton = 1");
    if (row === undefined) throw new DamagedControl("the control row is gone");
    const last = row["last_seq"];
    if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0) throw new DamagedControl(`last_seq ${String(last)} is not a count`);
    return last;
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    // Read everything first: validation and canonical form are the
    // input's own and need no transaction, which must not wait on a
    // source. Then, in one transaction, classify each input against
    // what is held — duplicate, conflict, new — in input order, check
    // for a fork, and only then accept; so the outcome names what was
    // held when the decision was made, and a write that landed while
    // the input was still being read is seen.
    this.requireWritable("ingest");
    const read: IngestInput[] = [];
    for await (const value of events) {
      try {
        read.push({ held: canonical(value) });
      } catch (err) {
        read.push({ rejected: { value, error: err instanceof Error ? err.message : String(err) } });
      }
    }
    return this.driver.transaction("immediate", () => {
      this.requireSound();
      const outcome: Ingested = { added: 0, duplicates: 0, conflicts: [], rejected: [] };
      const staged = new Map<EventId, Held>();
      const forked: Event[] = [];
      const lookup = this.driver.prepare(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.event_id = ?`);
      try {
        for (const item of read) {
          if ("rejected" in item) {
            outcome.rejected.push(item.rejected);
            continue;
          }
          const incoming = item.held;
          const have = this.held(lookup, incoming.event.eventId) ?? staged.get(incoming.event.eventId);
          if (have !== undefined) {
            if (sameBytes(have.bytes, incoming.bytes)) {
              outcome.duplicates += 1;
            } else {
              outcome.conflicts.push({ eventId: incoming.event.eventId, kept: have.event, rejected: incoming.event });
              if (incoming.event.author === this.author) forked.push(incoming.event);
            }
            continue;
          }
          if (incoming.event.author === this.author) {
            forked.push(incoming.event);
            continue;
          }
          staged.set(incoming.event.eventId, incoming);
        }
      } finally {
        lookup.finalize();
      }
      if (forked.length > 0) throw new ForkedAuthor(this.author, forked);
      this.accept([...staged.values()]);
      this.remember(outcome.conflicts);
      outcome.added = staged.size;
      return outcome;
    });
  }

  /** What is held under `eventId`, as its canonical bytes and the event they parse to; `undefined` for nothing. A damaged row is a throw: what is held under the ID cannot be told. */
  private held(lookup: SqliteStatement, eventId: EventId): Held | undefined {
    const row = lookup.get(eventId);
    if (row === undefined) return undefined;
    const decoded = this.noteDamage(decodeEventRow(row));
    if ("damage" in decoded) throw new DamagedHistory(decoded.damage);
    return { event: decoded.event, bytes: row["canonical"] as Uint8Array };
  }

  /** Records each rejected value once, by the ID it contended for; the table is made on the first conflict a runtime meets. Inside the caller's transaction. */
  private remember(conflicts: Conflict[]): void {
    if (conflicts.length === 0) return;
    this.driver.exec(CONFLICTS_DDL);
    const insert = this.driver.prepare("INSERT OR IGNORE INTO local_conflicts (event_id, rejected) VALUES (?, ?)");
    try {
      for (const conflict of conflicts) insert.run(conflict.eventId, canonicalize(conflict.rejected));
    } finally {
      insert.finalize();
    }
  }

  async *scan(filter?: Filter): AsyncIterable<Event> {
    const { conditions, bound } = eventFilterSql(filter);
    const events = this.select(`SELECT ${EVENT_COLUMNS} FROM events e${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`} ORDER BY e.at, e.event_id, e.author`, bound, filter);
    for (const event of events) yield event;
  }

  async changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }> {
    const upper = this.lastSeq();
    const from = since === undefined ? 0 : this.place(since, upper);
    const { conditions, bound } = eventFilterSql(filter);
    const events = this.select(
      `SELECT ${EVENT_COLUMNS} FROM event_positions p JOIN events e ON e.event_id = p.event_id WHERE p.accepted_seq > ? AND p.accepted_seq <= ?${conditions.map((c) => ` AND ${c}`).join("")} ORDER BY p.accepted_seq`,
      [from, upper, ...bound],
      filter
    );
    return { token: JSON.stringify({ generation: this.generation, seq: upper }), events: iterate(events) };
  }

  private place(token: ChangeToken, upper: number): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(token);
    } catch {
      throw new BadToken("not a token of this store");
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { generation?: unknown }).generation !== this.generation) {
      throw new BadToken("not a token of this store generation");
    }
    const seq = (parsed as { seq?: unknown }).seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > upper) {
      throw new BadToken("token names a position this store does not hold");
    }
    return seq;
  }

  /** The events the rows of `sql` decode to that match `filter`, read in full now; the damage met on the way is remembered. */
  private select(sql: string, bound: SqlValue[], filter?: Filter): Event[] {
    const events: Event[] = [];
    readEventRows(this.driver, sql, bound, (decoded) => {
      this.noteDamage(decoded);
      if ("event" in decoded && matches(decoded.event, filter)) events.push(decoded.event);
    });
    return events;
  }

  async damaged(): Promise<Damaged[]> {
    return this.survey();
  }

  /** Every row of `events` decoded, the damage found listed; after it, a store that found none is known sound. */
  private survey(): Damaged[] {
    const out: Damaged[] = [];
    readEventRows(this.driver, `SELECT ${EVENT_COLUMNS} FROM events e ORDER BY e.rowid`, [], (decoded) => {
      this.noteDamage(decoded);
      if ("damage" in decoded) out.push(decoded.damage);
    });
    this.surveyed = true;
    return out;
  }

  async tally(): Promise<EventTally> {
    const [row] = query(this.driver, "SELECT count(*) AS n, coalesce(sum(length(canonical)), 0) AS bytes FROM events");
    return { events: Number(row?.["n"]), bytes: Number(row?.["bytes"]) };
  }

  async conflicting(): Promise<Conflict[]> {
    if (!this.hasConflictsTable()) return [];
    const out: Conflict[] = [];
    for (const row of query(this.driver, `SELECT ${EVENT_COLUMNS}, c.rejected AS rejected FROM local_conflicts c JOIN events e ON e.event_id = c.event_id ORDER BY c.seen`)) {
      const kept = this.noteDamage(decodeEventRow(row));
      if ("damage" in kept) continue; // its accepted value is `damaged()`'s to report
      out.push({ eventId: kept.event.eventId, kept: kept.event, rejected: parseStrict(row["rejected"] as Uint8Array) as Event });
    }
    return out;
  }

  /** Forgets every conflict recorded: the diagnostic history, not the events. */
  async clearConflicts(): Promise<void> {
    this.requireWritable("clearConflicts");
    if (this.hasConflictsTable()) run(this.driver, "DELETE FROM local_conflicts");
  }

  private hasConflictsTable(): boolean {
    return hasTable(this.driver, "local_conflicts");
  }

  private noteDamage(decoded: DecodedEventRow): DecodedEventRow {
    if ("damage" in decoded) this.damage ??= decoded.damage;
    return decoded;
  }

  private requireWritable(what: string): void {
    if (!this.writable) throw new ReadOnlyVault(what);
  }

  /**
   * Throws `DamagedHistory` when this store has met damage, or when
   * the survey a store makes once, before its first write, finds any.
   * A runtime's history changes through its owner alone, so one survey
   * per open covers what was there before, and every read after it
   * reports what it meets. Every write of the store asks this first;
   * the vault asks it before a collection pass, whose keep set is
   * folded from the history and cannot be trusted with deletion while
   * that history is incomplete.
   */
  requireSound(): void {
    if (this.damage === undefined && !this.surveyed) this.survey();
    if (this.damage !== undefined) throw new DamagedHistory(this.damage);
  }
}

/**
 * A value as an accepted event would be held: validated, then its
 * canonical bytes and the form they parse to — member order, `-0` and
 * all — so two serializations of one event are one and a local append
 * reads back as its ingest elsewhere would. Throws `InvalidEvent` or
 * `InvalidJson`.
 */
function canonical(value: unknown): Held {
  const bytes = canonicalize(validateEvent(value));
  return { event: parseStrict(bytes) as Event, bytes };
}

/**
 * The event a row of `EVENT_COLUMNS` holds, or the damage it is: bytes
 * that are not canonical JSON, do not validate as an event, are not
 * the event's own canonical bytes, or disagree with the columns beside
 * them. The damage is placed by the row's ID when that is text, else
 * by rowid.
 */
export function decodeEventRow(row: SqlRow): DecodedEventRow {
  const canonical = row["canonical"];
  const bytes = canonical instanceof Uint8Array ? canonical : undefined;
  let where = `events/rowid ${String(row["rowid"])}`;
  try {
    const eventId = row["event_id"];
    if (eventId instanceof Uint8Array) where = `events/${decodeText(eventId, "event_id")}`;
    if (bytes === undefined) throw new Error("canonical is not bytes");
    const event = validateEvent(parseStrict(bytes));
    if (!sameBytes(canonicalize(event), bytes)) throw new Error("the stored bytes are not the event's canonical bytes");
    for (const [column, field] of [
      ["event_id", "eventId"],
      ["at", "at"],
      ["author", "author"],
      ["type", "type"],
    ] as const) {
      const stored = row[column];
      const text = stored instanceof Uint8Array ? decodeUtf8(stored, column) : String(stored);
      if (text !== event[field]) throw new Error(`column ${column} is ${JSON.stringify(text)}, not the event's ${JSON.stringify(event[field])}`);
    }
    return { event };
  } catch (err) {
    return { damage: { where, ...(bytes === undefined ? {} : { bytes }), error: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Every row of `sql`, a selection of `EVENT_COLUMNS` with `bound`
 * bound, decoded and handed to `each` in the order SQLite returns
 * them; the rows are read whole before the first is handed over, one
 * cut, which a write during the walk does not move. The SQL only
 * narrows the rows read: a filter is applied to the decoded event by
 * the caller, so that a match is exactly what the filter says,
 * whatever SQLite made of the bound values.
 */
export function readEventRows(driver: SqliteDriver, sql: string, bound: SqlValue[], each: (decoded: DecodedEventRow) => void): void {
  for (const row of query(driver, sql, ...bound)) each(decodeEventRow(row));
}

/** The SQL that narrows `events` as `e` to `filter`'s author and type, and the values it binds — as bytes cast to text, which carries a NUL where a bound string cannot. */
export function eventFilterSql(filter: Filter | undefined): { conditions: string[]; bound: SqlValue[] } {
  const conditions: string[] = [];
  const bound: SqlValue[] = [];
  if (filter?.author !== undefined) {
    conditions.push("e.author = CAST(? AS TEXT)");
    bound.push(UTF8.encode(filter.author));
  }
  if (filter?.type !== undefined) {
    conditions.push("e.type = CAST(? AS TEXT)");
    bound.push(UTF8.encode(filter.type));
  }
  return { conditions, bound };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
