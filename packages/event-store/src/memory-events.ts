/**
 * The event store as a map in memory (event-store.md §4): the reference
 * for the interface's semantics and the store folds are tested on.
 * Nothing persists; `damaged()` and `conflicting()` are empty by
 * construction, as a database's are (§4.5).
 */

import { BadToken, ForkedSelf } from "./errors.js";
import {
  cleanDraft,
  compareEvents,
  EidMinter,
  matches,
  mintDeviceId,
  mintInstance,
  validateEvent,
  type ChangeToken,
  type Conflict,
  type DamagedLine,
  type Draft,
  type Event,
  type EventStore,
  type Filter,
  type Ingested,
} from "./event.js";
import { deepFreeze, jsonClean, sameJson, type JsonObject } from "./json.js";

export interface MemoryEventStoreOptions {
  /** the device this store appends as; minted when left out */
  self?: string;
  /** the instance id its tokens name; minted when left out */
  instance?: string;
  /** which store of the instance this is (the vault's, an extension's); tokens name it too */
  store?: string;
  /** the wall clock; pinned by tests */
  clock?: () => Date;
}

/** What one `ingest` staged before writing: its outcome so far and the events to add. */
interface Staged {
  outcome: Ingested;
  events: Map<string, Event>;
}

export class MemoryEventStore implements EventStore {
  readonly self: string;
  readonly instance: string;
  readonly store: string;
  private readonly clock: () => Date;
  private readonly minter = new EidMinter();
  /** every event held, by eid */
  private readonly held = new Map<string, Event>();
  /** the same events in the order they arrived; an index into it is what a token names */
  private readonly arrived: Event[] = [];
  /** writes run one at a time */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryEventStoreOptions = {}) {
    this.self = options.self ?? mintDeviceId();
    this.instance = options.instance ?? mintInstance();
    this.store = options.store ?? "vault";
    this.clock = options.clock ?? (() => new Date());
  }

  private serialise<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>> {
    const clean = cleanDraft(draft);
    return this.serialise(() => {
      const now = this.clock();
      const event: Event<D> = {
        eid: this.minter.mint(now.getTime()),
        at: now.toISOString(),
        author: this.self,
        type: clean.type,
        blobs: clean.blobs,
        data: clean.data,
      };
      this.add(event);
      return event;
    });
  }

  async appendAll<D extends JsonObject>(drafts: Draft<D>[]): Promise<Event<D>[]> {
    const cleans = drafts.map(cleanDraft); // every draft checked before anything lands
    return this.serialise(() => {
      const now = this.clock();
      const events = cleans.map(
        (clean): Event<D> => ({
          eid: this.minter.mint(now.getTime()),
          at: now.toISOString(),
          author: this.self,
          type: clean.type,
          blobs: clean.blobs,
          data: clean.data,
        })
      );
      for (const event of events) {
        this.add(event); // one turn of the chain: all in, in input order
      }
      return events;
    });
  }

  private add(event: Event): void {
    deepFreeze(event);
    this.held.set(event.eid, event);
    this.arrived.push(event);
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    // Read everything first (§4.2): what is rejected, what is a duplicate
    // or a conflict against what is held or against the input itself, and
    // whether any of it is self's — then, and only then, write.
    const staged: Staged = { outcome: { added: 0, duplicates: 0, conflicts: [], rejected: [] }, events: new Map() };
    const forked: Event[] = [];
    for await (const raw of events) {
      let event: Event;
      try {
        event = validateEvent(jsonClean(raw));
      } catch (err) {
        staged.outcome.rejected.push({ event: raw, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const have = this.held.get(event.eid) ?? staged.events.get(event.eid);
      if (have !== undefined) {
        if (sameJson(have, event)) {
          staged.outcome.duplicates += 1;
        } else {
          staged.outcome.conflicts.push({ eid: event.eid, kept: have, other: event });
          if (event.author === this.self) {
            forked.push(event);
          }
        }
        continue;
      }
      if (event.author === this.self) {
        forked.push(event);
        continue;
      }
      staged.events.set(event.eid, event);
    }
    if (forked.length > 0) {
      throw new ForkedSelf(this.self, forked);
    }
    return this.serialise(() => {
      // Another ingest may have landed while this one was reading.
      for (const [eid, event] of staged.events) {
        const have = this.held.get(eid);
        if (have === undefined) {
          this.add(event);
          staged.outcome.added += 1;
        } else if (sameJson(have, event)) {
          staged.outcome.duplicates += 1;
        } else {
          staged.outcome.conflicts.push({ eid, kept: have, other: event });
        }
      }
      return staged.outcome;
    });
  }

  async *scan(filter?: Filter): AsyncIterable<Event> {
    // The store sorts (§4.3), over a snapshot: an append during the walk is not yielded.
    const events = [...this.held.values()].sort(compareEvents);
    for (const event of events) {
      if (matches(event, filter)) {
        yield event;
      }
    }
  }

  async changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }> {
    const to = this.arrived.length;
    const from = since === undefined ? 0 : this.place(since);
    const events = this.arrived.slice(from, to).filter((event) => matches(event, filter));
    return { token: this.token(to), events: iterate(events) };
  }

  private token(seq: number): ChangeToken {
    return JSON.stringify({ instance: this.instance, store: this.store, seq });
  }

  /** The position a token names, or a throw: another instance's, another store's, or past what is held. */
  private place(token: ChangeToken): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(token);
    } catch {
      throw new BadToken("not a token of this store");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { instance?: unknown }).instance !== this.instance ||
      (parsed as { store?: unknown }).store !== this.store
    ) {
      throw new BadToken("not a token of this store instance");
    }
    const seq = (parsed as { seq?: unknown }).seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > this.arrived.length) {
      throw new BadToken("token names a position this store does not hold");
    }
    return seq;
  }

  damaged(): DamagedLine[] {
    return [];
  }

  conflicting(): Conflict[] {
    return [];
  }
}

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

