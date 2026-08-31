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
 * spell one out. A field that is not there is absent or null: the
 * binding hands back null for a key that did not take part, and both
 * read the same here.
 */
export interface Unpacked {
  encrypted: boolean;
  non_repudiation: boolean;
  /** authcrypt: the key that sealed it, as a kid */
  encrypted_from_kid?: string | null;
  /** encrypted: the keys it was sealed to, as kids */
  encrypted_to_kids?: string[] | null;
  /** signed: the key that signed it, as a kid */
  sign_from?: string | null;
}

/** A kid the metadata names, or undefined for one it does not — however the binding spelled the absence. */
function kidIn(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

/** A key of ours by the DID it is under — the keyring's `keyOfDid`; null for a DID that is no one of ours. */
export type KeyOfDid = (did: string) => string | null;

/** What an envelope proves (§3): the pair, the kind, and the keys behind them. */
export interface Proved {
  pair: ChannelKey;
  kind: EnvelopeKind;
  /** the peer's full public key as its document lists it, multibase; present exactly when `peerKey` is */
  peerPublicKey?: string;
  /** authcrypt: a key that also signed the plaintext, as its document lists it (§3.1 `signedBy`) */
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
  if (kidIn(metadata.encrypted_from_kid) !== undefined) {
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
 * The DID of a signature that rode inside authcrypt (§3.1 `signedBy`):
 * `sign_from`'s, which may not be the sender's — then its document is
 * the second one to resolve before `inboundPair`. Null when no signature
 * rode inside authcrypt.
 */
export function signerOf(metadata: Unpacked): string | null {
  return envelopeKind(metadata) === "authcrypt" && metadata.non_repudiation ? didOf(metadata.sign_from) : null;
}

/**
 * The channel an inbound envelope proves: `myKey` the key of ours that
 * opened it, `peerKey` the fingerprint of the key that sealed it
 * (authcrypt) or signed it (signed), looked up in the sender's document —
 * the DID the kid names, which is what `unpack` verified against. A
 * signature inside authcrypt is named from the document of its own kid's
 * DID: the sender's when that is the sender, else `signerDoc`, the
 * document of `signerOf`'s DID — a document may list a method under
 * another DID's id, and only the DID's own document says what key that
 * is. Null for a plaintext. Throws when a kid names no key we can see:
 * sealed to no DID of ours, a document that is not its DID's, or a
 * sealing or signing key it does not list.
 */
export function inboundPair(metadata: Unpacked, senderDoc: DIDDoc | null, keyOfDid: KeyOfDid, signerDoc: DIDDoc | null = null): Proved | null {
  const kind = envelopeKind(metadata);
  if (kind === null) {
    return null;
  }
  const myKey = openedWith(metadata.encrypted_to_kids ?? [], keyOfDid);
  if (kind === "anoncrypt") {
    return { pair: { myKey, peerKey: null }, kind };
  }
  const kid = kidIn(kind === "authcrypt" ? metadata.encrypted_from_kid : metadata.sign_from);
  if (kid === undefined) {
    throw new Error(`${kind} by no kid`);
  }
  const peerPublicKey = publicKeyOfMethod(methodOf(senderDoc, kid));
  const proved: Proved = { pair: { myKey, peerKey: peerKeyOf(peerPublicKey) }, kind, peerPublicKey };
  const signature = kidIn(metadata.sign_from);
  if (kind === "authcrypt" && metadata.non_repudiation && signature !== undefined) {
    const own = didOf(signature) === didOf(kid);
    proved.signedBy = publicKeyOfMethod(methodOf(own ? senderDoc : signerDoc, signature));
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
 * (did:web's usual), or as base58 under a 2018/2019 suite — each checked
 * the same way, an Ed25519 or X25519 prefix over 32 bytes, and spelled
 * afresh. Null for a key this vault has no name for: another curve, a
 * malformed value.
 */
export function publicKeyOf(method: VerificationMethod): string | null {
  const multibase = method.publicKeyMultibase;
  if (multibase !== undefined) {
    if (!multibase.startsWith("z")) {
      return null;
    }
    const bytes = decoded(() => bs58.decode(multibase.slice(1)));
    if (bytes === null) {
      return null;
    }
    const prefix = [ED25519_PUB, X25519_PUB].find((known) => known[0] === bytes[0] && known[1] === bytes[1]) ?? null;
    return rawKey(prefix, () => bytes.slice(2));
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
  const bytes = decoded(decode);
  return bytes !== null && bytes.length === 32 ? multibaseKey(prefix, bytes) : null;
}

/** What `decode` yields, or null when the text was not what it claimed to be. */
function decoded(decode: () => Uint8Array): Uint8Array | null {
  try {
    return decode();
  } catch {
    return null;
  }
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

/** The method `kid` names, in the document of its own DID — no other document's word for it counts. */
function methodOf(doc: DIDDoc | null, kid: string): VerificationMethod {
  if (doc === null) {
    throw new Error(`no document for ${kid}`);
  }
  if (doc.id !== didOf(kid)) {
    throw new Error(`the document of ${doc.id} is not ${kid}'s`);
  }
  const method = doc.verificationMethod.find((entry) => entry.id === kid);
  if (method === undefined) {
    throw new Error(`${doc.id} lists no ${kid}`);
  }
  return method;
}
