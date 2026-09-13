/**
 * What runs in the page: spawns the Workers, all at once, each with a
 * directory of its own — the driver cases, the open cases, the
 * conformance suites, the exchange of a snapshot with the other
 * platform and the pool cases, every large case in a Worker of its
 * own and the rest of its list together in another — tries the pool's
 * ownership across two more, and reports every outcome as one list
 * the test reads back, with what the exchange made. The page itself
 * tries the pool once, to see it refused outside a Worker. A Worker
 * that asks what memory it holds is measured from here, over the
 * DevTools protocol the test exposes to the page before it loads.
 */

import { openSqlitePool } from "../../src/browser.js";
import { type Case, driverCases } from "../v3/sqlite/driver-cases.js";
import { eventCases } from "../v3/sqlite/event-cases.js";
import { exportCases } from "../v3/sqlite/export-cases.js";
import { importCases } from "../v3/sqlite/import-cases.js";
import { objectCases } from "../v3/sqlite/object-cases.js";
import { openCases } from "../v3/sqlite/open-cases.js";
import { vaultCases } from "../v3/sqlite/vault-cases.js";
import { poolCases } from "./pool-cases.js";
import type { Exchanged, PageAnswer, WorkerAsk, WorkerCaseResult, WorkerReply, WorkerRequest } from "./sqlite-worker.js";

export interface SuiteInput {
  utf16: { snapshot: number[]; forged: number[] };
  /** A portable snapshot the other platform exported. */
  snapshot: number[];
}

export interface SuiteOutput {
  results: WorkerCaseResult[];
  /** The tests the conformance suites collected, in order, each with its outcome. */
  suites: WorkerCaseResult[];
  exchanged: Exchanged;
}

/** The channel to the browser target that `Target.exposeDevToolsProtocol` injects: JSON in, JSON out. */
interface DevToolsBinding {
  send(json: string): void;
  onmessage: ((json: string) => void) | null;
}

declare global {
  interface Window {
    runSqliteSuite: (input: SuiteInput) => Promise<SuiteOutput>;
    devtools?: DevToolsBinding;
  }
}

interface DevToolsMessage {
  id: number;
  result?: unknown;
  error?: { message: string };
}

/** The DevTools protocol over the injected channel: one call, one reply, a session's when `sessionId` names one. */
class DevTools {
  private readonly binding: DevToolsBinding;
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  private next = 1;

  constructor() {
    if (window.devtools === undefined) throw new Error("no DevTools channel: the test exposes the protocol to the page before it loads");
    this.binding = window.devtools;
    this.binding.onmessage = (json) => {
      const message = JSON.parse(json) as DevToolsMessage;
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) waiting.reject(new Error(`${message.error.message}`));
      else waiting.resolve(message.result);
    };
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject });
      this.binding.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
    });
  }
}

let devtools: DevTools | undefined;

/**
 * What a Worker holds, measured from outside it: the DevTools session
 * on the Worker's target — found by the name the Worker was made with,
 * which is the target's title — collects garbage, then reports the
 * isolate's heap and the backing stores of its array buffers. What
 * SQLite's wasm build allocates within its own memory is not counted.
 */
class Measured {
  private session: Promise<string> | undefined;

  constructor(private readonly name: string) {}

  private async attach(): Promise<string> {
    devtools ??= new DevTools();
    const { targetInfos } = await devtools.send<{ targetInfos: { targetId: string; type: string; title: string }[] }>("Target.getTargets");
    const target = targetInfos.find((info) => info.type === "worker" && info.title === this.name);
    if (target === undefined) throw new Error(`no Worker target named ${this.name}`);
    const { sessionId } = await devtools.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    return sessionId;
  }

  async held(): Promise<number> {
    this.session ??= this.attach();
    const sessionId = await this.session;
    if (devtools === undefined) throw new Error("unreachable: attached without DevTools");
    // twice: the backing stores a collection frees are swept after it, and the next collection waits for the sweep
    await devtools.send("HeapProfiler.collectGarbage", {}, sessionId);
    await devtools.send("HeapProfiler.collectGarbage", {}, sessionId);
    const { usedSize, backingStorageSize } = await devtools.send<{ usedSize: number; backingStorageSize: number }>("Runtime.getHeapUsage", {}, sessionId);
    return usedSize + backingStorageSize;
  }
}

let spawned = 0;

class Driven {
  private readonly name = `sqlite-worker-${spawned++}`;
  private readonly worker = new Worker("/worker.js", { type: "module", name: this.name });
  private readonly measured = new Measured(this.name);
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private next = 1;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerReply | WorkerAsk>) => {
      if ("ask" in event.data) {
        void this.answer(event.data);
        return;
      }
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

  private async answer({ id }: WorkerAsk): Promise<void> {
    let answer: PageAnswer;
    try {
      answer = { answer: id, bytes: await this.measured.held() };
    } catch (err) {
      answer = { answer: id, error: err instanceof Error ? err.message : String(err) };
    }
    this.worker.postMessage(answer);
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

const OPEN_CASES = [...openCases, ...eventCases, ...objectCases, ...vaultCases, ...exportCases, ...importCases];

/** The names one Worker each is given: the list's small cases together, then every large one alone. */
function shares(cases: Case[]): string[][] {
  const small = cases.filter((c) => c.large === undefined).map((c) => c.name);
  return [small, ...cases.filter((c) => c.large !== undefined).map((c) => [c.name])];
}

window.runSqliteSuite = async ({ utf16, snapshot }: SuiteInput): Promise<SuiteOutput> => {
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
  const workers: Driven[] = [];
  const driven = (): Driven => {
    const worker = new Driven();
    workers.push(worker);
    return worker;
  };
  const casesOf = (command: WorkerRequest): Promise<WorkerCaseResult[]> => driven().send(command) as Promise<WorkerCaseResult[]>;
  try {
    const running = [
      ...shares(driverCases).map((names, i) => casesOf({ cmd: "cases", directory: `/cases-${i}`, names })),
      ...shares(OPEN_CASES).map((names, i) => casesOf({ cmd: "open", directory: `/open-${i}`, utf16, names })),
      ...shares(poolCases).map((names) => casesOf({ cmd: "pool", names })),
    ];
    const suites = casesOf({ cmd: "suites", directory: "/suites" });
    const exchanged = driven().send({ cmd: "exchange", directory: "/crossing", snapshot }) as Promise<Exchanged>;
    const holder = driven();
    const second = driven();
    results.push(
      await attempt("a second Worker is refused the directory another holds, and admitted once it is released", async () => {
        await holder.send({ cmd: "hold", directory: "/owned" });
        try {
          await second.send({ cmd: "hold", directory: "/owned" });
        } catch (err) {
          if (!(err instanceof Error && /^DatabaseBusy:/.test(err.message))) throw err;
          await holder.send({ cmd: "release" });
          await second.send({ cmd: "hold", directory: "/owned" });
          await second.send({ cmd: "release" });
          return;
        }
        throw new Error("the second Worker installed over a held directory");
      })
    );
    results.push(
      await attempt("a terminated Worker's directory frees up for the next", async () => {
        await holder.send({ cmd: "hold", directory: "/abandoned" });
        holder.terminate();
        const third = driven();
        await third.send({ cmd: "hold", directory: "/abandoned" });
        await third.send({ cmd: "release" });
      })
    );
    for (const list of await Promise.all(running)) results.push(...list);
    return { results, suites: await suites, exchanged: await exchanged };
  } finally {
    for (const worker of workers) worker.terminate();
  }
};
