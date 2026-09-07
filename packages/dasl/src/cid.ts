/**
 * DASL CIDs (https://dasl.ing/cid.html): CIDv1, sha-256, codec `raw`
 * (0x55, bare bytes) or `drisl` (0x71, a DRISL document), string form
 * multibase base32 lower (`b…`). Every DASL CID is exactly 36 bytes:
 * `01 <codec> 12 20 <32-byte digest>`. CIDs, multihashes, base32 and
 * sha-256 are multiformats'; this file is the DASL profile over them —
 * which version, codecs, hash, base and spelling a DASL CID has, and
 * the refusal of everything else.
 */

import { base32 } from "multiformats/bases/base32";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/** multicodec `raw`: the CID names the sha-256 of exactly these bytes. */
export const RAW_CODE = 0x55;
/** multicodec `dag-cbor`, used by DASL only for DRISL documents. */
export const DRISL_CODE = 0x71;

const SHA256_CODE = 0x12;
const DIGEST_LENGTH = 32;
/** `01 <codec> 12 20` + 32 bytes. */
export const CID_LENGTH = 36;

/** A DASL CID, decoded. `bytes` is the 36-byte binary form; `text` the `b…` string. */
export interface DaslCid {
  readonly code: number;
  readonly digest: Uint8Array;
  readonly bytes: Uint8Array;
  readonly text: string;
}

/** RFC 4648 base32, lowercase alphabet, no padding — the DASL string form's body. */
export function base32Encode(bytes: Uint8Array): string {
  return base32.baseEncode(bytes);
}

/**
 * The inverse; throws unless `text` is the one spelling of its bytes:
 * the lowercase alphabet only, no padding, zero trailing bits.
 */
export function base32Decode(text: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base32.baseDecode(text);
  } catch (error) {
    throw new Error(`not base32 lower: ${error instanceof Error ? error.message : String(error)}`);
  }
  // multiformats forgives `=` padding; DASL has none, and no other spelling either.
  if (base32.baseEncode(bytes) !== text) throw new Error("not base32 lower: not the canonical spelling");
  return bytes;
}

/** Decode the 36-byte binary form; throws unless it is exactly a DASL CID. */
export function cidFromBytes(bytes: Uint8Array): DaslCid {
  if (bytes.length !== CID_LENGTH) throw new Error(`a DASL CID is ${CID_LENGTH} bytes, not ${bytes.length}`);
  if (bytes[0] !== 1) throw new Error(`CID version ${bytes[0]} is not 1`);
  const code = bytes[1] as number;
  if (code !== RAW_CODE && code !== DRISL_CODE) throw new Error(`CID codec 0x${code.toString(16)} is neither raw nor drisl`);
  if (bytes[2] !== SHA256_CODE) throw new Error("CID hash is not sha-256");
  if (bytes[3] !== DIGEST_LENGTH) throw new Error("CID digest is not 32 bytes");
  return fromCid(CID.decode(bytes));
}

/** Parse the string form; throws unless it is a DASL CID in its one canonical spelling. */
export function parseCid(text: string): DaslCid {
  if (!text.startsWith("b")) throw new Error("a DASL CID starts with the base32 lower prefix b");
  const cid = cidFromBytes(base32Decode(text.slice(1)));
  if (cid.text !== text) throw new Error("CID is not in canonical base32 lower form");
  return cid;
}

/** Is this string a DASL CID? (The digest is checked against bytes elsewhere.) */
export function isDaslCid(text: unknown): text is string {
  if (typeof text !== "string") return false;
  try {
    parseCid(text);
    return true;
  } catch {
    return false;
  }
}

/** The codec of a DASL CID string, or null if it is not one. */
export function codecOf(text: string): number | null {
  try {
    return parseCid(text).code;
  } catch {
    return null;
  }
}

/** The CID that names `bytes` under `code`. */
export async function cidOf(code: number, bytes: Uint8Array): Promise<DaslCid> {
  if (code !== RAW_CODE && code !== DRISL_CODE) throw new Error(`codec 0x${code.toString(16)} is neither raw nor drisl`);
  return fromCid(CID.create(1, code, await sha256.digest(bytes)));
}

/** The raw CID string of bare bytes (a file, a leaf). */
export async function rawCid(bytes: Uint8Array): Promise<string> {
  return (await cidOf(RAW_CODE, bytes)).text;
}

/** The drisl CID string of an encoded DRISL document. */
export async function drislCid(bytes: Uint8Array): Promise<string> {
  return (await cidOf(DRISL_CODE, bytes)).text;
}

/** Throw unless `bytes` hash to `cid` (a string or a decoded CID) under its own codec. */
export async function checkCid(cid: string | DaslCid, bytes: Uint8Array): Promise<DaslCid> {
  const want = typeof cid === "string" ? parseCid(cid) : cid;
  const got = await cidOf(want.code, bytes);
  if (got.text !== want.text) throw new Error(`bytes do not hash to ${want.text}`);
  return want;
}

/** Bytewise lexicographic order of two byte strings (a proper prefix sorts first). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

// A CID within the profile, in this package's shape. `bytes` is the CID's own
// buffer (multiformats encodes afresh), so `digest` is a view into it, not into
// whatever the caller passed.
function fromCid(cid: CID): DaslCid {
  const bytes = cid.bytes;
  return { code: cid.code, digest: bytes.subarray(4), bytes, text: cid.toString(base32) };
}
