/**
 * RFC 8785, the JSON Canonicalization Scheme, as event-store.md §3.3 uses
 * it: `canonicalize` turns a JSON value into the one byte string that
 * stands for its content; `parseStrict` reads JSON text back the way
 * §3.3 requires — refusing a duplicate member, an unpaired surrogate and
 * a number outside binary64, which `JSON.parse` would let through.
 *
 * Canonical form (RFC 8785 §3): no insignificant whitespace; object
 * members sorted by the UTF-16 code units of their names; arrays in
 * order; numbers in ECMAScript `Number::toString` form; strings escaped
 * as `JSON.stringify` escapes them (`"`, `\`, and U+0000–U+001F only);
 * UTF-8. Two events are the same content exactly when these bytes are
 * equal.
 */

import { InvalidJson } from "./errors.js";
import { isJsonObject, type JsonValue } from "./json.js";

/**
 * Nesting deeper than this is refused by both directions. Not a rule of
 * RFC 8785 — a limit this implementation documents (event-store.md §13)
 * so hostile input cannot exhaust the stack.
 */
export const MAX_DEPTH = 1000;

// What I-JSON (RFC 7493 §2.1) keeps out of a member name or string value: a
// surrogate code point — with the `u` flag a proper pair reads as one
// supplementary code point, so `Cs` is exactly the unpaired ones — and a
// noncharacter, U+FDD0–U+FDEF and the last two code points of every plane.
const FORBIDDEN = /[\p{Cs}\p{Noncharacter_Code_Point}]/u;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 of the RFC 8785 serialization of `value`; throws `InvalidJson` when `value` is not I-JSON. */
export function canonicalize(value: unknown): Uint8Array {
  return encoder.encode(canonicalText(value));
}

/** The RFC 8785 serialization of `value` as a string; `canonicalize` is its UTF-8. */
export function canonicalText(value: unknown): string {
  const out: string[] = [];
  write(value, out, [], "$");
  return out.join("");
}

function write(value: unknown, out: string[], stack: object[], path: string): void {
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new InvalidJson(`${path}: ${String(value)} is not a finite number`);
      out.push(String(value));
      return;
    case "string":
      out.push(quote(value, path));
      return;
    case "object":
      break;
    default:
      throw new InvalidJson(`${path}: ${typeof value} is not JSON`);
  }
  if (value === null) {
    out.push("null");
    return;
  }
  if (stack.includes(value)) throw new InvalidJson(`${path}: cycle`);
  if (stack.length >= MAX_DEPTH) throw new InvalidJson(`${path}: nested deeper than ${MAX_DEPTH}`);
  stack.push(value);
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",");
      write(value[i], out, stack, `${path}[${i}]`);
    }
    out.push("]");
  } else {
    if (!isJsonObject(value)) throw new InvalidJson(`${path}: a ${describe(value)} is not JSON`);
    const keys = Object.keys(value).sort(compareCodeUnits);
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      const member = (value as Record<string, unknown>)[key];
      const at = `${path}.${key}`;
      if (member === undefined) throw new InvalidJson(`${at}: undefined is not JSON`);
      if (i > 0) out.push(",");
      out.push(quote(key, at), ":");
      write(member, out, stack, at);
    }
    out.push("}");
  }
  stack.pop();
}

function quote(text: string, path: string): string {
  const fault = forbiddenIn(text);
  if (fault !== null) throw new InvalidJson(`${path}: ${fault}`);
  return JSON.stringify(text);
}

/** Why `text` is not an I-JSON string, or null when it is one. */
export function forbiddenIn(text: string): string | null {
  const match = FORBIDDEN.exec(text);
  if (match === null) return null;
  const code = match[0].codePointAt(0) as number;
  const kind = code >= 0xd800 && code <= 0xdfff ? "unpaired surrogate" : "noncharacter";
  return `${kind} U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

function describe(value: object): string {
  const name = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof name === "string" && name !== "" ? name : "host object";
}

/** UTF-16 code unit order — what RFC 8785 §3.2.3 sorts member names by, and what `<` on strings compares. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse JSON text under event-store.md §3.3: RFC 8259 syntax, exactly;
 * valid UTF-8 with no byte-order mark; no duplicate member name; no
 * unpaired surrogate or noncharacter in a name or value, escaped or
 * not; every number a finite binary64.
 * What comes back is plain data — a member named `__proto__` is an own
 * property, as `JSON.parse` would make it. Throws `InvalidJson`.
 */
export function parseStrict(input: Uint8Array | string): JsonValue {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = decoder.decode(input);
    } catch {
      throw new InvalidJson("not valid UTF-8");
    }
  }
  const parser = new Parser(text);
  parser.skipWhitespace();
  const value = parser.value(0);
  parser.skipWhitespace();
  if (parser.pos !== text.length) parser.fail("trailing characters");
  return value;
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES = new Map<string, string>([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

class Parser {
  pos = 0;
  constructor(readonly text: string) {}

  fail(what: string): never {
    throw new InvalidJson(`${what} at offset ${this.pos}`);
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length && WHITESPACE.has(this.text.charCodeAt(this.pos))) this.pos++;
  }

  value(depth: number): JsonValue {
    const c = this.text[this.pos];
    switch (c) {
      case "{":
        return this.object(depth);
      case "[":
        return this.array(depth);
      case '"':
        return this.string();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      case undefined:
        return this.fail("unexpected end");
      default:
        return this.number();
    }
  }

  literal<T extends JsonValue>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) this.fail("unexpected token");
    this.pos += word.length;
    return value;
  }

  number(): number {
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (match === null) this.fail("unexpected token");
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail(`${match[0]} is outside binary64`);
    this.pos += match[0].length;
    return value;
  }

  string(): string {
    // this.text[this.pos] === '"'
    let pos = this.pos + 1;
    const parts: string[] = [];
    let start = pos;
    for (;;) {
      if (pos >= this.text.length) {
        this.pos = pos;
        this.fail("unterminated string");
      }
      const code = this.text.charCodeAt(pos);
      if (code === 0x22) {
        parts.push(this.text.slice(start, pos));
        const value = parts.join("");
        const fault = forbiddenIn(value);
        if (fault !== null) this.fail(fault);
        this.pos = pos + 1;
        return value;
      }
      if (code < 0x20) {
        this.pos = pos;
        this.fail("control character in string");
      }
      if (code !== 0x5c) {
        pos++;
        continue;
      }
      parts.push(this.text.slice(start, pos));
      this.pos = pos + 1;
      const escape = this.text[this.pos];
      if (escape === "u") {
        const unit = this.hex4(this.pos + 1);
        this.pos += 5;
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (this.text[this.pos] !== "\\" || this.text[this.pos + 1] !== "u") this.fail("unpaired surrogate escape");
          const low = this.hex4(this.pos + 2);
          if (low < 0xdc00 || low > 0xdfff) this.fail("unpaired surrogate escape");
          this.pos += 6;
          parts.push(String.fromCharCode(unit, low));
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          this.fail("unpaired surrogate escape");
        } else {
          parts.push(String.fromCharCode(unit));
        }
      } else {
        const mapped = escape === undefined ? undefined : ESCAPES.get(escape);
        if (mapped === undefined) this.fail("bad escape");
        parts.push(mapped);
        this.pos += 1;
      }
      pos = this.pos;
      start = pos;
    }
  }

  hex4(at: number): number {
    const digits = this.text.slice(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
      this.pos = at;
      this.fail("bad unicode escape");
    }
    return parseInt(digits, 16);
  }

  array(depth: number): JsonValue[] {
    if (depth >= MAX_DEPTH) this.fail(`nested deeper than ${MAX_DEPTH}`);
    this.pos++; // [
    const out: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      out.push(this.value(depth + 1));
      this.skipWhitespace();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return out;
      }
      this.fail("expected , or ]");
    }
  }

  object(depth: number): { [field: string]: JsonValue } {
    if (depth >= MAX_DEPTH) this.fail(`nested deeper than ${MAX_DEPTH}`);
    this.pos++; // {
    const out: { [field: string]: JsonValue } = {};
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') this.fail("expected a member name");
      const key = this.string();
      if (Object.hasOwn(out, key)) this.fail(`duplicate member ${JSON.stringify(key)}`);
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") this.fail("expected :");
      this.pos++;
      this.skipWhitespace();
      const value = this.value(depth + 1);
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      this.skipWhitespace();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return out;
      }
      this.fail("expected , or }");
    }
  }
}
