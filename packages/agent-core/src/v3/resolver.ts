/**
 * A presented DID resolved to the evidence the vault retains of a
 * peer: the presented spelling, the canonical DID, the document as
 * RFC 8785 bytes under their raw CID, the methods it authorizes and
 * the DIDComm service it names. A numalgo-4 long form resolves from
 * itself, its short form only through a long form already in
 * evidence. A `did:web` is fetched, and its document must call itself
 * by the presented string byte for byte: the spelling is the identity,
 * whatever URL or DNS processing the fetch went through.
 *
 * Every failure is `unavailable` — no answer now, the work stays
 * retryable — or `definitive` — an answer that closes the attempt.
 *
 * `web-did-resolver` is not used: it fetches through its own
 * transport, follows redirects and reads without a bound, and the
 * network policy has to hold on the transport itself.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import bs58 from "bs58";
import ipaddr from "ipaddr.js";
import { varint } from "multiformats";
import { bases } from "multiformats/basics";

import { isLongForm, isPeerDID4, isShortForm } from "@estoc/did-peer";
import { InvalidJson, canonicalize, isJsonObject, parseStrict, type JsonObject } from "@estoc/event-store/v3";
import { InvalidDidDocument, InvalidPublicKey, authorizedMethodIds, canonicalDidOf, canonicalPublicKey, decodePublicKey, didcommServiceUris, peerResolution, rawCidOfBytes, type Cid, type Did, type DidUrl, type KeyType, type VaultFold } from "@estoc/vault/v3";

import { bounded } from "./link.js";
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

/**
 * The codes a transport failure carries when its answer is final, on
 * the error or down its `cause` chain. `refused`: the transport's
 * policy forbids the connection. `noAddress`: the name has no address
 * — NXDOMAIN, or NODATA for every usable address family. A transport
 * that cannot tell a name's absence from a lookup that failed leaves
 * the code off, and the failure counts as no answer now.
 */
export const DEFINITIVE_TRANSPORT_CODES = { refused: "EBLOCKED", noAddress: "ENXDOMAIN" } as const;

export interface WebResolverOptions {
  /**
   * The transport a `did:web` document is fetched over, and where the
   * network policy holds. A check on the name binds nothing: only what
   * makes the connection sees every address the name resolves to, at
   * lookup, and can refuse one that is not public unicast — on every
   * connection, since the name may resolve differently next time. So
   * the transport is the host's, under this contract: it refuses what
   * its policy forbids, follows no redirect, answers from no cache,
   * honours `signal`, and marks a failure that is final with a code
   * from `DEFINITIVE_TRANSPORT_CODES`. Without one no `did:web` is
   * resolved.
   */
  fetch?: typeof fetch;
  /** the most bytes a document may be; `MAX_DOCUMENT_BYTES` by default */
  maxBytes?: number;
  /** how long one resolution may take, all of it — connection, last byte, diagnostic; 10 s by default */
  timeoutMs?: number;
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

const RELATIONSHIPS = ["authentication", "assertionMethod", "keyAgreement", "capabilityDelegation", "capabilityInvocation"];
/** The members a JWK carries only when it holds a private or symmetric key. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
/** The members a public JWK of each key type carries, by RFC 7518 §6 and RFC 8037 §2. */
const PUBLIC_JWK_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["EC", ["crv", "x", "y"]],
  ["OKP", ["crv", "x"]],
  ["RSA", ["n", "e"]],
]);
/** A CAIP-10 account ID: chain namespace, chain reference, account address. */
const CAIP_10 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/;
const HEX_BYTES = /^(?:[0-9A-Fa-f]{2})+$/;
/**
 * The most characters one encoded key may run to: room for the
 * largest public key in any of these encodings, and a bound on what
 * decoding one costs — base58 decoding is quadratic in its length, and
 * runs where no deadline can interrupt it.
 */
const MAX_MATERIAL_CHARS = 1024;
/** The JWK curves the vault reads, by key type; a JWK of another curve is kept unread. */
const READ_JWK_CURVES: ReadonlyMap<string, readonly KeyType[]> = new Map([
  ["OKP", ["Ed25519", "X25519"]],
  ["EC", ["P-256", "P-384", "P-521", "secp256k1"]],
]);
/** The multicodec codes of the key types the vault reads; a multibase key under another code is kept unread. */
const READ_MULTICODECS = new Set([0xed, 0xec, 0xe7, 0x1200, 0x1201, 0x1202]);
/** Bytes of a raw Ed25519 or X25519 key, the keys the base58 suites carry. */
const RAW_KEY_BYTES = 32;
interface Suite {
  /** the material a method of the suite carries, one of these */
  readonly material: readonly string[];
  /** the kind of key the suite is for, when it is for one kind */
  readonly keyType?: KeyType;
}
/**
 * The known suites. Any other type is another suite's: its method is
 * kept with whatever material it carries, and whether that is a
 * usable key is decided where the key is used.
 */
const SUITES: ReadonlyMap<string, Suite> = new Map([
  ["JsonWebKey2020", { material: ["publicKeyJwk"] }],
  ["Multikey", { material: ["publicKeyMultibase"] }],
  ["Ed25519VerificationKey2020", { material: ["publicKeyMultibase"], keyType: "Ed25519" }],
  ["X25519KeyAgreementKey2020", { material: ["publicKeyMultibase"], keyType: "X25519" }],
  ["Ed25519VerificationKey2018", { material: ["publicKeyBase58"], keyType: "Ed25519" }],
  ["X25519KeyAgreementKey2019", { material: ["publicKeyBase58"], keyType: "X25519" }],
  ["EcdsaSecp256k1VerificationKey2019", { material: ["publicKeyJwk", "publicKeyHex"], keyType: "secp256k1" }],
  ["EcdsaSecp256k1RecoveryMethod2020", { material: ["blockchainAccountId", "publicKeyJwk", "publicKeyHex"], keyType: "secp256k1" }],
]);
const METHOD_MEMBERS = new Set(["id", "type", "controller"]);

// RFC 3986 §3, component by component, on the raw string: the
// platform's URL parser escapes and normalizes what it is given rather
// than refusing it. A bracketed host is captured and checked apart:
// `ipaddr.js` decides whether it is an IPv6 address, and the grammar
// adds what the library does not hold to — a dotted tail in strict
// decimal, no zone identifier, IPvFuture under its own rule.
const PCHAR = "(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})";
const QUERY_OR_FRAGMENT = `(?:${PCHAR}|[/?])*`;
const REG_CHAR = "(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})";
const HOST = `(?:\\[([^\\]]*)\\]|${REG_CHAR}*)`;
const AUTHORITY = `(?:(?:${REG_CHAR}|:)*@)?${HOST}(?::[0-9]*)?`;
const HIER_PART = `(?://${AUTHORITY}(?:/${PCHAR}*)*|/(?:${PCHAR}+(?:/${PCHAR}*)*)?|${PCHAR}+(?:/${PCHAR}*)*|)`;
const URI = new RegExp(`^[A-Za-z][A-Za-z0-9+.-]*:${HIER_PART}(?:\\?${QUERY_OR_FRAGMENT})?(?:#${QUERY_OR_FRAGMENT})?$`);
const IPV_FUTURE = /^[vV][0-9A-Fa-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/;
const IPV6_CHARS = /^[0-9A-Fa-f:.]+$/;
const DEC_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const IPV4 = new RegExp(`^${DEC_OCTET}(?:\\.${DEC_OCTET}){3}$`);

function definitive(reason: string): Resolved {
  return { outcome: "definitive", reason };
}

function unavailable(reason: string): Resolved {
  return { outcome: "unavailable", reason };
}

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(err);
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let at = err; at !== undefined && at !== null && chain.length < 8; at = (at as { cause?: unknown }).cause) chain.push(at);
  return chain;
}

function reasonOf(err: unknown): string {
  return [...new Set(causeChain(err).map(messageOf))].join(": ");
}

/**
 * A failure of the transport or of the body as an outcome. A final
 * answer takes precedence over how it was wrapped: the definitive
 * code is looked for down the whole cause chain, past whatever
 * generic code an outer error carries, and past the deadline.
 */
function transportFailure(err: unknown, what: string, signal: AbortSignal, timeoutMs: number): Resolved {
  const codes = new Set(causeChain(err).map((at) => (at as { code?: unknown }).code));
  if (codes.has(DEFINITIVE_TRANSPORT_CODES.refused)) return definitive(`the transport refused the connection: ${reasonOf(err)}`);
  if (codes.has(DEFINITIVE_TRANSPORT_CODES.noAddress)) return definitive(`the authority has no address: ${reasonOf(err)}`);
  if (signal.aborted) return unavailable(`timed out: not resolved within ${timeoutMs} ms`);
  return unavailable(`${what}: ${reasonOf(err)}`);
}

function isIpLiteral(literal: string): boolean {
  if (IPV_FUTURE.test(literal)) return true;
  if (!IPV6_CHARS.test(literal) || !ipaddr.IPv6.isValid(literal)) return false;
  return !literal.includes(".") || IPV4.test(literal.slice(literal.lastIndexOf(":") + 1));
}

function isUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = URI.exec(value);
  return match !== null && (match[1] === undefined || isIpLiteral(match[1]));
}

function isDid(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    canonicalDidOf(value);
    return true;
  } catch (err) {
    if (err instanceof InvalidDidDocument) return false;
    throw err;
  }
}

function jwkFault(jwk: unknown): string | null {
  if (!isJsonObject(jwk)) return "an object";
  const secret = PRIVATE_JWK_MEMBERS.find((member) => jwk[member] !== undefined);
  if (secret !== undefined) return `a public key, without the private member ${secret}`;
  const kty = jwk["kty"];
  if (typeof kty !== "string") return "a JWK with a string kty";
  const missing = (PUBLIC_JWK_MEMBERS.get(kty) ?? []).find((member) => typeof jwk[member] !== "string");
  return missing === undefined ? null : `a ${kty} JWK with a string ${missing}`;
}

function encodedKeyFault(value: unknown, what: string, decode: (text: string) => Uint8Array): string | null {
  if (typeof value !== "string" || value.length > MAX_MATERIAL_CHARS) return `${what} within ${MAX_MATERIAL_CHARS} characters`;
  try {
    return decode(value).length > 0 ? null : what;
  } catch {
    return what;
  }
}

function decodeMultibase(text: string): Uint8Array {
  const base = Object.values(bases).find((candidate) => text.startsWith(candidate.prefix));
  if (base === undefined) throw new Error("no multibase prefix");
  return base.decode(text);
}

const MATERIAL_FAULTS: ReadonlyMap<string, (value: unknown) => string | null> = new Map([
  ["publicKeyJwk", jwkFault],
  ["publicKeyMultibase", (value) => encodedKeyFault(value, "a multibase-encoded value", decodeMultibase)],
  ["publicKeyBase58", (value) => encodedKeyFault(value, "a base58btc-encoded value", (text) => bs58.decode(text))],
  ["publicKeyHex", (value) => (typeof value === "string" && value.length <= MAX_MATERIAL_CHARS && HEX_BYTES.test(value) ? null : `hex-encoded bytes within ${MAX_MATERIAL_CHARS} characters`)],
  ["blockchainAccountId", (value) => (typeof value === "string" && CAIP_10.test(value) ? null : "a CAIP-10 account ID")],
]);

function invalidKey(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (err) {
    if (err instanceof InvalidPublicKey) return err.message;
    throw err;
  }
}

/** The multicodec code a base58btc multibase value carries; null under another base. */
function multicodecOf(text: string): number | null {
  if (!text.startsWith(bases.base58btc.prefix)) return null;
  try {
    return varint.decode(bases.base58btc.decode(text))[0];
  } catch {
    return null;
  }
}

function isSecp256k1Point(hex: string): boolean {
  try {
    secp256k1.Point.fromHex(hex);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fault in the key a method's material holds, read as the vault
 * reads keys: a JWK of a curve the vault reads, or a multibase key
 * under a code it reads, must be that key; a base58 key of a suite for
 * raw keys must be one; a hex key of a secp256k1 suite must be a point
 * on the curve; and a suite for one kind of key must carry that kind.
 * Material of a kind the vault does not read is kept unread.
 */
function keyFault(entry: JsonObject, type: string, suite: Suite | undefined): string | null {
  const expects = suite?.keyType;
  const wrongKind = (read: KeyType) => (expects !== undefined && read !== expects ? `of type ${type} carries a ${expects} key, not ${read}` : null);
  const jwk = entry["publicKeyJwk"];
  if (isJsonObject(jwk)) {
    const read = (READ_JWK_CURVES.get(String(jwk["kty"])) ?? []).find((curve) => curve === jwk["crv"]);
    if (read !== undefined) {
      const fault = invalidKey(() => canonicalPublicKey(jwk));
      if (fault !== null) return `has a publicKeyJwk that is a ${read} key: ${fault}`;
      const wrong = wrongKind(read);
      if (wrong !== null) return wrong;
    }
  }
  const multibase = entry["publicKeyMultibase"];
  if (typeof multibase === "string") {
    const code = multicodecOf(multibase);
    if (code !== null && READ_MULTICODECS.has(code)) {
      const fault = invalidKey(() => canonicalPublicKey(multibase));
      if (fault !== null) return `has a publicKeyMultibase that is the key its code says: ${fault}`;
      const wrong = wrongKind(decodePublicKey(canonicalPublicKey(multibase)).type);
      if (wrong !== null) return wrong;
    }
  }
  const base58 = entry["publicKeyBase58"];
  if (typeof base58 === "string" && (expects === "Ed25519" || expects === "X25519") && bs58.decode(base58).length !== RAW_KEY_BYTES) return `of type ${type} carries a ${expects} key of ${RAW_KEY_BYTES} bytes`;
  const hex = entry["publicKeyHex"];
  if (typeof hex === "string" && expects === "secp256k1" && !isSecp256k1Point(hex)) return "has a publicKeyHex that is a point on secp256k1";
  return null;
}

function methodFault(entry: unknown): string | null {
  if (!isJsonObject(entry)) return "is an object";
  if (typeof entry["id"] !== "string") return "has a string id";
  if (typeof entry["type"] !== "string") return "has a string type";
  if (!isDid(entry["controller"])) return "has a DID controller";
  for (const [member, faultOf] of MATERIAL_FAULTS) {
    const value = entry[member];
    if (value === undefined) continue;
    const fault = faultOf(value);
    if (fault !== null) return `has a ${member} that is ${fault}`;
  }
  if (entry["publicKeyMultibase"] !== undefined && entry["publicKeyJwk"] !== undefined) return "carries publicKeyMultibase or publicKeyJwk, not both";
  const type = entry["type"];
  const suite = SUITES.get(type);
  if (suite === undefined) {
    if (!Object.keys(entry).some((member) => !METHOD_MEMBERS.has(member))) return `of type ${type} carries its verification material`;
  } else if (!suite.material.some((member) => entry[member] !== undefined)) {
    return `of type ${type} carries ${suite.material.join(" or ")}`;
  }
  return keyFault(entry, type, suite);
}

function endpointFault(endpoint: unknown): string | null {
  if (typeof endpoint === "string") return isUri(endpoint) ? null : "has a serviceEndpoint that is a URI";
  if (!isJsonObject(endpoint)) return "has a serviceEndpoint that is a URI or an object";
  const uri = endpoint["uri"];
  return uri === undefined || isUri(uri) ? null : "has a serviceEndpoint whose uri is a URI";
}

function serviceFault(entry: unknown): string | null {
  if (!isJsonObject(entry)) return "is an object";
  if (typeof entry["id"] !== "string") return "has a string id";
  const type = entry["type"];
  if (typeof type !== "string" && !(Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === "string"))) return "has a type, a string or strings";
  const endpoint = entry["serviceEndpoint"];
  if (Array.isArray(endpoint)) {
    if (endpoint.length === 0) return "has a serviceEndpoint that is not empty";
    return endpoint.map(endpointFault).find((fault) => fault !== null) ?? null;
  }
  return endpointFault(endpoint);
}

/**
 * The shape a fetched document must have before its relationships are
 * read: every method an object with an ID, a type, a DID controller
 * and the material its type defines, public if it is a JWK; every
 * service an object with a URI as its own ID, a type and an endpoint
 * that is a URI or an object. This is a published document, not a
 * numalgo-4 input: nothing is filled in for it, so a controller must
 * be there, and it may carry what this agent never uses — a method of
 * another suite with its own key format, a service of another kind —
 * since whether a key is usable is decided where the key is used.
 */
function checkShape(document: JsonObject, did: Did): void {
  const each = (member: string, faultOf: (entry: unknown) => string | null) => {
    const entries = document[member];
    if (entries === undefined) return;
    if (!Array.isArray(entries)) throw new InvalidDidDocument(`${member} is an array`);
    entries.forEach((entry, i) => {
      const fault = faultOf(entry);
      if (fault !== null) throw new InvalidDidDocument(`${member}[${i}] ${fault}`);
    });
  };
  each("alsoKnownAs", (entry) => (typeof entry === "string" ? null : "is a string"));
  each("verificationMethod", methodFault);
  each("service", serviceFault);
  for (const relationship of RELATIONSHIPS) each(relationship, (entry) => (typeof entry === "string" ? null : methodFault(entry)));
  const serviceIds = new Set<string>();
  (document["service"] as JsonObject[] | undefined)?.forEach((service, i) => {
    const reference = service["id"] as string;
    const id = reference.startsWith("#") || reference.startsWith("?") ? did + reference : reference;
    if (!isUri(id)) throw new InvalidDidDocument(`service[${i}].id is a URI or a reference into the document: ${JSON.stringify(reference)}`);
    if (serviceIds.has(id)) throw new InvalidDidDocument(`two services are ${id}`);
    serviceIds.add(id);
  });
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
  const name = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const literal = name.startsWith("[") ? name.slice(1, -1) : name;
  if (LOOPBACK_NAMES.has(name)) {
    if (!insecureLoopback) return { refused: "a loopback authority" };
    url.protocol = "http:";
  } else if (ipaddr.isValid(literal)) {
    return { refused: "an IP-literal authority" };
  } else if (RESERVED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return { refused: `a reserved name: ${url.hostname}` };
  }
  url.pathname = path.length === 0 ? "/.well-known/did.json" : `/${path.map((segment) => encodeURIComponent(segment)).join("/")}/did.json`;
  return { url };
}

/**
 * The body, or null once it runs past `maxBytes`; what fails while
 * reading is the transport's. Past the bound the answer is settled,
 * so the stream is let go rather than waited for: a cancel that fails
 * or never returns changes nothing.
 */
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
      reader.cancel().catch(() => undefined);
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

/**
 * A `did:web` fetched over the transport and checked to be its own:
 * the presented string, byte for byte, as the document's `id`. One
 * deadline covers the whole resolution; the diagnostic written after
 * it neither holds the outcome nor overturns it.
 */
async function resolveWeb(presented: string, options: ResolverOptions): Promise<Resolved> {
  try {
    canonicalDidOf(presented);
  } catch (err) {
    if (err instanceof InvalidDidDocument) return definitive(err.message);
    throw err;
  }
  const derived = webDidUrl(presented, options.insecureLoopback ?? false);
  if ("refused" in derived) return definitive(`the resolver policy refuses ${presented}: ${derived.refused}`);
  if (options.fetch === undefined) return definitive("no transport: a did:web is fetched only over one that holds the network policy");
  const { url } = derived;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  const outcome = await fetchWeb(presented as Did, url, options.fetch, options.maxBytes ?? MAX_DOCUMENT_BYTES, signal, timeoutMs);
  const trace = options.trace;
  if (trace !== undefined) {
    const entry = { did: presented, url: url.href, outcome: outcome.outcome, ...(outcome.outcome === "resolved" ? { cid: outcome.resolution.cid } : { reason: outcome.reason }), ms: Date.now() - started };
    await bounded(signal, () => trace.append("diag", "resolve", entry)).catch(() => undefined);
  }
  return outcome;
}

async function fetchWeb(presented: Did, url: URL, fetch: typeof globalThis.fetch, maxBytes: number, signal: AbortSignal, timeoutMs: number): Promise<Resolved> {
  let response: Response;
  try {
    response = await bounded(signal, () => fetch(url.href, { redirect: "manual", cache: "no-store", signal, headers: { accept: "application/did+json, application/json" } }));
  } catch (err) {
    return transportFailure(err, "the fetch failed", signal, timeoutMs);
  }
  const { status } = response;
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) return definitive(`a redirect (${status}) is not followed`);
  if (RETRYABLE_STATUS.has(status) || status >= 500) return unavailable(`HTTP ${status}`);
  if (status === 404 || status === 410) return definitive(`HTTP ${status}: not found or deactivated`);
  if (status < 200 || status >= 300) return definitive(`HTTP ${status}`);
  let bytes: Uint8Array | null;
  try {
    bytes = await bounded(signal, () => readBounded(response, maxBytes));
  } catch (err) {
    return transportFailure(err, "the body did not arrive whole", signal, timeoutMs);
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
    checkShape(document, presented);
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
 * identities. A short form presented later resolves through it. A
 * spelling is validated when looked up — its hash, its document, the
 * short form it derives — so that an invalid one in evidence never
 * stands in for a valid one recorded beside it.
 */
export function knownLongForms(fold: VaultFold): KnownLongForms {
  const candidates = new Map<Did, Set<Did>>();
  const note = (spelling: Did | null | undefined): void => {
    if (spelling === null || spelling === undefined || !isLongForm(spelling)) return;
    const shortForm = spelling.slice(0, spelling.lastIndexOf(":")) as Did;
    const found = candidates.get(shortForm);
    if (found === undefined) candidates.set(shortForm, new Set([spelling]));
    else found.add(spelling);
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
  return (shortFormDid) => {
    for (const candidate of candidates.get(shortFormDid) ?? []) {
      try {
        if (peerResolution(candidate).did === shortFormDid) return candidate;
      } catch (err) {
        if (!(err instanceof InvalidDidDocument)) throw err;
      }
    }
    return null;
  };
}
