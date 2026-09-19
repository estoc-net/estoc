/**
 * Sending decides what a message is, and commits it, before any
 * network work: the content is stored, the control headers are frozen
 * and the channel is fixed — one live local DID of ours, one peer DID
 * in the exact spelling given — in a single commit of the objects and
 * the intent. Resolution, the package and the transport call come
 * later, from the intent left behind, and never move it to another
 * channel. Everything the fold answers is read under the writer lock,
 * in the same commit's view, so no rotation, denial or contact change
 * can slip between the decision and the record. The same rules build
 * the intent of an automatic effect — an ACK, a Ping reply, a rotation
 * notification — under the message ID its tuple derives, for the
 * operation that commits it.
 */

import { v7 as uuidv7 } from "uuid";

import { canonicalText, parseStrict, type CommitObject, type Held, type JsonObject, type VaultRuntime } from "@estoc/event-store/v3";
import {
  automaticIntent,
  canonicalDidOf,
  channelKey,
  channelOf,
  checkHeaders,
  intentHash,
  readVaultEvent,
  sameChannel,
  samePayload,
  scanVault,
  senderGate,
  storeMessage,
  vaultDraft,
  type AdditionalHeaders,
  type AutomaticIntent,
  type Channel,
  type Cid,
  type ContactId,
  type Did,
  type DidId,
  type EpochSeconds,
  type EventReference,
  type Execution,
  type Intent,
  type Keys,
  type LocalDidEntity,
  type MessageId,
  type MessageOut,
  type Outbound,
  type Source,
  type VaultDraft,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault/v3";

import { LiveAction } from "./action.js";
import { AmbiguousTarget, EntityConflict, NoTarget, UnknownEntity, Unusable } from "./errors.js";
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

/**
 * Whom to send to: a channel — one of our DIDs and the peer's, either
 * end in any spelling, the peer's kept as given for the recipient
 * unless `recipientDid` spells it otherwise — or a contact, in the
 * one head its selected channels lead to under its preference. A
 * channel a verified replacement has moved on from takes a send only
 * as an explicit pre-rotation choice, which the ordinary gates still
 * apply to.
 */
export type Target = { channel: Channel; recipientDid?: string; preRotation?: boolean; contactId?: undefined } | { contactId: ContactId; channel?: undefined };

export interface SendOptions {
  /** the message ID, for a send repeated after a crash: a fresh UUIDv7 when left out */
  messageId?: MessageId;
}

export interface Sent {
  messageId: MessageId;
  channel: Channel;
  senderDidId: DidId;
  intent: VaultEvent<"message.out">;
  /** an equal intent under this message ID was there already, its objects held: nothing was written */
  existed: boolean;
  /** the one transport call this send authorizes: `initial` with a new intent, `manual` when the user sent again for one already recorded */
  action: LiveAction;
}

type IntentFields = Omit<MessageOut, "senderDidId" | "recipientDid">;

/**
 * The intent of `content` committed with its objects, in the channel
 * `target` selects, with networking off. A message ID the vault has
 * already is not selected for again: the same content and a target
 * that names the recorded channel return what was committed, going in
 * again only when an object of it is missing; another intent or
 * target under the same ID is refused.
 */
export async function send(runtime: VaultRuntime, keys: Keys, target: Target, content: Content, options: SendOptions = {}): Promise<Sent> {
  const messageId = options.messageId ?? (uuidv7() as MessageId);
  const { fields, objects, roots } = intentOf(messageId, content, [], LOCAL);
  return runtime.locked(async (held) => {
    const fold = await scanVault(held, keys);
    const existing = fold.outbound.outbounds.get(messageId);
    if (existing !== undefined) return { ...(await repeat(held, fold, existing, target, fields, objects, roots)), action: new LiveAction(messageId, "manual") };
    const { sender, channel, recipientDid } = select(fold, target);
    const data: MessageOut = { ...fields, senderDidId: sender.didId, recipientDid };
    const [event] = (await held.commit(objects, [vaultDraft("message.out", data)])).map(readVaultEvent);
    return { messageId, channel, senderDidId: sender.didId, intent: event as VaultEvent<"message.out">, existed: false, action: new LiveAction(messageId, "initial") };
  });
}

async function repeat(held: Held, fold: VaultFold, existing: Outbound, target: Target, fields: IntentFields, objects: CommitObject[], roots: readonly Cid[]): Promise<Omit<Sent, "action">> {
  const { messageId } = fields;
  if (existing.intent.status === "conflict" || existing.channel === null) throw new EntityConflict("message", messageId, existing.intent.status === "conflict" ? existing.intent.because : "an intent whose sender is not here");
  const { data } = existing.intent;
  if (!samePayload({ ...fields, senderDidId: data.senderDidId, recipientDid: data.recipientDid }, data)) throw new EntityConflict("message", messageId, "another intent");
  if (!targetAgrees(fold, target, existing.channel, data.recipientDid)) throw new EntityConflict("message", messageId, "another target");
  const sent = { messageId, channel: existing.channel, senderDidId: data.senderDidId };
  if (await objectsHeld(held, roots)) return { ...sent, intent: existing.intents[0] as VaultEvent<"message.out">, existed: true };
  const [event] = (await held.commit(objects, [vaultDraft("message.out", data)])).map(readVaultEvent);
  return { ...sent, intent: event as VaultEvent<"message.out">, existed: false };
}

/** Does `target` name the channel a recorded intent is fixed to: the same pair, under the recipient spelling when one is given; or a contact whose view holds that channel, selected or derived. */
function targetAgrees(fold: VaultFold, target: Target, channel: Channel, recipientDid: Did): boolean {
  if (target.contactId !== undefined) return fold.views.contact(target.contactId).channels.some((view) => sameChannel(view.channel, channel));
  return sameChannel(canonicalChannel(target.channel), channel) && (target.recipientDid === undefined || target.recipientDid === recipientDid);
}

function canonicalChannel(channel: Channel): Channel {
  return channelOf(canonicalDidOf(channel.localDid), canonicalDidOf(channel.peerDid));
}

interface Selected {
  sender: LocalDidEntity;
  channel: Channel;
  recipientDid: Did;
}

function select(fold: VaultFold, target: Target): Selected {
  if (target.contactId !== undefined) return selectContact(fold, target.contactId);
  const channel = canonicalChannel(target.channel);
  const recipientDid = (target.recipientDid ?? target.channel.peerDid) as Did;
  if (canonicalDidOf(recipientDid) !== channel.peerDid) throw new Unusable("recipient", recipientDid, [`another DID than the channel's peer ${channel.peerDid}`]);
  return inChannel(fold, channel, recipientDid, target.preRotation === true);
}

/**
 * The one head a contact's selected channels lead to under its
 * preference; several eligible heads, or a preference that matches
 * none, leave the choice to the caller, who sends to a channel.
 */
function selectContact(fold: VaultFold, contactId: ContactId): Selected {
  const contact = fold.contacts.contacts.get(contactId);
  if (contact === undefined) throw new UnknownEntity("contact", contactId);
  if (contact.deleted) throw new Unusable("contact", contactId, ["deleted"]);
  const view = fold.views.contact(contactId);
  if (view.defaultWriteTo !== null) return inChannel(fold, view.defaultWriteTo, view.defaultWriteTo.peerDid, false);
  if (view.writeTo.length === 0) throw new NoTarget(contactId, contact.channels.length === 0 ? "it selects no channel" : "no head of its channels takes a send now");
  throw new AmbiguousTarget(contactId, view.writeTo, view.preference !== null && view.preference.matches.length === 0);
}

function inChannel(fold: VaultFold, channel: Channel, recipientDid: Did, preRotation: boolean): Selected {
  const gate = senderGate(fold, channel);
  if (gate.status === "closed") throw new Unusable("channel", channelKey(channel), [gate.because]);
  const head = fold.continuity.head(channel);
  if (!preRotation && (head === null || !sameChannel(head, channel))) {
    throw new Unusable("channel", channelKey(channel), [head === null ? "replaced, and no successor is unique" : `replaced by ${channelKey(head)}`, "an explicit pre-rotation send may still use it"]);
  }
  return { sender: senderOf(fold, channel), channel, recipientDid };
}

function senderOf(fold: VaultFold, channel: Channel): LocalDidEntity {
  const didId = fold.routes.entityOfDid(channel.localDid);
  const entity = didId === null ? undefined : fold.routes.dids.get(didId);
  if (entity === undefined) throw new UnknownEntity("DID", channel.localDid);
  if (!entity.live) throw new Unusable("DID", entity.didId, entity.retired !== null ? [`retired: ${entity.retired}`, ...entity.faults] : entity.faults);
  return entity;
}

type EffectFields = Pick<MessageOut, "executionId" | "effectType" | "effectKey" | "sourceEventId" | "rotationEventId">;

const LOCAL: EffectFields = { executionId: null, effectType: null, effectKey: null, sourceEventId: null, rotationEventId: null };

function intentOf(messageId: MessageId, content: Content, ack: readonly string[], effect: EffectFields): { fields: IntentFields; objects: CommitObject[]; roots: readonly Cid[] } {
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
    ack: [...ack],
    headers: checkHeaders(parseStrict(canonicalText(content.headers ?? {}))),
  };
  const fields: IntentFields = {
    messageId,
    msgType: intent.type,
    thid: intent.thid,
    pthid: intent.pthid,
    createdTime: intent.createdTime,
    expiresTime: intent.expiresTime,
    pleaseAck: intent.pleaseAck,
    ack: intent.ack,
    headers: intent.headers,
    bodyCid: stored.bodyCid,
    attachmentCids: stored.attachmentCids,
    intentHash: intentHash(intent),
    ...effect,
  };
  const objects: CommitObject[] = [{ cid: stored.bodyCid, source: stored.bytes }, ...stored.payloads.map(({ cid, bytes }) => ({ cid, source: bytes }))];
  return { fields, objects, roots: stored.roots };
}

/**
 * An automatic effect: the operation's output to one established
 * input, in the channel the operation's selection rule chose. The
 * source is the complete witness the output's fields are read from;
 * the rotation, when the output announces one, is its decision.
 */
export interface Effect {
  execution: Execution;
  source: Source;
  effectType: string;
  channel: Channel;
  rotationEventId?: EventReference<"did.rotationSelected"> | null;
}

/** The content of an automatic effect: as a send's, with the ACK targets the response algorithm froze. */
export interface EffectContent extends Content {
  ack?: readonly string[];
}

/** The tuple and its message ID, with the intent already recorded under it, or else the draft and the objects a new one commits. */
export type AutomaticDraft = Omit<AutomaticIntent, "existing"> & ({ existing: Outbound; draft: null; objects: null } | { existing: null; draft: VaultDraft<"message.out">; objects: CommitObject[] });

/**
 * The intent of an automatic effect, drafted over the fold under the
 * lock: the tuple and its message ID first, and the intent already
 * recorded under that ID as it is, whatever the channel or the content
 * would be now; only for a new one the fields frozen under the ID, the
 * recipient being the source's canonical peer. The operation commits
 * the draft with the objects.
 */
export function automaticDraft(fold: VaultFold, effect: Effect, content: EffectContent): AutomaticDraft {
  const tuple = automaticIntent(fold, effect.execution, effect.effectType);
  if (tuple.existing !== null) return { ...tuple, existing: tuple.existing, draft: null, objects: null };
  const sender = senderOf(fold, effect.channel);
  const { fields, objects } = intentOf(tuple.messageId, content, content.ack ?? [], {
    executionId: tuple.executionId,
    effectType: tuple.effectType,
    effectKey: tuple.effectKey,
    sourceEventId: effect.source.event.eventId as EventReference<"message.in">,
    rotationEventId: effect.rotationEventId ?? null,
  });
  const data: MessageOut = { ...fields, senderDidId: sender.didId, recipientDid: effect.channel.peerDid };
  return { ...tuple, existing: null, draft: vaultDraft("message.out", data), objects };
}
