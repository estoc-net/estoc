/**
 * DASL CIDs (https://dasl.ing/cid.html): CIDv1, sha-256, codec `raw`
 * (0x55, bare bytes) or `drisl` (0x71, a DRISL document), string form
 * multibase base32 lower (`b…`). Every DASL CID is exactly 36 bytes:
 * `01 <codec> 12 20 <32-byte digest>` — no varints to parse, no other
 * hash, no other base. The whole of what this format needs of CIDs, with
 * no dependency: sha-256 is WebCrypto's.
 */

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

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LOOKUP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

/** RFC 4648 base32, lowercase alphabet, no padding — the DASL string form's body. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The inverse; throws on a character outside the alphabet or non-zero trailing bits. */
export function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const c of text) {
    const v = LOOKUP.get(c);
    if (v === undefined) throw new Error(`not base32 lower: ${JSON.stringify(c)}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  if (bits >= 5 || value !== 0) throw new Error("base32: non-canonical trailing bits");
  return new Uint8Array(out);
}

/** Decode the 36-byte binary form; throws unless it is exactly a DASL CID. */
export function cidFromBytes(bytes: Uint8Array): DaslCid {
  if (bytes.length !== CID_LENGTH) throw new Error(`a DASL CID is ${CID_LENGTH} bytes, not ${bytes.length}`);
  if (bytes[0] !== 1) throw new Error(`CID version ${bytes[0]} is not 1`);
  const code = bytes[1] as number;
  if (code !== RAW_CODE && code !== DRISL_CODE) throw new Error(`CID codec 0x${code.toString(16)} is neither raw nor drisl`);
  if (bytes[2] !== SHA256_CODE) throw new Error("CID hash is not sha-256");
  if (bytes[3] !== DIGEST_LENGTH) throw new Error("CID digest is not 32 bytes");
  const copy = new Uint8Array(bytes);
  return { code, digest: copy.subarray(4), bytes: copy, text: `b${base32Encode(copy)}` };
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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** The CID that names `bytes` under `code`. */
export async function cidOf(code: number, bytes: Uint8Array): Promise<DaslCid> {
  if (code !== RAW_CODE && code !== DRISL_CODE) throw new Error(`codec 0x${code.toString(16)} is neither raw nor drisl`);
  const out = new Uint8Array(CID_LENGTH);
  out.set([1, code, SHA256_CODE, DIGEST_LENGTH]);
  out.set(await sha256(bytes), 4);
  return cidFromBytes(out);
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
