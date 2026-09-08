/**
 * RFC 8785, the JSON Canonicalization Scheme, as the event format uses it:
 * `canonicalize` turns a JSON value into the one byte string that stands for its
 * content; `parseStrict` reads JSON text back the way the event format requires —
 * refusing a duplicate member, an unpaired surrogate and a number outside binary64,
 * which `JSON.parse` would let through. The syntax is jsonc-parser's scanner, held
 * to RFC 8259; the value is built here, where those refusals live.
 *
 * Canonical form (RFC 8785 §3): no insignificant whitespace; object members sorted
 * by the UTF-16 code units of their names; arrays in order; numbers in ECMAScript
 * `Number::toString` form; strings escaped as `JSON.stringify` escapes them (`"`,
 * `\`, and U+0000–U+001F only); UTF-8. Two events are the same content exactly when
 * these bytes are equal.
 */

import { printParseErrorCode, visit } from "jsonc-parser";

import { InvalidJson } from "./errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

/**
 * Nesting deeper than this is refused by both directions. Not a rule of
 * RFC 8785 — a limit this implementation documents so hostile input
 * cannot exhaust the stack.
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
 * Parse JSON text as the event format restricts it: RFC 8259 syntax, exactly;
 * valid UTF-8 with no byte-order mark; no duplicate member name; no unpaired
 * surrogate or noncharacter in a name or value, escaped or not; every number
 * a finite binary64; nesting within `MAX_DEPTH`. jsonc-parser scans the text
 * — comments and trailing commas refused, whitespace only the four of RFC
 * 8259, a control character or a bad escape in a string an error — and the
 * visitor below builds the value, refusing what a scanner cannot see. What
 * comes back is plain data — a member named `__proto__` is an own property,
 * as `JSON.parse` would make it. Throws `InvalidJson`.
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

  let root: JsonValue | undefined;
  // The containers still open, innermost last; `key` is the member name a value is about to fill.
  const open: { readonly value: JsonValue[] | JsonObject; key: string | null }[] = [];

  const fail = (offset: number, what: string): never => {
    throw new InvalidJson(`${what} at offset ${offset}`);
  };
  const place = (value: JsonValue): void => {
    const parent = open[open.length - 1];
    if (parent === undefined) root = value;
    else if (Array.isArray(parent.value)) parent.value.push(value);
    else Object.defineProperty(parent.value, parent.key as string, { value, enumerable: true, writable: true, configurable: true });
  };
  const begin = (offset: number, value: JsonValue[] | JsonObject): void => {
    if (open.length >= MAX_DEPTH) fail(offset, `nested deeper than ${MAX_DEPTH}`);
    place(value);
    open.push({ value, key: null });
  };
  const end = (): void => {
    open.pop();
  };

  visit(
    text,
    {
      onObjectBegin: (offset) => begin(offset, {}),
      onObjectProperty: (name, offset) => {
        const fault = forbiddenIn(name);
        if (fault !== null) fail(offset, fault);
        const parent = open[open.length - 1] as { value: JsonObject; key: string | null };
        if (Object.hasOwn(parent.value, name)) fail(offset, `duplicate member ${JSON.stringify(name)}`);
        parent.key = name;
      },
      onObjectEnd: end,
      onArrayBegin: (offset) => begin(offset, []),
      onArrayEnd: end,
      onLiteralValue: (value: unknown, offset, length) => {
        if (typeof value === "string") {
          const fault = forbiddenIn(value);
          if (fault !== null) fail(offset, fault);
        } else if (typeof value === "number" && !Number.isFinite(value)) {
          fail(offset, `${text.slice(offset, offset + length)} is outside binary64`);
        }
        place(value as JsonValue);
      },
      onError: (code, offset) => fail(offset, SYNTAX[printParseErrorCode(code)] ?? "bad syntax"),
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false }
  );
  return root as JsonValue;
}

/** jsonc-parser's error codes, in the words the errors here use. */
const SYNTAX: Record<string, string> = {
  InvalidSymbol: "unexpected token",
  InvalidNumberFormat: "bad number",
  PropertyNameExpected: "expected a member name",
  ValueExpected: "expected a value",
  ColonExpected: "expected :",
  CommaExpected: "expected ,",
  CloseBraceExpected: "expected }",
  CloseBracketExpected: "expected ]",
  EndOfFileExpected: "trailing characters",
  InvalidCommentToken: "comment",
  UnexpectedEndOfComment: "comment",
  UnexpectedEndOfString: "unterminated string",
  UnexpectedEndOfNumber: "bad number",
  InvalidUnicode: "bad unicode escape",
  InvalidEscapeCharacter: "bad escape",
  InvalidCharacter: "control character in string",
};
