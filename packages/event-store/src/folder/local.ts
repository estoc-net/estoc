/**
 * This copy's own (vault-folder.md §7): an owner's options, cache and
 * trace under `local/<owner>/`. The trace is the `LocalEventStore` of
 * event-store.md §7.2 over segments, pruned whole segments at a time.
 */

import type { VaultBackend } from "../backend/types.js";
import { walk } from "../backend/types.js";
import { InvalidEvent } from "../errors.js";
import { EidMinter, type DamagedLine } from "../event.js";
import { checkPath } from "../files.js";
import { isJsonObject, type JsonObject } from "../json.js";
import { compareLocalEvents, isLocalEvent, matchesLocal, type LocalEvent, type LocalEventStore, type LocalFilter } from "../local.js";
import { isSegmentName, jsonLine, prettyJson, text } from "./layout.js";
import { decodeLocalEvent, decodeSegment } from "./lines.js";
import { Serial } from "./serial.js";

/** What a stream keeps (§7.2): lines this old, this many bytes; 0 turns it off. */
export interface RetentionPolicy {
  /** how long a line is kept, in milliseconds; 0 keeps nothing (and prune drops what is there) */
  keepMs: number;
  /** the most bytes the stream may hold; over it, the oldest segments go first */
  capBytes: number;
}

/** What one prune did. */
export interface PruneReport {
  /** segments dropped for being older than `keepMs` */
  byKeep: number;
  /** segments dropped to get under `capBytes` */
  byCap: number;
  bytesFreed: number;
}

/**
 * When a new segment is started: after this many bytes, or this many
 * milliseconds since the segment began, whichever comes first. Small
 * segments prune finely; a line is never older than its segment's name
 * plus `ms`, which is what lets prune go by names alone.
 */
export interface Rotation {
  bytes: number;
  ms: number;
}

export const DEFAULT_ROTATION: Rotation = { bytes: 1024 * 1024, ms: 24 * 60 * 60 * 1000 };

export interface FolderLocalEventStoreOptions {
  rotate?: Rotation;
  clock?: () => Date;
  /** throws once the store's owner is being disposed of (vault-folder.md §3.1): checked as an operation is called */
  guard?: () => void;
  /** throws once the disposal has run: checked as an operation's turn comes */
  alive?: () => void;
}

/** The millisecond a uuidv7-named segment was minted at — its first 48 bits. */
export function segmentTime(name: string): number {
  return parseInt(name.slice(0, 8) + name.slice(9, 13), 16);
}

/**
 * One trace stream as segments in one directory. Each instance writes
 * segments of its own: the first append starts one, and a segment is
 * left behind once it is `rotate.bytes` long or `rotate.ms` old. No
 * instance appends to another's segment, so a cut-short last line stays
 * where it is, damaged and skipped, and nothing has to be healed.
 */
export class FolderLocalEventStore implements LocalEventStore<LocalEvent, RetentionPolicy, PruneReport> {
  private readonly serial = new Serial();
  private readonly names = new EidMinter();
  private readonly rotate: Rotation;
  private readonly clock: () => Date;
  private open: { path: string; bytes: number; since: number } | null = null;
  private lastDamaged: DamagedLine[] = [];
  private readonly guard: () => void;
  private readonly alive: () => void;

  constructor(
    private readonly backend: VaultBackend,
    readonly dir: string,
    options: FolderLocalEventStoreOptions = {}
  ) {
    this.rotate = options.rotate ?? DEFAULT_ROTATION;
    this.clock = options.clock ?? (() => new Date());
    this.guard = options.guard ?? (() => undefined);
    this.alive = options.alive ?? (() => undefined);
  }

  /** Resolves once everything queued so far has run. */
  settle(): Promise<void> {
    return this.serial.run(() => undefined);
  }

  private async segments(): Promise<string[]> {
    return (await this.backend.list(this.dir)).filter(isSegmentName).sort();
  }

  async append(event: LocalEvent): Promise<void> {
    this.guard();
    if (!isLocalEvent(event)) {
      throw new InvalidEvent("not a local event: eid, at, type, data and nothing else");
    }
    const line = jsonLine(event);
    return this.serial.run(async () => {
      this.alive();
      const now = this.clock().getTime();
      if (this.open === null || this.open.bytes >= this.rotate.bytes || now - this.open.since >= this.rotate.ms) {
        this.open = { path: `${this.dir}/${this.names.mint(now)}.jsonl`, bytes: 0, since: now };
      }
      await this.backend.append(this.open.path, line);
      this.open.bytes += line.length;
    });
  }

  async *scan(filter?: LocalFilter): AsyncIterable<LocalEvent> {
    this.guard();
    // read in the stream's turn, so that a scan in flight finishes before a disposal removes the segments
    const events = await this.serial.run(async () => {
      this.alive();
      const found: LocalEvent[] = [];
      const damaged: DamagedLine[] = [];
      for (const name of await this.segments()) {
        const path = `${this.dir}/${name}`;
        const bytes = await this.backend.read(path);
        if (bytes === null) {
          continue;
        }
        const read = decodeSegment(bytes, path, decodeLocalEvent);
        found.push(...read.events);
        damaged.push(...read.damaged);
      }
      this.lastDamaged = damaged;
      return found.sort(compareLocalEvents);
    });
    for (const event of events) {
      if (matchesLocal(event, filter)) {
        yield event;
      }
    }
  }

  /** What the last `scan` met that was not a line. */
  damaged(): DamagedLine[] {
    return this.lastDamaged;
  }

  /**
   * Unlink the segments whose every line is older than `keepMs` (by
   * name — a segment's lines are at most `rotate.ms` newer than its
   * name), then the oldest until the stream fits `capBytes`. `keepMs` 0
   * empties the stream. Reads names and sizes, never contents.
   */
  async prune(policy: RetentionPolicy): Promise<PruneReport> {
    this.guard();
    return this.serial.run(async () => {
      this.alive();
      const report: PruneReport = { byKeep: 0, byCap: 0, bytesFreed: 0 };
      const horizon = this.clock().getTime() - policy.keepMs - this.rotate.ms;
      const kept: { name: string; bytes: number }[] = [];
      for (const name of await this.segments()) {
        const bytes = (await this.backend.size(`${this.dir}/${name}`)) ?? 0;
        if (policy.keepMs <= 0 || segmentTime(name) <= horizon) {
          await this.unlink(name);
          report.byKeep += 1;
          report.bytesFreed += bytes;
        } else {
          kept.push({ name, bytes });
        }
      }
      let total = kept.reduce((sum, segment) => sum + segment.bytes, 0);
      for (const segment of kept) {
        if (total <= policy.capBytes) {
          break;
        }
        await this.unlink(segment.name);
        total -= segment.bytes;
        report.byCap += 1;
        report.bytesFreed += segment.bytes;
      }
      return report;
    });
  }

  private async unlink(name: string): Promise<void> {
    const path = `${this.dir}/${name}`;
    await this.backend.remove(path);
    if (this.open?.path === path) {
      this.open = null;
    }
  }
}

/** Rebuildable files an owner keeps (§7.1): read, write, list, drop — any of it, any time. */
export interface LocalCache {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<string[]>;
  remove(path: string): Promise<void>;
  /** everything under `cache/` */
  clear(): Promise<void>;
}

/**
 * One owner's local state (§7): `options.json`, `cache/`, and a trace
 * stream per name under `trace/`. The directory is the owner's —
 * `local/agent`, `local/extensions/<ext>` — and nothing here is a fact
 * of the vault.
 *
 * Every operation here queues on the owner's own chain, so that
 * `settle` covers it: a disposal (vault-folder.md §3.1) waits for what
 * was issued before it and removes the directory after — no write that
 * passed the guard lands on the emptied tree, no read reads it.
 */
export class LocalOwner {
  private readonly traces = new Map<string, FolderLocalEventStore>();
  private readonly serial = new Serial();
  private readonly alive: () => void;

  constructor(
    private readonly backend: VaultBackend,
    readonly dir: string,
    private readonly options: FolderLocalEventStoreOptions = {},
    /** throws once the owner is being disposed of with its extension (vault-folder.md §3.1) */
    private readonly guard: () => void = () => undefined
  ) {
    this.alive = options.alive ?? (() => undefined);
  }

  /** Resolves once everything queued on the owner — its writes and its trace streams — so far has run. */
  async settle(): Promise<void> {
    await Promise.all([this.serial.run(() => undefined), ...[...this.traces.values()].map((trace) => trace.settle())]);
  }

  /** An operation, in the owner's turn. */
  private queued<T>(work: () => Promise<T>): Promise<T> {
    return this.serial.run(() => {
      this.alive();
      return work();
    });
  }

  /** What this device was told: a JSON object, or null when nothing was. */
  async readOptions(): Promise<JsonObject | null> {
    this.guard();
    const bytes = await this.queued(() => this.backend.read(`${this.dir}/options.json`));
    if (bytes === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text(bytes));
    if (!isJsonObject(parsed)) {
      throw new Error(`${this.dir}/options.json is not a JSON object`);
    }
    return parsed;
  }

  async writeOptions(options: JsonObject): Promise<void> {
    this.guard();
    const bytes = prettyJson(options);
    return this.queued(() => this.backend.write(`${this.dir}/options.json`, bytes));
  }

  get cache(): LocalCache {
    this.guard();
    const guard = this.guard;
    const base = `${this.dir}/cache`;
    const at = (path: string): string => `${base}/${checkPath(path)}`;
    const backend = this.backend;
    // every method async, so that a guard's throw is a rejection like any other failure
    return {
      read: async (path) => {
        guard();
        const file = at(path);
        return this.queued(() => backend.read(file));
      },
      write: async (path, bytes) => {
        guard();
        const file = at(path);
        return this.queued(() => backend.write(file, bytes));
      },
      list: async () => {
        guard();
        return this.queued(async () => (await walk(backend, base)).map((path) => path.slice(base.length + 1)));
      },
      remove: async (path) => {
        guard();
        const file = at(path);
        return this.queued(() => backend.remove(file));
      },
      clear: async () => {
        guard();
        return this.queued(async () => {
          for (const path of await walk(backend, base)) {
            await backend.remove(path);
          }
        });
      },
    };
  }

  /** One trace stream, by name; the owner divides its trace as it likes. */
  trace(stream: string): FolderLocalEventStore {
    this.guard();
    checkPath(stream);
    let store = this.traces.get(stream);
    if (store === undefined) {
      store = new FolderLocalEventStore(this.backend, `${this.dir}/trace/${stream}`, { ...this.options, guard: this.guard });
      this.traces.set(stream, store);
    }
    return store;
  }
}
