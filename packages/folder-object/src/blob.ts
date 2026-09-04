/**
 * The name of a blob — any bytes — as `docs/blob-store.md` names them: a
 * sha-256 multihash (`0x12 0x20 ‖ digest`), multibase base32 lower
 * (`b…`, 56 characters). Not a CID: a CID names a block inside a tree; a
 * blob name names bytes outside one — a package as uploaded — and the
 * two are never confused.
 */

import { base32Encode } from "@estoc/dasl";

export async function blobHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  const multihash = new Uint8Array(2 + digest.length);
  multihash.set([0x12, 0x20]);
  multihash.set(digest, 2);
  return `b${base32Encode(multihash)}`;
}

/** Does this string have the shape of a blob name? (The hash itself is checked against bytes.) */
export function isBlobHash(name: string): boolean {
  return /^b[a-z2-7]{55}$/.test(name);
}
