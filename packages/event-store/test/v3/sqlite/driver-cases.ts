/**
 * What every SQLite driver adapter must do, as cases free of any test
 * framework: run over `node:sqlite` on a file and in memory by
 * `node-driver.test.ts`, and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. A case gets a harness that opens fresh
 * targets; the cases that need a target to outlive a connection say so
 * and are skipped by a harness that has none.
 */

import { sha256 } from "@noble/hashes/sha2";

import { SqliteError } from "../../../src/v3/errors.js";
import { Connection, decodeText, type OpenMode, type RawConnection, type SqliteDriver, type SqlValue } from "../../../src/v3/sqlite/driver.js";

export interface DriverHarness {
  /** A target no database exists at yet. */
  fresh(): string;
  open(target: string, mode: OpenMode): Promise<SqliteDriver>;
  /** Whether a target outlives the connection that made it; `:memory:` does not. */
  persistent: boolean;
}

export interface DriverCase {
  name: string;
  needsPersistence?: true;
  /** Returns a note for the report — a timing — or nothing. */
  run(harness: DriverHarness): Promise<string | void>;
}

export const MIB = 1024 * 1024;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

export function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  if (actual.length !== expected.length) throw new Error(`${what}: expected ${expected.length} bytes, got ${actual.length}`);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${what}: byte ${i} is ${actual[i]}, expected ${expected[i]}`);
  }
}

export function assertThrows(fn: () => unknown, name: string, what: string): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error && err.name === name) return err;
    throw new Error(`${what}: threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}, expected ${name}`);
  }
  throw new Error(`${what}: did not throw, expected ${name}`);
}

export async function assertRejects(fn: () => Promise<unknown>, name: string, what: string): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && err.name === name) return err;
    throw new Error(`${what}: rejected with ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}, expected ${name}`);
  }
  throw new Error(`${what}: did not reject, expected ${name}`);
}

/** Bytes whose every position is decided by `seed`, so a mismatch names where. */
export function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

/** What a case puts between the driver's shared layer and the platform. */
export interface Interposed {
  /** Whether a `COMMIT` fails with SQLite's I/O error. */
  failCommit?: () => boolean;
  /** Whether a failing `COMMIT` has in fact landed before it fails. */
  landed?: boolean;
  /** Every SQL text executed or prepared, in order. */
  seen?: string[];
}

/** `inner` as the raw connection of another `Connection`, with `hooks` between the two. */
export function rawOver(inner: SqliteDriver, hooks: Interposed = {}): RawConnection {
  return {
    version: inner.version,
    exec: (sql) => {
      hooks.seen?.push(sql);
      if (sql === "COMMIT" && hooks.failCommit?.() === true) {
        if (hooks.landed === true) inner.exec(sql);
        throw new SqliteError(10, "disk I/O error");
      }
      inner.exec(sql);
    },
    prepare: (sql) => {
      hooks.seen?.push(sql);
      const statement = inner.prepare(sql);
      return {
        run: (params) => statement.run(...params).changes,
        rows: (params) => statement.iterate(...params),
        finalize: () => statement.finalize(),
      };
    },
    close: () => inner.close(),
  };
}

async function withFresh(harness: DriverHarness, mode: OpenMode, body: (db: SqliteDriver, target: string) => Promise<void> | void): Promise<void> {
  const target = harness.fresh();
  const db = await harness.open(target, mode);
  try {
    await body(db, target);
  } finally {
    db.close();
  }
}

function count(db: SqliteDriver, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

export const driverCases: DriverCase[] = [
  {
    name: "the platform's SQLite is 3.47 or later, with strict tables, RETURNING and JSON functions",
    run: (h) =>
      withFresh(h, "create", (db) => {
        const [major = 0, minor = 0] = db.version.split(".").map(Number);
        assert(major > 3 || (major === 3 && minor >= 47), `sqlite ${db.version} is older than 3.47`);
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT");
        const inserted = db.prepare("INSERT INTO t (body) VALUES (?) RETURNING id").get("x");
        assertEqual(inserted, { id: 1 }, "RETURNING");
        const extract = db.prepare("SELECT json_extract(CAST(? AS TEXT), '$.v') AS v, json_type(CAST(? AS TEXT), '$.v') AS t");
        const json = (v: string): [string, string] => [`{"v":${v}}`, `{"v":${v}}`];
        assertEqual(extract.get(...json("1")), { v: 1, t: "integer" }, "json integer");
        assertEqual(extract.get(...json("1.5")), { v: 1.5, t: "real" }, "json real");
        assertEqual(extract.get(...json('"1"')), { v: "1", t: "text" }, "json text");
        assertEqual(extract.get(...json("true")), { v: 1, t: "true" }, "json true reads as 1 through json_extract: primitive filters stay in JavaScript");
        assertEqual(extract.get(...json("null")), { v: null, t: "null" }, "json null");
      }),
  },
  {
    name: "text round-trips exactly",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, s TEXT NOT NULL) STRICT");
        const samples = ["", "plain", "naïve café", "日本語テキスト", "emoji 🎉 astral 𝔘𝔫𝔦𝔠𝔬𝔡𝔢", "e\u0301 combining", "\u200b zero width", "line\nbreak\ttab", "'quote' \"double\" \\ backslash", "\uFFFD replacement"];
        const insert = db.prepare("INSERT INTO t (k, s) VALUES (?, ?)");
        samples.forEach((s, i) => insert.run(i, s));
        const rows = db.prepare("SELECT s FROM t ORDER BY k").all().map((r) => r["s"]);
        assertEqual(rows, samples, "text back");
        assertEqual(db.prepare("SELECT length(s) AS n FROM t WHERE k = 4").get(), { n: [...(samples[4] as string)].length }, "length counts code points");
      }),
  },
  {
    name: "a string with a NUL or an unpaired surrogate is refused before the statement runs",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (s TEXT NOT NULL) STRICT");
        const insert = db.prepare("INSERT INTO t (s) VALUES (?)");
        assertThrows(() => insert.run("a\u0000b"), "InvalidSqlValue", "NUL");
        assertThrows(() => insert.run(String.fromCharCode(0xd800)), "InvalidSqlValue", "lone high surrogate");
        assertThrows(() => insert.run(`x${String.fromCharCode(0xdc00)}y`), "InvalidSqlValue", "lone low surrogate");
        assertEqual(count(db, "t"), 0, "nothing written");
        insert.run("🎉");
        assertEqual(count(db, "t"), 1, "a paired surrogate is a code point and passes");
      }),
  },
  {
    name: "text read as its stored bytes decodes exactly or is refused: how text of a file another party wrote is checked",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, s TEXT NOT NULL) STRICT");
        db.exec("INSERT INTO t VALUES (1, 'naïve 🎉'), (2, ''), (3, CAST(X'610062' AS TEXT)), (4, CAST(X'EDA080' AS TEXT)), (5, CAST(X'EFBBBF61' AS TEXT)), (6, CAST(X'FF' AS TEXT))");
        const bytesOf = db.prepare("SELECT CAST(s AS BLOB) AS b FROM t WHERE k = ?");
        const text = (k: number): string => decodeText(bytesOf.get(k)?.["b"] as Uint8Array, "s");
        assertEqual(text(1), "naïve 🎉", "text back");
        assertEqual(text(2), "", "empty text back");
        assertEqual(db.prepare("SELECT length(CAST(s AS BLOB)) AS n FROM t WHERE k = 3").get(), { n: 3 }, "under the cast, the bytes past a NUL are all there");
        assertThrows(() => text(3), "InvalidSqlValue", "a NUL inside");
        assertThrows(() => text(4), "InvalidSqlValue", "an encoded surrogate is not UTF-8");
        assertEqual(text(5), "\uFEFFa", "a byte order mark is a character and stays");
        assertThrows(() => text(6), "InvalidSqlValue", "a stray byte");
      }),
  },
  {
    name: "bytes round-trip exactly and are copied at both boundaries",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, b BLOB NOT NULL) STRICT");
        const insert = db.prepare("INSERT INTO t (k, b) VALUES (?, ?)");
        const select = db.prepare("SELECT b FROM t WHERE k = ?");
        const sizes = [0, 1, 2, 255, 256, 4095, 4096, 65536, MIB - 1, MIB];
        sizes.forEach((n, i) => insert.run(i, pattern(n, n + 1)));
        sizes.forEach((n, i) => {
          const back = select.get(i)?.["b"] as Uint8Array;
          assert(back instanceof Uint8Array, `bytes of ${n} come back as Uint8Array`);
          assertBytes(back, pattern(n, n + 1), `bytes of ${n}`);
          assert(back.byteOffset === 0 && back.byteLength === back.buffer.byteLength, `bytes of ${n} own their buffer`);
        });
        const big = pattern(64, 7);
        const view = big.subarray(8, 24);
        insert.run(100, view);
        big.fill(0);
        assertBytes(select.get(100)?.["b"] as Uint8Array, pattern(64, 7).subarray(8, 24), "a view binds exactly its bytes, copied before the caller wipes them");
        const stored = select.get(100)?.["b"] as Uint8Array;
        stored.fill(1);
        assertBytes(select.get(100)?.["b"] as Uint8Array, pattern(64, 7).subarray(8, 24), "what came back was the caller's copy, not the store's");
        assertEqual(db.prepare("SELECT typeof(b) AS t, length(b) AS n FROM t WHERE k = 0").get(), { t: "blob", n: 0 }, "an empty blob is a blob of length zero");
      }),
  },
  {
    name: "integers in the safe range round-trip exactly, as integers",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, i INTEGER NOT NULL) STRICT");
        const samples = [0, 1, -1, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), -(2 ** 31) - 1, 2 ** 32, 2 ** 53 - 1, -(2 ** 53 - 1)];
        const insert = db.prepare("INSERT INTO t (k, i) VALUES (?, ?)");
        samples.forEach((i, k) => insert.run(k, i));
        const rows = db.prepare("SELECT i, typeof(i) AS t FROM t ORDER BY k").all();
        assertEqual(
          rows,
          samples.map((i) => ({ i, t: "integer" })),
          "integers back"
        );
        assertEqual(db.prepare("SELECT ? + 1 AS n").get(2 ** 53 - 2), { n: 2 ** 53 - 1 }, "arithmetic on a bound integer");
      }),
  },
  {
    name: "a number the driver cannot carry exactly is refused before the statement runs",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (v ANY) STRICT");
        const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
        for (const bad of [2 ** 53, -(2 ** 53), 2 ** 63, 1e300, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          assertThrows(() => insert.run(bad), "InvalidSqlValue", `${bad}`);
        }
        for (const bad of [123n, true, false, undefined, {}, [], new Date(0), Symbol("s"), () => 1] as unknown as SqlValue[]) {
          assertThrows(() => insert.run(bad), "InvalidSqlValue", `${typeof bad}`);
        }
        assertEqual(count(db, "t"), 0, "nothing written");
        assertThrows(() => db.prepare("SELECT ? AS v").get(2 ** 53), "InvalidSqlValue", "a query parameter too");
        insert.run(1.5);
        insert.run(-0.25);
        insert.run(1e-300);
        insert.run(Math.PI);
        assertEqual(
          db.prepare("SELECT v, typeof(v) AS t FROM t ORDER BY rowid").all(),
          [
            { v: 1.5, t: "real" },
            { v: -0.25, t: "real" },
            { v: 1e-300, t: "real" },
            { v: Math.PI, t: "real" },
          ],
          "finite non-integers bind as REAL; every double at or beyond 2^53 is integral and refused with the integers"
        );
      }),
  },
  {
    name: "a stored integer outside the safe range fails the read rather than rounding",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, i INTEGER NOT NULL) STRICT");
        db.exec("INSERT INTO t VALUES (1, 9007199254740993), (2, 9223372036854775807), (3, -9223372036854775807), (4, 9007199254740991)");
        const select = db.prepare("SELECT i FROM t WHERE k = ?");
        for (const k of [1, 2, 3]) assertThrows(() => select.get(k), "InvalidSqlValue", `row ${k}`);
        assertEqual(select.get(4), { i: 2 ** 53 - 1 }, "the safe one reads");
        assertThrows(() => db.prepare("SELECT i FROM t ORDER BY k").all(), "InvalidSqlValue", "all() meets it");
        assertEqual(db.prepare("SELECT CAST(i AS TEXT) AS s FROM t WHERE k = 2").get(), { s: "9223372036854775807" }, "the value is intact in SQLite");
        const seen: number[] = [];
        assertThrows(() => {
          for (const row of db.prepare("SELECT i FROM t WHERE k IN (4, 1) ORDER BY k DESC").iterate()) seen.push(row["i"] as number);
        }, "InvalidSqlValue", "iterate fails at the row that cannot cross");
        assertEqual(seen, [2 ** 53 - 1], "the rows before it were delivered");
        assertEqual(select.get(4), { i: 2 ** 53 - 1 }, "the statement is usable after the failed iteration");
      }),
  },
  {
    name: "null round-trips and typeof tells the stored classes apart",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v ANY) STRICT");
        const insert = db.prepare("INSERT INTO t (k, v) VALUES (?, ?)");
        insert.run(1, null);
        insert.run(2, "text");
        insert.run(3, 3);
        insert.run(4, 4.5);
        insert.run(5, new Uint8Array([5]));
        assertEqual(db.prepare("SELECT k, v, typeof(v) AS t FROM t WHERE k < 5 ORDER BY k").all(), [
          { k: 1, v: null, t: "null" },
          { k: 2, v: "text", t: "text" },
          { k: 3, v: 3, t: "integer" },
          { k: 4, v: 4.5, t: "real" },
        ], "classes");
        assertEqual(db.prepare("SELECT typeof(v) AS t FROM t WHERE k = 5").get(), { t: "blob" }, "blob class");
        assertEqual(db.prepare("SELECT v FROM t WHERE v IS NULL").all(), [{ v: null }], "null selects");
      }),
  },
  {
    name: "run reports changes, get the first row or undefined, all every row in order, iterate lazily and stoppably",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, s TEXT NOT NULL) STRICT");
        const insert = db.prepare("INSERT INTO t (k, s) VALUES (?, ?)");
        assertEqual(insert.run(1, "a"), { changes: 1 }, "one insert");
        assertEqual(insert.run(2, "b"), { changes: 1 }, "the statement binds afresh");
        insert.run(3, "c");
        assertEqual(db.prepare("UPDATE t SET s = upper(s) WHERE k > 1").run(), { changes: 2 }, "update changes");
        assertEqual(db.prepare("DELETE FROM t WHERE k > 100").run(), { changes: 0 }, "no change");
        assertEqual(db.prepare("SELECT s FROM t WHERE k = 99").get(), undefined, "no row");
        assertEqual(db.prepare("SELECT s FROM t ORDER BY k").all(), [{ s: "a" }, { s: "B" }, { s: "C" }], "all rows");
        assertEqual(db.prepare("SELECT s FROM t WHERE k > 99").all(), [], "no rows");
        const select = db.prepare("SELECT k, s FROM t ORDER BY k");
        const seen: number[] = [];
        for (const row of select.iterate()) {
          seen.push(row["k"] as number);
          if (seen.length === 2) break;
        }
        assertEqual(seen, [1, 2], "stopped after two");
        assertEqual(select.all().length, 3, "a returned iteration leaves the statement ready");
        const it = select.iterate();
        it.next();
        assertThrows(() => select.all(), "Error", "a second query while one is in flight");
        it.return?.();
        assertEqual(select.all().length, 3, "and after it is returned");
        const unstarted = select.iterate();
        unstarted.return?.();
        assertEqual(select.all().length, 3, "an iterator returned before its first row leaves the statement ready too");
        assertEqual(unstarted.next(), { done: true, value: undefined }, "and is over");
        const restarted = select.iterate();
        assertEqual(restarted.next().value?.["k"], 1, "the next iteration starts from the first row");
        restarted.return?.();
        assertEqual(select.get()?.["k"], 1, "so does the next get");
        select.finalize();
        assertThrows(() => select.all(), "Error", "a finalized statement");
        select.finalize();
      }),
  },
  {
    name: "a transaction commits as a whole, rolls back on a throw, and does not nest",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, s TEXT NOT NULL) STRICT");
        const insert = db.prepare("INSERT INTO t (k, s) VALUES (?, ?)");
        assert(!db.inTransaction, "not in a transaction");
        const value = db.transaction("immediate", () => {
          insert.run(1, "a");
          insert.run(2, "b");
          assert(db.inTransaction, "in the transaction");
          return count(db, "t");
        });
        assertEqual(value, 2, "the body's value comes back");
        assert(!db.inTransaction, "committed");
        assertEqual(count(db, "t"), 2, "both rows landed");
        const failure = new Error("stop");
        try {
          db.transaction("deferred", () => {
            insert.run(3, "c");
            assertEqual(count(db, "t"), 3, "visible inside");
            throw failure;
          });
          throw new Error("the throw did not propagate");
        } catch (err) {
          assert(err === failure, `the body's own error propagates, got ${String(err)}`);
        }
        assert(!db.inTransaction, "rolled back");
        assertEqual(count(db, "t"), 2, "the third row did not land");
        const refused = assertThrows(() => db.transaction("exclusive", () => insert.run(1, "dup")), "SqliteError", "a constraint failure inside");
        assertEqual((refused as { code?: number }).code, 1555, "the extended result code: SQLITE_CONSTRAINT_PRIMARYKEY");
        assertEqual(count(db, "t"), 2, "and left nothing");
        assertThrows(
          () =>
            db.transaction("immediate", () => {
              insert.run(4, "d");
              db.transaction("immediate", () => insert.run(5, "e"));
            }),
          "Error",
          "nesting"
        );
        assertEqual(count(db, "t"), 2, "the outer transaction rolled back with the refusal");
        db.transaction("exclusive", () => insert.run(6, "f"));
        assertEqual(count(db, "t"), 3, "the connection is fine after all that");
      }),
  },
  {
    name: "strict column types and foreign keys are enforced",
    run: (h) =>
      withFresh(h, "create", (db) => {
        db.exec(`
          CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL CHECK (size >= 0)) STRICT;
          CREATE TABLE child (
            parent TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
            n INTEGER NOT NULL,
            bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),
            PRIMARY KEY (parent, n)
          ) STRICT;
        `);
        assertEqual(db.prepare("PRAGMA foreign_keys").get(), { foreign_keys: 1 }, "foreign keys on");
        const parent = db.prepare("INSERT INTO parent VALUES (?, ?)");
        const child = db.prepare("INSERT INTO child VALUES (?, ?, ?)");
        assertThrows(() => parent.run("p", "ten"), "SqliteError", "text into INTEGER");
        assertThrows(() => parent.run("p", 1.5), "SqliteError", "real into INTEGER");
        assertThrows(() => parent.run("p", -1), "SqliteError", "check constraint");
        assertThrows(() => child.run("nobody", 0, new Uint8Array([1])), "SqliteError", "a child without its parent");
        parent.run("p", 3);
        child.run("p", 0, new Uint8Array([1]));
        child.run("p", 1, new Uint8Array(MIB));
        assertThrows(() => child.run("p", 2, new Uint8Array(0)), "SqliteError", "an empty chunk");
        assertThrows(() => child.run("p", 2, new Uint8Array(MIB + 1)), "SqliteError", "a chunk over a mebibyte");
        assertEqual(count(db, "child"), 2, "two chunks");
        db.prepare("DELETE FROM parent WHERE id = ?").run("p");
        assertEqual(count(db, "child"), 0, "cascade");
      }),
  },
  {
    name: "what SQLite refuses arrives as SqliteError with its result code, and leaves the connection usable",
    run: (h) =>
      withFresh(h, "create", (db) => {
        assert(assertThrows(() => db.exec("SELECT * FROM nowhere"), "SqliteError", "no such table").message.includes("nowhere"), "the message names it");
        assertEqual((assertThrows(() => db.prepare("SELEC 1"), "SqliteError", "syntax") as { code?: number }).code, 1, "SQLITE_ERROR");
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
        assertEqual(db.prepare("SELECT count(*) AS n FROM t").get(), { n: 0 }, "usable after");
      }),
  },
  {
    name: "a closed connection refuses every call and close is idempotent",
    run: async (h) => {
      const target = h.fresh();
      const db = await h.open(target, "create");
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
      const insert = db.prepare("INSERT INTO t VALUES (?)");
      const select = db.prepare("SELECT k FROM t");
      insert.run(1);
      const pending = select.iterate();
      db.close();
      db.close();
      assertThrows(() => pending.next(), "DatabaseClosed", "an iterator taken before the close");
      assertThrows(() => db.exec("SELECT 1"), "DatabaseClosed", "exec");
      assertThrows(() => db.exec("SELECT * FROM nowhere"), "DatabaseClosed", "before SQLite sees the statement");
      assertThrows(() => db.prepare("SELECT 1"), "DatabaseClosed", "prepare");
      assertThrows(() => insert.run(2), "DatabaseClosed", "a statement prepared before");
      assertThrows(() => select.all(), "DatabaseClosed", "a query prepared before");
      assertThrows(() => db.transaction("immediate", () => 1), "DatabaseClosed", "transaction");
    },
  },
  {
    name: "a COMMIT that fails stops the connection with UncertainCommit: every call refuses, an iterator taken before steps no further, and a reopen shows the transaction whole or not at all and nothing after",
    needsPersistence: true,
    run: async (h) => {
      for (const landed of [false, true]) {
        const target = h.fresh();
        let failing = false;
        const db = new Connection(rawOver(await h.open(target, "create"), { failCommit: () => failing, landed }), "create");
        db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
        const insert = db.prepare("INSERT INTO t VALUES (?) RETURNING k");
        const select = db.prepare("SELECT k FROM t ORDER BY k");
        db.transaction("immediate", () => insert.run(1));
        const unstarted = insert.iterate(99);
        const underWay = select.iterate();
        assertEqual(underWay.next().value?.["k"], 1, "a read under way");
        failing = true;
        const outcome = landed ? "landed" : "not landed";
        const err = assertThrows(() => db.transaction("immediate", () => insert.run(2)), "UncertainCommit", `the commit, ${outcome}`);
        assert(db.uncertain === err, "the connection says what stopped it");
        assert(assertThrows(() => unstarted.next(), "UncertainCommit", "an iterator taken before the stop, not yet started") === err, "with the same error");
        assertThrows(() => underWay.next(), "UncertainCommit", "an iterator under way");
        assertThrows(() => db.exec("SELECT 1"), "UncertainCommit", "exec");
        assertThrows(() => select.all(), "UncertainCommit", "a query");
        assertThrows(() => db.prepare("SELECT 1"), "UncertainCommit", "prepare");
        assertThrows(() => db.transaction("immediate", () => 1), "UncertainCommit", "another transaction");
        assertEqual(unstarted.return?.(), { done: true, value: undefined }, "returning an iterator still cleans up");
        insert.finalize();
        db.close();
        const again = await h.open(target, "readwrite");
        try {
          assertEqual(again.prepare("SELECT k FROM t ORDER BY k").all(), landed ? [{ k: 1 }, { k: 2 }] : [{ k: 1 }], `what the file holds, ${outcome}`);
        } finally {
          again.close();
        }
      }
    },
  },
  {
    name: "mebibyte chunks go in and come back whole",
    run: async (h) => {
      const target = h.fresh();
      const db = await h.open(target, "create");
      try {
        db.exec("CREATE TABLE chunks (n INTEGER PRIMARY KEY, bytes BLOB NOT NULL) STRICT");
        const n = 64;
        const digest = sha256.create();
        const started = performance.now();
        db.transaction("immediate", () => {
          const insert = db.prepare("INSERT INTO chunks VALUES (?, ?)");
          for (let i = 0; i < n; i++) {
            const chunk = pattern(MIB, i);
            digest.update(chunk);
            insert.run(i, chunk);
          }
        });
        const written = performance.now();
        const back = sha256.create();
        let seen = 0;
        for (const row of db.prepare("SELECT n, bytes FROM chunks ORDER BY n").iterate()) {
          assertEqual(row["n"], seen, "chunk order");
          const bytes = row["bytes"] as Uint8Array;
          assertEqual(bytes.length, MIB, "chunk length");
          back.update(bytes);
          seen++;
        }
        const read = performance.now();
        assertEqual(seen, n, "every chunk");
        assertBytes(back.digest(), digest.digest(), "the bytes, concatenated");
        return `${n} MiB: wrote in ${Math.round(written - started)} ms, read in ${Math.round(read - written)} ms`;
      } finally {
        db.close();
      }
    },
  },
  {
    name: "application_id and user_version are the file's, and pragmas of the connection are its own",
    needsPersistence: true,
    run: async (h) => {
      const target = h.fresh();
      let db = await h.open(target, "create");
      db.exec("PRAGMA application_id = 1163088963; PRAGMA user_version = 1; CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
      assertEqual(db.prepare("PRAGMA application_id").get(), { application_id: 1163088963 }, "set");
      db.close();
      db = await h.open(target, "readwrite");
      assertEqual(db.prepare("PRAGMA application_id").get(), { application_id: 1163088963 }, "kept");
      assertEqual(db.prepare("PRAGMA user_version").get(), { user_version: 1 }, "kept");
      assertEqual(db.prepare("PRAGMA foreign_keys").get(), { foreign_keys: 1 }, "foreign keys on again");
      db.close();
    },
  },
  {
    name: "what one connection committed, a later one reads, read-write or read-only",
    needsPersistence: true,
    run: async (h) => {
      const target = h.fresh();
      let db = await h.open(target, "create");
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, b BLOB NOT NULL) STRICT");
      db.transaction("immediate", () => {
        const insert = db.prepare("INSERT INTO t VALUES (?, ?)");
        insert.run(1, pattern(MIB, 1));
        insert.run(2, pattern(10, 2));
      });
      db.close();
      db = await h.open(target, "readwrite");
      assertEqual(db.mode, "readwrite", "mode");
      assertBytes(db.prepare("SELECT b FROM t WHERE k = 1").get()?.["b"] as Uint8Array, pattern(MIB, 1), "the mebibyte");
      db.prepare("INSERT INTO t VALUES (?, ?)").run(3, pattern(3, 3));
      db.close();
      db = await h.open(target, "readonly");
      assertEqual(db.mode, "readonly", "mode");
      assertEqual(db.prepare("SELECT k, length(b) AS n FROM t ORDER BY k").all(), [
        { k: 1, n: MIB },
        { k: 2, n: 10 },
        { k: 3, n: 3 },
      ], "all three");
      db.close();
    },
  },
  {
    name: "a read-only connection writes nothing, loads no extension and trusts no schema",
    needsPersistence: true,
    run: async (h) => {
      const target = h.fresh();
      let db = await h.open(target, "create");
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT; INSERT INTO t VALUES (1)");
      db.close();
      db = await h.open(target, "readonly");
      assertThrows(() => db.exec("INSERT INTO t VALUES (2)"), "SqliteError", "insert");
      assertThrows(() => db.prepare("DELETE FROM t").run(), "SqliteError", "delete");
      assertThrows(() => db.exec("CREATE TABLE u (k INTEGER PRIMARY KEY) STRICT"), "SqliteError", "ddl");
      assertThrows(() => db.exec("PRAGMA user_version = 7"), "SqliteError", "a header write");
      assertThrows(() => db.exec("SELECT load_extension('nothing')"), "SqliteError", "extension loading");
      assertEqual(db.prepare("PRAGMA trusted_schema").get(), { trusted_schema: 0 }, "untrusted schema");
      assertEqual(db.prepare("PRAGMA query_only").get(), { query_only: 1 }, "query only");
      assertEqual(db.prepare("SELECT k FROM t").all(), [{ k: 1 }], "reads");
      db.close();
      db = await h.open(target, "readwrite");
      assertEqual(db.prepare("SELECT k FROM t").all(), [{ k: 1 }], "unchanged");
      assertEqual(db.prepare("PRAGMA user_version").get(), { user_version: 0 }, "header unchanged");
      db.close();
    },
  },
  {
    name: "create refuses an existing target; readwrite and readonly refuse a missing one",
    needsPersistence: true,
    run: async (h) => {
      const target = h.fresh();
      await assertRejects(() => h.open(target, "readwrite"), "DatabaseMissing", "readwrite of nothing");
      await assertRejects(() => h.open(target, "readonly"), "DatabaseMissing", "readonly of nothing");
      const db = await h.open(target, "create");
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
      db.close();
      await assertRejects(() => h.open(target, "create"), "DatabaseExists", "create over it");
      const again = await h.open(target, "readwrite");
      assertEqual(again.prepare("SELECT count(*) AS n FROM sqlite_master").get(), { n: 1 }, "the refused create touched nothing");
      again.close();
    },
  },
  {
    name: "a second connection to an open database is refused until the first closes",
    needsPersistence: true,
    run: async (h) => {
      const target = h.fresh();
      const first = await h.open(target, "create");
      first.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
      await assertRejects(() => h.open(target, "readwrite"), "DatabaseBusy", "second readwrite");
      await assertRejects(() => h.open(target, "readonly"), "DatabaseBusy", "second readonly");
      await assertRejects(() => h.open(target, "create"), "DatabaseExists", "second create: it exists before it is busy");
      first.prepare("INSERT INTO t VALUES (?)").run(1);
      first.close();
      const second = await h.open(target, "readonly");
      assertEqual(second.prepare("SELECT k FROM t").all(), [{ k: 1 }], "after close, the next reads");
      await assertRejects(() => h.open(target, "readwrite"), "DatabaseBusy", "a reader owns it too");
      second.close();
      const third = await h.open(target, "readwrite");
      third.close();
    },
  },
  {
    name: "a writable connection keeps foreign keys enforced and a journal SQLite recovers from under a synchronous setting that is not OFF, as the platform reports them",
    needsPersistence: true,
    run: async (h) => {
      const db = await h.open(h.fresh(), "create");
      try {
        const pragma = (name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
        assertEqual(pragma("foreign_keys"), 1, "foreign keys");
        const journal = String(pragma("journal_mode"));
        assert(journal === "wal" || journal === "delete", `a journal SQLite recovers from, not ${journal}`);
        const synchronous = Number(pragma("synchronous"));
        assert(synchronous >= 1, `synchronous is not OFF: ${synchronous}`);
        return `journal_mode=${journal}, synchronous=${["OFF", "NORMAL", "FULL", "EXTRA"][synchronous] ?? synchronous}`;
      } finally {
        db.close();
      }
    },
  },
];
