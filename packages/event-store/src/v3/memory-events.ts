/**
 * The version-3 event store as a map in memory (event-store.md §5): the
 * reference for the interface's semantics, what the vault folds are
 * tested on, and the store `eventStoreSuite` is first run against.
 * Nothing persists, so the process-durable half of §2.1 is vacuous here;
 * `damaged()` and `conflicting()` are empty by construction (§5.6), as a
 * database's are. Every event held — appended or ingested — is kept in
 * the form its canonical bytes parse to (§5.4) and frozen, so what is
 * handed out is what was accepted, the same from every store.
 */

import { v7 } from "uuid";

import { BadToken, ForkedAuthor } from "./errors.js";
import {
  compareEvents,
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
  type Filter,
  type Ingested,
} from "./event.js";
import { canonicalText, parseStrict } from "./jcs.js";
import type { JsonObject } from "./json.js";
import { mint } from "./mint.js";

export interface MemoryEventStoreOptions {
  /** the author this store appends as (§4.1); a fresh UUIDv7 when left out */
  author?: AuthorId;
  /** the wall clock in Unix milliseconds (§4.2); default `Date.now`, pinned by tests */
  now?: () => number;
}

/** What one `ingest` read before taking the lock: each input either as an accepted event would be held, or rejected. */
type Read = { held: Held } | { rejected: { value: unknown; error: string } };

/** One accepted event and the canonical text it is equal by (§3.3). */
interface Held {
  event: Event;
  text: string;
}

export class MemoryEventStore implements EventStore {
  readonly author: AuthorId;
  /** the store generation its tokens name (§5.5): this instance, and no other, so minted here and never given */
  readonly generation: string;
  private readonly now: () => number;
  /** every event held, by `eventId` */
  private readonly held = new Map<EventId, Held>();
  /** the same events in the order they were accepted; an index into it is what a token names */
  private readonly accepted: Event[] = [];
  /** writes run one at a time: the writer lock of §10, as far as one store in memory needs it */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryEventStoreOptions = {}) {
    this.author = options.author ?? (v7() as AuthorId);
    this.generation = v7();
    this.now = options.now ?? Date.now;
  }

  private serialise<T>(work: () => T): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>> {
    const [event] = await this.appendAll([draft]);
    return event as Event<D>;
  }

  async appendAll<D extends JsonObject>(drafts: Draft<D>[]): Promise<Event<D>[]> {
    const clean = drafts.map((draft) => validateDraft(draft)); // every draft checked before anything lands (§5.2)
    if (clean.length === 0) return [];
    return this.serialise(() => {
      // One clock reading and one `at` for the batch; a throw from the clock
      // or the generator lands before any event does (§4.2, ES-22).
      const { at, eventIds } = mint(clean.length, this.now);
      // Every event of the batch is brought to the form its canonical
      // bytes parse to (§5.4) before any is accepted, so what append
      // returns is what scan and another store's ingest hand out.
      const held = clean.map((draft, i) =>
        canonical({ eventId: eventIds[i], at, author: this.author, type: draft.type, roots: draft.roots, data: draft.data })
      );
      return held.map((h) => this.accept(h.event, h.text)) as Event<D>[];
    });
  }

  /** Add an event this store does not hold: it is frozen and, from here on, what `scan` hands out. */
  private accept(event: Event, text: string): Event {
    freeze(event);
    this.held.set(event.eventId, { event, text });
    this.accepted.push(event);
    return event;
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    // Read everything first (§5.3): validation and canonical form are
    // the input's own and need no lock. Then, under the writer lock (§10),
    // classify each input against what is held — duplicate, conflict,
    // new — in input order, check for a fork, and only then accept; so the
    // outcome names what was actually held when the decision was made,
    // and a write that lands while the input is still being read is seen.
    const read: Read[] = [];
    for await (const value of events) {
      try {
        read.push({ held: canonical(value) });
      } catch (err) {
        read.push({ rejected: { value, error: err instanceof Error ? err.message : String(err) } });
      }
    }
    return this.serialise(() => {
      const outcome: Ingested = { added: 0, duplicates: 0, conflicts: [], rejected: [] };
      const staged = new Map<EventId, Held>();
      const forked: Event[] = [];
      for (const item of read) {
        if ("rejected" in item) {
          outcome.rejected.push(item.rejected);
          continue;
        }
        const incoming = item.held;
        const have = this.held.get(incoming.event.eventId) ?? staged.get(incoming.event.eventId);
        if (have !== undefined) {
          if (have.text === incoming.text) {
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
      if (forked.length > 0) throw new ForkedAuthor(this.author, forked);
      for (const incoming of staged.values()) {
        this.accept(incoming.event, incoming.text);
        outcome.added += 1;
      }
      return outcome;
    });
  }

  async *scan(filter?: Filter): AsyncIterable<Event> {
    // The store sorts (§4.3), over a snapshot: a write during the walk is not yielded.
    const events = [...this.held.values()].map((held) => held.event).sort(compareEvents);
    for (const event of events) {
      if (matches(event, filter)) yield event;
    }
  }

  async changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }> {
    const to = this.accepted.length;
    const from = since === undefined ? 0 : this.place(since);
    const events = this.accepted.slice(from, to).filter((event) => matches(event, filter));
    return { token: this.token(to), events: iterate(events) };
  }

  /** The frontier at `seq`: this generation, the position, and the ID accepted last before it, which names the event set (§5.5). */
  private token(seq: number): ChangeToken {
    return JSON.stringify({ generation: this.generation, seq, last: seq === 0 ? null : this.accepted[seq - 1]?.eventId });
  }

  /** The position a token names, or a throw (§5.5): another generation's, malformed, past what is held, or of another event set. */
  private place(token: ChangeToken): number {
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
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > this.accepted.length) {
      throw new BadToken("token names a position this store does not hold");
    }
    const last = (parsed as { last?: unknown }).last;
    if (last !== (seq === 0 ? null : this.accepted[seq - 1]?.eventId)) {
      throw new BadToken("token names an event set this store does not hold");
    }
    return seq;
  }

  async damaged(): Promise<Damaged[]> {
    return [];
  }

  async conflicting(): Promise<Conflict[]> {
    return [];
  }
}

/**
 * A value as an accepted event would be held: validated (§3.4), then
 * the form its canonical bytes parse to — member order, `-0` and all —
 * with that canonical text, so two serializations of one event are one
 * (ES-5) and a local append reads back as its ingest elsewhere would.
 * Throws `InvalidEvent` or `InvalidJson`.
 */
function canonical(value: unknown): Held {
  const text = canonicalText(validateEvent(value));
  return { event: parseStrict(text) as Event, text };
}

function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) freeze(inner);
}

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
