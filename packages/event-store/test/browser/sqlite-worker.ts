/**
 * What runs in the Worker: the driver cases over the wasm pool, the
 * vault open cases and the event store cases, the pool's own cases,
 * and holding a directory against another Worker.
 * Driven by messages from the page script, which
 * `../v3/sqlite/browser-driver.test.ts` bundles and serves.
 */

import { openSqlitePool, type SqlitePool } from "../../src/browser.js";
import { assert, type DriverHarness, driverCases } from "../v3/sqlite/driver-cases.js";
import { eventCases } from "../v3/sqlite/event-cases.js";
import { type OpenHarness, openCases } from "../v3/sqlite/open-cases.js";
import { poolCases } from "./pool-cases.js";

export interface WorkerCaseResult {
  name: string;
  error?: string;
  note?: string;
}

export type WorkerRequest =
  | { cmd: "cases"; directory: string }
  | { cmd: "open"; directory: string; utf16: { snapshot: number[]; forged: number[] } }
  | { cmd: "pool" }
  | { cmd: "hold"; directory: string }
  | { cmd: "release" };

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

async function runOpenCases(directory: string, utf16: { snapshot: Uint8Array; forged: Uint8Array }): Promise<WorkerCaseResult[]> {
  const pool = await openSqlitePool({ directory });
  let n = 0;
  const harness: OpenHarness = {
    fresh: () => `vault-${n++}`,
    open: (target, mode) => pool.open(target, mode),
    importFile: (target, bytes) => pool.importFile(target, bytes),
    utf16,
  };
  const results: WorkerCaseResult[] = [];
  for (const c of [...openCases, ...eventCases]) {
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
    results.push({ name: "the pool closes once the open cases have closed their connections", error: describe(err) });
  }
  return results;
}

async function runPoolCases(): Promise<WorkerCaseResult[]> {
  const results: WorkerCaseResult[] = [];
  for (const c of poolCases) {
    try {
      const note = await c.run(openSqlitePool);
      results.push(note === undefined ? { name: c.name } : { name: c.name, note });
    } catch (err) {
      results.push({ name: c.name, error: describe(err) });
    }
  }
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
