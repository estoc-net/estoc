/**
 * What a message means, as bytes to hash: the semantic projection (the
 * application content), the intent projection (that plus the immutable
 * control headers) and the exact plaintext. `readPlaintext` takes a
 * DIDComm plaintext apart into its stored content, its intent and the
 * addressing that is not intent; `wirePlaintext` puts an intent back on
 * the wire. The two meet: reading what `wirePlaintext` emits yields the
 * intent it was given, and the same intent hash.
 */

import { InvalidJson, canonicalize, isJsonObject, type JsonObject } from "@estoc/event-store/v3";
import { sha256 } from "@noble/hashes/sha2";
import { base64urlnopad } from "@scure/base";

import { storeMessage, wireAttachment, type StoredMessage, type StoredMessageDocument } from "./document.js";
import { InvalidPlaintext } from "./errors.js";
import { isCompactJwt, isDid, isEpochSeconds } from "./syntax.js";
import type { AdditionalHeaders, Cid, Did, EpochSeconds, MessageHash, MessageOut } from "./types.js";

/** The DIDComm plaintext media type: the `typ` header a plaintext carries. */
export const PLAINTEXT_TYP = "application/didcomm-plain+json";

/** The top-level DIDComm members a dedicated field models, or that a vault plaintext may not carry; none may appear in `headers`. */
export const RESERVED_HEADERS = [
  "typ",
  "id",
  "type",
  "from",
  "to",
  "created_time",
  "expires_time",
  "thid",
  "pthid",
  "please_ack",
  "ack",
  "from_prior",
  "return_route",
  "body",
  "attachments",
] as const;

const RESERVED = new Set<string>(RESERVED_HEADERS);

/**
 * The intent of one message: everything the intent hash covers, with
 * the content already in its stored form. An outbound freezes it in
 * `message.out`; an inbound observation computes it from the plaintext.
 */
export type Intent = {
  /** the plaintext `id`: the outbound message ID, or the received wire ID */
  id: string;
  type: string;
  thid: string | null;
  pthid: string | null;
  document: StoredMessageDocument;
  createdTime: EpochSeconds | null;
  expiresTime: EpochSeconds | null;
  pleaseAck: string[] | null;
  ack: string[];
  headers: AdditionalHeaders;
};

/** A plaintext taken apart: what is intent, what is stored, and what is addressing. */
export type ReadPlaintext = {
  /** the plaintext as given, which `plaintextHash` covers */
  plaintext: JsonObject;
  plaintextHash: MessageHash;
  intent: Intent;
  intentHash: MessageHash;
  stored: StoredMessage;
  typ: string | null;
  from: Did | null;
  to: Did[] | null;
  fromPrior: string | null;
};

/** `headers` of an intent: a JSON object with no reserved member. */
export function checkHeaders(value: unknown, at = "headers"): AdditionalHeaders {
  if (!isJsonObject(value)) throw new InvalidPlaintext(`${at} must be a JSON object`);
  for (const name of Object.keys(value)) {
    if (RESERVED.has(name)) throw new InvalidPlaintext(`${at} carries the reserved header ${JSON.stringify(name)}`);
  }
  return value;
}

/** The application content of an intent: what two messages must share to say the same thing. */
export function semanticProjection(intent: Intent): JsonObject {
  return {
    id: intent.id,
    type: intent.type,
    thid: intent.thid,
    pthid: intent.pthid,
    body: intent.document.body,
    attachments: intent.document.attachments,
  };
}

/** The semantic projection with the immutable control headers: what `intentHash` covers. */
export function intentProjection(intent: Intent): JsonObject {
  return {
    semantic: semanticProjection(intent),
    created_time: intent.createdTime,
    expires_time: intent.expiresTime,
    please_ack: intent.pleaseAck === null ? null : [...intent.pleaseAck],
    ack: [...intent.ack],
    headers: intent.headers,
  };
}

export function intentHash(intent: Intent): MessageHash {
  return hashOf(intentProjection(intent), "the intent projection");
}

/** The hash of one exact plaintext: every member it carries, addressing and proof included. */
export function plaintextHash(plaintext: JsonObject): MessageHash {
  return hashOf(plaintext, "the plaintext");
}

function hashOf(value: JsonObject, what: string): MessageHash {
  let bytes: Uint8Array;
  try {
    bytes = canonicalize(value);
  } catch (err) {
    if (err instanceof InvalidJson) throw new InvalidPlaintext(`${what} is not I-JSON: ${err.message}`);
    throw err;
  }
  return base64urlnopad.encode(sha256(bytes)) as MessageHash;
}

/**
 * The `please_ack` targets as receipt processing reads them: `""` stands
 * for the current message, each target once, in first-seen order. The
 * stored array is never rewritten; this is for processing only.
 */
export function expandPleaseAck(currentWireId: string, values: readonly string[]): string[] {
  return [...new Set(values.map((value) => (value === "" ? currentWireId : value)))];
}

/** Does the message ask for its own acknowledgment? Null and `[]` do not; `""` and its own wire ID do. */
export function requestsAck(currentWireId: string, pleaseAck: readonly string[] | null): boolean {
  return pleaseAck !== null && expandPleaseAck(currentWireId, pleaseAck).includes(currentWireId);
}

/** The intent a committed `message.out` froze, given the document `bodyCid` names. */
export function intentOfOutbound(data: MessageOut, document: StoredMessageDocument): Intent {
  return {
    id: data.messageId,
    type: data.msgType,
    thid: data.thid,
    pthid: data.pthid,
    document,
    createdTime: data.createdTime,
    expiresTime: data.expiresTime,
    pleaseAck: data.pleaseAck,
    ack: data.ack,
    headers: data.headers,
  };
}

/**
 * A DIDComm plaintext, as parsed, taken apart. Absent and null optional
 * headers both read as absent; a present one must have its type.
 * `return_route` is refused outright: a vault application plaintext
 * never carries it.
 */
export function readPlaintext(value: unknown): ReadPlaintext {
  if (!isJsonObject(value)) throw new InvalidPlaintext("a plaintext must be a JSON object");
  if (Object.hasOwn(value, "return_route")) throw new InvalidPlaintext("return_route is not allowed in a vault plaintext");
  const id = nonEmpty(value.id, "id");
  const type = nonEmpty(value.type, "type");
  const typ = optional(value.typ, "typ", (typ, at) => {
    if (typ !== PLAINTEXT_TYP) throw new InvalidPlaintext(`${at} must be ${JSON.stringify(PLAINTEXT_TYP)}`);
    return typ;
  });
  const from = optional(value.from, "from", did);
  const to = optional(value.to, "to", (to, at) => {
    if (!Array.isArray(to)) throw new InvalidPlaintext(`${at} must be an array of DIDs`);
    return to.map((entry, i) => did(entry, `${at}[${i}]`));
  });
  const thid = optional(value.thid, "thid", nonEmpty);
  const pthid = optional(value.pthid, "pthid", nonEmpty);
  const createdTime = optional(value.created_time, "created_time", epochSeconds);
  const expiresTime = optional(value.expires_time, "expires_time", epochSeconds);
  if (createdTime !== null && expiresTime !== null && expiresTime <= createdTime) {
    throw new InvalidPlaintext("expires_time must be later than created_time");
  }
  const pleaseAck = optional(value.please_ack, "please_ack", strings);
  const ack = optional(value.ack, "ack", strings) ?? [];
  const fromPrior = optional(value.from_prior, "from_prior", (jwt, at) => {
    if (!isCompactJwt(jwt)) throw new InvalidPlaintext(`${at} must be a compact JWT`);
    return jwt;
  });
  const stored = storeMessage(value.body, value.attachments);
  const headers: AdditionalHeaders = Object.fromEntries(Object.entries(value).filter(([name]) => !RESERVED.has(name)));
  const intent: Intent = { id, type, thid, pthid, document: stored.document, createdTime, expiresTime, pleaseAck, ack, headers };
  return { plaintext: value, plaintextHash: plaintextHash(value), intent, intentHash: intentHash(intent), stored, typ, from, to, fromPrior };
}

function optional<T>(value: unknown, at: string, check: (value: unknown, at: string) => T): T | null {
  return value === undefined || value === null ? null : check(value, at);
}

function nonEmpty(value: unknown, at: string): string {
  if (typeof value !== "string" || value === "") throw new InvalidPlaintext(`${at} must be a non-empty string`);
  return value;
}

function did(value: unknown, at: string): Did {
  if (!isDid(value)) throw new InvalidPlaintext(`${at} must be a DID`);
  return value as Did;
}

function epochSeconds(value: unknown, at: string): EpochSeconds {
  if (!isEpochSeconds(value)) throw new InvalidPlaintext(`${at} must be an integer count of seconds`);
  return value;
}

function strings(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new InvalidPlaintext(`${at} must be an array of strings`);
  return [...(value as string[])];
}

/** The addressing and proof a package adds to an intent: what the plaintext hash covers beyond it. */
export type Addressing = { from: Did; to: Did[]; fromPrior: string | null };

/**
 * The complete innermost plaintext of an intent: `typ`, `id`, `type`,
 * `from`, `to` and `body` always; timing, threading and `from_prior`
 * only when non-null; `please_ack` whenever the intent has one, even
 * empty; `ack` and `attachments` when non-empty; every additional
 * header at the top level. `payloadOf` supplies each inline
 * attachment's bytes by its root.
 */
export function wirePlaintext(intent: Intent, addressing: Addressing, payloadOf: (root: Cid) => Uint8Array): JsonObject {
  const plaintext: JsonObject = { ...checkHeaders(intent.headers) };
  plaintext.typ = PLAINTEXT_TYP;
  plaintext.id = intent.id;
  plaintext.type = intent.type;
  plaintext.from = addressing.from;
  plaintext.to = [...addressing.to];
  if (intent.createdTime !== null) plaintext.created_time = intent.createdTime;
  if (intent.expiresTime !== null) plaintext.expires_time = intent.expiresTime;
  if (intent.thid !== null) plaintext.thid = intent.thid;
  if (intent.pthid !== null) plaintext.pthid = intent.pthid;
  if (intent.pleaseAck !== null) plaintext.please_ack = [...intent.pleaseAck];
  if (intent.ack.length > 0) plaintext.ack = [...intent.ack];
  if (addressing.fromPrior !== null) plaintext.from_prior = addressing.fromPrior;
  plaintext.body = intent.document.body;
  if (intent.document.attachments.length > 0) {
    plaintext.attachments = intent.document.attachments.map((stored) => wireAttachment(stored, stored.data.kind === "links" ? null : payloadOf(stored.data.root)));
  }
  return plaintext;
}
