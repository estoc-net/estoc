/**
 * Names a vault holds (event-store.md §5.1): DASL CIDs — CIDv1, sha-256,
 * codec `raw` or `drisl`, base32 lower, one canonical spelling. Anything
 * else — a dag-pb CID, a CIDv0, another base, another hash — is not a
 * name a vault holds. The parser is `@estoc/dasl`'s, the one every
 * layer shares.
 */

import { cidOf, parseCid as parseDaslCid, type DaslCid } from "@estoc/dasl";

/** multicodec `raw` (0x55): bare bytes — a file, whatever its size. `drisl` (0x71): one canonical DRISL document. */
export { RAW_CODE, DRISL_CODE, type DaslCid } from "@estoc/dasl";

/** The CID `name` is, if it is a DASL CID in its canonical string form; null otherwise. */
export function parseCid(name: string): DaslCid | null {
  try {
    return parseDaslCid(name);
  } catch {
    return null;
  }
}

export function isCid(name: unknown): name is string {
  return typeof name === "string" && parseCid(name) !== null;
}

/** The name of `bytes` under `code` (`RAW_CODE` or `DRISL_CODE`). */
export async function nameOf(code: number, bytes: Uint8Array): Promise<string> {
  return (await cidOf(code, bytes)).text;
}
