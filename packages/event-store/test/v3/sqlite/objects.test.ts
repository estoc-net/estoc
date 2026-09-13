/**
 * The SQLite object store over `node:sqlite`: the conformance suite in
 * memory and on files, the object cases, and what only a database on
 * disk can show — the staging beside a read, a stream across a repair,
 * a key that is no CID, statements not held, another process's crash.
 * The suite's extent size is not a setting here: every object is cut
 * at the format's chunk size, so a chunk boundary inside an object
 * takes an object of more than a mebibyte.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "../../../src/node.js";
import {
  CHUNK_BYTES,
  DamagedObject,
  InterruptedRead,
  SqliteObjectStore,
  StagingFull,
  createRuntime,
  openRuntime,
  sortCids,
  type Cid,
  type OpenMode,
  type RuntimeDatabase,
  type SqliteDriver,
  type SqlValue,
} from "../../../src/v3/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { all, expectBytes } from "../suite/helpers.js";
import { bytesOf, chunked, cidOf, drain, objectStoreSuite, type OpenObjectOptions } from "../suite/object-store-suite.js";
import { objectCases } from "./object-cases.js";
import { objectStoreOpener } from "./suite-openers.js";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-objects-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (target: string, mode: OpenMode): SqliteDriver => openNodeSqlite(target, { mode });

interface Made {
  db: RuntimeDatabase;
  store: SqliteObjectStore;
}

function create(target: string, options: OpenObjectOptions = {}): Made {
  const db = createRuntime(open(target, "create"), { metadata: META, wrapped: WRAPPED });
  const store = new SqliteObjectStore(db, options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes });
  return { db, store };
}

async function reopen(target: string): Promise<Made> {
  const db = await openRuntime(open(target, "readwrite"), { anchor: ANCHOR });
  return { db, store: new SqliteObjectStore(db) };
}

function rows(driver: SqliteDriver, sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
  const statement = driver.prepare(sql);
  try {
    return statement.all(...params);
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

/** Flips one byte of the first chunk of `cid` in place, as a bad sector would. */
async function corrupt(driver: SqliteDriver, cid: Cid): Promise<void> {
  const [row] = rows(driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = 0", cid);
  if (row === undefined) throw new Error(`${cid} has no bytes to damage`);
  const bytes = new Uint8Array(row["bytes"] as Uint8Array);
  bytes[0] = (bytes[0] as number) ^ 0x01;
  exec(driver, "UPDATE object_chunks SET bytes = ? WHERE cid = ? AND chunk_no = 0", bytes, cid);
}

/** How many statements `driver` still holds: what a leak of one per call would grow. */
function retained(driver: SqliteDriver): number {
  return (driver as unknown as { statements: Set<unknown> }).statements.size;
}

const staged = (driver: SqliteDriver): number => Number(rows(driver, "SELECT count(*) AS n FROM temp.staging_chunks")[0]?.["n"]);

objectStoreSuite("SqliteObjectStore in memory", objectStoreOpener({ fresh: () => ":memory:", open }));
objectStoreSuite("SqliteObjectStore on a file", objectStoreOpener({ fresh, open }));

describe("the object cases on node:sqlite files", () => {
  for (const c of objectCases) {
    it(c.name, async () => {
      const note = await c.run({ fresh, open: async (target, mode) => open(target, mode) });
      if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
    });
  }
});

describe("SqliteObjectStore", () => {
  it("the chunk size is the format's mebibyte; a bound that is not a non-negative integer is refused", () => {
    expect(CHUNK_BYTES).toBe(1 << 20);
    const db = createRuntime(open(":memory:", "create"), { metadata: META, wrapped: WRAPPED });
    expect(() => new SqliteObjectStore(db, { maxObjectBytes: -1 })).toThrow(RangeError);
    expect(() => new SqliteObjectStore(db, { maxStagedBytes: 1.5 })).toThrow(RangeError);
    db.close();
  });

  it("stages a source as it streams — one row in the temporary database per chunk's worth of bytes, none in the vault, nothing a read sees — and drops the staging when the source fails", async () => {
    const { db, store } = create(":memory:");
    const bytes = bytesOf(2 * CHUNK_BYTES + 2, 1);
    const cid = cidOf(bytes);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 2 * CHUNK_BYTES + 1);
      await gate;
      yield bytes.subarray(2 * CHUNK_BYTES + 1);
    }
    const put = store.putObject(cid, slow());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(staged(db.driver)).toBe(2); // two chunks sealed, one byte waiting
    expect(rows(db.driver, "SELECT count(*) AS n FROM object_chunks")).toEqual([{ n: 0 }]);
    expect(await store.has(cid)).toBe(false);
    expect(await all(store.list())).toEqual([]);
    release();
    expect(await put).toEqual({ cid, codec: "raw", size: bytes.length });
    expect(staged(db.driver)).toBe(0);
    expect(rows(db.driver, "SELECT chunk_no, length(bytes) AS n FROM object_chunks ORDER BY chunk_no")).toEqual([
      { chunk_no: 0, n: CHUNK_BYTES },
      { chunk_no: 1, n: CHUNK_BYTES },
      { chunk_no: 2, n: 2 },
    ]);
    async function* failing(): AsyncIterable<Uint8Array> {
      yield bytesOf(CHUNK_BYTES + 9, 2);
      throw new Error("disk gone");
    }
    await expect(store.putRaw(failing())).rejects.toThrow("disk gone");
    expect(staged(db.driver)).toBe(0);
    await expect(store.putObject(cid, bytesOf(10, 3))).rejects.toThrow(/hash to/);
    expect(staged(db.driver)).toBe(0);
    expect(await all(store.list())).toEqual([cid]);
    db.close();
  });

  it("bounds what is staged across every preparation in flight: the put that would pass the bound is refused before the chunk that would, nothing of it staged, and what the others staged counts until they publish or are dropped", async () => {
    const { db } = create(":memory:", { maxObjectBytes: 10 * CHUNK_BYTES });
    const bounded = new SqliteObjectStore(db, { maxStagedBytes: 3 * CHUNK_BYTES });
    const a = bytesOf(2 * CHUNK_BYTES, 61);
    const first = bounded.prepare();
    await first.putObject(cidOf(a), a);
    let pulled = 0;
    async function* counting(bytes: Uint8Array): AsyncIterable<Uint8Array> {
      for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
        pulled += 1;
        yield bytes.subarray(at, at + CHUNK_BYTES);
      }
    }
    const b = bytesOf(2 * CHUNK_BYTES, 62);
    const second = bounded.prepare();
    await expect(second.putObject(cidOf(b), counting(b))).rejects.toBeInstanceOf(StagingFull);
    expect(pulled).toBe(2); // the first chunk fit; the second would not, and no more is read
    expect(staged(db.driver)).toBe(2);
    await expect(bounded.putRaw(bytesOf(4 * CHUNK_BYTES, 63))).rejects.toThrow(/3145728 bytes are staged .* past the 3145728-byte staging bound/);
    expect(staged(db.driver)).toBe(2);
    expect((await second.putObject(cidOf(bytesOf(CHUNK_BYTES, 64)), bytesOf(CHUNK_BYTES, 64))).size).toBe(CHUNK_BYTES); // exactly the bound
    second.discard();
    expect(staged(db.driver)).toBe(2);
    db.driver.transaction("immediate", () => first.publish());
    first.settle();
    expect(staged(db.driver)).toBe(0);
    expect((await bounded.putRaw(bytesOf(3 * CHUNK_BYTES, 65))).size).toBe(3 * CHUNK_BYTES);
    db.close();
  });

  it("a preparation dropped unpublished leaves the store as it was; a second staging of one CID replaces the first", async () => {
    const { db, store } = create(":memory:");
    const bytes = bytesOf(10, 4);
    const cid = cidOf(bytes);
    const prepared = store.prepare();
    await prepared.putObject(cid, bytes);
    await prepared.putObject(cid, chunked(bytes, [5]));
    expect(staged(db.driver)).toBe(1); // the first staging is gone
    prepared.discard();
    expect(staged(db.driver)).toBe(0);
    expect(await store.has(cid)).toBe(false);
    expect(() => prepared.publish()).toThrow(/inside the transaction/);
    expect(db.driver.inTransaction).toBe(false);
    db.close();
  });

  it("a stream open on an object a repair replaces fails at its next chunk, explicitly, and is not damage; a stream opened after reads the new bytes", async () => {
    const { db, store } = create(":memory:");
    const bytes = bytesOf(CHUNK_BYTES + 5, 5);
    const cid = (await store.putRaw(bytes)).cid;
    const other = ((await store.open(cid)) as ReadableStream<Uint8Array>).getReader();
    const stale = ((await store.open(cid)) as ReadableStream<Uint8Array>).getReader();
    await stale.read();
    await corrupt(db.driver, cid);
    await expect(store.read(cid, bytes.length)).rejects.toBeInstanceOf(DamagedObject);
    expect(await store.putObject(cid, bytes)).toEqual({ cid, codec: "raw", size: bytes.length });
    await expect(stale.read()).rejects.toBeInstanceOf(InterruptedRead);
    await expect(other.read()).rejects.toBeInstanceOf(InterruptedRead);
    expect(await store.damaged()).toEqual([]);
    expect(await store.has(cid)).toBe(true);
    expectBytes((await drain((await store.open(cid)) as ReadableStream<Uint8Array>)).bytes, bytes);
    expectBytes(await store.read(cid, bytes.length), bytes);
    db.close();
  });

  it("a stream that finds the digest wrong on the object it opened on marks it damaged; one on an object collected meanwhile does not", async () => {
    const { db, store } = create(":memory:");
    const bytes = bytesOf(CHUNK_BYTES + 5, 6);
    const cid = (await store.putRaw(bytes)).cid;
    const reader = ((await store.open(cid)) as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await corrupt(db.driver, cid);
    const parts = [];
    let failed: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
    } catch (err) {
      failed = err;
    }
    expect(failed).toBeUndefined(); // this reader took the first chunk before it was damaged, and the rest is sound: its digest is right
    expect(parts).toHaveLength(1);
    const again = ((await store.open(cid)) as ReadableStream<Uint8Array>).getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await again.read();
          if (done) return;
        }
      })()
    ).rejects.toBeInstanceOf(DamagedObject);
    expect((await store.damaged()).map((d) => d.where)).toEqual([`objects/${cid}`]);
    // an object collected under an open stream: the stream fails, and the store knows no damage of it
    const sound = (await store.putRaw(bytesOf(CHUNK_BYTES + 7, 7))).cid;
    const open = ((await store.open(sound)) as ReadableStream<Uint8Array>).getReader();
    await open.read();
    expect(await store.collect([cid])).toEqual({ removed: [sound] });
    await expect(open.read()).rejects.toBeInstanceOf(InterruptedRead);
    expect((await store.damaged()).map((d) => d.where)).toEqual([`objects/${cid}`]);
    db.close();
  });

  it("what a reopen finds is what was accepted; damage is found again by the read that meets it, and a repair lays the object out anew", async () => {
    const file = fresh();
    const made = create(file);
    const bytes = bytesOf(CHUNK_BYTES + 5, 8);
    const cid = (await made.store.putRaw(bytes)).cid;
    await corrupt(made.db.driver, cid);
    await expect(made.store.read(cid, bytes.length)).rejects.toBeInstanceOf(DamagedObject);
    made.db.close();
    const again = await reopen(file);
    expect(await again.store.has(cid)).toBe(true);
    expect(await again.store.damaged()).toEqual([]);
    await expect(again.store.read(cid, bytes.length)).rejects.toBeInstanceOf(DamagedObject);
    expect(await again.store.putObject(cid, chunked(bytes, [3, 700_000]))).toEqual({ cid, codec: "raw", size: bytes.length });
    expect(rows(again.db.driver, "SELECT chunk_no, length(bytes) AS n FROM object_chunks ORDER BY chunk_no")).toEqual([
      { chunk_no: 0, n: CHUNK_BYTES },
      { chunk_no: 1, n: 5 },
    ]);
    expectBytes(await again.store.read(cid, bytes.length), bytes);
    again.db.close();
  });

  it("a key that is no CID is damage named by its rowid: list fails on it, collect removes it without naming it, and a read of a proper CID is untouched", async () => {
    const { db, store } = create(":memory:");
    const cid = (await store.putRaw(bytesOf(10, 9))).cid;
    exec(db.driver, "INSERT INTO objects (cid, size) VALUES ('not-a-cid', 0)");
    exec(db.driver, "INSERT INTO objects (cid, size) VALUES (CAST(x'6100' AS TEXT), 0)");
    await expect(all(store.list())).rejects.toBeInstanceOf(DamagedObject);
    const [first] = await store.damaged();
    expect(first?.where).toMatch(/^objects\/rowid [23]$/); // list fails on the first key it meets that is no CID
    expect(first?.error).toMatch(first?.where === "objects/rowid 2" ? /not-a-cid/ : /NUL/);
    expect(await store.has(cid)).toBe(true);
    expect(await store.collect([cid])).toEqual({ removed: [] });
    expect(rows(db.driver, "SELECT count(*) AS n FROM objects")).toEqual([{ n: 1 }]);
    expect(await all(store.list())).toEqual([cid]);
    expect(await store.damaged()).toEqual([]);
    db.close();
  });

  it("collect is one transaction: a keep set is checked before it, and a failure inside it deletes nothing", async () => {
    const { db, store } = create(":memory:");
    const cids = sortCids(await Promise.all([1, 2, 3].map(async (seed) => (await store.putRaw(bytesOf(10, 30 + seed))).cid)));
    db.driver.exec(`CREATE TRIGGER local_refuse BEFORE DELETE ON objects WHEN OLD.cid = '${cids[2] as string}' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    await expect(store.collect([])).rejects.toThrow(/refused/);
    expect(db.driver.inTransaction).toBe(false);
    expect(await all(store.list())).toEqual(cids);
    exec(db.driver, "DROP TRIGGER local_refuse");
    expect(await store.collect([cids[0] as Cid])).toEqual({ removed: cids.slice(1) });
    db.close();
  });

  it("holds no statement past a call", async () => {
    const { db, store } = create(":memory:");
    expect(retained(db.driver)).toBe(0);
    for (let i = 0; i < 50; i++) {
      const bytes = bytesOf(10, 100 + i);
      const { cid } = await store.putRaw(chunked(bytes, [3, 3]));
      await store.putObject(cid, bytes);
      await store.stat(cid);
      await store.has(cid);
      await store.read(cid, 10);
      await drain((await store.open(cid)) as ReadableStream<Uint8Array>);
      await all(store.list());
      const prepared = store.prepare();
      await prepared.putObject(cid, bytes);
      prepared.discard();
      await store.damaged();
      if (i % 10 === 9) await store.collect([]);
    }
    expect(retained(db.driver)).toBe(0);
    db.close();
  });

  it("a process that dies inside its acceptance leaves no object; one that committed leaves it whole", async () => {
    const file = fresh();
    const made = create(file);
    const before = (await made.store.putRaw(bytesOf(10, 40))).cid;
    made.db.close();
    const bytes = bytesOf(CHUNK_BYTES + 5, 41);
    const cid = cidOf(bytes);
    const payload = path.join(dir, "payload.bin");
    await writeFile(payload, bytes);
    await acceptInAnotherProcess(file, "die", cid, payload);
    const once = await reopen(file);
    expect(await all(once.store.list())).toEqual([before]);
    expect(rows(once.db.driver, "SELECT count(*) AS n FROM object_chunks")).toEqual([{ n: 1 }]);
    once.db.close();
    await acceptInAnotherProcess(file, "commit", cid, payload);
    const twice = await reopen(file);
    expect(await all(twice.store.list())).toEqual(sortCids([before, cid]));
    expectBytes(await twice.store.read(cid, bytes.length), bytes);
    expect(await twice.store.damaged()).toEqual([]);
    twice.db.close();
  });
});

/**
 * Another process writing the rows an acceptance writes, with
 * `node:sqlite` alone: the object and its chunks, in one transaction.
 * `die` exits before COMMIT — the interruption a crash is, as far as
 * the file can tell; `commit` commits and closes. The bytes come by
 * file: an argument has a length limit a chunk is over.
 */
const OTHER_PROCESS = `
  const { DatabaseSync } = require("node:sqlite");
  const { readFileSync } = require("node:fs");
  const [file, how, cid, payload] = process.argv.slice(1);
  const bytes = readFileSync(payload);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE");
  db.prepare("INSERT INTO objects (cid, size) VALUES (?, ?)").run(cid, bytes.length);
  const insert = db.prepare("INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, ?, ?)");
  for (let at = 0, no = 0; at < bytes.length; at += 1048576, no += 1) insert.run(cid, no, bytes.subarray(at, at + 1048576));
  if (how === "commit") {
    db.exec("COMMIT");
    db.close();
  }
  process.exit(0);
`;

async function acceptInAnotherProcess(file: string, how: "die" | "commit", cid: Cid, payload: string): Promise<void> {
  const child = spawn(process.execPath, ["--no-warnings", "-e", OTHER_PROCESS, file, how, cid, payload], { stdio: ["ignore", "pipe", "pipe"] });
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
