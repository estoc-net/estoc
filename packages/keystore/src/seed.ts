import { ed25519, x25519 } from "@noble/curves/ed25519";
import { base64url } from "jose";
import { didKeyFromPublicKey } from "./did-key.js";
import type { DidKeySigner } from "./types.js";

/**
 * A 32-byte master seed imported into WebCrypto as a non-extractable HKDF
 * key. It can derive but never be read back, and it survives structured
 * cloning — an application can keep it in IndexedDB and derive every key
 * without asking for the passphrase again.
 */
export type SeedKey = CryptoKey;

export const SEED_LENGTH = 32;

/** HKDF salt — fixed and public; domain-separates this scheme from any other use of the same seed. */
const HKDF_SALT = new TextEncoder().encode("estoc-keystore");

/** A fresh random 32-byte seed. */
export function generateSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SEED_LENGTH));
}

/**
 * Import raw seed bytes as a non-extractable HKDF key. The caller should
 * drop its copy of the bytes afterwards; the returned key is all that is
 * needed from here on.
 */
export async function importSeed(seed: Uint8Array): Promise<SeedKey> {
  if (seed.length !== SEED_LENGTH) {
    throw new Error(`seed must be ${SEED_LENGTH} bytes, got ${seed.length}`);
  }
  return crypto.subtle.importKey("raw", seed as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
}

/**
 * Key names are derivation paths: `[A-Za-z0-9._/-]+`. The same seed and the
 * same name always give the same key, so a name is never renamed and never
 * reused for a different key.
 */
export const KEY_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

export function isValidKeyName(name: string): boolean {
  return KEY_NAME_PATTERN.test(name);
}

function assertKeyName(name: string): void {
  if (typeof name !== "string" || !isValidKeyName(name)) {
    throw new Error(`invalid key name ${JSON.stringify(name)}: must match [A-Za-z0-9._/-]+`);
  }
}

/**
 * The HKDF info label for one half of one identity. `estoc/v3` names this
 * derivation scheme (and the document version that carries it); changing
 * either silently renames every DID, so it moves only with a new version.
 */
function info(name: string, purpose: "ed25519" | "x25519"): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`estoc/v3/${purpose}/${name}`);
}

async function deriveBits32(seedKey: SeedKey, name: string, purpose: "ed25519" | "x25519"): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: info(name, purpose) },
    seedKey,
    256,
  );
  return new Uint8Array(bits);
}

/** One identity derived from the seed under a name. */
export interface DerivedIdentity {
  /** The derivation path this identity was derived under. */
  name: string;
  /** did:key of the Ed25519 half — the identity's canonical name. */
  did: string;
  /**
   * Signing and X25519 key agreement with the private material closed over.
   * Note the X25519 key is derived independently of the Ed25519 key (not by
   * the did:key Ed→X conversion), so publish it explicitly (did:peer,
   * did:web) rather than relying on did:key resolution for keyAgreement.
   */
  signer: DidKeySigner;
  /**
   * Escape hatch: the private keys as OKP JWKs (RFC 8037), for libraries
   * that run their own crypto and cannot call a Signer (didcomm-rust's
   * secrets resolver, for one). Prefer `signer` wherever it suffices; each
   * call returns fresh copies.
   */
  privateJwks(): { ed25519: JsonWebKey; x25519: JsonWebKey };
}

/**
 * Derive the identity named `name`. Deterministic: the same seed and name
 * always yield the same keys, so a seed plus the names in use rebuilds
 * every identity — no table required.
 */
export async function deriveIdentity(seedKey: SeedKey, name: string): Promise<DerivedIdentity> {
  assertKeyName(name);
  const [edPriv, xPriv] = await Promise.all([
    deriveBits32(seedKey, name, "ed25519"),
    deriveBits32(seedKey, name, "x25519"),
  ]);
  const edPub = ed25519.getPublicKey(edPriv);
  const xPub = x25519.getPublicKey(xPriv);
  const did = didKeyFromPublicKey(edPub);

  return {
    name,
    did,
    signer: {
      did: () => did,
      publicKey: () => edPub.slice(),
      sign: async (data) => ed25519.sign(data, edPriv),
      x25519PublicKey: () => xPub.slice(),
      deriveSharedSecret: async (theirs) => x25519.getSharedSecret(xPriv, theirs),
    },
    privateJwks: () => ({
      ed25519: {
        kty: "OKP",
        crv: "Ed25519",
        x: base64url.encode(edPub),
        d: base64url.encode(edPriv),
      },
      x25519: {
        kty: "OKP",
        crv: "X25519",
        x: base64url.encode(xPub),
        d: base64url.encode(xPriv),
      },
    }),
  };
}
