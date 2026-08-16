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
 * A did:key signer additionally does X25519 key agreement, because the
 * did:key convention derives an X25519 keyAgreement key from the Ed25519
 * key and DIDComm decryption needs the private ECDH operation.
 *
 * Kept as a separate capability from `sign` on purpose: hardware devices
 * commonly support Ed25519 signing but not X25519 ECDH, so a future
 * hardware-backed Signer may implement only the base interface.
 */
export interface DidKeySigner extends Signer {
  /** X25519 public key (32 bytes) derived from the Ed25519 key. */
  x25519PublicKey(): Uint8Array;
  /**
   * X25519 shared secret (32 bytes) with the other party's X25519 public
   * key. The caller is responsible for running the result through a KDF.
   */
  deriveSharedSecret(theirX25519PublicKey: Uint8Array): Promise<Uint8Array>;
}

/** One key in the store. Only `privateKeyJwe` is secret. */
export interface KeyEntry {
  /** Local, store-unique label. Never leaves the machine. */
  name: string;
  /** did:key of the public half — public information, kept in cleartext so listing needs no passphrase. */
  did: string;
  /** ISO 8601 creation time. */
  createdAt: string;
  /**
   * The private key as an OKP Ed25519 JWK (RFC 8037), serialized and
   * encrypted as a compact JWE with PBES2-HS512+A256KW / A256GCM.
   */
  privateKeyJwe: string;
}

/** The v1 store — independently sealed keys. The JSON document an application persists wherever it likes. */
export interface KeystoreDocument {
  version: 1;
  keys: KeyEntry[];
}

/** One derived key in a v2 store. Nothing here is secret: the private material lives in the seed. */
export interface DerivedKeyEntry {
  /** Local, store-unique label. Never leaves the machine. */
  name: string;
  /** HKDF derivation index — with the seed, everything about this key follows from it. */
  index: number;
  /** did:key of the Ed25519 half, cached so listing needs no unlock. */
  did: string;
  /** ISO 8601 creation time. */
  createdAt: string;
}

/**
 * The v2 store — one sealed seed, every key derived from it. Unlock once,
 * keep the SeedKey, derive forever; the seed is the only thing that cannot
 * be regenerated.
 */
export interface SeedKeystoreDocument {
  version: 2;
  /** The 32-byte seed as a compact JWE (PBES2-HS512+A256KW / A256GCM). */
  seedJwe: string;
  /** Next unused derivation index. Only ever grows; removed keys do not free theirs. */
  nextIndex: number;
  keys: DerivedKeyEntry[];
}

/** What `listKeys` reveals without a passphrase (both store versions). */
export interface KeyInfo {
  name: string;
  did: string;
  createdAt: string;
}
