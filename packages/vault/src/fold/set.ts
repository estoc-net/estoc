/**
 * The event set a fold reads: every event once, by CID, in whatever
 * order it arrived. Each event of a version-4 type is read against its
 * schema on entry; one that fails stays listed with its fault, and one
 * of a type this version does not name is kept as it is, so both keep
 * holding their roots. A fold asks for a type's events in canonical
 * order and for the target of a typed reference, and never sees arrival
 * order. The events are a store's accepted events, one per CID: the
 * same CID offered again is the same event, and is not added twice.
 */

import { canonicalText, compareEvents, type AuthorId, type Event, type EventCid } from "@estoc/event-store";

import { InvalidPayload } from "../errors.js";
import { isVaultEventType, readVaultEvent, type VaultEvent } from "../schema.js";
import type { EventReference, VaultEventType } from "../types.js";

/** An event of a version-4 type whose payload or roots break that type's schema. */
export type InvalidVaultEvent = { event: Event; error: InvalidPayload };

/**
 * What a typed reference points at: the event of the required type,
 * nothing yet, or an event of another type. Missing evidence defers the
 * work that needs it; mismatched evidence is a conflict.
 */
export type Resolved<T extends VaultEventType> = { status: "present"; event: VaultEvent<T> } | { status: "missing" } | { status: "mismatched"; event: Event };

export class VaultEventSet {
  private readonly read = new Map<EventCid, VaultEvent>();
  private readonly kept = new Map<EventCid, Event>();
  private readonly byType = new Map<VaultEventType, VaultEvent[]>();
  private readonly sorted = new Map<VaultEventType, VaultEvent[]>();
  readonly invalid: InvalidVaultEvent[] = [];

  static of(events: Iterable<Event>): VaultEventSet {
    const set = new VaultEventSet();
    for (const event of events) set.add(event);
    return set;
  }

  static async from(events: AsyncIterable<Event>): Promise<VaultEventSet> {
    const set = new VaultEventSet();
    for await (const event of events) set.add(event);
    return set;
  }

  /** Add one event; false when the set already holds its CID. */
  add(event: Event): boolean {
    if (this.read.has(event.cid) || this.kept.has(event.cid)) return false;
    if (!isVaultEventType(event.type)) {
      this.kept.set(event.cid, event);
      return true;
    }
    let read: VaultEvent;
    try {
      read = readVaultEvent(event);
    } catch (err) {
      if (!(err instanceof InvalidPayload)) throw err;
      this.invalid.push({ event, error: err });
      this.kept.set(event.cid, event);
      return true;
    }
    this.read.set(event.cid, read);
    const list = this.byType.get(read.type);
    if (list === undefined) this.byType.set(read.type, [read]);
    else list.push(read);
    this.sorted.delete(read.type);
    return true;
  }

  get size(): number {
    return this.read.size + this.kept.size;
  }

  /** Every event of `type`, in canonical order. */
  of<T extends VaultEventType>(type: T): readonly VaultEvent<T>[] {
    let list = this.sorted.get(type);
    if (list === undefined) {
      list = [...(this.byType.get(type) ?? [])].sort(compareEvents);
      this.sorted.set(type, list);
    }
    return list as VaultEvent<T>[];
  }

  /** The event a reference names, if it is here and of the type the reference requires. */
  resolve<T extends VaultEventType>(reference: EventReference<T>, type: T): Resolved<T> {
    const read = this.read.get(reference);
    if (read !== undefined) return read.type === type ? { status: "present", event: read as VaultEvent<T> } : { status: "mismatched", event: read };
    const kept = this.kept.get(reference);
    return kept === undefined ? { status: "missing" } : { status: "mismatched", event: kept };
  }

  /** Every event here, read or kept, in no promised order. */
  *all(): IterableIterator<Event> {
    yield* this.read.values();
    yield* this.kept.values();
  }

  /** The events of a type this version does not name, and the invalid ones: held for their roots, never applied. */
  *unapplied(): IterableIterator<Event> {
    yield* this.kept.values();
  }

  /** Every event read against its schema, in no promised order. */
  *applied(): IterableIterator<VaultEvent> {
    yield* this.read.values();
  }

  authors(): Set<AuthorId> {
    const authors = new Set<AuthorId>();
    for (const event of this.all()) authors.add(event.author);
    return authors;
  }
}

/** The complete canonical key of an event: what orders it among others. */
export type SourceKey = { readonly at: string; readonly cid: EventCid };

export const keyOf = (event: { at: string; cid: EventCid }): SourceKey => ({ at: event.at, cid: event.cid });

/** Canonical order: by `at`, then the event CID's text. */
export function compareKeys(a: SourceKey, b: SourceKey): number {
  return cmp(a.at, b.at) || cmp(a.cid, b.cid);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The last of `events` in canonical order, or null: what a latest-wins value is. */
export function latest<E extends Event>(events: Iterable<E>): E | null {
  let best: E | null = null;
  for (const event of events) {
    if (best === null || compareEvents(best, event) < 0) best = event;
  }
  return best;
}

/** `events` grouped by a key, each group in the order given. */
export function groupBy<E, K>(events: Iterable<E>, keyOf: (event: E) => K): Map<K, E[]> {
  const groups = new Map<K, E[]>();
  for (const event of events) {
    const key = keyOf(event);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [event]);
    else group.push(event);
  }
  return groups;
}

/** Do two payloads say the same thing? Equal as RFC 8785 text. */
export function samePayload(a: unknown, b: unknown): boolean {
  return canonicalText(a) === canonicalText(b);
}
