/**
 * Local state of the trace kind (event-store.md §7.2): the event's shape
 * less what only exchange needs, minted by its producer, never ingested,
 * pruned by its owner. Types only; a folder keeps one under
 * `local/<owner>/trace/`.
 */

import type { JsonObject, JsonPrimitive } from "./json.js";
import { isJsonObject } from "./json.js";
import { isRfc3339Utc, isUuidv7, matchesData } from "./event.js";

/** The event's shape, less author and blobs. Id and time are the producer's. */
export type LocalEvent<D extends JsonObject = JsonObject> = { eid: string; at: string; type: string; data: D };

/** As `Filter`, less `author`, plus `eid`: a line is looked up by the id another line cites. */
export type LocalFilter = { eid?: string; type?: string; data?: { [field: string]: JsonPrimitive | undefined } };

export interface LocalEventStore<E extends LocalEvent = LocalEvent, Policy = unknown, Report = unknown> {
  /** Minted by the producer; the store checks the shape and nothing else. */
  append(event: E): Promise<void>;
  /** Equality, as §4.3; canonical order. */
  scan(filter?: LocalFilter): AsyncIterable<E>;
  /** What is kept, per the owner; what was unlinked. */
  prune(policy: Policy): Promise<Report>;
}

/** Whether `value` has a local event's shape: the four fields, well formed, and no other. */
export function isLocalEvent(value: unknown): value is LocalEvent {
  if (!isJsonObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    isUuidv7(value["eid"]) &&
    isRfc3339Utc(value["at"]) &&
    typeof value["type"] === "string" &&
    value["type"] !== "" &&
    isJsonObject(value["data"])
  );
}

export function matchesLocal(event: LocalEvent, filter?: LocalFilter): boolean {
  if (filter === undefined) {
    return true;
  }
  if (filter.eid !== undefined && event.eid !== filter.eid) {
    return false;
  }
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  return matchesData(event.data, filter.data);
}


