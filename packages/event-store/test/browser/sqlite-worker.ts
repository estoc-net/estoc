/**
 * What runs in the Worker: the driver cases over the wasm pool, and the
 * pool's own behaviour — holding a directory against another Worker,
 * exporting and importing a file. Driven by messages from the page
 * script, which `../v3/sqlite/browser-driver.test.ts` bundles and
 * serves.
 */

import { openSqlitePool, type SqlitePool } from "../../src/browser.js";
import { assert, assertBytes, assertEqual, assertRejects, type DriverHarness, driverCases, pattern } from "../v3/sqlite/driver-cases.js";

export interface WorkerCaseResult {
  name: string;
  error?: string;
  note?: string;
}

export type WorkerRequest = { cmd: "cases"; directory: string } | { cmd: "hold"; directory: string } | { cmd: "release" } | { cmd: "export-import"; directory: string };

export type WorkerCommand = WorkerRequest & { id: number };

export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const held = new Map<string, SqlitePool>();

async function runCases(directory: string): Promise<WorkerCaseResult[]> {
  const pool = await openSqlitePool({ directory });
  let n = 0;
  const harness: DriverHarness = {
    fresh: () => `db-${n++}`,
    open: (target, mode) => pool.open(target, mode),
    persistent: true,
  };
  const results: WorkerCaseResult[] = [];
  for (const c of driverCases) {
    try {
      const note = await c.run(harness);
      results.push(note === undefined ? { name: c.name } : { name: c.name, note });
    } catch (err) {
      results.push({ name: c.name, error: describe(err) });
    }
  }
  try {
    await pool.close();
  } catch (err) {
    results.push({ name: "the pool closes once the cases have closed their connections", error: describe(err) });
  }
  return results;
}

/** A database written, exported as bytes, imported under another name and read back: the delivery and intake a portable snapshot takes. */
async function exportImport(directory: string): Promise<string> {
  const pool = await openSqlitePool({ directory });
  const db = await pool.open("origin", "create");
  db.exec("PRAGMA application_id = 1163088963; CREATE TABLE t (k INTEGER PRIMARY KEY, b BLOB NOT NULL) STRICT");
  db.prepare("INSERT INTO t VALUES (?, ?)").run(1, pattern(3000, 9));
  await assertRejects(() => pool.exportFile("origin"), "DatabaseBusy", "export while open");
  db.close();
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
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
}

async function handle(command: WorkerCommand): Promise<unknown> {
  switch (command.cmd) {
    case "cases":
      return runCases(command.directory);
    case "hold": {
      held.set(command.directory, await openSqlitePool({ directory: command.directory }));
      return "held";
    }
    case "release": {
      for (const pool of held.values()) await pool.close();
      held.clear();
      return "released";
    }
    case "export-import":
      return exportImport(command.directory);
  }
}

self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
  const { id } = event.data;
  try {
    assert("WorkerGlobalScope" in globalThis, "this is a worker");
    const reply: WorkerReply = { id, ok: true, result: await handle(event.data) };
    self.postMessage(reply);
  } catch (err) {
    const reply: WorkerReply = { id, ok: false, error: describe(err) };
    self.postMessage(reply);
  }
};
