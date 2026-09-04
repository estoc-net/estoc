/**
 * The object and card layers over the DASL tree: the same `FolderObject`
 * (`readObject` is encoding-neutral — the canonical tree is taken by
 * enumeration), hashed to a manifest root instead of a UnixFS root, and
 * the same card (`signRoot`/`verifyCard`: a JWS over `{did, root}`) with
 * that root in it.
 */

import { signRoot, verifyCard as verifyAnyCard, type CardVerdict } from "../card.js";
import type { CardSigner, FolderObject, ObjectCard } from "../types.js";
import { codecOf, DRISL_CODE } from "./cid.js";
import { hashTree } from "./tree.js";

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
