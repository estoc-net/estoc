/**
 * Shared shapes of @estoc/folder-object.
 *
 * Three layers, one package: the tree (a fact hashed into a manifest and
 * its raw leaves — `tree.ts`), the object (a tree with an `index.json`
 * that says what it is), and the card (a DID standing behind an object).
 * The card is the one signature in the system and it means one thing —
 * "this DID stands behind this object, as the object's own format
 * defines it". Every other intent lives elsewhere: who *sent* it is the
 * transport envelope's business, and endorsing, replying or quoting is
 * a new object that refers to this one.
 */

/**
 * A flat snapshot of a directory: `/`-separated relative path → bytes.
 * The same shape agent-core's `snapshotVault` produces. Directories are
 * implied by the paths; an empty directory has no path here and is not
 * a thing a tree can hold (spec §1).
 */
export type TreeFiles = Record<string, Uint8Array>;

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
 * The payload of the card: "this DID stands behind this tree". Which
 * tree is someone's *current* version is the tree's own business
 * (`index.json`'s `id` and `updated`), never the card's.
 */
export interface ObjectCard {
  /** The signer: a did:key; its one verification method is the JWS `kid`. */
  did: string;
  /** The manifest CID of the object's canonical tree (spec §2.1): a drisl DASL CID in canonical spelling. */
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
