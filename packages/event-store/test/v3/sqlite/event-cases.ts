/**
 * The SQLite event store on whatever the platform's driver is, as
 * cases free of any test framework: run over `node:sqlite` by
 * `events.test.ts` and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. What the conformance suite cannot see —
 * the bytes a column holds, a runtime reopened, a history damaged
 * under the store — where the two platforms' SQLite must agree.
 */

import { SqliteEventStore, compareEvents, createRuntime, openRuntime, type Draft, type Event, type OpenMode, type SqliteDriver } from "../../../src/v3/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { type Case, assert, assertBytes, assertEqual, assertRejects } from "./driver-cases.js";

export interface EventHarness {
  /** A target no database exists at yet. */
  fresh(): string;
  open(target: string, mode: OpenMode): Promise<SqliteDriver>;
}

export interface EventCase extends Case {
  run(harness: EventHarness): Promise<string | void>;
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function lastSeq(driver: SqliteDriver): unknown {
  const statement = driver.prepare("SELECT last_seq FROM store_state");
  try {
    return statement.get()?.["last_seq"];
  } finally {
    statement.finalize();
  }
}

/** One event of another replica: appended in a runtime of its own, read back. */
async function foreign(h: EventHarness, draft: Draft): Promise<Event> {
  const other = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
  try {
    return await new SqliteEventStore(other).append(draft);
  } finally {
    other.close();
  }
}

async function refusesEveryWrite(store: SqliteEventStore, event: Event, what: string): Promise<void> {
  let published = false;
  await assertRejects(
    () =>
      store.appendAll([{ type: "t", data: {} }], () => {
        published = true;
      }),
    "DamagedHistory",
    `append ${what}`
  );
  assert(!published, `publish did not run ${what}`);
  await assertRejects(() => store.ingest([event]), "DamagedHistory", `ingest ${what}`);
}

export const eventCases: EventCase[] = [
  {
    name: "a type holding a NUL is stored as itself, filtered by equality, read back after a reopen, and is not damage",
    run: async (h) => {
      const target = h.fresh();
      const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteEventStore(db);
      const type = "a\u0000b";
      const own = await store.append({ type, data: { s: "\u0000" } });
      const other = await foreign(h, { type, data: {} });
      assertEqual((await store.ingest([other])).added, 1, "the foreign event is added");
      const both = [own, other].sort(compareEvents);
      assertEqual(await collect(store.scan({ type })), both, "scan by the type");
      assertEqual(await collect(store.scan({ type: "a" })), [], "a prefix of it matches nothing");
      assertEqual(await collect(store.scan({ type: "a\u0000" })), [], "nor a longer prefix");
      assertEqual(await collect(store.scan({ author: other.author, type })), [other], "with the author");
      assertEqual((await collect((await store.changes({ type })).events)).length, 2, "the delta by the type");
      const stored = db.driver.prepare("SELECT CAST(type AS BLOB) AS type FROM events ORDER BY event_id");
      try {
        for (const row of stored.all()) assertBytes(row["type"] as Uint8Array, new TextEncoder().encode(type), "the stored column");
      } finally {
        stored.finalize();
      }
      assertEqual(await store.damaged(), [], "no damage");
      db.close();
      const again = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        const reopened = new SqliteEventStore(again);
        assertEqual(await collect(reopened.scan({ type })), both, "after a reopen");
        assertEqual(await reopened.damaged(), [], "no damage after a reopen");
        assertEqual((await reopened.append({ type, data: {} })).type, type, "and another is appended");
      } finally {
        again.close();
      }
    },
  },
  {
    name: "damage a read has met stops every write, publish included; a reopen finds it before its first write; reads go on",
    run: async (h) => {
      const target = h.fresh();
      const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteEventStore(db);
      const [broken, sound] = await store.appendAll([
        { type: "t", data: { n: 1 } },
        { type: "t", data: { n: 2 } },
      ]);
      const other = await foreign(h, { type: "f", data: {} });
      const corrupt = db.driver.prepare("UPDATE events SET canonical = ? WHERE event_id = ?");
      try {
        corrupt.run(new TextEncoder().encode("{}"), broken?.eventId as string);
      } finally {
        corrupt.finalize();
      }
      assertEqual((await store.damaged()).map((d) => d.where), [`events/${broken?.eventId as string}`], "the damage is placed");
      await refusesEveryWrite(store, other, "once the damage is known");
      assertEqual(lastSeq(db.driver), 2, "last_seq");
      assertEqual(await collect(store.scan()), [sound], "the sound event still reads");
      assertEqual(db.driver.inTransaction, false, "no transaction left open");
      db.close();
      const again = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        const reopened = new SqliteEventStore(again);
        await refusesEveryWrite(reopened, other, "after a reopen, before any read");
        assertEqual(lastSeq(again.driver), 2, "last_seq after the reopen");
        assertEqual(await collect(reopened.scan()), [sound], "the sound event still reads after the reopen");
        assertEqual((await reopened.damaged()).length, 1, "the damage is still listed");
      } finally {
        again.close();
      }
    },
  },
  {
    name: "a batch with a hole is refused whole before anything is minted, and the runtime reopens as it was",
    run: async (h) => {
      const target = h.fresh();
      const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteEventStore(db);
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
        let published = false;
        await assertRejects(
          () =>
            store.appendAll(batch, () => {
              published = true;
            }),
          "InvalidEvent",
          `batch #${i}`
        );
        assert(!published, `batch #${i} published nothing`);
      }
      assertEqual(lastSeq(db.driver), 1, "last_seq");
      assertEqual((await store.changes()).token, token, "the token");
      db.close();
      const again = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        const reopened = new SqliteEventStore(again);
        assertEqual(await collect(reopened.scan()), [held], "what the reopen finds");
        assertEqual((await reopened.appendAll([{ type: "t", data: {} }])).length, 1, "and it accepts a batch");
        assertEqual(lastSeq(again.driver), 2, "last_seq after it");
      } finally {
        again.close();
      }
    },
  },
];
