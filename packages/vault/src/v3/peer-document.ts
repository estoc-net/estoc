/**
 * A peer's DID document as the vault retains it. For a numalgo-4 DID
 * the retained document is fixed: the long form's own resolution
 * result, identified by the long form, with the short form appended to
 * `alsoKnownAs` and omitted controllers filled in — the same RFC 8785
 * bytes and CID whichever spelling the peer presents later. The
 * verification relationships of any retained document, numalgo 4 or
 * not, are read the same way: references resolved against the
 * document's `id`, keys taken from the exact retained entries.
 */

import { canonicalize, isJsonObject, type JsonObject } from "@estoc/event-store/v3";
import { PeerDID4Error, decodeLongForm, isLongForm, isShortForm, longToShort, resolveLongForm } from "@estoc/did-peer";

import { rawCidOfBytes } from "./document.js";
import { InvalidDidDocument, InvalidPublicKey } from "./errors.js";
import { canonicalPublicKey } from "./public-key.js";
import { isDid, isDidUrl } from "./syntax.js";
import type { Cid, Did, DidUrl, PublicKey } from "./types.js";

export type VerificationRelationship = "authentication" | "keyAgreement";

/** The retained resolution of one numalgo-4 long form: the canonical DID, the presented spelling, and the document as object, bytes and root. */
export type PeerResolution = { did: Did; presentedDid: Did; document: JsonObject; bytes: Uint8Array; cid: Cid };

const PEER4_PREFIX = "did:peer:4";

function inputDocumentOf(longFormDid: string): JsonObject {
  if (!isLongForm(longFormDid)) throw new InvalidDidDocument("not a did:peer:4 long form");
  try {
    return decodeLongForm(longFormDid) as JsonObject;
  } catch (err) {
    if (err instanceof PeerDID4Error) throw new InvalidDidDocument(err.message);
    throw err;
  }
}

/**
 * The DID a spelling names for folds and comparisons: a validated
 * numalgo-4 long form is its derived short form; every other DID is
 * the exact string, byte for byte.
 */
export function canonicalDidOf(presented: string): Did {
  if (!isDid(presented)) throw new InvalidDidDocument(`not a DID: ${JSON.stringify(presented)}`);
  if (!presented.startsWith(PEER4_PREFIX) || isShortForm(presented)) return presented as Did;
  inputDocumentOf(presented);
  return longToShort(presented) as Did;
}

/** The retained resolution of a numalgo-4 long form; a throw when the long form or its input document is not one. */
export function peerResolution(longFormDid: string): PeerResolution {
  const input = inputDocumentOf(longFormDid);
  const aliases = input["alsoKnownAs"];
  if (aliases !== undefined && !Array.isArray(aliases)) throw new InvalidDidDocument("alsoKnownAs is an array");
  const document = resolveLongForm(longFormDid) as JsonObject;
  let bytes: Uint8Array;
  try {
    bytes = canonicalize(document);
  } catch (err) {
    throw new InvalidDidDocument(`the document does not canonicalize: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { did: longToShort(longFormDid) as Did, presentedDid: longFormDid as Did, document, bytes, cid: rawCidOfBytes(bytes) };
}

/** The DID portion of a DID URL and everything after it, the path, query and fragment. */
export function splitDidUrl(url: string): [did: string, rest: string] {
  const end = url.search(/[/?#]/);
  return end < 0 ? [url, ""] : [url.slice(0, end), url.slice(end)];
}

function documentId(document: JsonObject): Did {
  const id = document["id"];
  if (!isDid(id)) throw new InvalidDidDocument("the document id is a DID");
  return id as Did;
}

/**
 * A reference as the document authorizes it, resolved against the
 * document's DID. Only fragment and query references resolve: a DID
 * has no path to resolve a path-relative reference against.
 */
function absolute(reference: unknown, base: Did, at: string): DidUrl {
  if (typeof reference !== "string") throw new InvalidDidDocument(`${at} is a DID URL`);
  const url = reference.startsWith("#") || reference.startsWith("?") ? base + reference : reference;
  if (!isDidUrl(url) || !url.startsWith("did:")) throw new InvalidDidDocument(`${at} is a DID URL or a fragment reference: ${JSON.stringify(reference)}`);
  return url as DidUrl;
}

function entriesOf(document: JsonObject, member: string): readonly unknown[] {
  const entries = document[member];
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new InvalidDidDocument(`${member} is an array`);
  return entries;
}

const RELATIONSHIPS = ["authentication", "assertionMethod", "keyAgreement", "capabilityDelegation", "capabilityInvocation"] as const;

/** Every method the document defines, by absolute ID; two definitions under one ID must be the same entry. */
function definedMethods(document: JsonObject, base: Did): Map<DidUrl, JsonObject> {
  const methods = new Map<DidUrl, JsonObject>();
  const define = (entry: unknown, at: string) => {
    if (!isJsonObject(entry)) return;
    const id = absolute(entry["id"], base, `${at}.id`);
    const known = methods.get(id);
    if (known !== undefined && canonicalText(known) !== canonicalText(entry)) throw new InvalidDidDocument(`two different verification methods are ${id}`);
    methods.set(id, entry);
  };
  entriesOf(document, "verificationMethod").forEach((entry, i) => define(entry, `verificationMethod[${i}]`));
  for (const relationship of RELATIONSHIPS) entriesOf(document, relationship).forEach((entry, i) => define(entry, `${relationship}[${i}]`));
  return methods;
}

const decoder = new TextDecoder();

function canonicalText(value: JsonObject): string {
  return decoder.decode(canonicalize(value));
}

/**
 * The absolute IDs of the methods a relationship authorizes, each once
 * in document order: a reference resolved against the document's DID,
 * or an embedded method's own ID. A reference into this document must
 * name a method it defines; a reference into another DID is kept as
 * authorized without a key.
 */
export function authorizedMethodIds(document: JsonObject, relationship: VerificationRelationship): DidUrl[] {
  const base = documentId(document);
  const defined = definedMethods(document, base);
  const ids = new Set<DidUrl>();
  entriesOf(document, relationship).forEach((entry, i) => {
    const at = `${relationship}[${i}]`;
    let id: DidUrl;
    if (typeof entry === "string") {
      id = absolute(entry, base, at);
      if (splitDidUrl(id)[0] === base && !defined.has(id)) throw new InvalidDidDocument(`${at} references no verification method: ${id}`);
    } else if (isJsonObject(entry)) {
      id = absolute(entry["id"], base, `${at}.id`);
    } else {
      throw new InvalidDidDocument(`${at} is a reference or an embedded verification method`);
    }
    ids.add(id);
  });
  return [...ids];
}

/** The canonical public key of the method the document defines under an absolute ID. */
export function methodPublicKey(document: JsonObject, id: DidUrl): PublicKey {
  const method = definedMethods(document, documentId(document)).get(id);
  if (method === undefined) throw new InvalidDidDocument(`the document defines no verification method ${id}`);
  const multibase = method["publicKeyMultibase"];
  const jwk = method["publicKeyJwk"];
  const key = typeof multibase === "string" && jwk === undefined ? multibase : isJsonObject(jwk) && multibase === undefined ? jwk : null;
  if (key === null) throw new InvalidDidDocument(`${id} carries one of publicKeyMultibase and publicKeyJwk`);
  try {
    return canonicalPublicKey(key);
  } catch (err) {
    if (err instanceof InvalidPublicKey) throw new InvalidDidDocument(`${id}: ${err.message}`);
    throw err;
  }
}
