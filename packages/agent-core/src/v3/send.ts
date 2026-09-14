/**
 * Sending decides what a message is, and commits it, before any
 * network work: the intent is frozen offline in the relationship it
 * belongs to, and the resolution, the binding and the package come
 * later, from the intent left behind. Everything the fold answers is
 * read under the writer lock, in the same commit's view, so no other
 * writer can move the pair between the decision and the record.
 */

import { v7 as uuidv7 } from "uuid";

import { canonicalText, parseStrict, type Held, type JsonObject, type VaultRuntime } from "@estoc/event-store/v3";
import {
  canonicalDidOf,
  intentHash,
  mintDid,
  readVaultEvent,
  relationshipId as relationshipIdOf,
  samePayload,
  scanVault,
  senderGate,
  storeMessage,
  vaultDraft,
  type AdditionalHeaders,
  type Birth,
  type Cid,
  type ContactId,
  type ContactView,
  type Did,
  type DidId,
  type EpochSeconds,
  type Intent,
  type Keys,
  type MessageId,
  type MessageOut,
  type MintedDid,
  type Outbound,
  type RelationshipId,
  type RouteId,
  type VaultDraft,
  type VaultEvent,
  type VaultEventType,
  type VaultFold,
} from "@estoc/vault/v3";

import { didOf, routeTargetOf } from "./dids.js";
import { AmbiguousTarget, EntityConflict, UnknownEntity, Unusable } from "./errors.js";
import { objectsHeld } from "./evidence.js";

/** The content of a message to send: the application body and attachments in wire form, and the control headers the intent freezes. */
export interface Content {
  type: string;
  body: JsonObject;
  /** attachment descriptors as the wire carries them, each with exactly one of `base64`, `json` and `links` */
  attachments?: readonly JsonObject[];
  thid?: string | null;
  pthid?: string | null;
  createdTime?: EpochSeconds | null;
  expiresTime?: EpochSeconds | null;
  /** null omits the wire header; an array is carried exactly, `""` naming this message */
  pleaseAck?: readonly string[] | null;
  headers?: AdditionalHeaders;
}

/** The local address a new pair is born at: an entity already recorded, or one minted now on a route, private to the pair. */
export type Sender = { didId: DidId; fresh?: undefined } | { fresh: RouteId; didId?: DidId };

/**
 * Whom to send to: a contact, in the one relationship it may be
 * written in — the preferred one when a preference names it — or a
 * new pair with the one peer DID added to it; or an exact peer
 * spelling from a sender, in the relationship whose histories hold
 * that pair or a new one born at it, assigned to `contactId` when
 * named.
 */
export type Target = { contactId: ContactId; peerDid?: undefined; sender?: Sender } | { peerDid: string; sender: Sender; contactId?: ContactId };

/** What committing an intent for `target` takes, decided over the fold. */
export interface Selection {
  relationshipId: RelationshipId;
  /** the offline selection of a pair no binding holds yet; null in a bound relationship */
  birth: Birth | null;
  /** the sender minted for a fresh birth, with the route it is bound to; null when the sender is an entity already recorded */
  mint: { minted: MintedDid; routeId: RouteId } | null;
  /** the contact to assign the relationship to with the intent; null when it is assigned already or none was named */
  assign: ContactId | null;
}

export interface SendOptions {
  /** the message ID, for a send repeated after a crash: a fresh UUIDv7 when left out */
  messageId?: MessageId;
}

export interface Sent {
  messageId: MessageId;
  relationshipId: RelationshipId;
  birth: Birth | null;
  intent: VaultEvent<"message.out">;
  /** the sender minted for a fresh birth, null otherwise */
  created: VaultEvent<"did.created"> | null;
  assigned: VaultEvent<"relationship.contactAssigned"> | null;
  /** an equal intent under this message ID was there already, its objects held: nothing was written */
  existed: boolean;
}

type IntentFields = Omit<MessageOut, "relationshipId" | "birth">;

/**
 * The intent of `content` committed with its objects, in the
 * relationship `target` selects. A message ID the vault has already
 * is not selected for again: the same content and a target that names
 * the recorded relationship return what was committed, going in again
 * only when an object of it is missing; another intent or target under
 * the same ID is refused.
 */
export async function send(runtime: VaultRuntime, keys: Keys, target: Target, content: Content, options: SendOptions = {}): Promise<Sent> {
  const messageId = options.messageId ?? (uuidv7() as MessageId);
  const stored = storeMessage(content.body, content.attachments);
  const intent: Intent = {
    id: messageId,
    type: content.type,
    thid: content.thid ?? null,
    pthid: content.pthid ?? null,
    document: stored.document,
    createdTime: content.createdTime ?? null,
    expiresTime: content.expiresTime ?? null,
    pleaseAck: content.pleaseAck === undefined || content.pleaseAck === null ? null : [...content.pleaseAck],
    ack: [],
    headers: parseStrict(canonicalText(content.headers ?? {})) as AdditionalHeaders,
  };
  const fields: IntentFields = {
    messageId,
    msgType: intent.type,
    thid: intent.thid,
    pthid: intent.pthid,
    createdTime: intent.createdTime,
    expiresTime: intent.expiresTime,
    pleaseAck: intent.pleaseAck,
    ack: [],
    headers: intent.headers,
    bodyCid: stored.bodyCid,
    attachmentCids: stored.attachmentCids,
    intentHash: intentHash(intent),
    executionId: null,
    handlerId: null,
    effectKind: null,
    ordinal: null,
    effectKey: null,
  };
  const objects = [{ cid: stored.bodyCid, source: stored.bytes }, ...stored.payloads.map(({ cid, bytes }) => ({ cid, source: bytes }))];
  return runtime.locked(async (held) => {
    const fold = await scanVault(held, keys);
    const existing = fold.outbound.outbounds.get(messageId);
    if (existing !== undefined) return repeat(held, fold, existing, target, fields, objects, stored.roots);
    const selection = await selectTarget(fold, keys, target);
    const data: MessageOut = { ...fields, relationshipId: selection.relationshipId, birth: selection.birth };
    const drafts: VaultDraft[] = [];
    if (selection.mint !== null) {
      const { minted, routeId } = selection.mint;
      drafts.push(vaultDraft("did.created", { didId: minted.didId, did: minted.did, longFormDid: minted.longFormDid, boundRouteId: routeId }));
    }
    drafts.push(vaultDraft("message.out", data));
    if (selection.assign !== null) drafts.push(vaultDraft("relationship.contactAssigned", { relationshipId: selection.relationshipId, contactId: selection.assign }));
    const events = (await held.commit(objects, drafts)).map(readVaultEvent);
    const of = <T extends VaultEventType>(type: T): VaultEvent<T> | null => (events.find((event) => event.type === type) as VaultEvent<T> | undefined) ?? null;
    return { messageId, relationshipId: data.relationshipId, birth: data.birth, intent: of("message.out") as VaultEvent<"message.out">, created: of("did.created"), assigned: of("relationship.contactAssigned"), existed: false };
  });
}

/** A message ID the vault has: the recorded intent, once the caller's content and target agree with it, repaired when an object of it is missing. */
async function repeat(held: Held, fold: VaultFold, existing: Outbound, target: Target, fields: IntentFields, objects: { cid: Cid; source: Uint8Array }[], roots: readonly Cid[]): Promise<Sent> {
  const { messageId } = fields;
  if (existing.intent === null) throw new EntityConflict("message", messageId, "intents that disagree");
  const { relationshipId, birth } = existing.intent;
  if (!samePayload(existing.intent, { ...fields, relationshipId, birth })) throw new EntityConflict("message", messageId, "another intent");
  if (!targetAgrees(fold, target, existing.intent)) throw new EntityConflict("message", messageId, "another target");
  if (await objectsHeld(held, roots)) {
    const recorded = fold.set.of("message.out").find((event) => event.data.messageId === messageId) as VaultEvent<"message.out">;
    return { messageId, relationshipId, birth, intent: recorded, created: null, assigned: null, existed: true };
  }
  const [event] = (await held.commit(objects, [vaultDraft("message.out", existing.intent)])).map(readVaultEvent);
  return { messageId, relationshipId, birth, intent: event as VaultEvent<"message.out">, created: null, assigned: null, existed: false };
}

/**
 * Does `target` name the relationship a recorded intent is in: a
 * contact it is assigned to, or a pair its histories or birth hold at
 * a sender that is the intent's own — the DID named, or, for one
 * minted then, the DID the birth or binding roots, on the route named.
 */
function targetAgrees(fold: VaultFold, target: Target, intent: MessageOut): boolean {
  const relationship = fold.relationships.relationships.get(intent.relationshipId);
  if (target.contactId !== undefined && relationship?.contactId !== target.contactId) return false;
  if (target.peerDid === undefined) return target.sender === undefined || intent.birth === null || senderAgrees(fold, target.sender, intent.birth.localDidId);
  const localDidId = target.sender.didId ?? intent.birth?.localDidId ?? relationship?.binding?.localDidId ?? null;
  const localDid = localDidId === null ? undefined : fold.routes.dids.get(localDidId)?.created?.did;
  if (localDidId === null || localDid === undefined || !senderAgrees(fold, target.sender, localDidId)) return false;
  const peer = canonicalDidOf(target.peerDid);
  return relationshipIdOf(localDid, peer) === intent.relationshipId || fold.relationships.claimants(localDid, peer).includes(intent.relationshipId);
}

function senderAgrees(fold: VaultFold, sender: Sender, localDidId: DidId): boolean {
  if (sender.didId !== undefined && sender.didId !== localDidId) return false;
  return sender.fresh === undefined || fold.routes.dids.get(localDidId)?.created?.boundRouteId === sender.fresh;
}

/**
 * The relationship `target` names over `fold`, and what committing an
 * intent in it takes; a throw when there is none, more than one, or it
 * may not be written in now. A contact's peer DID seeds start a new
 * pair only while no relationship is assigned to it: one that is
 * assigned but may not be written in is reported, not gone around.
 */
export async function selectTarget(fold: VaultFold, keys: Keys, target: Target): Promise<Selection> {
  if (target.peerDid !== undefined) return selectAddress(fold, keys, target.peerDid, target.sender, target.contactId ?? null);
  const view = contactOf(fold, target.contactId);
  const gates = new Map(view.relationships.map((assigned) => [assigned.relationshipId, sendGate(fold, assigned.relationshipId)] as const));
  const open = [...gates.entries()].filter(([, gate]) => gate === null).map(([relationshipId]) => relationshipId);
  const chosen = view.preferred.length > 0 ? view.preferred : open;
  if (chosen.length === 1) return inRelationship(fold, chosen[0] as RelationshipId, null);
  if (chosen.length > 1) throw new AmbiguousTarget(target.contactId, chosen);
  if (gates.size > 0) throw new Unusable("contact", target.contactId, [...gates.entries()].map(([relationshipId, gate]) => `relationship ${relationshipId}: ${gate}`));
  const seeds = seedsOf(view);
  if (seeds.size !== 1) throw new Unusable("contact", target.contactId, [seeds.size === 0 ? "no relationship to write in and no peer DID added" : `no relationship to write in and ${seeds.size} peer DIDs added`]);
  if (target.sender === undefined) throw new Unusable("contact", target.contactId, ["no relationship to write in: a new pair needs a sender"]);
  const [spellings] = seeds.values();
  return selectAddress(fold, keys, richestSpelling(spellings as Did[]), target.sender, target.contactId);
}

/** The peer DIDs added to a contact and not removed, by canonical DID, each with its spellings in the order they were added. */
function seedsOf(view: ContactView): Map<Did, Did[]> {
  const seeds = new Map<Did, Did[]>();
  for (const seed of view.peerDidSeeds) {
    const canonical = canonicalDidOf(seed.did);
    const spellings = seeds.get(canonical);
    if (spellings === undefined) seeds.set(canonical, [seed.did]);
    else spellings.push(seed.did);
  }
  return seeds;
}

/** Of one DID's spellings, the first that carries its document, else the first: a long form resolves with no network. */
function richestSpelling(spellings: readonly Did[]): Did {
  return spellings.find((spelling) => canonicalDidOf(spelling) !== spelling) ?? (spellings[0] as Did);
}

async function selectAddress(fold: VaultFold, keys: Keys, peerDid: string, sender: Sender, contactId: ContactId | null): Promise<Selection> {
  const peer = canonicalDidOf(peerDid);
  if (sender.fresh !== undefined) {
    const didId = sender.didId ?? (uuidv7() as DidId);
    if (fold.routes.dids.has(didId)) throw new EntityConflict("DID", didId, "already recorded");
    const minted = await mintDid(keys, didId, routeTargetOf(fold, sender.fresh));
    return born(fold, { localDidId: didId, peerDid: peerDid as Did }, minted.did, peer, { minted, routeId: sender.fresh }, contactId);
  }
  const entity = didOf(fold, sender.didId);
  if (!entity.live) throw new Unusable("DID", entity.didId, entity.retired !== null ? [`retired: ${entity.retired}`, ...entity.faults] : entity.faults);
  const localDid = (entity.created as NonNullable<typeof entity.created>).did;
  const claimants = fold.relationships.claimants(localDid, peer);
  if (claimants.length === 1) return inRelationship(fold, claimants[0] as RelationshipId, contactId);
  const relationshipId = relationshipIdOf(localDid, peer);
  if (isBound(fold, relationshipId)) return inRelationship(fold, relationshipId, contactId);
  return born(fold, { localDidId: sender.didId, peerDid: peerDid as Did }, localDid, peer, null, contactId);
}

/** A relationship the fold has: bound, at its current ends; or unbound, at the birth its messages froze. */
function inRelationship(fold: VaultFold, relationshipId: RelationshipId, contactId: ContactId | null): Selection {
  const gate = sendGate(fold, relationshipId);
  if (gate !== null) throw new Unusable("relationship", relationshipId, [gate]);
  return { relationshipId, birth: isBound(fold, relationshipId) ? null : birthOf(fold, relationshipId), mint: null, assign: contactId === null ? null : assignmentOf(fold, relationshipId, contactId) };
}

/** A pair no binding holds yet: the relationship the pair derives, born at the exact spelling given now. */
function born(fold: VaultFold, birth: Birth, localDid: Did, peer: Did, mint: Selection["mint"], contactId: ContactId | null): Selection {
  const relationshipId = relationshipIdOf(localDid, peer);
  const assign = contactId === null ? null : assignmentOf(fold, relationshipId, contactId);
  if (mint !== null) return { relationshipId, birth, mint, assign };
  const gate = sendGate(fold, relationshipId, birth);
  if (gate !== null) throw new Unusable("relationship", relationshipId, [gate]);
  return { relationshipId, birth, mint: null, assign };
}

function isBound(fold: VaultFold, relationshipId: RelationshipId): boolean {
  return (fold.relationships.relationships.get(relationshipId)?.bindingEventIds.length ?? 0) > 0;
}

/**
 * Why no message may be sent in a relationship now, or null. A bound
 * relationship answers through its current local end. An unbound one
 * answers through its birth — the one given, or the one its messages
 * froze — whose local address must be live and whose pair no other
 * relationship's histories may hold or a pending claim reserve: the
 * same test a send to that pair by address makes, so a contact cannot
 * be written in a relationship its pair has since been claimed from.
 */
function sendGate(fold: VaultFold, relationshipId: RelationshipId, birth: Birth | null = null): string | null {
  const relationship = fold.relationships.relationships.get(relationshipId);
  if (relationship !== undefined && relationship.bindingEventIds.length > 0) return senderGate(fold, relationshipId);
  if (relationship?.conflict) return "the relationship is in conflict";
  const at = birth ?? birthOf(fold, relationshipId);
  if (at === null) return "the relationship has no binding and no queued birth";
  const entity = fold.routes.dids.get(at.localDidId);
  if (entity === undefined || entity.created === null || !entity.live) return `the birth local DID ${at.localDidId} is not live`;
  const pair = pairGate(fold, relationshipId, entity.created.did, canonicalDidOf(at.peerDid));
  if (pair !== null) return pair;
  if (relationship === undefined || relationship.contactId === null) {
    if (fold.set.of("relationship.contactAssigned").some((event) => event.data.relationshipId === relationshipId)) return "the contact assignments disagree";
  } else if (fold.contacts.get(relationship.contactId)?.deleted === true) return `the contact ${relationship.contactId} is deleted`;
  return null;
}

/** Why an unbound relationship may not be born at this pair now: another relationship's validated histories hold it, or a claim on it awaits its evidence. */
function pairGate(fold: VaultFold, relationshipId: RelationshipId, localDid: Did, peer: Did): string | null {
  const claimants = fold.relationships.claimants(localDid, peer).filter((claimant) => claimant !== relationshipId);
  if (claimants.length > 0) return `the pair ${localDid} / ${peer} is claimed by ${claimants.join(", ")}`;
  const pending = fold.relationships.pendingAt(localDid, peer);
  if (pending.length > 0) return `the pair ${localDid} / ${peer} awaits the evidence of ${pending.flatMap((claim) => claim.eventIds).join(", ")}`;
  return null;
}

/**
 * The birth of an unbound relationship, for a message sent in it with
 * no spelling of its own: the one frozen by the lowest message ID
 * still queued or prepared, so the messages awaiting one resolution
 * share it; else the one its last message froze, terminal messages
 * having settled the pair but not the relationship. Null when no
 * message of it stands.
 */
function birthOf(fold: VaultFold, relationshipId: RelationshipId): Birth | null {
  let last: Birth | null = null;
  for (const outbound of fold.outbound.outbounds.values()) {
    if (outbound.conflict || outbound.intent === null || outbound.intent.relationshipId !== relationshipId || outbound.intent.birth === null) continue;
    if (outbound.outcome === "queued" || outbound.outcome === "prepared") return outbound.intent.birth;
    last = outbound.intent.birth;
  }
  return last;
}

/** The contact to assign the relationship to now: null when it is assigned to `contactId` already; a throw when it is assigned elsewhere or the contact is gone. */
function assignmentOf(fold: VaultFold, relationshipId: RelationshipId, contactId: ContactId): ContactId | null {
  contactOf(fold, contactId);
  const relationship = fold.relationships.relationships.get(relationshipId);
  if (relationship === undefined) return contactId;
  if (relationship.contactId === contactId) return null;
  if (relationship.contactId === null && !fold.set.of("relationship.contactAssigned").some((event) => event.data.relationshipId === relationshipId)) return contactId;
  throw new EntityConflict("relationship", relationshipId, relationship.contactId === null ? "assigned to contacts that disagree" : `assigned to the contact ${relationship.contactId}`);
}

/** A contact that may be interacted with: recorded and not deleted. */
function contactOf(fold: VaultFold, contactId: ContactId): ContactView {
  const view = fold.contacts.get(contactId);
  if (view === undefined) throw new UnknownEntity("contact", contactId);
  if (view.deleted) throw new Unusable("contact", contactId, ["deleted"]);
  return view;
}
