/**
 * CARv1 (https://ipld.io/specs/transport/car/carv1/): a header naming the
 * roots, then blocks — each a CID and its bytes, length-prefixed. This is
 * how a tree's closure travels as one file (`docs/object-share.md` §8).
 *
 * The header is dag-cbor `{version: 1, roots: [CID…]}`, hand-encoded and
 * hand-decoded here: the map has two fixed keys and a CID is CBOR tag 42
 * over a byte string with a leading 0x00, which is all of dag-cbor this
 * format needs. Nothing else in the package pulls in a CBOR codec.
 */

import { CID } from "multiformats/cid";
import { base32 } from "multiformats/bases/base32";
import { sha256 } from "multiformats/hashes/sha2";

import { checkCid } from "./cid.js";

/** A CAR read back: what the header named and every block whose bytes match its CID. */
export interface Car {
  roots: string[];
  /** CID → bytes, in file order; blocks that do not hash to their CID are left out */
  blocks: Map<string, Uint8Array>;
  /** the CIDs of blocks dropped for not hashing to their name */
  bad: string[];
}

/** Encode a CAR: `roots`, then `blocks` in map order. */
export function encodeCar(roots: string[], blocks: Map<string, Uint8Array>): Uint8Array {
  const header = encodeHeader(roots.map((root) => CID.parse(root)));
  const parts: Uint8Array[] = [varint(header.length), header];
  for (const [cid, bytes] of blocks) {
    const name = CID.parse(cid).bytes;
    parts.push(varint(name.length + bytes.length), name, bytes);
  }
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Decode a CAR and check every block against its CID: a block whose bytes
 * do not hash to its name is not kept but listed in `bad`, so the caller
 * trusts every byte in `blocks`. A later block under a CID already seen
 * is ignored. Throws on a malformed container (a bad header, a truncated
 * section, a version other than 1).
 */
export async function decodeCar(bytes: Uint8Array): Promise<Car> {
  let at = 0;
  const section = (): Uint8Array => {
    const [length, next] = readVarint(bytes, at);
    if (next + length > bytes.length) {
      throw new Error("truncated CAR");
    }
    at = next + length;
    return bytes.subarray(next, at);
  };
  const roots = decodeHeader(section());
  const blocks = new Map<string, Uint8Array>();
  const bad: string[] = [];
  while (at < bytes.length) {
    const [cid, data] = CID.decodeFirst(section());
    const name = cid.toString();
    if (blocks.has(name)) {
      continue;
    }
    try {
      await checkCid(cid, data);
      blocks.set(name, data);
    } catch {
      bad.push(name);
    }
  }
  return { roots: roots.map((root) => root.toString()), blocks, bad };
}

/**
 * The name of a blob — any bytes — as `docs/blob-store.md` names them: a
 * sha-256 multihash, multibase base32 lower (`b…`, 56 characters).
 */
export async function blobHash(bytes: Uint8Array): Promise<string> {
  return base32.encode((await sha256.digest(bytes)).bytes);
}

/** Does this string have the shape of a blob name? (The hash itself is checked against bytes.) */
export function isBlobHash(name: string): boolean {
  return /^b[a-z2-7]{55}$/.test(name);
}

/*
 * dag-cbor, the two-key map. Keys sort by length then bytes, so `roots`
 * comes before `version`. A CID is tag 42 over `0x00 ‖ cid bytes`.
 */

function encodeHeader(roots: CID[]): Uint8Array {
  const parts: number[] = [0xa2, 0x65, ...utf8("roots")];
  parts.push(...cborHead(4, roots.length));
  for (const root of roots) {
    parts.push(0xd8, 42, ...cborHead(2, root.bytes.length + 1), 0x00, ...root.bytes);
  }
  parts.push(0x67, ...utf8("version"), 0x01);
  return new Uint8Array(parts);
}

function decodeHeader(bytes: Uint8Array): CID[] {
  const reader = new CborReader(bytes);
  const header = reader.read() as Record<string, unknown>;
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    throw new Error("CAR header is not a map");
  }
  if (header.version !== 1) {
    throw new Error(`CAR version ${String(header.version)} is not 1`);
  }
  const roots = header.roots;
  if (!Array.isArray(roots) || !roots.every((root) => root instanceof CID)) {
    throw new Error("CAR header roots are not CIDs");
  }
  return roots;
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

/** A CBOR major-type head with its argument. */
function cborHead(major: number, n: number): number[] {
  const type = major << 5;
  if (n < 24) return [type | n];
  if (n < 0x100) return [type | 24, n];
  if (n < 0x10000) return [type | 25, n >> 8, n & 0xff];
  return [type | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Just enough CBOR to read a CAR header: ints, bytes, text, arrays, maps, tag 42. */
class CborReader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  read(): unknown {
    const first = this.byte();
    const major = first >> 5;
    const n = this.argument(first & 0x1f);
    switch (major) {
      case 0:
        return n;
      case 2:
        return this.take(n);
      case 3:
        return new TextDecoder().decode(this.take(n));
      case 4: {
        const items: unknown[] = [];
        for (let i = 0; i < n; i++) items.push(this.read());
        return items;
      }
      case 5: {
        const map: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = this.read();
          if (typeof key !== "string") throw new Error("CAR header key is not text");
          map[key] = this.read();
        }
        return map;
      }
      case 6: {
        const inner = this.read();
        if (n !== 42 || !(inner instanceof Uint8Array) || inner[0] !== 0) {
          throw new Error("CAR header holds a tag that is not a CID");
        }
        return CID.decode(inner.subarray(1));
      }
      default:
        throw new Error(`unsupported CBOR item in CAR header (major type ${major})`);
    }
  }

  private byte(): number {
    if (this.at >= this.bytes.length) throw new Error("truncated CAR header");
    return this.bytes[this.at++] as number;
  }

  private take(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new Error("truncated CAR header");
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  private argument(info: number): number {
    if (info < 24) return info;
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : -1;
    if (width < 0) throw new Error("unsupported CBOR length in CAR header");
    let n = 0;
    for (let i = 0; i < width; i++) n = n * 256 + this.byte();
    return n;
  }
}

function varint(n: number): Uint8Array {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return new Uint8Array(out);
}

function readVarint(bytes: Uint8Array, at: number): [number, number] {
  let n = 0;
  let shift = 1;
  for (let i = 0; i < 9; i++) {
    if (at >= bytes.length) throw new Error("truncated CAR");
    const b = bytes[at++] as number;
    n += (b & 0x7f) * shift;
    if (b < 0x80) return [n, at];
    shift *= 128;
  }
  throw new Error("CAR length too long");
}
