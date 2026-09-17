/**
 * The DIDComm `from_prior` proof that one DID continues another: a
 * compact JWT the predecessor's authentication key signs over the
 * successor. Signing is ours to do for a local rotation; verification
 * uses the exact immutable predecessor document the caller retained
 * and verified, never a fresher resolution, and compares DID spellings
 * by validated equivalence while every other part of the method ID
 * matches byte for byte.
 */

import { isJsonObject, parseStrict, type JsonObject } from "@estoc/event-store/v3";
import { isLongForm } from "@estoc/did-peer";
import { base64urlnopad } from "@scure/base";
import { SignJWT, compactVerify, decodeProtectedHeader, importJWK } from "jose";

import { InvalidDidDocument, InvalidFromPrior } from "./errors.js";
import type { Keys } from "./identity.js";
import { didKeyName } from "./ids.js";
import { authorizedMethodIds, canonicalDidOf, methodPublicKey, peerResolution, splitDidUrl, type PeerResolution } from "./peer-document.js";
import { decodePublicKey } from "./public-key.js";
import { isCompactJwt, isDid, isDidUrl } from "./syntax.js";
import type { Did, DidId, DidUrl, PublicKey } from "./types.js";

export const FROM_PRIOR_ALG = "EdDSA";

/** The claims a `from_prior` carries and the protected key ID it names. */
export type FromPriorClaims = { iss: Did; sub: Did; iat: number; kid: DidUrl };

/** A verified proof: its claims, the pinned method that verified it and that method's key. */
export type VerifiedFromPrior = FromPriorClaims & { methodId: DidUrl; publicKey: PublicKey };

/** The predecessor as retained: its canonical DID and the exact immutable document the proof is verified against. */
export type PinnedResolution = { did: Did; document: JsonObject };

/**
 * Sign that the successor continues the predecessor: `iss` is the
 * predecessor's long form, `sub` the successor's, `kid` the method of
 * the predecessor's own document that carries the entity's
 * authentication key, whatever fragment that document gave it, and the
 * signature that key's.
 */
export async function signFromPrior(keys: Keys, predecessor: { didId: DidId; longFormDid: Did }, successorLongFormDid: Did, iat: number): Promise<string> {
  if (!isLongForm(predecessor.longFormDid) || !isLongForm(successorLongFormDid)) throw new InvalidFromPrior("iss and sub are did:peer:4 long forms");
  if (canonical(predecessor.longFormDid) === canonical(successorLongFormDid)) throw new InvalidFromPrior("the successor is another DID");
  if (!Number.isSafeInteger(iat)) throw new InvalidFromPrior("iat is an integer");
  const key = await keys.signing(didKeyName(predecessor.didId, "authentication"));
  const document = resolution(predecessor.longFormDid).document;
  const kid = authorizedMethodIds(document, "authentication").find((id) => splitDidUrl(id)[0] === predecessor.longFormDid && methodPublicKey(document, id) === key.publicKey);
  if (kid === undefined) throw new InvalidFromPrior(`${predecessor.longFormDid} authorizes no authentication method carrying the entity's key`);
  const privateKey = await importJWK(key.privateJwk(), FROM_PRIOR_ALG);
  return new SignJWT({})
    .setProtectedHeader({ alg: FROM_PRIOR_ALG, typ: "JWT", kid })
    .setIssuer(predecessor.longFormDid)
    .setSubject(successorLongFormDid)
    .setIssuedAt(iat)
    .sign(privateKey);
}

function resolution(longFormDid: string): PeerResolution {
  try {
    return peerResolution(longFormDid);
  } catch (err) {
    if (err instanceof InvalidDidDocument) throw new InvalidFromPrior(err.message);
    throw err;
  }
}

function claimsOf(jwt: string, kid: DidUrl): FromPriorClaims {
  let payload: unknown;
  try {
    payload = parseStrict(base64urlnopad.decode(jwt.split(".")[1] as string));
  } catch (err) {
    throw new InvalidFromPrior(`the payload is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isJsonObject(payload)) throw new InvalidFromPrior("the payload is a JSON object");
  const { iss, sub, iat } = payload;
  if (!isDid(iss)) throw new InvalidFromPrior("iss is a DID");
  if (!isDid(sub)) throw new InvalidFromPrior("sub is a DID");
  if (!Number.isSafeInteger(iat)) throw new InvalidFromPrior("iat is an integer");
  return { iss: iss as Did, sub: sub as Did, iat: iat as number, kid };
}

function protectedKid(jwt: string): DidUrl {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(jwt);
  } catch (err) {
    throw new InvalidFromPrior(`the protected header is not one: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (header.alg !== FROM_PRIOR_ALG) throw new InvalidFromPrior(`alg is ${FROM_PRIOR_ALG}`);
  if (header.typ !== undefined && header.typ !== "JWT") throw new InvalidFromPrior("typ is JWT");
  if (!isDidUrl(header.kid)) throw new InvalidFromPrior("kid is a DID URL");
  return header.kid as DidUrl;
}

function canonical(did: string): Did {
  try {
    return canonicalDidOf(did);
  } catch (err) {
    if (err instanceof InvalidDidDocument) throw new InvalidFromPrior(err.message);
    throw err;
  }
}

/** The claims a proof carries and the key it names, read without verifying anything: what a carrier says before the evidence to check it is here. */
export function fromPriorClaims(jwt: string): FromPriorClaims {
  if (!isCompactJwt(jwt)) throw new InvalidFromPrior("not a compact JWT");
  return claimsOf(jwt, protectedKid(jwt));
}

/**
 * Verify a proof against the pinned predecessor. The protected `kid`
 * names the `iss` DID byte for byte; `iss` names the pinned DID under
 * validated spelling equivalence, and so does the pinned document's
 * own `id`; `sub` is a validated DID other than the predecessor; the
 * `kid` is one of the pinned document's authentication methods, its
 * DID portion under the same equivalence and the rest byte for byte;
 * and that method's key verifies the signature. `iat` is any integer.
 * That `sub` is the DID the message came from, and that it resolves,
 * are the receiving procedure's to check with the message in hand.
 */
export async function verifyFromPrior(jwt: string, pinned: PinnedResolution): Promise<VerifiedFromPrior> {
  const claims = fromPriorClaims(jwt);
  const [kidDid, kidRest] = splitDidUrl(claims.kid);
  if (kidDid !== claims.iss) throw new InvalidFromPrior("the kid DID portion is the iss DID");
  const iss = canonical(claims.iss);
  if (iss !== pinned.did) throw new InvalidFromPrior(`iss ${claims.iss} is not the pinned predecessor ${pinned.did}`);
  if (canonical(claims.sub) === iss) throw new InvalidFromPrior("sub is another DID than iss");
  const documentId = pinned.document["id"];
  if (!isDid(documentId) || canonical(documentId) !== pinned.did) throw new InvalidFromPrior(`the pinned document is not ${pinned.did}'s`);
  let methodId: DidUrl | undefined;
  try {
    methodId = authorizedMethodIds(pinned.document, "authentication").find((id) => {
      const [did, rest] = splitDidUrl(id);
      return rest === kidRest && canonical(did) === iss;
    });
  } catch (err) {
    if (err instanceof InvalidDidDocument) throw new InvalidFromPrior(`the pinned document: ${err.message}`);
    throw err;
  }
  if (methodId === undefined) throw new InvalidFromPrior(`${claims.kid} is not an authentication method of the pinned document`);
  let publicKey: PublicKey;
  try {
    publicKey = methodPublicKey(pinned.document, methodId);
  } catch (err) {
    if (err instanceof InvalidDidDocument) throw new InvalidFromPrior(`the pinned document: ${err.message}`);
    throw err;
  }
  const decoded = decodePublicKey(publicKey);
  if (decoded.type !== "Ed25519") throw new InvalidFromPrior(`${methodId} is a ${decoded.type} key, not Ed25519`);
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(decoded.bytes) }, FROM_PRIOR_ALG);
  try {
    await compactVerify(jwt, key, { algorithms: [FROM_PRIOR_ALG] });
  } catch {
    throw new InvalidFromPrior(`the signature does not verify under ${methodId}`);
  }
  return { ...claims, methodId, publicKey };
}
