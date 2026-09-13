/**
 * The SQLite vault on whatever the platform's driver is, as cases free
 * of any test framework: run over `node:sqlite` by `vault.test.ts`
 * and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. What the conformance suite cannot see —
 * the rows one commit leaves and a reopen finds, a refused commit
 * leaving nothing, an identity reset, the history stopping writes, the
 * local tables, a commit of unknown outcome, ownership across close —
 * where the two platforms' SQLite must agree.
 */

import { sha256 } from "@noble/hashes/sha2";

import {
  Connection,
  SqliteError,
  SqliteVault,
  canonicalEventBytes,
  chunksOf,
  createRuntime,
  openInspector,
  openRuntime,
  rawCidFromDigest,
  type Cid,
  type Draft,
  type Event,
  type OpenMode,
  type RawConnection,
  type Retained,
  type SqliteDriver,
  type Vault,
} from "../../../src/v3/index.js";
import { ANCHOR, META, REWRAPPED, WRAPPED } from "../fixtures.js";
import { assert, assertBytes, assertEqual, assertRejects, rawOver } from "./driver-cases.js";

export interface VaultHarness {
  /** A target no database exists at yet. */
  fresh(): string;
  open(target: string, mode: OpenMode): Promise<SqliteDriver>;
}

export interface VaultCase {
  name: string;
  run(harness: VaultHarness): Promise<string | void>;
}

export const MIB = 1024 * 1024;
export const T0 = Date.parse("2026-09-12T10:00:00.000Z");
export const HELLO = new TextEncoder().encode("hello");
export const HELLO_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq" as Cid;
export const WORLD = new TextEncoder().encode("world");

/** `n` deterministic bytes from `seed`. */
export function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

export function cidOf(bytes: Uint8Array): Cid {
  return rawCidFromDigest(sha256(bytes)).text as Cid;
}

export const WORLD_CID = cidOf(WORLD);

export const draft = (roots: Cid[] = [], data: Record<string, unknown> = {}): Draft => ({ type: "test.event", roots, data: { n: 1, ...data } });

export function rows(driver: SqliteDriver, sql: string, ...params: (string | number | Uint8Array)[]): Record<string, unknown>[] {
  const statement = driver.prepare(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

export function exec(driver: SqliteDriver, sql: string, ...params: (string | number | Uint8Array)[]): void {
  const statement = driver.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

export async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

export async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunksOf(stream)) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A clock the case moves by hand. */
export function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = T0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Every root of every event: the type-independent keep set. */
export async function rootsOf(vault: Vault): Promise<Cid[]> {
  const roots: Cid[] = [];
  for await (const event of vault.events.scan()) roots.push(...event.roots);
  return roots;
}

/** Every root of every event, retained by that event: the type-independent retention. */
export async function retainedOf(vault: Vault): Promise<Retained[]> {
  const retained: Retained[] = [];
  for await (const event of vault.events.scan()) for (const root of event.roots) retained.push({ eventId: event.eventId, root });
  return retained;
}

/** `inner` as a `readwrite` connection whose `n`-th statement run fails as a bad disk would; `n` past the last run fails nothing. */
export function failingAt(inner: SqliteDriver, n: number): SqliteDriver {
  const raw = rawOver(inner);
  let count = 0;
  const failing: RawConnection = {
    ...raw,
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        ...statement,
        run: (params) => {
          if (++count === n) throw new SqliteError(10, "disk I/O error");
          return statement.run(params);
        },
      };
    },
  };
  return new Connection(failing, "readwrite");
}

/** Flips one byte of the first chunk of `cid`, as a bad sector would. */
export function corruptChunk(driver: SqliteDriver, cid: Cid, chunkNo = 0): void {
  const [row] = rows(driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = ?", cid, chunkNo);
  if (row === undefined) throw new Error(`${cid} has no chunk ${chunkNo}`);
  const bytes = new Uint8Array(row["bytes"] as Uint8Array);
  bytes[0] = (bytes[0] as number) ^ 0x01;
  exec(driver, "UPDATE object_chunks SET bytes = ? WHERE cid = ? AND chunk_no = ?", bytes, cid, chunkNo);
}

/** Cuts the stored canonical bytes of `event` short, as a torn write would. */
export function damageEvent(driver: SqliteDriver, event: Event): void {
  exec(driver, "UPDATE events SET canonical = ? WHERE event_id = ?", canonicalEventBytes(event).slice(0, -3), event.eventId);
}

/** The vault over the runtime database, and the connection under it, for what a case reads straight from the tables. */
export interface Made {
  vault: SqliteVault;
  driver: SqliteDriver;
}

export async function make(h: VaultHarness, target: string, now: () => number): Promise<Made> {
  const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
  return { vault: new SqliteVault(db, { now }), driver: db.driver };
}

export async function reopen(h: VaultHarness, target: string, now: () => number, resetIdentity = false): Promise<Made> {
  const db = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR, resetIdentity });
  return { vault: new SqliteVault(db, { now }), driver: db.driver };
}

/** The vault over the runtime `driver` holds, opened as a reopen would open it. */
export async function vaultOver(driver: SqliteDriver, now: () => number): Promise<Made> {
  const db = await openRuntime(driver, { anchor: ANCHOR });
  return { vault: new SqliteVault(db, { now }), driver: db.driver };
}

export const vaultCases: VaultCase[] = [
  {
    name: "a commit lands its objects, chunks, events and positions together; a reopen reads them back under the same identity, and the token still places",
    run: async (h) => {
      const target = h.fresh();
      const c = clock();
      const { vault, driver } = await make(h, target, c.now);
      const big = bytesOf(MIB + 7, 1);
      const bigCid = cidOf(big);
      const events = await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: bigCid, source: big },
        ],
        [draft([HELLO_CID, bigCid], { i: 0 }), draft([bigCid], { i: 1 })]
      );
      assertEqual(events.length, 2, "two events");
      assertEqual(new Set(events.map((e) => e.at)).size, 1, "one timestamp");
      assertEqual(rows(driver, "SELECT cid, size FROM objects ORDER BY cid"), [{ cid: HELLO_CID, size: 5 }, { cid: bigCid, size: MIB + 7 }].sort((a, b) => (a.cid < b.cid ? -1 : 1)), "the object rows");
      assertEqual(rows(driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 3 }], "the chunks");
      assertEqual(rows(driver, "SELECT accepted_seq, event_id FROM event_positions ORDER BY accepted_seq"), events.map((e, i) => ({ accepted_seq: i + 1, event_id: e.eventId })), "the positions");
      assertEqual(rows(driver, "SELECT last_seq FROM store_state"), [{ last_seq: 2 }], "the control");
      const { token } = await vault.vault.events.changes();
      const { author, generation } = vault;
      await vault.close();
      const { vault: again } = await reopen(h, target, c.now);
      try {
        assertEqual([again.author, again.generation], [author, generation], "the identity after a reopen");
        assertEqual(
          (await all(again.vault.events.scan())).map((e) => e.eventId),
          events.map((e) => e.eventId).sort(),
          "the events after a reopen"
        );
        const delta = await again.vault.events.changes(undefined, token);
        assertEqual(await all(delta.events), [], "nothing since the token");
        assertEqual(delta.token, token, "the token is the frontier still");
        assertBytes(await drain((await again.vault.objects.open(bigCid)) as ReadableStream<Uint8Array>), big, "the big object");
        assertBytes((await again.vault.objects.read(HELLO_CID, 5)) as Uint8Array, HELLO, "hello");
        assertEqual(await all(again.vault.objects.list()), [HELLO_CID, bigCid].sort(), "the objects");
        assertEqual(await again.vault.events.damaged(), [], "no damage");
        assertEqual(again.stopped, undefined, "not stopped");
      } finally {
        await again.close();
      }
    },
  },
  {
    name: "a commit refused at a root leaves no object row and nothing staged; the next commit lands",
    run: async (h) => {
      const c = clock();
      const { vault, driver } = await make(h, h.fresh(), c.now);
      try {
        const world = bytesOf(9, 2);
        await assertRejects(() => vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID, cidOf(world)])]), "MissingRoot", "a root not supplied");
        assertEqual(rows(driver, "SELECT count(*) AS n FROM objects"), [{ n: 0 }], "no object row");
        assertEqual(rows(driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 0 }], "no chunk");
        assertEqual(rows(driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "nothing staged");
        assertEqual(rows(driver, "SELECT count(*) AS n FROM events"), [{ n: 0 }], "no event");
        assertEqual(rows(driver, "SELECT last_seq FROM store_state"), [{ last_seq: 0 }], "no position");
        const events = await vault.vault.commit(
          [
            { cid: HELLO_CID, source: HELLO },
            { cid: cidOf(world), source: world },
          ],
          [draft([HELLO_CID, cidOf(world)])]
        );
        assertEqual(events.length, 1, "the next commit");
        assertEqual(rows(driver, "SELECT count(*) AS n FROM objects"), [{ n: 2 }], "two object rows");
        assertEqual(rows(driver, "SELECT accepted_seq, event_id FROM event_positions"), [{ accepted_seq: 1, event_id: events[0]?.eventId }], "one position");
      } finally {
        await vault.close();
      }
    },
  },
  {
    name: "a commit drops the cache in the transaction that changes the accepted state under it — events with objects, events alone, a repair with no new event — an empty commit and a commit refused before its transaction leave it, and one whose transaction fails leaves it with the state",
    run: async (h) => {
      const c = clock();
      const target = h.fresh();
      const { vault, driver } = await make(h, target, c.now);
      const cached = async (what: string, kept: boolean): Promise<void> => {
        assertEqual(rows(driver, "SELECT count(*) AS n FROM local_cache"), [{ n: kept ? 1 : 0 }], what);
        await vault.local.cache.put("projection", "events", HELLO);
      };
      await vault.local.cache.put("projection", "events", HELLO);
      await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID], { i: 0 })]);
      await cached("events with objects", false);
      await vault.vault.commit([], [{ type: "test.erased", roots: [], data: { dropCids: [HELLO_CID] } }]);
      await cached("events alone: what an erase is", false);
      await vault.vault.commit([], []);
      await cached("an empty commit", true);
      await assertRejects(() => vault.vault.commit([], [draft([cidOf(bytesOf(9, 2))])]), "MissingRoot", "a commit refused at a root");
      await cached("refused before its transaction", true);
      corruptChunk(driver, HELLO_CID);
      await assertRejects(() => vault.vault.objects.read(HELLO_CID, 5), "DamagedObject", "hello known damaged");
      const events = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID], { i: 1 })]);
      assertEqual(events.length, 1, "the repair lands with its event");
      assertBytes((await vault.vault.objects.read(HELLO_CID, 5)) as Uint8Array, HELLO, "hello repaired");
      await cached("a repair", false);
      const { author, generation } = vault;
      await vault.close();
      // a transaction that fails after the cache is dropped: rolled back with the state
      for (let n = 1; ; n++) {
        const { vault: failing, driver: raw } = await vaultOver(failingAt(await h.open(target, "readwrite"), n), c.now);
        const before = rows(raw, "SELECT count(*) AS n FROM events");
        let landed: Event[] | undefined;
        try {
          landed = await failing.vault.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID], { i: 2 })]);
        } catch (err) {
          assert(err instanceof SqliteError, `statement ${n}: ${String(err)}`);
        } finally {
          await failing.close();
        }
        const { vault: check, driver: after } = await reopen(h, target, c.now);
        try {
          if (landed !== undefined) {
            assertEqual(rows(after, "SELECT count(*) AS n FROM local_cache"), [{ n: 0 }], "past the last statement: the cache dropped with the commit");
            break;
          }
          assertEqual(rows(after, "SELECT count(*) AS n FROM events"), before, `statement ${n}: no event`);
          assertEqual(rows(after, "SELECT count(*) AS n FROM local_cache"), [{ n: 1 }], `statement ${n}: the cache with the state it was built from`);
          assertEqual([check.author, check.generation], [author, generation], `statement ${n}: the identity`);
        } finally {
          await check.close();
        }
      }
    },
  },
  {
    name: "an identity reset renews the replica ID and the generation, refuses the old token and drops the cache; events, positions, objects, options and the keystore stay",
    run: async (h) => {
      const target = h.fresh();
      const c = clock();
      const { vault } = await make(h, target, c.now);
      const [event] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      const { token } = await vault.vault.events.changes();
      await vault.local.options.set("theme", { dark: true });
      await vault.local.cache.put("thumbs", HELLO_CID, HELLO);
      const { author, generation } = vault;
      await vault.close();
      const { vault: same } = await reopen(h, target, c.now);
      assertEqual([same.author, same.generation], [author, generation], "a plain reopen keeps both");
      assertBytes((await same.local.cache.get("thumbs", HELLO_CID)) as Uint8Array, HELLO, "the cache after a plain reopen");
      await same.close();
      const { vault: reset, driver } = await reopen(h, target, c.now, true);
      try {
        assert(reset.author !== author, "a new replica ID");
        assert(reset.generation !== generation, "a new generation");
        await assertRejects(() => reset.vault.events.changes(undefined, token), "BadToken", "the old generation's token");
        assertEqual(await reset.local.cache.get("thumbs", HELLO_CID), undefined, "the cache is dropped");
        assertEqual(await reset.local.options.get("theme"), { dark: true }, "the options stay");
        assertEqual(await reset.keystore.read(), WRAPPED, "the keystore stays");
        assertEqual(
          (await all(reset.vault.events.scan())).map((e) => [e.eventId, e.author]),
          [[event?.eventId, author]],
          "the event stays, authored as it was"
        );
        assertEqual(rows(driver, "SELECT accepted_seq, event_id FROM event_positions"), [{ accepted_seq: 1, event_id: event?.eventId }], "the position stays");
        assertEqual(rows(driver, "SELECT replica_id, store_generation, last_seq FROM store_state"), [{ replica_id: reset.author, store_generation: reset.generation, last_seq: 1 }], "the control row");
        assertBytes((await reset.vault.objects.read(HELLO_CID, 5)) as Uint8Array, HELLO, "the object stays");
        const [next] = await reset.vault.commit([], [draft([HELLO_CID])]);
        assertEqual(next?.author, reset.author, "a commit is authored as the new replica");
        const fresh = await reset.vault.events.changes();
        assertEqual((await all(fresh.events)).length, 2, "the new generation's frontier covers every position");
        // the old identity's event ingested again is a duplicate, not a fork: the replica is another now
        assertEqual(await reset.ingest([event]), { added: 0, duplicates: 1, conflicts: [], rejected: [] }, "the old event as a duplicate");
      } finally {
        await reset.close();
      }
    },
  },
  {
    name: "damage to the history stops commit, ingest and collection while reads, local state and rewrap go on, and `stopped` says why; an inspector sees the same",
    run: async (h) => {
      const target = h.fresh();
      const c = clock();
      const { vault, driver } = await make(h, target, c.now);
      const [first, second] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID], { i: 0 }), draft([], { i: 1 })]);
      damageEvent(driver, second as Event);
      await vault.close();
      const other = await make(h, h.fresh(), c.now);
      const [foreign] = await other.vault.vault.commit([], [draft([], { from: "other" })]);
      await other.vault.close();
      const { vault: stopped, driver: reopened } = await reopen(h, target, c.now);
      try {
        assertEqual(stopped.stopped?.name, "DamagedHistory", "stopped by the damage, found by the survey asking makes");
        assertEqual((await all(stopped.vault.events.scan())).map((e) => e.eventId), [first?.eventId], "the sound event is read; the damaged one is left out");
        assertEqual((await stopped.vault.events.damaged()).map((d) => d.where), [`events/${second?.eventId}`], "the damage");
        await assertRejects(() => stopped.vault.commit([], [draft([HELLO_CID])]), "DamagedHistory", "commit");
        await assertRejects(() => stopped.ingest([foreign]), "DamagedHistory", "ingest");
        await assertRejects(() => stopped.collect(rootsOf), "DamagedHistory", "collect");
        await assertRejects(() => stopped.locked((held) => held.collect(rootsOf)), "DamagedHistory", "collect through a held view");
        assertBytes((await stopped.vault.objects.read(HELLO_CID, 5)) as Uint8Array, HELLO, "the object is still read");
        assertEqual(await all(stopped.vault.objects.list()), [HELLO_CID], "the object is still there");
        await stopped.local.options.set("note", "still local");
        assertEqual(await stopped.local.options.get("note"), "still local", "local state goes on");
        await stopped.keystore.rewrap(REWRAPPED);
        assertEqual(await stopped.keystore.read(), REWRAPPED, "the wrapper is replaced");
        assertEqual(rows(reopened, "SELECT count(*) AS n FROM events"), [{ n: 2 }], "no event was added or removed");
        assertEqual(rows(reopened, "SELECT count(*) AS n FROM objects"), [{ n: 1 }], "no object was removed");
      } finally {
        await stopped.close();
      }
      const inspector = new SqliteVault(openInspector(await h.open(target, "readwrite")), { now: c.now });
      try {
        assertEqual(inspector.writable, false, "an inspector is not writable");
        assertEqual((await inspector.vault.events.damaged()).map((d) => d.where), [`events/${second?.eventId}`], "the inspector finds the damage");
        assertEqual(await inspector.local.options.get("note"), "still local", "the inspector reads local state");
        await assertRejects(() => inspector.local.options.set("note", "x"), "ReadOnlyVault", "an inspector writes no option");
        await assertRejects(() => inspector.vault.commit([], [draft()]), "ReadOnlyVault", "an inspector commits nothing");
        await assertRejects(() => inspector.keystore.rewrap(WRAPPED), "ReadOnlyVault", "an inspector rewraps nothing");
      } finally {
        await inspector.close();
      }
    },
  },
  {
    name: "options, cache and trace live in local tables the schema check allows; prune keeps the newest within age and count; clearCaches empties the cache and the trace and keeps the options; a trace position is never given out twice",
    run: async (h) => {
      const target = h.fresh();
      const c = clock();
      const { vault, driver } = await make(h, target, c.now);
      assertEqual(rows(driver, "SELECT name FROM sqlite_master WHERE name LIKE 'local_%' ORDER BY name"), [], "no local table before the first write");
      assertEqual(await vault.local.options.get("missing"), undefined, "an option never set");
      assertEqual(await vault.local.options.keys(), [], "no keys");
      assertEqual(await vault.local.cache.get("ns", "k"), undefined, "a cache entry never put");
      assertEqual(await all(vault.local.trace.scan()), [], "an empty trace");
      await vault.local.options.set("a", [1, "two", null]);
      await vault.local.options.set("b", { nested: { deep: true } });
      await vault.local.options.set("a", -0);
      await assertRejects(() => vault.local.options.set("bad", undefined as never), "InvalidJson", "an option that is not JSON");
      assertEqual(await vault.local.options.get("a"), 0, "the last value, in canonical form");
      assertEqual(await vault.local.options.keys(), ["a", "b"], "the keys");
      await vault.local.options.delete("b");
      assertEqual(await vault.local.options.keys(), ["a"], "after a delete");
      await vault.local.cache.put("thumbs", "x", HELLO);
      await vault.local.cache.put("thumbs", "y", bytesOf(3, 3));
      await vault.local.cache.put("other", "x", bytesOf(3, 4));
      assertBytes((await vault.local.cache.get("thumbs", "x")) as Uint8Array, HELLO, "a cache entry");
      await vault.local.cache.delete("thumbs", "x");
      assertEqual(await vault.local.cache.get("thumbs", "x"), undefined, "a deleted cache entry");
      await vault.local.cache.clear("thumbs");
      assertEqual(await vault.local.cache.get("thumbs", "y"), undefined, "a cleared namespace");
      assertBytes((await vault.local.cache.get("other", "x")) as Uint8Array, bytesOf(3, 4), "another namespace stays");
      const entries = [];
      for (let i = 0; i < 5; i++) {
        entries.push(await vault.local.trace.append(i % 2 === 0 ? "even" : "odd", { i }));
        c.advance(1000);
      }
      assertEqual(
        entries.map((e) => [e.seq, e.at, e.type, e.data]),
        [
          [1, "2026-09-12T10:00:00.000Z", "even", { i: 0 }],
          [2, "2026-09-12T10:00:01.000Z", "odd", { i: 1 }],
          [3, "2026-09-12T10:00:02.000Z", "even", { i: 2 }],
          [4, "2026-09-12T10:00:03.000Z", "odd", { i: 3 }],
          [5, "2026-09-12T10:00:04.000Z", "even", { i: 4 }],
        ],
        "the entries as appended"
      );
      assertEqual(await all(vault.local.trace.scan()), entries, "the trace in order");
      assertEqual((await all(vault.local.trace.scan({ type: "odd" }))).map((e) => e.seq), [2, 4], "by type");
      assertEqual((await all(vault.local.trace.scan({ after: 3 }))).map((e) => e.seq), [4, 5], "after a seq");
      assertEqual((await all(vault.local.trace.scan({ type: "even", after: 1 }))).map((e) => e.seq), [3, 5], "both");
      await assertRejects(() => vault.local.trace.append("", {}), "TypeError", "an empty type");
      // the clock is at +5 s: keep 3.5 s drops entries 1 and 2; then the cap keeps the newest two
      assertEqual(await vault.local.trace.prune({ keepMs: 3500, capRows: 10 }), { pruned: 2 }, "pruned by age");
      assertEqual((await all(vault.local.trace.scan())).map((e) => e.seq), [3, 4, 5], "what age kept");
      assertEqual(await vault.local.trace.prune({ keepMs: 60_000, capRows: 2 }), { pruned: 1 }, "pruned by count");
      assertEqual((await all(vault.local.trace.scan())).map((e) => e.seq), [4, 5], "what the cap kept");
      assertEqual((await vault.local.trace.append("late", {})).seq, 6, "the next seq continues");
      assertEqual(rows(driver, "SELECT name FROM sqlite_master WHERE name LIKE 'local_%' ORDER BY name"), [{ name: "local_cache" }, { name: "local_options" }, { name: "local_trace" }, { name: "local_trace_state" }], "the local tables");
      await vault.local.clearCaches();
      assertEqual(await vault.local.cache.get("other", "x"), undefined, "the cache is emptied");
      assertEqual(await all(vault.local.trace.scan()), [], "the trace is emptied");
      assertEqual(await vault.local.options.get("a"), 0, "the options stay");
      assertEqual((await vault.local.trace.append("after", {})).seq, 7, "the trace continues past a clearing");
      c.advance(2000);
      assertEqual(await vault.local.trace.prune({ keepMs: 500, capRows: 10 }), { pruned: 1 }, "age empties the trace");
      assertEqual((await vault.local.trace.append("aged", {})).seq, 8, "and the next seq continues");
      assertEqual((await all(vault.local.trace.scan({ after: 7 }))).map((e) => e.seq), [8], "a position kept from before the emptying still reads what came after");
      assertEqual(await vault.local.trace.prune({ keepMs: 60_000, capRows: 0 }), { pruned: 1 }, "a cap of zero empties the trace");
      assertEqual((await vault.local.trace.append("capped", {})).seq, 9, "and the next seq continues");
      await vault.close();
      // the tables pass the runtime's schema check on reopen
      const { vault: again } = await reopen(h, target, c.now);
      try {
        assertEqual(await again.local.options.get("a"), 0, "the option after a reopen");
        assertEqual((await all(again.local.trace.scan())).map((e) => e.type), ["capped"], "the trace after a reopen");
        assertEqual((await again.local.trace.append("reopened", {})).seq, 10, "the seq continues across a reopen");
        assertEqual((await all(again.local.trace.scan({ after: 8 }))).map((e) => e.seq), [9, 10], "a position kept across the reopen reads what came after");
      } finally {
        await again.close();
      }
    },
  },
  {
    name: "a commit whose COMMIT fails is of unknown outcome: the vault refuses everything until closed, and a reopen shows the batch whole or not at all",
    run: async (h) => {
      const target = h.fresh();
      const c = clock();
      let failing = false;
      const db = createRuntime(new Connection(rawOver(await h.open(target, "create"), { failCommit: () => failing }), "create"), { metadata: META, wrapped: WRAPPED });
      const vault = new SqliteVault(db, { now: c.now });
      const [first] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      await vault.local.options.set("kept", true);
      failing = true;
      const world = bytesOf(MIB + 1, 5);
      const err = await assertRejects(() => vault.vault.commit([{ cid: cidOf(world), source: world }], [draft([cidOf(world)]), draft([HELLO_CID])]), "UncertainCommit", "the commit");
      assert(err.message.includes("disk I/O error"), `the cause is named: ${err.message}`);
      assertEqual(vault.stopped?.name, "UncertainCommit", "stopped by the uncertain commit");
      await assertRejects(() => all(vault.vault.events.scan()), "UncertainCommit", "a scan");
      await assertRejects(() => vault.vault.objects.has(HELLO_CID), "UncertainCommit", "a presence check");
      await assertRejects(() => vault.vault.commit([], [draft([HELLO_CID])]), "UncertainCommit", "another commit");
      await assertRejects(() => vault.ingest([]), "UncertainCommit", "an ingest");
      await assertRejects(() => vault.local.options.get("kept"), "UncertainCommit", "a local read");
      await assertRejects(() => vault.keystore.read(), "UncertainCommit", "the keystore");
      await vault.close();
      const { vault: again } = await reopen(h, target, c.now);
      try {
        const events = await all(again.vault.events.scan());
        assert(events.length === 1 || events.length === 3, `the batch landed whole or not at all: ${events.length} events`);
        assertEqual(events[0]?.eventId, first?.eventId, "the earlier commit is there");
        for (const event of events) {
          for (const root of event.roots) assertEqual(await again.vault.objects.has(root), true, `root ${root} of ${event.eventId}`);
        }
        assertEqual(await again.vault.events.damaged(), [], "no damage");
        assertEqual(await again.local.options.get("kept"), true, "the option");
        assertEqual(again.stopped, undefined, "the reopened vault runs");
      } finally {
        await again.close();
      }
    },
  },
  {
    name: "close admits nothing more, the keystore included, lets the operation in flight finish, then releases ownership: a second open is refused before and succeeds after; a stream open across it fails at its next chunk",
    run: async (h) => {
      const target = h.fresh();
      const c = clock();
      const seen: string[] = [];
      const db = createRuntime(new Connection(rawOver(await h.open(target, "create"), { seen }), "create"), { metadata: META, wrapped: WRAPPED });
      const vault = new SqliteVault(db, { now: c.now });
      const big = bytesOf(2 * MIB + 3, 6);
      const bigCid = cidOf(big);
      await vault.vault.commit([{ cid: bigCid, source: big }], [draft([bigCid])]);
      await assertRejects(() => h.open(target, "readwrite"), "DatabaseBusy", "a second open while the vault is open");
      const stream = (await vault.vault.objects.open(bigCid)) as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      assertEqual(((await reader.read()).value as Uint8Array).length, MIB, "the first chunk before the close");
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const source = (async function* () {
        yield HELLO.slice(0, 1);
        await gate;
        yield HELLO.slice(1);
      })();
      const inFlight = vault.vault.commit([{ cid: HELLO_CID, source }], [draft([HELLO_CID])]);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const closing = vault.close();
      await assertRejects(() => vault.vault.commit([], [draft([bigCid])]), "VaultClosed", "a commit after close");
      await assertRejects(() => all(vault.vault.events.scan()), "VaultClosed", "a read after close");
      await assertRejects(() => vault.local.options.keys(), "VaultClosed", "local state after close");
      const mark = seen.length;
      await assertRejects(() => vault.keystore.read(), "VaultClosed", "a keystore read after close");
      await assertRejects(() => vault.keystore.rewrap(REWRAPPED), "VaultClosed", "a rewrap after close");
      assert(!seen.slice(mark).some((sql) => sql.includes("keystore")), "neither reached the keystore table");
      assertEqual(vault.stopped?.name, "VaultClosed", "stopped by the close");
      resume();
      assertEqual((await inFlight).length, 1, "the commit admitted before the close lands");
      await closing;
      await vault.close();
      let failed = false;
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch (err) {
        failed = err instanceof Error;
      }
      assert(failed, "the stream open across the close fails");
      const { vault: again } = await reopen(h, target, c.now);
      try {
        assertEqual((await all(again.vault.events.scan())).length, 2, "both commits after the reopen");
      } finally {
        await again.close();
      }
    },
  },
];
