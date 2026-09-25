/**
 * The version-4 event store over an open SQLite runtime: the `events`
 * table, keyed by event CID, and the local control that gives every
 * accepted event a position — what a change token names. The
 * connection is the runtime's, synchronous and owned outright, so a
 * write is one transaction on it, atomic as SQLite makes it, and two
 * writes never interleave: no lock of the store's own is needed. What
 * is handed out is always what the stored canonical bytes parse to,
 * decoded fresh for each call, under the CID the row is keyed by; a
 * row whose bytes do not decode to the event its columns name is
 * damage, left out of every scan, reported by `damaged()`, and from the
 * moment it is found — or looked for, which every write does once —
 * the reason no write is accepted: the history is incomplete. An
 * ordinary read checks the bytes against the columns; the survey
 * `damaged()` makes, and acceptance, also hash them against the CID.
 */

import { BadToken, DamagedControl, DamagedHistory, ForkedAuthor, ReadOnlyVault } from "../errors.js";
import {
  canonicalEnvelope,
  canonicalEvent,
  canonicalEventBytes,
  checkFilter,
  eventCidOfBytes,
  isEventCid,
  matches,
  sampleAt,
  validateDraft,
  validateEnvelope,
  type AuthorId,
  type ChangeToken,
  type Damaged,
  type Draft,
  type Event,
  type EventCid,
  type EventStore,
  type EventTally,
  type Filter,
  type Ingested,
} from "../event.js";
import { parseStrict } from "../jcs.js";
import type { JsonObject } from "../json.js";
import { decodeText, decodeUtf8, type SqliteDriver, type SqliteStatement, type SqlRow, type SqlValue } from "./driver.js";
import type { RuntimeDatabase } from "./open.js";
import { query, run } from "./schema.js";

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
export const EVENT_COLUMNS = "e.rowid AS rowid, CAST(e.cid AS BLOB) AS cid, CAST(e.at AS BLOB) AS at, CAST(e.author AS BLOB) AS author, CAST(e.type AS BLOB) AS type, e.canonical AS canonical";

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
  /** Where every damaged row met so far is: what no scan or delta yields again, however its bytes read on an ordinary decode. */
  private readonly known = new Set<string>();
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
   * inside it, after the batch is hashed and classified and before any
   * of it is accepted, on the same connection and so without a
   * transaction of its own, with how many events are new: what it
   * writes and the events land together. How the SQLite vault
   * publishes a commit's objects with its events. A throw before the
   * commit — from a draft, the clock, the hashing, `publish`, a
   * damaged history or SQLite — accepts no event and takes what
   * `publish` wrote with it. A commit whose outcome SQLite could not
   * report comes back as its error, and what landed is learned by
   * reopening: stopping work until then is the runtime's.
   */
  async appendAll<D extends JsonObject>(drafts: Draft<D>[], publish?: (adding: number) => void): Promise<Event<D>[]> {
    // `Array.from` visits every index, so a hole in a sparse array is refused as a draft that is not an object.
    const clean = Array.from(drafts, (draft) => validateDraft(draft));
    if (clean.length === 0 && publish === undefined) return [];
    this.requireWritable("append");
    const { at } = sampleAt(this.now);
    const held = clean.map((draft) => canonicalEnvelope({ at, author: this.author, type: draft.type, roots: draft.roots, data: draft.data }));
    return this.driver.transaction("immediate", () => {
      this.requireSound();
      const staged = new Map<EventCid, Held>();
      const lookup = this.driver.prepare(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.cid = ?`);
      let out: Event[];
      try {
        out = held.map((incoming) => {
          const have = this.held(lookup, incoming.event.cid) ?? staged.get(incoming.event.cid);
          if (have !== undefined) return have.event;
          staged.set(incoming.event.cid, incoming);
          return incoming.event;
        });
      } finally {
        lookup.finalize();
      }
      publish?.(staged.size);
      this.accept([...staged.values()]);
      return out as Event<D>[];
    });
  }

  /** Inserts `held`, none of which is held yet, giving each the next position and advancing `last_seq` by as many; nothing for none. Inside the caller's transaction. */
  private accept(held: Held[]): void {
    if (held.length === 0) return;
    const last = this.lastSeq();
    const insertEvent = this.driver.prepare("INSERT INTO events (cid, at, author, type, canonical) VALUES (?, ?, ?, CAST(? AS TEXT), ?)");
    const insertPosition = this.driver.prepare("INSERT INTO event_positions (accepted_seq, cid) VALUES (?, ?)");
    try {
      held.forEach(({ event, bytes }, i) => {
        insertEvent.run(event.cid, event.at, event.author, UTF8.encode(event.type), bytes);
        insertPosition.run(last + i + 1, event.cid);
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

  /**
   * `publish`, when given, runs inside the transaction once the input
   * is classified and the fork check has passed, before the new events
   * are accepted, with how many there are: what it writes lands with
   * them, and a throw from it accepts none.
   */
  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>, publish?: (adding: number) => void): Promise<Ingested> {
    // Read everything first: validation, canonical form and the CID
    // check are the input's own and need no transaction, which must
    // not wait on a source. Then, in one transaction, classify each
    // input against what is held — duplicate or new — in input order,
    // check for a fork, and only then accept; so the outcome names
    // what was held when the decision was made, and a write that
    // landed while the input was still being read is seen.
    this.requireWritable("ingest");
    const read: IngestInput[] = [];
    for await (const value of events) {
      try {
        read.push({ held: canonicalEvent(value) });
      } catch (err) {
        read.push({ rejected: { value, error: err instanceof Error ? err.message : String(err) } });
      }
    }
    return this.driver.transaction("immediate", () => {
      this.requireSound();
      const outcome: Ingested = { added: 0, duplicates: 0, rejected: [] };
      const staged = new Map<EventCid, Held>();
      const forked: Event[] = [];
      const lookup = this.driver.prepare(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.cid = ?`);
      try {
        for (const item of read) {
          if ("rejected" in item) {
            outcome.rejected.push(item.rejected);
            continue;
          }
          const incoming = item.held;
          if (this.held(lookup, incoming.event.cid) !== undefined || staged.has(incoming.event.cid)) {
            outcome.duplicates += 1;
            continue;
          }
          if (incoming.event.author === this.author) {
            forked.push(incoming.event);
            continue;
          }
          staged.set(incoming.event.cid, incoming);
        }
      } finally {
        lookup.finalize();
      }
      if (forked.length > 0) throw new ForkedAuthor(this.author, forked);
      publish?.(staged.size);
      this.accept([...staged.values()]);
      outcome.added = staged.size;
      return outcome;
    });
  }

  /** What is held under `cid`, as its canonical bytes and the event they parse to; `undefined` for nothing. A damaged row is a throw: what is held under the CID cannot be told. */
  private held(lookup: SqliteStatement, cid: EventCid): Held | undefined {
    const row = lookup.get(cid);
    if (row === undefined) return undefined;
    const decoded = this.noteDamage(decodeEventRow(row));
    if ("damage" in decoded) throw new DamagedHistory(decoded.damage);
    return { event: decoded.event, bytes: row["canonical"] as Uint8Array };
  }

  async *scan(filter?: Filter): AsyncIterable<Event> {
    const { conditions, bound } = eventFilterSql(filter);
    const events = this.select(`SELECT ${EVENT_COLUMNS} FROM events e${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`} ORDER BY e.at, e.cid`, bound, filter);
    for (const event of events) yield event;
  }

  async changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }> {
    const { conditions, bound } = eventFilterSql(filter);
    const upper = this.lastSeq();
    const from = since === undefined ? 0 : this.place(since, upper);
    const events = this.select(
      `SELECT ${EVENT_COLUMNS} FROM event_positions p JOIN events e ON e.cid = p.cid WHERE p.accepted_seq > ? AND p.accepted_seq <= ?${conditions.map((c) => ` AND ${c}`).join("")} ORDER BY p.accepted_seq`,
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

  /** The events the rows of `sql` decode to that match `filter`, read in full now, rows known damaged left out; the damage met on the way is remembered. */
  private select(sql: string, bound: SqlValue[], filter?: Filter): Event[] {
    const events: Event[] = [];
    readEventRows(this.driver, sql, bound, (decoded, place) => {
      this.noteDamage(decoded, place);
      if ("event" in decoded && !this.known.has(place) && matches(decoded.event, filter)) events.push(decoded.event);
    });
    return events;
  }

  async damaged(): Promise<Damaged[]> {
    return this.survey();
  }

  /** Every row of `events` decoded and hashed against its CID, the damage found listed; after it, a store that found none is known sound. */
  private survey(): Damaged[] {
    const out: Damaged[] = [];
    readEventRows(
      this.driver,
      `SELECT ${EVENT_COLUMNS} FROM events e ORDER BY e.rowid`,
      [],
      (decoded, place) => {
        this.noteDamage(decoded, place);
        if ("damage" in decoded) out.push(decoded.damage);
      },
      { hash: true }
    );
    this.surveyed = true;
    return out;
  }

  async tally(): Promise<EventTally> {
    const [row] = query(this.driver, "SELECT count(*) AS n, coalesce(sum(length(canonical)), 0) AS bytes FROM events");
    return { events: Number(row?.["n"]), bytes: Number(row?.["bytes"]) };
  }

  private noteDamage(decoded: DecodedEventRow, place = "damage" in decoded ? decoded.damage.where : ""): DecodedEventRow {
    if ("damage" in decoded) {
      this.damage ??= decoded.damage;
      this.known.add(place);
    }
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

/** How far `decodeEventRow` checks a row: with `hash`, the bytes are hashed against the CID column too. */
export interface DecodeOptions {
  hash?: boolean;
}

/**
 * The event a row of `EVENT_COLUMNS` holds, or the damage it is: bytes
 * that are not canonical JSON, do not validate as an envelope, are not
 * the envelope's own canonical bytes, or disagree with the columns
 * beside them — the CID column not spelled as a CID, or, when `hash`
 * is asked, not the one the bytes hash to. The damage is placed by the
 * row's CID when that is text, else by rowid. The event handed back
 * carries the stored CID.
 */
export function decodeEventRow(row: SqlRow, options: DecodeOptions = {}): DecodedEventRow {
  const canonical = row["canonical"];
  const bytes = canonical instanceof Uint8Array ? canonical : undefined;
  const where = placeOf(row);
  try {
    const stored = row["cid"];
    if (bytes === undefined) throw new Error("canonical is not bytes");
    const envelope = validateEnvelope(parseStrict(bytes));
    if (!sameBytes(canonicalEventBytes(envelope), bytes)) throw new Error("the stored bytes are not the envelope's canonical bytes");
    const cid = stored instanceof Uint8Array ? decodeText(stored, "cid") : String(stored);
    if (!isEventCid(cid)) throw new Error(`column cid ${JSON.stringify(cid)} is not a canonical raw DASL CID`);
    if (options.hash === true) {
      const computed = eventCidOfBytes(bytes);
      if (cid !== computed) throw new Error(`column cid is ${cid}, but the bytes hash to ${computed}`);
    }
    for (const column of ["at", "author", "type"] as const) {
      const value = row[column];
      const text = value instanceof Uint8Array ? decodeUtf8(value, column) : String(value);
      if (text !== envelope[column]) throw new Error(`column ${column} is ${JSON.stringify(text)}, not the event's ${JSON.stringify(envelope[column])}`);
    }
    return { event: { ...envelope, cid } };
  } catch (err) {
    return { damage: { where, ...(bytes === undefined ? {} : { bytes }), error: err instanceof Error ? err.message : String(err) } };
  }
}

/** Where a row of `EVENT_COLUMNS` is, in the store's terms: by its CID column when that is text, else by rowid. */
export function placeOf(row: SqlRow): string {
  const stored = row["cid"];
  if (stored instanceof Uint8Array) {
    try {
      return `events/${decodeText(stored, "cid")}`;
    } catch {
      // not text: named by rowid below
    }
  }
  return `events/rowid ${String(row["rowid"])}`;
}

/**
 * Every row of `sql`, a selection of `EVENT_COLUMNS` with `bound`
 * bound, decoded and handed to `each` with its place, in the order
 * SQLite returns them; the rows are read whole before the first is
 * handed over, one cut, which a write during the walk does not move.
 * The SQL only narrows the rows read: a filter is applied to the
 * decoded event by the caller, so that a match is exactly what the
 * filter says, whatever SQLite made of the bound values.
 */
export function readEventRows(driver: SqliteDriver, sql: string, bound: SqlValue[], each: (decoded: DecodedEventRow, place: string) => void, options: DecodeOptions = {}): void {
  for (const row of query(driver, sql, ...bound)) each(decodeEventRow(row, options), placeOf(row));
}

/**
 * The SQL that narrows `events` as `e` to `filter`'s CID, author and
 * type, and the values it binds — as bytes cast to text, which carries
 * a NUL where a bound string cannot. A `cid` that is not a canonical
 * raw CID is refused here, before anything is read.
 */
export function eventFilterSql(filter: Filter | undefined): { conditions: string[]; bound: SqlValue[] } {
  checkFilter(filter);
  const conditions: string[] = [];
  const bound: SqlValue[] = [];
  if (filter?.cid !== undefined) {
    conditions.push("e.cid = CAST(? AS TEXT)");
    bound.push(UTF8.encode(filter.cid));
  }
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
