/**
 * JSON in the sense of RFC 8259 (event-store.md §2.3): objects, arrays,
 * strings, numbers, booleans and null, and nothing else. An event is
 * one of these; a draft that is not — `undefined`, a bigint, a `Date`,
 * a cycle — is rejected before it is stored.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [field: string]: JsonValue };
export type JsonObject = { [field: string]: JsonValue };

export function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
}

/**
 * A plain object: not an array, not null, not an instance of anything —
 * a `Map` or a `Date` serializes as something else and is not JSON.
 * Whether its values are JSON is `jsonClean`'s question.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality as JSON (§2.3): objects as unordered maps, arrays in
 * order, numbers as doubles, strings by code point. Key order and the
 * bytes a serializer chose are not differences; a field present with
 * `undefined` and a field absent are (the caller cleans first).
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((value, i) => sameJson(value, b[i]));
  }
  if (!isJsonObject(a) || !isJsonObject(b)) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  const objectB = b as Record<string, unknown>;
  return keysA.every(
    (key) => Object.hasOwn(objectB, key) && sameJson((a as Record<string, unknown>)[key], objectB[key])
  );
}

/**
 * The value as JSON, or a throw: a value survives serialization unchanged
 * or it is not JSON. The copy returned is plain data the caller cannot
 * reach through the original — a store keeps this, never the argument.
 */
export function jsonClean<T extends JsonValue = JsonValue>(value: unknown): T {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new NotJson(err instanceof Error ? err.message : String(err));
  }
  if (text === undefined) {
    throw new NotJson(`${typeof value} is not JSON`);
  }
  const copy: unknown = JSON.parse(text);
  if (!sameJson(value, copy)) {
    throw new NotJson("value does not survive JSON serialization unchanged");
  }
  return copy as T;
}

export class NotJson extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotJson";
  }
}

/** Freeze a JSON value all the way down: what a store hands out is read-only. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
  }
  return value;
}
