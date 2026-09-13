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

import { canonicalText, canonicalize, isJsonObject, parseStrict, type JsonObject, type JsonValue } from "@estoc/event-store/v3";
import { PeerDID4Error, decodeLongForm, isLongForm, isShortForm, longToShort, validateInputDocument } from "@estoc/did-peer";
import { base58 } from "@scure/base";
import { varint } from "multiformats";

import { rawCidOfBytes } from "./document.js";
import { InvalidDidDocument, InvalidPublicKey } from "./errors.js";
import { canonicalPublicKey } from "./public-key.js";
import { isDid, isDidUrl } from "./syntax.js";
import type { Cid, Did, DidUrl, PublicKey } from "./types.js";

/** The retained resolution of one numalgo-4 long form: the canonical DID, the presented spelling, and the document as object, bytes and root. */
export type PeerResolution = { did: Did; presentedDid: Did; document: JsonObject; bytes: Uint8Array; cid: Cid };

const PEER4_PREFIX = "did:peer:4";
const MULTICODEC_JSON = 0x0200;

export type VerificationRelationship = "authentication" | "keyAgreement";
const RELATIONSHIPS = ["authentication", "assertionMethod", "keyAgreement", "capabilityDelegation", "capabilityInvocation"] as const;

function shaped(document: JsonObject): void {
  const arrayOf = (member: string, each: (entry: unknown) => boolean, what: string) => {
    const entries = document[member];
    if (entries === undefined) return;
    if (!Array.isArray(entries) || !entries.every(each)) throw new InvalidDidDocument(`${member} is an array of ${what}`);
  };
  const withId = (entry: unknown) => isJsonObject(entry) && typeof entry["id"] === "string";
  arrayOf("alsoKnownAs", (entry) => typeof entry === "string", "strings");
  arrayOf("verificationMethod", withId, "verification methods with an id");
  arrayOf("service", withId, "services with an id");
  for (const relationship of RELATIONSHIPS) arrayOf(relationship, (entry) => typeof entry === "string" || withId(entry), "references or embedded verification methods");
}

/**
 * The input document a validated long form encodes. The method's own
 * decoder checks the hash; the document is then read again from the
 * raw bytes under the event format's strict JSON, since a lenient parse
 * would retain a document another implementation refuses, with invalid
 * UTF-8 replaced and a duplicated member's last value kept.
 */
function inputDocumentOf(longFormDid: string): JsonObject {
  if (!isLongForm(longFormDid)) throw new InvalidDidDocument("not a did:peer:4 long form");
  try {
    decodeLongForm(longFormDid);
  } catch (err) {
    if (err instanceof PeerDID4Error) throw new InvalidDidDocument(err.message);
    throw err;
  }
  const encoded = base58.decode(longFormDid.slice(longFormDid.lastIndexOf(":") + 2));
  const [code, length] = varint.decode(encoded);
  if (code !== MULTICODEC_JSON) throw new InvalidDidDocument("the encoded document is not multicodec-tagged JSON");
  let input: unknown;
  try {
    input = parseStrict(encoded.subarray(length));
  } catch (err) {
    throw new InvalidDidDocument(`the input document is not strict JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isJsonObject(input)) throw new InvalidDidDocument("the input document is a JSON object");
  try {
    validateInputDocument(input);
  } catch (err) {
    if (err instanceof PeerDID4Error) throw new InvalidDidDocument(err.message);
    throw err;
  }
  shaped(input);
  return input;
}

/**
 * The DID a spelling names for folds and comparisons: a validated
 * numalgo-4 long form is its derived short form; every other DID is
 * the exact string, byte for byte.
 */
export function canonicalDidOf(presented: string): Did {
  if (!isDid(presented)) throw new InvalidDidDocument(`not a DID: ${JSON.stringify(presented)}`);
  if (!presented.startsWith(PEER4_PREFIX) || isShortForm(presented)) return presented as Did;
  retainedDocumentOf(presented);
  return longToShort(presented) as Did;
}

/** The fill of an omitted `controller` on a method the document defines, listed or embedded. */
function controlled(entry: JsonValue, did: Did): JsonValue {
  return isJsonObject(entry) && entry["controller"] === undefined ? { ...entry, controller: did } : entry;
}

/**
 * The document a validated long form resolves to, as retained; a throw
 * when the long form or its input document is not one. It is the long
 * form's own resolution result: identified by the long form, the short
 * form appended to `alsoKnownAs`, omitted controllers filled in and
 * everything else, relative references included, kept as the input has
 * it. Its verification relationships must read: every reference into
 * the document names a method it defines.
 */
function retainedDocumentOf(longFormDid: string): JsonObject {
  const input = inputDocumentOf(longFormDid);
  const long = longFormDid as Did;
  const document: JsonObject = { ...input, id: long, alsoKnownAs: [...((input["alsoKnownAs"] as string[] | undefined) ?? []), longToShort(longFormDid)] };
  for (const member of ["verificationMethod", ...RELATIONSHIPS]) {
    const entries = input[member];
    if (Array.isArray(entries)) document[member] = entries.map((entry) => controlled(entry, long));
  }
  for (const relationship of ["authentication", "keyAgreement"] as const) authorizedMethodIds(document, relationship);
  return document;
}

/** The retained resolution of a numalgo-4 long form: its document under the RFC 8785 bytes and raw CID the vault stores it as. */
export function peerResolution(longFormDid: string): PeerResolution {
  const document = retainedDocumentOf(longFormDid);
  let bytes: Uint8Array;
  try {
    bytes = canonicalize(document);
  } catch (err) {
    throw new InvalidDidDocument(`the document does not canonicalize: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { did: longToShort(longFormDid) as Did, presentedDid: longFormDid as Did, document, bytes, cid: rawCidOfBytes(bytes) };
}

export function splitDidUrl(url: string): [did: string, pathQueryFragment: string] {
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

/**
 * The endpoint URIs of the document's DIDComm services, in document
 * order: `serviceEndpoint` as a string, as an object with a `uri`, or
 * as an array of either.
 */
export function didcommServiceUris(document: JsonObject): string[] {
  const uris: string[] = [];
  const uriOf = (endpoint: unknown, at: string): string => {
    if (typeof endpoint === "string") return endpoint;
    if (isJsonObject(endpoint) && typeof endpoint["uri"] === "string") return endpoint["uri"];
    throw new InvalidDidDocument(`${at} is a URI or an object with a uri`);
  };
  entriesOf(document, "service").forEach((service, i) => {
    if (!isJsonObject(service)) throw new InvalidDidDocument(`service[${i}] is an object`);
    const type = service["type"];
    if (type !== "DIDCommMessaging" && !(Array.isArray(type) && type.includes("DIDCommMessaging"))) return;
    const endpoint = service["serviceEndpoint"];
    const at = `service[${i}].serviceEndpoint`;
    if (Array.isArray(endpoint)) uris.push(...endpoint.map((entry, j) => uriOf(entry, `${at}[${j}]`)));
    else uris.push(uriOf(endpoint, at));
  });
  return uris;
}
