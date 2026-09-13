/**
 * The canonical public-key value: the did:key encoding of the complete
 * type-tagged key — unsigned-varint multicodec code, then the raw key,
 * a compressed point for a Weierstrass curve — as base58btc multibase
 * without the `did:key:` prefix. Every representation of one key
 * normalizes to this one string, and every deterministic ID or
 * authorization check that involves a peer key uses it.
 */

import bs58 from "bs58";

import { decodeBase64Url } from "./base64url.js";
import { InvalidPublicKey } from "./errors.js";
import type { PublicKey } from "./types.js";

export type KeyType = "Ed25519" | "X25519" | "secp256k1" | "P-256" | "P-384" | "P-521";

interface Codec {
  readonly type: KeyType;
  readonly code: number;
  /** Bytes of a coordinate, or of the whole key for a curve without points. */
  readonly coordinate: number;
  readonly point: boolean;
}

const CODECS: readonly Codec[] = [
  { type: "Ed25519", code: 0xed, coordinate: 32, point: false },
  { type: "X25519", code: 0xec, coordinate: 32, point: false },
  { type: "secp256k1", code: 0xe7, coordinate: 32, point: true },
  { type: "P-256", code: 0x1200, coordinate: 32, point: true },
  { type: "P-384", code: 0x1201, coordinate: 48, point: true },
  { type: "P-521", code: 0x1202, coordinate: 66, point: true },
];

/** A decoded public key: its type and the raw bytes did:key tags, a compressed point when the curve has points. */
export interface DecodedPublicKey {
  readonly type: KeyType;
  readonly bytes: Uint8Array;
}

/** The public members of a JWK; other members are ignored. */
export interface Jwk {
  readonly [member: string]: unknown;
}

function encodeVarint(code: number): number[] {
  const out: number[] = [];
  let n = code;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function decodeVarint(bytes: Uint8Array): { code: number; length: number } {
  let code = 0;
  for (let i = 0; i < bytes.length && i < 4; i++) {
    const byte = bytes[i] as number;
    code |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      if (encodeVarint(code).length !== i + 1) throw new InvalidPublicKey("multicodec code is not minimally encoded");
      return { code, length: i + 1 };
    }
  }
  throw new InvalidPublicKey("multicodec code is not an unsigned varint of at most four bytes");
}

function codecOf(type: KeyType): Codec {
  return CODECS.find((c) => c.type === type) as Codec;
}

function encode(codec: Codec, bytes: Uint8Array): PublicKey {
  return ("z" + bs58.encode(Uint8Array.from([...encodeVarint(codec.code), ...bytes]))) as PublicKey;
}

function compress(x: Uint8Array, y: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + x.length);
  out[0] = 0x02 | ((y[y.length - 1] as number) & 1);
  out.set(x, 1);
  return out;
}

function decodeMultibase(text: string): { codec: Codec; bytes: Uint8Array } {
  if (!text.startsWith("z") || text.length < 2) throw new InvalidPublicKey("not a base58btc multibase value");
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(text.slice(1));
  } catch {
    throw new InvalidPublicKey("not a base58btc multibase value");
  }
  const { code, length } = decodeVarint(decoded);
  const codec = CODECS.find((c) => c.code === code);
  if (codec === undefined) throw new InvalidPublicKey(`unsupported public-key multicodec 0x${code.toString(16)}`);
  const bytes = decoded.subarray(length);
  if (!codec.point) {
    if (bytes.length !== codec.coordinate) throw new InvalidPublicKey(`${codec.type} key is not ${codec.coordinate} bytes`);
    return { codec, bytes };
  }
  const first = bytes[0];
  if ((first === 0x02 || first === 0x03) && bytes.length === 1 + codec.coordinate) return { codec, bytes };
  if (first === 0x04 && bytes.length === 1 + 2 * codec.coordinate) {
    return { codec, bytes: compress(bytes.subarray(1, 1 + codec.coordinate), bytes.subarray(1 + codec.coordinate)) };
  }
  throw new InvalidPublicKey(`${codec.type} key is not a compressed or uncompressed point`);
}

function coordinate(jwk: Jwk, member: string, length: number, type: string): Uint8Array {
  const value = jwk[member];
  const bytes = typeof value === "string" ? decodeBase64Url(value) : null;
  if (bytes === null || bytes.length !== length) throw new InvalidPublicKey(`${type} JWK member ${member} is not ${length} bytes of base64url`);
  return bytes;
}

function decodeJwk(jwk: Jwk): { codec: Codec; bytes: Uint8Array } {
  const { kty, crv } = jwk;
  if (kty === "OKP" && (crv === "Ed25519" || crv === "X25519")) {
    if (jwk.y !== undefined) throw new InvalidPublicKey(`${crv} JWK has a y member`);
    const codec = codecOf(crv);
    return { codec, bytes: coordinate(jwk, "x", codec.coordinate, crv) };
  }
  if (kty === "EC" && (crv === "P-256" || crv === "P-384" || crv === "P-521" || crv === "secp256k1")) {
    const codec = codecOf(crv);
    return { codec, bytes: compress(coordinate(jwk, "x", codec.coordinate, crv), coordinate(jwk, "y", codec.coordinate, crv)) };
  }
  throw new InvalidPublicKey(`unsupported JWK: kty ${JSON.stringify(kty)}, crv ${JSON.stringify(crv)}`);
}

/** The canonical value of a key given as a JWK or as any multibase form of it. */
export function canonicalPublicKey(key: string | Jwk): PublicKey {
  const { codec, bytes } = typeof key === "string" ? decodeMultibase(key) : decodeJwk(key);
  return encode(codec, bytes);
}

/** `text` as a canonical public-key value, or a throw when it is not exactly one. */
export function parsePublicKey(text: string): PublicKey {
  const canonical = canonicalPublicKey(text);
  if (canonical !== text) throw new InvalidPublicKey("public key is not in its canonical form");
  return canonical;
}

/** The type and raw bytes a canonical value carries. */
export function decodePublicKey(key: PublicKey): DecodedPublicKey {
  const { codec, bytes } = decodeMultibase(key);
  return { type: codec.type, bytes };
}
