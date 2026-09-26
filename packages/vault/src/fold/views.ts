/**
 * What a person browses: a channel with its inputs, outputs and the
 * errors peers reported, and a contact as the channels it selected
 * together with the history verified continuity derives from them.
 * A view has no authority of its own — every message keeps the
 * channel it was observed or sent in, a selected channel stays told
 * apart from a derived one, and the heads a new send may go to are
 * read from the continuity and the current send policy, never from a
 * name, a shared DID or a merge. Nothing here appends an event.
 */

import { channelKey, compareChannels, sameChannel } from "../ids.js";
import type { Channel, ContactId, Did, DidId, MessageId } from "../types.js";
import { compareReceiptKeys } from "./channels.js";
import type { Contact, ContactFold } from "./contacts.js";
import type { Continuity } from "./continuity.js";
import type { Execution, InboundFold } from "./inbound.js";
import type { Outbound, OutboundFold } from "./outbound.js";
import type { RouteFold } from "./routes.js";

export type ViewInputs = {
  readonly routes: RouteFold;
  readonly continuity: Continuity;
  readonly inbound: InboundFold;
  readonly outbound: OutboundFold;
  readonly contacts: ContactFold;
};

/**
 * Why a channel takes no new work now — no user send, no automatic
 * reply, no package and no transport call, first or retried: its
 * local DID cannot send, the pair is denied, its continuity is in
 * conflict, the peer has replaced its DID in that context, or the
 * local DID has been replaced here by a successor, or by a decision
 * still waiting for its evidence. The one gate every path to the wire
 * goes through, whatever the caller: a message a replacement caught
 * queued or prepared keeps its intent, its package and whatever call
 * was made before, and is carried by nothing after.
 */
export type SendGate = { status: "open" } | { status: "closed"; because: string };

export function senderGate(fold: Pick<ViewInputs, "routes" | "continuity">, channel: Channel): SendGate {
  const didId = fold.routes.entityOfDid(channel.localDid);
  const entity = didId === null ? undefined : fold.routes.dids.get(didId);
  if (entity === undefined) return { status: "closed", because: "the local DID is not one of ours" };
  if (!entity.live) return { status: "closed", because: `the local DID cannot send: ${entity.faults[0] ?? `retired: ${entity.retired}`}` };
  const denied = channelPolicy(fold, channel);
  if (denied !== null) return { status: "closed", because: denied };
  const head = fold.continuity.head(channel);
  if (head === null || fold.continuity.decisionsIn(channel).some((decision) => decision.status.status === "pending")) return { status: "closed", because: "a rotation of the local DID here waits for its evidence" };
  if (!sameChannel(head, channel)) return { status: "closed", because: `the local DID is replaced here by ${head.localDid}` };
  return { status: "open" };
}

/** What current policy holds against the pair itself, whatever its local DID's state: denied, in conflict, or its peer replaced; null when nothing. */
export function channelPolicy(fold: Pick<ViewInputs, "continuity">, channel: Channel): string | null {
  if (fold.continuity.blocked(channel).length > 0) return "the channel is denied";
  if (fold.continuity.conflicted(channel)) return "the channel's continuity is in conflict";
  if (fold.continuity.superseded(channel)) return "the peer has replaced its DID";
  return null;
}

/**
 * A problem report a peer sent in a channel, beside the outbound its
 * thread names when the carrier may answer that outbound; with no such
 * outbound it is a report of nothing this vault sent. Whether its body
 * is still here is the execution's erasure and the object store's.
 */
export interface RemoteError {
  readonly execution: Execution;
  readonly outbound: Outbound | null;
}

export interface ChannelView {
  readonly channel: Channel;
  /** the unique usable channel forward replacements lead to, the channel itself when no fact mentions it; null while a replacement waits, conflicts or is not unique */
  readonly head: Channel | null;
  readonly superseded: boolean;
  readonly blocked: boolean;
  readonly conflicted: boolean;
  readonly send: SendGate;
  /** the established and pending inputs in this channel, in first-receipt order, the pending ones last */
  readonly inbound: readonly Execution[];
  /** the outbounds fixed to this channel, in message order */
  readonly outbound: readonly Outbound[];
  readonly errors: readonly RemoteError[];
}

/** A channel in a contact's view: selected by the contact, or reached from a selected one over usable continuity. */
export interface ContactChannel extends ChannelView {
  readonly selected: boolean;
}

/** Where a saved local-DID preference points among the heads: the heads at that DID or at a verified local successor of it on the way there. */
export interface Preference {
  readonly didId: DidId;
  readonly matches: readonly Channel[];
}

export interface ContactView {
  /** the contacts named; one no creation resolves has no origin, and its selection still shows, since membership grants nothing a send gate does not check */
  readonly contacts: readonly Contact[];
  /** the selected channels first, then the derived ones, each in canonical order */
  readonly channels: readonly ContactChannel[];
  /** the distinct heads of the selected channels that take a new user send now, in canonical order */
  readonly writeTo: readonly Channel[];
  readonly preference: Preference | null;
  /** the one head a new send goes to without a choice: the only one, or the only one the preference leaves */
  readonly defaultWriteTo: Channel | null;
}

export interface Views {
  channel(channel: Channel): ChannelView;
  /** one view over several contacts shows each channel, and so each message, once; their preferences must agree or none applies */
  contact(...contactIds: readonly ContactId[]): ContactView;
}

export function foldViews(fold: ViewInputs): Views {
  const inbound = groupByChannel(fold.inbound.executions.values(), (execution) => execution.channel);
  const outbound = groupByChannel([...fold.outbound.outbounds.values()].filter((o) => o.channel !== null), (o) => o.channel!);
  const views = new Map<string, ChannelView>();
  const channel = (channel: Channel): ChannelView => {
    const key = channelKey(channel);
    let view = views.get(key);
    if (view === undefined) views.set(key, (view = channelView(fold, channel, inbound.get(key) ?? [], outbound.get(key) ?? [])));
    return view;
  };
  return { channel, contact: (...contactIds) => contactView(fold, contactIds, channel) };
}

function groupByChannel<T>(items: Iterable<T>, channelOf: (item: T) => Channel): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = channelKey(channelOf(item));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

function channelView(fold: ViewInputs, channel: Channel, executions: readonly Execution[], outbounds: readonly Outbound[]): ChannelView {
  const { continuity } = fold;
  const inbound = [...executions].sort(byFirstReceipt);
  const errors: RemoteError[] = [];
  for (const execution of inbound) {
    if (execution.kind !== "error" || execution.firstWitness === null) continue;
    errors.push({ execution, outbound: fold.outbound.inReplyTo(execution.firstWitness.source.event.cid) });
  }
  return {
    channel,
    head: continuity.head(channel),
    superseded: continuity.superseded(channel),
    blocked: continuity.blocked(channel).length > 0,
    conflicted: continuity.conflicted(channel),
    send: senderGate(fold, channel),
    inbound,
    outbound: [...outbounds].sort((a, b) => cmp(a.messageId, b.messageId)),
    errors,
  };
}

/** The complete inputs in first-receipt order, then the rest in message order: a pending input has no receipt an operation would freeze. */
function byFirstReceipt(a: Execution, b: Execution): number {
  if (a.firstReceiptKey !== null && b.firstReceiptKey !== null) return compareReceiptKeys(a.firstReceiptKey, b.firstReceiptKey) || cmp(a.messageId, b.messageId);
  if (a.firstReceiptKey !== null) return -1;
  if (b.firstReceiptKey !== null) return 1;
  return cmp(a.messageId, b.messageId);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * From the selected channels, every channel a usable replacement
 * connects, forward or back, is related history; forward alone, the
 * local DIDs on the way to each head are where a preference may point.
 * A deleted contact selects nothing. Preferences of several contacts
 * apply only when they name one DID.
 */
function contactView(fold: ViewInputs, contactIds: readonly ContactId[], view: (channel: Channel) => ChannelView): ContactView {
  const contacts = [...new Set(contactIds)].sort().map((contactId) => fold.contacts.contacts.get(contactId) ?? absent(contactId));
  const selected = new Map<string, Channel>();
  for (const contact of contacts) if (!contact.deleted) for (const channel of contact.channels) selected.set(channelKey(channel), channel);

  const verified = new Map<string, { forward: Channel[]; back: Channel[] }>();
  const edges = (channel: Channel) => {
    const key = channelKey(channel);
    let entry = verified.get(key);
    if (entry === undefined) verified.set(key, (entry = { forward: [], back: [] }));
    return entry;
  };
  const seenLinks = new Set<string>();
  for (const channel of selected.values()) {
    for (const link of fold.continuity.model.history(channel).links) {
      const from = link.from as Channel;
      const to = link.to as Channel;
      const key = `${channelKey(from)} ${channelKey(to)}`;
      if (!link.usable || seenLinks.has(key)) continue;
      seenLinks.add(key);
      edges(from).forward.push(to);
      edges(to).back.push(from);
    }
  }

  const related = new Map<string, Channel>();
  const heads = new Map<string, { head: Channel; localDids: Set<Did> }>();
  for (const channel of selected.values()) {
    const seen = new Map<string, Channel>();
    const queue = [channel];
    while (queue.length > 0) {
      const next = queue.pop()!;
      const key = channelKey(next);
      if (seen.has(key)) continue;
      seen.set(key, next);
      const entry = verified.get(key);
      if (entry !== undefined) queue.push(...entry.forward, ...entry.back);
    }
    for (const [key, reached] of seen) if (!selected.has(key)) related.set(key, reached);

    const head = fold.continuity.head(channel);
    if (head === null) continue;
    const headKey = channelKey(head);
    let entry = heads.get(headKey);
    if (entry === undefined) heads.set(headKey, (entry = { head, localDids: new Set() }));
    const forward = [channel];
    const walked = new Set<string>();
    while (forward.length > 0) {
      const next = forward.pop()!;
      const key = channelKey(next);
      if (walked.has(key)) continue;
      walked.add(key);
      entry.localDids.add(next.localDid);
      forward.push(...(verified.get(key)?.forward ?? []));
    }
  }

  const writeTo = [...heads.values()]
    .filter(({ head }) => senderGate(fold, head).status === "open")
    .map(({ head }) => head)
    .sort(compareChannels);
  const preference = preferenceOf(fold, contacts, heads, writeTo);
  const candidates = preference === null ? writeTo : preference.matches;
  return {
    contacts,
    channels: [
      ...[...selected.values()].sort(compareChannels).map((channel) => ({ ...view(channel), selected: true })),
      ...[...related.values()].sort(compareChannels).map((channel) => ({ ...view(channel), selected: false })),
    ],
    writeTo,
    preference,
    defaultWriteTo: candidates.length === 1 ? candidates[0]! : null,
  };
}

const absent = (contactId: ContactId): Contact => ({ contactId, origin: null, deleted: false, petname: null, flags: new Map(), useDid: null, channels: [], mergedWith: [] });

function preferenceOf(fold: ViewInputs, contacts: readonly Contact[], heads: ReadonlyMap<string, { head: Channel; localDids: ReadonlySet<Did> }>, writeTo: readonly Channel[]): Preference | null {
  const preferred = new Set<DidId>();
  for (const contact of contacts) if (!contact.deleted && contact.useDid !== null) preferred.add(contact.useDid.didId);
  if (preferred.size !== 1) return null;
  const didId = [...preferred][0]!;
  const did = fold.routes.dids.get(didId)?.created?.did ?? null;
  const matches = did === null ? [] : writeTo.filter((head) => heads.get(channelKey(head))!.localDids.has(did));
  return { didId, matches };
}

/** The message IDs a view shows, for an erasure over a contact or a channel. */
export function messageIdsOf(view: ChannelView): MessageId[] {
  return [...view.inbound.map((execution) => execution.messageId), ...view.outbound.map((outbound) => outbound.messageId)];
}
