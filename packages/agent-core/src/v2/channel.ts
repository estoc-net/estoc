/**
 * The channel an envelope proves (vault-events.md §3): from the key that
 * opened it and the key that sealed or signed it, the pair, the kind and
 * the peer's full key; from a document, what else the DID lists
 * (`peer.resolved`, §3.1). Pure functions over didcomm-rust's unpack
 * metadata and the flat `DIDDoc` a resolver hands back — nothing here
 * reads the vault or the network, and no DID is in a pair: a DID is a
 * name a key wears.
 */

import bs58 from "bs58";

import type { DIDDoc, VerificationMethod } from "@estoc/did-peer";
import { base64urlToBytes } from "@estoc/did-peer";
import { peerKeyOf, type ChannelKey, type EnvelopeKind, type PeerResolved } from "@estoc/vault/v2";

import { ED25519_PUB, X25519_PUB, multibaseKey } from "../identity/peer.js";
import { didOf } from "../protocol/didcomm.js";

/**
 * What `unpack` says of the envelope it opened, the fields a channel is
 * read from: didcomm's `UnpackMetadata`, narrowed so that a test can
 * spell one out.
 */
export interface Unpacked {
  encrypted: boolean;
  non_repudiation: boolean;
  /** authcrypt: the key that sealed it, as a kid */
  encrypted_from_kid?: string;
  /** encrypted: the keys it was sealed to, as kids */
  encrypted_to_kids?: string[];
  /** signed: the key that signed it, as a kid */
  sign_from?: string;
}

/** A key of ours by the DID it is under — the keyring's `keyOfDid`; null for a DID that is no one of ours. */
export type KeyOfDid = (did: string) => string | null;

/** What an envelope proves (§3): the pair, the kind, and the keys behind them. */
export interface Proved {
  pair: ChannelKey;
  kind: EnvelopeKind;
  /** the peer's full public key as its document lists it, multibase; present exactly when `peerKey` is */
  peerPublicKey?: string;
  /** authcrypt: a key that also signed the plaintext, as the sender's document lists it (§3.1 `signedBy`) */
  signedBy?: string;
}

/**
 * The kind of channel an envelope opens (§3): what it proved of its
 * sender. Sealed by a key of theirs is `authcrypt`, whether or not a
 * signature rode inside; signed by one and sealed by no one is `signed`,
 * bare or inside anoncrypt; sealed to us by no one and unsigned is
 * `anoncrypt`. Null: a plaintext proves no one and opens no channel.
 */
export function envelopeKind(metadata: Unpacked): EnvelopeKind | null {
  if (metadata.encrypted_from_kid !== undefined) {
    return "authcrypt";
  }
  if (metadata.non_repudiation) {
    return "signed";
  }
  return metadata.encrypted ? "anoncrypt" : null;
}

/**
 * The DID the proving key wears (§3.1 `did`): `encrypted_from_kid`'s,
 * else `sign_from`'s — the document to resolve before `inboundPair`.
 * Null when no key of theirs proved anything.
 */
export function senderOf(metadata: Unpacked): string | null {
  switch (envelopeKind(metadata)) {
    case "authcrypt":
      return didOf(metadata.encrypted_from_kid);
    case "signed":
      return didOf(metadata.sign_from);
    default:
      return null;
  }
}

/**
 * The channel an inbound envelope proves: `myKey` the key of ours that
 * opened it, `peerKey` the fingerprint of the key that sealed it
 * (authcrypt) or signed it (signed), looked up in the sender's document —
 * the DID the kid names, which is what `unpack` verified against. Null
 * for a plaintext. Throws when a kid names no key we can see: sealed to
 * no DID of ours, or a sealing or signing key the sender's document does
 * not list.
 */
export function inboundPair(metadata: Unpacked, senderDoc: DIDDoc | null, keyOfDid: KeyOfDid): Proved | null {
  const kind = envelopeKind(metadata);
  if (kind === null) {
    return null;
  }
  const myKey = openedWith(metadata.encrypted_to_kids ?? [], keyOfDid);
  if (kind === "anoncrypt") {
    return { pair: { myKey, peerKey: null }, kind };
  }
  const kid = kind === "authcrypt" ? metadata.encrypted_from_kid : metadata.sign_from;
  if (kid === undefined) {
    throw new Error(`${kind} by no kid`);
  }
  const peerPublicKey = publicKeyOfMethod(methodOf(senderDoc, kid));
  const proved: Proved = { pair: { myKey, peerKey: peerKeyOf(peerPublicKey) }, kind, peerPublicKey };
  if (kind === "authcrypt" && metadata.non_repudiation && metadata.sign_from !== undefined) {
    // a signature by a key of another DID is verified by unpack, and not the sender's document's to name
    const signer = findMethod(senderDoc, metadata.sign_from);
    if (signer !== null) {
      proved.signedBy = publicKeyOfMethod(signer);
    }
  }
  return proved;
}

/**
 * The channel an outbound envelope will prove, sealed from `myKey` (null:
 * anonymously) to the first key agreement key `toDoc` lists — §11's
 * working rule. Throws when the document lists none.
 */
export function outboundPair(myKey: string | null, toDoc: DIDDoc): Proved {
  const kid = toDoc.keyAgreement[0];
  if (kid === undefined) {
    throw new Error(`no key agreement key: ${toDoc.id}`);
  }
  const peerPublicKey = publicKeyOfMethod(methodOf(toDoc, kid));
  return { pair: { myKey, peerKey: peerKeyOf(peerPublicKey) }, kind: myKey === null ? "anoncrypt" : "authcrypt", peerPublicKey };
}

/**
 * The `peer.resolved` line for a document seen under `did` on a channel
 * (§3.1): every key it lists that this vault can name, in the document's
 * order, and its first service's uri. Context for the fold, never an
 * edge (§7.1).
 */
export function resolvedOf(pair: ChannelKey, did: string, doc: DIDDoc): PeerResolved {
  const keys: string[] = [];
  for (const method of doc.verificationMethod) {
    const key = publicKeyOf(method);
    if (key !== null) {
      keys.push(key);
    }
  }
  const endpoint = doc.service[0]?.serviceEndpoint;
  const service = endpoint === undefined ? null : typeof endpoint === "string" ? endpoint : endpoint.uri;
  return { myKey: pair.myKey, peerKey: pair.peerKey, did, keys, service };
}

/**
 * A verification method's public key as the multibase a document lists
 * (`z…`, what a `did:key` encodes): given as such, or as an OKP JWK
 * (did:web's usual), or as base58 under a 2018/2019 suite. Null for a
 * key this vault has no name for — another curve, a malformed value.
 */
export function publicKeyOf(method: VerificationMethod): string | null {
  if (method.publicKeyMultibase !== undefined) {
    return method.publicKeyMultibase;
  }
  const jwk = method.publicKeyJwk;
  if (jwk !== undefined) {
    const x = jwk["x"];
    if (jwk["kty"] !== "OKP" || typeof x !== "string") {
      return null;
    }
    return rawKey(jwk["crv"] === "Ed25519" ? ED25519_PUB : jwk["crv"] === "X25519" ? X25519_PUB : null, () => base64urlToBytes(x));
  }
  const base58 = method.publicKeyBase58;
  if (base58 !== undefined) {
    const prefix = method.type === "Ed25519VerificationKey2018" ? ED25519_PUB : method.type === "X25519KeyAgreementKey2019" ? X25519_PUB : null;
    return rawKey(prefix, () => bs58.decode(base58));
  }
  return null;
}

/** As `publicKeyOf`, throwing for a key this vault has no name for. */
export function publicKeyOfMethod(method: VerificationMethod): string {
  const key = publicKeyOf(method);
  if (key === null) {
    throw new Error(`no key this vault can name: ${method.id}`);
  }
  return key;
}

/** The peer key (§3) of a verification method: the fingerprint of the key it lists. */
export function peerKeyOfMethod(method: VerificationMethod): string {
  return peerKeyOf(publicKeyOfMethod(method));
}

/** A raw 32-byte key under its prefix, as multibase; null when the prefix is none of ours or the bytes are not a key. */
function rawKey(prefix: number[] | null, decode: () => Uint8Array): string | null {
  if (prefix === null) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = decode();
  } catch {
    return null;
  }
  return bytes.length === 32 ? multibaseKey(prefix, bytes) : null;
}

/** The key of ours an envelope was opened with: the first of the kids it was sealed to that is under a DID of ours. */
function openedWith(kids: readonly string[], keyOfDid: KeyOfDid): string | null {
  if (kids.length === 0) {
    return null;
  }
  for (const kid of kids) {
    const did = didOf(kid);
    const name = did === null ? null : keyOfDid(did);
    if (name !== null) {
      return name;
    }
  }
  throw new Error(`sealed to no key of ours: ${kids.join(", ")}`);
}

function findMethod(doc: DIDDoc | null, kid: string): VerificationMethod | null {
  return doc?.verificationMethod.find((method) => method.id === kid) ?? null;
}

function methodOf(doc: DIDDoc | null, kid: string): VerificationMethod {
  const method = findMethod(doc, kid);
  if (method === null) {
    throw new Error(doc === null ? `no document for ${kid}` : `${doc.id} lists no ${kid}`);
  }
  return method;
}
