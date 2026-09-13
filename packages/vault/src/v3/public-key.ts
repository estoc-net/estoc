/**
 * The canonical public-key value: the did:key encoding of the complete
 * type-tagged key — unsigned-varint multicodec code, then the raw key,
 * a compressed point for a Weierstrass curve — as base58btc multibase
 * without the `did:key:` prefix. Every representation of one key
 * normalizes to this one string, and every deterministic ID or
 * authorization check that involves a peer key uses it.
 */

import { p256, p384, p521 } from "@noble/curves/nist";
import { secp256k1 } from "@noble/curves/secp256k1";
import { base58, base64urlnopad } from "@scure/base";
import { varint } from "multiformats";

import { InvalidPublicKey } from "./errors.js";
import type { PublicKey } from "./types.js";

export type KeyType = "Ed25519" | "X25519" | "secp256k1" | "P-256" | "P-384" | "P-521";

type Curve = typeof p256;

interface Codec {
  readonly type: KeyType;
  readonly code: number;
  /** Bytes of the raw key, or of one coordinate of a point on `curve`. */
  readonly size: number;
  readonly curve?: Curve;
}

const CODECS: readonly Codec[] = [
  { type: "Ed25519", code: 0xed, size: 32 },
  { type: "X25519", code: 0xec, size: 32 },
  { type: "secp256k1", code: 0xe7, size: 32, curve: secp256k1 },
  { type: "P-256", code: 0x1200, size: 32, curve: p256 },
  { type: "P-384", code: 0x1201, size: 48, curve: p384 },
  { type: "P-521", code: 0x1202, size: 66, curve: p521 },
];

/** A decoded public key: its type and the raw bytes did:key tags, a SEC 1 compressed point for a Weierstrass curve. */
export interface DecodedPublicKey {
  readonly type: KeyType;
  readonly bytes: Uint8Array;
}

/** The public members of a JWK; other members are ignored. */
export interface Jwk {
  readonly [member: string]: unknown;
}

function codePrefix(code: number): Uint8Array {
  const prefix = new Uint8Array(varint.encodingLength(code));
  varint.encodeTo(code, prefix);
  return prefix;
}

/** The multicodec code and its width, refused unless minimally encoded. */
function decodeCode(bytes: Uint8Array): [code: number, length: number] {
  try {
    return varint.decode(bytes);
  } catch {
    throw new InvalidPublicKey("not a multicodec-prefixed key");
  }
}

function codecOf(type: KeyType): Codec {
  return CODECS.find((c) => c.type === type) as Codec;
}

function encode(codec: Codec, bytes: Uint8Array): PublicKey {
  return ("z" + base58.encode(Uint8Array.from([...codePrefix(codec.code), ...bytes]))) as PublicKey;
}

/** The compressed form of a SEC 1 point that the curve accepts, in any SEC 1 encoding. */
function compressedPoint(codec: Codec, curve: Curve, encoded: Uint8Array): Uint8Array {
  try {
    return curve.Point.fromBytes(encoded).toBytes(true);
  } catch {
    throw new InvalidPublicKey(`not a point on ${codec.type}`);
  }
}

function decodeMultibase(text: string): { codec: Codec; bytes: Uint8Array } {
  if (!text.startsWith("z") || text.length < 2) throw new InvalidPublicKey("not a base58btc multibase value");
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(text.slice(1));
  } catch {
    throw new InvalidPublicKey("not a base58btc multibase value");
  }
  const [code, length] = decodeCode(decoded);
  const codec = CODECS.find((c) => c.code === code);
  if (codec === undefined) throw new InvalidPublicKey(`unsupported public-key multicodec 0x${code.toString(16)}`);
  const bytes = decoded.subarray(length);
  if (codec.curve !== undefined) return { codec, bytes: compressedPoint(codec, codec.curve, bytes) };
  if (bytes.length !== codec.size) throw new InvalidPublicKey(`${codec.type} key is not ${codec.size} bytes`);
  return { codec, bytes };
}

function coordinate(jwk: Jwk, member: string, length: number, type: string): Uint8Array {
  const value = jwk[member];
  let bytes: Uint8Array | null = null;
  try {
    bytes = typeof value === "string" ? base64urlnopad.decode(value) : null;
  } catch {
    bytes = null;
  }
  if (bytes === null || bytes.length !== length) throw new InvalidPublicKey(`${type} JWK member ${member} is not ${length} bytes of base64url`);
  return bytes;
}

function decodeJwk(jwk: Jwk): { codec: Codec; bytes: Uint8Array } {
  const { kty, crv } = jwk;
  if (kty === "OKP" && (crv === "Ed25519" || crv === "X25519")) {
    if (jwk.y !== undefined) throw new InvalidPublicKey(`${crv} JWK has a y member`);
    const codec = codecOf(crv);
    return { codec, bytes: coordinate(jwk, "x", codec.size, crv) };
  }
  if (kty === "EC" && (crv === "P-256" || crv === "P-384" || crv === "P-521" || crv === "secp256k1")) {
    const codec = codecOf(crv);
    const uncompressed = Uint8Array.from([0x04, ...coordinate(jwk, "x", codec.size, crv), ...coordinate(jwk, "y", codec.size, crv)]);
    return { codec, bytes: compressedPoint(codec, codec.curve as Curve, uncompressed) };
  }
  throw new InvalidPublicKey(`unsupported JWK: kty ${JSON.stringify(kty)}, crv ${JSON.stringify(crv)}`);
}

/** The canonical value of a key given as a JWK or as its base58btc multibase form. */
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
