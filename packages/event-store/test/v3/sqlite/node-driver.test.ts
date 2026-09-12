/**
 * The `node:sqlite` adapter: the driver cases on a file and in memory,
 * and what only a file on disk can show — the lock a second process
 * meets, the headers a journal mode leaves, the extension loading a
 * connection refuses.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "../../../src/node.js";
import { DatabaseBusy } from "../../../src/v3/errors.js";
import { type DriverHarness, driverCases } from "./driver-cases.js";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-sqlite-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const onFile: DriverHarness = {
  fresh: () => path.join(dir, `db-${n++}.sqlite`),
  open: async (target, mode) => openNodeSqlite(target, { mode }),
  persistent: true,
};

const inMemory: DriverHarness = {
  fresh: () => ":memory:",
  open: async (target, mode) => openNodeSqlite(target, { mode }),
  persistent: false,
};

for (const [name, harness] of [
  ["on a file", onFile],
  ["in memory", inMemory],
] as const) {
  describe(`node:sqlite driver ${name}`, () => {
    for (const c of driverCases) {
      it.skipIf(c.needsPersistence === true && !harness.persistent)(c.name, async () => {
        const note = await c.run(harness);
        if (note !== undefined) console.info(`${name}: ${c.name}: ${note}`);
      });
    }
  });
}

/**
 * A second process, with `node:sqlite` alone: `hold` opens the file and
 * keeps SQLite's exclusive lock until told to quit; `probe` opens it,
 * tries a read and a write, and reports each as `ok` or the SQLite
 * result code.
 */
const OTHER_PROCESS = `
  const { DatabaseSync } = require("node:sqlite");
  const [file, role] = process.argv.slice(1);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 0");
  const attempt = (sql) => { try { db.exec(sql); return "ok"; } catch (err) { return "code " + err.errcode; } };
  if (role === "hold") {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE; COMMIT");
    process.stdout.write("held\\n");
    process.stdin.on("data", () => { db.close(); process.exit(0); });
    process.stdin.on("end", () => { db.close(); process.exit(0); });
  } else {
    process.stdout.write(JSON.stringify({ read: attempt("SELECT count(*) FROM sqlite_master"), write: attempt("CREATE TABLE IF NOT EXISTS probe (x INTEGER) STRICT") }) + "\\n");
  }
`;

function otherProcess(file: string, role: "hold" | "probe"): Promise<{ output: string; quit: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "-e", OTHER_PROCESS, file, role], { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) {
        resolve({
          output: output.trim(),
          quit: () =>
            new Promise((done) => {
              child.on("exit", () => done());
              child.stdin.end("quit");
            }),
        });
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!output.includes("\n")) reject(new Error(`the other process exited with ${code} saying ${JSON.stringify(output)}`));
    });
  });
}

describe("node:sqlite driver and other processes", () => {
  it("a second process meets the lock this connection holds, read or write, in either journal mode", async () => {
    for (const journal of ["wal", "delete"] as const) {
      const file = onFile.fresh();
      const db = openNodeSqlite(file, { mode: "create", journal });
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
      const probe = await otherProcess(file, "probe");
      expect(JSON.parse(probe.output), journal).toEqual({ read: "code 5", write: "code 5" });
      db.close();
      const after = await otherProcess(file, "probe");
      expect(JSON.parse(after.output), `${journal} after close`).toEqual({ read: "ok", write: "ok" });
    }
  });

  it("a read-only connection keeps writers out of the file and lets readers in", async () => {
    const file = onFile.fresh();
    openNodeSqlite(file, { mode: "create", journal: "delete" }).close();
    const reader = openNodeSqlite(file, { mode: "readonly" });
    const probe = await otherProcess(file, "probe");
    expect(JSON.parse(probe.output)).toEqual({ read: "ok", write: "code 5" });
    reader.close();
    const after = await otherProcess(file, "probe");
    expect(JSON.parse(after.output)).toEqual({ read: "ok", write: "ok" });
  });

  it("a read-only connection of a WAL file owns it outright: no other connection reads or writes until it closes", async () => {
    const file = onFile.fresh();
    const db = openNodeSqlite(file, { mode: "create" });
    db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT; INSERT INTO t VALUES (1)");
    db.close();
    const inspector = openNodeSqlite(file, { mode: "readonly" });
    const probe = await otherProcess(file, "probe");
    expect(JSON.parse(probe.output)).toEqual({ read: "code 5", write: "code 5" });
    expect(() => inspector.exec("INSERT INTO t VALUES (2)")).toThrow(/readonly/);
    expect(inspector.prepare("SELECT k FROM t").all()).toEqual([{ k: 1 }]);
    expect(inspector.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    inspector.close();
    expect(Array.from((await readFile(file)).subarray(18, 20)), "still a WAL file").toEqual([2, 2]);
    const after = await otherProcess(file, "probe");
    expect(JSON.parse(after.output)).toEqual({ read: "ok", write: "ok" });
    const again = openNodeSqlite(file, { mode: "readwrite" });
    expect(again.prepare("SELECT k FROM t").all()).toEqual([{ k: 1 }]);
    again.close();
  });

  it("this process is refused, read-write or read-only, while another holds the file", async () => {
    const file = onFile.fresh();
    openNodeSqlite(file, { mode: "create" }).close();
    const holder = await otherProcess(file, "hold");
    expect(holder.output).toBe("held");
    try {
      expect(() => openNodeSqlite(file, { mode: "readwrite" })).toThrow(DatabaseBusy);
      expect(() => openNodeSqlite(file, { mode: "readonly" })).toThrow(DatabaseBusy);
    } finally {
      await holder.quit();
    }
    openNodeSqlite(file, { mode: "readwrite" }).close();
  });
});

describe("node:sqlite driver on disk", () => {
  it("a create leaves the journal it was asked for, with matching durability; a reopen keeps it", async () => {
    const wal = onFile.fresh();
    let db = openNodeSqlite(wal, { mode: "create" });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
    db.close();
    expect(Array.from((await readFile(wal)).subarray(18, 20)), "WAL headers").toEqual([2, 2]);
    db = openNodeSqlite(wal, { mode: "readwrite" });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    db.close();

    const rollback = onFile.fresh();
    db = openNodeSqlite(rollback, { mode: "create", journal: "delete" });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT");
    db.close();
    expect(Array.from((await readFile(rollback)).subarray(18, 20)), "rollback headers").toEqual([1, 1]);
    db = openNodeSqlite(rollback, { mode: "readwrite" });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    db.close();
    db = openNodeSqlite(rollback, { mode: "readonly" });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    db.close();
    expect(Array.from((await readFile(rollback)).subarray(18, 20)), "still rollback headers").toEqual([1, 1]);
  });

  it("a read-write connection loads no extension either", () => {
    const db = openNodeSqlite(onFile.fresh(), { mode: "create" });
    expect(() => db.exec("SELECT load_extension('nothing')")).toThrow(/not authorized/);
    db.close();
  });

  it("a refused create leaves nothing behind but the existing target", async () => {
    const file = onFile.fresh();
    const db = openNodeSqlite(file, { mode: "create" });
    db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT; INSERT INTO t VALUES (1)");
    db.close();
    const before = await readFile(file);
    expect(() => openNodeSqlite(file, { mode: "create" })).toThrow(/already exists/);
    expect(Array.from(await readFile(file))).toEqual(Array.from(before));
  });
});
