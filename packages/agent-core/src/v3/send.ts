/**
 * Sending: what a message is, decided and committed before any network
 * work. The content becomes its stored document and payload objects;
 * the control headers are frozen with it under one intent hash; the
 * relationship the message belongs to is selected under the writer
 * lock — an existing one, through a contact or an address pair the
 * validated histories know, or a new pair born now at a live local
 * address and the exact peer spelling given; and the objects, the
 * intent and any contact assignment go in as one commit. A fresh
 * private sender may be minted for a new pair in that same commit.
 * Nothing here resolves a DID, reaches a mediator or opens a socket:
 * the resolution, the binding and the package come later, from the
 * intent this leaves behind.
 */

import { v7 as uuidv7 } from "uuid";

import type { JsonObject, VaultRuntime } from "@estoc/event-store/v3";
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

/** What was decided over the fold: the relationship, the birth for one not yet bound, the sender to mint and the assignment to commit. */
export interface Selection {
  relationshipId: RelationshipId;
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

/**
 * The intent of `content` committed with its objects, in the
 * relationship `target` selects. The same message ID again with the
 * same target and content returns what was committed, unless an
 * object of it is missing, in which case the equal intent goes in
 * again with the objects; another intent under the same ID is refused.
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
    headers: content.headers ?? {},
  };
  const hash = intentHash(intent);
  return runtime.locked(async (held) => {
    const fold = await scanVault(held, keys);
    const selection = await selectTarget(fold, keys, target);
    const data: MessageOut = {
      messageId,
      relationshipId: selection.relationshipId,
      birth: selection.birth,
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
      intentHash: hash,
      executionId: null,
      handlerId: null,
      effectKind: null,
      ordinal: null,
      effectKey: null,
    };
    const draft = vaultDraft("message.out", data);
    const existing = fold.outbound.outbounds.get(messageId);
    if (existing !== undefined) {
      if (existing.intent === null || !samePayload(existing.intent, data)) throw new EntityConflict("message", messageId, existing.intent === null ? "intents that disagree" : "another intent");
      if (await objectsHeld(held, stored.roots)) {
        const recorded = fold.set.of("message.out").find((event) => event.data.messageId === messageId) as VaultEvent<"message.out">;
        return { messageId, relationshipId: data.relationshipId, birth: data.birth, intent: recorded, created: null, assigned: null, existed: true };
      }
    }
    const drafts: VaultDraft[] = [];
    if (selection.mint !== null) {
      const { minted, routeId } = selection.mint;
      drafts.push(vaultDraft("did.created", { didId: minted.didId, did: minted.did, longFormDid: minted.longFormDid, boundRouteId: routeId }));
    }
    drafts.push(draft);
    if (selection.assign !== null) drafts.push(vaultDraft("relationship.contactAssigned", { relationshipId: selection.relationshipId, contactId: selection.assign }));
    const objects = [{ cid: stored.bodyCid, source: stored.bytes }, ...stored.payloads.map(({ cid, bytes }) => ({ cid, source: bytes }))];
    const events = (await held.commit(objects, drafts)).map(readVaultEvent);
    const of = <T extends VaultEventType>(type: T): VaultEvent<T> | null => (events.find((event) => event.type === type) as VaultEvent<T> | undefined) ?? null;
    return { messageId, relationshipId: data.relationshipId, birth: data.birth, intent: of("message.out") as VaultEvent<"message.out">, created: of("did.created"), assigned: of("relationship.contactAssigned"), existed: false };
  });
}

/** The relationship `target` names over `fold`, and what committing an intent in it takes; a throw when there is none, more than one, or it may not be written in now. */
export async function selectTarget(fold: VaultFold, keys: Keys, target: Target): Promise<Selection> {
  if (target.peerDid !== undefined) return selectAddress(fold, keys, target.peerDid, target.sender, target.contactId ?? null);
  const view = contactOf(fold, target.contactId);
  const open = view.relationships.map((assigned) => assigned.relationshipId).filter((relationshipId) => sendGate(fold, relationshipId) === null);
  const chosen = view.preferred.length > 0 ? view.preferred : open;
  if (chosen.length === 1) return inRelationship(fold, chosen[0] as RelationshipId, null);
  if (chosen.length > 1) throw new AmbiguousTarget(target.contactId, chosen);
  const seeds = view.peerDidSeeds;
  if (seeds.length !== 1) throw new Unusable("contact", target.contactId, [seeds.length === 0 ? "no relationship to write in and no peer DID added" : `no relationship to write in and ${seeds.length} peer DIDs added`]);
  if (target.sender === undefined) throw new Unusable("contact", target.contactId, ["no relationship to write in: a new pair needs a sender"]);
  return selectAddress(fold, keys, seeds[0]!.did, target.sender, target.contactId);
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
  if (claimants.length > 1) throw new Unusable("address pair", `${localDid} / ${peer}`, [`claimed by ${claimants.join(", ")}`]);
  if (claimants.length === 1) return inRelationship(fold, claimants[0] as RelationshipId, contactId);
  const pending = fold.relationships.pendingAt(localDid, peer);
  if (pending.length > 0) throw new Unusable("address pair", `${localDid} / ${peer}`, pending.map((claim) => `awaits the evidence of ${claim.eventIds.join(", ")}`));
  const relationshipId = relationshipIdOf(localDid, peer);
  if ((fold.relationships.relationships.get(relationshipId)?.bindingEventIds.length ?? 0) > 0) return inRelationship(fold, relationshipId, contactId);
  return born(fold, { localDidId: sender.didId, peerDid: peerDid as Did }, localDid, peer, null, contactId);
}

/** A relationship the fold has: bound, at its current ends; or unbound, at its queued birth. */
function inRelationship(fold: VaultFold, relationshipId: RelationshipId, contactId: ContactId | null): Selection {
  const gate = sendGate(fold, relationshipId);
  if (gate !== null) throw new Unusable("relationship", relationshipId, [gate]);
  const bound = (fold.relationships.relationships.get(relationshipId)?.bindingEventIds.length ?? 0) > 0;
  return { relationshipId, birth: bound ? null : queuedBirth(fold, relationshipId), mint: null, assign: contactId === null ? null : assignmentOf(fold, relationshipId, contactId) };
}

/** A pair no binding holds yet: the relationship the pair derives, at the birth already queued for it or the one selected now. */
function born(fold: VaultFold, selected: Birth, localDid: Did, peer: Did, mint: Selection["mint"], contactId: ContactId | null): Selection {
  const relationshipId = relationshipIdOf(localDid, peer);
  const assign = contactId === null ? null : assignmentOf(fold, relationshipId, contactId);
  if (mint !== null) return { relationshipId, birth: selected, mint, assign };
  const queued = queuedBirth(fold, relationshipId);
  const birth = queued !== null && queued.localDidId === selected.localDidId ? queued : selected;
  const gate = sendGate(fold, relationshipId, birth);
  if (gate !== null) throw new Unusable("relationship", relationshipId, [gate]);
  return { relationshipId, birth, mint: null, assign };
}

/**
 * Why no message may be sent in a relationship now, or null. A bound
 * relationship answers through its current local end; an unbound one
 * through its queued birth, or the birth about to be queued, whose
 * local address must be live, under the same contact rules.
 */
function sendGate(fold: VaultFold, relationshipId: RelationshipId, birth: Birth | null = null): string | null {
  const relationship = fold.relationships.relationships.get(relationshipId);
  if (relationship !== undefined && relationship.bindingEventIds.length > 0) return senderGate(fold, relationshipId);
  if (relationship?.conflict) return "the relationship is in conflict";
  const at = birth ?? queuedBirth(fold, relationshipId);
  if (at === null) return "the relationship has no binding and no queued birth";
  if (fold.routes.dids.get(at.localDidId)?.live !== true) return `the birth local DID ${at.localDidId} is not live`;
  if (relationship === undefined || relationship.contactId === null) {
    if (fold.set.of("relationship.contactAssigned").some((event) => event.data.relationshipId === relationshipId)) return "the contact assignments disagree";
  } else if (fold.contacts.get(relationship.contactId)?.deleted === true) return `the contact ${relationship.contactId} is deleted`;
  return null;
}

/** The birth the outbounds of an unbound relationship froze, the earliest when spellings differ; null while none is queued. */
function queuedBirth(fold: VaultFold, relationshipId: RelationshipId): Birth | null {
  for (const outbound of fold.outbound.outbounds.values()) {
    if (outbound.intent !== null && outbound.intent.relationshipId === relationshipId && outbound.intent.birth !== null && !outbound.conflict) return outbound.intent.birth;
  }
  return null;
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
