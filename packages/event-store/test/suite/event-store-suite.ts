import { describe, expect, it } from "vitest";

import {
  BadToken,
  ForkedAuthor,
  InvalidEvent,
  canonicalEventBytes,
  canonicalEventText,
  compareCids,
  compareEvents,
  envelopeOf,
  eventCidOf,
  isEventCid,
  matches,
  type AuthorId,
  type Cid,
  type Draft,
  type Event,
  type EventCid,
  type EventStore,
  type Filter,
} from "../../src/index.js";
import { all, altered, authorN, clock, eventOf, ids, mislabelled, partition, reordered, shuffle, uuidv7At } from "./helpers.js";

export interface OpenOptions {
  author?: AuthorId;
  /** the wall clock in Unix milliseconds */
  now?: () => number;
}

/** Open a fresh, empty store of the kind under test, as its own generation. */
export type OpenStore = (options?: OpenOptions) => Promise<EventStore>;

const RAW_HELLO = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq" as Cid;
const T0 = "2026-09-06T10:00:00.000Z";

/** The specification's worked example: this envelope, appended by this author at this instant, has this CID. */
const EXAMPLE = {
  author: "019b0000-0000-7000-8000-000000000001" as AuthorId,
  at: "2026-09-25T00:00:00.000Z",
  draft: { type: "example.note", data: { text: "hello" } },
  cid: "bafkreigwmldn6qzody7iex3vwompw3zkdqihb5jzbpp3npvdod6rdnt5zi",
};

/** A fold any store must make the same of: CIDs in canonical order, a count per type and per author. */
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
 * The conformance suite over one `EventStore`, whatever it is made of:
 * what a store in memory and a database must both agree on.
 * `open` gives the suite fresh stores, each its own generation.
 * Durability across a process restart is a backend's to show with its
 * own tests.
 */
export function eventStoreSuite(name: string, open: OpenStore): void {
  /** Events of another replica, made honestly: appended by a store that is that author, then read back. Drafts with equal content are one event. */
  async function foreign(author: AuthorId, now: () => number, drafts: { type: string; data?: object }[]): Promise<Event[]> {
    const store = await open({ author, now });
    return store.appendAll(drafts.map((draft) => ({ type: draft.type, data: (draft.data ?? {}) as Record<string, never> })));
  }

  describe(`${name}: EventStore`, () => {
    it("append fills the five-field envelope — `at` from the store's clock, `author` the store's own — and hands it back with the CID its canonical bytes hash to", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      expect(store.author).toBe(authorN(1));
      const event = await store.append({ type: "contact.labeled", data: { contact: "c1", label: "alice" } });
      expect(isEventCid(event.cid)).toBe(true);
      expect(event).toEqual({
        cid: eventCidOf(event),
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

    it("the specification's example envelope hashes to its published CID", async () => {
      const c = clock(EXAMPLE.at);
      const store = await open({ author: EXAMPLE.author, now: c.now });
      const event = await store.append(EXAMPLE.draft);
      expect(event.cid).toBe(EXAMPLE.cid);
      expect(new TextDecoder().decode(canonicalEventBytes(event))).toBe('{"at":"2026-09-25T00:00:00.000Z","author":"019b0000-0000-7000-8000-000000000001","data":{"text":"hello"},"roots":[],"type":"example.note"}');
      expect(await all(store.scan({ cid: EXAMPLE.cid as EventCid }))).toEqual([event]);
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

    it("a draft that cannot become an event, or a clock that cannot be read, fails the append or the whole batch before anything lands", async () => {
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
        { type: "t", data: {}, extra: 1 },
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

    it("a draft carrying cid, at or author is refused — never re-derived as a second event — and the whole batch with it", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const held = await store.append({ type: "t", data: { n: 1 } });
      const carrying: unknown[] = [
        held, // an event handed back as a draft
        { type: "t", data: {}, cid: held.cid },
        { type: "t", data: {}, at: T0 },
        { type: "t", data: {}, author: authorN(1) },
        { type: "t", data: {}, author: authorN(2) },
        { type: "t", data: {}, cid: "supplied-by-caller" },
      ];
      for (const [i, draft] of carrying.entries()) {
        await expect(store.append(draft as never), `draft #${i}`).rejects.toBeInstanceOf(InvalidEvent);
        await expect(store.appendAll([{ type: "t", data: {} }, draft as never]), `batch with draft #${i}`).rejects.toBeInstanceOf(InvalidEvent);
      }
      expect(await all(store.scan())).toEqual([held]);
    });

    it("a batch with a hole — a sparse array — is refused whole, as a draft that is not an object, and the store is as it was", async () => {
      const store = await open();
      const held = await store.append({ type: "t", data: {} });
      const { token } = await store.changes();
      const trailing: Draft[] = [{ type: "t", data: {} }];
      trailing.length = 2;
      const leading: Draft[] = [];
      leading[1] = { type: "t", data: {} };
      const middle: Draft[] = [{ type: "t", data: {} }, { type: "t", data: {} }, { type: "t", data: {} }];
      Reflect.deleteProperty(middle, 1);
      const holes = new Array<Draft>(2);
      for (const [i, batch] of [trailing, leading, middle, holes].entries()) {
        await expect(store.appendAll(batch), `batch #${i}`).rejects.toBeInstanceOf(InvalidEvent);
      }
      expect(await all(store.scan())).toEqual([held]);
      expect((await store.changes()).token).toBe(token);
    });

    it("a type or a string value holding a NUL is stored, filtered and handed back as it is; a filter no event can equal matches nothing", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const type = "a\u0000b";
      const own = await store.append({ type, data: { s: "\u0000" } });
      const replacement = await store.append({ type: "�", data: {} });
      const [other] = await foreign(authorN(2), c.now, [{ type, data: {} }]);
      expect((await store.ingest([other])).added).toBe(1);
      expect(await all(store.scan({ type }))).toEqual([own, other as Event].sort(compareEvents));
      expect(await all(store.scan({ type: "a" }))).toEqual([]);
      expect(await all(store.scan({ type: "a\u0000" }))).toEqual([]);
      expect(await all(store.scan({ data: { s: "\u0000" } }))).toEqual([own]);
      expect(await all(store.scan({ author: authorN(2), type }))).toEqual([other]);
      expect(await all((await store.changes({ type })).events)).toHaveLength(2);
      expect(await all(store.scan({ type: "�" }))).toEqual([replacement]);
      expect(await all(store.scan({ type: "\uD800" })), "an unpaired surrogate is in no event, and is not the replacement character").toEqual([]);
      expect(await all(store.scan({ author: "\uD800" as AuthorId }))).toEqual([]);
      expect(await store.damaged()).toEqual([]);
    });

    it("one appendAll of 5000 distinct drafts in one millisecond — one `at`, 5000 distinct CIDs, input order back", async () => {
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
        expect(isEventCid(event.cid)).toBe(true);
        expect(event.author).toBe(authorN(1));
      }
      const scanned = await all(store.scan());
      expect(scanned).toHaveLength(5001);
      expect(scanned[0]).toEqual(before);
      expect(ids(scanned.slice(1))).toEqual(ids([...batch].sort(compareEvents)));
      expect(await all(store.scan({ type: "even" }))).toHaveLength(2500);
    });

    it("equal envelopes are one event: a draft repeated in a batch, or appended again at the same instant, comes back with the same CID, held once, under one position", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const batch = await store.appendAll([
        { type: "t", data: { n: 1 } },
        { type: "t", data: { n: 2 } },
        { type: "t", data: { n: 1 } },
        { data: { n: 1 }, type: "t" },
      ]);
      expect(batch).toHaveLength(4);
      expect(batch[0]).toEqual(batch[2]);
      expect(batch[0]).toEqual(batch[3]);
      expect(batch[0]).not.toEqual(batch[1]);
      expect(await all(store.scan())).toEqual([batch[0] as Event, batch[1] as Event].sort(compareEvents));
      const { token } = await store.changes();
      expect(await all((await store.changes()).events)).toHaveLength(2);
      const again = await store.append({ type: "t", data: { n: 1 } });
      expect(again).toEqual(batch[0]);
      expect(await store.appendAll([{ type: "t", data: { n: 2 } }, { type: "t", data: { n: 2 } }])).toEqual([batch[1], batch[1]]);
      expect((await store.changes()).token, "a duplicate-only write allocates no position").toBe(token);
      expect(await all((await store.changes(undefined, token)).events)).toEqual([]);
      expect((await store.tally()).events).toBe(2);
      c.advance(1);
      const later = await store.append({ type: "t", data: { n: 1 } });
      expect(later.cid).not.toBe(batch[0]?.cid); // another `at` is another envelope
      expect((await store.tally()).events).toBe(3);
    });

    it("appendAll of nothing writes nothing", async () => {
      const store = await open();
      expect(await store.appendAll([])).toEqual([]);
      expect(await all(store.scan())).toEqual([]);
    });

    it("after the clock rolls back `at` follows it and a batch shares one `at`; a draft that recreates a held envelope is that event again", async () => {
      const c = clock(T0);
      const store = await open({ now: c.now });
      const first = await store.append({ type: "t", data: {} });
      c.advance(-60_000);
      const back = await store.append({ type: "t", data: {} });
      const batch = await store.appendAll([
        { type: "t", data: { n: 1 } },
        { type: "t", data: { n: 2 } },
      ]);
      expect(back.at).toBe("2026-09-06T09:59:00.000Z");
      expect(back.at < first.at).toBe(true); // `at` is the wall clock, and says so
      expect(new Set(ids([first, back, ...batch])).size).toBe(4);
      expect(new Set(batch.map((event) => event.at))).toEqual(new Set([back.at]));
      expect(ids(await all(store.scan()))).toEqual(ids([first, back, ...batch].sort(compareEvents)));
      c.advance(60_000);
      expect(await store.append({ type: "t", data: {} })).toEqual(first);
      expect((await store.tally()).events).toBe(4);
    });

    it("scan yields canonical order — (at, cid), the CID as text — whatever order events were written in", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      c.set("2026-09-06T12:00:00.000Z");
      const noon = await store.append({ type: "t", data: { n: 1 } });
      c.set("2026-09-06T08:00:00.000Z");
      const morning = await store.append({ type: "t", data: { n: 2 } });
      c.set(T0);
      const ten = await store.append({ type: "t", data: { n: 3 } });
      // another replica at the same instant as `ten`; ties within one `at` fall to the CID
      const [other] = await foreign(authorN(2), c.now, [{ type: "t" }]);
      await store.ingest([other]);
      const expected = [morning, ten, other as Event, noon].sort(compareEvents);
      expect(await all(store.scan())).toEqual(expected);
      expect(ids(expected)[0]).toBe(morning.cid);
      expect(ids(expected)[3]).toBe(noon.cid);
      // and a store given the same set in another order scans the same
      const again = await open({ author: authorN(3), now: c.now });
      await again.ingest(shuffle([noon, morning, ten, other as Event], 7));
      expect(await all(again.scan())).toEqual(expected);
    });

    it("within one `at`, the order is the CID text's, which is not the decoded bytes' order", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const batch = await store.appendAll(Array.from({ length: 64 }, (_, n) => ({ type: "t", data: { n } })));
      const byText = [...batch].sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
      const byBytes = [...batch].sort((a, b) => compareCids(a.cid as unknown as Cid, b.cid as unknown as Cid));
      expect(ids(byText), "base32 spells the values 26–31 with digits, which ASCII puts before the letters").not.toEqual(ids(byBytes));
      expect(ids(await all(store.scan()))).toEqual(ids(byText));
    });

    it("scan's filter is equality on cid, author, type and the top level of data, null included, nothing coerced", async () => {
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
      expect(await query({ author: authorN(2) })).toEqual([foreignEvent?.cid]);
      expect(await query({ type: "t" })).toEqual(sorted([a, b, foreignEvent as Event]));
      expect(await query({ type: "t", data: { k: "x" } })).toEqual(sorted([a, foreignEvent as Event]));
      expect(await query({ data: { n: 1 } })).toEqual(sorted([a, b]));
      expect(await query({ data: { n: "1" } })).toEqual([cEvent.cid]); // no coercion
      expect(await query({ data: { flag: null } })).toEqual([a.cid]); // present and null
      expect(await query({ data: { missing: null } })).toEqual([]); // absent is not null
      expect(await query({ data: { k: undefined } })).toHaveLength(4); // undefined: no constraint
      expect(await query({ data: { deep: "x" } })).toEqual([]); // an object never equals a primitive
      expect(await query({ author: authorN(9) })).toEqual([]);
      expect(await query({ cid: b.cid })).toEqual([b.cid]);
      expect(await query({ cid: b.cid, type: "t", data: { n: 1 } })).toEqual([b.cid]);
      expect(await query({ cid: b.cid, type: "u" }), "a CID conjoins with the other filters").toEqual([]);
      expect(await query({ cid: b.cid, author: authorN(2) })).toEqual([]);
      expect(await query({ cid: altered(b).cid }), "a CID no event has").toEqual([]);
      expect(await query({ cid: RAW_HELLO as unknown as EventCid }), "a raw CID of other bytes names no event").toEqual([]);
      for (const junk of ["", b.cid.toUpperCase(), "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", authorN(1)]) {
        await expect(all(store.scan({ cid: junk as EventCid })), JSON.stringify(junk)).rejects.toBeInstanceOf(InvalidEvent);
        await expect(store.changes({ cid: junk as EventCid }), JSON.stringify(junk)).rejects.toBeInstanceOf(InvalidEvent);
      }
      expect(await all((await store.changes({ cid: cEvent.cid })).events)).toEqual([cEvent]);
      for (const event of await all(store.scan({ type: "t", data: { k: "x" } }))) {
        expect(matches(event, { type: "t", data: { k: "x" } })).toBe(true);
      }
    });

    it("ingest counts each of its three outcomes — added, duplicate under another serialization, rejected — and stores only the added", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const [one, two, three] = await foreign(authorN(2), c.now, [{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }, { type: "t", data: { n: 3 } }]);
      expect(await store.ingest([one, two])).toEqual({ added: 2, duplicates: 0, rejected: [] });
      const outcome = await store.ingest([
        reordered(one as Event), // same event, other member order and whitespace
        altered(two as Event), // other content: another event, under its own CID
        three, // new
        three, // and again within one input
        null, // not an event at all
        { ...three, extra: 1 },
        { ...(three as Event), at: "2026-09-06T10:00:00Z" },
        { ...(three as Event), cid: "not-a-cid" },
        mislabelled(altered(three as Event), (three as Event).cid), // other bytes under a CID that is held: refused, not a duplicate
      ]);
      expect(outcome.added).toBe(2);
      expect(outcome.duplicates).toBe(2);
      expect(outcome.rejected).toHaveLength(5);
      expect(outcome.rejected.map((r) => r.value)).toEqual([null, { ...three, extra: 1 }, { ...three, at: "2026-09-06T10:00:00Z" }, { ...three, cid: "not-a-cid" }, mislabelled(altered(three as Event), (three as Event).cid)]);
      for (const r of outcome.rejected) expect(r.error).toBeTypeOf("string");
      expect(await all(store.scan())).toEqual(([one, two, altered(two as Event), three] as Event[]).sort(compareEvents));
      // the same envelope twice inside one input, neither held: once added, once a duplicate
      const fresh = await open({ author: authorN(3), now: c.now });
      const [four] = await foreign(authorN(2), c.now, [{ type: "t", data: { n: 4 } }]);
      expect(await fresh.ingest([four, reordered(four as Event)])).toEqual({ added: 1, duplicates: 1, rejected: [] });
      expect(await all(fresh.scan())).toEqual([four]);
    });

    it("tally counts the rows held and sums their canonical bytes, multi-byte text by its UTF-8, and moves only when an event is accepted: not on a duplicate, a rejected input or a batch refused as a fork", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      expect(await store.tally()).toEqual({ events: 0, bytes: 0 });
      const weight = (events: Event[]) => events.reduce((n, e) => n + canonicalEventBytes(e).length, 0);
      const mine = await store.append({ type: "t", data: { text: "€😂" } });
      expect(canonicalEventBytes(mine).length).toBeGreaterThan(JSON.stringify(envelopeOf(mine)).length);
      const [one, two] = (await foreign(authorN(2), c.now, [{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }])) as Event[];
      await store.ingest([one]);
      const held = { events: 2, bytes: weight([mine, one as Event]) };
      expect(await store.tally()).toEqual(held);
      const outcome = await store.ingest([reordered(one as Event), mislabelled(altered(one as Event), (one as Event).cid), null]);
      expect([outcome.duplicates, outcome.rejected.length]).toEqual([1, 2]);
      expect(await store.tally()).toEqual(held);
      await expect(store.ingest([two, altered(mine)])).rejects.toBeInstanceOf(ForkedAuthor);
      expect(await store.tally()).toEqual(held);
      expect(await store.ingest([two])).toMatchObject({ added: 1 });
      expect(await store.tally()).toEqual({ events: 3, bytes: weight([mine, one as Event, two as Event]) });
    });

    it("what ingest hands back later is the event its canonical bytes parse to, whatever serialization arrived", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const [event] = await foreign(authorN(2), c.now, [{ type: "t", data: { z: 1, a: [1, { y: 2, x: 3 }] } }]);
      await store.ingest([reordered(event as Event)]);
      const [held] = await all(store.scan());
      expect(held).toEqual(event);
      expect(JSON.stringify(held)).toBe(JSON.stringify(event));
      expect(canonicalEventText(held as Event)).toBe(JSON.stringify(sortedDeep(envelopeOf(event as Event))));
    });

    it("a local append is held, returned and scanned in the form its canonical bytes parse to — `-0` as 0, members in canonical order, the CID last — the same as its ingest elsewhere", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const draft = { type: "t", data: { z: -0, a: 1, nested: { y: [2, { q: 1, p: 2 }], x: 1 } } };
      const returned = await store.append(draft);
      expect(Object.is(returned.data["z"], 0)).toBe(true);
      expect(Object.keys(returned.data)).toEqual(["a", "nested", "z"]);
      expect(Object.keys(returned)).toEqual(["at", "author", "data", "roots", "type", "cid"]);
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

    it("data carrying a toJSON or an accessor that answers differently later is held as the members it had when read, and the store goes on validating, scanning and appending", async () => {
      const c = clock(T0);
      const [event] = await foreign(authorN(2), c.now, [{ type: "t", data: { kept: true } }]);
      const hooked = { ...(event as Event), data: Object.defineProperty({ kept: true }, "toJSON", { value: () => [] }) };
      let reads = 0;
      const shifting = {
        type: "t",
        data: {
          get x(): string {
            return ++reads === 1 ? "ok" : (undefined as unknown as string);
          },
        },
      };

      const store = await open({ author: authorN(1), now: c.now });
      expect((await store.ingest([hooked])).added).toBe(1);
      const appended = await store.append(shifting);
      expect(appended.data).toEqual({ x: "ok" });
      expect(await all(store.scan())).toEqual([event, appended]);
      expect(await store.damaged()).toEqual([]);
      await store.append({ type: "t", data: {} });
      expect((await store.tally()).events).toBe(3);
    });

    it("an event whose roots array has an iterator of its own is held with the roots it has by index, and its canonical bytes arriving again are a duplicate", async () => {
      const c = clock(T0);
      const [minted] = await foreign(authorN(2), c.now, [{ type: "t" }]);
      const event = eventOf({ ...envelopeOf(minted as Event), roots: [RAW_HELLO] });
      const silent = { ...event, roots: Object.defineProperty([RAW_HELLO], Symbol.iterator, { value: function* () {} }) };
      const store = await open({ author: authorN(1), now: c.now });
      expect((await store.ingest([silent])).added).toBe(1);
      expect(await all(store.scan())).toEqual([event]);
      expect((await store.ingest([{ ...JSON.parse(new TextDecoder().decode(canonicalEventBytes(silent))), cid: event.cid }])).duplicates).toBe(1);
      const hollow = { ...silent, roots: Object.defineProperty([undefined], Symbol.iterator, { value: function* () {} }) };
      expect((await store.ingest([hollow])).rejected).toHaveLength(1);
      expect((await store.tally()).events).toBe(1);
    });

    it("ingest checks the CID and `at` each on its own: a CID spelled otherwise or of other bytes is refused, and the author's UUID time is never compared with `at`", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const oldAuthor = uuidv7At(Date.UTC(2020, 0, 1), 0x1234abcd) as AuthorId; // a replica ID minted, by its own account, in 2020
      const [event] = await foreign(oldAuthor, c.now, [{ type: "t", data: {} }]); // under an `at` of 2026
      const outcome = await store.ingest([event]);
      expect(outcome).toEqual({ added: 1, duplicates: 0, rejected: [] });
      expect(await all(store.scan())).toEqual([event]);
      // each field is still checked, on its own terms
      const other = altered(event as Event);
      const bad = await store.ingest([
        mislabelled(other, (event as Event).cid), // the bytes of `other` under a CID that is held
        mislabelled(event as Event, other.cid), // the held bytes under a CID that is not
        { ...(event as Event), cid: (event as Event).cid.toUpperCase() }, // not canonical
        { ...(event as Event), cid: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" }, // a drisl CID
        { ...(event as Event), cid: RAW_HELLO }, // a raw CID of other bytes
        { ...(event as Event), at: "2026-09-06T10:00:60.000Z" }, // leap second
        { ...(event as Event), at: "2026-09-06T10:00:00.0000Z" }, // four digits
        { ...(event as Event), at: "2026-09-06T10:00:00.000+00:00" }, // an offset
        { ...(event as Event), author: oldAuthor.toUpperCase() },
      ]);
      expect(bad).toMatchObject({ added: 0, duplicates: 0 });
      expect(bad.rejected).toHaveLength(9);
      expect(await all(store.scan())).toEqual([event]);
    });

    it("an event of this store's own author it does not hold is a fork — ForkedAuthor, nothing added", async () => {
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
      // the same envelope it already holds is no fork; another envelope under its author is
      expect(await mine.ingest([own, reordered(own)])).toMatchObject({ added: 0, duplicates: 2 });
      await expect(mine.ingest([altered(own)])).rejects.toBeInstanceOf(ForkedAuthor);
      expect(await all(mine.scan())).toEqual([own]);
      // the recovery: a fresh author holds both histories as immutable history
      const successor = await open({ author: authorN(3), now: c.now });
      expect(await successor.ingest([own, twinOwn, other])).toMatchObject({ added: 3 });
    });

    it("ingest reads its whole input before writing: an input that fails midway adds nothing", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const events = await foreign(authorN(2), c.now, [{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }]);
      async function* failing(): AsyncIterable<unknown> {
        yield events[0];
        throw new Error("transport broke");
      }
      await expect(store.ingest(failing())).rejects.toThrow("transport broke");
      expect(await all(store.scan())).toEqual([]);
      expect(await store.ingest(events)).toMatchObject({ added: 2 });
    });

    it("two ingests racing on one event land it once: one adds it, the other finds it a duplicate", async () => {
      const c = clock(T0);
      const store = await open({ author: authorN(1), now: c.now });
      const [a] = await foreign(authorN(2), c.now, [{ type: "t", data: { v: "a" } }]);
      async function* slow(): AsyncIterable<unknown> {
        // an input that completes on its own, taking a few turns: whichever
        // ingest a store serialises first is the store's choice
        yield reordered(a as Event);
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield a;
      }
      const [first, second] = await Promise.all([store.ingest(slow()), store.ingest([a])]);
      expect(await all(store.scan())).toEqual([a]);
      expect(first.rejected).toEqual([]);
      expect(second.rejected).toEqual([]);
      expect(first.added + second.added).toBe(1);
      expect(first.duplicates + second.duplicates).toBe(2);
      expect((await store.tally()).events).toBe(1);
    });

    it("shuffling and repartitioning one event set changes no fold, and merge is commutative and idempotent", async () => {
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
      expect(await x.ingest(everything)).toEqual({ added: 0, duplicates: 12, rejected: [] });
    });

    it("changes() returns the complete local delta after its token — each new CID once, the filter applied — and rejects a token it cannot place", async () => {
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
      // a duplicate — ingested again, or appended again as the same envelope — allocates no position and moves no frontier
      expect(await store.ingest(foreignEvents)).toMatchObject({ added: 0, duplicates: 2 });
      expect(await store.append({ type: "t", data: { n: 3 } })).toEqual(cEvent);
      expect((await store.changes()).token).toBe(second.token);
      expect(await all((await store.changes({ cid: a.cid }, second.token)).events), "a CID outside the interval matches nothing").toEqual([]);
      const fromStart = await store.changes(undefined, empty.token);
      expect(sortedIds(await all(fromStart.events))).toEqual(sortedIds([a, b, ...foreignEvents, cEvent]));
      expect(await all((await store.changes({ cid: a.cid }, empty.token)).events)).toEqual([a]);
      // a token of another generation, or no token at all, is refused
      const other = await open({ author: authorN(3), now: c.now });
      await other.append({ type: "t", data: {} });
      const foreignToken = (await other.changes()).token; // a position below this store's count
      await expect(store.changes(undefined, foreignToken)).rejects.toBeInstanceOf(BadToken);
      await expect(other.changes(undefined, second.token)).rejects.toBeInstanceOf(BadToken);
      // the same count of other events is another event set: its token places nowhere here
      const twin = await open({ author: authorN(4), now: c.now });
      await twin.ingest(await foreign(authorN(5), c.now, [{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }, { type: "t", data: { n: 3 } }, { type: "t", data: { n: 4 } }]));
      await twin.append({ type: "t", data: {} });
      expect(await all(twin.scan())).toHaveLength(5);
      await expect(store.changes(undefined, (await twin.changes()).token)).rejects.toBeInstanceOf(BadToken);
      await expect(twin.changes(undefined, second.token)).rejects.toBeInstanceOf(BadToken);
      for (const junk of ["", "garbage", "{}", "[]", "null"]) {
        await expect(store.changes(undefined, junk), JSON.stringify(junk)).rejects.toBeInstanceOf(BadToken);
      }
    });

    it("no token is ever needed — a fold from scan() equals one from changes() without a token, before and after a refused token", async () => {
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

    it("events of a retired replica are immutable history: a successor author ingests them, scans them under the old author, and appends as itself", async () => {
      const c = clock(T0);
      const retired = await open({ author: authorN(1), now: c.now });
      const history = await retired.appendAll([
        { type: "t", data: { n: 1 } },
        { type: "u", data: { n: 2 } },
      ]);
      c.advance(60_000);
      const successor = await open({ author: authorN(2), now: c.now });
      expect(await successor.ingest(history)).toEqual({ added: 2, duplicates: 0, rejected: [] });
      const own = await successor.append({ type: "t", data: { n: 3 } });
      const canonical = [...history].sort(compareEvents); // one `at`: the order within it is the CIDs', not the batch's
      expect(await all(successor.scan())).toEqual([...canonical, own]);
      expect(await all(successor.scan({ author: authorN(1) }))).toEqual(canonical);
      expect(await all(successor.scan({ author: authorN(2) }))).toEqual([own]);
      expect(await successor.ingest(history)).toMatchObject({ added: 0, duplicates: 2 });
      // the retired author's own copy, reopened as it was, still agrees on that history
      expect(await retired.ingest([own])).toMatchObject({ added: 1 });
      expect(await all(retired.scan())).toEqual([...canonical, own]);
    });

    it("damaged() resolves to a list, empty for a store nothing has touched", async () => {
      const store = await open();
      await store.append({ type: "t", data: {} });
      expect(await store.damaged()).toEqual([]);
    });
  });
}

function sortedIds(events: Event[]): string[] {
  return ids(events).sort();
}

/** CIDs in canonical order: within one `at`, the CIDs' own text order, which is not the order the drafts were given in. */
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
