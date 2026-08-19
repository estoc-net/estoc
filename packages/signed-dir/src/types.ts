/**
 * Shared shapes for the signed-directory trust layer.
 *
 * The contract (research note 2026-08-18-signed-directory-relay.md §5.1):
 * a reader who holds (object set, recursive hash, signed root card) can
 * trust a whole tree without understanding its contents. This package
 * computes and checks those three pieces; reading files, storing objects,
 * and deciding policy (expiry, id ordering) belong to callers.
 */

/**
 * A flat snapshot of a directory: `/`-separated relative path → bytes.
 * The same shape agent-core's `snapshotVault` produces. Empty directories
 * cannot be represented and do not exist (as in git).
 */
export type TreeFiles = Record<string, Uint8Array>;

/**
 * One row of a directory node. `hash` is a CID string: raw codec for
 * files (sha-256 of the bare bytes), dag-json codec for subdirectories.
 * `size` is the byte length for a file, and the recursive total of
 * contained file bytes for a directory.
 */
export interface DirEntry {
  name: string;
  type: "file" | "dir";
  hash: string;
  size: number;
}

/** The result of hashing a tree. No file bytes are held — see `files`. */
export interface HashedTree {
  /** CID of the root directory node — the root card's `root` field. */
  root: string;
  /** Directory objects this hash run produced: CID → dag-json bytes. */
  nodes: Map<string, Uint8Array>;
  /**
   * File objects: CID → path in the input snapshot. Bytes are not
   * copied; look them up in the input by path. When several paths hold
   * identical bytes they share one CID and one (arbitrary) path here —
   * any of them yields the same bytes.
   */
  files: Map<string, string>;
}

/**
 * The one signed statement in the system. Signing only the root would
 * allow rollback replay and cross-DID reuse, so the card binds owner,
 * version, and lifetime to the tree hash.
 */
export interface RootCard {
  /** The owner. Resolving this DID yields the verification key. */
  did: string;
  /**
   * uuidv7 — lexicographic order is issue order, so "newer card" is a
   * string comparison and no counter state exists anywhere.
   */
  id: string;
  /** ISO 8601 instant after which the card is stale (the DNS-TTL analogue). */
  expires: string;
  /** CID of the root directory node. */
  root: string;
}

/**
 * Anything that can produce a raw Ed25519 signature (64 bytes) over
 * given bytes. Structurally compatible with @estoc/keystore's `Signer`
 * without depending on it — a WebCrypto non-extractable key or a
 * hardware wallet fits the same contract.
 */
export interface CardSigner {
  sign(data: Uint8Array): Promise<Uint8Array>;
}
