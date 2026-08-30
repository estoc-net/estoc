import { describe, expect, it } from "vitest";

import {
  BadToken,
  ForkedSelf,
  InvalidEvent,
  compareEvents,
  isUuidv7,
  type Event,
  type EventStore,
  type Filter,
} from "../../src/index.js";
import { all, altered, clock, eids, reordered, shuffle } from "./helpers.js";

export interface OpenOptions {
  self?: string;
  clock?: () => Date;
}

/** Open a fresh, empty store of the kind under test. */
export type OpenStore = (options?: OpenOptions) => Promise<EventStore>;

/** A fold any store must make the same of: eids in canonical order, and a count per type. */
interface Folded {
  order: string[];
  perType: Record<string, number>;
}

function foldAll(events: Event[]): Folded {
  const sorted = [...events].sort(compareEvents);
  const perType: Record<string, number> = {};
  for (const event of sorted) {
    perType[event.type] = (perType[event.type] ?? 0) + 1;
  }
  return { order: eids(sorted), perType };
}

/**
 * The conformance suite of event-store.md §4: what every EventStore
 * promises, whatever it is made of. `open` gives the suite fresh stores;
 * a store that passes here reads and writes the same set as any other.
 */
export function storeSuite(name: string, open: OpenStore): void {
  /** Events of another device, made honestly: appended by a store that is that device, then read back. */
  async function foreign(self: string, c: () => Date, drafts: { type: string; data?: Record<string, never> | object }[]): Promise<Event[]> {
    const store = await open({ self, clock: c });
    for (const draft of drafts) {
      await store.append({ type: draft.type, data: (draft.data ?? {}) as Record<string, never> });
    }
    return all(store.scan());
  }

  describe(`${name}: EventStore`, () => {
    it("append mints the envelope from the store's clock and hands back the whole event", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "k7q3ma", clock: c.now });
      expect(store.self).toBe("k7q3ma");
      const event = await store.append({ type: "contact.petname", data: { cid: "c1", name: "alice" } });
      expect(isUuidv7(event.eid)).toBe(true);
      expect(event).toEqual({
        eid: event.eid,
        at: "2026-08-30T10:00:00.000Z",
        author: "k7q3ma",
        type: "contact.petname",
        blobs: [],
        data: { cid: "c1", name: "alice" },
      });
      c.advance(1000);
      const later = await store.append({ type: "x", blobs: ["bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"], data: {} });
      expect(later.at).toBe("2026-08-30T10:00:01.000Z");
      expect(later.blobs).toEqual(["bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"]);
      expect(later.eid > event.eid).toBe(true);
      expect(await all(store.scan())).toEqual([event, later]);
    });

    it("append keeps ids monotone when the clock stands still or steps back", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ clock: c.now });
      const first = await store.append({ type: "t", data: {} });
      const same = await store.append({ type: "t", data: {} });
      c.advance(-60_000);
      const back = await store.append({ type: "t", data: {} });
      expect(same.eid > first.eid).toBe(true);
      expect(back.eid > same.eid).toBe(true);
      expect(back.at < first.at).toBe(true); // `at` is the wall clock, and says so
    });

    it("appendAll lands the batch in input order at one instant, ids monotone", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "k7q3ma", clock: c.now });
      const before = await store.append({ type: "t", data: { n: 0 } });
      c.advance(1000);
      const batch = await store.appendAll([
        { type: "contact.deleted", data: { cid: "c1" } },
        { type: "contact.deleted", data: { cid: "c2" } },
        { type: "contact.deleted", data: { cid: "c3" } },
      ]);
      expect(batch.map((event) => event.data.cid)).toEqual(["c1", "c2", "c3"]);
      expect(new Set(batch.map((event) => event.at)).size).toBe(1); // one reading of the clock
      expect(batch.every((event) => event.author === "k7q3ma")).toBe(true);
      const ids = eids(batch);
      expect([...ids].sort()).toEqual(ids); // monotone within the batch
      expect(eids(await all(store.scan()))).toEqual([before.eid, ...ids]);
    });

    it("appendAll of nothing writes nothing", async () => {
      const store = await open();
      expect(await store.appendAll([])).toEqual([]);
      expect(await all(store.scan())).toEqual([]);
    });

    it("appendAll validates every draft before anything lands", async () => {
      const store = await open();
      await expect(store.appendAll([{ type: "t", data: {} }, { type: "", data: {} }])).rejects.toThrow(InvalidEvent);
      expect(await all(store.scan())).toEqual([]);
    });

    it("append stores a copy of the draft, and what it hands out is read-only", async () => {
      const store = await open();
      const draft = { type: "t", data: { list: [1, 2], nested: { a: 1 } }, blobs: [] as string[] };
      const event = await store.append(draft);
      draft.data.list.push(3);
      draft.data.nested.a = 2;
      draft.blobs.push("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
      const [stored] = await all(store.scan());
      expect(stored?.data).toEqual({ list: [1, 2], nested: { a: 1 } });
      expect(stored?.blobs).toEqual([]);
      expect(() => {
        (event as { type: string }).type = "changed";
      }).toThrow();
      expect(() => {
        (event.data as { list: number[] }).list.push(4);
      }).toThrow();
    });

    it("append rejects what cannot become an event", async () => {
      const store = await open();
      const cyclic: Record<string, unknown> = {};
      cyclic["self"] = cyclic;
      const bad: unknown[] = [
        { type: "", data: {} },
        { type: 1, data: {} },
        { data: {} },
        { type: "t" },
        { type: "t", data: [] },
        { type: "t", data: null },
        { type: "t", data: { u: undefined } },
        { type: "t", data: { when: new Date() } },
        { type: "t", data: { n: NaN } },
        { type: "t", data: { n: Infinity } },
        { type: "t", data: { big: 1n } },
        { type: "t", data: cyclic },
        { type: "t", data: {}, blobs: "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq" },
        { type: "t", data: {}, blobs: ["not-a-cid"] },
        { type: "t", data: {}, blobs: ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"] },
      ];
      for (const [i, draft] of bad.entries()) {
        await expect(store.append(draft as never), `draft #${i}`).rejects.toBeInstanceOf(InvalidEvent);
      }
      expect(await all(store.scan())).toEqual([]);
    });

    it("scan yields canonical order whatever order events arrived in", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "aaaaaa", clock: c.now });
      c.set("2026-08-30T12:00:00.000Z");
      const noon = await store.append({ type: "t", data: { n: 1 } });
      c.set("2026-08-30T08:00:00.000Z");
      const morning = await store.append({ type: "t", data: { n: 2 } });
      c.set("2026-08-30T10:00:00.000Z");
      const ten = await store.append({ type: "t", data: { n: 3 } });
      // another device at the same instant as `ten`, with the same eid prefix
      // impossible to arrange; ties within one `at` fall to eid, then author
      const [other] = await foreign("zzzzzz", c.now, [{ type: "t" }]);
      await store.ingest([other]);
      const sorted = await all(store.scan());
      expect(eids(sorted)).toEqual(eids([morning, ten, other as Event, noon].sort(compareEvents)));
      expect(sorted[0]).toEqual(morning);
      expect(sorted[3]).toEqual(noon);
    });

    it("filter is equality on author, type and the top level of data, null included", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "aaaaaa", clock: c.now });
      const a = await store.append({ type: "t", data: { k: "x", n: 1, flag: null, deep: { k: "x" } } });
      const b = await store.append({ type: "t", data: { k: "y", n: 1 } });
      const cEvent = await store.append({ type: "u", data: { k: "x", n: "1" } });
      const [foreignEvent] = await foreign("bbbbbb", c.now, [{ type: "t", data: { k: "x" } }]);
      await store.ingest([foreignEvent]);
      const query = async (filter: Filter): Promise<string[]> => eids(await all(store.scan(filter)));
      expect(await query({})).toHaveLength(4);
      expect(await query({ author: "aaaaaa" })).toEqual(eids([a, b, cEvent]));
      expect(await query({ author: "bbbbbb" })).toEqual([foreignEvent?.eid]);
      expect(await query({ type: "t" })).toEqual(eids([a, b, foreignEvent as Event].sort(compareEvents)));
      expect(await query({ type: "t", data: { k: "x" } })).toEqual(eids([a, foreignEvent as Event].sort(compareEvents)));
      expect(await query({ data: { n: 1 } })).toEqual(eids([a, b]));
      expect(await query({ data: { n: "1" } })).toEqual([cEvent.eid]); // no coercion
      expect(await query({ data: { flag: null } })).toEqual([a.eid]); // present and null
      expect(await query({ data: { missing: null } })).toEqual([]); // absent is not null
      expect(await query({ data: { k: undefined } })).toHaveLength(4); // undefined: no constraint
      expect(await query({ data: { deep: "x" } })).toEqual([]); // nothing below the top level
      expect(await query({ author: "aaaaaa", type: "u", data: { k: "x" } })).toEqual([cEvent.eid]);
    });

    it("ingest unions by eid: added, duplicates, conflicts, rejected", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "aaaaaa", clock: c.now });
      const mine = await store.append({ type: "t", data: { n: 0 } });
      const theirs = await foreign("bbbbbb", c.now, [{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }, { type: "u", data: { n: 3 } }]);
      const [t1, t2, t3] = theirs as [Event, Event, Event];
      const first = await store.ingest([reordered(t1), t2]);
      expect(first).toEqual({ added: 2, duplicates: 0, conflicts: [], rejected: [] });
      // again: duplicates whatever the key order; a conflict keeps what is held; the rest is added
      const second = await store.ingest([reordered(t2), altered(t1), t3, reordered(mine)]);
      expect(second.added).toBe(1);
      expect(second.duplicates).toBe(2);
      expect(second.conflicts).toEqual([{ eid: t1.eid, kept: t1, other: altered(t1) }]);
      expect(second.rejected).toEqual([]);
      expect(await all(store.scan({ author: "bbbbbb" }))).toEqual([t1, t2, t3].sort(compareEvents));
      // the input can disagree with itself: first one in wins, the rest are duplicates or conflicts
      const fresh = await open({ self: "cccccc", clock: c.now });
      const third = await fresh.ingest([t1, reordered(t1), altered(t1)]);
      expect(third).toMatchObject({ added: 1, duplicates: 1 });
      expect(third.conflicts).toEqual([{ eid: t1.eid, kept: t1, other: altered(t1) }]);
      expect(await all(fresh.scan())).toEqual([t1]);
    });

    it("ingest rejects what fails the envelope, one by one, and stores the rest", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "aaaaaa", clock: c.now });
      const [good] = (await foreign("bbbbbb", c.now, [{ type: "t" }])) as [Event];
      const bad: unknown[] = [
        null,
        "string",
        [],
        { ...good, extra: 1 },
        { ...good, eid: "not-a-uuid" },
        { ...good, eid: good.eid.toUpperCase() },
        { ...good, eid: "9c5d3a1e-2f4b-4c6d-8e9f-0a1b2c3d4e5f" }, // v4
        { ...good, at: "2026-08-30T10:00:00+00:00" },
        { ...good, at: "2026-08-30T10:00:00" },
        { ...good, at: "2026-02-30T10:00:00Z" },
        { ...good, at: "Sat, 30 Aug 2026 10:00:00 GMT" },
        { ...good, author: "BBBBBB" },
        { ...good, author: "bbbbb" },
        { ...good, author: "bbbbb1" },
        { ...good, type: "" },
        { ...good, type: 7 },
        (() => {
          const { blobs: _blobs, ...rest } = good;
          return rest;
        })(),
        { ...good, blobs: [null] },
        { ...good, blobs: ["bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi".toUpperCase()] },
        { ...good, data: [] },
        { ...good, data: "x" },
        (() => {
          const { data: _data, ...rest } = good;
          return rest;
        })(),
      ];
      const out = await store.ingest([...bad, good]);
      expect(out.added).toBe(1);
      expect(out.rejected).toHaveLength(bad.length);
      for (const [i, rejected] of out.rejected.entries()) {
        expect(rejected.event).toEqual(bad[i]);
        expect(rejected.error).toEqual(expect.any(String));
      }
      expect(await all(store.scan())).toEqual([good]);
    });

    it("ingest reads everything before writing, and refuses a forked self with nothing written", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "aaaaaa", clock: c.now });
      const mine = await store.append({ type: "t", data: { n: 0 } });
      const theirs = await foreign("bbbbbb", c.now, [{ type: "t" }]);
      // my own event from a backup of this device: a duplicate, no fork
      expect(await store.ingest([reordered(mine)])).toEqual({ added: 0, duplicates: 1, conflicts: [], rejected: [] });
      // an event of "me" I never wrote — another writer shares this device
      const [impostor] = (await foreign("aaaaaa", c.now, [{ type: "t" }])) as [Event];
      const error = await store.ingest([...theirs, impostor]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForkedSelf);
      expect((error as ForkedSelf).self).toBe("aaaaaa");
      expect((error as ForkedSelf).events).toEqual([impostor]);
      expect(await all(store.scan())).toEqual([mine]); // theirs was not written either
      // my own eid with other content is a fork too
      const twisted = await store.ingest([altered(mine)]).catch((e: unknown) => e);
      expect(twisted).toBeInstanceOf(ForkedSelf);
      expect((twisted as ForkedSelf).events).toEqual([altered(mine)]);
      expect(await all(store.scan())).toEqual([mine]);
      // a fork hidden behind another's event under the same eid, earlier in the input, is a fork all the same
      const [shadow] = (await foreign("bbbbbb", c.now, [{ type: "t" }])) as [Event];
      const hidden = { ...shadow, author: "aaaaaa" };
      const behind = await store.ingest([shadow, hidden]).catch((e: unknown) => e);
      expect(behind).toBeInstanceOf(ForkedSelf);
      expect((behind as ForkedSelf).events).toEqual([hidden]);
      expect(await all(store.scan())).toEqual([mine]);
    });

    it("ingest counts an input's two contents under one eid against what is held, in input order", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "aaaaaa", clock: c.now });
      const [theirs] = (await foreign("bbbbbb", c.now, [{ type: "t" }])) as [Event];
      await store.ingest([theirs]);
      // the other content first: a conflict with what is held; then the held content itself: a duplicate, not a second conflict
      expect(await store.ingest([altered(theirs), reordered(theirs)])).toEqual({
        added: 0,
        duplicates: 1,
        conflicts: [{ eid: theirs.eid, kept: theirs, other: altered(theirs) }],
        rejected: [],
      });
      // nothing held: the first content is taken, the second is a conflict with it
      c.advance(1000);
      const [fresh] = (await foreign("cccccc", c.now, [{ type: "t" }])) as [Event];
      expect(await store.ingest([fresh, altered(fresh)])).toEqual({
        added: 1,
        duplicates: 0,
        conflicts: [{ eid: fresh.eid, kept: fresh, other: altered(fresh) }],
        rejected: [],
      });
      expect(await all(store.scan())).toEqual([theirs, fresh]);
    });

    it("changes yields exactly the delta since a token, in whatever order, and nothing falls between", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "aaaaaa", clock: c.now });
      const a = await store.append({ type: "t", data: { n: 1 } });
      const start = await store.changes();
      expect(eids(await all(start.events))).toEqual([a.eid]);
      const b = await store.append({ type: "u", data: { n: 2 } });
      c.set("2026-08-30T09:00:00.000Z"); // earlier `at` than a: arrives later all the same
      const theirs = await foreign("bbbbbb", c.now, [{ type: "t" }, { type: "t" }]);
      await store.ingest(theirs);
      const delta = await store.changes(undefined, start.token);
      const gained = await all(delta.events);
      expect(eids(gained).sort()).toEqual(eids([b, ...theirs]).sort());
      expect(eids(await all((await store.changes(undefined, delta.token)).events))).toEqual([]);
      // a filter applies to the delta
      const typed = await store.changes({ type: "t" }, start.token);
      expect(eids(await all(typed.events)).sort()).toEqual(eids(theirs).sort());
      // a duplicate ingested again is not gained again
      await store.ingest(theirs);
      expect(await all((await store.changes(undefined, delta.token)).events)).toEqual([]);
      // concurrent append: the token is a frontier, so what lands after it is in the next delta and never lost
      const inFlight = store.append({ type: "t", data: { n: 3 } });
      const during = await store.changes(undefined, delta.token);
      const d = await inFlight;
      const seen = await all(during.events);
      const after = await all((await store.changes(undefined, during.token)).events);
      expect(eids([...seen, ...after]).sort()).toEqual([d.eid]);
      expect(seen.length + after.length).toBe(1);
    });

    it("changes rejects a token that is not this instance's, and one it cannot place", async () => {
      const store = await open();
      const other = await open();
      const foreignToken = (await other.changes()).token;
      await expect(store.changes(undefined, foreignToken)).rejects.toBeInstanceOf(BadToken);
      await expect(store.changes(undefined, "garbage")).rejects.toBeInstanceOf(BadToken);
      await expect(store.changes(undefined, "")).rejects.toBeInstanceOf(BadToken);
      const own = (await store.changes()).token;
      await expect(store.changes(undefined, own)).resolves.toBeDefined();
    });

    it("principle 6 at the store: shuffled = same, merge commutes, incremental = full", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const sets = await Promise.all(
        ["aaaaaa", "bbbbbb", "cccccc"].map(async (self) => {
          const store = await open({ self, clock: c.now });
          for (let i = 0; i < 10; i++) {
            c.advance(i % 3 === 0 ? -500 : 700); // a clock that wanders
            await store.append({ type: i % 2 === 0 ? "t" : "u", data: { i } });
          }
          return all(store.scan());
        })
      );
      const everything = sets.flat();
      const expected = foldAll(everything);
      // shuffled = same
      for (const seed of [1, 2, 3, 4, 5]) {
        const store = await open({ self: "dddddd", clock: c.now });
        const out = await store.ingest(shuffle(everything, seed));
        expect(out).toEqual({ added: 30, duplicates: 0, conflicts: [], rejected: [] });
        expect(foldAll(await all(store.scan()))).toEqual(expected);
        expect(eids(await all(store.scan()))).toEqual(expected.order); // scan itself is canonical
      }
      // merge(A, B) = merge(B, A), each side adding its own on top
      const [setA, setB] = sets as [Event[], Event[], Event[]];
      const a = await open({ self: "eeeeee", clock: c.now });
      const b = await open({ self: "ffffff", clock: c.now });
      await a.ingest(setA);
      await b.ingest(setB);
      const ownA = await a.append({ type: "t", data: {} });
      const ownB = await b.append({ type: "u", data: {} });
      await a.ingest([...(await all(b.scan()))]);
      await b.ingest([...(await all(a.scan()))]);
      expect(await all(a.scan())).toEqual(await all(b.scan()));
      expect(eids(await all(a.scan())).sort()).toEqual(eids([...setA, ...setB, ownA, ownB]).sort());
      // incremental = full: fold each delta from `changes`, in whatever order it comes
      const store = await open({ self: "gggggg", clock: c.now });
      let token: string | undefined;
      const folded: Event[] = [];
      for (const batch of [setA.slice(0, 4), setB, setA.slice(4), sets[2] as Event[]]) {
        await store.ingest(shuffle(batch, 9));
        const delta = await store.changes(undefined, token);
        folded.push(...(await all(delta.events)));
        token = delta.token;
      }
      expect(foldAll(folded)).toEqual(expected);
      expect(foldAll(await all(store.scan()))).toEqual(expected);
    });

    it("reports no damage and no conflict in a store that only ever wrote through the interface", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ self: "aaaaaa", clock: c.now });
      await store.append({ type: "t", data: {} });
      await store.ingest(await foreign("bbbbbb", c.now, [{ type: "t" }]));
      expect(store.damaged()).toEqual([]);
      expect(store.conflicting()).toEqual([]);
    });
  });
}
