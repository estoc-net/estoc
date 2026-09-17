/**
 * The deterministic identifiers: the reproducible UUIDv5 namespaces and
 * every entity ID a rule derives rather than mints — an inbound
 * observation, an execution, an automatic effect's key and message —
 * the channel a local and a peer DID form and the order channels are
 * kept in, plus the reserved keystore names. Each derivation hashes
 * exactly the transcript its rule specifies, never a payload or an API
 * object standing in for it.
 */

import { canonicalText, canonicalize, forbiddenIn, type JsonValue } from "@estoc/event-store/v3";
import { sha256 } from "@noble/hashes/sha2";
import { base64urlnopad } from "@scure/base";
import { v5 as uuidv5 } from "uuid";

import { InvalidIdentifier } from "./errors.js";
import type { Channel, Did, DidId, EffectKey, ExecutionId, KeyName, MediationId, MessageId, WireMessageId } from "./types.js";

export const NAMESPACE_PURPOSES = ["inbound-message", "message-execution", "automatic-mid"] as const;

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
 * The channel between one of our DIDs and a peer's, an ordered pair:
 * receiving from the peer at the local DID and sending from it to the
 * peer are the same channel, the reverse pair is another vault's view.
 * The caller canonicalizes both spellings; equal endpoints are no
 * channel.
 */
export function channelOf(localDid: Did, peerDid: Did): Channel {
  nonEmpty(localDid, "local DID");
  nonEmpty(peerDid, "peer DID");
  if (localDid === peerDid) throw new InvalidIdentifier("a channel needs two distinct DIDs");
  return { localDid, peerDid };
}

/** The canonical text a channel sorts and indexes by: `RFC8785([localDid, peerDid])`. */
export function channelKey(channel: Channel): string {
  return canonicalText([channel.localDid, channel.peerDid]);
}

export function sameChannel(a: Channel, b: Channel): boolean {
  return a.localDid === b.localDid && a.peerDid === b.peerDid;
}

/** The order of a set of channels: unsigned UTF-8 byte order of their keys. It sorts a set, not the two ends of a pair. */
export function compareChannels(a: Channel, b: Channel): number {
  return compareUtf8(channelKey(a), channelKey(b));
}

/**
 * The observation group of an authenticated inbound message: by the
 * canonical sender and recipient DIDs and the wire ID, so that the same
 * input under another authorized key of the sender's document
 * converges, and the reverse direction under the same wire ID does not.
 */
export function inboundMessageId(sender: Did, recipient: Did, wireMessageId: WireMessageId): MessageId {
  return derive("inbound-message", ["v3", "authenticated", nonEmpty(sender, "sender DID"), nonEmpty(recipient, "recipient DID"), nonEmpty(wireMessageId, "wire message ID")]) as MessageId;
}

/** The observation group of an anonymous inbound message: by the local key that decrypted it and the wire ID. */
export function anonymousMessageId(localKeyName: KeyName, wireMessageId: WireMessageId): MessageId {
  return derive("inbound-message", ["v1", "anonymous", nonEmpty(localKeyName, "local key name"), nonEmpty(wireMessageId, "wire message ID")]) as MessageId;
}

/**
 * The execution of one carrier in one channel: the peer is the sender,
 * the local DID the recipient. The transcript's members are the literal
 * tags `sender` and `recipient`, which RFC 8785 orders; the payload's
 * member names are no substitute.
 */
export function executionId(sender: Did, recipient: Did, wireMessageId: WireMessageId): ExecutionId {
  return derive("message-execution", ["v4", { sender: nonEmpty(sender, "sender DID"), recipient: nonEmpty(recipient, "recipient DID") }, nonEmpty(wireMessageId, "wire message ID")]) as ExecutionId;
}

const EFFECT_TAG = "estoc/effect/3\0";
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The idempotency key of an effect: SHA-256 over its tagged,
 * NUL-separated tuple. The effect type is the operation's URI, spelled
 * exactly; it must be text an event can carry — an unpaired surrogate
 * would encode as U+FFFD and make distinct inputs one key — so it is
 * refused here, before the event layer would refuse it.
 */
export function effectKey(executionId: ExecutionId, effectType: string): EffectKey {
  if (!URI_SCHEME.test(effectType) || effectType.includes("\0")) throw new InvalidIdentifier("an effect type is a URI with a scheme and no U+0000");
  const fault = forbiddenIn(effectType);
  if (fault !== null) throw new InvalidIdentifier(`effect type: ${fault}`);
  const transcript = `${EFFECT_TAG}${nonEmpty(executionId, "execution ID")}\0${effectType}`;
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
