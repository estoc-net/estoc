/**
 * The event (event-store.md §2), its identity, time and order (§3), and
 * the store interface (§4). The model, with no store behind it: what a
 * folder, a database or a map in memory must all agree on.
 */

import { v7 as uuidv7 } from "uuid";
import { isCid } from "./cid.js";
import { InvalidEvent } from "./errors.js";
import { isJsonObject, isJsonPrimitive, jsonClean, type JsonObject, type JsonPrimitive } from "./json.js";

/** A CIDv1, sha-256, codec raw or dag-pb, base32 lower (§5). */
export type Cid = string;

export type Event<D extends JsonObject = JsonObject> = {
  /** a bare uuidv7: minted at append, the dedup key */
  eid: string;
  /** RFC 3339 UTC */
  at: string;
  /** the authoring device (§3) */
  author: string;
  /** the event type, a non-empty string; `vault-events.md` names the vault's own */
  type: string;
  /** every root the event references, `[]` for none; checked, never read, here */
  blobs: Cid[];
  /** the payload; opaque here */
  data: D;
};

/** What a caller hands to `append`: no eid, at, or author — the store mints them; `blobs` left out is `[]`. */
export type Draft<D extends JsonObject = JsonObject> = { type: string; blobs?: Cid[]; data: D };

/**
 * Equality, by `===` on primitives: on the envelope fields named, and on
 * the top-level fields of `data` named under `data`. `null` matches a
 * field present and null; `undefined` is no constraint.
 */
export type Filter = { author?: string; type?: string; data?: { [field: string]: JsonPrimitive | undefined } };

/**
 * A frontier of one store instance: what it held when the token was
 * taken. Opaque; meaningful only to the instance that issued it. Not an
 * auth token: a checkpoint a caller keeps beside a fold.
 */
export type ChangeToken = string;

/** Two contents under one `eid`: the store keeps `kept`, reports `other`. */
export interface Conflict {
  eid: string;
  kept: Event;
  other: Event;
}

/** A value `ingest` could not read as an event (§2.4). */
export interface Rejected {
  event: unknown;
  error: string;
}

/** Bytes a serialization holds that could not be read as an event (§4.5). */
export interface DamagedLine {
  /** where in the store's own terms, e.g. `<segment path>:<line number>` */
  where: string;
  line: string;
  error: string;
}

export interface Ingested {
  added: number;
  /** same eid, same content: skipped */
  duplicates: number;
  /** same eid, different content: the store keeps what it had */
  conflicts: Conflict[];
  /** failed envelope validation (§2.4) */
  rejected: Rejected[];
}

export interface EventStore {
  /** Which device this store appends as (§3). */
  readonly self: string;
  /** This device's own event. The store mints eid and at, sets author = self, returns the whole event. */
  append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>>;
  /**
   * Several of this device's events as one write: every draft validated before anything
   * lands — one bad draft and nothing is written — then minted in input order at one
   * instant, one `at` for the batch and eids monotone within it. Across a crash of the
   * process the batch lands whole or not at all (§4.1).
   */
  appendAll<D extends JsonObject>(drafts: Draft<D>[]): Promise<Event<D>[]>;
  /**
   * Events from elsewhere (a backup, another store, another device). Union by eid.
   * Reads its whole input before writing; throws ForkedSelf, having written nothing,
   * on an event of `self` it does not already hold (§4.2).
   */
  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested>;
  /** Every event matching `filter`, in canonical order. */
  scan(filter?: Filter): AsyncIterable<Event>;
  /** What this store gained after `since` and at or before `token`; each event once, in no promised order. */
  changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }>;
  /** Bytes met in storage that could not be read as events; for the caller to surface. */
  damaged(): DamagedLine[];
  /** Eids met with more than one content; for the caller to surface. */
  conflicting(): Conflict[];
}

// ---- identity and time -------------------------------------------------

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEVICE_ID = /^[a-z2-7]{6}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
// RFC 3339 with the UTC designator `Z` and an optional fraction. `+00:00` is
// UTC too, but the store mints `Z` and accepts only what it would mint, so
// that one instant has one spelling as far as `at` can arrange.
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** A bare uuidv7, lowercase. */
export function isUuidv7(value: unknown): value is string {
  return typeof value === "string" && UUIDV7.test(value);
}

/** A device id: 6 characters of lowercase RFC 4648 base32 (§3). */
export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID.test(value);
}

/** RFC 3339 UTC, `Z`-terminated, naming a real instant. */
export function isRfc3339Utc(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const m = RFC3339_UTC.exec(value);
  if (m === null) {
    return false;
  }
  const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  // Date.UTC rolls an impossible date over (Feb 30 → Mar 2); a real one comes back as it went in.
  return (
    date.getUTCFullYear() === +y &&
    date.getUTCMonth() === +mo - 1 &&
    date.getUTCDate() === +d &&
    date.getUTCHours() === +h &&
    date.getUTCMinutes() === +mi &&
    date.getUTCSeconds() === +s
  );
}

/**
 * `at` in a form whose string order is time order: the fraction padded
 * to nine digits, so that `…:00Z` and `…:00.000Z` — one instant, two
 * spellings — sort together.
 */
export function atKey(at: string): string {
  const dot = at.indexOf(".");
  if (dot === -1) {
    return `${at.slice(0, -1)}.000000000Z`;
  }
  return `${at.slice(0, dot + 1)}${at.slice(dot + 1, -1).padEnd(9, "0")}Z`;
}

/** Canonical order (§3): by `at`, then `(eid, author)`. Total over distinct events. */
export function compareEvents(a: Pick<Event, "at" | "eid" | "author">, b: Pick<Event, "at" | "eid" | "author">): number {
  const ka = atKey(a.at);
  const kb = atKey(b.at);
  if (ka !== kb) {
    return ka < kb ? -1 : 1;
  }
  if (a.eid !== b.eid) {
    return a.eid < b.eid ? -1 : 1;
  }
  if (a.author !== b.author) {
    return a.author < b.author ? -1 : 1;
  }
  return 0;
}

/** A fresh device id: 30 random bits, base32 lower (§3). Not secret. */
export function mintDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let id = "";
  for (const byte of bytes) {
    id += BASE32[byte & 31];
  }
  return id;
}

/** A fresh instance id (§3): names this copy of a store to the tokens it issues. */
export function mintInstance(): string {
  return crypto.randomUUID();
}

/**
 * Mints one device's eids, monotone whatever the clock does: the same
 * millisecond, or an earlier one, continues the sequence instead of
 * starting a fresh random one (RFC 9562 §6.2, method 1), which is what
 * uuidv7 does on its own only when it reads the wall clock itself.
 */
export class EidMinter {
  private msecs = -Infinity;
  private seq = 0;

  /** A uuidv7 for the instant `now` (milliseconds since the epoch), later than every one minted before. */
  mint(now: number): string {
    const random = crypto.getRandomValues(new Uint8Array(16));
    if (now > this.msecs) {
      this.msecs = now;
      this.seq =
        ((random[6] as number) << 23) |
        ((random[7] as number) << 16) |
        ((random[8] as number) << 8) |
        (random[9] as number);
    } else {
      this.seq = (this.seq + 1) | 0;
      if (this.seq === 0) {
        this.msecs += 1;
      }
    }
    return uuidv7({ msecs: this.msecs, seq: this.seq, random });
  }
}

// ---- validation --------------------------------------------------------

const ENVELOPE = ["eid", "at", "author", "type", "blobs", "data"] as const;

/**
 * The event `value` is, or a throw (§2.4): a JSON object of exactly the
 * six fields, each well formed; `data` a JSON object, opaque beyond that.
 * Does not copy: the caller cleans (`jsonClean`) before storing.
 */
export function validateEvent(value: unknown): Event {
  if (!isJsonObject(value)) {
    throw new InvalidEvent("an event is a JSON object");
  }
  for (const field of Object.keys(value)) {
    if (!(ENVELOPE as readonly string[]).includes(field)) {
      throw new InvalidEvent(`unknown envelope field ${JSON.stringify(field)}`);
    }
  }
  const { eid, at, author, type, blobs, data } = value;
  if (!isUuidv7(eid)) {
    throw new InvalidEvent("eid is not a uuidv7");
  }
  if (!isRfc3339Utc(at)) {
    throw new InvalidEvent("at is not RFC 3339 UTC");
  }
  if (!isDeviceId(author)) {
    throw new InvalidEvent("author is not a device id");
  }
  checkType(type);
  checkBlobs(blobs);
  if (!isJsonObject(data)) {
    throw new InvalidEvent("data is not a JSON object");
  }
  return value as Event;
}

function checkType(type: unknown): asserts type is string {
  if (typeof type !== "string" || type === "") {
    throw new InvalidEvent("type is not a non-empty string");
  }
}

function checkBlobs(blobs: unknown): asserts blobs is Cid[] {
  if (!Array.isArray(blobs)) {
    throw new InvalidEvent("blobs is not an array");
  }
  for (const root of blobs) {
    if (!isCid(root)) {
      throw new InvalidEvent(`blobs holds ${JSON.stringify(root)}, which is not a profile CID`);
    }
  }
}

/**
 * The draft's own three fields, checked and copied as JSON: what `append`
 * does before minting the rest. Throws `InvalidEvent`.
 */
export function cleanDraft<D extends JsonObject>(draft: Draft<D>): { type: string; blobs: Cid[]; data: D } {
  if (!isJsonObject(draft)) {
    throw new InvalidEvent("a draft is an object");
  }
  const { type, blobs, data } = draft as { type: unknown; blobs?: unknown; data: unknown };
  checkType(type);
  if (blobs !== undefined) {
    checkBlobs(blobs);
  }
  if (!isJsonObject(data)) {
    throw new InvalidEvent("data is not a JSON object");
  }
  let clean: D;
  try {
    clean = jsonClean<D>(data);
  } catch (err) {
    throw new InvalidEvent(`data is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { type, blobs: blobs === undefined ? [] : [...blobs], data: clean };
}

// ---- filter ------------------------------------------------------------

/** Whether `event` matches `filter` (§4.3): equality on the fields named, `undefined` no constraint. */
export function matches(event: Event, filter?: Filter): boolean {
  if (filter === undefined) {
    return true;
  }
  if (filter.author !== undefined && event.author !== filter.author) {
    return false;
  }
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  return matchesData(event.data, filter.data);
}

/** The `data` half of a filter, shared with the local store's (§7.2). */
export function matchesData(data: JsonObject, wanted?: { [field: string]: JsonPrimitive | undefined }): boolean {
  if (wanted === undefined) {
    return true;
  }
  for (const [field, value] of Object.entries(wanted)) {
    if (value === undefined) {
      continue;
    }
    if (!Object.hasOwn(data, field)) {
      return false;
    }
    const actual = data[field];
    if (!isJsonPrimitive(actual) || actual !== value) {
      return false;
    }
  }
  return true;
}
