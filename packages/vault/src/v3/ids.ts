/**
 * The deterministic identifiers: the reproducible UUIDv5 namespaces and
 * every entity ID a rule derives rather than mints — a relationship and
 * its default contact and early private DID, an inbound observation, an
 * execution, an automatic effect's key and message — plus the reserved
 * keystore names. Each derivation hashes exactly the transcript its rule
 * specifies, never a payload or an API object standing in for it.
 */

import { canonicalize, forbiddenIn, type JsonValue } from "@estoc/event-store/v3";
import { sha256 } from "@noble/hashes/sha2";
import { base64urlnopad } from "@scure/base";
import { v5 as uuidv5 } from "uuid";

import { InvalidIdentifier } from "./errors.js";
import type {
  ContactId,
  DecimalOrdinal,
  Did,
  DidId,
  EffectKey,
  ExecutionId,
  KeyName,
  MediationId,
  MessageId,
  PublicKey,
  RelationshipId,
  WireMessageId,
} from "./types.js";

export const NAMESPACE_PURPOSES = [
  "inbound-message",
  "message-execution",
  "automatic-mid",
  "relationship",
  "relationship-local-did",
  "relationship-contact",
] as const;

export type NamespacePurpose = (typeof NAMESPACE_PURPOSES)[number];

const NAMESPACE_URI = "https://estoc.dev/uuid/v1/";

const namespaces = new Map<NamespacePurpose, string>();

/** The UUIDv5 namespace of one purpose, derived from the RFC 9562 URL namespace. */
export function estocNamespace(purpose: NamespacePurpose): string {
  let namespace = namespaces.get(purpose);
  if (namespace === undefined) {
    namespace = uuidv5(NAMESPACE_URI + purpose, uuidv5.URL);
    namespaces.set(purpose, namespace);
  }
  return namespace;
}

function derive(purpose: NamespacePurpose, transcript: JsonValue): string {
  return uuidv5(canonicalize(transcript), estocNamespace(purpose));
}

function nonEmpty(value: string, what: string): string {
  if (value.length === 0) throw new InvalidIdentifier(`${what} is empty`);
  return value;
}

const encoder = new TextEncoder();

/** Unsigned UTF-8 byte order, which differs from code-unit order beyond the BMP. */
export function compareUtf8(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * The relationship born of two distinct canonical birth DIDs, the same
 * from either end. The caller canonicalizes: a numalgo-4 short form for
 * a validated long form, the exact presented string for a method with
 * no canonical form.
 */
export function relationshipId(a: Did, b: Did): RelationshipId {
  nonEmpty(a, "birth DID");
  nonEmpty(b, "birth DID");
  if (a === b) throw new InvalidIdentifier("a relationship needs two distinct birth DIDs");
  const [lo, hi] = compareUtf8(a, b) < 0 ? [a, b] : [b, a];
  return derive("relationship", ["v1", lo, hi]) as RelationshipId;
}

/** The contact a relationship gets when nothing else assigned it one. */
export function contactIdOf(relationship: RelationshipId): ContactId {
  return derive("relationship-contact", ["v1", nonEmpty(relationship, "relationship ID")]) as ContactId;
}

/** This end's default private successor address in a relationship. */
export function earlyPrivateDidId(relationship: RelationshipId, localBirthDid: Did): DidId {
  return derive("relationship-local-did", [
    "v1",
    nonEmpty(relationship, "relationship ID"),
    nonEmpty(localBirthDid, "local birth DID"),
  ]) as DidId;
}

/**
 * The observation group of an inbound message: by the peer key that
 * authenticated it, so a repack to another local key converges; by the
 * local key that decrypted it when the sender is anonymous.
 */
export function inboundMessageId(sender: PublicKey | { localKeyName: KeyName }, wireMessageId: WireMessageId): MessageId {
  nonEmpty(wireMessageId, "wire message ID");
  const transcript =
    typeof sender === "string"
      ? ["v1", "authenticated", nonEmpty(sender, "peer public key"), wireMessageId]
      : ["v1", "anonymous", nonEmpty(sender.localKeyName, "local key name"), wireMessageId];
  return derive("inbound-message", transcript) as MessageId;
}

/**
 * The execution of one carrier in one relationship. The transcript's
 * member is the literal `relationship`, a fixed tag: hashing the runtime
 * scope object with its `relationshipId` member gives another value.
 */
export function executionId(relationship: RelationshipId, wireMessageId: WireMessageId): ExecutionId {
  return derive("message-execution", [
    "v2",
    { relationship: nonEmpty(relationship, "relationship ID") },
    nonEmpty(wireMessageId, "wire message ID"),
  ]) as ExecutionId;
}

const DECIMAL_ORDINAL = /^(0|[1-9][0-9]*)$/;

export function decimalOrdinal(ordinal: number): DecimalOrdinal {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new InvalidIdentifier(`not a non-negative integer ordinal: ${ordinal}`);
  return String(ordinal) as DecimalOrdinal;
}

export function parseDecimalOrdinal(text: string): DecimalOrdinal {
  if (!DECIMAL_ORDINAL.test(text)) throw new InvalidIdentifier(`not a canonical decimal ordinal: ${JSON.stringify(text)}`);
  return text as DecimalOrdinal;
}

/** What identifies one automatic effect, as `message.out` stores it. */
export interface EffectTuple {
  readonly executionId: ExecutionId;
  readonly handlerId: string;
  readonly effectKind: string;
  readonly ordinal: DecimalOrdinal;
}

const EFFECT_TAG = "estoc/effect/3\0";

function effectMember(value: string, what: string): string {
  if (value.length === 0 || value.includes("\0")) throw new InvalidIdentifier(`${what} must be non-empty without U+0000`);
  const fault = forbiddenIn(value);
  if (fault !== null) throw new InvalidIdentifier(`${what}: ${fault}`);
  return value;
}

/**
 * The idempotency key of an effect: SHA-256 over its tagged, NUL-separated
 * tuple. The handler ID and kind must be text an event can carry — an
 * unpaired surrogate would encode as U+FFFD and make distinct inputs one
 * key — so they are refused here, before the event layer would refuse them.
 */
export function effectKey(tuple: EffectTuple): EffectKey {
  const transcript = [
    EFFECT_TAG + nonEmpty(tuple.executionId, "execution ID"),
    effectMember(tuple.handlerId, "handler ID"),
    effectMember(tuple.effectKind, "effect kind"),
    parseDecimalOrdinal(tuple.ordinal),
  ].join("\0");
  return base64urlnopad.encode(sha256(encoder.encode(transcript))) as EffectKey;
}

/** The message ID, and so the wire ID, of the one response an effect key names. */
export function automaticMessageId(key: EffectKey): MessageId {
  return derive("automatic-mid", ["v1", nonEmpty(key, "effect key")]) as MessageId;
}

export const ANCHOR_KEY_NAME = "anchor" as KeyName;

export type DidKeyRole = "authentication" | "key-agreement";

/** The name of one of the two keys of a communication-DID entity. */
export function didKeyName(did: DidId, role: DidKeyRole): KeyName {
  return `did/${nonEmpty(did, "DID entity ID")}/${role}` as KeyName;
}

/** The name of the DIDComm identity key of one mediation arrangement. */
export function mediationKeyName(mediation: MediationId): KeyName {
  return `mediation/${nonEmpty(mediation, "mediation ID")}/me` as KeyName;
}
