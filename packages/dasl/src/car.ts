/**
 * DASL CAR (https://dasl.ing/car.html): CARv1 over DASL CIDs. A header
 * — a length-prefixed DRISL map with `version: 1` and `roots`, an array
 * of CIDs — then blocks, each a length-prefixed `CID ‖ data` where the
 * CID is exactly the 36 bytes of a DASL CID. This is how a set of blocks
 * travels as one file.
 *
 * The container is `@ipld/car`'s to write and to parse. The DASL profile
 * over it is checked here: every root and every block's name must be a
 * DASL CID, and every block must hash to its name, or the caller could
 * not trust the bytes in `blocks`. The library reads a block's CID by the
 * CID's own structure, not by the length the section declares, so that a
 * section holds the CID it opens with and its block is checked here too.
 */

import * as CarBufferWriter from "@ipld/car/buffer-writer";
import { CarIndexer } from "@ipld/car/indexer";
import { CID } from "multiformats/cid";

import { base32Encode, checkCid, cidFromBytes, parseCid, type DaslCid } from "./cid.js";

/** A CAR read back: what the header named, every block whose bytes match its CID, and what was dropped. */
export interface Car {
  roots: string[];
  /** CID → bytes, in file order; a block that does not hash to its CID is left out, a later block under a CID already seen is ignored */
  blocks: Map<string, Uint8Array>;
  /**
   * The names of blocks dropped: a CID whose data does not hash to it, or
   * — spelled `b` + base32 of its bytes, which no DASL CID shares —
   * a block named by a CID that is not a DASL CID.
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
 * malformed container — a header the library refuses, a version other
 * than 1, a root that is not a DASL CID, a section that ends before its
 * CID or past the file; a block is never a reason to throw, only to drop.
 */
export async function decodeCar(bytes: Uint8Array): Promise<Car> {
  const index = await CarIndexer.fromBytes(bytes);
  if (index.version !== 1) throw new Error(`CAR version ${index.version} is not 1`);
  const roots = (await index.getRoots()).map((root) => daslRoot(root).text);
  const blocks = new Map<string, Uint8Array>();
  const bad: string[] = [];
  for await (const { cid, blockOffset, blockLength } of index) {
    const end = blockOffset + blockLength;
    if (!Number.isSafeInteger(end) || blockLength < 0 || end > bytes.length) {
      throw new Error("a CAR section does not hold its CID and its block");
    }
    let name: DaslCid;
    try {
      name = cidFromBytes(cid.bytes);
    } catch {
      bad.push(`b${base32Encode(cid.bytes)}`);
      continue;
    }
    if (blocks.has(name.text)) continue;
    const data = bytes.subarray(blockOffset, end);
    try {
      await checkCid(name, data);
      blocks.set(name.text, data);
    } catch {
      bad.push(name.text);
    }
  }
  return { roots, blocks, bad };
}

function daslRoot(root: CID): DaslCid {
  try {
    return cidFromBytes(root.bytes);
  } catch (err) {
    throw new Error(`CAR header roots are not DASL CIDs: ${err instanceof Error ? err.message : String(err)}`);
  }
}
