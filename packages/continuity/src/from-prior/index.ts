/**
 * @estoc/continuity/from-prior — the DIDComm v2 `from_prior` proof: a
 * compact JWT the prior DID's authentication key signs, whose `iss` is
 * the prior DID, whose `sub` is the new DID, and which omits `sub` to
 * end the relationship instead. This module inspects a token without
 * verifying it, verifies one against the issuer's document the host
 * supplies, binds a verified proof to the receipt it arrived on to
 * produce continuity facts, and creates one with a signing capability
 * the host supplies. The supported profile is did:peer:4 issuers and
 * subjects and Ed25519 keys; DID equivalence is the did:peer:4 short
 * form, and nothing rewrites a signed byte.
 *
 * A received ending carries no sender, so the standard's basic form
 * binds it to no particular relationship. This profile binds an ending
 * only when its JWT names the recipient in `aud`; an ending without an
 * audience verifies but does not bind.
 */

import { decodeLongForm, isLongForm, isShortForm, longToShort, resolveLongForm } from "@estoc/did-peer";
import { base58, base64urlnopad } from "@scure/base";
import { compactVerify, decodeJwt, decodeProtectedHeader, importJWK, type JWK, type JWTPayload } from "jose";

import type { ContinuityFact, Did, EvidenceRef, FactId } from "../types.js";

export const FROM_PRIOR_PROFILE = "estoc-from-prior/1";
export const FROM_PRIOR_ALG = "EdDSA";

/** Why a token is not a proof: its form, the profile it does not meet, the document that is not its issuer's, or its signature. */
export type FromPriorFailure = "form" | "profile" | "document" | "signature";

export class InvalidFromPrior extends Error {
  override readonly name = "InvalidFromPrior";
  constructor(
    message: string,
    readonly failure: FromPriorFailure
  ) {
    super(message);
  }
}

export type DidUrl = string;

/** A DID as it was presented and the identity that spelling validates to. */
export type DidSpelling = Readonly<{ presented: Did; canonical: Did }>;

export type UnverifiedFromPrior = Readonly<{
  header: Readonly<{ alg: string; typ: string | undefined; kid: string }>;
  claims: Readonly<{ iss: string; sub: string | undefined; aud: string | undefined; iat: number }>;
}>;

/** The issuer's long-form did:peer:4 as the host retained it, and its reference. */
export type IssuerEvidence = Readonly<{ ref: EvidenceRef; longForm: Did }>;

const verified: unique symbol = Symbol("verified");

export type VerifiedChange = Readonly<{ kind: "rotate"; successor: DidSpelling }> | Readonly<{ kind: "end"; audience: DidSpelling | null }>;

/** A proof that verified under the profile: the issuer's declaration, before any receipt binding. */
export type VerifiedFromPrior = Readonly<{
  readonly [verified]: true;
  profile: typeof FROM_PRIOR_PROFILE;
  token: string;
  issuer: DidSpelling;
  change: VerifiedChange;
  iat: number;
  document: Readonly<{ ref: EvidenceRef; longForm: Did }>;
  method: DidUrl;
}>;

/** What the host established about the receipt by decrypting and authenticating the envelope. */
export type ReceiptEvidence = Readonly<{
  ref: EvidenceRef;
  /** the token exactly as the receipt carried it */
  token: string;
  /** the local DID the envelope was actually addressed to */
  recipient: Did;
  /**
   * the authenticated sender; null only when the host established that
   * the envelope was anonymous and the plaintext carried no `from`
   */
  sender: Did | null;
}>;

export type BindingIds = Readonly<{ transitionId: FactId; observationId?: FactId }>;

export type Binding =
  | Readonly<{ status: "bound"; facts: readonly ContinuityFact[] }>
  | Readonly<{ status: "mismatch"; because: string }>
  | Readonly<{ status: "unbound"; because: string }>;

/**
 * A key the host holds under an authentication method of the issuer's
 * document, reduced to signing bytes so that a key behind a hardware
 * wallet or a keystore that exposes no key object can sign too.
 */
export type Signer = Readonly<{
  methodId: DidUrl;
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}>;

export type ProofRequest = Readonly<{
  issuer: Did;
  change: Readonly<{ kind: "rotate"; successor: Did }> | Readonly<{ kind: "end"; audience: Did }>;
  iat: number;
  evidence: IssuerEvidence;
}>;

const ED25519_MULTICODEC = [0xed, 0x01];
const ED25519_KEY_BYTES = 32;

function form(message: string): InvalidFromPrior {
  return new InvalidFromPrior(message, "form");
}

function profile(message: string): InvalidFromPrior {
  return new InvalidFromPrior(message, "profile");
}

/** The identity a did:peer:4 spelling names, its long form checked against its hash. */
function canonicalDid(spelling: unknown, what: string): DidSpelling {
  if (typeof spelling !== "string") throw profile(`${what} is a string`);
  if (isShortForm(spelling)) return { presented: spelling, canonical: spelling };
  if (!isLongForm(spelling)) throw profile(`${what} is a did:peer:4`);
  try {
    decodeLongForm(spelling);
  } catch (err) {
    throw profile(`${what} does not decode: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { presented: spelling, canonical: longToShort(spelling) };
}

function splitDidUrl(url: unknown, what: string): { did: DidSpelling; fragment: string } {
  if (typeof url !== "string") throw profile(`${what} is a string`);
  const hash = url.indexOf("#");
  if (hash < 0 || url.indexOf("#", hash + 1) >= 0 || hash === url.length - 1) throw profile(`${what} is a DID URL with one fragment`);
  return { did: canonicalDid(url.slice(0, hash), `the DID of ${what}`), fragment: url.slice(hash + 1) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A token's protected header and claims, decoded and checked for shape
 * only. What this returns is what the token says, not a proof; it lets
 * the host find the issuer's material.
 */
export function inspectFromPrior(jwt: string): UnverifiedFromPrior {
  let header: ReturnType<typeof decodeProtectedHeader>;
  let payload: JWTPayload;
  try {
    header = decodeProtectedHeader(jwt);
    payload = decodeJwt(jwt);
  } catch (err) {
    throw form(`not a compact JWT: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof header.alg !== "string") throw form("the protected header names an alg");
  if (typeof header.kid !== "string") throw form("the protected header names a kid");
  if (header.typ !== undefined && typeof header.typ !== "string") throw form("typ is a string");
  return { header: { alg: header.alg, typ: header.typ, kid: header.kid }, claims: claimsOf(payload) };
}

/** The claims of a decoded payload, in the shape the profile reads them. */
function claimsOf(payload: JWTPayload): UnverifiedFromPrior["claims"] {
  if (typeof payload.iss !== "string") throw form("iss is a string");
  if (Object.hasOwn(payload, "sub") && typeof payload.sub !== "string") throw form("sub, when present, is a string");
  if (Object.hasOwn(payload, "aud") && typeof payload.aud !== "string") throw form("aud, when present, is one string");
  if (!Number.isSafeInteger(payload.iat)) throw form("iat is an integer");
  if (Object.hasOwn(payload, "exp") || Object.hasOwn(payload, "nbf")) throw form("a from_prior has no exp or nbf; this profile evaluates no validity window");
  return { iss: payload.iss, sub: payload.sub, aud: payload.aud as string | undefined, iat: payload.iat as number };
}

const decoder = new TextDecoder();

/** The claims a verified signature covers: read again from the bytes the library verified, not from the pre-verification decode. */
function verifiedClaims(payload: Uint8Array): UnverifiedFromPrior["claims"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch {
    throw form("the payload is JSON");
  }
  if (!isPlainObject(parsed)) throw form("the payload is an object");
  return claimsOf(parsed as JWTPayload);
}

/**
 * RFC 7519 makes `typ` optional and its value a media type, compared
 * case-insensitively; both spellings the RFC gives for a JWT are
 * accepted, and creation emits the short one.
 */
function isJwtType(typ: string | undefined): boolean {
  if (typ === undefined) return true;
  const lower = typ.toLowerCase();
  return lower === "jwt" || lower === "application/jwt";
}

type Method = { id: string; key: JWK };

function relativeTo(id: string, documentId: string): string {
  return id.startsWith("#") ? `${documentId}${id}` : id;
}

function ed25519Jwk(method: Record<string, unknown>, id: string): JWK {
  const multibase = method["publicKeyMultibase"];
  const jwk = method["publicKeyJwk"];
  if (typeof multibase === "string" && jwk === undefined) {
    if (!multibase.startsWith("z")) throw new InvalidFromPrior(`${id}: publicKeyMultibase is base58btc`, "document");
    let bytes: Uint8Array;
    try {
      bytes = base58.decode(multibase.slice(1));
    } catch {
      throw new InvalidFromPrior(`${id}: publicKeyMultibase is base58btc`, "document");
    }
    if (bytes.length !== ED25519_MULTICODEC.length + ED25519_KEY_BYTES || bytes[0] !== ED25519_MULTICODEC[0] || bytes[1] !== ED25519_MULTICODEC[1]) throw new InvalidFromPrior(`${id} is not an Ed25519 key`, "document");
    return { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(bytes.subarray(ED25519_MULTICODEC.length)) };
  }
  if (isPlainObject(jwk) && multibase === undefined) {
    if (jwk["kty"] !== "OKP" || jwk["crv"] !== "Ed25519" || typeof jwk["x"] !== "string") throw new InvalidFromPrior(`${id} is not an Ed25519 key`, "document");
    return { kty: "OKP", crv: "Ed25519", x: jwk["x"] };
  }
  throw new InvalidFromPrior(`${id} carries one of publicKeyMultibase and publicKeyJwk`, "document");
}

/**
 * The issuer's document, resolved from the long form the host retained:
 * the long form's hash covers the document, so a key found in it is the
 * issuer's own.
 */
function issuerDocument(evidence: IssuerEvidence, issuer: DidSpelling): { id: string; document: Record<string, unknown> } {
  const longForm = evidence.longForm;
  if (typeof longForm !== "string" || !isLongForm(longForm)) throw new InvalidFromPrior("the issuer evidence is a long-form did:peer:4", "document");
  let document: unknown;
  try {
    document = resolveLongForm(longForm);
  } catch (err) {
    throw new InvalidFromPrior(`the issuer's long form does not resolve: ${err instanceof Error ? err.message : String(err)}`, "document");
  }
  if (longToShort(longForm) !== issuer.canonical) throw new InvalidFromPrior(`the evidence is ${longForm}'s, not ${issuer.presented}'s`, "document");
  if (!isPlainObject(document)) throw new InvalidFromPrior("the issuer document is an object", "document");
  return { id: longForm, document };
}

/**
 * The authentication method of the issuer's document that `kid` names:
 * the kid's DID portion names the issuer, the fragment matches byte for
 * byte, and the method is listed under `authentication`, by reference
 * or embedded.
 */
function authenticationMethod(documentId: string, document: Record<string, unknown>, kid: string): Method {
  const target = splitDidUrl(kid, "kid");
  const defined = new Map<string, Record<string, unknown>>();
  const methods = document["verificationMethod"];
  if (methods !== undefined) {
    if (!Array.isArray(methods)) throw new InvalidFromPrior("verificationMethod is an array", "document");
    for (const method of methods) {
      if (!isPlainObject(method) || typeof method["id"] !== "string") throw new InvalidFromPrior("a verification method is an object with an id", "document");
      defined.set(relativeTo(method["id"], documentId), method);
    }
  }
  const authentication = document["authentication"];
  if (!Array.isArray(authentication)) throw new InvalidFromPrior("the document lists authentication methods", "document");
  for (const entry of authentication) {
    let id: string;
    let method: Record<string, unknown> | undefined;
    if (typeof entry === "string") {
      id = relativeTo(entry, documentId);
      method = defined.get(id);
    } else if (isPlainObject(entry) && typeof entry["id"] === "string") {
      id = relativeTo(entry["id"], documentId);
      method = entry;
    } else {
      throw new InvalidFromPrior("an authentication entry is a DID URL or an embedded method", "document");
    }
    const hash = id.indexOf("#");
    if (hash < 0) continue;
    let did: DidSpelling;
    try {
      did = canonicalDid(id.slice(0, hash), "a method id");
    } catch {
      continue;
    }
    if (did.canonical !== target.did.canonical || id.slice(hash + 1) !== target.fragment) continue;
    if (method === undefined) throw new InvalidFromPrior(`${id} is authorized but not defined`, "document");
    return { id: kid, key: ed25519Jwk(method, id) };
  }
  throw new InvalidFromPrior(`${kid} is not an authentication method of ${documentId}`, "document");
}

function profileChange(claims: UnverifiedFromPrior["claims"], issuer: DidSpelling): VerifiedChange {
  if (claims.sub !== undefined) {
    const successor = canonicalDid(claims.sub, "sub");
    if (successor.canonical === issuer.canonical) throw profile("sub is another DID than iss");
    if (claims.aud !== undefined) throw profile("a rotation names no aud");
    return { kind: "rotate", successor };
  }
  const audience = claims.aud === undefined ? null : canonicalDid(claims.aud, "aud");
  if (audience !== null && audience.canonical === issuer.canonical) throw profile("aud is another DID than iss");
  return { kind: "end", audience };
}

/**
 * Verify a token against the issuer's retained long form: the protected
 * `kid` names an authentication method of the document that long form
 * encodes, that method's Ed25519 key verifies the JWS, and the claims
 * the signature covers meet the profile. The library verifies the
 * signature only; the profile has no time-bound claim and consults no
 * clock. The token and long form are retained as given; a failure
 * says whether form, profile, document or signature failed.
 */
export async function verifyFromPrior(jwt: string, evidence: IssuerEvidence): Promise<VerifiedFromPrior> {
  const unverified = inspectFromPrior(jwt);
  if (unverified.header.alg !== FROM_PRIOR_ALG) throw profile(`alg is ${FROM_PRIOR_ALG}`);
  if (!isJwtType(unverified.header.typ)) throw profile("typ, when present, is JWT or application/jwt");
  const issuer = canonicalDid(unverified.claims.iss, "iss");
  const kid = splitDidUrl(unverified.header.kid, "kid");
  if (kid.did.canonical !== issuer.canonical) throw profile("the kid names a key of iss");
  const { id: documentId, document } = issuerDocument(evidence, issuer);
  const method = authenticationMethod(documentId, document, unverified.header.kid);
  const key = await importJWK(method.key, FROM_PRIOR_ALG);
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(jwt, key, { algorithms: [FROM_PRIOR_ALG] }));
  } catch (err) {
    throw new InvalidFromPrior(`the signature does not verify under ${method.id}: ${err instanceof Error ? err.message : String(err)}`, "signature");
  }
  const claims = verifiedClaims(payload);
  const signedIssuer = canonicalDid(claims.iss, "iss");
  return {
    [verified]: true,
    profile: FROM_PRIOR_PROFILE,
    token: jwt,
    issuer: signedIssuer,
    change: profileChange(claims, signedIssuer),
    iat: claims.iat,
    document: { ref: evidence.ref, longForm: documentId },
    method: method.id,
  } as VerifiedFromPrior;
}

/**
 * Bind a verified proof to the receipt it arrived on. A rotation binds
 * when the receipt carries this very token and its authenticated
 * sender is the successor: the peer of C(recipient, issuer) became the
 * successor, and the successor wrote to the recipient. An ending binds
 * when the receipt is anonymous and the proof names the recipient as
 * its audience. Anything else binds nothing.
 */
export function bindFromPrior(proof: VerifiedFromPrior, receipt: ReceiptEvidence, ids: BindingIds): Binding {
  if (receipt.token !== proof.token) return { status: "mismatch", because: "the receipt carries another token than the proof" };
  let recipient: DidSpelling;
  let sender: DidSpelling | null;
  try {
    recipient = canonicalDid(receipt.recipient, "the recipient");
    sender = receipt.sender === null ? null : canonicalDid(receipt.sender, "the sender");
  } catch (err) {
    return { status: "mismatch", because: err instanceof Error ? err.message : String(err) };
  }
  if (recipient.canonical === proof.issuer.canonical) return { status: "mismatch", because: "the recipient is the issuer" };
  const at = { localDid: recipient.canonical, peerDid: proof.issuer.canonical };
  if (proof.change.kind === "rotate") {
    const successor = proof.change.successor;
    if (sender === null) return { status: "mismatch", because: "a rotation arrives from an authenticated sender" };
    if (sender.canonical !== successor.canonical) return { status: "mismatch", because: `sub is ${successor.presented} but the sender is ${sender.presented}` };
    if (recipient.canonical === successor.canonical) return { status: "mismatch", because: "the recipient is the successor" };
    const facts: ContinuityFact[] = [{ kind: "peer-transition", id: ids.transitionId, at, change: { kind: "rotate", successor: successor.canonical }, receipt: receipt.ref }];
    if (ids.observationId !== undefined) {
      facts.push({ kind: "address-observed", id: ids.observationId, at: { localDid: recipient.canonical, peerDid: successor.canonical }, carriedTransition: ids.transitionId, receipt: receipt.ref });
    }
    return { status: "bound", facts };
  }
  if (sender !== null) return { status: "mismatch", because: "an ending arrives without a sender" };
  if (proof.change.audience === null) return { status: "unbound", because: "the ending names no audience; this profile binds an ending only to the recipient it names" };
  if (proof.change.audience.canonical !== recipient.canonical) return { status: "mismatch", because: `aud is ${proof.change.audience.presented} but the recipient is ${recipient.presented}` };
  return { status: "bound", facts: [{ kind: "peer-transition", id: ids.transitionId, at, change: { kind: "end" }, receipt: receipt.ref }] };
}

const encoder = new TextEncoder();

function segment(value: unknown): string {
  return base64urlnopad.encode(encoder.encode(JSON.stringify(value)));
}

/**
 * Create a proof of the requested change and verify it against the
 * issuer evidence before returning it: the signer's method must be an
 * authentication method of the issuer's document and its signature
 * must verify under that method's key. The result is what the host
 * saves with its decision; creating it decides and sends nothing.
 */
export async function createFromPrior(request: ProofRequest, signer: Signer): Promise<VerifiedFromPrior> {
  const issuer = canonicalDid(request.issuer, "the issuer");
  if (!Number.isSafeInteger(request.iat)) throw profile("iat is an integer");
  const claims: Record<string, unknown> = { iss: issuer.presented };
  if (request.change.kind === "rotate") {
    const successor = canonicalDid(request.change.successor, "the successor");
    if (successor.canonical === issuer.canonical) throw profile("the successor is another DID than the issuer");
    claims["sub"] = successor.presented;
  } else {
    const audience = canonicalDid(request.change.audience, "the audience");
    if (audience.canonical === issuer.canonical) throw profile("the audience is another DID than the issuer");
    claims["aud"] = audience.presented;
  }
  claims["iat"] = request.iat;
  const signingInput = `${segment({ alg: FROM_PRIOR_ALG, typ: "JWT", kid: signer.methodId })}.${segment(claims)}`;
  const signature = await signer.sign(encoder.encode(signingInput));
  if (!(signature instanceof Uint8Array)) throw new InvalidFromPrior("the signer returned no bytes", "signature");
  const token = `${signingInput}.${base64urlnopad.encode(signature)}`;
  const proof = await verifyFromPrior(token, request.evidence);
  const matches =
    proof.issuer.presented === request.issuer &&
    proof.iat === request.iat &&
    proof.method === signer.methodId &&
    (request.change.kind === "rotate" ? proof.change.kind === "rotate" && proof.change.successor.presented === request.change.successor : proof.change.kind === "end" && proof.change.audience?.presented === request.change.audience);
  if (!matches) throw new InvalidFromPrior("the created proof does not state the requested change", "profile");
  return proof;
}
