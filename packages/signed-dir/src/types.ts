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
 * The same shape agent-core's `snapshotVault` produces. Directories are
 * implied by the paths; an empty directory has no path here, so it is
 * declared through `HashOptions.dirs` instead.
 */
export type TreeFiles = Record<string, Uint8Array>;

/** Options for `hashTree`. */
export interface HashOptions {
  /**
   * Directories to create whether or not any file lives under them —
   * the way to put an empty directory into the tree. Ancestors are
   * created too; listing a directory that files already imply is a
   * no-op; naming a path that is also a file is a conflict.
   */
  dirs?: Iterable<string>;
}

/** The result of verifying a tree: every path the root reaches. */
export interface VerifiedTree {
  /**
   * File path → the file's root CID (raw for a single-block file,
   * dag-pb for a chunked one).
   */
  files: Map<string, string>;
  /**
   * Directory path → its dag-pb CID, the root included under `""`. An
   * empty directory shows up only here.
   */
  dirs: Map<string, string>;
}

/** The result of hashing a tree (UnixFS, profile unixfs-v1-2025). */
export interface HashedTree {
  /** CID of the root directory node (dag-pb) — the root card's `root` field. */
  root: string;
  /**
   * Every block this hash run produced except single-block file roots:
   * directory nodes, HAMT shards, big-file roots, and raw leaf chunks.
   * CID → bytes.
   */
  nodes: Map<string, Uint8Array>;
  /**
   * The file listing: file root CID → path in the input snapshot. For a
   * single-block file (≤ 1 MiB) the CID is raw and the bytes are the
   * input bytes at that path — they are not copied into `nodes`. For a
   * chunked file the CID is dag-pb and its blocks are all in `nodes`.
   * The complete object set is therefore `nodes` plus the input bytes of
   * every `files` entry whose CID `nodes` does not already hold. When
   * several paths hold identical bytes they share one CID and one
   * (arbitrary) path here — any of them yields the same bytes.
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
  /**
   * CID of the root directory node, or null for a takedown card: the
   * owner's assertion "I publish nothing". Null is the only encoding —
   * a card *missing* the field is malformed. A takedown is destructive,
   * so it must be written deliberately, never minted by a producer bug
   * that drops a field (RFC 7386's null-means-removal idiom).
   */
  root: string | null;
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
