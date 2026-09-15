/**
 * The agent's trace: what this runtime observed, beside the vault's
 * events, which record what was said. An envelope opened, a frame
 * sent, a ritual round trip with the mediator — none of it is a fact
 * of the vault, all of it is what an audit or a debugger wants. It
 * lives in the runtime's local trace, which no snapshot carries, as
 * entries typed by stream and observation:
 *
 *   - `envelope`   every seal and open: kind, keys, algorithm — no bytes.
 *   - `wire`       every frame and request, headers only: where, how,
 *                  status, size, time.
 *   - `bytes`      the ciphertext itself, for peeling an envelope open
 *                  on screen. A leaf: nothing hangs on it.
 *   - `mediation`  the plaintext of the mediation rituals.
 *   - `diag`       one-line diagnostics.
 *
 * An entry's `data` carries the stream's own fields and two that link:
 * `parent`, the sequence number of the observation this happened
 * inside (the frame an envelope came off), and `messageId`, the
 * message it ended in, when it ended in one. `traceOf(messageId)`
 * follows both. Retention is a runtime option, not a vault fact: the
 * level lives in the local options, and a level is one prune policy
 * over the whole trace plus the streams it writes at all.
 */

import type { JsonObject, JsonValue, LocalState, TraceEntry, TracePolicy as PrunePolicy } from "@estoc/event-store/v3";

import { bounded } from "./link.js";

export const TRACE_STREAMS = ["envelope", "wire", "bytes", "mediation", "diag"] as const;
export type TraceStream = (typeof TRACE_STREAMS)[number];

export function isTraceStream(name: string): name is TraceStream {
  return (TRACE_STREAMS as readonly string[]).includes(name);
}

/** The stream an entry type belongs to: the part before the first dot. */
export function streamOf(type: string): TraceStream | null {
  const name = type.slice(0, type.indexOf("."));
  return isTraceStream(name) ? name : null;
}

/** What `append` takes as `data`: the stream's own fields, `parent` and `messageId` among them; a field left `undefined` is left out. */
export type TraceData = { [field: string]: JsonValue | undefined };

export interface TracePolicy extends PrunePolicy {
  /** the streams written at all; an entry of any other stream is dropped before it is written */
  streams: ReadonlySet<TraceStream>;
}

const DAY = 24 * 60 * 60 * 1000;
const EVERY: ReadonlySet<TraceStream> = new Set(TRACE_STREAMS);

/** Nothing written; what is there goes at the next prune. */
export const TRACE_OFF: TracePolicy = { keepMs: 0, capRows: 0, streams: new Set() };
/** Every stream but the bytes, a month or twenty thousand entries: the default. */
export const TRACE_NORMAL: TracePolicy = { keepMs: 30 * DAY, capRows: 20_000, streams: new Set(TRACE_STREAMS.filter((stream) => stream !== "bytes")) };
/** Everything, four months or a hundred thousand entries. */
export const TRACE_VERBOSE: TracePolicy = { keepMs: 120 * DAY, capRows: 100_000, streams: EVERY };

export const TRACE_LEVELS = ["off", "normal", "verbose"] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];

export function isTraceLevel(value: unknown): value is TraceLevel {
  return typeof value === "string" && (TRACE_LEVELS as readonly string[]).includes(value);
}

export function tracePolicy(level: TraceLevel): TracePolicy {
  return level === "off" ? TRACE_OFF : level === "verbose" ? TRACE_VERBOSE : TRACE_NORMAL;
}

/** The local option the level is kept under. */
export const TRACE_OPTION = "trace";

export interface AgentTraceOptions {
  /** the level, when known already; `open` reads it from the local options */
  level?: TraceLevel;
  /** keep by this rather than the level's policy: a test's knob, or a caller's own retention */
  policy?: TracePolicy;
}

export type TraceFilter = { stream?: TraceStream; type?: string; after?: number };

function parentOf(entry: TraceEntry): number | undefined {
  const parent = entry.data["parent"];
  return typeof parent === "number" ? parent : undefined;
}

function cleanData(data: TraceData): JsonObject {
  const defined: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(data)) {
    if (value !== undefined) defined[field] = value;
  }
  return defined;
}

export class AgentTrace {
  private current: { level: TraceLevel; policy: TracePolicy };

  /** Over the runtime's local state. `open` reads the level from the options; this takes it as given. */
  constructor(
    private readonly local: LocalState,
    options: AgentTraceOptions = {}
  ) {
    const level = options.level ?? "normal";
    this.current = { level, policy: options.policy ?? tracePolicy(level) };
  }

  /** The trace at the level the local options name — `normal` when they name none. */
  static async open(local: LocalState, options: Omit<AgentTraceOptions, "level"> = {}): Promise<AgentTrace> {
    const level = await local.options.get(TRACE_OPTION);
    return new AgentTrace(local, { ...options, level: isTraceLevel(level) ? level : "normal" });
  }

  get level(): TraceLevel {
    return this.current.level;
  }

  get policy(): TracePolicy {
    return this.current.policy;
  }

  /** Keep at another level from now on and on every open after: the level written to the options, and what the new policy does not keep pruned at once. */
  async setLevel(level: TraceLevel): Promise<{ pruned: number }> {
    await this.local.options.set(TRACE_OPTION, level);
    this.current = { level, policy: tracePolicy(level) };
    return this.prune();
  }

  enabled(stream: TraceStream): boolean {
    return this.policy.streams.has(stream);
  }

  /**
   * Record one observation as `<stream>.<what>`. Returns its sequence
   * number, or `undefined` when the stream is off and nothing was
   * written: what would have hung on it hangs on nothing, and reads as
   * an entry whose parent was not kept.
   */
  async append(stream: TraceStream, what: string, data: TraceData = {}): Promise<number | undefined> {
    if (!this.enabled(stream)) return undefined;
    const entry = await this.local.trace.append(`${stream}.${what}`, cleanData(data));
    return entry.seq;
  }

  /** The entries `filter` admits, in the order written. */
  async read(filter: TraceFilter = {}): Promise<TraceEntry[]> {
    const { stream, ...rest } = filter;
    const entries: TraceEntry[] = [];
    for await (const entry of this.local.trace.scan(rest)) {
      if (stream === undefined || streamOf(entry.type) === stream) entries.push(entry);
    }
    return entries;
  }

  /**
   * Everything observed about one message, across every stream: the
   * envelopes that name `messageId`, everything they happened inside
   * (`parent`, up to the outermost frame), and what happened inside
   * those — the frame's bytes, the answer to it, the mediator's ritual
   * on it — but not the other envelopes that shared the frame: a
   * delivery that carried two messages is two onions, each its own.
   * The whole onion in the order written; empty when nothing was kept.
   */
  async traceOf(messageId: string): Promise<TraceEntry[]> {
    const all = await this.read();
    const bySeq = new Map(all.map((entry) => [entry.seq, entry]));
    const found = new Map<number, TraceEntry>();
    const ends = all.filter((entry) => streamOf(entry.type) === "envelope" && entry.data["messageId"] === messageId);
    if (ends.length === 0) return [];
    for (const end of ends) found.set(end.seq, end);
    // outward: the chain of parents
    const wanted = ends.map(parentOf).filter((seq): seq is number => seq !== undefined);
    while (wanted.length > 0) {
      const seq = wanted.pop() as number;
      const parent = bySeq.get(seq);
      if (parent === undefined || found.has(seq)) continue;
      found.set(seq, parent);
      const next = parentOf(parent);
      if (next !== undefined) wanted.push(next);
    }
    // inward: what hangs on the chain and on what was found, except the other envelopes on the chain above the ends
    const chain = new Set(found.keys());
    const isEnd = new Set(ends.map((entry) => entry.seq));
    for (let grew = true; grew; ) {
      grew = false;
      for (const entry of all) {
        const parent = parentOf(entry);
        if (parent === undefined || !found.has(parent) || found.has(entry.seq)) continue;
        if (streamOf(entry.type) === "envelope" && chain.has(parent) && !isEnd.has(parent)) continue;
        found.set(entry.seq, entry);
        grew = true;
      }
    }
    return [...found.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Apply the policy: entries older than `keepMs` and beyond the newest `capRows` go. Meant for start and then every hour. */
  prune(): Promise<{ pruned: number }> {
    const { keepMs, capRows } = this.policy;
    return this.local.trace.prune({ keepMs, capRows });
  }
}

/** How long an entry is waited for once what it records has happened; past it the work goes on without waiting, whether or not the entry lands. */
const NOTE_WAIT_MS = 10_000;

/** One trace entry owed by work the trace only observes. */
export type Note = { stream: TraceStream; what: string; data: TraceData };

/** Write one entry with a deadline and without a throw: what it observed already stands. Its sequence number, or `undefined` when nothing was written in time. */
export async function note(trace: AgentTrace | null, { stream, what, data }: Note): Promise<number | undefined> {
  if (trace === null) return undefined;
  return bounded(AbortSignal.timeout(NOTE_WAIT_MS), () => trace.append(stream, what, data)).catch(() => undefined);
}

/** Write each entry in turn, as `note` does. */
export async function noteAll(trace: AgentTrace | null, notes: readonly Note[]): Promise<void> {
  for (const entry of notes) await note(trace, entry);
}
