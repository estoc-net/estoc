/**
 * DASL CAR (https://dasl.ing/car.html): CARv1 over DASL CIDs. A header
 * — a length-prefixed DRISL map with `version: 1` and `roots`, an array
 * of CIDs — then blocks, each a length-prefixed `CID ‖ data` where the
 * CID is exactly the 36 bytes of a DASL CID. Lengths are unsigned
 * LEB128 varints. This is how a set of blocks travels as one file.
 *
 * Reading checks every block against its name: a section whose 36 bytes
 * are not a DASL CID, or whose data does not hash to it, is not kept —
 * the caller trusts every byte in `blocks`. Writing puts the roots and
 * blocks in the order given, so a CAR of one closure is one byte string
 * when the caller orders it.
 */

import { base32Encode, checkCid, CID_LENGTH, cidFromBytes, parseCid } from "./cid.js";
import { decodeDrisl, encodeDrisl, Link, type Drisl } from "./drisl.js";

/** A CAR read back: what the header named, every block whose bytes match its CID, and what was dropped. */
export interface Car {
  roots: string[];
  /** CID → bytes, in file order; a block that does not hash to its CID is left out, a later block under a CID already seen is ignored */
  blocks: Map<string, Uint8Array>;
  /**
   * The names of blocks dropped: a CID whose data does not hash to it, or
   * — spelled `b` + base32 of its 36 bytes, which no DASL CID shares —
   * a block named by something that is not a DASL CID.
   */
  bad: string[];
}

/** Encode a CAR: `roots`, then `blocks` in map order. Every CID must be a DASL CID. */
export function encodeCar(roots: string[], blocks: Map<string, Uint8Array>): Uint8Array {
  const header = encodeDrisl({ roots: roots.map((root) => new Link(parseCid(root))), version: 1 });
  const parts: Uint8Array[] = [varint(header.length), header];
  for (const [cid, bytes] of blocks) {
    const name = parseCid(cid).bytes;
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
 * Decode a CAR and check every block against its CID. Throws on a
 * malformed container — a header that is not a DRISL map with
 * `version: 1` and `roots` of DASL CIDs, a truncated section, a section
 * shorter than a CID; a block is never a reason to throw, only to drop.
 */
export async function decodeCar(bytes: Uint8Array): Promise<Car> {
  let at = 0;
  const section = (): Uint8Array => {
    const [length, next] = readVarint(bytes, at);
    if (next + length > bytes.length) throw new Error("truncated CAR");
    at = next + length;
    return bytes.subarray(next, at);
  };
  const header = section();
  if (header.length === 0) throw new Error("CAR header is empty");
  const roots = decodeHeader(header);
  const blocks = new Map<string, Uint8Array>();
  const bad: string[] = [];
  while (at < bytes.length) {
    const block = section();
    if (block.length < CID_LENGTH) throw new Error("CAR block shorter than a CID");
    const name = block.subarray(0, CID_LENGTH);
    const data = block.subarray(CID_LENGTH);
    let cid;
    try {
      cid = cidFromBytes(name);
    } catch {
      bad.push(`b${base32Encode(name)}`);
      continue;
    }
    if (blocks.has(cid.text)) continue;
    try {
      await checkCid(cid, data);
      blocks.set(cid.text, data);
    } catch {
      bad.push(cid.text);
    }
  }
  return { roots, blocks, bad };
}

function decodeHeader(bytes: Uint8Array): string[] {
  let doc: Drisl;
  try {
    doc = decodeDrisl(bytes);
  } catch (err) {
    throw new Error(`CAR header is not DRISL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc) || doc instanceof Uint8Array || doc instanceof Link) {
    throw new Error("CAR header is not a map");
  }
  if (doc["version"] !== 1) throw new Error(`CAR version ${String(doc["version"])} is not 1`);
  const roots = doc["roots"];
  if (!Array.isArray(roots) || !roots.every((root) => root instanceof Link)) throw new Error("CAR header roots are not CIDs");
  return roots.map((root) => root.cid.text);
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
  for (let i = 0; i < 8; i++) {
    if (at >= bytes.length) throw new Error("truncated CAR");
    const b = bytes[at++] as number;
    n += (b & 0x7f) * shift;
    if (b < 0x80) return [n, at];
    shift *= 128;
  }
  throw new Error("CAR length too long");
}
