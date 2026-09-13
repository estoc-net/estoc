/**
 * The stored message document: the closed representation of a DIDComm
 * body and its attachments that a message event retains as one raw
 * object, and the payload objects the attachments' inline content
 * becomes. `storeMessage` normalizes the wire form into it and
 * `wireAttachment` turns a stored descriptor back into the wire form,
 * so that reading a message in and preparing one out meet at the same
 * bytes and the same hashes.
 */

import { InvalidJson, canonicalText, canonicalize, isJsonObject, isRawCid, parseStrict, rawCidFromDigest, type JsonObject, type JsonValue } from "@estoc/event-store/v3";
import { sha256 } from "@noble/hashes/sha2";
import { base64url, base64urlnopad } from "@scure/base";

import { InvalidPlaintext } from "./errors.js";
import type { Cid, EpochSeconds } from "./types.js";

export type StoredAttachmentData =
  | { kind: "base64"; root: Cid; hash: string | null; jws: JsonValue | null }
  | { kind: "json"; root: Cid; hash: string | null; jws: JsonValue | null }
  | { kind: "links"; links: string[]; hash: string; jws: JsonValue | null };

/** One attachment as stored: every member present, absent wire members null. */
export type StoredAttachment = {
  id: string | null;
  description: string | null;
  filename: string | null;
  media_type: string | null;
  format: string | null;
  lastmod_time: EpochSeconds | null;
  byte_count: number | null;
  data: StoredAttachmentData;
};

export type StoredMessageDocument = { body: JsonObject; attachments: StoredAttachment[] };

export type StoredObject = { cid: Cid; bytes: Uint8Array };

/** A message's content as the object store and the event will hold it. */
export type StoredMessage = {
  document: StoredMessageDocument;
  /** `UTF8(RFC8785(document))`, the object `bodyCid` names */
  bytes: Uint8Array;
  bodyCid: Cid;
  /** the distinct object-backed attachment payload roots, in attachment order */
  attachmentCids: Cid[];
  /** `bodyCid` then `attachmentCids`, distinct: what the retaining event's `roots` must be */
  roots: Cid[];
  /** the payload object of each entry of `attachmentCids`, in that order */
  payloads: StoredObject[];
};

const DESCRIPTOR_STRINGS = ["description", "filename", "media_type", "format"] as const;
const CARRIERS = ["base64", "json", "links"] as const;

/** DIDComm 2.1 restricts an attachment ID to the URI unreserved characters so it composes into URI references. */
const UNRESERVED = /^[A-Za-z0-9._~-]+$/;

/** The raw DASL CID of exactly these bytes. */
export function rawCidOfBytes(bytes: Uint8Array): Cid {
  return rawCidFromDigest(sha256(bytes)).text as Cid;
}

/** `bodyCid` followed by `attachmentCids`, each CID once, in first-seen order. */
export function messageRoots(bodyCid: Cid, attachmentCids: readonly Cid[]): Cid[] {
  return [...new Set<Cid>([bodyCid, ...attachmentCids])];
}

/**
 * The wire `body` and `attachments` of a plaintext as the vault stores
 * them, and the objects that storage takes. Inline content is decoded
 * or canonicalized once and becomes a payload object; a links
 * descriptor is kept as its ordered link strings and fetches nothing.
 * Members this version does not store are dropped; a wire `byte_count`
 * that disagrees with the inline content is refused.
 */
export function storeMessage(body: unknown, attachments: unknown): StoredMessage {
  if (!isJsonObject(body)) throw new InvalidPlaintext("body must be a JSON object");
  if (attachments !== undefined && !Array.isArray(attachments)) throw new InvalidPlaintext("attachments must be an array");
  const payloads = new Map<Cid, Uint8Array>();
  const stored: StoredAttachment[] = [];
  (attachments ?? []).forEach((attachment, i) => {
    const { descriptor, payload } = storeAttachment(attachment, `attachments[${i}]`);
    stored.push(descriptor);
    if (payload !== null && !payloads.has(payload.cid)) payloads.set(payload.cid, payload.bytes);
  });
  const document: StoredMessageDocument = { body, attachments: stored };
  const bytes = canonicalDocument(document);
  const bodyCid = rawCidOfBytes(bytes);
  const attachmentCids = [...payloads.keys()];
  return {
    document,
    bytes,
    bodyCid,
    attachmentCids,
    roots: messageRoots(bodyCid, attachmentCids),
    payloads: attachmentCids.map((cid) => ({ cid, bytes: payloads.get(cid) as Uint8Array })),
  };
}

function canonicalDocument(document: StoredMessageDocument): Uint8Array {
  try {
    return canonicalize(document);
  } catch (err) {
    if (err instanceof InvalidJson) throw new InvalidPlaintext(`not I-JSON: ${err.message}`);
    throw err;
  }
}

function storeAttachment(value: unknown, at: string): { descriptor: StoredAttachment; payload: StoredObject | null } {
  if (!isJsonObject(value)) throw new InvalidPlaintext(`${at} must be a JSON object`);
  const members = descriptorMembers(value, at);
  const { data, payload } = storeData(value.data, `${at}.data`);
  let byteCount: number | null = members.byte_count;
  if (payload !== null) {
    if (byteCount !== null && byteCount !== payload.bytes.length) {
      throw new InvalidPlaintext(`${at}.byte_count says ${byteCount} but the inline content is ${payload.bytes.length} bytes`);
    }
    byteCount = payload.bytes.length;
  }
  return { descriptor: { ...members, byte_count: byteCount, data }, payload };
}

/** The descriptor members other than `data`, absent and null both read as null. */
function descriptorMembers(value: JsonObject, at: string): Omit<StoredAttachment, "data"> {
  return {
    id: nullable(value.id, `${at}.id`, (id, where) => {
      if (typeof id !== "string" || !UNRESERVED.test(id)) throw new InvalidPlaintext(`${where} must be a non-empty string of URI unreserved characters`);
      return id;
    }),
    description: nullable(value.description, `${at}.description`, text),
    filename: nullable(value.filename, `${at}.filename`, text),
    media_type: nullable(value.media_type, `${at}.media_type`, text),
    format: nullable(value.format, `${at}.format`, text),
    lastmod_time: nullable(value.lastmod_time, `${at}.lastmod_time`, (time, where) => {
      if (!Number.isSafeInteger(time)) throw new InvalidPlaintext(`${where} must be an integer`);
      return time as number;
    }),
    byte_count: nullable(value.byte_count, `${at}.byte_count`, (count, where) => {
      if (!Number.isSafeInteger(count) || (count as number) < 0) throw new InvalidPlaintext(`${where} must be a non-negative integer`);
      return count as number;
    }),
  };
}

function storeData(value: unknown, at: string): { data: StoredAttachmentData; payload: StoredObject | null } {
  if (!isJsonObject(value)) throw new InvalidPlaintext(`${at} must be a JSON object`);
  const carriers = CARRIERS.filter((carrier) => Object.hasOwn(value, carrier));
  if (carriers.length !== 1) {
    throw new InvalidPlaintext(`${at} carries exactly one of base64, json and links, not ${carriers.length === 0 ? "none" : carriers.join(" and ")}`);
  }
  const carrier = carriers[0] as (typeof CARRIERS)[number];
  const hash = nullable(value.hash, `${at}.hash`, multihash);
  const jws = value.jws === undefined ? null : value.jws;
  if (carrier === "links") {
    if (hash === null) throw new InvalidPlaintext(`${at}.hash is required with links`);
    return { data: { kind: "links", links: links(value.links, `${at}.links`), hash, jws }, payload: null };
  }
  const bytes = carrier === "base64" ? decodeBase64(value.base64, `${at}.base64`) : canonicalJson(value.json, `${at}.json`);
  const cid = rawCidOfBytes(bytes);
  return { data: { kind: carrier, root: cid, hash, jws }, payload: { cid, bytes } };
}

function nullable<T>(value: unknown, at: string, check: (value: unknown, at: string) => T): T | null {
  return value === undefined || value === null ? null : check(value, at);
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string") throw new InvalidPlaintext(`${at} must be a string`);
  return value;
}

function multihash(value: unknown, at: string): string {
  if (typeof value !== "string" || value === "") throw new InvalidPlaintext(`${at} must be a non-empty multihash string`);
  return value;
}

function links(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((link) => typeof link === "string" && link !== "")) {
    throw new InvalidPlaintext(`${at} must be a non-empty array of non-empty strings`);
  }
  return [...(value as string[])];
}

/** Base64url as DIDComm attachments carry it, padded or not; the standard alphabet is refused. */
function decodeBase64(value: unknown, at: string): Uint8Array {
  if (typeof value !== "string") throw new InvalidPlaintext(`${at} must be a string`);
  try {
    return value.includes("=") ? base64url.decode(value) : base64urlnopad.decode(value);
  } catch (err) {
    throw new InvalidPlaintext(`${at} is not base64url: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function canonicalJson(value: unknown, at: string): Uint8Array {
  try {
    return canonicalize(value);
  } catch (err) {
    if (err instanceof InvalidJson) throw new InvalidPlaintext(`${at} is not I-JSON: ${err.message}`);
    throw err;
  }
}

/**
 * `value` as a stored message document read back from its object:
 * exactly the closed shape `storeMessage` writes, or `InvalidPlaintext`.
 * The payload roots are named, not checked for presence; what the
 * payload bytes must be is checked when they are put back on the wire.
 */
export function readStoredDocument(value: unknown): StoredMessageDocument {
  if (!isJsonObject(value) || !exactly(value, ["attachments", "body"])) throw new InvalidPlaintext("a stored document must have exactly body and attachments");
  if (!isJsonObject(value.body)) throw new InvalidPlaintext("body must be a JSON object");
  if (!Array.isArray(value.attachments)) throw new InvalidPlaintext("attachments must be an array");
  return { body: value.body, attachments: value.attachments.map((attachment, i) => readStoredAttachment(attachment, `attachments[${i}]`)) };
}

const DESCRIPTOR_MEMBERS = ["byte_count", "data", "description", "filename", "format", "id", "lastmod_time", "media_type"];
const INLINE_DATA_MEMBERS = ["hash", "jws", "kind", "root"];
const LINKS_DATA_MEMBERS = ["hash", "jws", "kind", "links"];

function readStoredAttachment(value: unknown, at: string): StoredAttachment {
  if (!isJsonObject(value) || !exactly(value, DESCRIPTOR_MEMBERS)) throw new InvalidPlaintext(`${at} must have exactly the stored descriptor members`);
  const members = descriptorMembers(value, at);
  const data = readStoredData(value.data, `${at}.data`);
  if (data.kind !== "links" && members.byte_count === null) throw new InvalidPlaintext(`${at}.byte_count must be the length of the inline ${data.kind} payload`);
  return { ...members, data };
}

function readStoredData(value: unknown, at: string): StoredAttachmentData {
  if (!isJsonObject(value)) throw new InvalidPlaintext(`${at} must be a JSON object`);
  const { kind } = value;
  const jws = value.jws === undefined ? null : value.jws;
  if (kind === "links") {
    if (!exactly(value, LINKS_DATA_MEMBERS)) throw new InvalidPlaintext(`${at} must have exactly the stored links members`);
    return { kind, links: links(value.links, `${at}.links`), hash: multihash(value.hash, `${at}.hash`), jws };
  }
  if (kind !== "base64" && kind !== "json") throw new InvalidPlaintext(`${at}.kind must be base64, json or links`);
  if (!exactly(value, INLINE_DATA_MEMBERS)) throw new InvalidPlaintext(`${at} must have exactly the stored ${kind} members`);
  if (!isRawCid(value.root)) throw new InvalidPlaintext(`${at}.root must be a raw DASL CID`);
  return { kind, root: value.root, hash: nullable(value.hash, `${at}.hash`, multihash), jws };
}

function canonicalJsonPayload(payload: Uint8Array, root: Cid): JsonValue {
  const value = parseStrict(payload);
  if (canonicalText(value) !== new TextDecoder().decode(payload)) throw new InvalidPlaintext(`the JSON payload ${root} is not in canonical form`);
  return value;
}

function exactly(value: JsonObject, members: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === members.length && keys.every((key, i) => key === members[i]);
}

/**
 * A stored descriptor as the wire carries it: absent members omitted,
 * inline content re-encoded from its payload bytes — base64url without
 * padding, or the JSON the canonical bytes parse to. The payload is
 * the object `data.root` names, as long as `byte_count`, and for JSON
 * already canonical; a links descriptor takes none. A payload that
 * fails those is refused rather than re-normalized, since `storeMessage`
 * on the other side would derive another document from it.
 */
export function wireAttachment(stored: StoredAttachment, payload: Uint8Array | null): JsonObject {
  const wire: JsonObject = {};
  for (const member of ["id", ...DESCRIPTOR_STRINGS, "lastmod_time", "byte_count"] as const) {
    const value = stored[member];
    if (value !== null) wire[member] = value;
  }
  const data: JsonObject = {};
  const { kind } = stored.data;
  if (kind === "links") {
    data.links = [...stored.data.links];
  } else {
    if (payload === null) throw new InvalidPlaintext(`a ${kind} attachment needs its payload bytes`);
    if (rawCidOfBytes(payload) !== stored.data.root) throw new InvalidPlaintext(`the payload is not the object ${stored.data.root}`);
    if (payload.length !== stored.byte_count) throw new InvalidPlaintext(`the payload is ${payload.length} bytes, not the stored byte_count ${stored.byte_count}`);
    if (kind === "base64") data.base64 = base64urlnopad.encode(payload);
    else data.json = canonicalJsonPayload(payload, stored.data.root);
  }
  if (stored.data.hash !== null) data.hash = stored.data.hash;
  if (stored.data.jws !== null) data.jws = stored.data.jws;
  wire.data = data;
  return wire;
}
