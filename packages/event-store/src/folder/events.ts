/**
 * The reference EventStore over a folder (vault-folder.md §9): one log
 * per device under `devices/<dev>/`, segments of JSONL, read whole and
 * sorted, appended by one writer, merged by union.
 */

import { BadToken, ForkedSelf } from "../errors.js";
import {
  cleanDraft,
  compareEvents,
  isDeviceId,
  matches,
  validateEvent,
  type ChangeToken,
  type Conflict,
  type DamagedLine,
  type Draft,
  type Event,
  type EventStore,
  type Filter,
  type Ingested,
} from "../event.js";
import { deepFreeze, jsonClean, sameJson, type JsonObject } from "../json.js";
import { DEVICES_DIR, isSegmentName, jsonLine, utf8 } from "./layout.js";
import { decodeEvent, decodeSegment, endsClean } from "./lines.js";
import type { StoreContext } from "./serial.js";

/** The writer's own rotation (§5): a fresh segment once the open one is this long. */
export const ROTATE_BYTES = 4 * 1024 * 1024;

/** What reading one device's directory found. */
interface DeviceRead {
  events: Map<string, Event>;
  damaged: DamagedLine[];
  conflicts: Conflict[];
}

/** What a token names (§9.4): the instance, the store, and every segment's length. */
interface Frontier {
  instance: string;
  store: string;
  segments: Record<string, number>;
}

export class FolderEventStore implements EventStore {
  /** the segment this instance appends to, once it has */
  private open: { path: string; bytes: number } | null = null;
  /** what the last read of each device's directory found that was not an event */
  private readonly findings = new Map<string, { damaged: DamagedLine[]; conflicts: Conflict[] }>();

  constructor(private readonly ctx: StoreContext) {}

  get self(): string {
    return this.ctx.self;
  }

  private get devicesDir(): string {
    return `${this.ctx.base}/${DEVICES_DIR}`;
  }

  private newSegmentPath(dev: string): string {
    return `${this.devicesDir}/${dev}/${this.ctx.segments.mint(this.ctx.clock().getTime())}.jsonl`;
  }

  // ---- reading -----------------------------------------------------------

  /** Segment paths under one device's directory, in path order (§9.5). */
  private async segmentsOf(dev: string): Promise<string[]> {
    const dir = `${this.devicesDir}/${dev}`;
    return (await this.ctx.backend.list(dir))
      .filter(isSegmentName)
      .sort()
      .map((name) => `${dir}/${name}`);
  }

  /** The devices with a directory here, in path order. */
  private async devices(): Promise<string[]> {
    return (await this.ctx.backend.dirs(this.devicesDir)).filter(isDeviceId).sort();
  }

  /**
   * One device's whole log (§9.1): every segment, every line, the author
   * checked against the directory, deduplicated by eid — the first by
   * path order then line order is kept, the others with different
   * content reported (§9.5). What was not an event is remembered for
   * `damaged()` and `conflicting()`.
   */
  private async readDevice(dev: string): Promise<DeviceRead> {
    const read: DeviceRead = { events: new Map(), damaged: [], conflicts: [] };
    for (const path of await this.segmentsOf(dev)) {
      const bytes = await this.ctx.backend.read(path);
      if (bytes === null) {
        continue;
      }
      const { events, damaged } = decodeSegment(bytes, path, (line) => decodeEvent(line, dev));
      read.damaged.push(...damaged);
      for (const event of events) {
        const have = read.events.get(event.eid);
        if (have === undefined) {
          read.events.set(event.eid, event);
        } else if (!sameJson(have, event)) {
          read.conflicts.push({ eid: event.eid, kept: have, other: event });
        }
      }
    }
    this.findings.set(dev, { damaged: read.damaged, conflicts: read.conflicts });
    return read;
  }

  /** Every device's log, or one device's: the store's event set by eid. */
  private async readAll(author?: string): Promise<Map<string, Event>> {
    const devs = author === undefined ? await this.devices() : isDeviceId(author) ? [author] : [];
    const all = new Map<string, Event>();
    for (const dev of devs) {
      const { events } = await this.readDevice(dev);
      for (const [eid, event] of events) {
        const have = all.get(eid);
        if (have === undefined) {
          all.set(eid, event);
        } else {
          // one eid under two devices: two authors, so two contents — kept by path order
          const found = this.findings.get(dev) as { conflicts: Conflict[] };
          found.conflicts.push({ eid, kept: have, other: event });
        }
      }
    }
    return all;
  }

  async *scan(filter?: Filter): AsyncIterable<Event> {
    this.ctx.guard();
    const events = [...(await this.readAll(filter?.author)).values()].sort(compareEvents);
    for (const event of events) {
      if (matches(event, filter)) {
        yield event;
      }
    }
  }

  damaged(): DamagedLine[] {
    return [...this.findings.keys()].sort().flatMap((dev) => (this.findings.get(dev) as { damaged: DamagedLine[] }).damaged);
  }

  conflicting(): Conflict[] {
    return [...this.findings.keys()].sort().flatMap((dev) => (this.findings.get(dev) as { conflicts: Conflict[] }).conflicts);
  }

  // ---- writing -----------------------------------------------------------

  async append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>> {
    this.ctx.guard();
    const clean = cleanDraft(draft);
    return this.ctx.serial.run(async () => {
      this.ctx.alive();
      const now = this.ctx.clock();
      const event: Event<D> = {
        eid: this.ctx.segments.mint(now.getTime()),
        at: now.toISOString(),
        author: this.ctx.self,
        type: clean.type,
        blobs: clean.blobs,
        data: clean.data,
      };
      const line = jsonLine(event);
      const open = await this.openSegment();
      await this.ctx.backend.append(open.path, line);
      open.bytes += line.length;
      this.ctx.generation += 1;
      return deepFreeze(event);
    });
  }

  /**
   * The segment this instance appends to (§9.2): the newest under
   * `devices/<self>/` the first time, healed if a crash left it
   * unterminated (§5), a fresh one once it is long enough.
   */
  private async openSegment(): Promise<{ path: string; bytes: number }> {
    if (this.open === null) {
      const newest = (await this.segmentsOf(this.ctx.self)).at(-1);
      if (newest === undefined) {
        this.open = { path: this.newSegmentPath(this.ctx.self), bytes: 0 };
      } else {
        const bytes = (await this.ctx.backend.read(newest)) ?? new Uint8Array(0);
        let length = bytes.length;
        if (!endsClean(bytes)) {
          await this.ctx.backend.append(newest, utf8("\n"));
          length += 1;
        }
        this.open = { path: newest, bytes: length };
      }
    }
    if (this.open.bytes >= this.ctx.rotateBytes) {
      this.open = { path: this.newSegmentPath(this.ctx.self), bytes: 0 };
    }
    return this.open;
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    this.ctx.guard();
    // One pass, reading first (§9.3): what is here, then the whole input.
    const generation = this.ctx.generation;
    const held = await this.readAll();
    const outcome: Ingested = { added: 0, duplicates: 0, conflicts: [], rejected: [] };
    const staged = new Map<string, Event>();
    const forked: Event[] = [];
    for await (const raw of events) {
      let event: Event;
      try {
        event = validateEvent(jsonClean(raw));
      } catch (err) {
        outcome.rejected.push({ event: raw, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const have = held.get(event.eid) ?? staged.get(event.eid);
      if (have !== undefined) {
        if (sameJson(have, event)) {
          outcome.duplicates += 1;
        } else {
          outcome.conflicts.push({ eid: event.eid, kept: have, other: event });
          if (event.author === this.ctx.self) {
            forked.push(event);
          }
        }
        continue;
      }
      if (event.author === this.ctx.self) {
        forked.push(event);
        continue;
      }
      staged.set(event.eid, event);
    }
    if (forked.length > 0) {
      throw new ForkedSelf(this.ctx.self, forked);
    }
    return this.ctx.serial.run(async () => {
      this.ctx.alive();
      // Another ingest, or an append, may have written while the input was being read: what is
      // here now is what the staged events are checked against, over every author — an eid
      // arriving twice, under two authors, from two calls, must end up in the store once.
      const current = this.ctx.generation === generation ? held : await this.readAll();
      const byAuthor = new Map<string, Event[]>();
      for (const event of staged.values()) {
        const list = byAuthor.get(event.author);
        if (list === undefined) {
          byAuthor.set(event.author, [event]);
        } else {
          list.push(event);
        }
      }
      for (const [author, incoming] of [...byAuthor].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const lines: Uint8Array[] = [];
        for (const event of incoming) {
          const have = current.get(event.eid);
          if (have === undefined) {
            current.set(event.eid, event);
            lines.push(jsonLine(deepFreeze(event)));
            outcome.added += 1;
          } else if (sameJson(have, event)) {
            outcome.duplicates += 1;
          } else {
            outcome.conflicts.push({ eid: event.eid, kept: have, other: event });
          }
        }
        if (lines.length > 0) {
          // one segment per author per call (§9.3), written whole
          await this.ctx.backend.write(this.newSegmentPath(author), concat(lines));
          this.ctx.generation += 1;
        }
      }
      return outcome;
    });
  }

  // ---- changes -----------------------------------------------------------

  async changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }> {
    this.ctx.guard();
    // The frontier first (§9.4): every segment's length, before any line is read.
    const table = new Map<string, number>();
    for (const dev of await this.devices()) {
      for (const path of await this.segmentsOf(dev)) {
        const size = await this.ctx.backend.size(path);
        if (size !== null) {
          table.set(path, size);
        }
      }
    }
    const from = since === undefined ? {} : this.place(since, table);
    const frontier: Frontier = { instance: this.ctx.instance, store: this.ctx.store, segments: Object.fromEntries([...table].sort()) };
    return { token: JSON.stringify(frontier), events: this.between(from, table, filter) };
  }

  /** The lengths `since` names, or a throw: another instance's or store's, or a segment now shorter or absent. */
  private place(since: ChangeToken, table: Map<string, number>): Record<string, number> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(since);
    } catch {
      throw new BadToken("not a token of this store");
    }
    const token = parsed as Partial<Frontier> | null;
    if (typeof token !== "object" || token === null || token.instance !== this.ctx.instance || token.store !== this.ctx.store) {
      throw new BadToken("not a token of this store instance");
    }
    if (typeof token.segments !== "object" || token.segments === null) {
      throw new BadToken("not a token of this store");
    }
    for (const [path, length] of Object.entries(token.segments)) {
      const now = table.get(path);
      if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || now === undefined || now < length) {
        throw new BadToken(`token names a position this store does not hold: ${path}`);
      }
    }
    return token.segments;
  }

  /** The whole lines of every segment between the two lengths, decoded; each eid once; in walk order. */
  private async *between(from: Record<string, number>, to: Map<string, number>, filter?: Filter): AsyncIterable<Event> {
    const seen = new Set<string>();
    for (const [path, end] of to) {
      const start = from[path] ?? 0;
      if (start >= end) {
        continue;
      }
      const bytes = await this.ctx.backend.read(path);
      if (bytes === null) {
        continue;
      }
      const dev = path.split("/").at(-2) as string;
      const { events } = decodeSegment(bytes.subarray(start, Math.min(end, bytes.length)), path, (line) => decodeEvent(line, dev));
      for (const event of events) {
        if (!seen.has(event.eid) && matches(event, filter)) {
          seen.add(event.eid);
          yield event;
        }
      }
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
