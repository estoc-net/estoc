/**
 * The version-4 event, its identity, time and order, and the store
 * interface. The model with no store behind it: what a database and
 * a map in memory must both agree on. No event type is
 * known here; what an event means is `@estoc/vault`'s.
 */

import { RAW_CODE, codecOf } from "@estoc/dasl";
import { sha256 } from "@noble/hashes/sha2";

import { InvalidEvent, InvalidJson } from "./errors.js";
import { canonicalText, canonicalize, parseStrict, plainJson } from "./jcs.js";
import { isJsonObject, isJsonPrimitive, type JsonObject, type JsonPrimitive, type JsonValue } from "./json.js";
import { rawCidFromDigest } from "./objects.js";

/** A validated canonical raw DASL CID string: the brand says it was checked. */
export type Cid = string & { readonly __cid: unique symbol };
/** The raw DASL CID of one event's canonical envelope bytes: its identity, derived, never carried in the envelope. */
export type EventCid = string & { readonly __eventCid: unique symbol };
/** A canonical lowercase UUIDv7 naming one writable local replica. */
export type AuthorId = string & { readonly __authorId: unique symbol };

/** The five fields that are hashed: the portable event, exactly what its canonical bytes spell. */
export type EventEnvelope<D extends JsonObject = JsonObject> = {
  /** RFC 3339 UTC, exactly `YYYY-MM-DDTHH:mm:ss.sssZ`: the wall clock as the appending store read it */
  at: string;
  /** the local replica that appended it */
  author: AuthorId;
  /** non-empty; the vault's own types are the vault's to name */
  type: string;
  /** every object root the event retains, `[]` for none; checked, never read, here */
  roots: Cid[];
  /** the payload, opaque here; `{}` when empty */
  data: D;
};

/** The envelope as the API hands it out, with the CID its canonical bytes hash to: equal envelopes are one event. */
export type Event<D extends JsonObject = JsonObject> = EventEnvelope<D> & { cid: EventCid };

/** What a caller hands to `append`: the store samples `at`, sets `author` and derives `cid`; `roots` left out is `[]`. */
export type Draft<D extends JsonObject = JsonObject> = { type: string; roots?: Cid[]; data: D };

/**
 * Equality only: on the CID, on the envelope fields named, and on the
 * top-level fields of `data` named under `data`. `null` matches a field
 * present and null; `undefined` is no constraint. A `cid` names at most
 * one event and still conjoins with the rest.
 */
export type Filter = { cid?: EventCid; author?: AuthorId; type?: string; data?: { [field: string]: JsonPrimitive | undefined } };

/**
 * A local frontier of one store generation: opaque, meaningful only to
 * the generation and event set that issued it; never sent anywhere.
 */
export type ChangeToken = string;

/** A value `ingest` could not accept as an event. */
export interface Rejected {
  value: unknown;
  error: string;
  source?: string;
}

/** Storage material that could not be decoded as an event. */
export interface Damaged {
  /** where, in the store's own terms: a row, a position, a file and offset */
  where: string;
  bytes?: Uint8Array;
  error: string;
}

export interface Ingested {
  /** CIDs not held before: now accepted */
  added: number;
  /** CIDs already held, or repeated in this input: nothing added */
  duplicates: number;
  /** failed envelope or CID validation: never stored */
  rejected: Rejected[];
}

/**
 * The backend interface. `append`, `appendAll` and `ingest` are
 * internal to `Vault.commit` and validated import/restore; application
 * code sees only the read half through `Vault.events`.
 */
export interface EventStore {
  /** Author assigned to every locally appended event. */
  readonly author: AuthorId;
  /** One local event: validates the draft, reads the clock for `at`, derives the CID, retains it if new and returns it. */
  append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>>;
  /**
   * Several local events as one all-or-nothing write: every draft
   * validated first, one clock reading and one `at` for the batch,
   * equal envelopes — against what is held and against each other —
   * retained once, and one event returned per draft in input order;
   * canonical order need not match it.
   */
  appendAll<D extends JsonObject>(drafts: Draft<D>[]): Promise<Event<D>[]>;
  /**
   * Events from elsewhere: union by CID. Each input is validated with
   * its CID before it is classified. Reads its whole input before
   * committing anything; throws `ForkedAuthor`, having added nothing,
   * on an event of this author it does not already hold.
   */
  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested>;
  /** Every accepted event matching `filter`, in canonical order, with its stored CID. */
  scan(filter?: Filter): AsyncIterable<Event>;
  /** What this store gained after `since` and no later than `token`; each CID once, in no promised order. */
  changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }>;
  /** Storage material that could not be read as an event, or does not hash to the CID it is held under; for the caller to surface. */
  damaged(): Promise<Damaged[]>;
  /** How much the store holds — every row counted, its canonical bytes summed — from what it keeps beside the events, no event loaded. */
  tally(): Promise<EventTally>;
}

export interface EventTally {
  events: number;
  bytes: number;
}

// ---- identity -----------------------------------------------------------

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A canonical lowercase UUIDv7: RFC 9562 version 7, variant 10. */
export function isUuidv7(value: unknown): value is string {
  return typeof value === "string" && UUIDV7.test(value);
}

export function isAuthorId(value: unknown): value is AuthorId {
  return isUuidv7(value);
}

/** A canonical raw DASL CID string — what `roots` may hold. */
export function isRawCid(value: unknown): value is Cid {
  return typeof value === "string" && codecOf(value) === RAW_CODE;
}

/** Spelled like an event CID: a canonical raw DASL CID. Whether any event hashes to it is the store's question. */
export function isEventCid(value: unknown): value is EventCid {
  return isRawCid(value);
}

// ---- time ---------------------------------------------------------------

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The last millisecond `atOf` can spell: `9999-12-31T23:59:59.999Z`. */
export const MAX_T = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/**
 * Exactly `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real Gregorian UTC instant:
 * three fractional digits, seconds `00`–`59`, a day that exists in its
 * month. One instant has one spelling, so lexical order of accepted
 * values is millisecond order.
 */
export function isCanonicalAt(value: unknown): value is string {
  if (typeof value !== "string" || !AT.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}

/** The canonical `at` of the integer Unix millisecond `t`. */
export function atOf(t: number): string {
  if (!Number.isInteger(t) || t < 0 || t > MAX_T) {
    throw new RangeError(`${String(t)} is not an integer millisecond between 1970 and 9999`);
  }
  return new Date(t).toISOString();
}

/**
 * One reading of the wall clock for an append or a batch: `now` is
 * Unix milliseconds, fractional allowed, truncated to the integer;
 * default `Date.now`. Throws `RangeError` on a reading `atOf` cannot
 * spell. After a clock rollback the earlier time is what is sampled.
 */
export function sampleAt(now: () => number = Date.now): { t: number; at: string } {
  const t = Math.floor(now());
  return { t, at: atOf(t) };
}

// ---- the envelope -------------------------------------------------------

const ENVELOPE_FIELDS = ["at", "author", "type", "roots", "data"] as const;
const EVENT_FIELDS = [...ENVELOPE_FIELDS, "cid"] as const;

/**
 * Envelope validation: exactly the five fields, each checked, and JCS
 * eligibility of the whole. Each member of `value` is read once and
 * the envelope returned is the fresh plain data that was checked, so an
 * accessor on `value` cannot show one envelope here and another to
 * whoever serializes it. Throws `InvalidEvent` naming the first rule
 * broken. Validates no payload field — `data` is opaque here.
 */
export function validateEnvelope(value: unknown): EventEnvelope {
  if (!isJsonObject(value)) throw new InvalidEvent("an event envelope is a JSON object");
  exactly(value, ENVELOPE_FIELDS);
  return checkedEnvelope(value);
}

/**
 * An API event as a store accepts it: the five envelope fields and
 * `cid`, nothing else, the envelope validated and `cid` a canonical raw
 * CID equal to the one the envelope's canonical bytes hash to. A
 * well-formed CID for other bytes is refused before any duplicate
 * check. Returns fresh plain data.
 */
export function validateEvent(value: unknown): Event {
  if (!isJsonObject(value)) throw new InvalidEvent("an event is a JSON object");
  exactly(value, EVENT_FIELDS);
  const envelope = checkedEnvelope(value);
  const cid: unknown = value["cid"];
  if (!isEventCid(cid)) throw new InvalidEvent("cid is not a canonical raw DASL CID");
  const computed = eventCidOf(envelope);
  if (cid !== computed) throw new InvalidEvent(`cid ${cid} is not the envelope's, ${computed}`);
  return { ...envelope, cid };
}

function exactly(value: JsonObject, fields: readonly string[]): void {
  const keys = Object.keys(value);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new InvalidEvent(`missing ${field}`);
  }
  if (keys.length !== fields.length) {
    const extra = keys.filter((k) => !fields.includes(k));
    throw new InvalidEvent(`unknown top-level field ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
  }
}

function checkedEnvelope(value: JsonObject): EventEnvelope {
  const { at, author, type, roots, data } = value as Record<(typeof ENVELOPE_FIELDS)[number], unknown>;
  if (!isCanonicalAt(at)) throw new InvalidEvent("at is not a canonical RFC 3339 UTC millisecond");
  if (!isAuthorId(author)) throw new InvalidEvent("author is not a canonical UUIDv7");
  checkType(type);
  const checked = checkedRoots(roots);
  if (!isJsonObject(data)) throw new InvalidEvent("data is not a JSON object");
  return plain({ at, author, data, roots: checked, type }) as EventEnvelope;
}

/** What the store supplies: a draft that carries one is refused, never silently re-derived. */
const SUPPLIED = ["cid", "at", "author"] as const;

/**
 * A draft that can become an event: none of `cid`, `at` or `author`,
 * which the store supplies — an event handed back as a draft is
 * refused, not quietly made a second event — a non-empty `type`,
 * `roots` of raw CIDs or left out, `data` an object, and nothing
 * else. The whole — `type`, `roots`, `data` under one root object,
 * nested exactly as the envelope will be — is JCS-eligible, so that a
 * draft this accepts makes an envelope `validateEnvelope` accepts once
 * `at` and `author` are added. Returns the draft normalized — `roots`
 * always an array — as fresh plain data the caller cannot reach.
 */
export function validateDraft(draft: unknown): Required<Draft> {
  if (!isJsonObject(draft)) throw new InvalidEvent("a draft is an object");
  for (const supplied of SUPPLIED) {
    if (Object.hasOwn(draft, supplied)) throw new InvalidEvent(`a draft does not carry ${supplied}: the store supplies it`);
  }
  const extra = Object.keys(draft).filter((k) => k !== "type" && k !== "roots" && k !== "data");
  if (extra.length > 0) throw new InvalidEvent(`a draft has type, roots and data only, not ${extra.map((k) => JSON.stringify(k)).join(", ")}`);
  const { type, roots, data } = draft as Record<string, unknown>;
  checkType(type);
  const checked = roots === undefined ? [] : checkedRoots(roots);
  if (!isJsonObject(data)) throw new InvalidEvent("data is not a JSON object");
  return plain({ type, roots: checked, data }) as Required<Draft>;
}

function checkType(type: unknown): asserts type is string {
  if (typeof type !== "string" || type === "") throw new InvalidEvent("type is not a non-empty string");
}

/**
 * `roots` as an array of its own, each element read once and checked. Read by
 * index, as `plainJson` reads an array: what an array's iterator yields need not
 * be the elements it serializes as.
 */
function checkedRoots(roots: unknown): Cid[] {
  if (!Array.isArray(roots)) throw new InvalidEvent("roots is not an array");
  const length = roots.length;
  const checked: Cid[] = [];
  for (let i = 0; i < length; i++) {
    const root: unknown = roots[i];
    if (!isRawCid(root)) throw new InvalidEvent(`roots: ${JSON.stringify(root)} is not a canonical raw DASL CID`);
    checked.push(root);
  }
  return checked;
}

function plain(value: unknown): JsonValue {
  try {
    return plainJson(value);
  } catch (err) {
    if (err instanceof InvalidJson) throw new InvalidEvent(`not I-JSON: ${err.message}`);
    throw err;
  }
}

/** The five envelope fields of `event`, in canonical member order and nothing else: what is hashed and what persists. */
export function envelopeOf<D extends JsonObject>(event: EventEnvelope<D>): EventEnvelope<D> {
  return { at: event.at, author: event.author, data: event.data, roots: event.roots, type: event.type };
}

/** `UTF8(RFC8785(envelope))`: the sole content-equality representation of an event. A `cid` on the value given is left out. */
export function canonicalEventBytes(envelope: EventEnvelope): Uint8Array {
  return canonicalize(envelopeOf(envelope));
}

/** The raw DASL CID of `bytes`, which must be an envelope's canonical bytes for the result to be an event CID. */
export function eventCidOfBytes(bytes: Uint8Array): EventCid {
  return rawCidFromDigest(sha256(bytes)).text as EventCid;
}

/** The event CID of an envelope: `rawCid(canonicalEventBytes(envelope))`. */
export function eventCidOf(envelope: EventEnvelope): EventCid {
  return eventCidOfBytes(canonicalEventBytes(envelope));
}

/**
 * An envelope as an accepted event is held: validated, then the form
 * its canonical bytes parse to — member order, `-0` and all — as fresh
 * data of its own, with the CID those bytes hash to. What a local
 * append makes of a draft once `at` and `author` are set. Throws
 * `InvalidEvent` or `InvalidJson`.
 */
export function canonicalEnvelope(value: unknown): { event: Event; bytes: Uint8Array } {
  const bytes = canonicalEventBytes(validateEnvelope(value));
  return { event: withCid(bytes), bytes };
}

/**
 * A value as an accepted event is held: validated with its CID, then
 * the form its canonical bytes parse to. What a store fixes each input
 * of `ingest` to before it asks the source for the next, so a source
 * that reuses one working object between yields is read as it yielded.
 * Throws `InvalidEvent` or `InvalidJson`.
 */
export function canonicalEvent(value: unknown): { event: Event; bytes: Uint8Array } {
  const bytes = canonicalEventBytes(validateEvent(value));
  return { event: withCid(bytes), bytes };
}

/** The event `bytes` — an envelope's canonical bytes — spell, with the CID they hash to. */
function withCid(bytes: Uint8Array): Event {
  return { ...(parseStrict(bytes) as EventEnvelope), cid: eventCidOfBytes(bytes) };
}

/** The canonical text of an envelope: `canonicalEventBytes` as a string. */
export function canonicalEventText(envelope: EventEnvelope): string {
  return canonicalText(envelopeOf(envelope));
}

// ---- order and the filter -----------------------------------------------

/**
 * Canonical order: ascending by `(at, cid)`, comparing the literal
 * strings — the CID as its base32 text, whose order is not the order
 * of its decoded bytes.
 */
export function compareEvents(a: Event, b: Event): number {
  return cmp(a.at, b.at) || cmp(a.cid, b.cid);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `filter` with a `cid` that is not a canonical raw CID refused: `InvalidEvent`, before anything is read. */
export function checkFilter(filter: Filter | undefined): void {
  if (filter?.cid !== undefined && !isEventCid(filter.cid)) throw new InvalidEvent(`filter cid ${JSON.stringify(filter.cid)} is not a canonical raw DASL CID`);
}

/** Does `event` satisfy `filter`? No filter matches everything. */
export function matches(event: Event, filter?: Filter): boolean {
  if (filter === undefined) return true;
  if (filter.cid !== undefined && event.cid !== filter.cid) return false;
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
