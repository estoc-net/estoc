/**
 * The schema of each version-3 event type: the closed member set of its
 * payload, each member's type and nullability, the rules that hold
 * between members, and what its `roots` must be. `readVaultEvent`
 * accepts an event of a known type or throws `InvalidPayload`; what it
 * cannot see — whether a referenced event exists, whether a derived ID
 * matches evidence held elsewhere — is for the folds.
 */

import { isEventId, isJsonObject, isRawCid, type Draft, type Event } from "@estoc/event-store/v3";

import { InvalidIdentifier, InvalidPayload, InvalidPlaintext, InvalidPublicKey } from "./errors.js";
import { automaticMessageId, effectKey, inboundMessageId, mediationKeyName, parseDecimalOrdinal } from "./ids.js";
import { messageRoots } from "./document.js";
import { checkHeaders } from "./projection.js";
import { parsePublicKey } from "./public-key.js";
import {
  isCompactJwt,
  isDerivedId,
  isDid,
  isDidUrl,
  isEntityId,
  isEpochSeconds,
  isKeyName,
  isMessageHash,
  isMintedId,
  isPeer4Long,
  isPeer4Short,
  isReceiptOrdinal,
} from "./syntax.js";
import type {
  Cid,
  ContactId,
  Did,
  DidId,
  DidUrl,
  EventReference,
  ExecutionId,
  KeyName,
  MediationId,
  MessageHash,
  MessageId,
  PackageId,
  PublicKey,
  ReceiptOrdinal,
  RelationshipId,
  RouteId,
  VaultData,
  VaultEventType,
  WireMessageId,
} from "./types.js";

export type VaultEvent<T extends VaultEventType = VaultEventType> = T extends VaultEventType ? Event<VaultData[T]> & { type: T } : never;
export type VaultDraft<T extends VaultEventType = VaultEventType> = T extends VaultEventType ? Required<Draft<VaultData[T]>> & { type: T } : never;

// ---- the checks ---------------------------------------------------------

class Fault extends Error {}

type Check<T> = (value: unknown, at: string) => T;

function fail(at: string, what: string): never {
  throw new Fault(`${at} is ${what}`);
}

const text: Check<string> = (value, at) => (typeof value === "string" ? value : fail(at, "a string"));
const nonEmpty: Check<string> = (value, at) => (typeof value === "string" && value !== "" ? value : fail(at, "a non-empty string"));
const bool: Check<boolean> = (value, at) => (typeof value === "boolean" ? value : fail(at, "a boolean"));
const epochSeconds: Check<number> = (value, at) => (isEpochSeconds(value) ? value : fail(at, "an integer count of seconds"));
const count: Check<number> = (value, at) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail(at, "a non-negative integer"));
const did: Check<Did> = (value, at) => (isDid(value) ? (value as Did) : fail(at, "a DID"));
/** A DID as folds compare it: a did:peer:4 is its short form. */
const canonicalDid: Check<Did> = (value, at) => (isDid(value) && (!value.startsWith("did:peer:4") || isPeer4Short(value)) ? (value as Did) : fail(at, "a canonical DID"));
const didUrl: Check<DidUrl> = (value, at) => (isDidUrl(value) ? (value as DidUrl) : fail(at, "a DID URL"));
const keyName: Check<KeyName> = (value, at) => (isKeyName(value) ? (value as KeyName) : fail(at, "a vault key name"));
const publicKey: Check<PublicKey> = (value, at) => {
  if (typeof value !== "string") fail(at, "a canonical public key");
  try {
    return parsePublicKey(value);
  } catch (err) {
    if (err instanceof InvalidPublicKey) fail(at, `a canonical public key: ${err.message}`);
    throw err;
  }
};
const cid: Check<Cid> = (value, at) => (isRawCid(value) ? value : fail(at, "a raw DASL CID"));
const hash: Check<MessageHash> = (value, at) => (isMessageHash(value) ? (value as MessageHash) : fail(at, "an unpadded base64url SHA-256"));
const compactJwt: Check<string> = (value, at) => (isCompactJwt(value) ? value : fail(at, "a compact JWT"));
const receiptOrdinal: Check<ReceiptOrdinal> = (value, at) => (isReceiptOrdinal(value) ? (value as ReceiptOrdinal) : fail(at, "a canonical positive decimal"));
const headers: Check<VaultData["message.out"]["headers"]> = (value, at) => {
  try {
    return checkHeaders(value, at);
  } catch (err) {
    if (err instanceof InvalidPlaintext) throw new Fault(err.message);
    throw err;
  }
};

/** A locally minted entity ID: UUIDv7. */
const minted = <T extends string>(): Check<T> => (value, at) => (isMintedId(value) ? (value as T) : fail(at, "a canonical UUIDv7"));
/** A derived entity ID: UUIDv5. */
const derived = <T extends string>(): Check<T> => (value, at) => (isDerivedId(value) ? (value as T) : fail(at, "a canonical UUIDv5"));
/** An entity ID a rule may mint or derive. */
const entity = <T extends string>(): Check<T> => (value, at) => (isEntityId(value) ? (value as T) : fail(at, "a canonical UUIDv5 or UUIDv7"));
const ref = <T extends string>(): Check<EventReference<T>> => (value, at) => (isEventId(value) ? (value as EventReference<T>) : fail(at, "an event ID"));

const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (value, at) =>
    value === null ? null : check(value, at);

const oneOf =
  <const V extends readonly string[]>(values: V): Check<V[number]> =>
  (value, at) =>
    typeof value === "string" && values.includes(value) ? (value as V[number]) : fail(at, `one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);

const arrayOf =
  <T>(check: Check<T>, options: { distinct?: boolean; nonEmpty?: boolean } = {}): Check<T[]> =>
  (value, at) => {
    if (!Array.isArray(value)) fail(at, "an array");
    if (options.nonEmpty === true && value.length === 0) fail(at, "non-empty");
    const entries = value.map((entry, i) => check(entry, `${at}[${i}]`));
    if (options.distinct === true && new Set(entries).size !== entries.length) fail(at, "distinct");
    return entries;
  };

type Shape = { readonly [member: string]: Check<unknown> };
type Of<S extends Shape> = { [M in keyof S]: S[M] extends Check<infer T> ? T : never };

/** An object with exactly the members of `shape`, each checked. */
const shape =
  <S extends Shape>(members: S): Check<Of<S>> =>
  (value, at) => {
    if (!isJsonObject(value)) fail(at, "a JSON object");
    for (const member of Object.keys(members)) {
      if (!Object.hasOwn(value, member)) throw new Fault(`${at}.${member} is missing`);
    }
    for (const member of Object.keys(value)) {
      if (!Object.hasOwn(members, member)) throw new Fault(`${at}.${member} is not a member`);
    }
    const out: Record<string, unknown> = {};
    for (const [member, check] of Object.entries(members)) out[member] = check(value[member], `${at}.${member}`);
    return out as Of<S>;
  };

/** `shape`, then rules between members. */
const checked =
  <T>(check: Check<T>, rules: (data: T) => void): Check<T> =>
  (value, at) => {
    const data = check(value, at);
    rules(data);
    return data;
  };

// ---- roots --------------------------------------------------------------

function rootsAre(roots: readonly Cid[], expected: readonly Cid[]): void {
  if (roots.length !== expected.length || roots.some((root, i) => root !== expected[i])) {
    throw new Fault(`roots must be [${expected.join(", ")}], not [${roots.join(", ")}]`);
  }
}

const contentRoots = (data: { bodyCid: Cid; attachmentCids: Cid[] }): Cid[] => messageRoots(data.bodyCid, data.attachmentCids);

// ---- the schemas --------------------------------------------------------

const idMembers = {
  mediationId: minted<MediationId>(),
  routeId: minted<RouteId>(),
  didId: entity<DidId>(),
  contactId: entity<ContactId>(),
  relationshipId: derived<RelationshipId>(),
  packageId: minted<PackageId>(),
};

const timing = {
  createdTime: nullable(epochSeconds),
  expiresTime: nullable(epochSeconds),
  pleaseAck: nullable(arrayOf(text)),
  ack: arrayOf(text),
  headers,
};

function expiryAfterCreation(data: { createdTime: number | null; expiresTime: number | null }): void {
  if (data.createdTime !== null && data.expiresTime !== null && data.expiresTime <= data.createdTime) {
    throw new Fault("expiresTime must be later than createdTime");
  }
}

const messageOut = checked(
  shape({
    messageId: entity<MessageId>(),
    relationshipId: idMembers.relationshipId,
    birth: nullable(shape({ localDidId: idMembers.didId, peerDid: did })),
    msgType: nonEmpty,
    thid: nullable(nonEmpty),
    pthid: nullable(nonEmpty),
    ...timing,
    bodyCid: cid,
    attachmentCids: arrayOf(cid, { distinct: true }),
    intentHash: hash,
    executionId: nullable(derived<ExecutionId>()),
    handlerId: nullable(nonEmpty),
    effectKind: nullable(nonEmpty),
    ordinal: nullable(text),
    effectKey: nullable(text),
  }),
  (data) => {
    expiryAfterCreation(data);
    const effect = [data.executionId, data.handlerId, data.effectKind, data.ordinal, data.effectKey];
    const present = effect.filter((member) => member !== null).length;
    if (present === 0) {
      if (!isMintedId(data.messageId)) throw new Fault("a locally initiated send mints a UUIDv7 messageId");
      if (data.ack.length > 0) throw new Fault("a locally initiated send has ack []");
      return;
    }
    if (present !== effect.length) throw new Fault("executionId, handlerId, effectKind, ordinal and effectKey are all null or all present");
    const tuple = {
      executionId: data.executionId as ExecutionId,
      handlerId: data.handlerId as string,
      effectKind: data.effectKind as string,
      ordinal: parseDecimalOrdinal(data.ordinal as string),
    };
    const key = effectKey(tuple);
    if (data.effectKey !== key) throw new Fault(`effectKey is not the key of the producing tuple, ${key}`);
    const messageId = automaticMessageId(key);
    if (data.messageId !== messageId) throw new Fault(`an automatic effect's messageId is derived from its key: ${messageId}`);
  }
) as Check<VaultData["message.out"]>;

const messageIn = checked(
  shape({
    messageId: derived<MessageId>(),
    wireMessageId: nonEmpty as Check<WireMessageId>,
    receiptOrdinal,
    intentHash: hash,
    plaintextHash: hash,
    localKeyName: keyName,
    msgType: nonEmpty,
    peerResolutionEventId: nullable(ref<"peer.resolved">()),
    relationshipBindingEventId: nullable(ref<"relationship.bound">()),
    peerTransitionEventId: nullable(ref<"relationship.peerTransitioned">()),
    presentedDid: nullable(did),
    did: nullable(canonicalDid),
    thid: nullable(nonEmpty),
    pthid: nullable(nonEmpty),
    ...timing,
    fromPrior: nullable(compactJwt),
    bodyCid: cid,
    attachmentCids: arrayOf(cid, { distinct: true }),
    bytes: count,
    signedBy: nullable(nonEmpty),
    receivedVia: shape({ mediationId: nullable(idMembers.mediationId), deliveryId: nullable(nonEmpty) }),
  }),
  (data) => {
    expiryAfterCreation(data);
    const anonymous = data.peerResolutionEventId === null;
    if (anonymous !== (data.did === null) || anonymous !== (data.presentedDid === null)) {
      throw new Fault("peerResolutionEventId, did and presentedDid are null together, for an anonymous observation");
    }
    if (anonymous) {
      if (data.signedBy !== null) throw new Fault("a signed sender has resolution evidence");
      if (data.relationshipBindingEventId !== null || data.peerTransitionEventId !== null) throw new Fault("an anonymous observation has no relationship evidence");
      const messageId = inboundMessageId({ localKeyName: data.localKeyName }, data.wireMessageId);
      if (data.messageId !== messageId) throw new Fault(`an anonymous observation's messageId is derived from its local key and wire ID: ${messageId}`);
    }
  }
) as Check<VaultData["message.in"]>;

const routeConfigured = checked(
  shape({ routeId: idMembers.routeId, kind: oneOf(["mediated", "direct"]), mediationId: nullable(idMembers.mediationId), endpoint: nullable(nonEmpty) }),
  (data) => {
    if (data.kind === "mediated") {
      if (data.mediationId === null || data.endpoint !== null) throw new Fault("a mediated route has a mediationId and no endpoint");
      return;
    }
    if (data.mediationId !== null || data.endpoint === null) throw new Fault("a direct route has an endpoint and no mediationId");
    let url: URL;
    try {
      url = new URL(data.endpoint);
    } catch {
      throw new Fault("endpoint is an absolute URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "wss:") throw new Fault("endpoint is an HTTPS or WSS URL");
  }
) as Check<VaultData["route.configured"]>;

type Schema<T extends VaultEventType> = { readonly check: Check<VaultData[T]>; readonly roots: (data: VaultData[T]) => readonly Cid[] };

function schema<T extends VaultEventType>(check: Check<VaultData[T]>, roots: (data: VaultData[T]) => readonly Cid[]): Schema<T> {
  return { check, roots };
}

const none = () => [] as const;

const SCHEMAS: { [T in VaultEventType]: Schema<T> } = {
  "identity.label": schema(shape({ name: text }), none),
  "peer.resolved": schema(
    shape({
      localKeyName: keyName,
      peerPublicKey: publicKey,
      presentedDid: did,
      did: canonicalDid,
      documentCid: cid,
      authenticationMethodIds: arrayOf(didUrl, { distinct: true }),
      keyAgreementMethodIds: arrayOf(didUrl, { distinct: true }),
      service: nullable(nonEmpty),
    }),
    (data) => [data.documentCid]
  ),
  "mediation.created": schema(
    checked(shape({ mediationId: idMembers.mediationId, mediatorDid: did, me: shape({ keyName, did }) }), (data) => {
      const expected = mediationKeyName(data.mediationId);
      if (data.me.keyName !== expected) throw new Fault(`me.keyName is the arrangement's own key, ${expected}`);
    }),
    none
  ),
  "mediation.granted": schema(shape({ mediationId: idMembers.mediationId, routingDid: did }), none),
  "mediation.selected": schema(shape({ mediationId: idMembers.mediationId }), none),
  "mediation.retired": schema(shape({ mediationId: idMembers.mediationId, because: nonEmpty }), none),
  "did.created": schema(
    checked(shape({ didId: idMembers.didId, did: text, longFormDid: text, boundRouteId: idMembers.routeId }), (data) => {
      if (!isPeer4Short(data.did)) throw new Fault("did is a did:peer:4 short form");
      if (!isPeer4Long(data.longFormDid) || !data.longFormDid.startsWith(`${data.did}:`)) throw new Fault("longFormDid is the did:peer:4 long form of did");
    }) as Check<VaultData["did.created"]>,
    none
  ),
  "route.configured": schema(routeConfigured, none),
  "route.retired": schema(shape({ routeId: idMembers.routeId, because: nonEmpty }), none),
  "did.disclosed": schema(
    checked(shape({ didId: idMembers.didId, as: oneOf(["oob", "profile", "direct"]), uses: oneOf(["one", "many"]), oobId: nullable(nonEmpty), goal: nullable(text) }), (data) => {
      if ((data.as === "oob") !== (data.oobId !== null)) throw new Fault("oobId is present exactly for an oob disclosure");
    }),
    none
  ),
  "did.retired": schema(shape({ didId: idMembers.didId, because: nonEmpty }), none),
  "relationship.bound": schema(shape({ relationshipId: idMembers.relationshipId, localDidId: idMembers.didId, peerResolutionEventId: ref<"peer.resolved">() }), none),
  "relationship.contactAssigned": schema(shape({ relationshipId: idMembers.relationshipId, contactId: idMembers.contactId }), none),
  "relationship.peerTransitioned": schema(
    checked(
      shape({
        relationshipId: idMembers.relationshipId,
        localKeyName: keyName,
        peerPublicKey: publicKey,
        fromDid: canonicalDid,
        presentedFromDid: did,
        toDid: canonicalDid,
        presentedToDid: did,
        fromPrior: compactJwt,
        priorResolutionEventId: ref<"peer.resolved">(),
        peerResolutionEventId: ref<"peer.resolved">(),
        messageId: derived<MessageId>(),
      }),
      (data) => {
        if (data.fromDid === data.toDid) throw new Fault("fromDid and toDid differ: a transition moves to another DID");
      }
    ),
    none
  ),
  "relationship.localTransitioned": schema(
    checked(
      shape({ relationshipId: idMembers.relationshipId, fromDidId: idMembers.didId, toDidId: idMembers.didId, fromPrior: compactJwt, triggerEventId: nullable(ref<"message.in">()) }),
      (data) => {
        if (data.fromDidId === data.toDidId) throw new Fault("fromDidId and toDidId differ: a transition moves to another DID entity");
      }
    ),
    none
  ),
  "contact.created": schema(shape({ contactId: idMembers.contactId, because: oneOf(["user", "automatic"]) }), none),
  "contact.petname": schema(shape({ contactId: idMembers.contactId, name: text }), none),
  "contact.flag": schema(shape({ contactId: idMembers.contactId, flag: nonEmpty, value: bool }), none),
  "contact.useDid": schema(shape({ contactId: idMembers.contactId, didId: idMembers.didId, because: nonEmpty }), none),
  "contact.peerDidAdded": schema(shape({ contactId: idMembers.contactId, did, because: nonEmpty }), none),
  "contact.peerDidRemoved": schema(shape({ contactId: idMembers.contactId, addEventId: ref<"contact.peerDidAdded">() }), none),
  "contact.merged": schema(
    checked(shape({ contactId: idMembers.contactId, fromContactId: idMembers.contactId }), (data) => {
      if (data.contactId === data.fromContactId) throw new Fault("contactId and fromContactId are two contacts");
    }),
    none
  ),
  "contact.deleted": schema(shape({ contactId: idMembers.contactId }), none),
  "profile.nameClaimed": schema(shape({ relationshipId: idMembers.relationshipId, sourceEventId: ref<"message.in">(), name: text }), none),
  "profile.shared": schema(shape({ relationshipId: idMembers.relationshipId, sourceEventId: ref<"message.out">() }), none),
  "message.out": schema(messageOut, contentRoots),
  "message.prepared": schema(
    shape({
      messageId: entity<MessageId>(),
      packageId: idMembers.packageId,
      senderDidId: idMembers.didId,
      localKeyName: keyName,
      recipientDid: did,
      peerResolutionEventId: ref<"peer.resolved">(),
      fromPrior: nullable(compactJwt),
      intentHash: hash,
      plaintextHash: hash,
      envelopeCid: cid,
    }),
    (data) => [data.envelopeCid]
  ),
  "message.packageRetired": schema(
    shape({ messageId: entity<MessageId>(), packageId: idMembers.packageId, because: nonEmpty, replacementPackageId: nullable(idMembers.packageId) }),
    none
  ),
  "delivery.submitted": schema(shape({ messageId: entity<MessageId>(), packageId: idMembers.packageId }), none),
  "delivery.failed": schema(
    checked(shape({ messageId: entity<MessageId>(), scope: oneOf(["package", "message"]), packageId: nullable(idMembers.packageId), code: nonEmpty }), (data) => {
      if (data.scope === "package" && data.packageId === null) throw new Fault("a package-scoped failure names its package");
      if ((data.code === "expired" || data.code === "peer-key-changed") && data.scope !== "message") throw new Fault(`${data.code} is message-scoped`);
      if (data.code === "peer-key-changed" && data.packageId !== null) throw new Fault("peer-key-changed happens before any package");
    }),
    none
  ),
  "delivery.acknowledged": schema(
    shape({
      messageId: entity<MessageId>(),
      localKeyName: keyName,
      peerPublicKey: publicKey,
      ackMessageId: derived<MessageId>(),
      ackWireMessageId: nonEmpty as Check<WireMessageId>,
    }),
    none
  ),
  "message.in": schema(messageIn, contentRoots),
  "message.erased": schema(shape({ messageId: entity<MessageId>(), dropCids: arrayOf(cid, { distinct: true, nonEmpty: true }), because: nonEmpty }), none),
};

export const VAULT_EVENT_TYPES = Object.freeze(Object.keys(SCHEMAS) as VaultEventType[]);

export function isVaultEventType(type: string): type is VaultEventType {
  return Object.hasOwn(SCHEMAS, type);
}

function read<T extends VaultEventType>(type: T, data: unknown, roots: readonly Cid[]): VaultData[T] {
  const { check, roots: rootsOf } = SCHEMAS[type];
  try {
    const payload = check(data, "data");
    rootsAre(roots, rootsOf(payload));
    return payload;
  } catch (err) {
    if (err instanceof Fault || err instanceof InvalidIdentifier) throw new InvalidPayload(type, err.message);
    throw err;
  }
}

/**
 * `event` as an event of its type, or `InvalidPayload`. An unknown type
 * is refused too: a reader that preserves unknown events checks
 * `isVaultEventType` first and keeps those as they are.
 */
export function readVaultEvent(event: Event): VaultEvent {
  if (!isVaultEventType(event.type)) throw new InvalidPayload(event.type, "not a version-3 event type");
  read(event.type, event.data, event.roots);
  return event as VaultEvent;
}

/** A draft as a draft of its type, `roots` filled in, or `InvalidPayload`. */
export function readVaultDraft(draft: Draft): VaultDraft {
  if (!isVaultEventType(draft.type)) throw new InvalidPayload(draft.type, "not a version-3 event type");
  const roots = draft.roots ?? [];
  read(draft.type, draft.data, roots);
  return { ...draft, roots } as VaultDraft;
}

/** A checked draft of one event type with the `roots` its schema requires, so a caller names only the payload. */
export function vaultDraft<T extends VaultEventType>(type: T, data: VaultData[T]): VaultDraft<T> {
  const roots = [...SCHEMAS[type].roots(data)];
  return readVaultDraft({ type, roots, data }) as VaultDraft<T>;
}
