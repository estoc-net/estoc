/**
 * The SQLite object store on whatever the platform's driver is, as
 * cases free of any test framework: run over `node:sqlite` by
 * `objects.test.ts` and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. What the conformance suite cannot see —
 * the rows a put leaves, a runtime reopened, a preparation staged
 * beside a read, damage under the store, a repair rolled back — where
 * the two platforms' SQLite must agree.
 */

import { sha256 } from "@noble/hashes/sha2";

import {
  SqliteObjectStore,
  chunksOf,
  createRuntime,
  openInspector,
  openRuntime,
  rawCidFromDigest,
  sortCids,
  type Cid,
  type OpenMode,
  type SqliteDriver,
} from "../../../src/v3/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { assert, assertBytes, assertEqual, assertRejects } from "./driver-cases.js";

export interface ObjectHarness {
  /** A target no database exists at yet. */
  fresh(): string;
  open(target: string, mode: OpenMode): Promise<SqliteDriver>;
}

export interface ObjectCase {
  name: string;
  run(harness: ObjectHarness): Promise<string | void>;
}

const MIB = 1024 * 1024;

/** `n` deterministic bytes from `seed`. */
function bytesOf(n: number, seed: number): Uint8Array {
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

function cidOf(bytes: Uint8Array): Cid {
  return rawCidFromDigest(sha256(bytes)).text as Cid;
}

async function* chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

async function listed(store: SqliteObjectStore): Promise<Cid[]> {
  const out: Cid[] = [];
  for await (const cid of store.list()) out.push(cid);
  return out;
}

function rows(driver: SqliteDriver, sql: string, ...params: (string | number | Uint8Array)[]): Record<string, unknown>[] {
  const statement = driver.prepare(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

function exec(driver: SqliteDriver, sql: string, ...params: (string | number | Uint8Array)[]): void {
  const statement = driver.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

/** Flips one byte of the first chunk of `cid`, as a bad sector would. */
function corrupt(driver: SqliteDriver, cid: Cid): void {
  const [row] = rows(driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = 0", cid);
  const bytes = new Uint8Array(row?.["bytes"] as Uint8Array);
  bytes[0] = (bytes[0] as number) ^ 0x01;
  exec(driver, "UPDATE object_chunks SET bytes = ? WHERE cid = ? AND chunk_no = 0", bytes, cid);
}

async function expectDamaged(store: SqliteObjectStore, cid: Cid, what: string): Promise<void> {
  await assertRejects(() => store.has(cid), "DamagedObject", `has ${what}`);
  await assertRejects(() => store.stat(cid), "DamagedObject", `stat ${what}`);
  await assertRejects(() => store.open(cid), "DamagedObject", `open ${what}`);
  await assertRejects(() => store.read(cid, MIB), "DamagedObject", `read ${what}`);
  await assertRejects(() => listed(store), "DamagedObject", `list ${what}`);
}

export const objectCases: ObjectCase[] = [
  {
    name: "an object put in arbitrary chunks is held as 1 MiB chunks numbered from zero, the last shorter, and is read back after a reopen; an empty object has no chunk",
    run: async (h) => {
      const target = h.fresh();
      const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db);
      const bytes = bytesOf(2 * MIB + 12_345, 1);
      const cid = cidOf(bytes);
      const info = await store.putRaw(chunked(bytes, 300_007));
      assertEqual(info, { cid, codec: "raw", size: bytes.length }, "the info");
      assertEqual(rows(db.driver, "SELECT chunk_no, length(bytes) AS n FROM object_chunks WHERE cid = ? ORDER BY chunk_no", cid), [
        { chunk_no: 0, n: MIB },
        { chunk_no: 1, n: MIB },
        { chunk_no: 2, n: 12_345 },
      ], "the chunks");
      assertEqual(rows(db.driver, "SELECT size FROM objects WHERE cid = ?", cid), [{ size: bytes.length }], "the size");
      const empty = await store.putRaw(new Uint8Array(0));
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM object_chunks WHERE cid = ?", empty.cid), [{ n: 0 }], "no chunk for the empty object");
      assertEqual(rows(db.driver, "SELECT name FROM sqlite_master WHERE name LIKE '%staging%'"), [], "nothing of the staging in the vault's own schema");
      db.close();
      const again = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        const reopened = new SqliteObjectStore(again);
        assertEqual(await reopened.stat(cid), info, "stat after a reopen");
        assertBytes(await drain((await reopened.open(cid)) as ReadableStream<Uint8Array>), bytes, "the bytes after a reopen");
        assertBytes((await reopened.read(empty.cid, 0)) as Uint8Array, new Uint8Array(0), "the empty object after a reopen");
        assertEqual(await reopened.damaged(), [], "no damage");
      } finally {
        again.close();
      }
    },
  },
  {
    name: "a preparation is staged where no read sees it and lands with the transaction it publishes in, or not at all",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db, { chunkBytes: 4 });
      const bytes = bytesOf(10, 2);
      const cid = cidOf(bytes);
      const prepared = store.prepare();
      await prepared.putObject(cid, bytes);
      assert(await prepared.has(cid), "prepared here counts as present to the preparation");
      assertEqual(await store.has(cid), false, "not to the store");
      assertEqual(await store.stat(cid), null, "nor its metadata");
      assertEqual(await listed(store), [], "nor in the list");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 0 }], "no chunk in the vault");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 3 }], "three staged in the temporary database");
      let published = false;
      try {
        db.driver.transaction("immediate", () => {
          prepared.publish();
          published = rows(db.driver, "SELECT count(*) AS n FROM object_chunks")[0]?.["n"] === 3;
          throw new Error("the commit fails after publishing");
        });
      } catch (err) {
        assert(err instanceof Error && err.message === "the commit fails after publishing", "the throw comes back");
      }
      assert(published, "publish moved the chunks inside the transaction");
      assertEqual(await store.has(cid), false, "rolled back: absent");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 3 }], "the staging is back too");
      prepared.discard();
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "discarded");
      const again = store.prepare();
      await again.putObject(cid, chunked(bytes, 3));
      db.driver.transaction("immediate", () => again.publish());
      again.settle();
      again.discard();
      assertEqual(await store.stat(cid), { cid, codec: "raw", size: 10 }, "published");
      assertBytes((await store.read(cid, 10)) as Uint8Array, bytes, "and read back");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "nothing staged after");
      db.close();
    },
  },
  {
    name: "bytes that no longer hash to the CID are damage every read and presence check reports until a verified put replaces them; a repair rolled back keeps the old bytes and the damage",
    run: async (h) => {
      const target = h.fresh();
      const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db, { chunkBytes: 4 });
      const bytes = bytesOf(10, 3);
      const cid = cidOf(bytes);
      await store.putRaw(bytes);
      const other = (await store.putRaw(bytesOf(10, 4))).cid;
      corrupt(db.driver, cid);
      assert(await store.has(cid), "nothing has looked yet");
      await assertRejects(() => store.read(cid, 10), "DamagedObject", "the read finds it");
      await expectDamaged(store, cid, "once known");
      assertEqual((await store.damaged()).map((d) => d.where), [`objects/${cid}`], "reported");
      assertBytes((await store.read(other, 10)) as Uint8Array, bytesOf(10, 4), "the other object reads");
      await assertRejects(() => store.putObject(cid, bytesOf(10, 5)), "DigestMismatch", "wrong bytes under the CID");
      await expectDamaged(store, cid, "after a refused repair");
      const prepared = store.prepare();
      await prepared.putObject(cid, bytes);
      try {
        db.driver.transaction("immediate", () => {
          prepared.publish();
          throw new Error("rolled back");
        });
      } catch {
        // the repair is rolled back
      }
      prepared.discard();
      await expectDamaged(store, cid, "after a rolled-back repair");
      const [chunk] = rows(db.driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = 0", cid);
      assert(((chunk?.["bytes"] as Uint8Array)[0] as number) !== (bytes[0] as number), "the old, corrupt bytes are still there");
      assertEqual(await store.putObject(cid, chunked(bytes, 3)), { cid, codec: "raw", size: 10 }, "the repair");
      assertBytes((await store.read(cid, 10)) as Uint8Array, bytes, "sound again");
      assertEqual(await listed(store), sortCids([cid, other]), "listed again");
      assertEqual((await store.damaged()).length, 0, "no damage known");
      corrupt(db.driver, cid);
      await assertRejects(() => store.read(cid, 10), "DamagedObject", "damaged again");
      db.close();
      const again = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        const reopened = new SqliteObjectStore(again);
        assert(await reopened.has(cid), "damage is not persisted: a reopen finds the object until it reads it");
        await assertRejects(() => reopened.read(cid, 10), "DamagedObject", "and finds the damage again");
      } finally {
        again.close();
      }
    },
  },
  {
    name: "a chunk missing, a size that does not add up or a chunk past the size is damage; the rest still read",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db, { chunkBytes: 4 });
      const objects = [1, 2, 3, 4].map((seed) => bytesOf(10, seed + 10));
      const [missing, resized, extra, sound] = (await Promise.all(objects.map((bytes) => store.putRaw(bytes)))).map((info) => info.cid) as [Cid, Cid, Cid, Cid];
      exec(db.driver, "DELETE FROM object_chunks WHERE cid = ? AND chunk_no = 1", missing);
      exec(db.driver, "UPDATE objects SET size = 9 WHERE cid = ?", resized);
      exec(db.driver, "INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, 3, x'00')", extra);
      for (const [cid, what] of [
        [missing, "a chunk missing"],
        [resized, "the size changed"],
        [extra, "a chunk past the size"],
      ] as const) {
        await assertRejects(() => store.read(cid, 10), "DamagedObject", `${what}: read`);
        await expectDamaged(store, cid, what);
      }
      const damage = await store.damaged();
      assertEqual(damage.map((d) => d.where).sort(), [missing, resized, extra].map((cid) => `objects/${cid}`).sort(), "each reported");
      assert(damage.some((d) => /1 chunk\(s\) hold 4 bytes, not the object's 10/.test(d.error)), "the missing chunk ends the walk: what was read before it is named");
      assert(damage.some((d) => /run past the object's 9 bytes/.test(d.error)), "the resized object by its chunks running past");
      assertBytes((await store.read(sound, 10)) as Uint8Array, objects[3] as Uint8Array, "the sound object");
      db.close();
    },
  },
  {
    name: "collection deletes the unkept, damaged among them, keeps a damaged held object with its damage, and a stream open on a removed object fails explicitly",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db, { chunkBytes: 4 });
      const keptDamaged = (await store.putRaw(bytesOf(10, 21))).cid;
      const goneDamaged = (await store.putRaw(bytesOf(10, 22))).cid;
      const kept = (await store.putRaw(bytesOf(10, 23))).cid;
      const gone = (await store.putRaw(bytesOf(10, 24))).cid;
      corrupt(db.driver, keptDamaged);
      corrupt(db.driver, goneDamaged);
      await assertRejects(() => store.read(keptDamaged, 10), "DamagedObject", "found");
      await assertRejects(() => store.read(goneDamaged, 10), "DamagedObject", "found");
      const reader = ((await store.open(gone)) as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      assertEqual(first.done, false, "the first chunk is out");
      const { removed } = await store.collect([kept, keptDamaged]);
      assertEqual(removed, sortCids([gone, goneDamaged]), "removed: the unkept, the damaged one among them");
      await assertRejects(() => reader.read(), "InterruptedRead", "the stream open on a removed object");
      assertEqual(await store.has(gone), false, "absent");
      assertEqual(await store.has(goneDamaged), false, "absent, its damage no longer reported as damage");
      await expectDamaged(store, keptDamaged, "the kept damaged object");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 6 }], "the chunks of the two kept objects");
      assertEqual((await store.damaged()).map((d) => d.where), [`objects/${keptDamaged}`], "only the kept damage remains");
      await store.putObject(keptDamaged, bytesOf(10, 21));
      assertEqual(await listed(store), sortCids([kept, keptDamaged]), "both list once repaired");
      db.close();
    },
  },
  {
    name: "an inspector's store reads and refuses every write before reading a source",
    run: async (h) => {
      const target = h.fresh();
      const made = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const bytes = bytesOf(10, 31);
      const cid = (await new SqliteObjectStore(made).putRaw(bytes)).cid;
      made.close();
      const db = openInspector(await h.open(target, "readwrite"));
      try {
        const store = new SqliteObjectStore(db);
        assertBytes((await store.read(cid, 10)) as Uint8Array, bytes, "reads");
        assertEqual(await listed(store), [cid], "lists");
        let pulled = false;
        async function* source(): AsyncIterable<Uint8Array> {
          pulled = true;
          yield bytes;
        }
        await assertRejects(() => store.putRaw(source()), "ReadOnlyVault", "putRaw");
        await assertRejects(() => store.putObject(cid, source()), "ReadOnlyVault", "putObject");
        await assertRejects(() => store.prepare().putObject(cid, source()), "ReadOnlyVault", "a preparation's putObject");
        await assertRejects(() => store.collect([]), "ReadOnlyVault", "collect");
        assert(!pulled, "no source was read");
        assert(await store.has(cid), "still there");
      } finally {
        db.close();
      }
    },
  },
];
