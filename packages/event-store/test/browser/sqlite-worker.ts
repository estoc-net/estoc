/**
 * What runs in the Worker: the driver cases over the wasm pool, the
 * vault open cases, the event and object store cases, the vault,
 * export and import cases, the three conformance suites, a portable
 * snapshot's exchange with the other platform, the pool's own cases,
 * and holding a directory against another Worker.
 * Driven by messages from the page script, which
 * `../v3/sqlite/browser-driver.test.ts` bundles and serves.
 */

import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { openSqlitePool, type SqlitePool } from "../../src/browser.js";
import { assert, type DriverHarness, driverCases } from "../v3/sqlite/driver-cases.js";
import { eventCases } from "../v3/sqlite/event-cases.js";
import { continued, inspectPortable, type Inspection } from "../v3/sqlite/exchange.js";
import { destination, exportCases, type ExportHarness, opened } from "../v3/sqlite/export-cases.js";
import { importCases, type ImportHarness } from "../v3/sqlite/import-cases.js";
import { objectCases, type ObjectHarness } from "../v3/sqlite/object-cases.js";
import { type OpenHarness, openCases } from "../v3/sqlite/open-cases.js";
import { eventStoreOpener, objectStoreOpener, type SuiteHarness, vaultOpener } from "../v3/sqlite/suite-openers.js";
import { clock, vaultCases } from "../v3/sqlite/vault-cases.js";
import { eventStoreSuite } from "../v3/suite/event-store-suite.js";
import { objectStoreSuite } from "../v3/suite/object-store-suite.js";
import { vaultSuite } from "../v3/suite/vault-suite.js";
import { poolCases } from "./pool-cases.js";
import { collected } from "./vitest-stand-in.js";

export interface WorkerCaseResult {
  name: string;
  error?: string;
  note?: string;
}

/** What came of a snapshot the other platform exported: how it inspects here, and how the continuation exported here inspects, with its bytes to send back. */
export interface Exchanged {
  inspected: Inspection;
  continued: Inspection;
  bytes: number[];
}

export type WorkerRequest =
  | { cmd: "cases"; directory: string }
  | { cmd: "open"; directory: string; utf16: { snapshot: number[]; forged: number[] } }
  | { cmd: "suites"; directory: string }
  | { cmd: "exchange"; directory: string; snapshot: number[] }
  | { cmd: "pool" }
  | { cmd: "hold"; directory: string }
  | { cmd: "release" };

export type WorkerCommand = WorkerRequest & { id: number };

export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const held = new Map<string, SqlitePool>();

/** What SQLite holds, from the runtime the pool was made over: no part of the pool's interface. */
function memoryUsedIn(pool: SqlitePool): () => number {
  const { sqlite3 } = pool as unknown as { sqlite3: Sqlite3Static };
  return () => {
    const out = sqlite3.wasm.alloc(8);
    try {
      sqlite3.capi.sqlite3_status(sqlite3.capi.SQLITE_STATUS_MEMORY_USED, out, out + 4, 0);
      return sqlite3.wasm.peek32(out);
    } finally {
      sqlite3.wasm.dealloc(out);
    }
  };
}

async function attempt(results: WorkerCaseResult[], name: string, body: () => Promise<string | void>): Promise<void> {
  try {
    const note = await body();
    results.push(note === undefined ? { name } : { name, note });
  } catch (err) {
    results.push({ name, error: describe(err) });
  }
}

async function closing(pool: SqlitePool, results: WorkerCaseResult[], what: string): Promise<void> {
  await attempt(results, `the pool closes once the ${what} have closed their connections`, () => pool.close());
}

async function runCases(directory: string): Promise<WorkerCaseResult[]> {
  const pool = await openSqlitePool({ directory });
  let n = 0;
  const harness: DriverHarness = {
    fresh: () => `db-${n++}`,
    open: (target, mode) => pool.open(target, mode),
    persistent: true,
  };
  const results: WorkerCaseResult[] = [];
  for (const c of driverCases) await attempt(results, c.name, () => c.run(harness));
  await closing(pool, results, "cases");
  return results;
}

async function runOpenCases(directory: string, utf16: { snapshot: Uint8Array; forged: Uint8Array }): Promise<WorkerCaseResult[]> {
  const pool = await openSqlitePool({ directory });
  let n = 0;
  const harness: OpenHarness & ObjectHarness & ExportHarness & ImportHarness = {
    fresh: () => `vault-${n++}`,
    open: (target, mode) => pool.open(target, mode),
    importFile: (target, bytes) => pool.importFile(target, bytes),
    fileBytes: (target) => pool.exportFile(target),
    utf16,
    memoryUsed: memoryUsedIn(pool),
  };
  const results: WorkerCaseResult[] = [];
  for (const c of [...openCases, ...eventCases, ...objectCases, ...vaultCases, ...exportCases, ...importCases]) await attempt(results, c.name, () => c.run(harness));
  await closing(pool, results, "open cases");
  return results;
}

/** The three conformance suites over the pool, each test closing what it opened once it has run, so the pool can close after them. */
async function runSuites(directory: string): Promise<WorkerCaseResult[]> {
  const pool = await openSqlitePool({ directory });
  let n = 0;
  const closers: (() => Promise<void>)[] = [];
  const harness: SuiteHarness = {
    fresh: () => `suite-${n++}`,
    open: (target, mode) => pool.open(target, mode),
    opened: (close) => closers.push(close),
  };
  eventStoreSuite("SqliteEventStore in the pool", eventStoreOpener(harness));
  objectStoreSuite("SqliteObjectStore in the pool", objectStoreOpener(harness));
  vaultSuite("SqliteVault in the pool", vaultOpener(harness));
  const results: WorkerCaseResult[] = [];
  for (const test of collected()) {
    await attempt(results, test.name, async () => {
      await test.run();
    });
    for (const close of closers.splice(0)) {
      try {
        await close();
      } catch {
        // closed by the test itself, or left where a close no longer applies
      }
    }
  }
  await closing(pool, results, "suites");
  return results;
}

async function runExchange(directory: string, snapshot: Uint8Array): Promise<Exchanged> {
  const pool = await openSqlitePool({ directory });
  const harness: ExportHarness = {
    fresh: () => "restored",
    open: (target, mode) => pool.open(target, mode),
    fileBytes: (target) => pool.exportFile(target),
  };
  await pool.importFile("from-the-other-platform", snapshot);
  const arrived = await opened(harness, "from-the-other-platform");
  const inspected = await inspectPortable(arrived);
  await continued(arrived, destination(harness, "restored"), destination(harness, "continued"), clock().now);
  arrived.close();
  const own = await opened(harness, "continued");
  const result = { inspected, continued: await inspectPortable(own), bytes: [] as number[] };
  own.close();
  result.bytes = Array.from(await pool.exportFile("continued"));
  await pool.close();
  return result;
}

async function runPoolCases(): Promise<WorkerCaseResult[]> {
  const results: WorkerCaseResult[] = [];
  for (const c of poolCases) await attempt(results, c.name, () => c.run(openSqlitePool));
  return results;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
}

async function handle(command: WorkerCommand): Promise<unknown> {
  switch (command.cmd) {
    case "cases":
      return runCases(command.directory);
    case "open":
      return runOpenCases(command.directory, { snapshot: new Uint8Array(command.utf16.snapshot), forged: new Uint8Array(command.utf16.forged) });
    case "suites":
      return runSuites(command.directory);
    case "exchange":
      return runExchange(command.directory, new Uint8Array(command.snapshot));
    case "pool":
      return runPoolCases();
    case "hold": {
      held.set(command.directory, await openSqlitePool({ directory: command.directory }));
      return "held";
    }
    case "release": {
      for (const pool of held.values()) await pool.close();
      held.clear();
      return "released";
    }
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
