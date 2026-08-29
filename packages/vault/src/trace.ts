import { v7 as uuidv7 } from "uuid";

import type { VaultBackend } from "./backend/types.js";
import { TRACE_DIR, utf8, text } from "./layout.js";
import { newSegment, orderSegments, parseSegment, type DamagedLine } from "./log.js";

/**
 * The trace log: what this device *observed* while the message log
 * recorded what was *said*. An envelope opened, a frame sent, a pickup
 * round-trip with the mediator — none of it is a fact about the
 * conversation, all of it is what an audit or a debugger wants, and it
 * is bulky and perishable. So it lives apart, under `trace/<stream>/`,
 * one stream per kind of observation, and it is the one log in the vault
 * whose segments get deleted: every stream has a retention, and pruning
 * unlinks whole segments — never a line, never a rewrite.
 *
 * Streams (§6.10 of the format):
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
 * A trace event links two ways: `parent` is the `tid` of the observation
 * it happened inside (the envelope an inner envelope was found in, the
 * frame an envelope came off), and `mid` names the message-log record it
 * ended in, when it ended in one. `traceOf(mid)` follows both.
 *
 * Retention is a device option, not a vault fact — the same vault keeps
 * everything on a workstation and a day on a phone — so the policy is
 * handed to the log, never written into the vault.
 */
export const TRACE_STREAMS = ["envelope", "wire", "wire.bytes", "mediation", "diag"] as const;
export type TraceStream = (typeof TRACE_STREAMS)[number];

export function isTraceStream(name: string): name is TraceStream {
  return (TRACE_STREAMS as readonly string[]).includes(name);
}

/** One line of a trace stream. Fields beyond the common ones are the stream's own. */
export interface TraceEvent {
  stream: TraceStream;
  /** this observation's id, uuidv7 */
  tid: string;
  /** ISO time */
  at: string;
  /** what was observed: `envelope.open`, `wire.in`, `prune`, … */
  event: string;
  /** the `tid` of the observation this happened inside */
  parent?: string;
  /** the message record this observation ended in, when it did */
  mid?: string;
  [field: string]: unknown;
}

/** What `append` takes: everything the caller knows; the log stamps the rest. */
export interface TraceInput {
  event: string;
  parent?: string;
  mid?: string;
  /** given only to replay or test; minted otherwise */
  tid?: string;
  at?: string;
  [field: string]: unknown;
}

export interface StreamRetention {
  /** how long a line is kept, in milliseconds; 0 turns the stream off (and prune drops what is there) */
  keepMs: number;
  /** the most bytes the stream may hold; over it, the oldest segments go first */
  capBytes: number;
}

export interface TracePolicy {
  streams: Record<TraceStream, StreamRetention>;
  /**
   * When a new segment is started: after this many bytes, or this many
   * milliseconds since the segment began, whichever comes first. Small
   * segments prune finely; a line is never older than its segment's name
   * plus `ms`, which is what lets prune go by names alone.
   */
  rotate: { bytes: number; ms: number };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

const ROTATE = { bytes: MIB, ms: DAY };

/** Nothing kept; what is there goes at the next prune. */
export const TRACE_OFF: TracePolicy = {
  streams: {
    envelope: { keepMs: 0, capBytes: 0 },
    wire: { keepMs: 0, capBytes: 0 },
    "wire.bytes": { keepMs: 0, capBytes: 0 },
    mediation: { keepMs: 0, capBytes: 0 },
    diag: { keepMs: 0, capBytes: 0 },
  },
  rotate: ROTATE,
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
  rotate: ROTATE,
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
  rotate: ROTATE,
};

export type TraceLevel = "off" | "normal" | "verbose";

/** The policy a user-facing level stands for. */
export function tracePolicy(level: TraceLevel): TracePolicy {
  return level === "off" ? TRACE_OFF : level === "verbose" ? TRACE_VERBOSE : TRACE_NORMAL;
}

/** What one prune did to one stream. */
export interface PruneReport {
  stream: TraceStream;
  /** segments dropped for being older than `keepMs` */
  byKeep: number;
  /** segments dropped to get under `capBytes` */
  byCap: number;
  bytesFreed: number;
}

function parseLine(line: string, where: string): TraceEvent {
  const event = JSON.parse(line) as Partial<TraceEvent>;
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.stream !== "string" ||
    !isTraceStream(event.stream) ||
    typeof event.tid !== "string" ||
    typeof event.at !== "string" ||
    typeof event.event !== "string" ||
    (event.parent !== undefined && typeof event.parent !== "string") ||
    (event.mid !== undefined && typeof event.mid !== "string")
  ) {
    throw new Error(`${where} is not a trace event`);
  }
  return event as TraceEvent;
}

/** The millisecond a uuidv7-named segment was minted at — its first 48 bits. */
export function segmentTime(segment: string): number {
  const hex = segment.slice(0, 8) + segment.slice(9, 13);
  return parseInt(hex, 16);
}

interface OpenSegment {
  name: string;
  bytes: number;
  since: number;
}

export class TraceLog {
  /** per stream: appends and prunes run one at a time */
  private readonly chains = new Map<TraceStream, Promise<unknown>>();
  /** per stream: the segment being appended to, if any */
  private readonly open = new Map<TraceStream, OpenSegment>();

  /**
   * `clock` pins time (tests); left out, the log uses the wall clock and
   * lets uuidv7 keep segment names monotonic on its own.
   */
  constructor(
    private readonly backend: VaultBackend,
    private current: TracePolicy,
    private readonly clock?: () => Date
  ) {}

  get policy(): TracePolicy {
    return this.current;
  }

  /**
   * Keep by another policy from now on: a stream turned off stops being
   * written at once, what is already there goes by the next `prune`.
   */
  setPolicy(policy: TracePolicy): void {
    this.current = policy;
  }

  /** Is this stream being written? */
  enabled(stream: TraceStream): boolean {
    return this.policy.streams[stream].keepMs > 0;
  }

  static dir(stream: TraceStream): string {
    return `${TRACE_DIR}/${stream}`;
  }

  private now(): Date {
    return this.clock === undefined ? new Date() : this.clock();
  }

  private serialise<T>(stream: TraceStream, work: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(stream) ?? Promise.resolve()).then(work);
    this.chains.set(
      stream,
      run.catch(() => undefined)
    );
    return run;
  }

  /**
   * Record one observation. Returns its `tid` — minted here even when the
   * stream is off, so a caller can still name it as the `parent` of what
   * it finds inside; a line whose parent was never written is a line
   * whose parent was not kept, and reads as such.
   *
   * Each session writes segments of its own: the first append to a stream
   * starts one, and a segment is left behind once it is `rotate.bytes`
   * long or `rotate.ms` old. No session ever appends to another's
   * segment, so a cut-short last line stays where it is, damaged and
   * skipped, and nothing has to be healed.
   */
  append(stream: TraceStream, input: TraceInput): Promise<string> {
    const now = this.now();
    const tid = input.tid ?? (this.clock === undefined ? uuidv7() : uuidv7({ msecs: now.getTime() }));
    if (!this.enabled(stream)) {
      return Promise.resolve(tid);
    }
    const event: TraceEvent = { ...input, stream, tid, at: input.at ?? now.toISOString() };
    const line = utf8(JSON.stringify(event) + "\n");
    return this.serialise(stream, async () => {
      let open = this.open.get(stream);
      if (
        open === undefined ||
        open.bytes >= this.policy.rotate.bytes ||
        now.getTime() - open.since >= this.policy.rotate.ms
      ) {
        open = { name: newSegment(this.clock === undefined ? undefined : now), bytes: 0, since: now.getTime() };
        this.open.set(stream, open);
      }
      await this.backend.append(`${TraceLog.dir(stream)}/${open.name}`, line);
      open.bytes += line.length;
      return tid;
    });
  }

  /** Every event of one stream, in segment order then line order; damaged lines reported and skipped. */
  async read(stream: TraceStream, onDamaged?: (damaged: DamagedLine) => void): Promise<TraceEvent[]> {
    const dir = TraceLog.dir(stream);
    const events: TraceEvent[] = [];
    for (const segment of orderSegments(await this.backend.list(dir))) {
      const bytes = await this.backend.read(`${dir}/${segment}`);
      if (bytes === null) {
        continue;
      }
      events.push(...parseSegment(text(bytes), segment, parseLine, onDamaged));
    }
    return events;
  }

  /**
   * Everything observed about one message record, across every stream:
   * the events that name `mid`, everything they happened inside
   * (`parent`, up to the outermost frame), and everything that happened
   * inside those — the whole onion, ordered by time. Empty when nothing
   * was kept: the record still stands, its trace has expired.
   */
  async traceOf(mid: string): Promise<TraceEvent[]> {
    const byTid = new Map<string, TraceEvent>();
    const children = new Map<string, TraceEvent[]>();
    for (const stream of TRACE_STREAMS) {
      for (const event of await this.read(stream)) {
        byTid.set(event.tid, event);
        if (event.parent !== undefined) {
          const siblings = children.get(event.parent);
          if (siblings === undefined) {
            children.set(event.parent, [event]);
          } else {
            siblings.push(event);
          }
        }
      }
    }
    const found = new Map<string, TraceEvent>();
    const visit = (event: TraceEvent): void => {
      if (found.has(event.tid)) {
        return;
      }
      found.set(event.tid, event);
      const parent = event.parent === undefined ? undefined : byTid.get(event.parent);
      if (parent !== undefined) {
        visit(parent);
      }
      for (const child of children.get(event.tid) ?? []) {
        visit(child);
      }
    };
    for (const event of byTid.values()) {
      if (event.mid === mid) {
        visit(event);
      }
    }
    return [...found.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0));
  }

  /**
   * Apply the policy: for every stream, unlink the segments whose every
   * line is older than `keepMs` (by name — a segment's lines are at most
   * `rotate.ms` newer than its name), then the oldest segments until the
   * stream fits `capBytes`. A stream with `keepMs` 0 is emptied. Deleting
   * for cap is out of the ordinary, so it leaves a `prune` line in `diag`
   * naming the stream and what went; a gap in a trace is then a fact on
   * record, not a mystery. Meant for start and then every hour; it reads
   * names and sizes, never contents.
   */
  async prune(): Promise<PruneReport[]> {
    const reports: PruneReport[] = [];
    for (const stream of TRACE_STREAMS) {
      reports.push(await this.serialise(stream, () => this.pruneStream(stream)));
    }
    for (const report of reports) {
      if (report.byCap > 0) {
        await this.append("diag", {
          event: "prune",
          reason: "cap",
          of: report.stream,
          segments: report.byCap,
          bytes: report.bytesFreed,
        });
      }
    }
    return reports;
  }

  private async pruneStream(stream: TraceStream): Promise<PruneReport> {
    const { keepMs, capBytes } = this.policy.streams[stream];
    const dir = TraceLog.dir(stream);
    const report: PruneReport = { stream, byKeep: 0, byCap: 0, bytesFreed: 0 };
    const horizon = this.now().getTime() - keepMs - this.policy.rotate.ms;
    const kept: { name: string; bytes: number }[] = [];
    for (const name of orderSegments(await this.backend.list(dir))) {
      const bytes = (await this.backend.size(`${dir}/${name}`)) ?? 0;
      if (keepMs === 0 || segmentTime(name) <= horizon) {
        await this.unlink(stream, name);
        report.byKeep += 1;
        report.bytesFreed += bytes;
      } else {
        kept.push({ name, bytes });
      }
    }
    let total = kept.reduce((sum, segment) => sum + segment.bytes, 0);
    for (const segment of kept) {
      if (total <= capBytes) {
        break;
      }
      await this.unlink(stream, segment.name);
      total -= segment.bytes;
      report.byCap += 1;
      report.bytesFreed += segment.bytes;
    }
    return report;
  }

  private async unlink(stream: TraceStream, name: string): Promise<void> {
    await this.backend.remove(`${TraceLog.dir(stream)}/${name}`);
    if (this.open.get(stream)?.name === name) {
      this.open.delete(stream);
    }
  }
}

/** Is this path under `.estoc/trace/` — this device's observations, no part of a snapshot? */
export function isTracePath(path: string): boolean {
  return path === TRACE_DIR || path.startsWith(`${TRACE_DIR}/`);
}
