/**
 * The agent's trace: what this device *observed* while the vault's
 * events record what was *said*. An envelope opened, a frame sent, a
 * pickup round-trip with the mediator — none of it is a fact of the
 * vault, all of it is what an audit or a debugger wants, and it is bulky
 * and perishable. So it lives in the agent's local state
 * (`local/agent/trace/<stream>/`: event-store.md §7.2, vault-folder.md
 * §7), one stream per kind of observation, each with a retention of its
 * own, pruned whole segments at a time and never a line.
 *
 * Streams:
 *
 *   - `envelope`   every seal and open: kind, keys, algorithm — no bytes.
 *                  The most valuable and the smallest; kept longest.
 *   - `wire`       every frame and request, headers only: where, how,
 *                  status, size, time.
 *   - `wire.bytes` the ciphertext itself, for peeling an envelope open on
 *                  screen; worthless after a day.
 *   - `mediation`  the plaintext of the mediation rituals (status,
 *                  delivery, grant, update) — the one place these live.
 *   - `diag`       one-line diagnostics.
 *
 * A line is a local event: `eid` and `at` minted here, `type` the
 * observation (`envelope.open`, `wire.in`, `prune`, …), `data` the
 * stream's own fields and two that link: `parent`, the `eid` of the
 * observation this happened inside (the envelope an inner envelope was
 * found in, the frame an envelope came off), and `mid`, the message
 * record it ended in, when it ended in one. `traceOf(mid)` follows both.
 *
 * Retention is a device option, not a vault fact — the same vault keeps
 * everything on a workstation and a day on a phone — so the level lives
 * in the owner's `options.json`, and a wipe takes it with the rest.
 */

import {
  compareLocalEvents,
  EidMinter,
  jsonClean,
  type DamagedLine,
  type JsonObject,
  type JsonValue,
  type LocalEvent,
  type LocalFilter,
  type LocalOwner,
  type PruneReport,
  type RetentionPolicy,
} from "@estoc/event-store";

export const TRACE_STREAMS = ["envelope", "wire", "wire.bytes", "mediation", "diag"] as const;
export type TraceStream = (typeof TRACE_STREAMS)[number];

export function isTraceStream(name: string): name is TraceStream {
  return (TRACE_STREAMS as readonly string[]).includes(name);
}

/** One line of the trace, and the stream it was read from: the directory's name, not a field of the line. */
export type TraceEvent = LocalEvent & { stream: TraceStream };

/** What `append` takes as `data`: the stream's own fields, `parent` and `mid` among them; a field left `undefined` is left out. */
export type TraceData = { [field: string]: JsonValue | undefined };

export interface TracePolicy {
  streams: Record<TraceStream, RetentionPolicy>;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

/** Nothing kept; what is there goes at the next prune. */
export const TRACE_OFF: TracePolicy = {
  streams: {
    envelope: { keepMs: 0, capBytes: 0 },
    wire: { keepMs: 0, capBytes: 0 },
    "wire.bytes": { keepMs: 0, capBytes: 0 },
    mediation: { keepMs: 0, capBytes: 0 },
    diag: { keepMs: 0, capBytes: 0 },
  },
};

/** Everything on, pruned briskly: the default. `wire.bytes` is kept a day so what just arrived can be peeled open. */
export const TRACE_NORMAL: TracePolicy = {
  streams: {
    envelope: { keepMs: 90 * DAY, capBytes: 20 * MIB },
    wire: { keepMs: 30 * DAY, capBytes: 10 * MIB },
    "wire.bytes": { keepMs: DAY, capBytes: 50 * MIB },
    mediation: { keepMs: 7 * DAY, capBytes: 10 * MIB },
    diag: { keepMs: 7 * DAY, capBytes: 5 * MIB },
  },
};

/** Normal times four, and the bytes for a week. */
export const TRACE_VERBOSE: TracePolicy = {
  streams: {
    envelope: { keepMs: 360 * DAY, capBytes: 80 * MIB },
    wire: { keepMs: 120 * DAY, capBytes: 40 * MIB },
    "wire.bytes": { keepMs: 7 * DAY, capBytes: 200 * MIB },
    mediation: { keepMs: 28 * DAY, capBytes: 40 * MIB },
    diag: { keepMs: 28 * DAY, capBytes: 20 * MIB },
  },
};

export const TRACE_LEVELS = ["off", "normal", "verbose"] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];

export function isTraceLevel(value: unknown): value is TraceLevel {
  return typeof value === "string" && (TRACE_LEVELS as readonly string[]).includes(value);
}

/** The policy a user-facing level stands for. */
export function tracePolicy(level: TraceLevel): TracePolicy {
  return level === "off" ? TRACE_OFF : level === "verbose" ? TRACE_VERBOSE : TRACE_NORMAL;
}

/** The level `options.json` names under `trace`; `normal` when it names none. */
export function traceLevelOf(options: JsonObject | null): TraceLevel {
  const level = options?.["trace"];
  return isTraceLevel(level) ? level : "normal";
}

/** What one prune did to one stream. */
export type TracePruneReport = PruneReport & { stream: TraceStream };

export interface AgentTraceOptions {
  /** pins time (tests); left out, the wall clock */
  clock?: () => Date;
  /** the level, when known already; `open` reads it from `options.json` */
  level?: TraceLevel;
  /** keep by this rather than the level's policy: a test's knob, or a caller's own retention */
  policy?: TracePolicy;
}

/** The `parent` a line cites: a string in `data`, or nothing. */
function parentOf(event: LocalEvent): string | undefined {
  const parent = event.data["parent"];
  return typeof parent === "string" ? parent : undefined;
}

/** `data` with its `undefined` fields left out, checked to be JSON. */
function cleanData(data: TraceData): JsonObject {
  const defined: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(data)) {
    if (value !== undefined) {
      defined[field] = value;
    }
  }
  return jsonClean<JsonObject>(defined);
}

export class AgentTrace {
  private readonly eids = new EidMinter();
  private readonly clock: () => Date;
  private current: { level: TraceLevel; policy: TracePolicy };

  /**
   * Over the agent's local state, `vault.local("agent")`. `open` reads
   * the level from `options.json`; this takes it as given.
   */
  constructor(
    private readonly owner: LocalOwner,
    options: AgentTraceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    const level = options.level ?? "normal";
    this.current = { level, policy: options.policy ?? tracePolicy(level) };
  }

  /** The trace at the level `options.json` names — `normal` when it names none. */
  static async open(owner: LocalOwner, options: Omit<AgentTraceOptions, "level"> = {}): Promise<AgentTrace> {
    return new AgentTrace(owner, { ...options, level: traceLevelOf(await owner.readOptions()) });
  }

  get level(): TraceLevel {
    return this.current.level;
  }

  get policy(): TracePolicy {
    return this.current.policy;
  }

  /**
   * Keep at another level from now on and on every open after: the
   * level written to `options.json` (beside whatever else is there), a
   * stream turned off no longer written, and what the new policy does
   * not keep pruned at once.
   */
  async setLevel(level: TraceLevel): Promise<TracePruneReport[]> {
    await this.owner.writeOptions({ ...(await this.owner.readOptions()), trace: level });
    this.current = { level, policy: tracePolicy(level) };
    return this.prune();
  }

  /** Is this stream being written? */
  enabled(stream: TraceStream): boolean {
    return this.policy.streams[stream].keepMs > 0;
  }

  /**
   * Record one observation. Returns its `eid` — minted here even when
   * the stream is off, so a caller can still name it as the `parent` of
   * what it finds inside; a line whose parent was never written is a
   * line whose parent was not kept, and reads as such.
   */
  async append(stream: TraceStream, type: string, data: TraceData = {}): Promise<string> {
    const now = this.clock();
    const eid = this.eids.mint(now.getTime());
    if (!this.enabled(stream)) {
      return eid;
    }
    const event: LocalEvent = { eid, at: now.toISOString(), type, data: cleanData(data) };
    await this.owner.trace(stream).append(event);
    return eid;
  }

  /** One stream's lines, those the filter admits, in canonical order; what was not a line, `damaged` says. */
  async read(stream: TraceStream, filter?: LocalFilter): Promise<TraceEvent[]> {
    const events: TraceEvent[] = [];
    for await (const event of this.owner.trace(stream).scan(filter)) {
      events.push({ ...event, stream });
    }
    return events;
  }

  /** What the last `read` of this stream met that was not a line. */
  damaged(stream: TraceStream): DamagedLine[] {
    return this.owner.trace(stream).damaged();
  }

  /**
   * Everything observed about one message record, across every stream:
   * the envelopes that name `mid`, everything they happened inside
   * (`parent`, up to the outermost frame), and what happened inside
   * those — the frame's bytes, the answer to it, the mediator's ritual on
   * it — but not the other envelopes that shared the frame: a delivery
   * that carried two messages is two onions, each its own. The whole
   * onion in canonical order, the outer layers first; empty when nothing
   * was kept: the record still stands, its trace has expired.
   *
   * Read the way §7.2 means a trace to be read: a chain of `parent`s is
   * a chain of lookups by `eid`, and what hung on a line is a lookup by
   * `data.parent` — one filtered `scan` per link, which is what a store
   * may index.
   */
  async traceOf(mid: string): Promise<TraceEvent[]> {
    const found = new Map<string, TraceEvent>();
    const take = (events: TraceEvent[]): TraceEvent[] => {
      const fresh = events.filter((event) => !found.has(event.eid));
      for (const event of fresh) {
        found.set(event.eid, event);
      }
      return fresh;
    };
    // the envelopes that ended in (or began as) the record
    const ends = take(await this.read("envelope", { data: { mid } }));
    if (ends.length === 0) {
      return [];
    }
    // outward: the envelopes and the frame they happened inside — a chain
    // of parents, one lookup per link (an onion has two or three layers)
    let wanted = this.parentsOf(ends, found);
    while (wanted.length > 0) {
      const hit: TraceEvent[] = [];
      for (const eid of wanted) {
        for (const stream of ["envelope", "wire"] as const) {
          hit.push(...(await this.read(stream, { eid })));
        }
      }
      wanted = this.parentsOf(take(hit), found);
    }
    // inward: what hung on the chain that is not another envelope — the
    // bytes, the wire's answer, the mediator's part — and anything inside
    // the ends themselves
    const chain = [...found.keys()];
    const inside: TraceEvent[] = [];
    for (const stream of ["wire", "wire.bytes", "mediation"] as const) {
      for (const eid of chain) {
        inside.push(...take(await this.read(stream, { data: { parent: eid } })));
      }
    }
    for (const event of [...ends, ...inside]) {
      take(await this.read("envelope", { data: { parent: event.eid } }));
    }
    return [...found.values()].sort(compareLocalEvents);
  }

  /** The parents these lines cite that are not found yet, each once. */
  private parentsOf(events: TraceEvent[], found: Map<string, TraceEvent>): string[] {
    const parents = new Set<string>();
    for (const event of events) {
      const parent = parentOf(event);
      if (parent !== undefined && !found.has(parent)) {
        parents.add(parent);
      }
    }
    return [...parents];
  }

  /**
   * Apply the policy: every stream pruned by its retention — the segments
   * whose every line is older than `keepMs`, then the oldest until the
   * stream fits `capBytes`; a stream at `keepMs` 0 emptied. Deleting for
   * cap is out of the ordinary, so it leaves a `prune` line in `diag`
   * naming the stream and what went; a gap in a trace is then a fact on
   * record, not a mystery. Meant for start and then every hour.
   */
  async prune(): Promise<TracePruneReport[]> {
    const reports: TracePruneReport[] = [];
    for (const stream of TRACE_STREAMS) {
      reports.push({ stream, ...(await this.owner.trace(stream).prune(this.policy.streams[stream])) });
    }
    for (const report of reports) {
      if (report.byCap > 0) {
        await this.append("diag", "prune", { reason: "cap", of: report.stream, segments: report.byCap, bytes: report.bytesFreed });
      }
    }
    return reports;
  }
}
