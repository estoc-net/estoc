/**
 * The card — the one signature in the system. Compact JWS, EdDSA over
 * Ed25519, `typ: estoc/object-card`, `kid` naming the did:key's one
 * verification method, payload `{did, root}`.
 *
 * The `typ` header pins what this signature is: a signature made here
 * cannot be read as some other protocol's statement, and vice versa. The
 * meaning of the card is fixed and single — the signer stands behind the
 * object — and what *that* means for a given tree is defined by the
 * format the tree declares in its own `index.json`.
 */

import { publicKeyFromDidKey } from "@estoc/keystore";
import { base64url, compactVerify, errors, importJWK, type CompactJWSHeaderParameters } from "jose";
import { hashObject } from "./object.js";
import type { CardSigner, FolderObject, ObjectCard } from "./types.js";

export const CARD_TYP = "estoc/object-card";

const DID_KEY = "did:key:";

/** A did:key's verification method: `did:key:z6Mk…#z6Mk…` (the did:key convention). */
export function didKeyKid(did: string): string {
  if (!did.startsWith(DID_KEY)) throw new Error("cards are signed by did:key identities");
  return `${did}#${did.slice(DID_KEY.length)}`;
}

/**
 * Sign a card over a root as `did`. Two cards over the same (did, root)
 * are equivalent. The JWS is put together here rather than by `jose`
 * because the signer may be a device that signs bytes and never gives
 * up a key, and `jose` signs with a key it is given: it takes no signer
 * to call.
 */
export async function signRoot(did: string, root: string, signer: Pick<CardSigner, "sign">): Promise<string> {
  const header = base64url.encode(JSON.stringify({ alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(did) }));
  const payload = base64url.encode(JSON.stringify({ did, root } satisfies ObjectCard));
  const signature = await signer.sign(new TextEncoder().encode(`${header}.${payload}`));
  if (signature.length !== 64) throw new Error("signer did not return a 64-byte Ed25519 signature");
  return `${header}.${payload}.${base64url.encode(signature)}`;
}

/** Sign an object: hash its canonical tree, sign the root as the signer's did:key. */
export async function signObject(object: FolderObject, signer: CardSigner): Promise<string> {
  return signRoot(signer.did(), await hashObject(object), signer);
}

/** The key an object card's header names: the did:key of its `kid`, which is self-certifying. */
function cardKey(header: CompactJWSHeaderParameters) {
  if (header.typ !== CARD_TYP) throw new Error(`not an object card (typ ${String(header.typ)})`);
  // RFC 7797 allows an unencoded payload; no card is signed that way, and a verifier without the extension would refuse one this one took.
  if (header.b64 === false) throw new Error("a card's payload is base64url");
  const did = header.kid?.split("#")[0] ?? "";
  if (!did.startsWith(DID_KEY) || didKeyKid(did) !== header.kid) throw new Error("expected the kid of a did:key");
  return importJWK({ kty: "OKP", crv: "Ed25519", x: base64url.encode(publicKeyFromDidKey(did)) }, "EdDSA");
}

/** Verify a card on its own terms; throws on anything that is not one. Whether the root is the tree you hold is `verifyObjectCard`'s question. */
export async function verifyCard(jws: string): Promise<ObjectCard> {
  const verified = await compactVerify(jws, cardKey, { algorithms: ["EdDSA"] }).catch((err: unknown) => {
    if (err instanceof errors.JWSSignatureVerificationFailed) throw new Error("card signature does not verify");
    throw err;
  });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    throw new Error("malformed card payload");
  }
  const { did, root } = (payload ?? {}) as Record<string, unknown>;
  if (typeof did !== "string" || typeof root !== "string") throw new Error("malformed card");
  if (Object.keys(payload as object).length !== 2) throw new Error("a card says exactly {did, root}");
  if (!did.startsWith(DID_KEY) || didKeyKid(did) !== verified.protectedHeader.kid) {
    throw new Error("the card's kid does not belong to the card's did");
  }
  return { did, root };
}

export interface CardVerdict extends ObjectCard {
  /** The card's root is the object's recomputed root. */
  matches: boolean;
}

/**
 * Verify a card and check it against the object. Throws if the card
 * itself is bad; returns `matches: false` if it is a fine card about a
 * different tree.
 */
export async function verifyObjectCard(jws: string, object: FolderObject): Promise<CardVerdict> {
  const card = await verifyCard(jws);
  return { ...card, matches: card.root === (await hashObject(object)) };
}
