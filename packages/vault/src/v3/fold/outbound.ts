/**
 * The outbound messages: for each message ID, the one intent its
 * `message.out` records must agree on, the one package its
 * preparations must agree on, the submission that says a transport
 * accepted that package, the termination that ended it unsent, and
 * the peers' receipts that acknowledge it. Each fact is derived on its
 * own from its own evidence, so that a submission once complete stays
 * complete whatever a later import adds, and a termination stands
 * without any package. An intent derived from an inbound input is
 * checked against that input's execution and the producing
 * operation's rules; what contradicts it does so for good, what is
 * missing leaves it pending. The fold says what a message still needs
 * — a package, or a transport call — and never whether to make that
 * call: dispatch authority is the runtime's live action.
 */

import { InvalidDidDocument } from "../errors.js";
import { channelOf, sameChannel } from "../ids.js";
import { canonicalDidOf } from "../peer-document.js";
import type { VaultEvent } from "../schema.js";
import type { Channel, Did, EventId, MessageId, MessageOut, WireMessageId } from "../types.js";
import { compareReceiptKeys, receiptOrderKey, type ChannelEvidence, type Source } from "./channels.js";
import type { Continuity } from "./continuity.js";
import type { EvidenceCheck } from "./evidence.js";
import type { Erasures } from "./held.js";
import { EMPTY_CONTENT_CID, EMPTY_MESSAGE_TYPE, PING_RESPONSE_TYPE, type Execution, type InboundFold } from "./inbound.js";
import type { LocalDidEntity, RouteFold } from "./routes.js";
import { groupBy, samePayload, type VaultEventSet } from "./set.js";

export const PURE_ACK_EFFECT = "https://estoc.dev/distributed-delivery/1.0#pure-ack";
export const PING_RESPONSE_EFFECT = PING_RESPONSE_TYPE;
export const ROTATION_NOTIFICATION_EFFECT = "https://estoc.dev/distributed-delivery/1.0#rotation-notification";
export const PING_TYPE = "https://didcomm.org/trust-ping/2.0/ping";

/** The operations whose output intents this fold can check field by field. */
export const BUILT_IN_EFFECTS: ReadonlySet<string> = new Set([PURE_ACK_EFFECT, PING_RESPONSE_EFFECT, ROTATION_NOTIFICATION_EFFECT]);

export type IntentStatus = { status: "consistent"; data: MessageOut } | { status: "conflict"; because: string };

/**
 * A preparation on its own. Conflict is for good: it contradicts the
 * intent or its own evidence. Pending while the resolution it names,
 * or that resolution's document, is not here.
 */
export type PackageStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

export interface Package {
  /** the first preparation in canonical order with this payload; identical repetitions are one package */
  readonly event: VaultEvent<"message.prepared">;
  readonly status: PackageStatus;
  /** an erasure of the message names the envelope: nothing to send */
  readonly erased: boolean;
}

export type SubmissionStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

export interface Submission {
  readonly event: VaultEvent<"delivery.submitted">;
  readonly status: SubmissionStatus;
}

export type TerminationStatus = { status: "complete" } | { status: "invalid"; because: string };

export interface Termination {
  readonly event: VaultEvent<"delivery.failed">;
  readonly status: TerminationStatus;
}

/** A complete witness in the outbound's channel, or a role-preserving successor of it, whose `ack` names the outbound. */
export interface AckWitness {
  readonly source: Source;
}

export type AcknowledgementStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

/** A recorded `delivery.acknowledged`, checked against the one carrier it names. */
export interface Acknowledgement {
  readonly event: VaultEvent<"delivery.acknowledged">;
  readonly status: AcknowledgementStatus;
}

/**
 * What an intent derived from an input rests on: the input's
 * execution, the source's witness, the operation's rules, the
 * output's channel. Complete for a locally initiated send that names
 * no rotation. Conflict is for good; pending waits for evidence that
 * may still arrive, or for an operation this vault does not know.
 */
export type EffectStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

export type Outcome = { status: "conflict"; because: string } | { status: "submitted" } | { status: "terminal"; code: "expired" | "cancelled" } | { status: "prepared" } | { status: "queued" };

/**
 * What the message still needs, whatever the wall clock says: a
 * package, or a transport call of the one it has. The runtime checks
 * expiry, bytes and its own dispatch authority before either.
 */
export type Work = { kind: "none"; because: string } | { kind: "prepare" } | { kind: "dispatch"; package: Package };

export interface Outbound {
  readonly messageId: MessageId;
  readonly intents: readonly VaultEvent<"message.out">[];
  readonly intent: IntentStatus;
  /** the sender entity the consistent intent names, whatever its state; null while none is here */
  readonly sender: LocalDidEntity | null;
  /** the fixed pair, once the sender's creation reads */
  readonly channel: Channel | null;
  /** every distinct preparation, in canonical order */
  readonly packages: readonly Package[];
  /** the one package, when the preparations agree */
  readonly package: Package | null;
  readonly submissions: readonly Submission[];
  /** a complete submission names the intent and a valid package: a fact nothing later withdraws */
  readonly submitted: boolean;
  readonly terminations: readonly Termination[];
  /** the first valid termination in canonical order */
  readonly terminal: Termination | null;
  readonly effect: EffectStatus;
  /** in first-receipt order */
  readonly ackWitnesses: readonly AckWitness[];
  readonly acknowledgements: readonly Acknowledgement[];
  readonly acknowledged: boolean;
  /** acknowledged, with an expiry, and the earliest witness observed at or after it */
  readonly late: boolean;
  /** an erasure names the message */
  readonly erased: boolean;
  readonly outcome: Outcome;
  readonly work: Work;
  /** the envelope contribution is released: submitted or terminal under a consistent intent */
  readonly released: boolean;
}

export type Notification = { status: "none" } | { status: "selected"; messageId: MessageId } | { status: "conflict"; messageIds: readonly MessageId[] };

/** A delivery event of a message ID no intent is recorded under. */
export type StrayEvent = VaultEvent<"message.prepared"> | VaultEvent<"delivery.submitted"> | VaultEvent<"delivery.failed"> | VaultEvent<"delivery.acknowledged">;

export interface OutboundFold {
  /** every message ID an intent is recorded under */
  readonly outbounds: ReadonlyMap<MessageId, Outbound>;
  /** in canonical order */
  readonly stray: readonly StrayEvent[];
  /** the messages whose envelope contribution is released */
  readonly released: ReadonlySet<MessageId>;
  /** the notification intents naming a rotation decision, whatever their form: one selects, several conflict */
  notificationFor(rotationEventId: EventId): Notification;
  /**
   * The ACK targets a carrier's request names, in first-receipt order:
   * each an established input of this channel or a verified
   * role-preserving predecessor, not under a receipt-integrity
   * conflict, and unambiguous under its wire ID. A carrier that is no
   * complete witness, or requests nothing, names none.
   */
  ackTargets(sourceEventId: EventId): readonly WireMessageId[];
  /** the outbound a ping-response or problem report answers, when its thread names one this carrier may answer */
  inReplyTo(sourceEventId: EventId): Outbound | null;
}

export type OutboundFoldOptions = {
  /** operations beyond the built-in three whose intents this vault produces; an intent of another operation is pending */
  effectTypes?: Iterable<string>;
};

export function foldOutbound(
  set: VaultEventSet,
  routes: RouteFold,
  evidence: ChannelEvidence,
  continuity: Continuity,
  inbound: InboundFold,
  erasures: Erasures,
  resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>,
  options: OutboundFoldOptions = {}
): OutboundFold {
  const known = new Set([...BUILT_IN_EFFECTS, ...(options.effectTypes ?? [])]);
  const intents = groupBy(set.of("message.out"), (event) => event.data.messageId);
  const prepared = groupBy(set.of("message.prepared"), (event) => event.data.messageId);
  const submissions = groupBy(set.of("delivery.submitted"), (event) => event.data.messageId);
  const failures = groupBy(set.of("delivery.failed"), (event) => event.data.messageId);
  const acknowledgements = groupBy(set.of("delivery.acknowledged"), (event) => event.data.messageId);
  const witnesses = witnessesByTarget(evidence, continuity);

  const outbounds = new Map<MessageId, Outbound>();
  const released = new Set<MessageId>();
  for (const [messageId, events] of intents) {
    const outbound = outboundOf(messageId, events, {
      packages: prepared.get(messageId) ?? [],
      submissions: submissions.get(messageId) ?? [],
      failures: failures.get(messageId) ?? [],
      acknowledgements: acknowledgements.get(messageId) ?? [],
      witnesses: witnesses.get(messageId) ?? [],
      set,
      routes,
      evidence,
      continuity,
      inbound,
      erasures,
      resolutionChecks,
      known,
    });
    outbounds.set(messageId, outbound);
    if (outbound.released) released.add(messageId);
  }

  const stray: StrayEvent[] = [];
  for (const group of [prepared, submissions, failures, acknowledgements]) {
    for (const [messageId, events] of group) if (!intents.has(messageId)) stray.push(...events);
  }
  stray.sort((a, b) => cmp(a.at, b.at) || cmp(a.eventId, b.eventId) || cmp(a.author, b.author));

  const notifications = groupBy(
    set.of("message.out").filter((event) => event.data.rotationEventId !== null),
    (event) => event.data.rotationEventId as EventId
  );
  const executionsByWire = groupBy(inbound.executions.values(), (execution) => execution.wireMessageId);

  return {
    outbounds,
    stray,
    released,
    notificationFor: (rotationEventId) => {
      const messageIds = [...new Set((notifications.get(rotationEventId) ?? []).map((event) => event.data.messageId))].sort();
      if (messageIds.length === 0) return { status: "none" };
      return messageIds.length === 1 ? { status: "selected", messageId: messageIds[0]! } : { status: "conflict", messageIds };
    },
    ackTargets: (sourceEventId) => ackTargetsOf(sourceEventId, evidence, continuity, inbound, executionsByWire),
    inReplyTo: (sourceEventId) => {
      const source = evidence.sources.get(sourceEventId);
      const execution = inbound.ofSource(sourceEventId);
      if (source === undefined || source.channel === null || execution === null || execution.status.status !== "complete") return null;
      if (continuity.witness(sourceEventId).status !== "complete") return null;
      const { data } = source.event;
      const thread = execution.kind === "ping-response" ? data.thid : execution.kind === "error" ? data.pthid : null;
      if (thread === null) return null;
      const outbound = outbounds.get(thread as MessageId);
      if (outbound?.channel == null || !continuity.ackPath(outbound.channel, source.channel)) return null;
      return outbound;
    },
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The complete witnesses whose `ack` names each wire ID, in first-receipt order. */
function witnessesByTarget(evidence: ChannelEvidence, continuity: Continuity): Map<string, Source[]> {
  const byTarget = new Map<string, Source[]>();
  const sources = [...evidence.sources.values()].sort((a, b) => compareReceiptKeys(receiptOrderKey(a.event), receiptOrderKey(b.event)));
  for (const source of sources) {
    if (source.channel === null || source.event.data.ack.length === 0 || continuity.witness(source.event.eventId).status !== "complete") continue;
    for (const target of new Set(source.event.data.ack)) {
      const list = byTarget.get(target);
      if (list === undefined) byTarget.set(target, [source]);
      else list.push(source);
    }
  }
  return byTarget;
}

type Inputs = {
  packages: readonly VaultEvent<"message.prepared">[];
  submissions: readonly VaultEvent<"delivery.submitted">[];
  failures: readonly VaultEvent<"delivery.failed">[];
  acknowledgements: readonly VaultEvent<"delivery.acknowledged">[];
  witnesses: readonly Source[];
  set: VaultEventSet;
  routes: RouteFold;
  evidence: ChannelEvidence;
  continuity: Continuity;
  inbound: InboundFold;
  erasures: Erasures;
  resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>;
  known: ReadonlySet<string>;
};

function outboundOf(messageId: MessageId, events: readonly VaultEvent<"message.out">[], inputs: Inputs): Outbound {
  const intent = intentOf(events);
  const data = intent.status === "consistent" ? intent.data : null;
  const sender = data === null ? null : (inputs.routes.dids.get(data.senderDidId) ?? null);
  const erased = inputs.erasures.has(messageId);

  let channel: Channel | null = null;
  let fault: string | null = intent.status === "conflict" ? intent.because : null;
  let waiting: string | null = null;
  if (data !== null) {
    if (sender === null) waiting = "no communication DID here records the sender";
    else if (sender.conflict) fault = `the sender entity is in conflict: ${sender.faults[0]}`;
    else if (sender.created === null) waiting = "the sender entity has no consistent creation here";
    else {
      const recipient = canonicalRecipient(data.recipientDid);
      if (recipient === null) fault = "the recipient is no valid did:peer:4";
      else if (recipient === sender.created.did) fault = "the recipient is the sender's own DID";
      else channel = channelOf(sender.created.did, recipient);
    }
  }

  const packages = packagesOf(inputs.packages, data, channel, messageId, inputs);
  const one = packages.length === 1 ? packages[0]! : null;
  if (packages.length > 1 && fault === null) fault = `${packages.length} packages are prepared for one message`;
  if (one?.status.status === "conflict" && fault === null) fault = `the package contradicts the intent: ${one.status.because}`;

  const submissions = inputs.submissions.map((event) => submissionOf(event, packages, data));
  const submitted = submissions.some((submission) => submission.status.status === "complete");
  const terminations = inputs.failures.map((event) => terminationOf(event, data));
  const terminal = terminations.find((termination) => termination.status.status === "complete") ?? null;

  const effect = data === null ? { status: "complete" as const } : effectOf(data, channel, inputs);
  if (effect.status === "conflict" && fault === null) fault = effect.because;

  const ackWitnesses: AckWitness[] = channel === null ? [] : inputs.witnesses.filter((source) => inputs.continuity.ackPath(channel, source.channel!)).map((source) => ({ source }));
  const acknowledgements = inputs.acknowledgements.map((event) => acknowledgementOf(event, ackWitnesses, inputs.evidence));
  const acknowledged = ackWitnesses.length > 0;
  const late = acknowledged && data?.expiresTime != null && Math.min(...ackWitnesses.map(({ source }) => Date.parse(source.event.at))) >= data.expiresTime * 1000;

  const outcome: Outcome =
    fault !== null
      ? { status: "conflict", because: fault }
      : submitted
        ? { status: "submitted" }
        : terminal !== null
          ? { status: "terminal", code: terminal.event.data.code }
          : one !== null
            ? { status: "prepared" }
            : { status: "queued" };
  const released = data !== null && (submitted || terminal !== null);

  const work = workOf({ outcome, waiting, sender, channel, erased, effect, package: one, continuity: inputs.continuity });
  return { messageId, intents: events, intent, sender, channel, packages, package: one, submissions, submitted, terminations, terminal, effect, ackWitnesses, acknowledgements, acknowledged, late, erased, outcome, work, released };
}

function intentOf(events: readonly VaultEvent<"message.out">[]): IntentStatus {
  const first = events[0]!;
  for (const event of events) if (!samePayload(event.data, first.data)) return { status: "conflict", because: "the intents recorded under one message ID disagree" };
  return { status: "consistent", data: first.data };
}

function canonicalRecipient(did: Did): Did | null {
  try {
    return canonicalDidOf(did);
  } catch (err) {
    if (err instanceof InvalidDidDocument) return null;
    throw err;
  }
}

/**
 * Each distinct preparation against the intent and its own evidence:
 * the sender and the canonical recipient are the intent's, the intent
 * hash is the intent's, the resolution it names is here, is one, was
 * taken at its key of the sender it names and is verified against its
 * document. Identical payloads are one package. Without a consistent
 * intent there is nothing to check a package against.
 */
function packagesOf(events: readonly VaultEvent<"message.prepared">[], data: MessageOut | null, channel: Channel | null, messageId: MessageId, inputs: Inputs): Package[] {
  const distinct: VaultEvent<"message.prepared">[] = [];
  for (const event of events) if (!distinct.some((seen) => samePayload(seen.data, event.data))) distinct.push(event);
  return distinct.map((event) => ({ event, status: packageStatus(event, data, channel, inputs), erased: inputs.erasures.get(messageId)?.has(event.data.envelopeCid) ?? false }));
}

function packageStatus(event: VaultEvent<"message.prepared">, data: MessageOut | null, channel: Channel | null, inputs: Inputs): PackageStatus {
  const conflict = (because: string): PackageStatus => ({ status: "conflict", because });
  if (data === null) return { status: "pending", because: "the intent is not consistent" };
  const { data: pkg } = event;
  if (pkg.senderDidId !== data.senderDidId) return conflict("the package's sender is not the intent's");
  if (pkg.intentHash !== data.intentHash) return conflict("the package's intent hash is not the intent's");
  const recipient = canonicalRecipient(pkg.recipientDid);
  if (recipient === null) return conflict("the package's recipient is no valid did:peer:4");
  if (channel !== null && recipient !== channel.peerDid) return conflict("the package's recipient is not the intent's");
  const resolved = inputs.set.resolve(pkg.peerResolutionEventId, "peer.resolved");
  if (resolved.status === "missing") return { status: "pending", because: "the resolution it names is not here" };
  if (resolved.status === "mismatched") return conflict(`the resolution it names is a ${resolved.event.type}`);
  const resolution = resolved.event.data;
  if (resolution.localKeyName !== pkg.localKeyName) return conflict("the resolution it names was not taken at the package's key");
  if (resolution.did !== recipient) return conflict("the resolution it names is not of the recipient");
  const check = inputs.resolutionChecks.get(resolved.event.eventId);
  if (check === "invalid") return conflict("the resolution's snapshot is not its document's");
  if (check === undefined) return { status: "pending", because: "the resolution's document is not here" };
  if (channel === null) return { status: "pending", because: "the sender entity has no consistent creation here" };
  return { status: "complete" };
}

/** A submission names the intent's message and one preparation here that is itself complete; a preparation not here is still to arrive. */
function submissionOf(event: VaultEvent<"delivery.submitted">, packages: readonly Package[], data: MessageOut | null): Submission {
  if (data === null) return { event, status: { status: "pending", because: "the intent is not consistent" } };
  const named = packages.find((pkg) => pkg.event.data.packageId === event.data.packageId);
  if (named === undefined) return { event, status: { status: "pending", because: "the package it names is not here" } };
  if (named.status.status === "complete") return { event, status: { status: "complete" } };
  return { event, status: named.status.status === "conflict" ? { status: "conflict", because: `the package it names contradicts the intent: ${named.status.because}` } : named.status };
}

function terminationOf(event: VaultEvent<"delivery.failed">, data: MessageOut | null): Termination {
  if (data === null) return { event, status: { status: "invalid", because: "the intent is not consistent" } };
  if (event.data.code === "expired" && data.expiresTime === null) return { event, status: { status: "invalid", because: "the intent has no expiry to reach" } };
  return { event, status: { status: "complete" } };
}

/** A recorded acknowledgement names one carrier among the witnesses and repeats that carrier's key, peer key and wire ID exactly. */
function acknowledgementOf(event: VaultEvent<"delivery.acknowledged">, witnesses: readonly AckWitness[], evidence: ChannelEvidence): Acknowledgement {
  const { data } = event;
  const witness = witnesses.find(({ source }) => source.event.data.messageId === data.ackMessageId);
  if (witness === undefined) {
    const known = [...evidence.sources.values()].some((source) => source.event.data.messageId === data.ackMessageId);
    return { event, status: known ? { status: "pending", because: "the carrier it names does not acknowledge this message as a complete witness" } : { status: "pending", because: "the carrier it names is not here" } };
  }
  const carrier = witness.source.event.data;
  const conflict = (because: string): Acknowledgement => ({ event, status: { status: "conflict", because } });
  if (carrier.wireMessageId !== data.ackWireMessageId) return conflict("the wire ID is not the carrier's");
  if (carrier.localKeyName !== data.localKeyName) return conflict("the local key is not the carrier's");
  if (witness.source.resolution!.data.peerPublicKey !== data.peerPublicKey) return conflict("the peer key is not the carrier's");
  return { event, status: { status: "complete" } };
}

/**
 * An intent derived from an input rests on the input's execution:
 * the source must be a member of the input whose execution the intent
 * names, a complete witness, in the channel the output continues,
 * and the input free of intent conflict; the operation must be one
 * this vault knows, and a built-in one must have shaped the output as
 * its rules say. A notification rests on its decision the same way.
 */
function effectOf(data: MessageOut, channel: Channel | null, inputs: Inputs): EffectStatus {
  const conflict = (because: string): EffectStatus => ({ status: "conflict", because });
  const pending = (because: string): EffectStatus => ({ status: "pending", because });
  const missing: string[] = [];

  let source: Source | null = null;
  let execution: Execution | null = null;
  if (data.sourceEventId !== null) {
    const resolved = inputs.set.resolve(data.sourceEventId, "message.in");
    if (resolved.status === "mismatched") return conflict(`the source it names is a ${resolved.event.type}`);
    if (resolved.status === "missing") missing.push("the source it names is not here");
    else {
      source = inputs.evidence.sources.get(data.sourceEventId)!;
      if (source.event.data.peerResolutionEventId === null) return conflict("the source is anonymous, in no channel");
      if (source.standing.status === "conflict") return conflict(`the source's authentication is in conflict: ${source.standing.because}`);
      execution = inputs.inbound.ofSource(data.sourceEventId);
      if (execution !== null) {
        if (execution.id !== data.executionId) return conflict(`the execution ID is not the one the source's input derives, ${execution.id}`);
        if (execution.status.status === "conflict") return conflict(`the source's input is in conflict: ${execution.status.because}`);
      }
      const witness = inputs.continuity.witness(data.sourceEventId);
      if (witness.status === "invalid" || witness.status === "conflict") return conflict(`the source is no complete witness: ${witness.because}`);
      if (witness.status === "pending") missing.push(`the source is no complete witness yet: ${witness.because}`);
    }
  }

  if (data.rotationEventId !== null) {
    const verdict = notificationOf(data, source, channel, inputs, missing);
    if (verdict !== null) return verdict;
  } else if (data.effectType !== null) {
    if (!inputs.known.has(data.effectType)) return pending(`no operation here produces ${data.effectType}`);
    const verdict = builtInOf(data, source, channel, inputs);
    if (verdict !== null) return verdict;
  }

  if (missing.length > 0) return pending(missing[0]!);
  return { status: "complete" };
}

/** The output of an ACK or a Ping reply continues the source's channel, or a verified role-preserving successor that keeps the peer. */
function continues(source: Source, channel: Channel | null, continuity: Continuity): string | null {
  if (channel === null || source.channel === null) return null;
  if (sameChannel(source.channel, channel)) return null;
  if (channel.peerDid !== source.channel.peerDid || !continuity.ackPath(source.channel, channel)) return "the output's channel does not continue the source's";
  return null;
}

function builtInOf(data: MessageOut, source: Source | null, channel: Channel | null, inputs: Inputs): EffectStatus | null {
  const conflict = (because: string): EffectStatus => ({ status: "conflict", because });
  const carried = source?.event.data ?? null;
  const continued = source === null ? null : continues(source, channel, inputs.continuity);
  if (continued !== null) return conflict(continued);
  const empty = data.bodyCid === EMPTY_CONTENT_CID && data.attachmentCids.length === 0 && Object.keys(data.headers).length === 0;
  const threaded = carried === null || (data.thid === (carried.thid ?? carried.wireMessageId) && data.pthid === carried.pthid);
  switch (data.effectType) {
    case PURE_ACK_EFFECT:
      if (data.msgType !== EMPTY_MESSAGE_TYPE || !empty) return conflict("a pure ACK is an Empty message with body {} and nothing else");
      if (data.pleaseAck !== null || data.expiresTime !== null) return conflict("a pure ACK requests no ACK and does not expire");
      if (data.ack.length === 0) return conflict("a pure ACK names at least one target");
      if (!threaded || (carried !== null && data.createdTime !== carried.createdTime)) return conflict("a pure ACK keeps the carrier's thread and creation time");
      if (carried !== null && carried.msgType === EMPTY_MESSAGE_TYPE && carried.pleaseAck === null) return conflict("a pure ACK answers no pure ACK");
      return null;
    case PING_RESPONSE_EFFECT:
      if (data.msgType !== PING_RESPONSE_TYPE || !empty) return conflict("a Ping reply is a ping-response with an empty body and nothing else");
      if (data.pleaseAck !== null || data.ack.length > 0) return conflict("a Ping reply neither requests nor carries an ACK");
      if (carried !== null && carried.msgType !== PING_TYPE) return conflict("a Ping reply answers a Ping");
      if (carried !== null && (data.thid !== carried.wireMessageId || data.pthid !== carried.pthid || data.createdTime !== carried.createdTime || data.expiresTime !== carried.expiresTime)) {
        return conflict("a Ping reply threads on the Ping's wire ID and keeps its parent thread and timing");
      }
      return null;
    default:
      return null;
  }
}

/**
 * A notification names a decision and is shaped by it: sent from the
 * decision's successor to its peer, an Empty message requesting an
 * ACK, never expiring; triggered exactly when the decision was, by the
 * same source, whose thread and creation time it keeps; a manual one
 * with no thread and no creation time.
 */
function notificationOf(data: MessageOut, source: Source | null, channel: Channel | null, inputs: Inputs, missing: string[]): EffectStatus | null {
  const conflict = (because: string): EffectStatus => ({ status: "conflict", because });
  if (data.effectType !== null && data.effectType !== ROTATION_NOTIFICATION_EFFECT) return conflict("an intent naming a rotation is a rotation notification");
  const empty = data.bodyCid === EMPTY_CONTENT_CID && data.attachmentCids.length === 0 && Object.keys(data.headers).length === 0;
  if (data.msgType !== EMPTY_MESSAGE_TYPE || !empty) return conflict("a notification is an Empty message with body {} and nothing else");
  if (data.pleaseAck === null || data.pleaseAck.length !== 1 || data.pleaseAck[0] !== "" || data.ack.length > 0 || data.expiresTime !== null) {
    return conflict("a notification requests its own receipt, carries no ACK and does not expire");
  }
  const resolved = inputs.set.resolve(data.rotationEventId!, "did.rotationSelected");
  if (resolved.status === "mismatched") return conflict(`the rotation it names is a ${resolved.event.type}`);
  if (resolved.status === "missing") {
    missing.push("the rotation it names is not here");
    return null;
  }
  const decision = inputs.evidence.decisions.get(resolved.event.eventId)!;
  const { data: rotation } = decision.event;
  if (rotation.sourceEventId !== data.sourceEventId) return conflict("a notification is triggered exactly as its decision was, by the same source");
  if (rotation.toDidId !== data.senderDidId) return conflict("a notification is sent from the decision's successor");
  if (channel !== null && channel.peerDid !== rotation.peerDid) return conflict("a notification is sent to the decision's peer");
  const carried = source?.event.data ?? null;
  if (carried === null) {
    if (data.thid !== null || data.pthid !== null || data.createdTime !== null) return conflict("a manual notification has no thread and no creation time");
  } else if (data.thid !== (carried.thid ?? carried.wireMessageId) || data.pthid !== carried.pthid || data.createdTime !== carried.createdTime) {
    return conflict("a triggered notification keeps its source's thread and creation time");
  }
  if (decision.status.status === "invalid" || decision.status.status === "conflict") return conflict(`the rotation it names is ${decision.status.status}: ${decision.status.because}`);
  if (decision.status.status === "pending") missing.push(`the rotation it names is pending: ${decision.status.because}`);
  return null;
}

type WorkInputs = { outcome: Outcome; waiting: string | null; sender: LocalDidEntity | null; channel: Channel | null; erased: boolean; effect: EffectStatus; package: Package | null; continuity: Continuity };

function workOf(w: WorkInputs): Work {
  const none = (because: string): Work => ({ kind: "none", because });
  if (w.outcome.status === "conflict") return none(w.outcome.because);
  if (w.outcome.status === "submitted") return none("submitted");
  if (w.outcome.status === "terminal") return none(`terminated: ${w.outcome.code}`);
  if (w.erased) return none("erased");
  if (w.waiting !== null || w.channel === null) return none(w.waiting ?? "the sender's channel is not known");
  if (!w.sender!.live) return none(`the sender is not live: ${w.sender!.faults[0] ?? `retired: ${w.sender!.retired}`}`);
  if (w.continuity.blocked(w.channel).length > 0) return none("the channel is blocked");
  if (w.effect.status !== "complete") return none(w.effect.because);
  if (w.package === null) return { kind: "prepare" };
  if (w.package.status.status !== "complete") return none(w.package.status.because);
  if (w.package.erased) return none("the envelope is erased");
  return { kind: "dispatch", package: w.package };
}

function ackTargetsOf(sourceEventId: EventId, evidence: ChannelEvidence, continuity: Continuity, inbound: InboundFold, executionsByWire: ReadonlyMap<WireMessageId, Execution[]>): WireMessageId[] {
  const source = evidence.sources.get(sourceEventId);
  const requested = source?.event.data.pleaseAck;
  if (source === undefined || source.channel === null || requested == null || requested.length === 0) return [];
  if (continuity.witness(sourceEventId).status !== "complete") return [];
  const channel = source.channel;
  const own = inbound.ofSource(sourceEventId);
  const targets: Execution[] = [];
  for (const wanted of new Set(requested.map((target) => (target === "" ? source.event.data.wireMessageId : target)))) {
    const candidates = (executionsByWire.get(wanted as WireMessageId) ?? []).filter((execution) => {
      if (execution.status.status !== "complete" || evidence.receipts.affected.has(execution.messageId)) return false;
      return execution === own || continuity.ackPath(execution.channel, channel);
    });
    if (candidates.length === 1) targets.push(candidates[0]!);
  }
  targets.sort((a, b) => compareReceiptKeys(a.firstReceiptKey!, b.firstReceiptKey!));
  return targets.map((execution) => execution.wireMessageId);
}
