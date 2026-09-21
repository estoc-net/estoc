/**
 * A handle that can sign but never yields the private key — the same
 * contract as a WebCrypto non-extractable key or a hardware wallet.
 * Anything that hands out Signers (this package's JSON store today, a
 * hardware device tomorrow) is interchangeable to callers.
 */
export interface Signer {
  /** did:key identifier of this key's Ed25519 public half. */
  did(): string;
  /** Raw Ed25519 public key (32 bytes). */
  publicKey(): Uint8Array;
  /** Ed25519 signature (64 bytes) over the given bytes. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/**
 * A did:key signer additionally does X25519 key agreement, because
 * DIDComm decryption needs the private ECDH operation. The X25519 key is
 * its own key, not the one the did:key convention would convert from the
 * Ed25519 key, so whoever publishes the DID publishes it alongside.
 *
 * Kept as a separate capability from `sign` on purpose: hardware devices
 * commonly support Ed25519 signing but not X25519 ECDH, so a future
 * hardware-backed Signer may implement only the base interface.
 */
export interface DidKeySigner extends Signer {
  /** X25519 public key (32 bytes). */
  x25519PublicKey(): Uint8Array;
  /**
   * X25519 shared secret (32 bytes) with the other party's X25519 public
   * key. The caller is responsible for running the result through a KDF.
   */
  deriveSharedSecret(theirX25519PublicKey: Uint8Array): Promise<Uint8Array>;
}

/**
 * The store: one sealed seed, every key derived from it by name. Unlock
 * once, keep the SeedKey, derive forever; the seed is the only thing that
 * cannot be regenerated, and which names are in use is for whoever holds
 * the store to record.
 */
export interface SeedKeystoreDocument {
  version: 3;
  /** The 32-byte seed as a compact JWE (PBES2-HS512+A256KW / A256GCM). */
  seedJwe: string;
}
