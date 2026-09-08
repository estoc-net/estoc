import { describe, expect, it } from "vitest";

import {
  BadToken,
  ForkedAuthor,
  InvalidEvent,
  compareEvents,
  isEventId,
  isUuidv7,
  matches,
  timestampOf,
  type AuthorId,
  type Cid,
  type Event,
  type EventStore,
  type Filter,
} from "../../../src/v3/index.js";
import { all, altered, authorN, clock, ids, partition, renamed, reordered, shuffle, uuidv7At } from "./helpers.js";

export interface OpenOptions {
  author?: AuthorId;
  /** the wall clock in Unix milliseconds */
  now?: () => number;
}

/** Open a fresh, empty store of the kind under test, as its own generation. */
export type OpenStore = (options?: OpenOptions) => Promise<EventStore>;

const RAW_HELLO = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq" as Cid;
const T0 = "2026-09-06T10:00:00.000Z";

/** A fold any store must make the same of (§2 rule 3): IDs in canonical order, a count per type and per author. */
interface Folded {
  order: string[];
  perType: Record<string, number>;
  perAuthor: Record<string, number>;
}

function fold(events: Event[]): Folded {
  const sorted = [...events].sort(compareEvents);
  const perType: Record<string, number> = {};
  const perAuthor: Record<string, number> = {};
  for (const event of sorted) {
    perType[event.type] = (perType[event.type] ?? 0) + 1;
    perAuthor[event.author] = (perAuthor[event.author] ?? 0) + 1;
  }
  return { order: ids(sorted), perType, perAuthor };
}

/**
 * The conformance suite of event-store.md §5 over one `EventStore`,
 * whatever it is made of: what a store in memory, a folder and a
 * database must all agree on. `open` gives the suite fresh stores, each
 * its own generation. Durability across a process restart (ES-1's
 * second half, ES-2, ES-3) is a backend's to show with its own tests.
 */
export function eventStoreSuite(name: string, open: OpenStore): void {
  /** Events of another replica, made honestly: appended by a store that is that author, then read back. */
  async function foreign(author: AuthorId, now: () => number, drafts: { type: string; data?: object }[]): Promise<Event[]> {
    const store = await open({ author, now });
    return store.appendAll(drafts.map((draft) => ({ type: draft.type, data: (draft.data ?? {}) as Record<string, never> })));
  }

  describe(`${name}: EventStore`, () => {
    it("ES-1: append mints the six-field envelope — `at` from the store's clock, `author` the store's own — and hands back the whole event", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      expect(store.author).toBe(authorN(1));
      const event = await store.append({ type: "contact.labeled", data: { contact: "c1", label: "alice" } });
      expect(isEventId(event.eventId)).toBe(true);
      expect(event).toEqual({
        eventId: event.eventId,
        at: T0,
        author: authorN(1),
        type: "contact.labeled",
        roots: [],
        data: { contact: "c1", label: "alice" },
      });
      expect(Object.keys(event)).toHaveLength(6);
      c.advance(1000);
      const later = await store.append({ type: "x", roots: [RAW_HELLO], data: {} });
      expect(later.at).toBe("2026-09-06T10:00:01.000Z");
      expect(later.roots).toEqual([RAW_HELLO]);
      expect(await all(store.scan())).toEqual([event, later]);
    });

    it("append stores a copy of the draft: a draft changed afterwards changes nothing held", async () => {
      const store = await open();
      const draft = { type: "t", data: { list: [1, 2], nested: { a: 1 } }, roots: [] as Cid[] };
      await store.append(draft);
      draft.data.list.push(3);
      draft.data.nested.a = 2;
      draft.roots.push(RAW_HELLO);
      const [stored] = await all(store.scan());
      expect(stored?.data).toEqual({ list: [1, 2], nested: { a: 1 } });
      expect(stored?.roots).toEqual([]);
    });

    it("ES-22: a draft that cannot become an event, or a clock that cannot be read, fails the append or the whole batch before anything lands", async () => {
      const store = await open();
      const bad: unknown[] = [
        { type: "", data: {} },
        { type: 1, data: {} },
        { data: {} },
        { type: "t" },
        { type: "t", data: [] },
        { type: "t", data: null },
        { type: "t", data: { u: undefined } },
        { type: "t", data: { n: NaN } },
        { type: "t", data: { big: 1n } },
        { type: "t", data: {}, roots: RAW_HELLO },
        { type: "t", data: {}, roots: ["not-a-cid"] },
        { type: "t", data: {}, roots: ["bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"] }, // drisl, not raw
      ];
      for (const [i, draft] of bad.entries()) {
        await expect(store.append(draft as never), `draft #${i}`).rejects.toBeInstanceOf(InvalidEvent);
        await expect(store.appendAll([{ type: "t", data: {} }, draft as never]), `batch with draft #${i}`).rejects.toBeInstanceOf(InvalidEvent);
      }
      expect(await all(store.scan())).toEqual([]);
      const broken = await open({
        now: () => {
          throw new Error("no clock");
        },
      });
      await expect(broken.append({ type: "t", data: {} })).rejects.toThrow("no clock");
      await expect(broken.appendAll([{ type: "t", data: {} }, { type: "t", data: {} }])).rejects.toThrow("no clock");
      expect(await all(broken.scan())).toEqual([]);
    });

    it("a draft carrying eventId, at or author is refused — never re-minted as a second event — and the whole batch with it", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const held = await store.append({ type: "t", data: { n: 1 } });
      const carrying: unknown[] = [
        held, // an event handed back as a draft
        { type: "t", data: {}, eventId: held.eventId },
        { type: "t", data: {}, at: T0 },
        { type: "t", data: {}, author: authorN(1) },
        { type: "t", data: {}, author: authorN(2) },
        { type: "t", data: {}, eventId: "supplied-by-caller" },
      ];
      for (const [i, draft] of carrying.entries()) {
        await expect(store.append(draft as never), `draft #${i}`).rejects.toBeInstanceOf(InvalidEvent);
        await expect(store.appendAll([{ type: "t", data: {} }, draft as never]), `batch with draft #${i}`).rejects.toBeInstanceOf(InvalidEvent);
      }
      expect(await all(store.scan())).toEqual([held]);
    });

    it("ES-19: one appendAll of 5000 drafts in one millisecond — one `at`, 5000 distinct IDs, input order back", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const before = await store.append({ type: "t", data: { n: -1 } });
      c.advance(1);
      const drafts = Array.from({ length: 5000 }, (_, n) => ({ type: n % 2 === 0 ? "even" : "odd", data: { n } }));
      const batch = await store.appendAll(drafts);
      expect(batch).toHaveLength(5000);
      expect(batch.map((event) => event.data.n)).toEqual(drafts.map((draft) => draft.data.n));
      expect(new Set(batch.map((event) => event.at))).toEqual(new Set(["2026-09-06T10:00:00.001Z"]));
      expect(new Set(ids(batch)).size).toBe(5000);
      for (const event of batch) {
        expect(isUuidv7(event.eventId)).toBe(true);
        expect(event.author).toBe(authorN(1));
      }
      const scanned = await all(store.scan());
      expect(scanned).toHaveLength(5001);
      expect(scanned[0]).toEqual(before);
      expect(ids(scanned.slice(1))).toEqual(ids([...batch].sort(compareEvents)));
      expect(await all(store.scan({ type: "even" }))).toHaveLength(2500);
    });

    it("appendAll of nothing writes nothing", async () => {
      const store = await open();
      expect(await store.appendAll([])).toEqual([]);
      expect(await all(store.scan())).toEqual([]);
    });

    it("ES-20: after the clock rolls back `at` follows it, every ID is still distinct and a batch shares one `at`", async () => {
      const c = clock(T0);
      const store = await open({ now: c.now });
      const first = await store.append({ type: "t", data: {} });
      c.advance(-60_000);
      const back = await store.append({ type: "t", data: {} });
      const batch = await store.appendAll([
        { type: "t", data: {} },
        { type: "t", data: {} },
      ]);
      expect(back.at).toBe("2026-09-06T09:59:00.000Z");
      expect(back.at < first.at).toBe(true); // `at` is the wall clock, and says so
      expect(new Set(ids([first, back, ...batch])).size).toBe(4);
      expect(new Set(batch.map((event) => event.at))).toEqual(new Set([back.at]));
      expect(ids(await all(store.scan()))).toEqual(ids([first, back, ...batch].sort(compareEvents)));
    });

    it("ES-9: scan yields canonical order — (at, eventId, author) — whatever order events were written in", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      c.set("2026-09-06T12:00:00.000Z");
      const noon = await store.append({ type: "t", data: { n: 1 } });
      c.set("2026-09-06T08:00:00.000Z");
      const morning = await store.append({ type: "t", data: { n: 2 } });
      c.set(T0);
      const ten = await store.append({ type: "t", data: { n: 3 } });
      // another replica at the same instant as `ten`; ties within one `at` fall to eventId, then author
      const [other] = await foreign(authorN(2), c.now, [{ type: "t" }]);
      await store.ingest([other]);
      const expected = [morning, ten, other as Event, noon].sort(compareEvents);
      expect(await all(store.scan())).toEqual(expected);
      expect(ids(expected)[0]).toBe(morning.eventId);
      expect(ids(expected)[3]).toBe(noon.eventId);
      // and a store given the same set in another order scans the same
      const again = await open({ author: authorN(3), now: c.now });
      await again.ingest(shuffle([noon, morning, ten, other as Event], 7));
      expect(await all(again.scan())).toEqual(expected);
    });

    it("scan's filter is equality on author, type and the top level of data, null included, nothing coerced", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const a = await store.append({ type: "t", data: { k: "x", n: 1, flag: null, deep: { k: "x" } } });
      const b = await store.append({ type: "t", data: { k: "y", n: 1 } });
      const cEvent = await store.append({ type: "u", data: { k: "x", n: "1" } });
      const [foreignEvent] = await foreign(authorN(2), c.now, [{ type: "t", data: { k: "x" } }]);
      await store.ingest([foreignEvent]);
      const query = async (filter: Filter): Promise<string[]> => ids(await all(store.scan(filter)));
      expect(await query({})).toHaveLength(4);
      expect(await query({ author: authorN(1) })).toEqual(sorted([a, b, cEvent]));
      expect(await query({ author: authorN(2) })).toEqual([foreignEvent?.eventId]);
      expect(await query({ type: "t" })).toEqual(sorted([a, b, foreignEvent as Event]));
      expect(await query({ type: "t", data: { k: "x" } })).toEqual(sorted([a, foreignEvent as Event]));
      expect(await query({ data: { n: 1 } })).toEqual(sorted([a, b]));
      expect(await query({ data: { n: "1" } })).toEqual([cEvent.eventId]); // no coercion
      expect(await query({ data: { flag: null } })).toEqual([a.eventId]); // present and null
      expect(await query({ data: { missing: null } })).toEqual([]); // absent is not null
      expect(await query({ data: { k: undefined } })).toHaveLength(4); // undefined: no constraint
      expect(await query({ data: { deep: "x" } })).toEqual([]); // an object never equals a primitive
      expect(await query({ author: authorN(9) })).toEqual([]);
      for (const event of await all(store.scan({ type: "t", data: { k: "x" } }))) {
        expect(matches(event, { type: "t", data: { k: "x" } })).toBe(true);
      }
    });

    it("ES-5, ES-6: ingest counts each of its four outcomes — added, duplicate under another serialization, conflict with the held value kept, rejected — and stores only the added", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const [one, two, three] = await foreign(authorN(2), c.now, [{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }, { type: "t", data: { n: 3 } }]);
      expect(await store.ingest([one, two])).toEqual({ added: 2, duplicates: 0, conflicts: [], rejected: [] });
      const outcome = await store.ingest([
        reordered(one as Event), // same event, other member order and whitespace
        altered(two as Event), // same eventId, other content
        three, // new
        three, // and again within one input
        null, // not an event at all
        { ...three, extra: 1 },
        { ...(three as Event), at: "2026-09-06T10:00:00Z" },
        { ...(three as Event), eventId: "not-a-uuid" },
      ]);
      expect(outcome.added).toBe(1);
      expect(outcome.duplicates).toBe(2);
      expect(outcome.conflicts).toHaveLength(1);
      expect(outcome.conflicts[0]?.eventId).toBe(two?.eventId);
      expect(outcome.conflicts[0]?.kept).toEqual(two);
      expect(outcome.conflicts[0]?.rejected).toEqual(altered(two as Event));
      expect(outcome.rejected).toHaveLength(4);
      expect(outcome.rejected.map((r) => r.value)).toEqual([null, { ...three, extra: 1 }, { ...three, at: "2026-09-06T10:00:00Z" }, { ...three, eventId: "not-a-uuid" }]);
      for (const r of outcome.rejected) expect(r.error).toBeTypeOf("string");
      expect(await all(store.scan())).toEqual(([one, two, three] as Event[]).sort(compareEvents)); // the held value of `two` is untouched
      // a conflict inside one input, neither side held: the first seen is kept, the other reported
      const fresh = await open({ author: authorN(3), now: c.now });
      const [four] = await foreign(authorN(2), c.now, [{ type: "t", data: { n: 4 } }]);
      const inner = await fresh.ingest([altered(four as Event), four]);
      expect(inner.added).toBe(1);
      expect(inner.conflicts).toEqual([{ eventId: four?.eventId, kept: altered(four as Event), rejected: four }]);
      expect(await all(fresh.scan())).toEqual([altered(four as Event)]);
    });

    it("ES-5: what ingest hands back later is the event its canonical bytes parse to, whatever serialization arrived", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const [event] = await foreign(authorN(2), c.now, [{ type: "t", data: { z: 1, a: [1, { y: 2, x: 3 }] } }]);
      await store.ingest([reordered(event as Event)]);
      const [held] = await all(store.scan());
      expect(held).toEqual(event);
      expect(JSON.stringify(held)).toBe(JSON.stringify(JSON.parse(new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(sortedDeep(event)))))));
    });

    it("a local append is held, returned and scanned in the form its canonical bytes parse to — `-0` as 0, members in canonical order — the same as its ingest elsewhere", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const draft = { type: "t", data: { z: -0, a: 1, nested: { y: [2, { q: 1, p: 2 }], x: 1 } } };
      const returned = await store.append(draft);
      expect(Object.is(returned.data["z"], 0)).toBe(true);
      expect(Object.keys(returned.data)).toEqual(["a", "nested", "z"]);
      expect(Object.keys(returned)).toEqual(["at", "author", "data", "eventId", "roots", "type"]);
      expect(Object.keys((returned.data["nested"] as { y: unknown[] }).y[1] as object)).toEqual(["p", "q"]);
      const [scanned] = await all(store.scan());
      const [changed] = await all((await store.changes()).events);
      const other = await open({ author: authorN(2), now: c.now });
      await other.ingest([reordered(returned)]);
      const [ingested] = await all(other.scan());
      for (const form of [scanned, changed, ingested]) {
        expect(JSON.stringify(form)).toBe(JSON.stringify(returned));
        expect(Object.is((form as Event).data["z"], 0)).toBe(true);
      }
      const batch = await store.appendAll([{ type: "t", data: { b: 1, a: -0 } }]);
      expect(JSON.stringify(batch[0]?.data)).toBe('{"a":0,"b":1}');
    });

    it("ES-21: ingest checks `eventId` and `at` each on its own and never compares the UUID's embedded time with `at`", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const [event] = await foreign(authorN(2), c.now, [{ type: "t", data: {} }]);
      const oldId = uuidv7At(Date.UTC(2020, 0, 1), 0x1234abcd); // an ID minted, by its own account, in 2020
      const farApart = renamed(event as Event, oldId); // under an `at` of 2026
      expect(timestampOf(oldId)).toBe(Date.UTC(2020, 0, 1));
      const outcome = await store.ingest([farApart]);
      expect(outcome).toEqual({ added: 1, duplicates: 0, conflicts: [], rejected: [] });
      expect(await all(store.scan())).toEqual([farApart]);
      // each field is still checked, on its own terms
      const bad = await store.ingest([
        renamed(event as Event, oldId.replace("-7", "-4")), // version 4
        renamed(event as Event, oldId.toUpperCase()), // not canonical
        { ...(event as Event), at: "2026-09-06T10:00:60.000Z" }, // leap second
        { ...(event as Event), at: "2026-09-06T10:00:00.0000Z" }, // four digits
        { ...(event as Event), at: "2026-09-06T10:00:00.000+00:00" }, // an offset
      ]);
      expect(bad).toMatchObject({ added: 0, duplicates: 0, conflicts: [] });
      expect(bad.rejected).toHaveLength(5);
    });

    it("ES-7: an event of this store's own author it does not hold with identical content is a fork — ForkedAuthor, nothing added", async () => {
      const c = clock(T0);
      const mine = await open({ author: authorN(1), now: c.now });
      const own = await mine.append({ type: "t", data: { n: 1 } });
      const [other] = await foreign(authorN(2), c.now, [{ type: "t" }]);
      // a second writable copy under the same author
      const twin = await open({ author: authorN(1), now: c.now });
      const twinOwn = await twin.append({ type: "t", data: { n: 2 } });
      const err = await mine.ingest([other, twinOwn]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForkedAuthor);
      expect((err as ForkedAuthor).author).toBe(authorN(1));
      expect((err as ForkedAuthor).events).toEqual([twinOwn]);
      expect(await all(mine.scan())).toEqual([own]); // not even `other` landed
      // the same content it already holds is no fork; the same ID under other content is
      expect(await mine.ingest([own, reordered(own)])).toMatchObject({ added: 0, duplicates: 2, conflicts: [] });
      await expect(mine.ingest([altered(own)])).rejects.toBeInstanceOf(ForkedAuthor);
      expect(await all(mine.scan())).toEqual([own]);
      // the recovery: a fresh author holds both histories as immutable history
      const successor = await open({ author: authorN(3), now: c.now });
      expect(await successor.ingest([own, twinOwn, other])).toMatchObject({ added: 3 });
    });

    it("ingest reads its whole input before writing: an input that fails midway adds nothing", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const events = await foreign(authorN(2), c.now, [{ type: "t" }, { type: "t" }]);
      async function* failing(): AsyncIterable<unknown> {
        yield events[0];
        throw new Error("transport broke");
      }
      await expect(store.ingest(failing())).rejects.toThrow("transport broke");
      expect(await all(store.scan())).toEqual([]);
      expect(await store.ingest(events)).toMatchObject({ added: 2 });
    });

    it("two ingests racing on one eventId with two contents land as one legal serialization — one content held, every reported conflict names it as kept", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const [a] = await foreign(authorN(2), c.now, [{ type: "t", data: { v: "a" } }]);
      const b = altered(a as Event); // same eventId, other content
      async function* slow(): AsyncIterable<unknown> {
        // an input that completes on its own, taking a few turns: whichever
        // ingest a store serialises first is the store's choice (§10, §13)
        yield a;
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield b;
      }
      const [first, second] = await Promise.all([store.ingest(slow()), store.ingest([b])]);
      const held = await all(store.scan());
      expect(held).toHaveLength(1);
      expect([a, b]).toContainEqual(held[0]);
      expect(first.added + second.added).toBe(1);
      expect(first.rejected).toEqual([]);
      expect(second.rejected).toEqual([]);
      for (const outcome of [first, second]) {
        for (const conflict of outcome.conflicts) {
          expect(conflict.eventId).toBe(a?.eventId);
          expect(conflict.kept).toEqual(held[0]); // a conflict is against what is held, never against what lost
          expect([a, b]).toContainEqual(conflict.rejected);
          expect(conflict.rejected).not.toEqual(held[0]);
        }
      }
      // the two legal outcomes, and nothing else
      const slowFirst = first.added === 1 && first.conflicts.length === 1 && second.conflicts.length === 1 && second.duplicates === 0;
      const fastFirst = second.added === 1 && second.conflicts.length === 0 && first.duplicates === 1 && first.conflicts.length === 1;
      expect(slowFirst || fastFirst).toBe(true);
      expect(held[0]).toEqual(slowFirst ? a : b);
    });

    it("ES-8: shuffling and repartitioning one event set changes no fold, and merge is commutative and idempotent", async () => {
      const c = clock(T0);
      const sources = await Promise.all(
        [2, 3, 4].map(async (n, i) => {
          c.set(`2026-09-06T1${i}:00:00.000Z`);
          const store = await open({ author: authorN(n), now: c.now });
          const events = await store.appendAll([{ type: "a", data: { n } }, { type: "b", data: { n } }, { type: "a", data: { n: n * 10 } }]);
          c.advance(1000);
          return { events: [...events, await store.append({ type: "c", data: { n } })] };
        })
      );
      const everything = sources.flatMap((source) => source.events);
      expect(everything).toHaveLength(12);
      const inOrder = await open({ author: authorN(1), now: c.now });
      expect((await inOrder.ingest(everything)).added).toBe(12);
      const shuffled = await open({ author: authorN(1), now: c.now });
      for (const part of partition(shuffle(everything, 11), [1, 5, 2])) await shuffled.ingest(part);
      const reversed = await open({ author: authorN(1), now: c.now });
      for (const part of partition([...everything].reverse(), [4, 4])) await reversed.ingest(part);
      const expected = fold(everything);
      expect(fold(await all(inOrder.scan()))).toEqual(expected);
      expect(fold(await all(shuffled.scan()))).toEqual(expected);
      expect(fold(await all(reversed.scan()))).toEqual(expected);
      expect(expected.perType).toEqual({ a: 6, b: 3, c: 3 });
      // commutative: two stores holding different halves end up equal whichever ingests the other
      const [left, right] = partition(shuffle(everything, 5), [7, 5]);
      const x = await open({ author: authorN(1), now: c.now });
      const y = await open({ author: authorN(1), now: c.now });
      await x.ingest(left as Event[]);
      await y.ingest(right as Event[]);
      await x.ingest(await all(y.scan()));
      await y.ingest(await all(x.scan()));
      expect(await all(x.scan())).toEqual(await all(y.scan()));
      expect(fold(await all(x.scan()))).toEqual(expected);
      // idempotent: the union again is all duplicates
      expect(await x.ingest(everything)).toEqual({ added: 0, duplicates: 12, conflicts: [], rejected: [] });
    });

    it("ES-11: changes() returns the complete local delta after its token — each event once, the filter applied — and rejects a token it cannot place", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const empty = await store.changes();
      expect(await all(empty.events)).toEqual([]);
      const a = await store.append({ type: "t", data: { n: 1 } });
      const b = await store.append({ type: "u", data: { n: 2 } });
      const first = await store.changes(undefined, empty.token);
      expect(sortedIds(await all(first.events))).toEqual(sortedIds([a, b]));
      const foreignEvents = await foreign(authorN(2), c.now, [{ type: "t" }, { type: "u" }]);
      await store.ingest(foreignEvents);
      const cEvent = await store.append({ type: "t", data: { n: 3 } });
      const second = await store.changes(undefined, first.token);
      expect(sortedIds(await all(second.events))).toEqual(sortedIds([...foreignEvents, cEvent]));
      expect(await all((await store.changes({ type: "t" }, first.token)).events)).toHaveLength(2);
      expect(await all((await store.changes({ author: authorN(1) }, first.token)).events)).toEqual([cEvent]);
      expect(await all((await store.changes(undefined, second.token)).events)).toEqual([]); // nothing since
      const fromStart = await store.changes(undefined, empty.token);
      expect(sortedIds(await all(fromStart.events))).toEqual(sortedIds([a, b, ...foreignEvents, cEvent]));
      // a token of another generation, or no token at all, is refused
      const other = await open({ author: authorN(3), now: c.now });
      await other.append({ type: "t", data: {} });
      const foreignToken = (await other.changes()).token; // a position below this store's count
      await expect(store.changes(undefined, foreignToken)).rejects.toBeInstanceOf(BadToken);
      await expect(other.changes(undefined, second.token)).rejects.toBeInstanceOf(BadToken);
      // the same count of other events is another event set: its token places nowhere here
      const twin = await open({ author: authorN(4), now: c.now });
      await twin.ingest(await foreign(authorN(5), c.now, [{ type: "t" }, { type: "t" }, { type: "t" }, { type: "t" }]));
      await twin.append({ type: "t", data: {} });
      expect(await all(twin.scan())).toHaveLength(5);
      await expect(store.changes(undefined, (await twin.changes()).token)).rejects.toBeInstanceOf(BadToken);
      await expect(twin.changes(undefined, second.token)).rejects.toBeInstanceOf(BadToken);
      for (const junk of ["", "garbage", "{}", "[]", "null"]) {
        await expect(store.changes(undefined, junk), JSON.stringify(junk)).rejects.toBeInstanceOf(BadToken);
      }
    });

    it("ES-12: no token is ever needed — a fold from scan() equals one from changes() without a token, before and after a refused token", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      await store.append({ type: "t", data: { n: 1 } });
      await store.ingest(await foreign(authorN(2), c.now, [{ type: "t" }, { type: "u" }]));
      c.advance(5);
      await store.appendAll([
        { type: "u", data: { n: 2 } },
        { type: "t", data: { n: 3 } },
      ]);
      const whole = await all((await store.changes()).events);
      expect(fold(whole)).toEqual(fold(await all(store.scan())));
      const stale = (await (await open({ author: authorN(3), now: c.now })).changes()).token;
      await expect(store.changes(undefined, stale)).rejects.toBeInstanceOf(BadToken);
      const refolded = fold(await all(store.scan()));
      expect(refolded).toEqual(fold(whole));
      expect(refolded.order).toHaveLength(5);
    });

    it("ES-16: events of a retired replica are immutable history: a successor author ingests them, scans them under the old author, and appends as itself", async () => {
      const c = clock(T0);
      const retired = await open({ author: authorN(1), now: c.now });
      const history = await retired.appendAll([
        { type: "t", data: { n: 1 } },
        { type: "u", data: { n: 2 } },
      ]);
      c.advance(60_000);
      const successor = await open({ author: authorN(2), now: c.now });
      expect(await successor.ingest(history)).toEqual({ added: 2, duplicates: 0, conflicts: [], rejected: [] });
      const own = await successor.append({ type: "t", data: { n: 3 } });
      const canonical = [...history].sort(compareEvents); // one `at`: the order within it is the IDs', not the batch's
      expect(await all(successor.scan())).toEqual([...canonical, own]);
      expect(await all(successor.scan({ author: authorN(1) }))).toEqual(canonical);
      expect(await all(successor.scan({ author: authorN(2) }))).toEqual([own]);
      expect(await successor.ingest(history)).toMatchObject({ added: 0, duplicates: 2 });
      // the retired author's own copy, reopened as it was, still agrees on that history
      expect(await retired.ingest([own])).toMatchObject({ added: 1 });
      expect(await all(retired.scan())).toEqual([...canonical, own]);
    });

    it("damaged() and conflicting() resolve to lists, empty for a store nothing has touched", async () => {
      const store = await open();
      await store.append({ type: "t", data: {} });
      expect(await store.damaged()).toEqual([]);
      expect(await store.conflicting()).toEqual([]);
    });
  });
}

function sortedIds(events: Event[]): string[] {
  return ids(events).sort();
}

/** IDs in canonical order: within one `at`, the IDs' own order, which need not be the order they were minted in (§4.2). */
function sorted(events: Event[]): string[] {
  return ids([...events].sort(compareEvents));
}

/** `value` with every object's members in RFC 8785 order, for comparing spellings. */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((k) => [k, sortedDeep((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}
