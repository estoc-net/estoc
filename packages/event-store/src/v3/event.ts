/**
 * The version-3 event (event-store.md §3), its identity, time and order
 * (§4), and the store interface (§5). The model with no store behind
 * it: what a folder, a database and a map in memory must all agree on.
 * No event type is known here; what an event means is `@estoc/vault`'s.
 */

import { RAW_CODE, codecOf } from "@estoc/dasl";
import { InvalidEvent, InvalidJson } from "./errors.js";
import { canonicalText, canonicalize } from "./jcs.js";
import { isJsonObject, isJsonPrimitive, type JsonObject, type JsonPrimitive } from "./json.js";

/** A validated canonical raw DASL CID string (dasl-objects.md §3, §6): the brand says it was checked. */
export type Cid = string & { readonly __cid: unique symbol };
/** A canonical lowercase UUIDv7 naming one event (§3). */
export type EventId = string & { readonly __eventId: unique symbol };
/** A canonical lowercase UUIDv7 naming one writable local replica (§4.1). */
export type AuthorId = string & { readonly __authorId: unique symbol };

export type Event<D extends JsonObject = JsonObject> = {
  /** minted by the appending store with `at`; the deduplication key */
  eventId: EventId;
  /** RFC 3339 UTC, exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, from the same clock reading as `eventId` */
  at: string;
  /** the local replica that appended it (§4.1) */
  author: AuthorId;
  /** non-empty; `vault-events.md` names the vault's own */
  type: string;
  /** every object root the event retains, `[]` for none (§3.2); checked, never read, here */
  roots: Cid[];
  /** the payload, opaque here; `{}` when empty */
  data: D;
};

/** What a caller hands to `append`: the store mints `eventId` and `at` and sets `author`; `roots` left out is `[]`. */
export type Draft<D extends JsonObject = JsonObject> = { type: string; roots?: Cid[]; data: D };

/**
 * Equality only (§5.4): on the envelope fields named, and on the
 * top-level fields of `data` named under `data`. `null` matches a field
 * present and null; `undefined` is no constraint.
 */
export type Filter = { author?: AuthorId; type?: string; data?: { [field: string]: JsonPrimitive | undefined } };

/**
 * A local frontier of one store generation (§5.5): opaque, meaningful
 * only to the generation and event set that issued it; never sent
 * anywhere.
 */
export type ChangeToken = string;

/** Two contents under one `eventId` (§5.6): the store keeps `kept`, reports `rejected`. */
export interface Conflict {
  eventId: EventId;
  kept: Event;
  rejected: Event;
  /** where `rejected` came from, in the store's own terms */
  source?: string;
}

/** A value `ingest` could not accept as an event (§3.4). */
export interface Rejected {
  value: unknown;
  error: string;
  source?: string;
}

/** Storage material that could not be decoded as an event (§5.6). */
export interface Damaged {
  /** where, in the store's own terms, e.g. `<segment path>:<line number>` */
  where: string;
  bytes?: Uint8Array;
  error: string;
}

export interface Ingested {
  added: number;
  /** same `eventId`, same canonical bytes: nothing added */
  duplicates: number;
  /** same `eventId`, different canonical bytes: the store keeps what it had */
  conflicts: Conflict[];
  /** failed envelope validation: never stored */
  rejected: Rejected[];
}

/**
 * The backend interface (§5). `append`, `appendAll` and `ingest` are
 * internal to `Vault.commit` and validated import/restore; application
 * code sees only the read half through `Vault.events` (§10).
 */
export interface EventStore {
  /** Author assigned to every locally appended event. */
  readonly author: AuthorId;
  /** One local event: validates the draft, samples the clock once, mints `eventId` and `at`, writes and returns it (§5.1). */
  append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>>;
  /**
   * Several local events as one all-or-nothing write (§5.2): every draft
   * validated first, one clock sample and one `at` for the batch, IDs
   * in input order, which is the batch's canonical order.
   */
  appendAll<D extends JsonObject>(drafts: Draft<D>[]): Promise<Event<D>[]>;
  /**
   * Events from elsewhere (§5.3): union by `eventId`. Reads its whole
   * input before committing anything; throws `ForkedAuthor`, having
   * added nothing, on an event of this author it does not already hold.
   */
  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested>;
  /** Every accepted event matching `filter`, in canonical order (§5.4). */
  scan(filter?: Filter): AsyncIterable<Event>;
  /** What this store gained after `since` and no later than `token`; each event once, in no promised order (§5.5). */
  changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }>;
  /** Storage material that could not be read as an event; for the caller to surface. */
  damaged(): Promise<Damaged[]>;
  /** IDs met with more than one content; for the caller to surface. */
  conflicting(): Promise<Conflict[]>;
}

// ---- identity -----------------------------------------------------------

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A canonical lowercase UUIDv7: RFC 9562 version 7, variant 10. */
export function isUuidv7(value: unknown): value is string {
  return typeof value === "string" && UUIDV7.test(value);
}

export function isEventId(value: unknown): value is EventId {
  return isUuidv7(value);
}

export function isAuthorId(value: unknown): value is AuthorId {
  return isUuidv7(value);
}

/** A canonical raw DASL CID string — what `roots` may hold (dasl-objects.md §3). */
export function isRawCid(value: unknown): value is Cid {
  return typeof value === "string" && codecOf(value) === RAW_CODE;
}

/** The integer Unix millisecond a UUIDv7 embeds (its first 48 bits). */
export function timestampOf(id: string): number {
  if (!isUuidv7(id)) throw new InvalidEvent(`${JSON.stringify(id)} is not a canonical UUIDv7`);
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

// ---- time ---------------------------------------------------------------

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The last millisecond `atOf` can spell: `9999-12-31T23:59:59.999Z`. */
export const MAX_T = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/**
 * Exactly `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real Gregorian UTC instant
 * (§3.4): three fractional digits, seconds `00`–`59`, a day that exists
 * in its month. One instant has one spelling, so lexical order of
 * accepted values is millisecond order (§4.3).
 */
export function isCanonicalAt(value: unknown): value is string {
  if (typeof value !== "string" || !AT.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}

/** The canonical `at` of the integer Unix millisecond `t` (§4.2). */
export function atOf(t: number): string {
  if (!Number.isInteger(t) || t < 0 || t > MAX_T) {
    throw new RangeError(`${String(t)} is not an integer millisecond between 1970 and 9999`);
  }
  return new Date(t).toISOString();
}

// ---- the envelope -------------------------------------------------------

const FIELDS = ["eventId", "at", "author", "type", "roots", "data"] as const;

/**
 * Envelope validation (§3.4): the eight rules, in order, and JCS
 * eligibility of the whole. Returns the same value, typed; throws
 * `InvalidEvent` naming the first rule broken. Validates no payload
 * field — `data` is opaque here.
 */
export function validateEvent(value: unknown): Event {
  if (!isJsonObject(value)) throw new InvalidEvent("an event is a JSON object");
  const keys = Object.keys(value);
  for (const field of FIELDS) {
    if (!Object.hasOwn(value, field)) throw new InvalidEvent(`missing ${field}`);
  }
  if (keys.length !== FIELDS.length) {
    const extra = keys.filter((k) => !(FIELDS as readonly string[]).includes(k));
    throw new InvalidEvent(`unknown top-level field ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
  }
  const event = value as Record<(typeof FIELDS)[number], unknown>;
  if (!isEventId(event.eventId)) throw new InvalidEvent("eventId is not a canonical UUIDv7");
  if (!isCanonicalAt(event.at)) throw new InvalidEvent("at is not a canonical RFC 3339 UTC millisecond");
  if (!isAuthorId(event.author)) throw new InvalidEvent("author is not a canonical UUIDv7");
  checkType(event.type);
  checkRoots(event.roots);
  if (!isJsonObject(event.data)) throw new InvalidEvent("data is not a JSON object");
  checkJcs(value);
  return value as Event;
}

/**
 * A draft that can become an event (§5.1 step 1): a non-empty `type`,
 * `roots` of raw CIDs or left out, and the whole — `type`, `roots`,
 * `data` under one root object, nested exactly as the event will be —
 * JCS-eligible, so that a draft this accepts makes an event
 * `validateEvent` accepts once `eventId`, `at` and `author` are added.
 * Returns the draft normalized — `roots` always an array — as fresh
 * plain data the caller cannot reach.
 */
export function validateDraft(draft: unknown): Required<Draft> {
  if (!isJsonObject(draft)) throw new InvalidEvent("a draft is an object");
  const { type, roots, data } = draft as Record<string, unknown>;
  checkType(type);
  if (roots !== undefined) checkRoots(roots);
  if (!isJsonObject(data)) throw new InvalidEvent("data is not a JSON object");
  const normalized: Required<Draft> = { type, roots: roots === undefined ? [] : [...roots], data };
  checkJcs(normalized);
  return structuredClone(normalized);
}

function checkType(type: unknown): asserts type is string {
  if (typeof type !== "string" || type === "") throw new InvalidEvent("type is not a non-empty string");
}

function checkRoots(roots: unknown): asserts roots is Cid[] {
  if (!Array.isArray(roots)) throw new InvalidEvent("roots is not an array");
  for (const root of roots) {
    if (!isRawCid(root)) throw new InvalidEvent(`roots: ${JSON.stringify(root)} is not a canonical raw DASL CID`);
  }
}

function checkJcs(value: unknown): void {
  try {
    canonicalText(value);
  } catch (err) {
    if (err instanceof InvalidJson) throw new InvalidEvent(`not I-JSON: ${err.message}`);
    throw err;
  }
}

/** `UTF8(RFC8785(event))` (§3.3): the sole content-equality representation of an event. */
export function canonicalEventBytes(event: Event): Uint8Array {
  return canonicalize(event);
}

// ---- order and the filter -----------------------------------------------

/** Canonical order (§4.3): ascending by `(at, eventId, author)`, comparing the literal strings. */
export function compareEvents(a: Event, b: Event): number {
  return cmp(a.at, b.at) || cmp(a.eventId, b.eventId) || cmp(a.author, b.author);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Does `event` satisfy `filter` (§5.4)? No filter matches everything. */
export function matches(event: Event, filter?: Filter): boolean {
  if (filter === undefined) return true;
  if (filter.author !== undefined && event.author !== filter.author) return false;
  if (filter.type !== undefined && event.type !== filter.type) return false;
  return filter.data === undefined || matchesData(event.data, filter.data);
}

/**
 * Every field named with a value other than `undefined` is present in
 * `data` with the same canonical JSON value: the same primitive. A
 * field holding an object or array never matches a primitive.
 */
export function matchesData(data: JsonObject, wanted: { [field: string]: JsonPrimitive | undefined }): boolean {
  for (const [field, value] of Object.entries(wanted)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(data, field)) return false;
    const actual = data[field];
    if (!isJsonPrimitive(actual) || actual !== value) return false;
  }
  return true;
}
