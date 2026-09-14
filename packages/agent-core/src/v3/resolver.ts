/**
 * A presented DID resolved to the exact evidence the vault retains of
 * a peer: the presented spelling, the canonical DID, the document as
 * the object store keeps it — RFC 8785 bytes under their raw CID —
 * the methods it authorizes for authentication and key agreement, and
 * the DIDComm service it names. Two methods are supported. A Peer DID
 * numalgo 4 carries its document in its long form and resolves without
 * a network; its short form resolves only through a long form already
 * in evidence. A `did:web` is fetched, under a policy that refuses what
 * a fetch from an agent must never do — reach an address the DID
 * itself does not name, follow a redirect, read without bound — and
 * its document must call itself by the presented string, byte for
 * byte: the spelling is the identity, whatever URL or DNS processing
 * the fetch went through.
 *
 * Every failure is one of two kinds, and the difference decides what
 * the caller does next: `unavailable` is no answer now — the network,
 * a timeout, a retryable status — and leaves the work retryable;
 * `definitive` is an answer that closes the attempt — not found, not
 * a document, another DID's, forbidden by policy.
 *
 * `web-did-resolver` is not used here: it fetches through its own
 * transport, follows redirects and reads without a bound, none of
 * which this policy can reach into. The `did:web` URL derivation it
 * would provide is a few lines; the document checks are the vault's.
 */

import ipaddr from "ipaddr.js";

import { isLongForm, isPeerDID4, isShortForm } from "@estoc/did-peer";
import { InvalidJson, canonicalize, isJsonObject, parseStrict, type JsonObject } from "@estoc/event-store/v3";
import { InvalidDidDocument, authorizedMethodIds, canonicalDidOf, didcommServiceUris, peerResolution, rawCidOfBytes, type Cid, type Did, type DidUrl, type VaultFold } from "@estoc/vault/v3";

import type { AgentTrace } from "./trace.js";

/** A resolved peer document, in the exact form the vault retains and the folds check. */
export interface Resolution {
  /** the spelling that was resolved */
  presentedDid: Did;
  /** the DID for folds and comparisons: a numalgo-4 short form, any other DID as presented */
  did: Did;
  document: JsonObject;
  /** `UTF8(RFC8785(document))`: the retained object */
  bytes: Uint8Array;
  cid: Cid;
  authenticationMethodIds: DidUrl[];
  keyAgreementMethodIds: DidUrl[];
  /** the first DIDComm service endpoint the document names, or null */
  service: string | null;
}

export type Resolved = { outcome: "resolved"; resolution: Resolution } | { outcome: "unavailable"; reason: string } | { outcome: "definitive"; reason: string };

/** The long form of a numalgo-4 short form already in evidence, or null. */
export type KnownLongForms = (shortFormDid: Did) => Did | null;

export interface WebResolverOptions {
  /** the transport; the global by default */
  fetch?: typeof fetch;
  /** the most bytes a document may be; `MAX_DOCUMENT_BYTES` by default */
  maxBytes?: number;
  /** how long one fetch may take, connect to last byte; 10 s by default */
  timeoutMs?: number;
  /**
   * The host's own say on a hostname, beyond the syntactic policy
   * here: the reason it is refused, or null. A fetch API neither
   * exposes the addresses a name resolves to nor pins the connection
   * to them; a host that can look them up refuses here the names that
   * lead to a reserved range.
   */
  checkHost?: (hostname: string) => Promise<string | null> | string | null;
  /**
   * Plain HTTP to `localhost`, `127.0.0.1` or `[::1]`: a mediator run
   * on this machine for development. Every loopback name is refused
   * without it, and nothing else is ever fetched over HTTP.
   */
  insecureLoopback?: boolean;
}

export interface ResolverOptions extends WebResolverOptions {
  /** every network resolution goes to the `diag` stream */
  trace?: AgentTrace;
}

export const MAX_DOCUMENT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const DID_METHOD = /^did:([a-z0-9]+):/;
const WEB_PREFIX = "did:web:";
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** name suffixes that never name a public host: loopback, mDNS, private naming, reverse DNS */
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".in-addr.arpa", ".ip6.arpa"];
const RETRYABLE_STATUS = new Set([408, 429]);

function definitive(reason: string): Resolved {
  return { outcome: "definitive", reason };
}

function unavailable(reason: string): Resolved {
  return { outcome: "unavailable", reason };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The full resolution over a document the vault's rules accept, or a throw the caller classifies as definitive. */
function resolutionOf(presentedDid: Did, did: Did, document: JsonObject, bytes: Uint8Array, cid: Cid): Resolution {
  return {
    presentedDid,
    did,
    document,
    bytes,
    cid,
    authenticationMethodIds: authorizedMethodIds(document, "authentication"),
    keyAgreementMethodIds: authorizedMethodIds(document, "keyAgreement"),
    service: didcommServiceUris(document)[0] ?? null,
  };
}

/** A numalgo-4 DID from its validated long form, presented under either spelling. */
function resolvePeer(presented: string, known: KnownLongForms): Resolved {
  let longForm: string;
  if (isLongForm(presented)) {
    longForm = presented;
  } else if (isShortForm(presented)) {
    const found = known(presented as Did);
    if (found === null) return definitive(`no long form of ${presented} is in evidence`);
    longForm = found;
  } else {
    return definitive("not a did:peer:4 long or short form");
  }
  try {
    const { did, document, bytes, cid } = peerResolution(longForm);
    return { outcome: "resolved", resolution: resolutionOf(presented as Did, did, document, bytes, cid) };
  } catch (err) {
    if (err instanceof InvalidDidDocument) return definitive(err.message);
    throw err;
  }
}

/** The one URL a `did:web` is fetched from, or the reason its authority is refused before any network is touched. */
export function webDidUrl(did: string, insecureLoopback = false): { url: URL } | { refused: string } {
  if (!did.startsWith(WEB_PREFIX)) return { refused: "not a did:web" };
  let segments: string[];
  try {
    segments = did
      .slice(WEB_PREFIX.length)
      .split(":")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return { refused: "the method-specific ID is not percent-encoded" };
  }
  const [authority = "", ...path] = segments;
  if (authority === "" || /[@/?#\\]/.test(authority)) return { refused: "the authority is a host name and an optional port, nothing else" };
  for (const segment of path) {
    if (segment === "" || segment === "." || segment === ".." || /[/?#\\]/.test(segment)) return { refused: `the path segment ${JSON.stringify(segment)} is not one` };
  }
  let url: URL;
  try {
    url = new URL(`https://${authority}/`);
  } catch {
    return { refused: `the authority ${JSON.stringify(authority)} is not a host` };
  }
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const loopback = LOOPBACK_NAMES.has(url.hostname);
  if (loopback) {
    if (!insecureLoopback) return { refused: "a loopback authority" };
    url.protocol = "http:";
  } else if (ipaddr.isValid(hostname)) {
    return { refused: "an IP-literal authority" };
  } else if (RESERVED_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))) {
    return { refused: `a reserved name: ${url.hostname}` };
  }
  url.pathname = path.length === 0 ? "/.well-known/did.json" : `/${path.map((segment) => encodeURIComponent(segment)).join("/")}/did.json`;
  return { url };
}

/** The body, or null once it runs past `maxBytes`; what fails while reading is the transport's. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > maxBytes ? null : bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** A `did:web` fetched under the policy and checked to be its own: the presented string, byte for byte, as the document's `id`. */
async function resolveWeb(presented: string, options: ResolverOptions): Promise<Resolved> {
  try {
    canonicalDidOf(presented);
  } catch (err) {
    if (err instanceof InvalidDidDocument) return definitive(err.message);
    throw err;
  }
  const derived = webDidUrl(presented, options.insecureLoopback ?? false);
  if ("refused" in derived) return definitive(`the resolver policy refuses ${presented}: ${derived.refused}`);
  const { url } = derived;
  const refused = await options.checkHost?.(url.hostname);
  if (refused !== null && refused !== undefined) return definitive(`the resolver policy refuses ${url.hostname}: ${refused}`);
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_BYTES;
  const started = Date.now();
  const outcome = await fetchWeb(presented as Did, url, maxBytes, options);
  await options.trace?.append("diag", "resolve", { did: presented, url: url.href, outcome: outcome.outcome, ...(outcome.outcome === "resolved" ? { cid: outcome.resolution.cid } : { reason: outcome.reason }), ms: Date.now() - started });
  return outcome;
}

async function fetchWeb(presented: Did, url: URL, maxBytes: number, options: WebResolverOptions): Promise<Resolved> {
  const fetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), headers: { accept: "application/did+json, application/json" } });
  } catch (err) {
    return unavailable(`the fetch failed: ${messageOf(err)}`);
  }
  const { status } = response;
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) return definitive(`a redirect (${status}) is not followed`);
  if (RETRYABLE_STATUS.has(status) || status >= 500) return unavailable(`HTTP ${status}`);
  if (status === 404 || status === 410) return definitive(`HTTP ${status}: not found or deactivated`);
  if (status < 200 || status >= 300) return definitive(`HTTP ${status}`);
  let bytes: Uint8Array | null;
  try {
    bytes = await readBounded(response, maxBytes);
  } catch (err) {
    return unavailable(`the body did not arrive whole: ${messageOf(err)}`);
  }
  if (bytes === null) return definitive(`the document is larger than ${maxBytes} bytes`);
  let document: unknown;
  try {
    document = parseStrict(bytes);
  } catch (err) {
    return definitive(`the document is not strict JSON: ${messageOf(err)}`);
  }
  if (!isJsonObject(document)) return definitive("the document is not a JSON object");
  if (document["id"] !== presented) return definitive(`the document is ${JSON.stringify(document["id"])}'s, not ${presented}'s`);
  try {
    const canonical = canonicalize(document);
    return { outcome: "resolved", resolution: resolutionOf(presented, presented, document, canonical, rawCidOfBytes(canonical)) };
  } catch (err) {
    if (err instanceof InvalidDidDocument || err instanceof InvalidJson) return definitive(`the document is not one the vault retains: ${messageOf(err)}`);
    throw err;
  }
}

/**
 * Resolve a presented DID. A numalgo-4 DID needs no network and no
 * options; `known` supplies the long form of a short form already in
 * evidence, and nothing else can. A `did:web` goes to the network
 * under the options' policy. Any other method is unsupported, which
 * is a definitive answer.
 */
export async function resolve(presented: string, known: KnownLongForms, options: ResolverOptions = {}): Promise<Resolved> {
  const method = DID_METHOD.exec(presented)?.[1];
  if (method === "peer") return isPeerDID4(presented) ? resolvePeer(presented, known) : definitive("only numalgo 4 of did:peer is supported");
  if (method === "web") return resolveWeb(presented, options);
  return definitive(method === undefined ? `not a DID: ${JSON.stringify(presented)}` : `unsupported DID method ${method}`);
}

/**
 * Every numalgo-4 long form the fold has in evidence, by short form:
 * what a peer disclosed, what was resolved, what a transition named
 * under either spelling, and this vault's own entities and mediation
 * identities. A short form presented later resolves through it.
 */
export function knownLongForms(fold: VaultFold): KnownLongForms {
  const longForms = new Map<Did, Did>();
  const note = (spelling: Did | null | undefined): void => {
    if (spelling !== null && spelling !== undefined && isLongForm(spelling)) {
      const shortForm = spelling.slice(0, spelling.lastIndexOf(":")) as Did;
      if (!longForms.has(shortForm)) longForms.set(shortForm, spelling);
    }
  };
  for (const event of fold.set.of("peer.resolved")) note(event.data.presentedDid);
  for (const event of fold.set.of("message.in")) note(event.data.presentedDid);
  for (const event of fold.set.of("relationship.peerTransitioned")) {
    note(event.data.presentedFromDid);
    note(event.data.presentedToDid);
  }
  for (const event of fold.set.of("did.created")) note(event.data.longFormDid);
  for (const event of fold.set.of("mediation.created")) {
    note(event.data.me.did);
    note(event.data.mediatorDid);
  }
  return (shortFormDid) => longForms.get(shortFormDid) ?? null;
}
