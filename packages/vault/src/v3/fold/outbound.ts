/**
 * The outbound messages: each an intent frozen under one message ID,
 * the packages prepared for it, what became of each — retired, failed,
 * submitted — and the receipts the peer's acknowledgments evidence.
 * Each fact is read from the evidence it needs and no more. Submission
 * is one committed acceptance of a package that belongs to a message
 * that stands in its relationship, and closes the message for good: a
 * record of acceptance releases nothing until the package it names is
 * known to belong, and once it is, what another package still waits
 * for, or a conflict of the execution found later, takes nothing back.
 * A terminal failure closes the message too. An acknowledgment is a
 * complete, scoped observation whose explicit `ack` names the message,
 * applied only once the message's whole membership is verified —
 * birth, binding and every package agreeing on the one relationship,
 * each package sent from a node of the local chain to a document of
 * the peer chain. What contradicts is a conflict that stops every
 * automatic step; what is not here yet defers them. The acknowledgment
 * records are judged by the same witness rule and kept apart: they
 * change no work, outcome or retention. The fold reads no clock, so
 * expiry is the worker's to compare against `expiresTime`, and a
 * committed expired failure is what ends the message.
 */

import { canonicalText, compareEvents } from "@estoc/event-store/v3";

import { InvalidDidDocument, InvalidIdentifier } from "../errors.js";
import { executionId as executionIdOf, relationshipId as relationshipIdOf } from "../ids.js";
import { canonicalDidOf } from "../peer-document.js";
import type { VaultEvent } from "../schema.js";
import type { ContactId, Did, EventId, EventReference, ExecutionId, KeyName, MessageId, MessageOut, PackageId, RelationshipId, VaultData } from "../types.js";
import type { Erasures } from "./held.js";
import type { InboundFold } from "./inbound.js";
import type { EvidenceCheck, LocalNode, Relationship, RelationshipFold } from "./relationships.js";
import type { RouteFold } from "./routes.js";
import { groupBy, type VaultEventSet } from "./set.js";

/** Whether evidence belongs to the relationship it claims: verified, still waiting for what it names, or contradicting it. */
export type Membership = { readonly status: "verified" } | { readonly status: "deferred"; readonly because: string } | { readonly status: "conflict"; readonly because: string };

export interface Package {
  readonly packageId: PackageId;
  readonly data: VaultData["message.prepared"];
  /** every prepared event recording this package, in canonical order */
  readonly eventIds: readonly EventReference<"message.prepared">[];
  /** the reason of the first retirement in canonical order, null while not retired */
  readonly retired: string | null;
  /** the code of the first package-scoped terminal failure in canonical order, null while none */
  readonly failed: string | null;
  /** a committed submission names this package */
  readonly submitted: boolean;
  /** neither retired nor failed: still a candidate for submission while the message is open */
  readonly active: boolean;
  /** sent from a node of the local chain to a document of the peer chain, carrying the proof of the transition that added the sender, if any */
  readonly membership: Membership;
}

/** The displayed submission outcome, in order of precedence. */
export type Outcome = "conflict" | "submitted" | "failed" | "prepared" | "queued";

/**
 * What the active runtime may do next for the message, from the
 * events alone: prepare a first or replacement package, submit one of
 * the packages named (in canonical order), retire the packages named
 * and prepare from the current local end, or nothing, and why. An
 * erased message has no work, whatever bytes another event still
 * keeps: nothing rebuilds content the user released, nothing sends an
 * envelope of it. A deleted contact's message has none either, since
 * the tombstone ends every interaction with it. Work waits while a
 * local transition of the relationship is still unjudged, since it
 * may move the current end; a package from a successor no input has
 * yet confirmed is submittable only with the transition's proof. The
 * worker still compares the clock with `expiresTime` and checks that
 * the envelope bytes are here.
 */
export type Work =
  | { readonly kind: "none"; readonly because: string }
  | { readonly kind: "prepare" }
  | { readonly kind: "submit"; readonly packageIds: readonly PackageId[] }
  | { readonly kind: "repack"; readonly packageIds: readonly PackageId[] };

export interface Outbound {
  readonly messageId: MessageId;
  /** the one intent, null while the intent events disagree */
  readonly intent: MessageOut | null;
  /** every intent event under this ID, in canonical order */
  readonly intentEventIds: readonly EventReference<"message.out">[];
  /** every consistent package by ID; a package recorded with two contents, prepared for two messages or carrying another intent is a fault, not a package */
  readonly packages: ReadonlyMap<PackageId, Package>;
  /** a committed submission names a package that belongs, of a message that stands: closed to further preparation and submission, its envelopes released; what another package waits for, and a conflict of the execution, take nothing back */
  readonly submitted: boolean;
  /** the code of the first message-scoped terminal failure in canonical order, null while none */
  readonly failed: string | null;
  /** the message's own standing: one intent, its birth and binding agreeing and its relationship standing, apart from its packages and its carrier; what a submission completes under */
  readonly standing: Membership;
  /** the message's whole membership: intent, birth, binding, every package and, for an automatic message, its execution agreeing; what an acknowledgment is applied under */
  readonly membership: Membership;
  /** the complete, scoped observations whose explicit `ack` names this message, in canonical order */
  readonly ackWitnesses: readonly EventId[];
  readonly acknowledged: boolean;
  /** the earliest `at` among the witnesses, null while not acknowledged */
  readonly receiptInstant: string | null;
  /** acknowledged at or after `expiresTime` */
  readonly late: boolean;
  readonly outcome: Outcome;
  readonly work: Work;
  readonly deferred: readonly string[];
  readonly faults: readonly string[];
  readonly conflict: boolean;
  /** what the acknowledgment records, and the acknowledging observations that may yet witness, still wait for: receipt information only */
  readonly ackDeferred: readonly string[];
  /** an acknowledgment record no observation witnesses: receipt information only */
  readonly ackFaults: readonly string[];
}

export interface OutboundFold {
  readonly outbounds: ReadonlyMap<MessageId, Outbound>;
  /** the ACK-bearing response each execution selected, sorted: one message ID, or several in conflict */
  readonly responses: ReadonlyMap<ExecutionId, readonly MessageId[]>;
  /** package, delivery and retirement events under a message ID with no intent here, by message ID: held, never worked */
  readonly orphans: ReadonlyMap<MessageId, readonly EventId[]>;
}

export type OutboundFoldOptions = {
  /** each `peer.resolved` event's snapshot against its document, by event ID */
  resolutionChecks?: ReadonlyMap<EventId, EvidenceCheck>;
  /** the roots each message's erasures released; none when left out */
  erasures?: Erasures;
};

type Receipt = VaultEvent<"message.in">;
type Prepared = VaultEvent<"message.prepared">;
type Verdict = { faults: string[]; deferred: string[] };

type Context = {
  set: VaultEventSet;
  routes: RouteFold;
  relationships: RelationshipFold;
  resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>;
  packageOwners: ReadonlyMap<PackageId, ReadonlySet<MessageId>>;
  ackers: ReadonlyMap<string, Receipt[]>;
  responses: ReadonlyMap<ExecutionId, readonly MessageId[]>;
  inbound: InboundFold;
  localEdges: ReadonlyMap<RelationshipId, VaultEvent<"relationship.localTransitioned">[]>;
  peerEdges: ReadonlyMap<RelationshipId, VaultEvent<"relationship.peerTransitioned">[]>;
  /** the keys scoped input in each relationship arrived at, in a group that does not contradict: what confirms a local address */
  confirmedKeys: ReadonlyMap<RelationshipId, ReadonlySet<KeyName>>;
  erasures: Erasures;
  deletedContacts: ReadonlySet<ContactId>;
};

const NO_CHECKS: ReadonlyMap<EventId, EvidenceCheck> = new Map();

export function foldOutbound(set: VaultEventSet, routes: RouteFold, relationships: RelationshipFold, inbound: InboundFold, options: OutboundFoldOptions = {}): OutboundFold {
  const intents = groupBy(set.of("message.out"), (event) => event.data.messageId);
  const prepared = groupBy(set.of("message.prepared"), (event) => event.data.messageId);
  const retirements = groupBy(set.of("message.packageRetired"), (event) => event.data.messageId);
  const submissions = groupBy(set.of("delivery.submitted"), (event) => event.data.messageId);
  const failures = groupBy(set.of("delivery.failed"), (event) => event.data.messageId);
  const acknowledgments = groupBy(set.of("delivery.acknowledged"), (event) => event.data.messageId);

  const packageOwners = new Map<PackageId, Set<MessageId>>();
  for (const event of set.of("message.prepared")) {
    const owners = packageOwners.get(event.data.packageId);
    if (owners === undefined) packageOwners.set(event.data.packageId, new Set([event.data.messageId]));
    else owners.add(event.data.messageId);
  }
  const ackers = new Map<string, Receipt[]>();
  for (const receipt of set.of("message.in")) {
    for (const target of new Set(receipt.data.ack)) {
      const list = ackers.get(target);
      if (list === undefined) ackers.set(target, [receipt]);
      else list.push(receipt);
    }
  }
  const selected = new Map<ExecutionId, Set<MessageId>>();
  for (const event of set.of("message.out")) {
    const { executionId, ack, messageId } = event.data;
    if (executionId === null || ack.length === 0) continue;
    const ids = selected.get(executionId);
    if (ids === undefined) selected.set(executionId, new Set([messageId]));
    else ids.add(messageId);
  }
  const responses = new Map<ExecutionId, readonly MessageId[]>([...selected].map(([executionId, ids]) => [executionId, [...ids].sort()]));
  const confirmedKeys = new Map<RelationshipId, Set<KeyName>>();
  for (const receipt of set.of("message.in")) {
    const scope = relationships.observations.get(receipt.eventId);
    if (scope === undefined || scope.status !== "scoped" || relationships.groups.get(receipt.data.messageId)?.status === "conflict") continue;
    const keys = confirmedKeys.get(scope.relationshipId);
    if (keys === undefined) confirmedKeys.set(scope.relationshipId, new Set([receipt.data.localKeyName]));
    else keys.add(receipt.data.localKeyName);
  }

  const context: Context = {
    set,
    routes,
    relationships,
    resolutionChecks: options.resolutionChecks ?? NO_CHECKS,
    packageOwners,
    ackers,
    responses,
    inbound,
    localEdges: groupBy(set.of("relationship.localTransitioned"), (event) => event.data.relationshipId),
    peerEdges: groupBy(set.of("relationship.peerTransitioned"), (event) => event.data.relationshipId),
    confirmedKeys,
    erasures: options.erasures ?? new Map(),
    deletedContacts: new Set(set.of("contact.deleted").map((event) => event.data.contactId)),
  };

  const outbounds = new Map<MessageId, Outbound>();
  for (const messageId of [...intents.keys()].sort()) {
    outbounds.set(messageId, foldOne(messageId, intents.get(messageId)!, { prepared: prepared.get(messageId) ?? [], retirements: retirements.get(messageId) ?? [], submissions: submissions.get(messageId) ?? [], failures: failures.get(messageId) ?? [], acknowledgments: acknowledgments.get(messageId) ?? [] }, context));
  }
  const orphans = new Map<MessageId, readonly EventId[]>();
  for (const group of [prepared, retirements, submissions, failures, acknowledgments]) {
    for (const [messageId, events] of group) {
      if (intents.has(messageId)) continue;
      orphans.set(messageId, [...(orphans.get(messageId) ?? []), ...events.map((event) => event.eventId)]);
    }
  }
  for (const [messageId, eventIds] of orphans) orphans.set(messageId, [...eventIds].sort());
  return { outbounds, responses, orphans: new Map([...orphans].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

type MessageEvents = {
  prepared: readonly Prepared[];
  retirements: readonly VaultEvent<"message.packageRetired">[];
  submissions: readonly VaultEvent<"delivery.submitted">[];
  failures: readonly VaultEvent<"delivery.failed">[];
  acknowledgments: readonly VaultEvent<"delivery.acknowledged">[];
};

type PackageDraft = { packageId: PackageId; data: VaultData["message.prepared"]; eventIds: EventReference<"message.prepared">[]; retired: string | null; failed: string | null; submitted: boolean };

function foldOne(messageId: MessageId, intentEvents: readonly VaultEvent<"message.out">[], events: MessageEvents, context: Context): Outbound {
  const faults: string[] = [];
  const deferred: string[] = [];
  const variants = new Set(intentEvents.map((event) => canonicalText(event.data)));
  const intent = variants.size === 1 ? intentEvents[0]!.data : null;

  const drafts = new Map<PackageId, PackageDraft>();
  const disputed = new Set<PackageId>();
  for (const [packageId, recorded] of groupBy(events.prepared, (event) => event.data.packageId)) {
    const contents = new Set(recorded.map((event) => canonicalText(event.data)));
    const owners = context.packageOwners.get(packageId)!;
    if (contents.size > 1) faults.push(`package ${packageId} is recorded with ${contents.size} contents`);
    else if (owners.size > 1) faults.push(`package ${packageId} is also prepared for ${[...owners].filter((owner) => owner !== messageId).join(", ")}`);
    else if (intent !== null && recorded[0]!.data.intentHash !== intent.intentHash) faults.push(`package ${packageId} carries another intent`);
    else {
      drafts.set(packageId, { packageId, data: recorded[0]!.data, eventIds: recorded.map((event) => event.eventId as EventReference<"message.prepared">), retired: null, failed: null, submitted: false });
      continue;
    }
    disputed.add(packageId);
  }
  const packageNamed = (packageId: PackageId, what: string): PackageDraft | null => {
    const draft = drafts.get(packageId);
    if (draft !== undefined) return draft;
    if (disputed.has(packageId)) faults.push(`${what} names the disputed package ${packageId}`);
    else deferred.push(`${what} names package ${packageId}, which is not here`);
    return null;
  };
  for (const event of events.retirements) {
    const draft = packageNamed(event.data.packageId, "a retirement");
    if (draft !== null) draft.retired ??= event.data.because;
  }
  let failed: string | null = null;
  for (const event of events.failures) {
    if (event.data.scope === "message") {
      failed ??= event.data.code;
      continue;
    }
    const draft = packageNamed(event.data.packageId!, "a package failure");
    if (draft !== null) draft.failed ??= event.data.code;
  }
  for (const event of events.submissions) {
    const draft = packageNamed(event.data.packageId, "a submission");
    if (draft !== null) draft.submitted = true;
  }

  const relationship = intent === null ? undefined : context.relationships.relationships.get(intent.relationshipId);
  const { packages, standing } = judgeMembership(intent, variants.size, relationship, drafts, context, faults, deferred);
  const submitted = standing.status === "verified" && [...packages.values()].some((pkg) => pkg.submitted && pkg.membership.status === "verified");
  if (intent !== null && intent.executionId !== null) {
    if (intent.ack.length > 0) {
      const others = (context.responses.get(intent.executionId) ?? []).filter((id) => id !== messageId);
      if (others.length > 0) faults.push(`execution ${intent.executionId} selected another ACK-bearing response: ${others.join(", ")}`);
    }
    judgeCarrier(intent, context, faults, deferred);
  }
  const membership: Membership = faults.length > 0 ? { status: "conflict", because: faults.join("; ") } : deferred.length > 0 ? { status: "deferred", because: deferred.join("; ") } : { status: "verified" };

  const ackFaults: string[] = [];
  const ackDeferred: string[] = [];
  for (const event of events.acknowledgments) {
    if (intent === null) {
      ackFaults.push(`acknowledgment ${event.eventId} names no witness: the intent events disagree`);
      continue;
    }
    const witness = recordWitness(context, messageId, intent.relationshipId, membership, event.data);
    if (witness.status === "none") ackFaults.push(`acknowledgment ${event.eventId} names no witness: ${witness.because}`);
    else if (witness.status === "incomplete") ackDeferred.push(`acknowledgment ${event.eventId} awaits its witness: ${witness.because}`);
  }
  const ackWitnesses: Receipt[] = [];
  if (intent !== null) {
    for (const receipt of [...(context.ackers.get(messageId) ?? [])].sort(compareEvents)) {
      const witness = witnessOf(context, receipt, intent.relationshipId, membership);
      if (witness.status === "complete") ackWitnesses.push(receipt);
      else if (witness.status === "incomplete") ackDeferred.push(`acknowledging observation ${receipt.eventId} is not yet a witness: ${witness.because}`);
    }
  }
  const acknowledged = ackWitnesses.length > 0;
  const receiptInstant = acknowledged ? ackWitnesses[0]!.at : null;
  const late = acknowledged && intent !== null && intent.expiresTime !== null && Date.parse(receiptInstant!) >= intent.expiresTime * 1000;

  const conflict = faults.length > 0;
  const outcome: Outcome = conflict ? "conflict" : submitted ? "submitted" : failed !== null ? "failed" : packages.size > 0 ? "prepared" : "queued";
  const work = workOf(intent, relationship, packages, submitted, failed, deferred, conflict, context);
  return {
    messageId,
    intent,
    intentEventIds: intentEvents.map((event) => event.eventId as EventReference<"message.out">),
    packages,
    submitted,
    failed,
    standing,
    membership,
    ackWitnesses: ackWitnesses.map((receipt) => receipt.eventId),
    acknowledged,
    receiptInstant,
    late,
    outcome,
    work,
    deferred,
    faults,
    conflict,
    ackDeferred,
    ackFaults,
  };
}

type Witness = { readonly status: "complete" } | { readonly status: "incomplete" | "none"; readonly because: string };

/**
 * Whether an observation acknowledges the message: its own row scoped
 * in the relationship, its group complete there, the execution its
 * wire ID derives there free of conflict and the message's whole
 * membership verified. Any of the four contradicting is final whatever
 * the others still wait for, since more evidence undoes no
 * contradiction; only short of one does what is missing defer.
 */
function witnessOf(context: Context, receipt: Receipt, relationshipId: RelationshipId, membership: Membership): Witness {
  const { messageId, wireMessageId } = receipt.data;
  const group = context.relationships.groups.get(messageId);
  const scope = context.relationships.observations.get(receipt.eventId);
  const execution = context.inbound.executions.get(executionIdOf(relationshipId, wireMessageId));
  if (membership.status === "conflict") return { status: "none", because: "the message's membership is in conflict" };
  if (group?.status === "anonymous") return { status: "none", because: `the observations of ${messageId} are anonymous` };
  if (group?.status === "conflict") return { status: "none", because: `the observations of ${messageId} are in conflict: ${group.because}` };
  if (group !== undefined && group.relationshipId !== null && group.relationshipId !== relationshipId) return { status: "none", because: `the observations of ${messageId} are scoped in ${group.relationshipId}, not ${relationshipId}` };
  if (scope?.status === "anonymous") return { status: "none", because: `observation ${receipt.eventId} is anonymous` };
  if (scope?.status === "conflict") return { status: "none", because: `observation ${receipt.eventId} is in conflict: ${scope.because}` };
  if (scope !== undefined && scope.relationshipId !== null && scope.relationshipId !== relationshipId) return { status: "none", because: `observation ${receipt.eventId} is scoped in ${scope.relationshipId}, not ${relationshipId}` };
  if (execution?.status === "conflict") return { status: "none", because: `execution ${execution.executionId} ${execution.because}` };
  if (scope === undefined) return { status: "incomplete", because: `observation ${receipt.eventId} awaits its scope` };
  if (scope.status === "deferred") return { status: "incomplete", because: `observation ${receipt.eventId} ${scope.because}` };
  if (group === undefined || group.status === "incomplete") return { status: "incomplete", because: `the observations of ${messageId} await their evidence` };
  if (membership.status === "deferred") return { status: "incomplete", because: "the message's membership awaits its evidence" };
  return { status: "complete" };
}

/**
 * Whether an observation of the acknowledged message ID witnesses the
 * acknowledgment record: the same wire ID, local key and authenticated
 * peer key, its `ack` naming the outbound, and what any acknowledging
 * observation needs. What contradicts the message or the observations
 * as a whole is final for every candidate; else one candidate still
 * waiting, for its resolution or its standing, keeps the record
 * waiting, and the record is unwitnessed once every candidate here
 * falls short. None of the message's observations being here yet is a
 * wait.
 */
function recordWitness(context: Context, messageId: MessageId, relationshipId: RelationshipId, membership: Membership, data: VaultData["delivery.acknowledged"]): Witness {
  if (membership.status === "conflict") return { status: "none", because: "the message's membership is in conflict" };
  let waiting: Witness | null = null;
  let short: Witness | null = null;
  for (const receipt of context.ackers.get(messageId) ?? []) {
    if (receipt.data.messageId !== data.ackMessageId || receipt.data.wireMessageId !== data.ackWireMessageId || receipt.data.localKeyName !== data.localKeyName) continue;
    if (receipt.data.peerResolutionEventId === null) continue;
    const witness = witnessOf(context, receipt, relationshipId, membership);
    if (witness.status === "none") {
      short ??= witness;
      continue;
    }
    const resolved = context.set.resolve(receipt.data.peerResolutionEventId, "peer.resolved");
    if (resolved.status === "missing") {
      waiting ??= { status: "incomplete", because: `observation ${receipt.eventId} awaits its resolution ${receipt.data.peerResolutionEventId}` };
      continue;
    }
    if (resolved.status !== "present" || resolved.event.data.peerPublicKey !== data.peerPublicKey) continue;
    if (witness.status === "complete") return witness;
    waiting ??= witness;
  }
  if (waiting !== null) return waiting;
  if (short !== null) return short;
  if (context.relationships.groups.has(data.ackMessageId)) return { status: "none", because: `no observation of ${data.ackMessageId} matches the record` };
  return { status: "incomplete", because: `the observations of ${data.ackMessageId} are not here` };
}

/**
 * The message's membership in the relationship it names, in two parts
 * that are read apart: the message's own standing — one intent, a
 * birth that derives the ID and agrees with the binding, a
 * relationship that stands and does not contradict — and each package
 * judged on its own. A message with a birth and no binding yet stands
 * on the birth alone; one with neither waits. Both parts are added to
 * the message's diagnostics.
 */
function judgeMembership(intent: MessageOut | null, variants: number, relationship: Relationship | undefined, drafts: ReadonlyMap<PackageId, PackageDraft>, context: Context, faults: string[], deferred: string[]): { packages: Map<PackageId, Package>; standing: Membership } {
  const own: Verdict = { faults: [], deferred: [] };
  const packages = judgeMessage(intent, variants, relationship, drafts, context, own, faults, deferred);
  faults.push(...own.faults);
  deferred.push(...own.deferred);
  const standing: Membership = own.faults.length > 0 ? { status: "conflict", because: own.faults.join("; ") } : own.deferred.length > 0 ? { status: "deferred", because: own.deferred.join("; ") } : { status: "verified" };
  return { packages, standing };
}

function judgeMessage(intent: MessageOut | null, variants: number, relationship: Relationship | undefined, drafts: ReadonlyMap<PackageId, PackageDraft>, context: Context, own: Verdict, faults: string[], deferred: string[]): Map<PackageId, Package> {
  const packages = new Map<PackageId, Package>();
  const settle = (membership: Membership) => {
    for (const draft of drafts.values()) packages.set(draft.packageId, { ...draft, active: draft.retired === null && draft.failed === null, membership });
    return packages;
  };
  if (intent === null) {
    own.faults.push(`${variants} intents disagree under one message ID`);
    return settle({ status: "conflict", because: "the intent events disagree" });
  }
  const R = intent.relationshipId;
  let birthPeer: Did | null = null;
  if (intent.birth !== null) {
    const { localDidId, peerDid } = intent.birth;
    const entity = context.routes.dids.get(localDidId);
    if (entity === undefined || entity.created === null) own.deferred.push(`the birth local DID ${localDidId} is not created`);
    else if (entity.conflict) own.faults.push(`the birth local DID ${localDidId} is in conflict`);
    else {
      try {
        birthPeer = canonicalDidOf(peerDid);
        const derived = relationshipIdOf(entity.created.did, birthPeer);
        if (derived !== R) own.faults.push(`the birth addresses derive ${derived}, not ${R}`);
      } catch (err) {
        if (!(err instanceof InvalidDidDocument || err instanceof InvalidIdentifier)) throw err;
        own.faults.push(`the birth addresses derive no relationship: ${err.message}`);
      }
    }
    if (relationship !== undefined && relationship.binding !== null) {
      if (relationship.binding.localDidId !== localDidId) own.faults.push(`the binding roots ${relationship.binding.localDidId}, not the birth local DID ${localDidId}`);
      const root = relationship.peerChain[0];
      if (root !== undefined && birthPeer !== null && root.did !== birthPeer) own.faults.push(`the binding pins ${root.did}, not the birth peer DID ${birthPeer}`);
    }
  }
  if (relationship !== undefined && relationship.conflict) own.faults.push(`relationship ${R} is in conflict: ${relationship.faults.join("; ")}`);
  if (relationship === undefined || relationship.bindingEventIds.length === 0) {
    if (intent.birth === null) own.deferred.push(`relationship ${R} has no binding`);
    else if (drafts.size > 0) own.deferred.push(`${drafts.size} package${drafts.size > 1 ? "s await" : " awaits"} the binding`);
    return settle(drafts.size === 0 ? { status: "verified" } : { status: "deferred", because: "awaits the binding" });
  }
  if (relationship.localChain.length === 0) {
    if (!relationship.conflict) own.deferred.push(`relationship ${R} does not stand: ${relationship.deferred.join("; ")}`);
    return settle(relationship.conflict ? { status: "conflict", because: `relationship ${R} is in conflict` } : { status: "deferred", because: `relationship ${R} does not stand` });
  }
  for (const draft of drafts.values()) {
    const membership = judgePackage(draft.data, relationship, context);
    if (membership.status === "conflict") faults.push(`package ${draft.packageId} ${membership.because}`);
    else if (membership.status === "deferred") deferred.push(`package ${draft.packageId} ${membership.because}`);
    packages.set(draft.packageId, { ...draft, active: draft.retired === null && draft.failed === null, membership });
  }
  return packages;
}

/**
 * One package against the chains: its sender a node of the local chain
 * — one a local edge of the relationship would add waits, any other is
 * outside — carrying exactly the proof of the transition that added the
 * node, or none for the root; its recipient resolution here, verified
 * against its document, taken at the package's key, naming the
 * recipient DID, and the exact document a node of the peer chain pins
 * for that DID — one a peer edge would add waits, any other is outside.
 */
function judgePackage(data: VaultData["message.prepared"], relationship: Relationship, context: Context): Membership {
  const faults: string[] = [];
  const deferred: string[] = [];
  const R = relationship.relationshipId;
  const sender = relationship.localChain.find((node) => node.didId === data.senderDidId);
  if (sender === undefined) {
    if ((context.localEdges.get(R) ?? []).some((edge) => edge.data.toDidId === data.senderDidId)) deferred.push(`awaits the local transition adding its sender ${data.senderDidId}`);
    else faults.push(`is sent from ${data.senderDidId}, outside the local history`);
  } else if (sender.edgeEventIds.length === 0) {
    if (data.fromPrior !== null) faults.push("carries a proof, though sent from the root");
  } else {
    const edge = context.set.resolve(sender.edgeEventIds[0]! as EventReference<"relationship.localTransitioned">, "relationship.localTransitioned");
    if (data.fromPrior !== null && (edge.status !== "present" || edge.event.data.fromPrior !== data.fromPrior)) faults.push("carries a proof that is not the transition's that added its sender");
  }
  const resolved = context.set.resolve(data.peerResolutionEventId, "peer.resolved");
  if (resolved.status === "mismatched") faults.push(`names ${resolved.event.type} as its recipient resolution`);
  else if (resolved.status === "missing") deferred.push("awaits its recipient resolution");
  else {
    const resolution = resolved.event.data;
    if (resolution.localKeyName !== data.localKeyName) faults.push("names a recipient resolution taken at another key");
    let recipient: Did | null = null;
    try {
      recipient = canonicalDidOf(data.recipientDid);
    } catch (err) {
      if (!(err instanceof InvalidDidDocument)) throw err;
      faults.push(`is addressed to no DID: ${err.message}`);
    }
    if (recipient !== null && resolution.did !== recipient) faults.push(`names a resolution of ${resolution.did}, not of its recipient ${recipient}`);
    const check = context.resolutionChecks.get(resolved.event.eventId);
    if (check === "invalid") faults.push("names a recipient resolution that is not its document's");
    else if (check === undefined) deferred.push("awaits the verification of its recipient resolution");
    const pinned = relationship.peerChain.filter((node) => node.did === resolution.did);
    if (pinned.length === 0) {
      if ((context.peerEdges.get(R) ?? []).some((edge) => edge.data.toDid === resolution.did)) deferred.push(`awaits the peer transition adding its recipient ${resolution.did}`);
      else faults.push(`is addressed to ${resolution.did}, outside the peer history`);
    } else if (!pinned.some((node) => node.documentCid === resolution.documentCid)) faults.push(`names a document of ${resolution.did} that the peer chain does not pin`);
  }
  if (faults.length > 0) return { status: "conflict", because: faults.join("; ") };
  if (deferred.length > 0) return { status: "deferred", because: deferred.join("; ") };
  return { status: "verified" };
}

/**
 * An automatic intent's carrier: the execution the intent names, read
 * from the inbound fold — scoped in the intent's own relationship,
 * else a contradiction; complete, else waiting or in conflict as the
 * execution is. When no scoped row or group derives the ID, the groups
 * of the wire ID are looked up under the intent's relationship
 * instead: a group that derives it so but is anonymous, or scoped
 * elsewhere, contradicts the intent, since the intent claims a scope
 * the carrier does not have; one whose scope is not yet known waits.
 */
function judgeCarrier(intent: MessageOut, context: Context, faults: string[], deferred: string[]): void {
  const executionId = intent.executionId!;
  const execution = context.inbound.executions.get(executionId);
  if (execution !== undefined) {
    if (execution.relationshipId !== intent.relationshipId) faults.push(`the carrier of execution ${executionId} is scoped in ${execution.relationshipId}, not ${intent.relationshipId}`);
    else if (execution.status === "conflict") faults.push(`the carrier of execution ${executionId} ${execution.because}`);
    else if (execution.status === "incomplete") deferred.push(`the carrier of execution ${executionId} ${execution.because}`);
    return;
  }
  for (const [wireMessageId, messageIds] of context.inbound.groupsByWire) {
    if (executionIdOf(intent.relationshipId, wireMessageId) !== executionId) continue;
    const group = context.relationships.groups.get(messageIds[0]!)!;
    if (group.status === "anonymous") faults.push(`the carrier of execution ${executionId} is anonymous`);
    else if (group.relationshipId !== null) faults.push(`the carrier of execution ${executionId} is scoped in ${group.relationshipId}, not ${intent.relationshipId}`);
    else if (group.status === "conflict") faults.push(`the carrier of execution ${executionId} is in conflict: ${group.because}`);
    else deferred.push(`the carrier of execution ${executionId} awaits its scope`);
    return;
  }
  deferred.push(`the carrier of execution ${executionId} is not here`);
}

function workOf(intent: MessageOut | null, relationship: Relationship | undefined, packages: ReadonlyMap<PackageId, Package>, submitted: boolean, failed: string | null, deferred: readonly string[], conflict: boolean, context: Context): Work {
  if (intent === null) return { kind: "none", because: "the intent events disagree" };
  if (conflict) return { kind: "none", because: "in conflict" };
  if (submitted) return { kind: "none", because: "submitted" };
  if (failed !== null) return { kind: "none", because: `terminal failure: ${failed}` };
  if (context.erasures.has(intent.messageId)) return { kind: "none", because: "erased" };
  const contactId = relationship?.contactId ?? null;
  if (contactId !== null && context.deletedContacts.has(contactId)) return { kind: "none", because: `the contact ${contactId} is deleted` };
  if (deferred.length > 0) return { kind: "none", because: `awaits evidence: ${deferred.join("; ")}` };
  const unjudged = (context.localEdges.get(intent.relationshipId) ?? []).filter((edge) => context.relationships.transitions.get(edge.eventId)?.status === "deferred");
  if (unjudged.length > 0) return { kind: "none", because: `awaits the local transition${unjudged.length > 1 ? "s" : ""} ${unjudged.map((edge) => edge.eventId).join(", ")}, which may move the current local end` };
  const active = [...packages.values()].filter((pkg) => pkg.active);
  const current = relationship?.currentLocalDidId ?? (relationship === undefined || relationship.bindingEventIds.length === 0 ? (intent.birth?.localDidId ?? null) : null);
  if (current === null) return { kind: "none", because: "no current local end" };
  const entity = context.routes.dids.get(current);
  if (entity === undefined || !entity.live) return { kind: "none", because: `the current local DID ${current} is not live` };
  if (active.length === 0) return { kind: "prepare" };
  const node = relationship?.localChain.find((node) => node.didId === current);
  const proofRequired = node !== undefined && needsProof(node, context.confirmedKeys.get(intent.relationshipId));
  const submittable = active.filter((pkg) => pkg.membership.status === "verified" && pkg.data.senderDidId === current && (pkg.data.fromPrior !== null || !proofRequired)).map((pkg) => pkg.packageId);
  if (submittable.length > 0) return { kind: "submit", packageIds: submittable };
  return { kind: "repack", packageIds: active.map((pkg) => pkg.packageId) };
}

/** Must a package from this node carry the rotation proof: the root has none to carry; a successor carries it until scoped input has arrived at one of its keys. */
function needsProof(node: LocalNode, confirmedKeys: ReadonlySet<KeyName> | undefined): boolean {
  return node.edgeEventIds.length > 0 && !(confirmedKeys !== undefined && (confirmedKeys.has(node.keyNames.keyAgreement) || confirmedKeys.has(node.keyNames.authentication)));
}
