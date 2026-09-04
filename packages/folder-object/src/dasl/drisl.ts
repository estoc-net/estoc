/**
 * DRISL (https://dasl.ing/drisl.html): deterministic CBOR with CIDs as
 * tag 42 — the CBOR/c-42 profile. Encoder and strict decoder, complete
 * for the profile and nothing more, in one file with no dependency.
 *
 * Determinism is the point: one value has exactly one byte string, so a
 * document's CID is a function of its content. The encoder produces that
 * form; the decoder *refuses* every other form — shortest-form integers
 * and lengths only, definite lengths only, map keys text strings in
 * strictly ascending bytewise order of their encoding (for text keys the
 * same as DAG-CBOR's length-first order), no tag but 42, no simple value
 * but false/true/null, floats only as 64-bit finite non-negative-zero
 * values, valid UTF-8, no trailing bytes. A block that decodes here is a
 * block whose bytes are the only bytes its value can have.
 */

import { cidFromBytes, compareBytes, type DaslCid } from "./cid.js";

/** A CID as a DRISL value: tag 42 over `0x00 ‖ 36 CID bytes`. */
export class Link {
  constructor(readonly cid: DaslCid) {}
  toString(): string {
    return this.cid.text;
  }
}

/** The DRISL data model. Integers beyond 2^53 come back as bigint. */
export type Drisl = null | boolean | number | bigint | string | Uint8Array | Link | Drisl[] | { [key: string]: Drisl };

/** Nesting deeper than this is refused, whatever the bytes claim. */
export const MAX_DEPTH = 64;

const TWO_64 = 1n << 64n;

/* ---------------------------------------------------------------- encode */

class Writer {
  private chunks: Uint8Array[] = [];
  private small: number[] = [];

  push(...bytes: number[]): void {
    this.small.push(...bytes);
  }

  bytes(b: Uint8Array): void {
    this.flush();
    this.chunks.push(b);
  }

  head(major: number, n: number | bigint): void {
    const type = major << 5;
    const v = typeof n === "bigint" ? n : BigInt(n);
    if (v < 0n) throw new Error("negative argument");
    if (v < 24n) this.push(type | Number(v));
    else if (v < 0x100n) this.push(type | 24, Number(v));
    else if (v < 0x10000n) this.push(type | 25, Number(v >> 8n), Number(v & 0xffn));
    else if (v < 0x100000000n) this.push(type | 26, ...be(v, 4));
    else if (v < TWO_64) this.push(type | 27, ...be(v, 8));
    else throw new Error("integer does not fit in 64 bits");
  }

  private flush(): void {
    if (this.small.length) {
      this.chunks.push(new Uint8Array(this.small));
      this.small = [];
    }
  }

  finish(): Uint8Array {
    this.flush();
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

function be(v: bigint, width: number): number[] {
  const out: number[] = [];
  for (let i = width - 1; i >= 0; i--) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}

const utf8 = new TextEncoder();

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function encodeText(w: Writer, s: string): void {
  if (LONE_SURROGATE.test(s)) throw new Error("text is not well-formed Unicode (lone surrogate)");
  const b = utf8.encode(s);
  w.head(3, b.length);
  w.bytes(b);
}

function encodeValue(w: Writer, value: Drisl, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error(`nesting deeper than ${MAX_DEPTH}`);
  if (value === null) return w.push(0xf6);
  if (value === true) return w.push(0xf5);
  if (value === false) return w.push(0xf4);
  if (typeof value === "number") {
    // A safe integer is an integer; anything else a number holds (a
    // fraction, or an integral value past 2^53 that a double cannot
    // count exactly) is a 64-bit float — cborg's rule too, so the bytes
    // agree with @ipld/dag-cbor. Exact large integers are bigints.
    if (Number.isSafeInteger(value)) {
      return value >= 0 ? w.head(0, value) : w.head(1, -1 - value);
    }
    if (!Number.isFinite(value)) throw new Error("DRISL has no NaN or infinity");
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, value);
    w.push(0xfb);
    return w.bytes(new Uint8Array(buf.buffer));
  }
  if (typeof value === "bigint") {
    return value >= 0n ? w.head(0, value) : w.head(1, -1n - value);
  }
  if (typeof value === "string") return encodeText(w, value);
  if (value instanceof Uint8Array) {
    w.head(2, value.length);
    return w.bytes(value);
  }
  if (value instanceof Link) {
    w.push(0xd8, 42);
    w.head(2, value.cid.bytes.length + 1);
    w.push(0);
    return w.bytes(value.cid.bytes);
  }
  if (Array.isArray(value)) {
    w.head(4, value.length);
    for (const item of value) encodeValue(w, item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const entries: [Uint8Array, Drisl][] = [];
    for (const key of Object.keys(value)) {
      const kw = new Writer();
      encodeText(kw, key);
      entries.push([kw.finish(), value[key] as Drisl]);
    }
    entries.sort((a, b) => compareBytes(a[0], b[0]));
    w.head(5, entries.length);
    for (const [k, v] of entries) {
      w.bytes(k);
      encodeValue(w, v, depth + 1);
    }
    return;
  }
  throw new Error(`cannot encode ${typeof value} as DRISL`);
}

/** The one byte string a value has. */
export function encodeDrisl(value: Drisl): Uint8Array {
  const w = new Writer();
  encodeValue(w, value, 0);
  return w.finish();
}

/* ---------------------------------------------------------------- decode */

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

class Reader {
  at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private byte(): number {
    if (this.at >= this.bytes.length) throw new Error("truncated");
    return this.bytes[this.at++] as number;
  }

  take(n: number): Uint8Array {
    if (n > this.bytes.length - this.at) throw new Error("truncated");
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  remaining(): number {
    return this.bytes.length - this.at;
  }

  /** Read a head; returns the major type and its argument, refusing non-shortest and indefinite forms. */
  head(): { major: number; arg: bigint; info: number } {
    const first = this.byte();
    const major = first >> 5;
    const info = first & 0x1f;
    if (info < 24) return { major, arg: BigInt(info), info };
    if (info === 31) throw new Error("indefinite length");
    if (info > 27) throw new Error(`reserved additional information ${info}`);
    const width = 1 << (info - 24);
    let arg = 0n;
    for (let i = 0; i < width; i++) arg = (arg << 8n) | BigInt(this.byte());
    if (major === 7) return { major, arg, info }; // floats: checked by the caller
    const floor = info === 24 ? 24n : info === 25 ? 0x100n : info === 26 ? 0x10000n : 0x100000000n;
    if (arg < floor) throw new Error("integer or length not in shortest form");
    return { major, arg, info };
  }

  value(depth: number): Drisl {
    if (depth > MAX_DEPTH) throw new Error(`nesting deeper than ${MAX_DEPTH}`);
    const { major, arg, info } = this.head();
    switch (major) {
      case 0:
        return arg <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(arg) : arg;
      case 1: {
        const v = -1n - arg;
        return v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v;
      }
      case 2:
        return new Uint8Array(this.take(length(arg)));
      case 3: {
        const b = this.take(length(arg));
        try {
          return utf8Strict.decode(b);
        } catch {
          throw new Error("text is not valid UTF-8");
        }
      }
      case 4: {
        const n = length(arg);
        if (n > this.remaining()) throw new Error("array longer than the input");
        const out: Drisl[] = [];
        for (let i = 0; i < n; i++) out.push(this.value(depth + 1));
        return out;
      }
      case 5: {
        const n = length(arg);
        if (n > this.remaining() / 2) throw new Error("map longer than the input");
        const out: { [key: string]: Drisl } = {};
        let previous: Uint8Array | null = null;
        for (let i = 0; i < n; i++) {
          const start = this.at;
          const kh = this.head();
          if (kh.major !== 3) throw new Error("map key is not a text string");
          const kb = this.take(length(kh.arg));
          const encoded = this.bytes.subarray(start, this.at);
          if (previous !== null && compareBytes(previous, encoded) >= 0) {
            throw new Error("map keys not in strictly ascending bytewise order");
          }
          previous = encoded;
          let key: string;
          try {
            key = utf8Strict.decode(kb);
          } catch {
            throw new Error("map key is not valid UTF-8");
          }
          if (key === "__proto__") throw new Error("map key __proto__ is refused");
          out[key] = this.value(depth + 1);
        }
        return out;
      }
      case 6: {
        if (arg !== 42n) throw new Error(`tag ${arg} is not tag 42`);
        const ih = this.head();
        if (ih.major !== 2) throw new Error("tag 42 content is not a byte string");
        const b = this.take(length(ih.arg));
        if (b[0] !== 0) throw new Error("tag 42 byte string does not start with 0x00");
        return new Link(cidFromBytes(b.subarray(1)));
      }
      case 7: {
        if (info < 24) {
          if (arg === 20n) return false;
          if (arg === 21n) return true;
          if (arg === 22n) return null;
          throw new Error(`simple value ${arg} is not false, true or null`);
        }
        if (info === 24) throw new Error("one-byte simple values are not allowed");
        if (info !== 27) throw new Error("floats must be 64-bit");
        const view = new DataView(new ArrayBuffer(8));
        for (let i = 0; i < 8; i++) view.setUint8(i, Number((arg >> BigInt(8 * (7 - i))) & 0xffn));
        const f = view.getFloat64(0);
        if (!Number.isFinite(f)) throw new Error("DRISL has no NaN or infinity");
        if (Object.is(f, -0)) throw new Error("DRISL has no negative zero");
        return f;
      }
      default:
        throw new Error(`major type ${major}`);
    }
  }
}

function length(arg: bigint): number {
  if (arg > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("length beyond 2^53");
  return Number(arg);
}

/** Decode exactly one DRISL document; throws on any non-canonical or trailing byte. */
export function decodeDrisl(bytes: Uint8Array): Drisl {
  const r = new Reader(bytes);
  const value = r.value(0);
  if (r.remaining() !== 0) throw new Error(`${r.remaining()} trailing bytes after the document`);
  return value;
}
