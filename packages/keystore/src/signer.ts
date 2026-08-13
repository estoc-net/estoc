import {
  ed25519,
  x25519,
  edwardsToMontgomeryPriv,
  edwardsToMontgomeryPub,
} from "@noble/curves/ed25519";
import { didKeyFromPublicKey } from "./did-key.js";
import type { DidKeySigner } from "./types.js";

/**
 * Wrap a raw Ed25519 private key (the 32-byte RFC 8032 seed) in a
 * DidKeySigner. The private key lives only in this closure; nothing on the
 * returned object exposes it.
 */
export function didKeySignerFromPrivateKey(privateKey: Uint8Array): DidKeySigner {
  if (privateKey.length !== 32) {
    throw new Error(`Ed25519 private key must be 32 bytes, got ${privateKey.length}`);
  }
  const publicKey = ed25519.getPublicKey(privateKey);
  const did = didKeyFromPublicKey(publicKey);
  const xPrivateKey = edwardsToMontgomeryPriv(privateKey);
  const xPublicKey = edwardsToMontgomeryPub(publicKey);

  return {
    did: () => did,
    publicKey: () => publicKey.slice(),
    sign: async (data) => ed25519.sign(data, privateKey),
    x25519PublicKey: () => xPublicKey.slice(),
    deriveSharedSecret: async (theirX25519PublicKey) =>
      x25519.getSharedSecret(xPrivateKey, theirX25519PublicKey),
  };
}

/** A fresh random Ed25519 private key (32 bytes). */
export function generatePrivateKey(): Uint8Array {
  return ed25519.utils.randomPrivateKey();
}
