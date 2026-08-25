/**
 * Shared shapes of @estoc/folder-object.
 *
 * Three layers, one package: the UnixFS tree (a fact hashed into a merkle
 * DAG), the object (a tree with an `index.json` that says what it is),
 * and the card (a DID standing behind an object). The card is the one
 * signature in the system and it means one thing — "this DID stands
 * behind this object, as the object's own format defines it". Every other
 * intent lives elsewhere: who *sent* it is the transport envelope's
 * business, and endorsing, replying or quoting is a new object that
 * refers to this one.
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
  /** CID of the root directory node (dag-pb) — the card's `root`. */
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

/** The structural members of index.json (spec §3.1); vocabulary members ride along untyped. */
export interface IndexJson {
  format: string;
  id: string;
  content?: { mediaType: string; path: string } | { mediaType: string; text: string };
  [member: string]: unknown;
}

/** An object: its index plus its canonical tree (`index.json` + `files/…`). */
export interface FolderObject {
  meta: IndexJson;
  /** The canonical tree, exactly the paths that enter the root hash. */
  tree: TreeFiles;
}

/**
 * The payload of the card: "this DID stands behind this tree". Testimony
 * about a fact, not a pointer to one — no issue order, no expiry, no
 * takedown form. Which tree is someone's *current* version is the
 * tree's own business (`index.json`'s `id` and `updated`), never the
 * signature's.
 */
export interface ObjectCard {
  /** The signer: a did:key; its one verification method is the JWS `kid`. */
  did: string;
  /** UnixFS root CID of the object's canonical tree. */
  root: string;
}

/**
 * Anything that can produce a raw Ed25519 signature (64 bytes) over
 * given bytes and say which did:key it is. Structurally what
 * @estoc/keystore's identity `signer` is — a WebCrypto non-extractable
 * key or a hardware wallet fits the same contract.
 */
export interface CardSigner {
  did(): string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** A signed object: the object and the card that stands behind it (spec §5). */
export interface SignedObject {
  object: FolderObject;
  /** compact JWS, the contents of `card.jws` */
  card: string;
}

/** Which layer rejected the tree (spec §8). */
export type MalformedLayer = "format" | "closure";

export class MalformedObjectError extends Error {
  constructor(
    public readonly layer: MalformedLayer,
    message: string,
  ) {
    super(`malformed object (${layer} layer): ${message}`);
    this.name = "MalformedObjectError";
  }
}
