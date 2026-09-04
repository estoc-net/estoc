/**
 * The object and card layers over the DASL tree: the same `FolderObject`
 * (`readObject` is encoding-neutral — the canonical tree is taken by
 * enumeration), hashed to a manifest root instead of a UnixFS root, and
 * the same card (`signRoot`/`verifyCard`: a JWS over `{did, root}`) with
 * that root in it.
 */

import { signRoot, verifyCard as verifyAnyCard, type CardVerdict } from "../card.js";
import { isInsideFiles, parseIndex } from "../object.js";
import { MalformedObjectError, type CardSigner, type FolderObject, type ObjectCard, type TreeFiles } from "../types.js";
import { codecOf, DRISL_CODE } from "./cid.js";
import { hashTree, walkTree, type GetBlock, type VerifiedManifest, type VerifyOptions } from "./tree.js";

/**
 * Is this listing an object's? The manifest of an object names exactly
 * the canonical tree — `index.json` and paths inside `files/`, none
 * hidden — and nothing else: a root that reaches litter, a card, or a
 * hidden file was not computed over an object, and no canonical tree
 * hashes to it. (A mapping read from a container may hold all of those
 * beside the object, and `readObject` drops them; a *hashed* tree may
 * not, and this refuses it.) Throws a format-layer MalformedObjectError.
 */
export function checkObjectPaths(paths: Iterable<string>): void {
  let index = false;
  for (const path of paths) {
    if (path === "index.json") index = true;
    else if (!isInsideFiles(path)) {
      throw new MalformedObjectError("format", `the manifest names ${JSON.stringify(path)}, which no canonical tree holds`);
    }
  }
  if (!index) throw new MalformedObjectError("format", "no index.json in the manifest");
}

/** An object read out of a verified manifest: as much of it as the blocks at hand make. */
export interface VerifiedObject {
  /** The object; with `leaves: "optional"`, `tree` holds only the files whose bytes are here. */
  object: FolderObject;
  /** What the manifest says and what was checked: every path, size, absent leaf. */
  tree: VerifiedManifest;
  /** No leaf is missing and none was declined: the object is whole, and verified whole. */
  complete: boolean;
}

/**
 * Verify a tree from its root (`verifyTree`) and read the object out of
 * it: the manifest must name exactly a canonical tree and `index.json`'s
 * bytes must be present and well-formed (format layer); `content.path`
 * must be a path the manifest names (closure layer). A leaf the blocks
 * lack is, with `leaves: "optional"`, a partial object — every path and
 * size known, some bytes not yet here — never a defect.
 */
export async function verifyObject(
  root: string,
  objects: Map<string, Uint8Array> | GetBlock,
  options: VerifyOptions = {},
): Promise<VerifiedObject> {
  const { tree, leaves } = await walkTree(root, objects, options);
  checkObjectPaths(tree.files.keys());
  const indexBytes = leaves.get("index.json");
  if (indexBytes === undefined) {
    if (tree.declined.has("index.json")) throw new Error("index.json is larger than this reader's maxLeafBytes: the object cannot be read here");
    throw new MalformedObjectError("format", "index.json's bytes are absent");
  }
  const meta = parseIndex(indexBytes);
  if (meta.content && "path" in meta.content && !tree.files.has(meta.content.path)) {
    throw new MalformedObjectError("closure", `content.path ${meta.content.path} is not in the manifest`);
  }
  const files: TreeFiles = {};
  for (const [path, bytes] of leaves) files[path] = bytes;
  return { object: { meta, tree: files }, tree, complete: tree.missing.size === 0 && tree.declined.size === 0 };
}

/** The object's version identity: the drisl CID of its manifest. */
export async function hashObject(object: FolderObject): Promise<string> {
  return (await hashTree(object.tree)).root;
}

/** Sign an object: hash its canonical tree, sign the root as the signer's did:key. */
export async function signObject(object: FolderObject, signer: CardSigner): Promise<string> {
  return signRoot(signer.did(), await hashObject(object), signer);
}

/**
 * Verify a card on its own terms (`card.ts`), and that its `root` is a
 * manifest CID: a card over a raw CID, or over a UnixFS root, is a
 * signature over something this format gives no meaning (spec §6, §8).
 */
export async function verifyCard(jws: string): Promise<ObjectCard> {
  const card = await verifyAnyCard(jws);
  if (codecOf(card.root) !== DRISL_CODE) throw new Error("the card's root is not a manifest CID");
  return card;
}

/** Verify a card and check it against the object (a fine card about another tree gives `matches: false`). */
export async function verifyObjectCard(jws: string, object: FolderObject): Promise<CardVerdict> {
  const card = await verifyCard(jws);
  return { ...card, matches: card.root === (await hashObject(object)) };
}
