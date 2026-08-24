import { createCard, verifyCard, type CardSigner } from "@estoc/signed-dir";
import { publicKeyFromDidKey } from "@estoc/keystore";
import { hashObject } from "./object.js";
import type { FolderObject } from "./types.js";

/** A did:key's verification method: `did:key:z6Mk…#z6Mk…` (the did:key convention). */
export function didKeyKid(did: string): string {
  if (!did.startsWith("did:key:")) throw new Error("only did:key is supported for cards");
  return `${did}#${did.slice("did:key:".length)}`;
}

/** Sign a bundle card over an object: JWS of `{did, root}` (spec §6). */
export async function signObject(object: FolderObject, signer: CardSigner & { did(): string }): Promise<string> {
  const did = signer.did();
  const root = await hashObject(object);
  return createCard({ did, root }, signer, didKeyKid(did));
}

export interface CardVerdict {
  did: string;
  root: string;
  /** The card's root matches the object's recomputed root. */
  matches: boolean;
}

/**
 * Verify a did:key card and check it against the object. Throws if the JWS
 * itself is bad (wrong shape, wrong key, kid not belonging to the payload's
 * did); returns `matches: false` if it is a fine card about a different tree.
 */
export async function verifyObjectCard(jws: string, object: FolderObject): Promise<CardVerdict> {
  const { card, kid } = await verifyCard(jws, (kid) => {
    const did = kid.split("#")[0] ?? "";
    if (didKeyKid(did) !== kid) return null;
    return publicKeyFromDidKey(did);
  });
  if (didKeyKid(card.did) !== kid) throw new Error("card kid does not belong to the card's did");
  const root = await hashObject(object);
  return { did: card.did, root: card.root, matches: card.root === root };
}
