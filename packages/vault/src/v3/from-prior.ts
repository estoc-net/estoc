/**
 * The DIDComm `from_prior` proof that one DID continues another: a
 * compact JWT the predecessor's authentication key signs over the
 * successor. Signing is ours to do for a local rotation. A carried
 * proof is read in three steps that need progressively more material:
 * its claims alone, the claims against the carrier they arrived on,
 * and the signature against the predecessor's immutable document,
 * derived from the issuer's long form or from a retained resolution
 * of its short form. DID spellings compare by validated equivalence
 * while every other part of a method ID matches byte for byte, and
 * nothing rewrites the signed bytes or the retained document.
 */

import { isJsonObject, parseStrict, type JsonObject } from "@estoc/event-store/v3";
import { isLongForm } from "@estoc/did-peer";
import { base64urlnopad } from "@scure/base";
import { SignJWT, compactVerify, importJWK } from "jose";

import { InvalidDidDocument, InvalidFromPrior } from "./errors.js";
import { resolvedDocumentOf, type ReadObject } from "./fold/evidence.js";
import type { Keys } from "./identity.js";
import { didKeyName } from "./ids.js";
import { authorizedMethodIds, canonicalDidOf, methodPublicKey, peerResolution, splitDidUrl, type PeerResolution } from "./peer-document.js";
import { decodePublicKey } from "./public-key.js";
import { isCompactJwt, isDid, isDidUrl, isPeer4Long, isPeer4Short } from "./syntax.js";
import type { Did, DidId, DidUrl, PublicKey, VaultData } from "./types.js";

export const FROM_PRIOR_ALG = "EdDSA";

/** The claims a `from_prior` carries and the protected key ID it names. */
export type FromPriorClaims = { iss: Did; sub: Did; iat: number; kid: DidUrl };

/** A carried proof's claims checked as far as they can be without the issuer's document: the canonical DIDs it links. */
export type CarriedClaims = FromPriorClaims & { predecessorDid: Did; successorDid: Did };

/** A verified proof: its claims, the method of the issuer's document that verified it and that method's key. */
export type VerifiedFromPrior = FromPriorClaims & { methodId: DidUrl; publicKey: PublicKey };

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

function segmentsOf(jwt: string): [header: string, payload: string, signature: string] {
  if (!isCompactJwt(jwt)) throw new InvalidFromPrior("not a compact JWT");
  return jwt.split(".") as [string, string, string];
}

function decoded(segment: string, what: string): Uint8Array {
  try {
    return base64urlnopad.decode(segment);
  } catch (err) {
    throw new InvalidFromPrior(`the ${what} is not base64url: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function jsonObjectOf(segment: string, what: string): JsonObject {
  let value: unknown;
  try {
    value = parseStrict(decoded(segment, what));
  } catch (err) {
    if (err instanceof InvalidFromPrior) throw err;
    throw new InvalidFromPrior(`the ${what} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isJsonObject(value)) throw new InvalidFromPrior(`the ${what} is a JSON object`);
  return value;
}

function claimsOf(payload: JsonObject, kid: DidUrl): FromPriorClaims {
  const { iss, sub, iat } = payload;
  if (!isDid(iss)) throw new InvalidFromPrior("iss is a DID");
  if (!isDid(sub)) throw new InvalidFromPrior("sub is a DID");
  if (!Number.isSafeInteger(iat)) throw new InvalidFromPrior("iat is an integer");
  return { iss: iss as Did, sub: sub as Did, iat: iat as number, kid };
}

/**
 * RFC 7797 lets a JWS leave its payload unencoded and requires the `b64`
 * option, when spelled out, to be critical; a JWT may only spell out the
 * encoded default, and no other extension is understood here.
 */
function protectedKid(header: JsonObject): DidUrl {
  if (header["alg"] !== FROM_PRIOR_ALG) throw new InvalidFromPrior(`alg is ${FROM_PRIOR_ALG}`);
  if (header["typ"] !== undefined && header["typ"] !== "JWT") throw new InvalidFromPrior("typ is JWT");
  const { b64, crit } = header;
  if (b64 !== undefined && b64 !== true) throw new InvalidFromPrior("a JWT encodes its payload");
  if (crit !== undefined && (!Array.isArray(crit) || crit.length === 0 || !crit.every((name) => name === "b64"))) throw new InvalidFromPrior("crit names b64 and no other extension");
  if ((b64 === undefined) !== (crit === undefined)) throw new InvalidFromPrior("b64 is critical when spelled out");
  if (!isDidUrl(header["kid"])) throw new InvalidFromPrior("kid is a DID URL");
  return header["kid"] as DidUrl;
}

function canonical(did: string): Did {
  try {
    return canonicalDidOf(did);
  } catch (err) {
    if (err instanceof InvalidDidDocument) throw new InvalidFromPrior(err.message);
    throw err;
  }
}

function canonicalChannelDid(spelling: Did, claim: string): Did {
  if (!isPeer4Short(spelling) && !isPeer4Long(spelling)) throw new InvalidFromPrior(`${claim} is a did:peer:4`);
  return canonical(spelling);
}

/**
 * The claims a proof carries and the key it names, read without
 * verifying the signature: what a carrier says before the evidence to
 * check it is here. Every segment must be base64url, the header and
 * payload strict JSON objects, so that what fails here is the proof's
 * form and no later material can repair it.
 */
export function fromPriorClaims(jwt: string): FromPriorClaims {
  const [header, payload, signature] = segmentsOf(jwt);
  const kid = protectedKid(jsonObjectOf(header, "protected header"));
  decoded(signature, "signature");
  return claimsOf(jsonObjectOf(payload, "payload"), kid);
}

/**
 * A carried proof's claims against the carrier they arrived on, every
 * check that needs no document: `sub` is the DID the message came from
 * byte for byte, `iss` and `sub` are did:peer:4 spellings that
 * validate to two different DIDs, and the protected `kid` names `iss`
 * byte for byte. A failure here is invalid whatever material turns up
 * later.
 */
export function carriedClaims(jwt: string, presentedDid: Did): CarriedClaims {
  const claims = fromPriorClaims(jwt);
  if (claims.sub !== presentedDid) throw new InvalidFromPrior("sub is the DID the message came from");
  const predecessorDid = canonicalChannelDid(claims.iss, "iss");
  const successorDid = canonicalChannelDid(claims.sub, "sub");
  if (predecessorDid === successorDid) throw new InvalidFromPrior("sub is another DID than iss");
  if (splitDidUrl(claims.kid)[0] !== claims.iss) throw new InvalidFromPrior("the kid DID portion is the iss DID");
  return { ...claims, predecessorDid, successorDid };
}

/**
 * The immutable document of a proof's issuer. A long form derives it
 * on its own. A short form needs a retained resolution of that DID:
 * the first of those given whose document reads, which is what the
 * document's own long form derives. Null while no retained document is
 * here: a long form seen only in other event data is not material.
 */
export async function issuerDocumentOf(iss: Did, retained: Iterable<VaultData["peer.resolved"]>, readObject: ReadObject): Promise<JsonObject | null> {
  if (isLongForm(iss)) return resolution(iss).document;
  for (const resolved of retained) {
    if (resolved.did !== iss) continue;
    let document: JsonObject | null;
    try {
      document = await resolvedDocumentOf(resolved, readObject);
    } catch (err) {
      if (err instanceof InvalidDidDocument) continue;
      throw err;
    }
    if (document !== null) return document;
  }
  return null;
}

/**
 * Verify a proof against its issuer's document. The protected `kid`
 * names the `iss` DID byte for byte; `iss` and the document's `id`
 * name one DID under validated spelling equivalence; `sub` is a
 * validated DID other than that one; the `kid` is one of the
 * document's authentication methods, its DID portion under the same
 * equivalence and the rest byte for byte; and that method's Ed25519
 * key verifies the signature. `iat` is any integer. That `sub` is the
 * DID the message came from is the carrier's check, made beforehand.
 */
export async function verifyFromPrior(jwt: string, document: JsonObject): Promise<VerifiedFromPrior> {
  const claims = fromPriorClaims(jwt);
  const [kidDid, kidRest] = splitDidUrl(claims.kid);
  if (kidDid !== claims.iss) throw new InvalidFromPrior("the kid DID portion is the iss DID");
  const iss = canonical(claims.iss);
  if (canonical(claims.sub) === iss) throw new InvalidFromPrior("sub is another DID than iss");
  const documentId = document["id"];
  if (!isDid(documentId) || canonical(documentId) !== iss) throw new InvalidFromPrior(`the document is not ${claims.iss}'s`);
  let methodId: DidUrl | undefined;
  try {
    methodId = authorizedMethodIds(document, "authentication").find((id) => {
      const [did, rest] = splitDidUrl(id);
      return rest === kidRest && canonical(did) === iss;
    });
  } catch (err) {
    if (err instanceof InvalidDidDocument) throw new InvalidFromPrior(`the issuer's document: ${err.message}`);
    throw err;
  }
  if (methodId === undefined) throw new InvalidFromPrior(`${claims.kid} is not an authentication method of the issuer's document`);
  let publicKey: PublicKey;
  try {
    publicKey = methodPublicKey(document, methodId);
  } catch (err) {
    if (err instanceof InvalidDidDocument) throw new InvalidFromPrior(`the issuer's document: ${err.message}`);
    throw err;
  }
  const decodedKey = decodePublicKey(publicKey);
  if (decodedKey.type !== "Ed25519") throw new InvalidFromPrior(`${methodId} is a ${decodedKey.type} key, not Ed25519`);
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(decodedKey.bytes) }, FROM_PRIOR_ALG);
  let signed: Uint8Array;
  try {
    ({ payload: signed } = await compactVerify(jwt, key, { algorithms: [FROM_PRIOR_ALG] }));
  } catch {
    throw new InvalidFromPrior(`the signature does not verify under ${methodId}`);
  }
  if (base64urlnopad.encode(signed) !== segmentsOf(jwt)[1]) throw new InvalidFromPrior("the signature does not cover the claims");
  return { ...claims, methodId, publicKey };
}

/**
 * Verify the proof a local rotation decision froze, the exact
 * counterpart of signing one: `iss` is the predecessor's long form and
 * `sub` the successor's, byte for byte; the signature verifies under
 * an authentication method of the predecessor's own document; and
 * that method's key is the one the seed derives for the predecessor
 * entity.
 */
export async function verifyLocalProof(jwt: string, keys: Keys, predecessor: { didId: DidId; longFormDid: Did }, successorLongFormDid: Did): Promise<VerifiedFromPrior> {
  const claims = fromPriorClaims(jwt);
  if (claims.iss !== predecessor.longFormDid) throw new InvalidFromPrior("iss is the predecessor's long form");
  if (claims.sub !== successorLongFormDid) throw new InvalidFromPrior("sub is the successor's long form");
  if (!isLongForm(claims.iss) || !isLongForm(claims.sub)) throw new InvalidFromPrior("iss and sub are did:peer:4 long forms");
  const verified = await verifyFromPrior(jwt, resolution(predecessor.longFormDid).document);
  const key = await keys.signing(didKeyName(predecessor.didId, "authentication"));
  if (verified.publicKey !== key.publicKey) throw new InvalidFromPrior(`${verified.methodId} does not carry the entity's authentication key`);
  return verified;
}
