/**
 * `@estoc/event-store/v3` — the version-3 event model of
 * `docs/replica-model/event-store.md`, built beside version 2 until the
 * vault switches over: RFC 8785 canonical JSON and the strict parser
 * (§3.3), the six-field envelope and its validation (§3.4), identity,
 * time and canonical order (§4), the store interface (§5), and minting
 * — `at` from the clock, `eventId` from `uuid`'s standard UUIDv7
 * generator (§4.2). No store yet, and no event type.
 */

export type { JsonPrimitive, JsonValue, JsonObject } from "./json.js";
export { isJsonObject, isJsonPrimitive } from "./json.js";

export { canonicalize, canonicalText, parseStrict, forbiddenIn, compareCodeUnits, MAX_DEPTH } from "./jcs.js";

export type {
  Cid,
  EventId,
  AuthorId,
  Event,
  Draft,
  Filter,
  ChangeToken,
  Conflict,
  Rejected,
  Damaged,
  Ingested,
  EventStore,
} from "./event.js";
export {
  isUuidv7,
  isEventId,
  isAuthorId,
  isRawCid,
  timestampOf,
  isCanonicalAt,
  atOf,
  MAX_T,
  validateEvent,
  validateDraft,
  canonicalEventBytes,
  compareEvents,
  matches,
  matchesData,
} from "./event.js";

export { mint, type Minted } from "./mint.js";

export { InvalidJson, InvalidEvent } from "./errors.js";
