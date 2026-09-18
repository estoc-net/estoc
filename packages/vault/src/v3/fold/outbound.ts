/**
 * The outbound messages: for each message ID, the one intent its
 * `message.out` records must agree on, the one package its
 * preparations must agree on, the submission that says a transport
 * accepted that package, the termination that ended it unsent, and
 * the peers' receipts that acknowledge it. Each fact is derived on its
 * own from its own evidence: under a consistent intent a submission
 * that is complete stays complete however much unrelated, competing or
 * later lifecycle evidence is imported, and a termination stands
 * without any package. An intent derived from an inbound input is
 * checked against that input's execution and the producing
 * operation's rules; what contradicts it does so for good, what is
 * missing leaves it pending. The fold says what a message still needs
 * — a package, or a transport call — and never whether to make that
 * call: dispatch authority is the runtime's live action.
 */

import { InvalidDidDocument, InvalidPublicKey } from "../errors.js";
import { channelOf, sameChannel } from "../ids.js";
import { canonicalDidOf } from "../peer-document.js";
import { agreementKey } from "../public-key.js";
import type { VaultEvent } from "../schema.js";
import type { Channel, Did, EventId, MessageId, MessageOut, WireMessageId } from "../types.js";
import { compareReceiptKeys, keyAgreementTypeOf, receiptOrderKey, type ChannelEvidence, type Source } from "./channels.js";
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
  /** a complete submission names the consistent intent and a complete package: no unrelated, competing or later evidence withdraws it */
  readonly submitted: boolean;
  readonly terminations: readonly Termination[];
  /** the first valid termination in canonical order */
  readonly terminal: Termination | null;
  readonly effect: EffectStatus;
  /** in first-receipt order; none until a complete package is here to attribute the receipts to */
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
  /** the notification intents naming a rotation decision, whatever their form: one selects, several conflict and stop each one's work */
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
  const selections = new Map<EventId, MessageId[]>();
  for (const event of set.of("message.out")) {
    if (event.data.rotationEventId === null) continue;
    const selected = selections.get(event.data.rotationEventId) ?? [];
    if (!selected.includes(event.data.messageId)) selections.set(event.data.rotationEventId, [...selected, event.data.messageId].sort());
  }
  const executionsByWire = groupBy(inbound.executions.values(), (execution) => execution.wireMessageId);

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
      selections,
      executionsByWire,
    });
    outbounds.set(messageId, outbound);
    if (outbound.released) released.add(messageId);
  }

  const stray: StrayEvent[] = [];
  for (const group of [prepared, submissions, failures, acknowledgements]) {
    for (const [messageId, events] of group) if (!intents.has(messageId)) stray.push(...events);
  }
  stray.sort((a, b) => cmp(a.at, b.at) || cmp(a.eventId, b.eventId) || cmp(a.author, b.author));

  return {
    outbounds,
    stray,
    released,
    notificationFor: (rotationEventId) => {
      const messageIds = selections.get(rotationEventId) ?? [];
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
  /** the distinct notification message IDs naming each rotation */
  selections: ReadonlyMap<EventId, readonly MessageId[]>;
  executionsByWire: ReadonlyMap<WireMessageId, Execution[]>;
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

  const packages = packagesOf(inputs.packages, data, sender, channel, messageId, inputs);
  const one = packages.length === 1 ? packages[0]! : null;
  if (packages.length > 1 && fault === null) fault = `${packages.length} packages are prepared for one message`;
  if (one?.status.status === "conflict" && fault === null) fault = `the package contradicts the intent: ${one.status.because}`;
  const packaged = packagedOf(packages);

  const submissions = inputs.submissions.map((event) => submissionOf(event, packages, data));
  const submitted = submissions.some((submission) => submission.status.status === "complete");
  const unresolved = submissions.some((submission) => !packages.some((pkg) => pkg.event.data.packageId === submission.event.data.packageId));
  const terminations = inputs.failures.map((event) => terminationOf(event, data));
  const terminal = terminations.find((termination) => termination.status.status === "complete") ?? null;

  const effect = data === null ? { status: "complete" as const } : effectOf(data, channel, inputs);
  if (effect.status === "conflict" && fault === null) fault = effect.because;

  const ackWitnesses: AckWitness[] = channel === null || packaged.status !== "complete" ? [] : inputs.witnesses.filter((source) => inputs.continuity.ackPath(channel, source.channel!)).map((source) => ({ source }));
  const acknowledgements = inputs.acknowledgements.map((event) => acknowledgementOf(event, packaged, ackWitnesses, inputs.evidence));
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

  const work = workOf({ outcome, waiting, sender, channel, erased, effect, package: one, unresolved, continuity: inputs.continuity });
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

/** Each distinct preparation checked on its own; identical payloads are one package. */
function packagesOf(events: readonly VaultEvent<"message.prepared">[], data: MessageOut | null, sender: LocalDidEntity | null, channel: Channel | null, messageId: MessageId, inputs: Inputs): Package[] {
  const distinct: VaultEvent<"message.prepared">[] = [];
  for (const event of events) if (!distinct.some((seen) => samePayload(seen.data, event.data))) distinct.push(event);
  return distinct.map((event) => ({ event, status: packageStatus(event, data, sender, channel, inputs), erased: inputs.erasures.get(messageId)?.has(event.data.envelopeCid) ?? false }));
}

/**
 * A package is the intent's — same sender, canonical recipient and
 * intent hash — and rests on the one resolution it names: taken at
 * the package's key, of that recipient,
 * verified against its document, and selecting a peer key on the
 * curve the sender's own key is on, since no key is agreed across
 * curves. Each contradiction is found as soon as what it needs is
 * here, before any absence.
 */
function packageStatus(event: VaultEvent<"message.prepared">, data: MessageOut | null, sender: LocalDidEntity | null, channel: Channel | null, inputs: Inputs): PackageStatus {
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
  let peerKeyType: string;
  try {
    peerKeyType = agreementKey(resolution.peerPublicKey).type;
  } catch (err) {
    if (!(err instanceof InvalidPublicKey)) throw err;
    return conflict(err.message);
  }
  const check = inputs.resolutionChecks.get(resolved.event.eventId);
  if (check === "invalid") return conflict("the resolution's snapshot is not its document's");
  const localKeyType = sender === null ? null : keyAgreementTypeOf(sender);
  if (localKeyType !== null && peerKeyType !== localKeyType) return conflict(`the peer key is ${peerKeyType} and the sender's key-agreement key ${localKeyType}: no key is agreed across curves`);
  if (check === undefined) return { status: "pending", because: "the resolution's document is not here" };
  if (channel === null) return { status: "pending", because: "the sender entity has no consistent creation here" };
  if (localKeyType === null) return { status: "pending", because: "the sender's own document does not read" };
  return { status: "complete" };
}

/** Whether a complete package is here to attribute receipts and submissions to: the best any preparation reaches. */
function packagedOf(packages: readonly Package[]): PackageStatus {
  if (packages.some((pkg) => pkg.status.status === "complete")) return { status: "complete" };
  if (packages.length === 0) return { status: "pending", because: "no package is prepared here" };
  const pending = packages.find((pkg) => pkg.status.status === "pending");
  if (pending !== undefined) return pending.status;
  const { status } = packages[0]!;
  return status.status === "conflict" ? { status: "conflict", because: `the package contradicts the intent: ${status.because}` } : status;
}

/**
 * A submission names the intent's message and a preparation here
 * under its package ID that is itself complete. Among preparations
 * under that ID a complete one carries it, whatever order the others
 * come in; a preparation not here is still to arrive.
 */
function submissionOf(event: VaultEvent<"delivery.submitted">, packages: readonly Package[], data: MessageOut | null): Submission {
  if (data === null) return { event, status: { status: "pending", because: "the intent is not consistent" } };
  const named = packages.filter((pkg) => pkg.event.data.packageId === event.data.packageId);
  if (named.length === 0) return { event, status: { status: "pending", because: "the package it names is not here" } };
  const status = packagedOf(named);
  return { event, status: status.status === "conflict" ? { status: "conflict", because: status.because.replace("the package", "the package it names") } : status };
}

function terminationOf(event: VaultEvent<"delivery.failed">, data: MessageOut | null): Termination {
  if (data === null) return { event, status: { status: "invalid", because: "the intent is not consistent" } };
  if (event.data.code === "expired" && data.expiresTime === null) return { event, status: { status: "invalid", because: "the intent has no expiry to reach" } };
  return { event, status: { status: "complete" } };
}

/** A recorded acknowledgement rests on a complete package and names one carrier among the witnesses, repeating that carrier's key, peer key and wire ID exactly. */
function acknowledgementOf(event: VaultEvent<"delivery.acknowledged">, packaged: PackageStatus, witnesses: readonly AckWitness[], evidence: ChannelEvidence): Acknowledgement {
  if (packaged.status !== "complete") return { event, status: packaged };
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
 * The operation the intent declares decides what is checked: an
 * intent naming a rotation, or of the notification operation, is
 * checked as a notification; another automatic one as its built-in
 * operation's output. Either rests on its source's execution and
 * witness. A witness still pending, or an operation this vault does
 * not know, leaves the intent pending.
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

  if (data.rotationEventId !== null || data.effectType === ROTATION_NOTIFICATION_EFFECT) {
    const verdict = notificationOf(data, source, channel, inputs, missing);
    if (verdict !== null) return verdict;
  } else if (data.effectType !== null) {
    if (!inputs.known.has(data.effectType)) return pending(`no operation here produces ${data.effectType}`);
    const verdict = builtInOf(data, source, execution, channel, inputs, missing);
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

function builtInOf(data: MessageOut, source: Source | null, execution: Execution | null, channel: Channel | null, inputs: Inputs, missing: string[]): EffectStatus | null {
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
      return source === null ? null : ackTargetsIn(data.ack, source, execution, inputs, missing);
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
 * The frozen targets of a pure ACK, each against the source's request
 * and the input it names: the source must request it, and the input
 * must be established for it as when the array was frozen. An input
 * not here is still to arrive; an unrequested, ambiguous or
 * contradicted target is a conflict. The saved array is checked, never
 * rebuilt, so that later inputs do not rewrite an intent.
 */
function ackTargetsIn(targets: readonly string[], source: Source, execution: Execution | null, inputs: Inputs, missing: string[]): EffectStatus | null {
  const carried = source.event.data;
  if (carried.pleaseAck === null || carried.pleaseAck.length === 0) return { status: "conflict", because: "the source requests no ACK" };
  const requested = new Set(carried.pleaseAck.map((target) => (target === "" ? carried.wireMessageId : target)));
  for (const target of targets) {
    if (!requested.has(target)) return { status: "conflict", because: `the source does not request an ACK of ${target}` };
    const verdict = targetOf(target as WireMessageId, source, execution, inputs.evidence, inputs.continuity, inputs.executionsByWire);
    if (verdict.status === "conflict") return verdict;
    if (verdict.status === "pending") missing.push(verdict.because);
  }
  return null;
}

type Target = { status: "eligible"; execution: Execution } | { status: "pending"; because: string } | { status: "conflict"; because: string };

/**
 * The input a wire ID names for a carrier: the carrier's own input
 * when it is the carrier's wire ID, else the one established input of
 * that wire ID in the carrier's channel or a verified role-preserving
 * predecessor. None here is pending; more than one, or one under a
 * receipt-integrity or intent conflict, is a conflict.
 */
function targetOf(wanted: WireMessageId, source: Source, own: Execution | null, evidence: ChannelEvidence, continuity: Continuity, executionsByWire: ReadonlyMap<WireMessageId, Execution[]>): Target {
  const channel = source.channel!;
  const related =
    wanted === source.event.data.wireMessageId
      ? own === null
        ? []
        : [own]
      : (executionsByWire.get(wanted) ?? []).filter((execution) => continuity.ackPath(execution.channel, channel));
  if (related.length === 0) return { status: "pending", because: `no input of the channel or a verified predecessor has wire ID ${wanted}` };
  const eligible = related.filter((execution) => execution.status.status === "complete" && !evidence.receipts.affected.has(execution.messageId));
  if (eligible.length === 1) return { status: "eligible", execution: eligible[0]! };
  if (eligible.length > 1) return { status: "conflict", because: `wire ID ${wanted} names ${eligible.length} inputs` };
  const contradicted = related.find((execution) => execution.status.status === "conflict" || evidence.receipts.affected.has(execution.messageId));
  if (contradicted !== undefined) {
    return { status: "conflict", because: contradicted.status.status === "conflict" ? `the input with wire ID ${wanted} is in conflict: ${contradicted.status.because}` : `the input with wire ID ${wanted} is under a receipt conflict` };
  }
  return { status: "pending", because: `the input with wire ID ${wanted} is not established yet` };
}

/**
 * A notification is shaped by the decision it names: sent from the
 * decision's successor to its peer, an Empty message requesting an
 * ACK, never expiring; triggered exactly when the decision was, by
 * the same source, whose thread and creation time it keeps; manual
 * with no thread and no creation time. It rests on the decision's
 * continuity — a predecessor still unconfirmed is pending — and one
 * decision selects one notification.
 */
function notificationOf(data: MessageOut, source: Source | null, channel: Channel | null, inputs: Inputs, missing: string[]): EffectStatus | null {
  const conflict = (because: string): EffectStatus => ({ status: "conflict", because });
  if (data.effectType !== null && data.effectType !== ROTATION_NOTIFICATION_EFFECT) return conflict("an intent naming a rotation is a rotation notification");
  if (data.rotationEventId === null) return conflict("a rotation notification names its rotation");
  const empty = data.bodyCid === EMPTY_CONTENT_CID && data.attachmentCids.length === 0 && Object.keys(data.headers).length === 0;
  if (data.msgType !== EMPTY_MESSAGE_TYPE || !empty) return conflict("a notification is an Empty message with body {} and nothing else");
  if (data.pleaseAck === null || data.pleaseAck.length !== 1 || data.pleaseAck[0] !== "" || data.ack.length > 0 || data.expiresTime !== null) {
    return conflict("a notification requests its own receipt, carries no ACK and does not expire");
  }
  if (data.sourceEventId === null) {
    if (data.thid !== null || data.pthid !== null || data.createdTime !== null) return conflict("a manual notification has no thread and no creation time");
  } else if (source !== null) {
    const carried = source.event.data;
    if (data.thid !== (carried.thid ?? carried.wireMessageId) || data.pthid !== carried.pthid || data.createdTime !== carried.createdTime) {
      return conflict("a triggered notification keeps its source's thread and creation time");
    }
  }
  if ((inputs.selections.get(data.rotationEventId) ?? []).length > 1) return conflict("another notification is selected for the rotation");
  const resolved = inputs.set.resolve(data.rotationEventId, "did.rotationSelected");
  if (resolved.status === "mismatched") return conflict(`the rotation it names is a ${resolved.event.type}`);
  if (resolved.status === "missing") {
    missing.push("the rotation it names is not here");
    return null;
  }
  const { data: rotation } = resolved.event;
  if (rotation.sourceEventId !== data.sourceEventId) return conflict("a notification is triggered exactly as its decision was, by the same source");
  if (rotation.toDidId !== data.senderDidId) return conflict("a notification is sent from the decision's successor");
  if (channel !== null && channel.peerDid !== rotation.peerDid) return conflict("a notification is sent to the decision's peer");
  const status = inputs.continuity.status(resolved.event.eventId);
  if (status.status === "invalid" || status.status === "conflict") return conflict(`the rotation it names is ${status.status}: ${status.because}`);
  if (status.status !== "verified") missing.push(`the rotation it names is not verified yet${"because" in status ? `: ${status.because}` : ""}`);
  return null;
}

type WorkInputs = { outcome: Outcome; waiting: string | null; sender: LocalDidEntity | null; channel: Channel | null; erased: boolean; effect: EffectStatus; package: Package | null; unresolved: boolean; continuity: Continuity };

/** A submission naming a preparation not here is no absence of a preparation: nothing is prepared while it may still arrive. */
function workOf(w: WorkInputs): Work {
  const none = (because: string): Work => ({ kind: "none", because });
  if (w.outcome.status === "conflict") return none(w.outcome.because);
  if (w.outcome.status === "submitted") return none("submitted");
  if (w.outcome.status === "terminal") return none(`terminated: ${w.outcome.code}`);
  if (w.erased) return none("erased");
  if (w.waiting !== null || w.channel === null) return none(w.waiting ?? "the sender's channel is not known");
  if (!w.sender!.live) return none(`the sender is not live: ${w.sender!.faults[0] ?? `retired: ${w.sender!.retired}`}`);
  if (w.continuity.blocked(w.channel).length > 0) return none("the channel is blocked");
  if (w.continuity.conflicted(w.channel)) return none("the channel's continuity is in conflict");
  if (w.effect.status !== "complete") return none(w.effect.because);
  if (w.package === null) return w.unresolved ? none("a submission names a package that is not here") : { kind: "prepare" };
  if (w.package.status.status !== "complete") return none(w.package.status.because);
  if (w.package.erased) return none("the envelope is erased");
  return { kind: "dispatch", package: w.package };
}

function ackTargetsOf(sourceEventId: EventId, evidence: ChannelEvidence, continuity: Continuity, inbound: InboundFold, executionsByWire: ReadonlyMap<WireMessageId, Execution[]>): WireMessageId[] {
  const source = evidence.sources.get(sourceEventId);
  const requested = source?.event.data.pleaseAck;
  if (source === undefined || source.channel === null || requested == null || requested.length === 0) return [];
  if (continuity.witness(sourceEventId).status !== "complete") return [];
  const own = inbound.ofSource(sourceEventId);
  const targets: Execution[] = [];
  for (const wanted of new Set(requested.map((target) => (target === "" ? source.event.data.wireMessageId : target)))) {
    const target = targetOf(wanted as WireMessageId, source, own, evidence, continuity, executionsByWire);
    if (target.status === "eligible") targets.push(target.execution);
  }
  targets.sort((a, b) => compareReceiptKeys(a.firstReceiptKey!, b.firstReceiptKey!));
  return targets.map((execution) => execution.wireMessageId);
}
