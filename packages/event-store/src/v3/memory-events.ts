/**
 * The version-3 event store as a map in memory (event-store.md §5): the
 * reference for the interface's semantics, what the vault folds are
 * tested on, and the store `eventStoreSuite` is first run against.
 * Nothing persists, so the process-durable half of §2.1 is vacuous here;
 * `damaged()` and `conflicting()` are empty by construction (§5.6), as a
 * database's are. Every event held is kept in the form its canonical
 * bytes parse to (§5.4) and frozen, so what is handed out is what was
 * accepted.
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
  /** the store generation its tokens name (§5.5); a fresh UUIDv7 when left out */
  generation?: string;
  /** the wall clock in Unix milliseconds (§4.2); default `Date.now`, pinned by tests */
  now?: () => number;
}

/** One accepted event and the canonical text it is equal by (§3.3). */
interface Held {
  event: Event;
  text: string;
}

export class MemoryEventStore implements EventStore {
  readonly author: AuthorId;
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
    this.generation = options.generation ?? v7();
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
      const events = clean.map((draft, i): Event => {
        const event: Event = {
          eventId: eventIds[i] as EventId,
          at,
          author: this.author,
          type: draft.type,
          roots: draft.roots,
          data: draft.data,
        };
        return this.accept(event, canonicalText(event));
      });
      return events as Event<D>[];
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
    // Read everything first (§5.3): what is rejected, what is a duplicate
    // or a conflict against what is held or against the input itself, and
    // whether any of it forks this store's author — then, and only then,
    // write. Between the two, another write may have landed; the write
    // step checks again.
    const outcome: Ingested = { added: 0, duplicates: 0, conflicts: [], rejected: [] };
    const staged = new Map<EventId, Held>();
    const forked: Event[] = [];
    for await (const value of events) {
      let incoming: Held;
      try {
        incoming = canonical(value);
      } catch (err) {
        outcome.rejected.push({ value, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
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
    return this.serialise(() => {
      for (const [eventId, incoming] of staged) {
        const have = this.held.get(eventId);
        if (have === undefined) {
          this.accept(incoming.event, incoming.text);
          outcome.added += 1;
        } else if (have.text === incoming.text) {
          outcome.duplicates += 1;
        } else {
          outcome.conflicts.push({ eventId, kept: have.event, rejected: incoming.event });
        }
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

  private token(seq: number): ChangeToken {
    return JSON.stringify({ generation: this.generation, seq });
  }

  /** The position a token names, or a throw (§5.5): another generation's, malformed, or past what is held. */
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
 * the form its canonical bytes parse to — member order and all — with
 * that canonical text, so two serializations of one event are one
 * (ES-5). Throws `InvalidEvent` or `InvalidJson`.
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
