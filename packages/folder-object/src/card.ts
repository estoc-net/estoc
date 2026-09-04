/**
 * The card — the one signature in the system. Compact JWS, EdDSA over
 * Ed25519, `typ: estoc/object-card`, `kid` naming the did:key's one
 * verification method, payload `{did, root}` where `root` is a manifest
 * CID (spec §6).
 *
 * The `typ` header pins what this signature is: a signature made here
 * cannot be read as some other protocol's statement, and vice versa. The
 * meaning of the card is fixed and single — the signer stands behind the
 * object — and what *that* means for a given tree is defined by the
 * format the tree declares in its own `index.json` (spec §6).
 */

import { codecOf, DRISL_CODE } from "@estoc/dasl";
import { publicKeyFromDidKey } from "@estoc/keystore";
import { base64urlToBytes, base64urlToUtf8, bytesToBase64url, utf8ToBase64url } from "./base64url.js";
import { hashObject } from "./object.js";
import type { CardSigner, FolderObject, ObjectCard } from "./types.js";

/** The JWS `typ` of an object card. */
export const CARD_TYP = "estoc/object-card";

/** A did:key's verification method: `did:key:z6Mk…#z6Mk…` (the did:key convention). */
export function didKeyKid(did: string): string {
  if (!did.startsWith("did:key:")) throw new Error("cards are signed by did:key identities");
  return `${did}#${did.slice("did:key:".length)}`;
}

/** Throw unless `root` is what a card may be about: the canonical string of a drisl DASL CID — a manifest's. */
function checkRoot(root: string): void {
  if (codecOf(root) !== DRISL_CODE) {
    throw new Error("a card's root is the drisl CID of a manifest, in canonical spelling: this format defines no signature over anything else");
  }
}

/** Sign a card over a manifest root as `did`. Two cards over the same (did, root) are equivalent. */
export async function signRoot(did: string, root: string, signer: Pick<CardSigner, "sign">): Promise<string> {
  checkRoot(root);
  const header = utf8ToBase64url(JSON.stringify({ alg: "EdDSA", typ: CARD_TYP, kid: didKeyKid(did) }));
  const payload = utf8ToBase64url(JSON.stringify({ did, root } satisfies ObjectCard));
  const signature = await signer.sign(new TextEncoder().encode(`${header}.${payload}`));
  if (signature.length !== 64) throw new Error("signer did not return a 64-byte Ed25519 signature");
  return `${header}.${payload}.${bytesToBase64url(signature)}`;
}

/** Sign an object: hash its canonical tree, sign the root as the signer's did:key. */
export async function signObject(object: FolderObject, signer: CardSigner): Promise<string> {
  return signRoot(signer.did(), await hashObject(object), signer);
}

/**
 * Verify a card on its own terms: an `estoc/object-card` JWS whose
 * payload is the one text `{"did":…,"root":…}`, whose `root` is a
 * manifest CID, and whose signature checks out under the did:key its
 * payload names. Throws on anything else. Whether the root is the tree
 * you hold is `verifyObjectCard`'s question.
 */
export async function verifyCard(jws: string): Promise<ObjectCard> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("not a compact JWS");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  try {
    header = JSON.parse(base64urlToUtf8(h));
  } catch {
    throw new Error("malformed JWS header");
  }
  if (header.typ !== CARD_TYP) throw new Error(`not an object card (typ ${String(header.typ)})`);
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new Error("expected an EdDSA JWS with a kid");
  let text: string;
  let payload: unknown;
  try {
    text = base64urlToUtf8(p); // fatal: a byte that is not UTF-8 is not a text, whatever it decodes to
    payload = JSON.parse(text);
  } catch {
    throw new Error("malformed card payload");
  }
  const { did, root } = (payload ?? {}) as Record<string, unknown>;
  if (typeof did !== "string" || typeof root !== "string") throw new Error("malformed card");
  if (Object.keys(payload as object).length !== 2) throw new Error("a card says exactly {did, root}");
  // Closed testimony has one text: the two members, each once, in this
  // order, no whitespace — what `signRoot` writes. Two JSON parsers can
  // disagree about a duplicated member; none can about this.
  if (text !== JSON.stringify({ did, root })) throw new Error("a card's payload is exactly the text {\"did\":…,\"root\":…}");
  checkRoot(root);
  if (!did.startsWith("did:key:") || didKeyKid(did) !== header.kid) {
    throw new Error("the card's kid does not belong to the card's did");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    publicKeyFromDidKey(did) as Uint8Array<ArrayBuffer>,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    base64urlToBytes(s) as Uint8Array<ArrayBuffer>,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("card signature does not verify");
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
