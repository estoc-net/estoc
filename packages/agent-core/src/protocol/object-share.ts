import {
  blobHash,
  decodeCar,
  encodeCar,
  hashTree,
  isBlobHash,
  isDagPbCid,
  isInsideFiles,
  MalformedObjectError,
  parseIndex,
  resolvePath,
  verifyCard,
  verifyTree,
  type FolderObject,
  type GetBlock,
  type ObjectCard,
  type TreeFiles,
  type VerifiedTree,
} from "@estoc/folder-object";

import type { PlainMessage } from "../records.js";
import { AES256_GCM_HKDF_1MB, decryptStream } from "./streaming-aead.js";

/**
 * object-share/1.0 (`docs/object-share.md`): hand a contact a whole
 * object — a folder-object hashed into a UnixFS tree. One message
 * carries the root in the body and blocks as attachments named by their
 * CID: always the tree's **skeleton** (every dag-pb block) and
 * `index.json`, and every leaf when the whole closure fits. When it does
 * not, the leaves go by the other road: the whole closure as one
 * encrypted CAR at a URL — a **package** (§8) — named in the share with
 * its hash and key, fetched by the receiver whenever it likes. Nothing
 * is asked back over DIDComm; a package that is gone leaves a partial
 * object whose files are all named and sized by the skeleton.
 *
 * What is shared is an object — a tree that declares what it is
 * (`index.json`); a well-hashed tree that is not one does not verify,
 * however good its hashes. A share may carry a card, and then it is a
 * signed object: the card is testimony about the object, not about the
 * message. Its `did` is whoever signed — the sender's own anchor for
 * something they stand behind, or the original author's when the sender
 * passes a signed object on. The envelope proves who sent; the card,
 * when there is one, proves who stands behind the object. Without a
 * card the share says only what the envelope says: this contact handed
 * me this object.
 */
export const OBJECT_SHARE = "https://estoc.dev/object-share/1.0/share";

/** IPLD block media types, as the IPFS ecosystem names them. */
export const DAG_PB_MEDIA_TYPE = "application/vnd.ipld.dag-pb";
export const RAW_MEDIA_TYPE = "application/vnd.ipld.raw";
/** The package's plaintext: a CARv1 of the closure. */
export const CAR_MEDIA_TYPE = "application/vnd.ipld.car";

/** The raw block bytes one share may carry by default: what a mediator queue comfortably holds. */
export const DEFAULT_MAX_SHARE_BYTES = 1024 * 1024;

export interface ObjectShareBody {
  /** CID of the object's root directory node: the name of the tree the attachments make */
  root: string;
  /** compact JWS over `{did, root}` — folder-object's card; present, the share is a signed object */
  card?: string;
  /** the one package (§8): which attachment, how to open it, and how long its store promised to keep it */
  package?: {
    attachment_id: string;
    ciphering: { algorithm: string; parameters: { key: string } };
    /** ISO 8601: the store's retention as the sender was told it — advisory, the bytes may go sooner or later */
    available_until: string;
  };
}

/**
 * The package as a DIDComm linked attachment: `id` and `data.hash` are
 * the ciphertext's own name (sha-256 multihash, base32), `byte_count`
 * its size, `data.links` where it is — exactly one URL (§8); `media_type`
 * says what the plaintext is.
 */
export interface PackageAttachment {
  id: string;
  media_type: typeof CAR_MEDIA_TYPE;
  byte_count: number;
  data: { links: string[]; hash: string };
}

/** A package as a share names it: everything needed to fetch and open it. */
export interface SharePackage {
  hash: string;
  byteCount: number;
  /** the one place the ciphertext is, http(s) with no credentials */
  url: string;
  /** when the store's hold on the bytes was to run out, ISO 8601 — advisory */
  availableUntil: string;
  algorithm: typeof AES256_GCM_HKDF_1MB;
  key: Uint8Array;
}

/**
 * A share that names a package the receiver cannot use: the entry is
 * there but its shape, its attachment, or its algorithm is not what this
 * receiver can open. The share is still what its blocks make it (§7); the
 * problem is reported, not swallowed, so a receiver can tell "no bytes
 * were offered" from "bytes were offered in a way I cannot take".
 */
export interface PackageProblem {
  problem: string;
}

/**
 * One block of the closure as a DIDComm attachment. The `id` is the CID
 * and is the only name the block has: DIDComm's `data.hash` is not used,
 * because it is defined alongside `links`, not `base64`, and
 * didcomm-rust drops it from an inline attachment.
 */
export interface BlockAttachment {
  id: string;
  media_type: string;
  byte_count: number;
  data: { base64: string };
}

/** The closure of a tree: its root, every block the root reaches, and the blocks a share must carry. */
export interface Closure {
  root: string;
  /** every block, CID → bytes */
  blocks: Map<string, Uint8Array>;
  /**
   * The minimal share (`docs/object-share.md` §2): every dag-pb block —
   * the skeleton — plus the blocks of `index.json`. A subset of `blocks`.
   */
  minimal: Map<string, Uint8Array>;
}

/**
 * What a verified share yields: the root, who (if anyone) stands behind
 * it, the tree, the object as far as its bytes are here, and the blocks.
 */
export interface VerifiedShare {
  root: string;
  /** the verified card, or null for an object shared without one */
  card: ObjectCard | null;
  /** the verified tree; `tree.missing` names the leaves not held, `tree.partial` their files */
  tree: VerifiedTree;
  /**
   * The object read out of the tree: `index.json` (always here) and every
   * file under `files/` whose bytes are all here. A partial file is not in
   * `object.tree` at all — it is in `tree.partial`.
   */
  object: FolderObject;
  /** true when no leaf is missing: the object is whole */
  complete: boolean;
  /** the package the share names, when it names one this receiver can fetch and open; null otherwise */
  package: SharePackage | null;
  /** why the named package is unusable, when one is named and `package` is null; null otherwise */
  packageProblem: string | null;
  /**
   * Every block the walk from `root` reached and found — carried by the
   * message, or supplied through `held` — CID → bytes: what a keeper
   * puts in `blobs/`. A block the message carries that the tree does not
   * reach is not here: it is not part of the object.
   */
  blocks: Map<string, Uint8Array>;
}

/**
 * Hash a tree and gather the complete object set: `hashTree`'s `nodes`
 * plus the input bytes of every single-block file (which it
 * deliberately does not copy) — and, apart, the minimal share.
 */
export async function closureOf(files: TreeFiles): Promise<Closure> {
  const hashed = await hashTree(files);
  const blocks = new Map(hashed.nodes);
  for (const [cid, path] of hashed.files) {
    if (!blocks.has(cid)) {
      blocks.set(cid, files[path] as Uint8Array);
    }
  }
  const minimal = new Map<string, Uint8Array>();
  for (const [cid, bytes] of blocks) {
    if (isDagPbCid(cid)) {
      minimal.set(cid, bytes);
    }
  }
  // index.json's blocks: its raw CID, or the chunks of a chunked one —
  // which a walk over the skeleton alone names, as that file's gaps
  const index = [...hashed.files].find(([, path]) => path === "index.json");
  if (index !== undefined) {
    const [cid] = index;
    const chunks = isDagPbCid(cid)
      ? ((await verifyTree(hashed.root, minimal, { leaves: "optional" })).partial.get("index.json") ?? [])
      : [cid];
    for (const chunk of chunks) {
      minimal.set(chunk, blocks.get(chunk) as Uint8Array);
    }
  }
  return { root: hashed.root, blocks, minimal };
}

/** The bytes of a closure, summed. */
export function closureSize(blocks: Map<string, Uint8Array>): number {
  let total = 0;
  for (const bytes of blocks.values()) {
    total += bytes.length;
  }
  return total;
}

/** Blocks as attachments, one each, in CID order so two shares of one tree are alike. */
export function attachmentsOf(blocks: Map<string, Uint8Array>): BlockAttachment[] {
  return [...blocks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cid, bytes]) => ({
      id: cid,
      media_type: isDagPbCid(cid) ? DAG_PB_MEDIA_TYPE : RAW_MEDIA_TYPE,
      byte_count: bytes.length,
      data: { base64: bytesToBase64url(bytes) },
    }));
}

/**
 * The share's `body.package` and its attachment, read out as
 * `SharePackage` when both are there and well-formed under an algorithm
 * we know; null when the share names no package; a `PackageProblem`
 * when it names one that cannot be used (§8). A problem is not an error
 * in the share — the blocks it carries are what they are — but it is
 * not nothing either, and is reported as such.
 */
export function packageOf(msg: PlainMessage): SharePackage | PackageProblem | null {
  const named = (msg.body as Partial<ObjectShareBody>).package;
  if (named === undefined) {
    return null;
  }
  if (named === null || typeof named !== "object") {
    return { problem: "body.package is not an object" };
  }
  const { attachment_id, ciphering, available_until } = named;
  if (typeof attachment_id !== "string") {
    return { problem: "body.package names no attachment" };
  }
  if (typeof ciphering?.algorithm !== "string") {
    return { problem: "body.package names no ciphering algorithm" };
  }
  if (ciphering.algorithm !== AES256_GCM_HKDF_1MB) {
    return { problem: `unsupported ciphering ${ciphering.algorithm}` };
  }
  const keyText = ciphering.parameters?.key;
  let key: Uint8Array | null = null;
  try {
    key = typeof keyText === "string" ? base64urlToBytes(keyText) : null;
  } catch {
    key = null;
  }
  if (key === null || key.length !== 32) {
    return { problem: "the package key is not 32 bytes of base64url" };
  }
  if (typeof available_until !== "string" || Number.isNaN(Date.parse(available_until))) {
    return { problem: "body.package has no available_until date" };
  }
  const attachment = (msg.attachments ?? []).find(
    (a) => (a as Partial<PackageAttachment>).id === attachment_id
  ) as Partial<PackageAttachment> | undefined;
  if (attachment === undefined) {
    return { problem: `no attachment ${attachment_id} for the package` };
  }
  if (attachment.media_type !== CAR_MEDIA_TYPE) {
    return { problem: `the package attachment is ${attachment.media_type ?? "of no media type"}, not ${CAR_MEDIA_TYPE}` };
  }
  const data = attachment.data;
  if (typeof data?.hash !== "string" || !isBlobHash(data.hash) || attachment.id !== data.hash) {
    return { problem: "the package attachment is not named by its hash" };
  }
  const url = Array.isArray(data.links) && data.links.length === 1 ? packageUrl(data.links[0]) : null;
  if (url === null) {
    return { problem: "the package attachment does not name exactly one http(s) URL" };
  }
  const byteCount = attachment.byte_count;
  if (typeof byteCount !== "number" || !Number.isInteger(byteCount) || byteCount < 0) {
    return { problem: "the package attachment has no byte_count" };
  }
  return { hash: data.hash, byteCount, url, availableUntil: available_until, algorithm: AES256_GCM_HKDF_1MB, key };
}

/**
 * The one URL a package may name, or null: an absolute http(s) URL with
 * no credentials. Anything else is not a place the receiver will fetch
 * from — the package is a place to GET ciphertext, not a way to make the
 * receiver's agent call somewhere on the sender's behalf.
 */
function packageUrl(link: unknown): string | null {
  if (typeof link !== "string") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "") {
    return null;
  }
  return parsed.href;
}

/** The package attachment and the body entry that names it, for a share carrying one. */
export function packageParts(
  placed: { hash: string; url: string; byteCount: number; key: Uint8Array; retainUntil: string }
): { attachment: PackageAttachment; named: NonNullable<ObjectShareBody["package"]> } {
  return {
    attachment: {
      id: placed.hash,
      media_type: CAR_MEDIA_TYPE,
      byte_count: placed.byteCount,
      data: { links: [placed.url], hash: placed.hash },
    },
    named: {
      attachment_id: placed.hash,
      ciphering: { algorithm: AES256_GCM_HKDF_1MB, parameters: { key: bytesToBase64url(placed.key) } },
      available_until: placed.retainUntil,
    },
  };
}

/** The package's plaintext for a closure: a CARv1 rooted at `root` holding every block. */
export function packageCar(closure: Closure): Uint8Array {
  return encodeCar([closure.root], closure.blocks);
}

/**
 * Open a fetched package: the ciphertext must hash to the name the share
 * gave it, then decrypt under the share's key and read the CAR. Every
 * block returned hashes to its CID; whether it belongs to the closure is
 * for `verifyShare` to decide, block by block, as it walks. Throws when
 * the bytes are not the package, do not open, or open to a CAR rooted
 * elsewhere than `root` (§8): a package of some other object is not
 * this share's, however well it decrypts. What is missing from it is
 * not an error here — what walks is kept, the rest stays partial.
 */
export async function openPackage(
  pkg: SharePackage,
  ciphertext: Uint8Array,
  root: string
): Promise<Map<string, Uint8Array>> {
  if ((await blobHash(ciphertext)) !== pkg.hash) {
    throw new Error(`the bytes fetched do not hash to the package ${pkg.hash}`);
  }
  const car = await decodeCar(await decryptStream(pkg.key, ciphertext));
  if (car.roots.length !== 1 || car.roots[0] !== root) {
    throw new Error(`the package is rooted at [${car.roots.join(", ")}], not the object shared (${root})`);
  }
  return car.blocks;
}

/**
 * The blocks a share message carries, CID → bytes. Only attachments of
 * the block shape count; anything else riding along is ignored. Whether
 * the bytes match their CID is `verifyShare`'s question. Throws when an
 * `id` appears on two attachments (§2): that is malformed, whatever the
 * bytes.
 */
export function blocksOf(msg: PlainMessage): Map<string, Uint8Array> {
  const blocks = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  for (const attachment of msg.attachments ?? []) {
    const a = attachment as Partial<BlockAttachment>;
    const cid = a.id;
    if (typeof cid === "string") {
      // one id, one attachment: a second under the same name would leave it
      // to the reader which bytes the name means, and readers differ
      if (seen.has(cid)) {
        throw new Error(`attachment ${cid} appears twice`);
      }
      seen.add(cid);
    }
    const base64 = a.data?.base64;
    if (typeof cid !== "string" || typeof base64 !== "string") {
      continue;
    }
    try {
      blocks.set(cid, base64urlToBytes(base64));
    } catch {
      // not base64: not a block
    }
  }
  return blocks;
}

/**
 * Check a share message end to end: the skeleton carried reaches every
 * path under `body.root` with matching hashes, `index.json` is here and
 * well-formed, every leaf present hashes to its CID, and the card, if
 * there is one, verifies under its own did:key and is about this very
 * root. Leaves under `files/` may be absent: the result says which
 * (`tree.missing`, `tree.partial`, `complete`). Blocks the message does
 * not carry are looked up through `held` when given — the vault's
 * `blobs/`, so leaves that arrived by another road count as present,
 * and a recorded share, whose body names its blocks by id alone
 * (`lift.ts`), verifies over them. `blocks` is what the walk reached.
 * Throws naming the first thing wrong.
 */
export async function verifyShare(msg: PlainMessage, held?: GetBlock): Promise<VerifiedShare> {
  const body = msg.body as Partial<ObjectShareBody>;
  if (typeof body.root !== "string") {
    throw new Error("object-share message has no root");
  }
  const root = body.root;
  let card: ObjectCard | null = null;
  if (body.card !== undefined) {
    if (typeof body.card !== "string") {
      throw new Error("object-share card is not a JWS");
    }
    card = await verifyCard(body.card);
    if (card.root !== root) {
      throw new Error(`the card is about ${card.root}, not the object shared (${root})`);
    }
  }
  const carried = blocksOf(msg);
  const blocks = new Map<string, Uint8Array>(); // what the walk reaches and finds, wherever from
  const getBlock: GetBlock = async (cid) => {
    const reached = blocks.get(cid);
    if (reached !== undefined) {
      return reached;
    }
    const found = carried.get(cid) ?? (held === undefined ? null : await held(cid));
    if (found !== null) {
      blocks.set(cid, found);
    }
    return found;
  };
  const tree = await verifyTree(root, getBlock, { leaves: "optional" });
  if (!tree.files.has("index.json")) {
    throw new MalformedObjectError("format", "no index.json at the root");
  }
  if (tree.partial.has("index.json")) {
    throw new Error("object-share message carries no index.json: not the minimal share");
  }
  const files: TreeFiles = {};
  for (const path of tree.files.keys()) {
    if (path === "index.json" || (isInsideFiles(path) && !tree.partial.has(path))) {
      files[path] = (await resolvePath(root, path, getBlock)).bytes;
    }
  }
  const meta = parseIndex(files["index.json"] as Uint8Array);
  const object: FolderObject = { meta, tree: files };
  const named = packageOf(msg);
  const problem = named !== null && "problem" in named ? named : null;
  return {
    root,
    card,
    tree,
    object,
    complete: tree.missing.size === 0,
    package: problem === null ? (named as SharePackage | null) : null,
    packageProblem: problem?.problem ?? null,
    blocks,
  };
}

/** The bytes a partial share still lacks, as the skeleton sizes them. */
export function missingBytes(tree: VerifiedTree): number {
  let total = 0;
  for (const size of tree.missing.values()) {
    total += size;
  }
  return total;
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
