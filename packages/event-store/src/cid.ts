/**
 * Names of the `unixfs-v1-2025` profile (event-store.md §5.1): CIDv1,
 * sha-256, codec `raw` or `dag-pb`, base32 lower. Anything else is not a
 * name a vault holds.
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/** multicodec `raw`: bare bytes, at most 1 MiB. */
export const RAW_CODE = 0x55;
/** multicodec `dag-pb`: a UnixFS node. */
export const DAG_PB_CODE = 0x70;

/** The CID `name` is, if it is a profile name in its canonical string form; null otherwise. */
export function parseCid(name: string): CID | null {
  let cid: CID;
  try {
    cid = CID.parse(name);
  } catch {
    return null;
  }
  if (
    cid.version !== 1 ||
    cid.multihash.code !== sha256.code ||
    (cid.code !== RAW_CODE && cid.code !== DAG_PB_CODE) ||
    cid.toString() !== name
  ) {
    return null;
  }
  return cid;
}

export function isCid(name: unknown): name is string {
  return typeof name === "string" && parseCid(name) !== null;
}

/** The profile name of `bytes` under `code` (`RAW_CODE` or `DAG_PB_CODE`). */
export async function nameOf(code: number, bytes: Uint8Array): Promise<string> {
  return CID.create(1, code, await sha256.digest(bytes)).toString();
}
