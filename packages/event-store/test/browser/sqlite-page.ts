/**
 * What runs in the page: spawns the Workers, drives them through the
 * driver cases, the open cases, the pool cases and the pool's
 * ownership, and reports
 * every outcome as one list the test reads back. The page itself tries
 * the pool once, to see it refused outside a Worker.
 */

import { openSqlitePool } from "../../src/browser.js";
import type { WorkerCaseResult, WorkerReply, WorkerRequest } from "./sqlite-worker.js";

declare global {
  interface Window {
    runSqliteSuite: (utf16: { snapshot: number[]; forged: number[] }) => Promise<WorkerCaseResult[]>;
  }
}

class Driven {
  private readonly worker = new Worker("/worker.js", { type: "module" });
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private next = 1;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      const waiting = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      if (waiting === undefined) return;
      if (reply.ok) waiting.resolve(reply.result);
      else waiting.reject(new Error(reply.error));
    };
    this.worker.onerror = (event) => {
      for (const waiting of this.pending.values()) waiting.reject(new Error(`worker error: ${event.message}`));
      this.pending.clear();
    };
  }

  send(command: WorkerRequest): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...command, id });
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

async function attempt(name: string, body: () => Promise<string | void>): Promise<WorkerCaseResult> {
  try {
    const note = await body();
    return note === undefined ? { name } : { name, note };
  } catch (err) {
    return { name, error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
  }
}

window.runSqliteSuite = async (utf16: { snapshot: number[]; forged: number[] }): Promise<WorkerCaseResult[]> => {
  const results: WorkerCaseResult[] = [];
  results.push(
    await attempt("the pool is refused on the main thread", async () => {
      try {
        await openSqlitePool({ directory: "/main-thread" });
      } catch (err) {
        if (err instanceof Error && /Worker only/.test(err.message)) return;
        throw err;
      }
      throw new Error("the main thread got a pool");
    })
  );
  const first = new Driven();
  const second = new Driven();
  try {
    results.push(...((await first.send({ cmd: "cases", directory: "/cases" })) as WorkerCaseResult[]));
    results.push(...((await first.send({ cmd: "open", directory: "/open", utf16 })) as WorkerCaseResult[]));
    results.push(
      await attempt("a second Worker is refused the directory another holds, and admitted once it is released", async () => {
        await first.send({ cmd: "hold", directory: "/owned" });
        try {
          await second.send({ cmd: "hold", directory: "/owned" });
        } catch (err) {
          if (!(err instanceof Error && /^DatabaseBusy:/.test(err.message))) throw err;
          await first.send({ cmd: "release" });
          await second.send({ cmd: "hold", directory: "/owned" });
          await second.send({ cmd: "release" });
          return;
        }
        throw new Error("the second Worker installed over a held directory");
      })
    );
    results.push(
      await attempt("a terminated Worker's directory frees up for the next", async () => {
        await first.send({ cmd: "hold", directory: "/abandoned" });
        first.terminate();
        const third = new Driven();
        try {
          await third.send({ cmd: "hold", directory: "/abandoned" });
          await third.send({ cmd: "release" });
        } finally {
          third.terminate();
        }
      })
    );
    results.push(...((await second.send({ cmd: "pool" })) as WorkerCaseResult[]));
  } finally {
    first.terminate();
    second.terminate();
  }
  return results;
};
