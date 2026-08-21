/**
 * The root card — the one signature in the system. Compact JWS, EdDSA
 * over Ed25519, `kid` naming the owner's verification method.
 *
 * Split of responsibilities: this module proves *who signed what*; it
 * does not decide whether the card is acceptable. Expiry is read-time
 * policy, "newer than the card I hold" is a string comparison on `id`
 * (uuidv7), and resolving `did` to a public key is the caller's resolver
 * — all deliberately outside.
 */

import {
  base64urlToBytes,
  base64urlToUtf8,
  bytesToBase64url,
  utf8ToBase64url,
} from "./base64url.js";
import type { CardSigner, RootCard } from "./types.js";

function checkCardShape(value: unknown): RootCard {
  const { did, id, expires, root } = (value ?? {}) as Record<string, unknown>;
  if (
    typeof did !== "string" ||
    typeof id !== "string" ||
    typeof expires !== "string" ||
    (root !== undefined && typeof root !== "string")
  ) {
    throw new Error("malformed root card");
  }
  return root === undefined ? { did, id, expires } : { did, id, expires, root };
}

/**
 * Sign a root card into a compact JWS. `kid` should name the owner's
 * verification method (usually `<did>#<fragment>`); the payload is the
 * card as given — minting rules (fresh uuidv7 id greater than the last,
 * a sane expires) are the caller's. A card without `root` is a takedown
 * card; JSON.stringify keeps the absent field absent on the wire.
 */
export async function createCard(
  card: RootCard,
  signer: CardSigner,
  kid: string,
): Promise<string> {
  const header = utf8ToBase64url(JSON.stringify({ alg: "EdDSA", kid }));
  const payload = utf8ToBase64url(JSON.stringify(card));
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await signer.sign(signingInput);
  if (signature.length !== 64) {
    throw new Error("signer did not return a 64-byte Ed25519 signature");
  }
  return `${header}.${payload}.${bytesToBase64url(signature)}`;
}

/** A verified card plus the kid that named the key which checked out. */
export interface VerifiedCard {
  card: RootCard;
  kid: string;
}

/**
 * Verify a compact JWS root card. `publicKeyFor` maps the protected
 * header's `kid` to a raw Ed25519 public key (32 bytes) — typically by
 * resolving the DID inside the payload and checking the kid belongs to
 * it; returning null rejects the kid. Throws unless the signature
 * verifies and the payload has the RootCard shape. Expiry and id
 * ordering are NOT checked here — they are acceptance policy.
 */
export async function verifyCard(
  jws: string,
  publicKeyFor: (kid: string) => Promise<Uint8Array | null> | Uint8Array | null,
): Promise<VerifiedCard> {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new Error("not a compact JWS");
  }
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(base64urlToUtf8(h));
  } catch {
    throw new Error("malformed JWS header");
  }
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") {
    throw new Error("expected EdDSA JWS with a kid");
  }
  const publicKey = await publicKeyFor(header.kid);
  if (publicKey === null) {
    throw new Error(`unknown kid ${header.kid}`);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    publicKey as Uint8Array<ArrayBuffer>,
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
  if (!ok) {
    throw new Error("root card signature does not verify");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(base64urlToUtf8(p));
  } catch {
    throw new Error("malformed root card payload");
  }
  return { card: checkCardShape(payload), kid: header.kid };
}
