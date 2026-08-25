/**
 * CID helpers for the UnixFS experiment (IPIP-499, profile unixfs-v1-2025).
 *
 * File object  = for a single-block file (≤ 1 MiB): the bare bytes, named
 *                by a CIDv1 with the raw codec and sha-256 — byte-for-byte
 *                the same CID the dag-json branch computed. A larger file
 *                roots in a dag-pb node linking raw 1 MiB chunks.
 * Dir object   = dag-pb bytes whose UnixFS Data field says `directory`
 *                (or `hamt-sharded-directory` past the 256 KiB threshold).
 *
 * Unlike the dag-json encoding, the codec bits alone no longer separate
 * the kinds: a dag-pb CID can root either a multi-block file or a
 * directory. Telling them apart means decoding the UnixFS Data field —
 * which is why tree.ts leans on ipfs-unixfs-exporter instead of a
 * hand-rolled decoder.
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";

/** multicodec code for dag-pb — UnixFS's carrier format. */
export const dagPbCode = 0x70;

/** CID string (raw codec, sha-256) naming these bare bytes. */
export async function fileCid(bytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(bytes);
  return CID.create(1, raw.code, digest).toString();
}

/** Does this CID name bare bytes (a leaf chunk or single-block file)? */
export function isRawCid(cid: string): boolean {
  return CID.parse(cid).code === raw.code;
}

/** Does this CID name a dag-pb node (directory, shard, or big-file root)? */
export function isDagPbCid(cid: string): boolean {
  return CID.parse(cid).code === dagPbCode;
}

/**
 * Compare names as UTF-8 byte sequences — the sort order of directory
 * entries. (Plain JS string comparison is UTF-16 code-unit order, which
 * disagrees beyond the BMP.)
 */
export function compareNames(a: string, b: string): number {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ab[i] as number) - (bb[i] as number);
    if (d !== 0) return d;
  }
  return ab.length - bb.length;
}

/** Throw unless `bytes` hash to `cid` (sha-256 only — the profile's hash). */
export async function checkCid(cid: CID, bytes: Uint8Array): Promise<void> {
  if (cid.multihash.code !== sha256.code) {
    throw new Error(`unsupported multihash in ${cid.toString()}`);
  }
  const digest = await sha256.digest(bytes);
  if (!CID.create(cid.version, cid.code, digest).equals(cid)) {
    throw new Error(`object bytes do not hash to ${cid.toString()}`);
  }
}
