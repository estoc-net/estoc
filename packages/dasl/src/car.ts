/**
 * DASL CAR (https://dasl.ing/car.html): CARv1 over DASL CIDs. A header —
 * a length-prefixed DRISL map with `version: 1`, `roots` (an array of
 * CIDs) and whatever other metadata the writer put there — then blocks,
 * each a length-prefixed `CID ‖ data` where the CID is exactly the 36
 * bytes of a DASL CID. This is how a set of blocks travels as one file.
 *
 * `@ipld/car` writes the container. It does not read it here: its reader
 * refuses a header with any member beyond `version` and `roots`, decodes
 * the header into an object whose `__proto__` entry becomes a prototype
 * rather than a key, and takes a block's CID by the CID's own structure,
 * past the end of the section if need be and re-encoded, so a name that
 * is not the 36 bytes of a DASL CID can come back as one. Reading is the
 * profile's own definition instead: multiformats' varint for every
 * length, the DRISL codec for the header, the first 36 bytes of a block
 * for its name.
 */

import * as CarBufferWriter from "@ipld/car/buffer-writer";
import { CID } from "multiformats/cid";
import { varint } from "multiformats";

import { base32Encode, checkCid, CID_LENGTH, cidFromBytes, parseCid } from "./cid.js";
import { decodeDrisl, Float, Link, type Drisl } from "./drisl.js";

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
  const named = { roots: roots.map((root) => CID.decode(parseCid(root).bytes)) };
  const sections = [...blocks].map(([cid, bytes]) => ({ cid: CID.decode(parseCid(cid).bytes), bytes }));
  const length = sections.reduce((total, block) => total + CarBufferWriter.blockLength(block), CarBufferWriter.headerLength(named));
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(length), named);
  for (const block of sections) writer.write(block);
  return writer.close();
}

/**
 * Decode a CAR and check every block against its CID. Throws on a
 * malformed container — a header that is not a DRISL map with the integer
 * `version: 1` and `roots` of DASL CIDs, a length that is not a minimal
 * varint, a truncated section, a section shorter than a CID; a block is
 * never a reason to throw, only to drop.
 */
export async function decodeCar(bytes: Uint8Array): Promise<Car> {
  let at = 0;
  const section = (): Uint8Array => {
    const [length, prefix] = varint.decode(bytes, at);
    const start = at + prefix;
    if (start + length > bytes.length) throw new Error("truncated CAR");
    at = start + length;
    return bytes.subarray(start, at);
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
  if (typeof doc !== "object" || doc === null || Array.isArray(doc) || doc instanceof Uint8Array || doc instanceof Link || doc instanceof Float) {
    throw new Error("CAR header is not a map");
  }
  // the integer 1: the float 1.0 decodes as a Float and is refused here
  if (doc["version"] !== 1) throw new Error(`CAR version ${String(doc["version"])} is not 1`);
  const roots = doc["roots"];
  if (!Array.isArray(roots) || !roots.every((root) => root instanceof Link)) throw new Error("CAR header roots are not CIDs");
  return roots.map((root) => root.cid.text);
}
