/**
 * CARv1 (https://ipld.io/specs/transport/car/carv1/): a header naming the
 * roots, then blocks — each a CID and its bytes, length-prefixed. This is
 * how a tree's closure travels as one file. The container is `@ipld/car`'s
 * to write and to parse. It checks neither a block against its CID nor
 * that a section is long enough for the CID it opens with, so reading
 * goes by its index of where each block lies, and both are checked here.
 */

import * as CarBufferWriter from "@ipld/car/buffer-writer";
import { CarIndexer } from "@ipld/car/indexer";
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
  const named = { roots: roots.map((root) => CID.parse(root)) };
  const sections = [...blocks].map(([cid, bytes]) => ({ cid: CID.parse(cid), bytes }));
  const length = sections.reduce((total, block) => total + CarBufferWriter.blockLength(block), CarBufferWriter.headerLength(named));
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(length), named);
  for (const block of sections) writer.write(block);
  return writer.close();
}

/**
 * Decode a CAR and check every block against its CID: a block whose bytes
 * do not hash to its name is not kept but listed in `bad`, so the caller
 * trusts every byte in `blocks`. A later block under a CID already seen
 * is ignored. Throws on a malformed container (a bad header, a section
 * that ends before its CID or past the file, a version other than 1).
 */
export async function decodeCar(bytes: Uint8Array): Promise<Car> {
  const index = await CarIndexer.fromBytes(bytes);
  if (index.version !== 1) throw new Error(`CAR version ${index.version} is not 1`);
  const blocks = new Map<string, Uint8Array>();
  const bad: string[] = [];
  for await (const { cid, blockOffset, blockLength } of index) {
    const end = blockOffset + blockLength;
    if (!Number.isSafeInteger(end) || blockLength < 0 || end > bytes.length) {
      throw new Error("a CAR section does not hold its CID and its block");
    }
    const name = cid.toString();
    if (blocks.has(name)) continue;
    const data = bytes.subarray(blockOffset, end);
    try {
      await checkCid(cid, data);
      blocks.set(name, data);
    } catch {
      bad.push(name);
    }
  }
  return { roots: (await index.getRoots()).map((root) => root.toString()), blocks, bad };
}

/**
 * The name of a blob — any bytes — in a blob store: a
 * sha-256 multihash, multibase base32 lower (`b…`, 56 characters).
 */
export async function blobHash(bytes: Uint8Array): Promise<string> {
  return base32.encode((await sha256.digest(bytes)).bytes);
}

/** Does this string have the shape of a blob name? (The hash itself is checked against bytes.) */
export function isBlobHash(name: string): boolean {
  return /^b[a-z2-7]{55}$/.test(name);
}
