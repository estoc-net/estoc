/**
 * The peer key (vault-events.md §3): the fingerprint of a public key we
 * only ever see — `base32lower(sha256(multicodec-prefixed raw public
 * key))[0:26]`, the hash of the bytes a `did:key` of that key encodes.
 */

import { sha256 } from "@noble/hashes/sha2";
import { base32nopad } from "@scure/base";
import bs58 from "bs58";

import { PEER_KEY } from "./types.js";

const LENGTH = 26;

/** The fingerprint of a multicodec-prefixed public key. */
export function fingerprint(prefixedKey: Uint8Array): string {
  return base32nopad.encode(sha256(prefixedKey)).toLowerCase().slice(0, LENGTH);
}

/**
 * The peer key of a public key given as a `did:key` (`did:key:z6LS…`) or
 * as the multibase a document lists (`z6LS…`, `publicKeyMultibase`):
 * the same key fingerprints the same either way. Throws on anything but
 * base58btc multibase.
 */
export function peerKeyOf(key: string): string {
  const multibase = key.startsWith("did:key:") ? key.slice("did:key:".length) : key;
  if (!multibase.startsWith("z") || multibase.length < 2) {
    throw new Error(`not a base58btc multibase key: ${key}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(multibase.slice(1));
  } catch {
    throw new Error(`not a base58btc multibase key: ${key}`);
  }
  return fingerprint(bytes);
}

/** Whether `value` has the shape of a peer key; says nothing about whose. */
export function isPeerKey(value: unknown): value is string {
  return typeof value === "string" && PEER_KEY.test(value);
}
