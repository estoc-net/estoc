/**
 * JSON as the event format restricts it — I-JSON (RFC 7493): objects,
 * arrays, strings, finite binary64 numbers, booleans and null. The
 * types here are what an event is made of; whether a value in hand is
 * one of them, with no duplicate member, no unpaired surrogate and no
 * host object, is `jcs.ts`'s question.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [field: string]: JsonValue };
export type JsonObject = { [field: string]: JsonValue };

export function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * A plain object: not an array, not null, not an instance of anything —
 * a `Map` or a `Date` is a host object, not JSON. Whether its members
 * are JSON is `canonicalize`'s question.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `value` and everything reachable from it frozen, and returned: what a store hands out cannot be edited into what it holds. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}
