/**
 * What the runtime does over the whole fold: the retention it hands
 * the event store for collection, export and import; the erasure of a
 * message and the closure that keeps an erasure complete when a later
 * event names roots the erase did not; the invitation consumptions the
 * retained receipts are owed; the work an open finds unfinished, which
 * it lists and never dispatches; the decisions a send, a reply and a
 * rotation take before they commit; the denial of channels and the
 * deletion of a contact. Each decision is a pure function of the
 * fold, exported as such, and each procedure takes the writer lock,
 * scans, decides, commits what it decided in one batch and, when the
 * batch may release a root, collects.
 */

import { heldRootsOf, type Collected, type Event, type HeldRoots, type RetainedRoots, type VaultRuntime } from "@estoc/event-store/v3";

import type { Carrier, Decision, Source } from "./fold/channels.js";
import { erased } from "./fold/held.js";
import type { Execution } from "./fold/inbound.js";
import { PING_RESPONSE_EFFECT, PING_TYPE, PURE_ACK_EFFECT, type Notification, type Outbound } from "./fold/outbound.js";
import { scanVault, type ScanOptions, type VaultFold } from "./fold/vault.js";
import { channelPolicy, messageIdsOf, senderGate } from "./fold/views.js";
import type { Keys } from "./identity.js";
import { automaticMessageId, channelKey, channelOf, compareChannels, effectKey, sameChannel } from "./ids.js";
import { requestsAck } from "./projection.js";
import { vaultDraft, type VaultDraft } from "./schema.js";
import type { Channel, Cid, ContactId, Did, EffectKey, EventId, EventReference, ExecutionId, MessageId } from "./types.js";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- retention -----------------------------------------------------------

/** The vault's retention as the event store asks for it: folded from the vault it is handed, with the seed's checks when the keys are here. */
export function vaultRetention(keys: Keys | null, options: ScanOptions = {}): RetainedRoots {
  return async (vault) => (await scanVault(vault, keys, options)).retained;
}

/** The roots the vault holds, as a keep set for collection, an export or a validation. */
export function vaultHeldRoots(keys: Keys | null, options: ScanOptions = {}): HeldRoots {
  return heldRootsOf(vaultRetention(keys, options));
}

/** One collection pass: the keep set folded under the lock. */
export function collectGarbage(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Collected> {
  return runtime.collect(vaultHeldRoots(keys, options));
}

// ---- erasure -------------------------------------------------------------

/** Every root the events of each message name, by message ID: what its erasure must release. */
function rootsByMessage(fold: VaultFold): Map<MessageId, Set<Cid>> {
  const roots = new Map<MessageId, Set<Cid>>();
  for (const type of ["message.out", "message.in", "message.prepared"] as const) {
    for (const event of fold.set.of(type)) {
      const named = roots.get(event.data.messageId);
      if (named === undefined) roots.set(event.data.messageId, new Set(event.roots));
      else for (const root of event.roots) named.add(root);
    }
  }
  return roots;
}

function unreleased(fold: VaultFold, roots: Map<MessageId, Set<Cid>>, messageId: MessageId): Cid[] {
  return [...(roots.get(messageId) ?? [])].filter((root) => !erased(fold.erasures, messageId, root)).sort();
}

/** One erase per message that still names a root no erasure of it released, in message order. */
export function eraseDrafts(fold: VaultFold, messageIds: Iterable<MessageId>, because: string): VaultDraft<"message.erased">[] {
  const roots = rootsByMessage(fold);
  const drafts: VaultDraft<"message.erased">[] = [];
  for (const messageId of [...new Set(messageIds)].sort()) {
    const dropCids = unreleased(fold, roots, messageId);
    if (dropCids.length > 0) drafts.push(vaultDraft("message.erased", { messageId, dropCids, because }));
  }
  return drafts;
}

/**
 * The equivalent erase each erased message is owed for roots learned
 * since its erasure — a later observation's, a package prepared after
 * — under the reason of the first erasure in canonical order, one
 * erase per message ID.
 */
export function erasureClosure(fold: VaultFold): VaultDraft<"message.erased">[] {
  const because = new Map<MessageId, string>();
  for (const event of fold.set.of("message.erased")) if (!because.has(event.data.messageId)) because.set(event.data.messageId, event.data.because);
  const roots = rootsByMessage(fold);
  const drafts: VaultDraft<"message.erased">[] = [];
  for (const [messageId, reason] of [...because].sort(([a], [b]) => cmp(a, b))) {
    const dropCids = unreleased(fold, roots, messageId);
    if (dropCids.length > 0) drafts.push(vaultDraft("message.erased", { messageId, dropCids, because: reason }));
  }
  return drafts;
}

export interface Committed {
  readonly events: Event[];
  readonly collected: Collected;
}

/** Scan under the lock, commit what the decision drafts in one batch; nothing drafted commits nothing. */
function commitDecided(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions, drafts: (fold: VaultFold) => VaultDraft[]): Promise<Event[]> {
  return runtime.locked(async (held) => {
    const batch = drafts(await scanVault(held, keys, options));
    return batch.length === 0 ? [] : held.commit([], batch);
  });
}

/** As `commitDecided`, then one collection pass under the same lock: for a batch that may release a root. */
function decide(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions, drafts: (fold: VaultFold) => VaultDraft[]): Promise<Committed> {
  return runtime.locked(async (held) => {
    const batch = drafts(await scanVault(held, keys, options));
    const events = batch.length === 0 ? [] : await held.commit([], batch);
    return { events, collected: await held.collect(vaultHeldRoots(keys, options)) };
  });
}

/** Erase a message: every root its events and its packages still retain, in one commit, then collect. Nothing left to release commits nothing. */
export function eraseMessage(runtime: VaultRuntime, keys: Keys | null, messageId: MessageId, because = "user", options: ScanOptions = {}): Promise<Committed> {
  return decide(runtime, keys, options, (fold) => eraseDrafts(fold, [messageId], because));
}

/** Append the equivalent erases later events made erased messages owed, then collect. */
export function closeErasures(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Committed> {
  return decide(runtime, keys, options, erasureClosure);
}

// ---- invitation consumption --------------------------------------------

/**
 * The consumption each available one-use invitation is owed: the
 * first candidate receipt, in first-receipt order, that may be
 * recorded now. A refused or invalid candidate is passed over; one
 * that waits for evidence, or is caught in a receipt-integrity
 * conflict, stops the walk and nothing behind it is taken, which the
 * invitation's status already says. An invitation with a consumer, a
 * record still pending or a conflict is owed nothing.
 */
export function consumptionDrafts(fold: VaultFold): VaultDraft<"invitation.consumed">[] {
  const drafts: VaultDraft<"invitation.consumed">[] = [];
  for (const [disclosureEventId, invitation] of fold.invitations.invitations) {
    if (invitation.status.status !== "available") continue;
    for (const { source, eligibility } of invitation.candidates) {
      if (eligibility.status === "refused" || eligibility.status === "invalid") continue;
      if (eligibility.status === "eligible") drafts.push(vaultDraft("invitation.consumed", { disclosureEventId: disclosureEventId as EventReference<"did.disclosed">, sourceEventId: source.event.eventId as EventReference<"message.in"> }));
      break;
    }
  }
  return drafts;
}

/** Record the consumptions the retained receipts are owed, in one commit under the lock: what an open and every receipt run, dispatching nothing. */
export function consumeInvitations(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Event[]> {
  return commitDecided(runtime, keys, options, consumptionDrafts);
}

// ---- automatic effects ---------------------------------------------------

/** An operation's tuple over an input, the message ID it names and the intent already recorded under it, if any. */
export interface AutomaticIntent {
  readonly executionId: ExecutionId;
  readonly effectType: string;
  readonly effectKey: EffectKey;
  readonly messageId: MessageId;
  readonly existing: Outbound | null;
}

export function automaticIntent(fold: VaultFold, execution: Execution, effectType: string): AutomaticIntent {
  const key = effectKey(execution.id, effectType);
  const messageId = automaticMessageId(key);
  return { executionId: execution.id, effectType, effectKey: key, messageId, existing: fold.outbound.outbounds.get(messageId) ?? null };
}

/**
 * Where a built-in reply to an input goes: the carrier's own channel
 * while its local DID may still send there, otherwise the unique
 * verified local-only successor head that keeps the carrier's peer,
 * when that may send. A denied channel, one in conflict, or one whose
 * peer has replaced its DID takes no reply and hands it to no
 * successor; an input that is not established, or whose intents
 * disagree, earns none.
 */
export type ResponseChannel = { status: "selected"; channel: Channel } | { status: "none"; because: string };

export function responseChannel(fold: VaultFold, execution: Execution): ResponseChannel {
  const none = (because: string): ResponseChannel => ({ status: "none", because });
  if (execution.status.status !== "complete") return none(`the input is not established: ${execution.status.because}`);
  const denied = channelPolicy(fold, execution.channel, { automatic: true });
  if (denied !== null) return none(denied);
  const own = senderGate(fold, execution.channel, { automatic: true });
  if (own.status === "open") return { status: "selected", channel: execution.channel };
  const head = fold.continuity.head(execution.channel);
  if (head === null || sameChannel(head, execution.channel) || head.peerDid !== execution.channel.peerDid) return none(`${own.because}, and no verified local successor keeping the peer is unique`);
  const successor = senderGate(fold, head, { automatic: true });
  return successor.status === "open" ? { status: "selected", channel: head } : none(`${own.because}, and its successor cannot reply: ${successor.because}`);
}

// ---- unfinished work -----------------------------------------------------

/** A reply an established input is owed and no intent records yet, with the channel a manual completion would fix it to. */
export interface MissingResponse {
  readonly execution: Execution;
  readonly effectType: string;
  readonly channel: Channel;
  /** the complete witness whose fields the reply is built from */
  readonly source: Source;
}

/** A verified rotation decision with no notification intent yet, while its source, when it has one, still permits creating it. */
export interface MissingNotification {
  readonly decision: Decision;
  /** from the successor to the decision's peer */
  readonly channel: Channel;
  readonly source: Source | null;
}

export interface NotificationConflict {
  readonly decision: Decision;
  readonly notification: Extract<Notification, { status: "conflict" }>;
}

/**
 * What an open lists for manual action, and dispatches nothing of:
 * the outbounds not yet submitted or terminated, each with the work
 * it still needs; the replies established inputs are owed; the
 * notifications verified decisions are owed; the decisions whose
 * notification intents disagree, listed as a diagnostic, since no
 * retry may select among them; the proofs that wait for issuer
 * material a repair or an import may bring; and the invitation
 * consumptions the runtime records on its own.
 */
export interface PendingWork {
  readonly outbounds: readonly Outbound[];
  readonly responses: readonly MissingResponse[];
  readonly notifications: readonly MissingNotification[];
  readonly notificationConflicts: readonly NotificationConflict[];
  readonly proofs: readonly Carrier[];
  readonly consumptions: readonly VaultDraft<"invitation.consumed">[];
}

export function unfinishedWork(fold: VaultFold): PendingWork {
  const { notifications, conflicts } = missingNotifications(fold);
  return {
    outbounds: [...fold.outbound.outbounds.values()].filter((o) => (o.outcome.status === "queued" || o.outcome.status === "prepared") && !o.erased).sort((a, b) => cmp(a.messageId, b.messageId)),
    responses: missingResponses(fold),
    notifications,
    notificationConflicts: conflicts,
    proofs: [...fold.channels.carriers.values()].filter((carrier) => carrier.proof.status === "pending-proof"),
    consumptions: consumptionDrafts(fold),
  };
}

/**
 * A pure ACK is owed by every established input that asks for its own
 * acknowledgment and whose request names a target, whatever the
 * input's kind, an erased body included: the request is in the
 * headers. A Ping reply is owed by an established, unerased Ping;
 * whether it asked for a response, and whether it has expired, is in
 * its body and its timing, which the completion reads.
 */
function missingResponses(fold: VaultFold): MissingResponse[] {
  const missing: MissingResponse[] = [];
  const executions = [...fold.inbound.executions.values()].sort((a, b) => cmp(a.messageId, b.messageId));
  for (const execution of executions) {
    if (execution.status.status !== "complete") continue;
    const source = execution.members.find((member) => member.witness.status === "complete")!.source;
    const { data } = source.event;
    const owed: string[] = [];
    if (requestsAck(data.wireMessageId, data.pleaseAck) && fold.outbound.ackTargets(source.event.eventId).length > 0) owed.push(PURE_ACK_EFFECT);
    if (data.msgType === PING_TYPE && !execution.erased) owed.push(PING_RESPONSE_EFFECT);
    if (owed.length === 0) continue;
    const channel = responseChannel(fold, execution);
    if (channel.status === "none") continue;
    for (const effectType of owed) {
      if (automaticIntent(fold, execution, effectType).existing !== null) continue;
      missing.push({ execution, effectType, channel: channel.channel, source });
    }
  }
  return missing;
}

/**
 * A decision is owed a notification once continuity has verified it
 * and no intent names it. With a source, the source must still be a
 * complete witness of an established input, and its channel must not
 * be denied, in conflict, or left by the peer; the successor must be
 * able to send to that peer. A source-free decision is held only to
 * the successor's channel.
 */
function missingNotifications(fold: VaultFold): { notifications: MissingNotification[]; conflicts: NotificationConflict[] } {
  const notifications: MissingNotification[] = [];
  const conflicts: NotificationConflict[] = [];
  for (const decision of fold.channels.decisions.values()) {
    const notification = fold.outbound.notificationFor(decision.event.eventId);
    if (notification.status === "conflict") conflicts.push({ decision, notification });
    if (notification.status !== "none" || decision.channel === null) continue;
    if (fold.continuity.status(decision.event.eventId).status !== "verified") continue;
    const successor = fold.routes.dids.get(decision.event.data.toDidId)?.created?.did;
    if (successor === undefined) continue;
    const channel = channelOf(successor, decision.channel.peerDid);
    if (senderGate(fold, channel).status === "closed") continue;
    let source: Source | null = null;
    if (decision.event.data.sourceEventId !== null) {
      source = fold.channels.sources.get(decision.event.data.sourceEventId as EventId) ?? null;
      if (source === null || fold.continuity.witness(source.event.eventId).status !== "complete") continue;
      if (fold.inbound.ofSource(source.event.eventId)?.status.status !== "complete") continue;
      if (channelPolicy(fold, decision.channel, { automatic: true }) !== null) continue;
    }
    notifications.push({ decision, channel, source });
  }
  return { notifications, conflicts };
}

// ---- rotation ------------------------------------------------------------

/**
 * The decision a rotation away from a pair reuses: the one already
 * recorded from that local DID anywhere in its verified peer-only
 * context. Several that pass, or one the evidence contradicts, leave
 * no room for another; one still waiting for evidence defers the
 * rotation; one refused for good is ignored, as it never enters the
 * graph.
 */
export type ExistingDecision = { status: "none" } | { status: "reuse"; decision: Decision } | { status: "defer"; decision: Decision; because: string } | { status: "conflict"; decisions: readonly Decision[]; because: string };

export function decisionFor(fold: VaultFold, localDid: Did, peerDid: Did): ExistingDecision {
  const decisions = fold.continuity.decisionsIn(channelOf(localDid, peerDid)).filter(({ status }) => status.status !== "invalid");
  const conflict = (because: string): ExistingDecision => ({ status: "conflict", decisions, because });
  for (const decision of decisions) {
    if (decision.status.status === "conflict") return conflict(decision.status.because);
    const continuity = fold.continuity.status(decision.event.eventId);
    if (continuity.status === "conflict") return conflict(continuity.because);
  }
  for (const decision of decisions) if (decision.status.status === "pending") return { status: "defer", decision, because: decision.status.because };
  if (decisions.length > 1) return conflict("several decisions rotate away from the local DID in this context");
  return decisions.length === 1 ? { status: "reuse", decision: decisions[0]! } : { status: "none" };
}

// ---- denial and deletion -------------------------------------------------

/** One denial per pair not already denied to at least that extent, in canonical order. */
export function blockDrafts(fold: VaultFold, channels: Iterable<Channel>, includeSuccessors: boolean): VaultDraft<"channel.blocked">[] {
  const distinct = new Map<string, Channel>();
  for (const channel of channels) distinct.set(channelKey(channel), channel);
  const drafts: VaultDraft<"channel.blocked">[] = [];
  for (const channel of [...distinct.values()].sort(compareChannels)) {
    const exact = fold.continuity.blocked(channel).filter((denial) => sameChannel(channelOf(denial.data.localDid, denial.data.peerDid), channel));
    if (exact.some((denial) => denial.data.includeSuccessors || !includeSuccessors)) continue;
    drafts.push(vaultDraft("channel.blocked", { localDid: channel.localDid, peerDid: channel.peerDid, includeSuccessors }));
  }
  return drafts;
}

/** Deny channels for good, with or without their successors. */
export function blockChannels(runtime: VaultRuntime, keys: Keys | null, channels: readonly Channel[], includeSuccessors: boolean, options: ScanOptions = {}): Promise<Event[]> {
  return commitDecided(runtime, keys, options, (fold) => blockDrafts(fold, channels, includeSuccessors));
}

export type DeleteContactOptions = {
  /** deny the contact's selected channels as well, with or without their successors */
  block?: { includeSuccessors: boolean };
  /** erase every message in the selected channels as well, under this reason */
  erase?: string;
};

/**
 * The tombstone, unless one is already there, and what the product
 * chose to do with the concrete selected channels alongside: deny
 * them, erase their messages. Neither reaches the derived history,
 * and a later selection changes neither.
 */
export function deleteContactDrafts(fold: VaultFold, contactId: ContactId, options: DeleteContactOptions = {}): VaultDraft[] {
  const contact = fold.contacts.contacts.get(contactId);
  const drafts: VaultDraft[] = [];
  if (contact === undefined) return drafts;
  if (!contact.deleted) drafts.push(vaultDraft("contact.deleted", { contactId }));
  if (options.block !== undefined) drafts.push(...blockDrafts(fold, contact.channels, options.block.includeSuccessors));
  if (options.erase !== undefined) drafts.push(...eraseDrafts(fold, contact.channels.flatMap((channel) => messageIdsOf(fold.views.channel(channel))), options.erase));
  return drafts;
}

/** Delete a contact, and deny or erase what the product chose, in one commit; then collect, since an erase may release a root. */
export function deleteContact(runtime: VaultRuntime, keys: Keys | null, contactId: ContactId, options: DeleteContactOptions = {}, scan: ScanOptions = {}): Promise<Committed> {
  return decide(runtime, keys, scan, (fold) => deleteContactDrafts(fold, contactId, options));
}
