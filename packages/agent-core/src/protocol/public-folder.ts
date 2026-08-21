import bs58 from "bs58";

import { base64urlToBytes, base64urlToUtf8 } from "@estoc/did-peer";
import type { DIDDoc } from "@estoc/did-peer";
import {
  decodeDirNode,
  resolvePath,
  verifyCard,
  type DirEntry,
  type Resolved,
  type RootCard,
} from "@estoc/signed-dir";
import { deriveIdentity, generateSeed, importSeed } from "@estoc/keystore";

import { mintPeerDid } from "../identity/peer.js";
import {
  ENCRYPTED_MIME,
  didOf,
  endpointOf,
  plainMessage,
  secretsResolverFor,
  serviceUris,
  type DidcommApi,
  type IMessage,
} from "./didcomm.js";
import { resolveDid as defaultResolveDid } from "./resolver.js";

/**
 * public-folder/1.0 — https://didcomm.org/public-folder/1.0 — the reader
 * role, and the wire vocabulary the owner role in `Agent` shares.
 *
 * Reading is trustless: whatever channel the pieces arrive by, trust comes
 * from verifying the owner's signed root card and hashing every object
 * against the CID that named it (`verifyPublicFolder`). The default
 * channel is plain HTTP against the relay's trustless endpoints
 * (`readPublicFolder`) — zero DIDs, zero envelopes, works from a browser
 * fetch. The DIDComm `query` form (`queryPublicFolder`) is the protocol's
 * own read channel; it needs a DID only as a return mailbox, so it mints a
 * one-time in-memory did:peer:4 per call — never a DID that exists for any
 * other purpose, so reads stay unlinkable to each other and to any
 * relationship, and no ecosystem grows up treating reader DIDs as
 * identities.
 *
 * Everything here is a free function over what is passed in: no vault, no
 * agent, no storage. The owner side (signing, publishing, renewal) lives
 * on `Agent`, because publishing is a conversation with one's own
 * mediator.
 */

export const PUBLIC_FOLDER_QUERY = "https://didcomm.org/public-folder/1.0/query";
export const PUBLIC_FOLDER_ANSWER = "https://didcomm.org/public-folder/1.0/answer";
export const PUBLIC_FOLDER_PUBLISH = "https://didcomm.org/public-folder/1.0/publish";
export const PUBLIC_FOLDER_PUBLISH_RESULT =
  "https://didcomm.org/public-folder/1.0/publish-result";
export const PUBLIC_FOLDER_PUBLISHED =
  "https://didcomm.org/public-folder/1.0/published";
export const PROBLEM_REPORT = "https://didcomm.org/report-problem/2.0/problem-report";

export const RAW_MEDIA_TYPE = "application/vnd.ipld.raw";
export const DAG_JSON_MEDIA_TYPE = "application/vnd.ipld.dag-json";

type ResolveDid = (did: string) => Promise<DIDDoc | null>;

/**
 * The raw Ed25519 key a card's kid names, out of a resolved DID document —
 * the kid must be one of the document's authentication methods. Handles
 * the two spellings our world uses: JWK (did:web documents) and Multikey
 * multibase (did:peer documents, base58btc with the ed25519-pub prefix).
 */
export function authenticationKeyOf(doc: DIDDoc, kid: string): Uint8Array | null {
  if (!doc.authentication.includes(kid)) {
    return null;
  }
  const method = doc.verificationMethod.find((m) => m.id === kid);
  if (method === undefined) {
    return null;
  }
  const jwk = method.publicKeyJwk as
    | { kty?: unknown; crv?: unknown; x?: unknown }
    | undefined;
  if (jwk?.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string") {
    return base64urlToBytes(jwk.x);
  }
  if (
    typeof method.publicKeyMultibase === "string" &&
    method.publicKeyMultibase.startsWith("z")
  ) {
    try {
      const decoded = bs58.decode(method.publicKeyMultibase.slice(1));
      if (decoded.length === 34 && decoded[0] === 0xed && decoded[1] === 0x01) {
        return decoded.slice(2);
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Decode a compact-JWS card's payload without verifying anything — for
 * reading a card one signed oneself (the vault's stored state). Anyone
 * else's card goes through `verifyPublicFolder`.
 */
export function decodeCard(jws: string): RootCard {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new Error("not a compact JWS");
  }
  let payload: Partial<RootCard>;
  try {
    payload = JSON.parse(base64urlToUtf8(parts[1] as string)) as Partial<RootCard>;
  } catch {
    throw new Error("malformed card payload");
  }
  if (
    typeof payload.did !== "string" ||
    typeof payload.id !== "string" ||
    typeof payload.expires !== "string" ||
    !(typeof payload.root === "string" || payload.root === null)
  ) {
    throw new Error("payload is not a root card");
  }
  return { did: payload.did, id: payload.id, expires: payload.expires, root: payload.root };
}

/** Fetches one object's bytes by CID, or null when it is not to be had. */
export type GetObject = (cid: string) => Promise<Uint8Array | null>;

export interface PublicFolderResult {
  /** the verified card */
  card: RootCard;
  /** past its `expires` — only ever seen with `allowStale` */
  stale: boolean;
  /** what the path named, hash-verified; null for a takedown card or a card-only read */
  resolved: Resolved | null;
  /** the directory listing, when `resolved` is a directory */
  entries: DirEntry[] | null;
}

export interface VerifyPublicFolderOptions {
  /** the owner being asked about — the card must be theirs */
  did: string;
  /** the root card, compact JWS */
  card: string;
  getObject: GetObject;
  /** slash-separated, relative to the root; absent or "" is the root directory */
  path?: string;
  /** stop after the card — the HEAD of the protocol */
  cardOnly?: boolean;
  resolveDid?: ResolveDid;
  /**
   * Accept a card past its `expires` (reported as `stale: true`). The
   * default refuses: a stale card is the one lie a relay can tell.
   */
  allowStale?: boolean;
  now?: Date;
}

/**
 * The trust core, transport-agnostic: given the owner's DID, a card, and a
 * way to fetch objects, end up with proven bytes or an error. Verification
 * order: the card's signature against the owner's own DID document (the
 * kid must be the queried DID's), then freshness (reader policy), then the
 * path — every hop hashed against the CID that named it, so `getObject`
 * needs no honesty, only availability.
 */
export async function verifyPublicFolder(
  options: VerifyPublicFolderOptions
): Promise<PublicFolderResult> {
  const resolve = options.resolveDid ?? defaultResolveDid;
  const { card, kid } = await verifyCard(options.card, async (kid) => {
    if (didOf(kid) !== options.did) {
      return null;
    }
    const doc = await resolve(options.did);
    return doc === null ? null : authenticationKeyOf(doc, kid);
  });
  if (didOf(kid) !== card.did || card.did !== options.did) {
    throw new Error("the card is not the queried DID's own");
  }
  const expiresAt = Date.parse(card.expires);
  if (Number.isNaN(expiresAt)) {
    throw new Error("the card's expires is not a timestamp");
  }
  const stale = (options.now ?? new Date()).getTime() > expiresAt;
  if (stale && options.allowStale !== true) {
    throw new Error(`the card for ${options.did} expired at ${card.expires}`);
  }
  if (card.root === null || options.cardOnly === true) {
    return { card, stale, resolved: null, entries: null };
  }
  const resolved = await resolvePath(card.root, options.path ?? "", options.getObject);
  return {
    card,
    stale,
    resolved,
    entries: resolved.kind === "dir" ? decodeDirNode(resolved.bytes) : null,
  };
}

/**
 * Where to ask about an owner: the relay is whatever the owner's own DID
 * document names as its routing service — a did:peer:4 carries its
 * document, so this resolves without any network for the DIDs we mint.
 * 1.0 adds nothing to the document; the mediator that routes the owner's
 * mail is the relay that serves their folder.
 */
export async function discoverRelay(
  ownerDid: string,
  resolveDid: ResolveDid = defaultResolveDid
): Promise<{ relayDid: string | null; httpUrl: string }> {
  const doc = await resolveDid(ownerDid);
  if (doc === null) {
    throw new Error(`${ownerDid} does not resolve`);
  }
  const uri = serviceUris(doc)[0];
  if (uri === undefined) {
    throw new Error(`${ownerDid} names no service; there is no relay to ask`);
  }
  if (uri.startsWith("did:")) {
    const relayDoc = await resolveDid(uri);
    if (relayDoc === null) {
      throw new Error(`the relay DID ${uri} does not resolve`);
    }
    const httpUrl = endpointOf(relayDoc, "http");
    if (httpUrl === null) {
      throw new Error(`the relay ${uri} has no HTTP endpoint`);
    }
    return { relayDid: uri, httpUrl };
  }
  // a service that is already a URL: readable over HTTP, but no DID to query
  return { relayDid: null, httpUrl: uri };
}

/** `GetObject` over the relay's trustless endpoint (`GET /objects/<cid>`). */
export function httpObjects(relayUrl: string, fetchFn: typeof fetch = fetch): GetObject {
  return async (cid) => {
    const response = await fetchFn(new URL(`/objects/${cid}`, relayUrl).href);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`the relay answered ${response.status} for object ${cid}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

export interface ReadPublicFolderOptions {
  did: string;
  path?: string;
  cardOnly?: boolean;
  /** the relay's base URL; discovered from the owner's DID document when absent */
  relayUrl?: string;
  fetch?: typeof fetch;
  resolveDid?: ResolveDid;
  allowStale?: boolean;
  now?: Date;
}

/**
 * The default read: plain HTTP against the relay's trustless endpoints.
 * No DID is minted, no envelope sealed — the response is untrusted bytes
 * that `verifyPublicFolder` proves, so the transport needs nothing from
 * the reader. Throws when the relay holds no card for the DID.
 */
export async function readPublicFolder(
  options: ReadPublicFolderOptions
): Promise<PublicFolderResult> {
  const fetchImpl = options.fetch ?? fetch;
  const fetchFn: typeof fetch = (input, init) => fetchImpl(input, init);
  const resolve = options.resolveDid ?? defaultResolveDid;
  const relayUrl =
    options.relayUrl ?? (await discoverRelay(options.did, resolve)).httpUrl;
  const response = await fetchFn(
    new URL(`/card/${encodeURIComponent(options.did)}`, relayUrl).href
  );
  if (response.status === 404) {
    throw new Error(`the relay holds no card for ${options.did}`);
  }
  if (!response.ok) {
    throw new Error(`the relay answered ${response.status} for the card`);
  }
  return verifyPublicFolder({
    did: options.did,
    card: await response.text(),
    getObject: httpObjects(relayUrl, fetchFn),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.cardOnly === undefined ? {} : { cardOnly: options.cardOnly }),
    resolveDid: resolve,
    ...(options.allowStale === undefined ? {} : { allowStale: options.allowStale }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export interface QueryPublicFolderOptions {
  did: string;
  path?: string;
  cardOnly?: boolean;
  didcomm: DidcommApi;
  /** the relay to ask; discovered from the owner's DID document when absent */
  relayDid?: string;
  fetch?: typeof fetch;
  resolveDid?: ResolveDid;
  allowStale?: boolean;
  now?: Date;
}

/**
 * The DIDComm read: `query` to the relay's own DID, the `answer` riding
 * the same HTTP response (`return_route: "all"`). The requester is a
 * one-time did:peer:4 minted from a random seed that lives exactly one
 * POST — a mailbox, not an identity. Attachments arrive with the CID as
 * their id; ones that came as links are fetched over HTTP, and either way
 * `verifyPublicFolder` hashes every hop, so nothing is taken on faith.
 */
export async function queryPublicFolder(
  options: QueryPublicFolderOptions
): Promise<PublicFolderResult> {
  const fetchImpl = options.fetch ?? fetch;
  const fetchFn: typeof fetch = (input, init) => fetchImpl(input, init);
  const resolve = options.resolveDid ?? defaultResolveDid;

  let relayDid = options.relayDid ?? null;
  if (relayDid === null) {
    relayDid = (await discoverRelay(options.did, resolve)).relayDid;
    if (relayDid === null) {
      throw new Error(`${options.did} names no relay DID to query`);
    }
  }
  const relayDoc = await resolve(relayDid);
  if (relayDoc === null) {
    throw new Error(`the relay DID ${relayDid} does not resolve`);
  }
  const httpUrl = endpointOf(relayDoc, "http");
  if (httpUrl === null) {
    throw new Error(`the relay ${relayDid} has no HTTP endpoint`);
  }

  // the one-time mailbox: a random seed, one derived key, zero storage
  const requester = mintPeerDid(
    await deriveIdentity(await importSeed(generateSeed()), "reader"),
    null
  );
  const resolver = { resolve };
  const query: IMessage = {
    ...plainMessage(PUBLIC_FOLDER_QUERY, requester.did, relayDid, {
      did: options.did,
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.cardOnly === undefined ? {} : { card_only: options.cardOnly }),
    }),
    return_route: "all",
  } as IMessage;
  const [packed] = await new options.didcomm.Message(query).pack_encrypted(
    relayDid,
    requester.did,
    null,
    resolver,
    secretsResolverFor(requester.secrets),
    { forward: false }
  );
  const response = await fetchFn(httpUrl, {
    method: "POST",
    headers: { "Content-Type": ENCRYPTED_MIME },
    body: packed,
  });
  if (!response.ok) {
    throw new Error(`the relay answered ${response.status} to the query`);
  }
  const [unpacked] = await options.didcomm.Message.unpack(
    await response.text(),
    resolver,
    secretsResolverFor(requester.secrets),
    {}
  );
  const answer = unpacked.as_value();

  if (answer.type === PROBLEM_REPORT) {
    const body = answer.body as { code?: string; comment?: string };
    throw new Error(
      `the relay refused the query: ${body.code ?? "unknown"}${body.comment ? ` — ${body.comment}` : ""}`
    );
  }
  if (answer.type !== PUBLIC_FOLDER_ANSWER) {
    throw new Error(`expected an answer, got ${answer.type}`);
  }
  const card = (answer.body as { card?: unknown }).card;
  if (typeof card !== "string") {
    throw new Error("the answer carries no card");
  }

  const attachments = new Map<string, { base64?: string; links?: string[] }>();
  for (const attachment of answer.attachments ?? []) {
    const { id, data } = attachment as {
      id?: string;
      data?: { base64?: string; links?: string[] };
    };
    if (typeof id === "string" && data !== undefined) {
      attachments.set(id, data);
    }
  }
  const getObject: GetObject = async (cid) => {
    const data = attachments.get(cid);
    if (data === undefined) {
      return null;
    }
    if (typeof data.base64 === "string") {
      return base64urlToBytes(data.base64);
    }
    const link = data.links?.[0];
    if (link === undefined) {
      return null;
    }
    const fetched = await fetchFn(link);
    if (!fetched.ok) {
      throw new Error(`the relay answered ${fetched.status} for linked object ${cid}`);
    }
    return new Uint8Array(await fetched.arrayBuffer());
  };

  return verifyPublicFolder({
    did: options.did,
    card,
    getObject,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.cardOnly === undefined ? {} : { cardOnly: options.cardOnly }),
    resolveDid: resolve,
    ...(options.allowStale === undefined ? {} : { allowStale: options.allowStale }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
