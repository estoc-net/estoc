/**
 * What the wasm pool itself must do, beyond the driver cases its
 * connections pass. Run in the Worker by `sqlite-worker.ts`; the cases
 * take the pool opener so this module loads without the wasm runtime,
 * for the test that lists their names.
 */

import type { SqlitePool, SqlitePoolOptions } from "../../src/browser.js";
import { SqliteObjectStore, createRuntime } from "../../src/v3/index.js";
import { META, WRAPPED } from "../v3/fixtures.js";
import { assertEqual, assertRejects, assertThrows, assertBytes, pattern } from "../v3/sqlite/driver-cases.js";

export type OpenPool = (options: SqlitePoolOptions) => Promise<SqlitePool>;

export interface PoolCase {
  name: string;
  run(open: OpenPool): Promise<string | void>;
}

export const poolCases: PoolCase[] = [
  {
    name: "names are the databases: one that spells another's journal is its own, and the journal SQLite keeps beside a database is not listed",
    run: async (open) => {
      const pool = await open({ directory: "/names" });
      const side = await pool.open("vault-journal", "create");
      side.exec("CREATE TABLE valuable (v TEXT NOT NULL) STRICT; INSERT INTO valuable VALUES ('keep me')");
      side.close();
      const main = await pool.open("vault", "create");
      main.exec("CREATE TABLE marker (v INTEGER NOT NULL) STRICT");
      main.transaction("immediate", () => {
        main.prepare("INSERT INTO marker VALUES (?)").run(1);
        assertEqual(pool.names(), ["vault", "vault-journal"], "inside a transaction, with the journal on disk");
      });
      main.close();
      assertEqual(pool.names(), ["vault", "vault-journal"], "after it");
      const again = await pool.open("vault-journal", "readonly");
      assertEqual(again.prepare("SELECT v FROM valuable").all(), [{ v: "keep me" }], "the database with the journal-like name is intact");
      again.close();
      const vault = await pool.open("vault", "readonly");
      assertEqual(vault.prepare("SELECT v FROM marker").all(), [{ v: 1 }], "and so is the other");
      vault.close();
      await pool.close();
    },
  },
  {
    name: "two directories are two pools however alike their names; one directory is one pool however it is spelled",
    run: async (open) => {
      const first = await open({ directory: "/collision-a" });
      const db = await first.open("vault", "create");
      db.exec("CREATE TABLE marker (v TEXT NOT NULL) STRICT; INSERT INTO marker VALUES ('first')");
      db.close();
      const second = await open({ directory: "/collision/a" });
      assertEqual(second.names(), [], "nothing of the first directory");
      await assertRejects(() => second.open("vault", "readwrite"), "DatabaseMissing", "the first directory's database is not here");
      await second.close();
      await assertRejects(() => open({ directory: "collision-a//" }), "DatabaseBusy", "the held directory, spelled without the leading slash and with a doubled one");
      await assertRejects(() => open({ directory: "/collision-a/" }), "DatabaseBusy", "the held directory, with a trailing slash");
      await first.close();
      const third = await open({ directory: "collision-a" });
      assertEqual(third.names(), ["vault"], "the directory once released, under another spelling");
      await third.close();
      for (const bad of ["", "/", "//", "/a/../b", "/./a"]) await assertRejects(() => open({ directory: bad }), "Error", `${JSON.stringify(bad)} is not a directory the pool takes`);
    },
  },
  {
    name: "a closed pool refuses every call: the directory is the next owner's alone",
    run: async (open) => {
      const first = await open({ directory: "/lifecycle" });
      const db = await first.open("vault", "create");
      db.exec("CREATE TABLE marker (v INTEGER NOT NULL) STRICT; INSERT INTO marker VALUES (1)");
      db.close();
      await first.close();
      await first.close();
      await assertRejects(() => first.open("vault", "readwrite"), "Error", "open after close");
      assertThrows(() => first.names(), "Error", "names after close");
      assertThrows(() => first.remove("vault"), "Error", "remove after close");
      await assertRejects(() => first.exportFile("vault"), "Error", "export after close");
      await assertRejects(() => first.importFile("copy", new Uint8Array(512)), "Error", "import after close");
      const next = await open({ directory: "/lifecycle" });
      const current = await next.open("vault", "readwrite");
      await assertRejects(() => first.open("vault", "readwrite"), "Error", "the old pool while the new owner works");
      assertThrows(() => first.remove("vault"), "Error", "the old pool cannot remove what the new owner holds");
      assertEqual(current.prepare("SELECT v FROM marker").all(), [{ v: 1 }], "the new owner's view, untouched");
      current.close();
      await next.close();
    },
  },
  {
    name: "the pool does not close under an open in progress",
    run: async (open) => {
      const pool = await open({ directory: "/lifecycle-pending" });
      const opening = pool.open("vault", "create");
      await assertRejects(() => pool.close(), "Error", "close while an open is in progress");
      const db = await opening;
      await assertRejects(() => pool.close(), "Error", "close while a connection is open");
      db.close();
      await pool.close();
    },
  },
  {
    name: "importing more databases than the pool has handles for grows it",
    run: async (open) => {
      const pool = await open({ directory: "/import-capacity" });
      const db = await pool.open("origin", "create");
      db.exec("CREATE TABLE marker (v INTEGER NOT NULL) STRICT; INSERT INTO marker VALUES (7)");
      db.close();
      const bytes = await pool.exportFile("origin");
      const copies = Array.from({ length: 8 }, (_, i) => `copy-${i}`);
      for (const name of copies) await pool.importFile(name, bytes);
      assertEqual(pool.names(), [...copies, "origin"].sort(), "every copy landed");
      const last = await pool.open("copy-7", "readonly");
      assertEqual(last.prepare("SELECT v FROM marker").all(), [{ v: 7 }], "and reads");
      last.close();
      await pool.close();
      return `${copies.length} copies of ${bytes.byteLength} bytes`;
    },
  },
  {
    name: "imports started together all land, past the handles the pool had",
    run: async (open) => {
      const pool = await open({ directory: "/import-together" });
      const db = await pool.open("origin", "create");
      db.exec("CREATE TABLE marker (v INTEGER NOT NULL) STRICT; INSERT INTO marker VALUES (3)");
      db.close();
      const bytes = await pool.exportFile("origin");
      const copies = Array.from({ length: 8 }, (_, i) => `copy-${i}`);
      await Promise.all(copies.map((name) => pool.importFile(name, bytes)));
      assertEqual(pool.names(), [...copies, "origin"].sort(), "every copy landed");
      for (const name of copies) {
        const copy = await pool.open(name, "readonly");
        assertEqual(copy.prepare("SELECT v FROM marker").all(), [{ v: 3 }], `${name} reads`);
        copy.close();
      }
      await pool.close();
    },
  },
  {
    name: "an import and a create of one name started together: one lands, the other is refused, whichever is first",
    run: async (open) => {
      const pool = await open({ directory: "/import-or-create" });
      const db = await pool.open("origin", "create");
      db.exec("CREATE TABLE marker (v TEXT NOT NULL) STRICT; INSERT INTO marker VALUES ('imported')");
      db.close();
      const bytes = await pool.exportFile("origin");
      const outcomes = await Promise.allSettled([pool.importFile("target", bytes), pool.open("target", "create").then((created) => created.close())]);
      const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      assertEqual(refused.length, 1, "exactly one refused");
      assertEqual((refused[0]?.reason as Error).name, "DatabaseExists", "and refused as taken");
      const target = await pool.open("target", "readonly");
      const rows = target.prepare("SELECT name FROM sqlite_master WHERE name = 'marker'").all();
      assertEqual(rows.length, outcomes[0]?.status === "fulfilled" ? 1 : 0, "the import's content, when the import was the one that landed");
      if (outcomes[0]?.status === "fulfilled") assertEqual(target.prepare("SELECT v FROM marker").all(), [{ v: "imported" }], "intact");
      target.close();
      const backwards = await Promise.allSettled([pool.open("target-2", "create").then((created) => created.close()), pool.importFile("target-2", bytes)]);
      assertEqual(backwards.map((outcome) => outcome.status), ["fulfilled", "rejected"], "started the other way round, the create lands and the import is refused");
      assertEqual(((backwards[1] as PromiseRejectedResult).reason as Error).name, "DatabaseExists", "as taken");
      await pool.close();
    },
  },
  {
    name: "connections kept open keep the handles their staging and journals will take: each in turn stages and accepts an object past the temporary cache, another opens after them, and every one still writes",
    run: async (open) => {
      const pool = await open({ directory: "/capacity-held" });
      const vaults: ReturnType<typeof createRuntime>[] = [];
      for (let i = 0; i < 4; i++) vaults.push(createRuntime(await pool.open(`vault-${i}`, "create"), { metadata: META, wrapped: WRAPPED }));
      const big = 8 * 1024 * 1024;
      const putAndRead = async (i: number, size: number, seed: number): Promise<void> => {
        const vault = vaults[i];
        if (vault === undefined) throw new Error(`no vault ${i}`);
        const store = new SqliteObjectStore(vault);
        const bytes = pattern(size, seed);
        const info = await store.putRaw(bytes);
        assertEqual(info.size, size, `vault ${i}: the put`);
        const back = await store.read(info.cid, size);
        if (back === null) throw new Error(`vault ${i}: the object is not there`);
        assertBytes(back, bytes, `vault ${i}: the bytes back`);
      };
      for (let i = 0; i < 4; i++) await putAndRead(i, big, 100 + i);
      vaults.push(createRuntime(await pool.open("vault-4", "create"), { metadata: META, wrapped: WRAPPED }));
      await putAndRead(4, big, 104);
      for (let i = 0; i < 5; i++) await putAndRead(i, 1024 * 1024 + 1, 200 + i);
      for (const vault of vaults) vault.close();
      assertEqual(pool.names(), ["vault-0", "vault-1", "vault-2", "vault-3", "vault-4"], "the databases, their temporary files gone with the connections");
      await pool.close();
    },
  },
  {
    name: "text SQLite holds that is not text is refused at the read, not repaired",
    run: async (open) => {
      const pool = await open({ directory: "/text" });
      const db = await pool.open("vault", "create");
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, s TEXT NOT NULL) STRICT; INSERT INTO t VALUES (1, CAST(X'610062' AS TEXT)), (2, CAST(X'EDA080' AS TEXT)), (3, CAST(X'C3A9' AS TEXT)), (4, '')");
      const select = db.prepare("SELECT s FROM t WHERE k = ?");
      assertThrows(() => select.get(1), "InvalidSqlValue", "a NUL inside");
      assertThrows(() => select.get(2), "InvalidSqlValue", "an encoded surrogate");
      assertEqual(select.get(3), { s: "é" }, "valid text reads");
      assertEqual(select.get(4), { s: "" }, "empty text reads");
      assertThrows(() => db.prepare("SELECT CAST(X'FF' AS TEXT) AS s").get(), "InvalidSqlValue", "from an expression too");
      assertEqual(db.prepare("SELECT typeof(s) AS t FROM t WHERE k = 1").get(), { t: "text" }, "the stored value is left as it is");
      db.close();
      await pool.close();
    },
  },
  {
    name: "a database exports as a standalone file and imports back",
    run: async (open) => {
      const pool = await open({ directory: "/exchange" });
      const db = await pool.open("origin", "create");
      db.exec("PRAGMA application_id = 1163088963; CREATE TABLE t (k INTEGER PRIMARY KEY, b BLOB NOT NULL) STRICT");
      db.prepare("INSERT INTO t VALUES (?, ?)").run(1, pattern(3000, 9));
      await assertRejects(() => pool.exportFile("origin"), "DatabaseBusy", "export while open");
      db.close();
      await assertRejects(() => pool.exportFile("nothing"), "DatabaseMissing", "export of a name not there");
      const bytes = await pool.exportFile("origin");
      assertEqual(new TextDecoder().decode(bytes.subarray(0, 15)), "SQLite format 3", "a database file");
      assertEqual([bytes[18], bytes[19]], [1, 1], "rollback-format headers");
      assertEqual(bytes.byteLength % 4096, 0, "whole pages");
      await pool.importFile("copy", bytes);
      await assertRejects(() => pool.importFile("copy", bytes), "DatabaseExists", "import over an existing name");
      assertEqual(pool.names(), ["copy", "origin"], "both in the pool");
      const copy = await pool.open("copy", "readonly");
      assertEqual(copy.prepare("PRAGMA application_id").get(), { application_id: 1163088963 }, "the header travelled");
      assertBytes(copy.prepare("SELECT b FROM t WHERE k = 1").get()?.["b"] as Uint8Array, pattern(3000, 9), "the bytes travelled");
      copy.close();
      pool.remove("copy");
      assertEqual(pool.names(), ["origin"], "removed");
      await pool.close();
      return `${bytes.byteLength} bytes`;
    },
  },
];
