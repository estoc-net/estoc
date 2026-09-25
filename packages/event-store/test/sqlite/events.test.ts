/**
 * The SQLite event store over `node:sqlite`: the conformance suite in
 * memory and on files, and what only a database can show — the rows
 * an append leaves, positions and the token that names them, a reopen
 * finding what was accepted and refusing the rest, damage told apart
 * from history, an inspector's refusals, another process's crash.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "../../src/node.js";
import {
  BadToken,
  DamagedControl,
  DamagedHistory,
  ForkedAuthor,
  ReadOnlyVault,
  SqliteEventStore,
  canonicalEventBytes,
  createRuntime,
  openInspector,
  openRuntime,
  type Cid,
  type Event,
  type OpenMode,
  type RuntimeDatabase,
  type SqliteDriver,
  type SqlValue,
} from "../../src/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { eventStoreSuite, type OpenOptions } from "../suite/event-store-suite.js";
import { all, altered, authorN, clock, expectBytes, mislabelled, reordered } from "../suite/helpers.js";
import { eventCases } from "./event-cases.js";
import { eventStoreOpener } from "./suite-openers.js";

const T0 = "2026-09-12T10:00:00.000Z";
const RAW_HELLO = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq" as Cid;

/** `events` in canonical order, for sets whose `at` is one instant: the CIDs' text order. */
const byCid = (events: Event[]): Event[] => [...events].sort((a, b) => (a.cid < b.cid ? -1 : 1));

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-events-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (target: string, mode: OpenMode): SqliteDriver => openNodeSqlite(target, { mode });

interface Made {
  db: RuntimeDatabase;
  store: SqliteEventStore;
}

/** A runtime created at `target`, and the store over it; the author pinned to `options.author` when given, as a test names its replicas. */
function create(target: string, options: OpenOptions = {}): Made {
  const db = createRuntime(open(target, "create"), { metadata: META, wrapped: WRAPPED });
  const author = options.author ?? db.author;
  if (author !== db.author) exec(db.driver, "UPDATE store_state SET replica_id = ?", author);
  const store = new SqliteEventStore({ driver: db.driver, author, generation: db.generation, writable: true }, options.now === undefined ? {} : { now: options.now });
  return { db, store };
}

async function reopen(target: string, now?: () => number): Promise<Made> {
  const db = await openRuntime(open(target, "readwrite"), { anchor: ANCHOR });
  return { db, store: new SqliteEventStore(db, now === undefined ? {} : { now }) };
}

function inspect(target: string): Made {
  const db = openInspector(open(target, "readwrite"));
  return { db, store: new SqliteEventStore(db) };
}

function rows(driver: SqliteDriver, sql: string): Record<string, unknown>[] {
  const statement = driver.prepare(sql);
  try {
    return statement.all();
  } finally {
    statement.finalize();
  }
}

function exec(driver: SqliteDriver, sql: string, ...params: SqlValue[]): void {
  const statement = driver.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

/** How many statements `driver` still holds: what a leak of one per call would grow. */
function retained(driver: SqliteDriver): number {
  return (driver as unknown as { statements: Set<unknown> }).statements.size;
}

eventStoreSuite("SqliteEventStore in memory", eventStoreOpener({ fresh: () => ":memory:", open }));
eventStoreSuite("SqliteEventStore on a file", eventStoreOpener({ fresh, open }));

describe("the event cases on node:sqlite files", () => {
  for (const c of eventCases) {
    it(c.name, async () => {
      const note = await c.run({ fresh, open: async (target, mode) => open(target, mode) });
      if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
    });
  }
});

describe("SqliteEventStore", () => {
  it("stores each event as the canonical bytes of its five-field envelope, without a newline or the CID, keyed by that CID beside columns that agree with them", async () => {
    const c = clock(T0);
    const { db, store } = create(":memory:", { author: authorN(1), now: c.now });
    const event = await store.append({ type: "t", roots: [RAW_HELLO], data: { z: -0, a: [1, { y: 2, x: 3 }] } });
    const [row] = rows(db.driver, "SELECT cid, at, author, type, canonical FROM events");
    expect(row).toMatchObject({ cid: event.cid, at: T0, author: authorN(1), type: "t" });
    expectBytes(row?.["canonical"] as Uint8Array, canonicalEventBytes(event));
    const text = new TextDecoder().decode(row?.["canonical"] as Uint8Array);
    expect(text.endsWith("\n")).toBe(false);
    expect(text).toBe(`{"at":"${T0}","author":"${authorN(1)}","data":{"a":[1,{"x":3,"y":2}],"z":0},"roots":["${RAW_HELLO}"],"type":"t"}`);
    expect(text).not.toContain(event.cid);
    db.close();
  });

  it("gives every accepted event the next position, in acceptance order, and advances last_seq by as many; nothing for a batch of none, a repeated draft or an ingest of duplicates", async () => {
    const c = clock(T0);
    const { db, store } = create(":memory:", { author: authorN(1), now: c.now });
    const positions = (): { seq: number; cid: string }[] => rows(db.driver, "SELECT accepted_seq AS seq, cid FROM event_positions ORDER BY accepted_seq").map((r) => ({ seq: r["seq"] as number, cid: r["cid"] as string }));
    const lastSeq = (): number => rows(db.driver, "SELECT last_seq FROM store_state")[0]?.["last_seq"] as number;
    const batch = await store.appendAll([
      { type: "t", data: { n: 1 } },
      { type: "t", data: { n: 2 } },
      { type: "t", data: { n: 3 } },
    ]);
    expect(positions()).toEqual(batch.map((event, i) => ({ seq: i + 1, cid: event.cid })));
    expect(lastSeq()).toBe(3);
    const other = create(":memory:", { author: authorN(2), now: c.now }).store;
    const foreign = await other.appendAll([{ type: "f", data: { n: 1 } }, { type: "f", data: { n: 2 } }]);
    expect(await store.ingest([...foreign, reordered(batch[0] as Event)])).toMatchObject({ added: 2, duplicates: 1 });
    expect(positions().slice(3)).toEqual(foreign.map((event, i) => ({ seq: i + 4, cid: event.cid })));
    expect(lastSeq()).toBe(5);
    expect(await store.appendAll([])).toEqual([]);
    expect(await store.ingest(foreign)).toMatchObject({ added: 0, duplicates: 2 });
    expect(await store.ingest([mislabelled(altered(foreign[0] as Event), (foreign[0] as Event).cid)])).toMatchObject({ added: 0, duplicates: 0 });
    expect(await store.appendAll([{ type: "t", data: { n: 2 } }, { type: "t", data: { n: 2 } }])).toEqual([batch[1], batch[1]]);
    expect(lastSeq()).toBe(5);
    expect(positions()).toHaveLength(5);
    expect(rows(db.driver, "SELECT count(*) AS n FROM events")).toEqual([{ n: 5 }]);
    db.close();
  });

  it("a token is this generation and the position accepted last; it survives a reopen, and a position past the last is refused", async () => {
    const c = clock(T0);
    const file = fresh();
    const made = create(file, { author: authorN(1), now: c.now });
    const one = await made.store.append({ type: "t", data: { n: 1 } });
    const { token } = await made.store.changes();
    expect(JSON.parse(token)).toEqual({ generation: made.db.generation, seq: 1 });
    made.db.close();
    const again = await reopen(file, c.now);
    expect(again.store.generation).toBe(made.db.generation);
    expect(await all((await again.store.changes(undefined, token)).events)).toEqual([]);
    const two = await again.store.append({ type: "t", data: { n: 2 } });
    expect(await all((await again.store.changes(undefined, token)).events)).toEqual([two]);
    const forge = (patch: object): string => JSON.stringify({ ...(JSON.parse(token) as object), ...patch });
    await expect(again.store.changes(undefined, forge({ seq: 3 }))).rejects.toBeInstanceOf(BadToken);
    await expect(again.store.changes(undefined, forge({ generation: authorN(9) }))).rejects.toBeInstanceOf(BadToken);
    for (const seq of [-1, 1.5, "1", null, undefined]) {
      await expect(again.store.changes(undefined, forge({ seq })), String(seq)).rejects.toBeInstanceOf(BadToken);
    }
    expect(await all((await again.store.changes(undefined, forge({ seq: 0 }))).events)).toEqual([one, two]);
    again.db.close();
  });

  it("what a reopen finds is what was accepted: the events under their CIDs, their positions, and the same author", async () => {
    const c = clock(T0);
    const file = fresh();
    const made = create(file, { author: authorN(1), now: c.now });
    const own = await made.store.append({ type: "t", data: { n: 1 } });
    const other = create(":memory:", { author: authorN(2), now: c.now }).store;
    const [foreign] = await other.appendAll([{ type: "f", data: { v: "a" } }]);
    expect(await made.store.ingest([foreign, altered(foreign as Event)])).toMatchObject({ added: 2 });
    made.db.close();
    const again = await reopen(file, c.now);
    expect(again.store.author).toBe(authorN(1));
    expect(await all(again.store.scan())).toEqual(byCid([own, foreign as Event, altered(foreign as Event)]));
    expect(await again.store.damaged()).toEqual([]);
    await expect(again.store.ingest([altered(own)])).rejects.toBeInstanceOf(ForkedAuthor);
    expect(await again.store.ingest([reordered(own)])).toMatchObject({ added: 0, duplicates: 1 });
    expect(await again.store.append({ type: "t", data: { n: 1 } })).toEqual(own);
    const later = await again.store.append({ type: "t", data: { n: 2 } });
    expect(rows(again.db.driver, "SELECT accepted_seq FROM event_positions ORDER BY accepted_seq").map((r) => r["accepted_seq"])).toEqual([1, 2, 3, 4]);
    expect(await all(again.store.scan({ author: authorN(1) }))).toEqual(byCid([own, later]));
    again.db.close();
  });

  it("a fork found while classifying leaves nothing behind: no event, no position", async () => {
    const c = clock(T0);
    const { db, store } = create(":memory:", { author: authorN(1), now: c.now });
    await store.append({ type: "t", data: { n: 1 } });
    const other = create(":memory:", { author: authorN(2), now: c.now }).store;
    const [foreign] = await other.appendAll([{ type: "f", data: {} }]);
    const own = await create(":memory:", { author: authorN(1), now: c.now }).store.append({ type: "t", data: { n: 2 } });
    await expect(store.ingest([foreign, altered(foreign as Event), own])).rejects.toBeInstanceOf(ForkedAuthor);
    expect(rows(db.driver, "SELECT count(*) AS n FROM events")).toEqual([{ n: 1 }]);
    expect(rows(db.driver, "SELECT last_seq FROM store_state")).toEqual([{ last_seq: 1 }]);
    expect(db.driver.inTransaction).toBe(false);
    db.close();
  });

  it("publish runs inside the batch's transaction with the count of new events: what it writes lands with them, and a throw from it rolls everything back", async () => {
    const c = clock(T0);
    const { db, store } = create(":memory:", { author: authorN(1), now: c.now });
    db.driver.exec("CREATE TABLE local_marks (mark TEXT PRIMARY KEY) STRICT");
    const marks = (): unknown[] => rows(db.driver, "SELECT mark FROM local_marks ORDER BY mark").map((r) => r["mark"]);
    const counts: number[] = [];
    const landed = await store.appendAll([{ type: "t", data: { n: 1 } }], (adding) => {
      counts.push(adding);
      expect(db.driver.inTransaction).toBe(true);
      db.driver.exec("INSERT INTO local_marks VALUES ('with')");
    });
    expect(landed).toHaveLength(1);
    expect(marks()).toEqual(["with"]);
    await expect(
      store.appendAll([{ type: "t", data: { n: 2 } }], () => {
        db.driver.exec("INSERT INTO local_marks VALUES ('rolled back')");
        throw new Error("publish failed");
      })
    ).rejects.toThrow("publish failed");
    expect(marks()).toEqual(["with"]);
    expect(await all(store.scan())).toEqual(landed);
    expect(rows(db.driver, "SELECT last_seq FROM store_state")).toEqual([{ last_seq: 1 }]);
    expect(await store.appendAll([], (adding) => {
      counts.push(adding);
      db.driver.exec("INSERT INTO local_marks VALUES ('alone')");
    }), "a batch of none still publishes").toEqual([]);
    expect(await store.appendAll([{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 1 } }], (adding) => counts.push(adding)), "a duplicate-only batch publishes too, with nothing new").toEqual([landed[0], landed[0]]);
    expect(counts).toEqual([1, 0, 0]);
    expect(marks()).toEqual(["alone", "with"]);
    expect(db.driver.inTransaction).toBe(false);
    db.close();
  });

  it("a row that no longer decodes to the event its columns name is damage: reported with its place and bytes, left out of every scan and delta, and the rest still read", async () => {
    const c = clock(T0);
    const { db, store } = create(":memory:", { author: authorN(1), now: c.now });
    const events = await store.appendAll(Array.from({ length: 8 }, (_, i) => ({ type: "t", data: { n: i } })));
    const [notJson, notAnEvent, notCanonical, otherCid, notACid, otherAt, otherType, sound] = events as unknown as [Event, Event, Event, Event, Event, Event, Event, Event];
    db.driver.exec("PRAGMA foreign_keys = OFF"); // the positions keep naming what the CIDs were
    const set = (event: Event, column: string, value: string | Uint8Array): void => exec(db.driver, `UPDATE events SET ${column} = ? WHERE cid = ?`, value, event.cid);
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    set(notJson, "canonical", bytes("{not json"));
    set(notAnEvent, "canonical", bytes('{"a":1}'));
    set(notCanonical, "canonical", bytes(`${new TextDecoder().decode(canonicalEventBytes(notCanonical))} `));
    set(otherCid, "cid", RAW_HELLO); // a CID spelled well, of other bytes
    set(notACid, "cid", "not-a-cid");
    set(otherAt, "at", "2026-09-12T10:00:00.001Z");
    set(otherType, "type", "u");
    const damaged = await store.damaged();
    const where = (cid: string): string => `events/${cid}`;
    expect(damaged.map((d) => d.where).sort()).toEqual([...[notJson, notAnEvent, notCanonical, otherAt, otherType].map((e) => where(e.cid)), where(RAW_HELLO), where("not-a-cid")].sort());
    const errorOf = (cid: string): string => damaged.find((d) => d.where === where(cid))?.error ?? "";
    expect(errorOf(notJson.cid)).not.toBe("");
    expect(errorOf(notAnEvent.cid)).toMatch(/missing at/);
    expect(errorOf(notCanonical.cid)).toMatch(/not the envelope's canonical bytes/);
    expect(errorOf(RAW_HELLO)).toMatch(new RegExp(`column cid is ${RAW_HELLO}, but the bytes hash to ${otherCid.cid}`));
    expect(errorOf("not-a-cid")).toMatch(/column cid "not-a-cid" is not a canonical raw DASL CID/);
    expect(errorOf(otherAt.cid)).toMatch(/column at is "2026-09-12T10:00:00.001Z"/);
    expect(errorOf(otherType.cid)).toMatch(/column type is "u", not the event's "t"/);
    const stored = new Map(rows(db.driver, "SELECT cid, canonical FROM events").map((r) => [where(r["cid"] as string), r["canonical"] as Uint8Array]));
    for (const d of damaged) expectBytes(d.bytes, stored.get(d.where) as Uint8Array, d.where);
    expect(await all(store.scan())).toEqual([sound]);
    expect(await all(store.scan({ type: "t" }))).toEqual([sound]);
    expect(await all((await store.changes()).events)).toEqual([sound]);
    await expect(store.ingest([reordered(notCanonical)]), "a history with damage accepts no write").rejects.toBeInstanceOf(DamagedHistory);
    await expect(store.ingest([reordered(notCanonical)])).rejects.toThrow(/is damaged, .*: the history is incomplete/);
    expect(db.driver.inTransaction).toBe(false);
    db.close();
  });

  it("an ordinary read checks the bytes against the columns without hashing them; the survey hashes, and what it finds is then left out of every read", async () => {
    const c = clock(T0);
    const file = fresh();
    const made = create(file, { author: authorN(1), now: c.now });
    const [relabelled, sound] = (await made.store.appendAll([{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }])) as unknown as [Event, Event];
    made.db.close();
    const db = openNodeSqlite(file, { mode: "readwrite" });
    db.exec("PRAGMA foreign_keys = OFF");
    exec(db, "UPDATE events SET cid = ? WHERE cid = ?", RAW_HELLO, relabelled.cid);
    exec(db, "UPDATE event_positions SET cid = ? WHERE cid = ?", RAW_HELLO, relabelled.cid);
    db.close();
    const again = await reopen(file, c.now);
    expect(await all(again.store.scan()), "read as stored: the CID column is not recomputed").toEqual([sound, { ...relabelled, cid: RAW_HELLO }].sort((a, b) => (a.cid < b.cid ? -1 : 1)));
    expect(await all((await again.store.changes()).events)).toHaveLength(2);
    expect((await again.store.damaged()).map((d) => d.where)).toEqual([`events/${RAW_HELLO}`]);
    expect(await all(again.store.scan()), "known damaged now").toEqual([sound]);
    expect(await all((await again.store.changes()).events)).toEqual([sound]);
    await expect(again.store.append({ type: "t", data: { n: 3 } })).rejects.toBeInstanceOf(DamagedHistory);
    again.db.close();
    const third = await reopen(file, c.now);
    await expect(third.store.append({ type: "t", data: { n: 3 } }), "the survey before the first write finds it").rejects.toBeInstanceOf(DamagedHistory);
    expect(await all(third.store.scan())).toEqual([sound]);
    third.db.close();
  });

  it("a row whose CID column holds a NUL is damage named by its rowid, the column being no name", async () => {
    const { db, store } = create(":memory:");
    const event = await store.append({ type: "t", data: {} });
    db.driver.exec("PRAGMA foreign_keys = OFF");
    exec(db.driver, "UPDATE events SET cid = CAST(CAST(cid AS BLOB) || x'00' AS TEXT) WHERE cid = ?", event.cid);
    const [withNul] = await store.damaged();
    expect(withNul?.where).toBe("events/rowid 1");
    expect(withNul?.error).toMatch(/NUL/);
    expect(await all(store.scan())).toEqual([]);
    db.close();
  });

  it("an inspector's store scans, follows changes and lists damage, and refuses every write before reading a source", async () => {
    const c = clock(T0);
    const file = fresh();
    const made = create(file, { author: authorN(1), now: c.now });
    const own = await made.store.append({ type: "t", data: { n: 1 } });
    const other = create(":memory:", { author: authorN(2), now: c.now }).store;
    const [foreign] = await other.appendAll([{ type: "f", data: {} }]);
    await made.store.ingest([foreign, altered(foreign as Event)]);
    const { token } = await made.store.changes();
    made.db.close();
    const { db, store } = inspect(file);
    expect(store.author).toBe(authorN(1));
    expect(await all(store.scan())).toHaveLength(3);
    expect(await all((await store.changes(undefined, token)).events)).toEqual([]);
    expect((await store.changes()).token).toBe(token);
    expect(await store.damaged()).toEqual([]);
    let pulled = false;
    async function* source(): AsyncIterable<unknown> {
      pulled = true;
      yield foreign;
    }
    await expect(store.append({ type: "t", data: {} })).rejects.toBeInstanceOf(ReadOnlyVault);
    await expect(store.appendAll([{ type: "t", data: {} }])).rejects.toBeInstanceOf(ReadOnlyVault);
    await expect(store.appendAll([], () => undefined)).rejects.toBeInstanceOf(ReadOnlyVault);
    await expect(store.ingest(source())).rejects.toBeInstanceOf(ReadOnlyVault);
    expect(pulled).toBe(false);
    db.close();
    const again = await reopen(file, c.now);
    expect(await all(again.store.scan())).toEqual(byCid([own, foreign as Event, altered(foreign as Event)]));
    again.db.close();
  });

  it("refuses to write over a control row that is gone, in the transaction, so nothing of the batch lands", async () => {
    const { db, store } = create(":memory:");
    db.driver.exec("DELETE FROM store_state");
    await expect(store.append({ type: "t", data: {} })).rejects.toBeInstanceOf(DamagedControl);
    expect(rows(db.driver, "SELECT count(*) AS n FROM events")).toEqual([{ n: 0 }]);
    expect(db.driver.inTransaction).toBe(false);
    db.close();
  });

  it("holds no statement past a call", async () => {
    const c = clock(T0);
    const { db, store } = create(":memory:", { author: authorN(1), now: c.now });
    const other = create(":memory:", { author: authorN(2), now: c.now }).store;
    const foreign = await other.appendAll([{ type: "f", data: { n: 1 } }, { type: "f", data: { n: 2 } }]);
    expect(retained(db.driver)).toBe(0);
    for (let i = 0; i < 200; i++) {
      await store.append({ type: "t", data: { i } });
      await store.appendAll([{ type: "t", data: { i } }, { type: "t", data: { i } }]);
      await store.ingest([foreign[i % 2], altered(foreign[i % 2] as Event), mislabelled(altered(foreign[i % 2] as Event), (foreign[i % 2] as Event).cid)]);
      await all(store.scan({ type: "t", data: { i } }));
      await all(store.scan({ cid: foreign[0]?.cid }));
      await all((await store.changes({ author: authorN(2) })).events);
      await store.damaged();
    }
    expect(retained(db.driver)).toBe(0);
    db.close();
  });

  it("a process that dies inside its transaction leaves the whole batch or none; one that committed leaves it whole", async () => {
    const c = clock(T0);
    const file = fresh();
    const made = create(file, { author: authorN(1), now: c.now });
    const before = await made.store.append({ type: "t", data: { n: 0 } });
    made.db.close();
    c.advance(1);
    const batch = await create(":memory:", { author: authorN(1), now: c.now }).store.appendAll([{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }]);
    await appendInAnotherProcess(file, "die", batch);
    const once = await reopen(file, c.now);
    expect(await all(once.store.scan())).toEqual([before]);
    expect(rows(once.db.driver, "SELECT last_seq FROM store_state")).toEqual([{ last_seq: 1 }]);
    once.db.close();
    await appendInAnotherProcess(file, "commit", batch);
    const twice = await reopen(file, c.now);
    expect(await all(twice.store.scan())).toEqual([before, ...byCid(batch)]);
    expect(rows(twice.db.driver, "SELECT last_seq FROM store_state")).toEqual([{ last_seq: 3 }]);
    expect(await twice.store.damaged()).toEqual([]);
    twice.db.close();
  });
});

/**
 * Another process writing the rows an append writes, with `node:sqlite`
 * alone: the events, their positions and the advanced `last_seq`, in
 * one transaction. `die` exits before COMMIT — the interruption a
 * crash is, as far as the file can tell; `commit` commits and closes.
 */
const OTHER_PROCESS = `
  const { DatabaseSync } = require("node:sqlite");
  const [file, how, payload] = process.argv.slice(1);
  const events = JSON.parse(payload);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE");
  const last = Number(db.prepare("SELECT last_seq FROM store_state").get().last_seq);
  const insertEvent = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)");
  const insertPosition = db.prepare("INSERT INTO event_positions VALUES (?, ?)");
  events.forEach((e, i) => {
    insertEvent.run(e.cid, e.at, e.author, e.type, Buffer.from(e.hex, "hex"));
    insertPosition.run(last + i + 1, e.cid);
  });
  db.prepare("UPDATE store_state SET last_seq = ?").run(last + events.length);
  if (how === "commit") {
    db.exec("COMMIT");
    db.close();
  }
  process.exit(0);
`;

async function appendInAnotherProcess(file: string, how: "die" | "commit", events: Event[]): Promise<void> {
  const payload = JSON.stringify(events.map((event) => ({ ...event, hex: Buffer.from(canonicalEventBytes(event)).toString("hex") })));
  const child = spawn(process.execPath, ["--no-warnings", "-e", OTHER_PROCESS, file, how, payload], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.on("error", reject);
    child.on("exit", done);
  });
  if (code !== 0) throw new Error(`the other process (${how}) exited with ${code}: ${output}`);
}
