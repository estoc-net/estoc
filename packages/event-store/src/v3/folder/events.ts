/**
 * The version-3 event store over a folder: the reference backend, and
 * the readable interchange format every other backend renders. One
 * directory per author under `events/`, segments of JSONL in it, each
 * complete line exactly one event's RFC 8785 canonical bytes and an LF.
 * This store writes only under its own replica's directory — appends to
 * its newest segment when that ends in LF, starts a fresh one when a
 * crash or a failed write left a fragment there, so nothing is ever
 * appended after a fragment, a batch as a fresh segment written whole —
 * and, for `ingest`, one fresh segment per incoming author, of decoded
 * and reserialized events, never a copied source segment. Reads walk
 * every segment, take nothing from physical order, confirm each line's
 * author against its directory, deduplicate by `eventId` with the first
 * by path order then line offset kept and every other content reported,
 * and report what was not an event, an unknown entry inside `events/`
 * included. A change token names the store generation and the accepted
 * length of every segment.
 *
 * Durability is the backend's: a resolved append or batch is
 * process-durable with every backend shipped; power-loss survival is a
 * matter of the backend's flush policy, which none of them documents as
 * stronger than the platform's.
 */

import { v7 } from "uuid";

import type { VaultBackend } from "../../backend/types.js";
import { BadToken, DamagedLayout, ForkedAuthor } from "../errors.js";
import {
  compareEvents,
  isAuthorId,
  matches,
  validateDraft,
  validateEvent,
  type AuthorId,
  type ChangeToken,
  type Conflict,
  type Damaged,
  type Draft,
  type Event,
  type EventId,
  type EventStore,
  type Filter,
  type Ingested,
} from "../event.js";
import { comparePaths } from "../files.js";
import { canonicalText, parseStrict } from "../jcs.js";
import { deepFreeze, type JsonObject } from "../json.js";
import { mint } from "../mint.js";
import { ESTOC_DIR, EVENTS_DIR, authorDir, isSegmentName, kindOf, segmentPath } from "./layout.js";
import { decodeSegment, encodeLines, endsClean, type Decoded, type SegmentRead } from "./lines.js";
import type { Replica } from "./replica.js";

/** The writer's own rotation: a fresh segment once the open one is this long. */
export const ROTATE_BYTES = 4 * 1024 * 1024;

export interface FolderEventStoreOptions {
  /** the layout's directory, relative to the backend's root; `.estoc` when left out */
  base?: string;
  /** the wall clock in Unix milliseconds; default `Date.now`, pinned by tests */
  now?: () => number;
  /** rotate the append segment once it is this long; default `ROTATE_BYTES` */
  rotateBytes?: number;
}

/** One segment as a read found it: its path relative to the layout, its author directory, its bytes, and what they decoded to. */
interface Segment {
  rel: string;
  author: AuthorId;
  bytes: Uint8Array;
  read: SegmentRead;
}

/** What one read of `events/` found: the segments in path order, the accepted event per ID, and what was not one. */
interface Read {
  segments: Segment[];
  held: Map<EventId, Decoded>;
  damaged: Damaged[];
  conflicts: Conflict[];
}

/** What a token names: the generation, and the accepted length of every segment visible at the frontier. */
interface Frontier {
  generation: string;
  segments: Record<string, number>;
}

/** What a file where `events/` belongs is reported as, by a read and by the write it refuses. */
const EVENTS_IS_A_FILE = "a file where the events directory belongs";

/** What one `ingest` read before taking the lock: each input either as an accepted event would be held, or rejected. */
type Input = { held: Decoded } | { rejected: { value: unknown; error: string } };

export class FolderEventStore implements EventStore {
  readonly author: AuthorId;
  /** the store generation its tokens name: `local/replica.json`'s */
  readonly generation: string;
  private readonly base: string;
  private readonly now: () => number;
  private readonly rotateBytes: number;
  /** the segment this instance appends to, once it has one */
  private open: { rel: string; bytes: number } | null = null;
  /** operations run one at a time: the vault's writer lock, as far as one store needs it */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: VaultBackend,
    replica: Replica,
    options: FolderEventStoreOptions = {}
  ) {
    this.author = replica.replica_id;
    this.generation = replica.store_generation;
    this.base = options.base ?? ESTOC_DIR;
    this.now = options.now ?? Date.now;
    this.rotateBytes = options.rotateBytes ?? ROTATE_BYTES;
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A layout path as the backend names it. */
  private at(rel: string): string {
    return `${this.base}/${rel}`;
  }

  // ---- reading -----------------------------------------------------------

  /**
   * The segments under `events/`, in path order; and every entry that is
   * not one — a file where `events/` itself belongs, a file beside the
   * author directories, a directory that is not an author's, a name in an
   * author directory that is not a segment's, a directory where a segment
   * belongs — as damage. An absent `events/` is an empty store; a file
   * there is not.
   */
  private async walk(): Promise<{ segments: { rel: string; author: AuthorId }[]; damaged: Damaged[] }> {
    const damaged: Damaged[] = [];
    const segments: { rel: string; author: AuthorId }[] = [];
    const events = this.at(EVENTS_DIR);
    // The root itself first: a backend answers `list`
    // and `dirs` with [] for a file as for nothing there, so a file where
    // `events/` belongs would read as an empty store.
    if (await this.rootIsAFile()) {
      damaged.push({ where: EVENTS_DIR, error: EVENTS_IS_A_FILE });
      return { segments, damaged };
    }
    for (const name of await this.backend.list(events)) {
      damaged.push({ where: `${EVENTS_DIR}/${name}`, error: "a file where an author directory belongs" });
    }
    for (const name of await this.backend.dirs(events)) {
      const dir = `${EVENTS_DIR}/${name}`;
      if (!isAuthorId(name)) {
        damaged.push({ where: dir, error: "not an author directory: the name is not a canonical UUIDv7" });
        continue;
      }
      for (const sub of await this.backend.dirs(this.at(dir))) {
        damaged.push({ where: `${dir}/${sub}`, error: "a directory where a segment belongs" });
      }
      for (const file of await this.backend.list(this.at(dir))) {
        const rel = `${dir}/${file}`;
        if (isSegmentName(file)) segments.push({ rel, author: name });
        else damaged.push({ where: rel, error: "not a segment: the name is not <uuidv7>.jsonl" });
      }
    }
    segments.sort((a, b) => comparePaths(a.rel, b.rel));
    damaged.sort((a, b) => comparePaths(a.where, b.where));
    return { segments, damaged };
  }

  /** Whether a file stands where `events/` belongs: asked as a file, it has a size, and a directory or nothing there has none. */
  private async rootIsAFile(): Promise<boolean> {
    return (await this.backend.size(this.at(EVENTS_DIR))) !== null;
  }

  /**
   * Before the first byte of a write: a file where `events/`
   * belongs is not a place to write a segment. A backend over a flat map
   * would take the write, and every read would then skip what it wrote;
   * one over a file system would fail in its own words. Either way the
   * write must not be acknowledged, so it is refused here, by position,
   * before anything lands — the same damage a read reports.
   */
  private async checkRoot(): Promise<void> {
    if (await this.rootIsAFile()) throw new DamagedLayout(EVENTS_DIR, EVENTS_IS_A_FILE);
  }

  /**
   * Every segment read: each line decoded under its directory's author,
   * the accepted event per `eventId` — the first by path order, then line
   * offset — and every other content under an ID already held reported as
   * a conflict naming where it was found. Nothing is taken from segment
   * name or position.
   */
  private async readAll(): Promise<Read> {
    const walked = await this.walk();
    const read: Read = { segments: [], held: new Map(), damaged: walked.damaged, conflicts: [] };
    for (const { rel, author } of walked.segments) {
      const bytes = await this.backend.read(this.at(rel));
      if (bytes === null) continue; // gone between the listing and the read: not this store's writing
      const decoded = decodeSegment(bytes, rel, author);
      read.segments.push({ rel, author, bytes, read: decoded });
      read.damaged.push(...decoded.damaged);
      for (const found of decoded.events) {
        const have = read.held.get(found.event.eventId);
        if (have === undefined) {
          read.held.set(found.event.eventId, { event: deepFreeze(found.event), text: found.text });
        } else if (have.text !== found.text) {
          read.conflicts.push({ eventId: found.event.eventId, kept: have.event, rejected: deepFreeze(found.event), source: `${rel}:${found.n}` });
        }
      }
    }
    return read;
  }

  async *scan(filter?: Filter): AsyncIterable<Event> {
    // Read in the store's turn — the whole of `events/`, whatever the
    // filter: which content an ID is accepted under is
    // decided over every segment and only then filtered, so a
    // filter never exposes a content `scan()` rejects. Sorted here,
    // over what the read found: a write during
    // the walk is not yielded.
    const read = await this.serialise(() => this.readAll());
    const events = [...read.held.values()].map((held) => held.event).sort(compareEvents);
    for (const event of events) {
      if (matches(event, filter)) yield event;
    }
  }

  /** What a read of the whole of `events/` finds that is not an event, each with where it stands. */
  async damaged(): Promise<Damaged[]> {
    return (await this.serialise(() => this.readAll())).damaged;
  }

  /** Every content under an already-held `eventId`, each with the segment and line it stands in. */
  async conflicting(): Promise<Conflict[]> {
    return (await this.serialise(() => this.readAll())).conflicts;
  }

  // ---- writing -----------------------------------------------------------

  async append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>> {
    const clean = validateDraft(draft); // checked before the store's turn; the backend never sees `eventId`, `at` or `author` from the draft
    return this.serialise(async () => {
      await this.checkRoot();
      const { at, eventIds } = mint(1, this.now);
      const held = canonical({ eventId: eventIds[0], at, author: this.author, type: clean.type, roots: clean.roots, data: clean.data });
      const open = await this.openSegment();
      const line = encodeLines([held.event]);
      try {
        await this.backend.append(this.at(open.rel), line);
      } catch (err) {
        // The backend may have written part of the line. The segment
        // is no longer one to append to: forget it, so the next append reads
        // the tail afresh and, finding it unterminated, leaves it behind.
        this.open = null;
        throw err;
      }
      open.bytes += line.length;
      return deepFreeze(held.event) as Event<D>;
    });
  }

  async appendAll<D extends JsonObject>(drafts: Draft<D>[]): Promise<Event<D>[]> {
    const clean = drafts.map((draft) => validateDraft(draft)); // every draft checked before anything lands
    if (clean.length === 0) return [];
    return this.serialise(async () => {
      await this.checkRoot();
      // One clock reading and one `at` for the batch.
      const { at, eventIds } = mint(clean.length, this.now);
      const held = clean.map((draft, i) =>
        canonical({ eventId: eventIds[i], at, author: this.author, type: draft.type, roots: draft.roots, data: draft.data })
      );
      // A fresh segment, written whole: the backend's `write` is a
      // whole-file replacement, atomic across a process crash, so a
      // restart sees the complete batch or none of it — an append could
      // tear between lines. On success it is the newest segment under this
      // author, so it is the open one from here on; on failure `open` stands.
      const rel = this.freshSegment(this.author);
      const bytes = encodeLines(held.map((h) => h.event));
      await this.backend.write(this.at(rel), bytes);
      this.open = { rel, bytes: bytes.length };
      return held.map((h) => deepFreeze(h.event)) as Event<D>[];
    });
  }

  /**
   * The segment this instance appends to: the newest under its own author
   * directory when it ends in LF; a fresh one when there is none, when the
   * newest ends mid-line — a crash or a failed write left a fragment
   * there, and nothing is ever appended after a fragment, so it can never
   * fuse with the next event and stays what it is, reportable damage,
   * whatever its bytes happen to spell — and a fresh one once the open one
   * is long enough.
   */
  private async openSegment(): Promise<{ rel: string; bytes: number }> {
    if (this.open === null) {
      const dir = authorDir(this.author);
      const newest = (await this.backend.list(this.at(dir))).filter(isSegmentName).sort(comparePaths).at(-1);
      const bytes = newest === undefined ? null : await this.backend.read(this.at(`${dir}/${newest}`));
      this.open = bytes === null || !endsClean(bytes) ? { rel: this.freshSegment(this.author), bytes: 0 } : { rel: `${dir}/${newest}`, bytes: bytes.length };
    }
    if (this.open.bytes >= this.rotateBytes) this.open = { rel: this.freshSegment(this.author), bytes: 0 };
    return this.open;
  }

  /** A segment path this store has never used, under `author`: a fresh UUIDv7 name. */
  private freshSegment(author: AuthorId): string {
    return segmentPath(author, v7());
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    // The whole input first, fixed to canonical form as each
    // arrives and touching nothing of the folder. Then, in the store's
    // turn: what the folder holds against what came — duplicate, conflict,
    // new — the fork preflight, and only then the writes, one fresh segment
    // per incoming author. A failure before the writes writes nothing.
    const input: Input[] = [];
    for await (const value of events) {
      try {
        input.push({ held: canonical(value) });
      } catch (err) {
        input.push({ rejected: { value, error: err instanceof Error ? err.message : String(err) } });
      }
    }
    return this.serialise(async () => {
      const outcome: Ingested = { added: 0, duplicates: 0, conflicts: [], rejected: [] };
      const { held } = await this.readAll();
      const staged = new Map<EventId, Decoded>();
      const forked: Event[] = [];
      const byAuthor = new Map<AuthorId, Event[]>();
      for (const item of input) {
        if ("rejected" in item) {
          outcome.rejected.push(item.rejected);
          continue;
        }
        const incoming = item.held;
        const id = incoming.event.eventId;
        const have = held.get(id) ?? staged.get(id);
        if (have !== undefined) {
          if (have.text === incoming.text) {
            outcome.duplicates += 1;
          } else {
            outcome.conflicts.push({ eventId: id, kept: have.event, rejected: incoming.event });
            if (incoming.event.author === this.author) forked.push(incoming.event);
          }
          continue;
        }
        if (incoming.event.author === this.author) {
          forked.push(incoming.event);
          continue;
        }
        staged.set(id, incoming);
        const list = byAuthor.get(incoming.event.author);
        if (list === undefined) byAuthor.set(incoming.event.author, [incoming.event]);
        else list.push(incoming.event);
      }
      if (forked.length > 0) throw new ForkedAuthor(this.author, forked);
      if (byAuthor.size > 0) await this.checkRoot(); // only a write is refused: an input of duplicates alone adds nothing and needs no root
      for (const [author, added] of [...byAuthor].sort(([a], [b]) => comparePaths(a, b))) {
        await this.backend.write(this.at(this.freshSegment(author)), encodeLines(added));
        outcome.added += added.length;
      }
      return outcome;
    });
  }

  // ---- changes -----------------------------------------------------------

  async changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }> {
    return this.serialise(async () => {
      // One read gives both the frontier — every segment's accepted
      // length — and the events; the token is issued for what was read.
      const read = await this.readAll();
      const from = since === undefined ? new Map<string, number>() : this.place(since, read);
      // What the store gained after `since`: every accepted event whose ID
      // stands in no line at or before the position `since` recorded for
      // its segment. A line appended later under an ID already held — a
      // hand-copied duplicate — is not a gain; and what is yielded is what
      // the store holds under the ID, whichever line that is.
      const before = new Set<EventId>();
      for (const segment of read.segments) {
        const start = from.get(segment.rel) ?? 0;
        for (const found of segment.read.events) {
          if (found.end <= start) before.add(found.event.eventId);
        }
      }
      const events = [...read.held.values()]
        .map((held) => held.event)
        .filter((event) => !before.has(event.eventId) && matches(event, filter))
        .sort(compareEvents);
      const frontier: Frontier = {
        generation: this.generation,
        segments: Object.fromEntries(read.segments.map((segment) => [segment.rel, segment.read.accepted])),
      };
      return { token: JSON.stringify(frontier), events: iterate(events) };
    });
  }

  /**
   * The positions `since` names, or a throw: another generation's, a
   * shape not recognized, a named segment now missing or shorter than the
   * position, or a position that is not the end of a complete line.
   */
  private place(since: ChangeToken, read: Read): Map<string, number> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(since);
    } catch {
      throw new BadToken("not a token of this store");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BadToken("not a token of this store");
    const token = parsed as Partial<Frontier>;
    if (token.generation !== this.generation) throw new BadToken("not a token of this store generation");
    if (typeof token.segments !== "object" || token.segments === null || Array.isArray(token.segments)) throw new BadToken("not a token of this store");
    const have = new Map(read.segments.map((segment) => [segment.rel, segment]));
    const from = new Map<string, number>();
    for (const [rel, position] of Object.entries(token.segments)) {
      if (kindOf(rel) !== "segment") throw new BadToken(`not a token of this store: ${rel} is not a segment path`);
      const segment = have.get(rel);
      if (segment === undefined) throw new BadToken(`token names a segment this store does not hold: ${rel}`);
      if (typeof position !== "number" || !Number.isInteger(position) || position < 0) throw new BadToken(`not a token of this store: ${rel}`);
      if (position > segment.read.accepted) throw new BadToken(`token names a position past ${rel}'s accepted length`);
      if (position !== 0 && segment.bytes[position - 1] !== 0x0a) throw new BadToken(`token names a position inside a line of ${rel}`);
      from.set(rel, position);
    }
    return from;
  }
}

/**
 * A value as the folder holds it: validated, then the form its
 * canonical bytes parse to, with that text — the same helper the store
 * in memory uses, so a local append reads back as its ingest elsewhere
 * would. Throws `InvalidEvent` or `InvalidJson`.
 */
function canonical(value: unknown): Decoded {
  const text = canonicalText(validateEvent(value));
  return { event: parseStrict(text) as Event, text };
}

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
