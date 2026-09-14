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
import type { Did, EventId, EventReference, ExecutionId, KeyName, MessageId, MessageOut, PackageId, RelationshipId, VaultData, WireMessageId } from "../types.js";
import type { EvidenceCheck, LocalNode, ObservationGroup, Relationship, RelationshipFold } from "./relationships.js";
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
 * and prepare from the current local end, or nothing, and why. Work
 * waits while a local transition of the relationship is still
 * unjudged, since it may move the current end; a package from a
 * successor no input has yet confirmed is submittable only with the
 * transition's proof. The worker still compares the clock with
 * `expiresTime` and checks that the envelope bytes are here.
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
  /** what the acknowledgment records and the acknowledging observations still wait for: receipt information only */
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
  carriers: Carriers;
  localEdges: ReadonlyMap<RelationshipId, VaultEvent<"relationship.localTransitioned">[]>;
  peerEdges: ReadonlyMap<RelationshipId, VaultEvent<"relationship.peerTransitioned">[]>;
  /** the keys scoped input in each relationship arrived at, in a group that does not contradict: what confirms a local address */
  confirmedKeys: ReadonlyMap<RelationshipId, ReadonlySet<KeyName>>;
};

const NO_CHECKS: ReadonlyMap<EventId, EvidenceCheck> = new Map();

export function foldOutbound(set: VaultEventSet, routes: RouteFold, relationships: RelationshipFold, options: OutboundFoldOptions = {}): OutboundFold {
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
    carriers: carriersOf(set, relationships),
    localEdges: groupBy(set.of("relationship.localTransitioned"), (event) => event.data.relationshipId),
    peerEdges: groupBy(set.of("relationship.peerTransitioned"), (event) => event.data.relationshipId),
    confirmedKeys,
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
  if (variants.size > 1) faults.push(`${variants.size} intents disagree under one message ID`);

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
  const { packages, standing } = judgeMembership(intent, relationship, drafts, context, faults, deferred);
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
      ackDeferred.push(`acknowledgment ${event.eventId} awaits one intent`);
      continue;
    }
    const witness = witnessOf(context, messageId, intent.relationshipId, event.data);
    if (witness === "none") ackFaults.push(`acknowledgment ${event.eventId} names no complete witness among the observations of ${event.data.ackMessageId}`);
    else if (witness === "unknown") ackDeferred.push(`acknowledgment ${event.eventId} awaits the observations of ${event.data.ackMessageId}`);
  }
  const candidates = context.ackers.get(messageId) ?? [];
  const ackWitnesses = intent === null || membership.status !== "verified" ? [] : candidates.filter((receipt) => isWitness(context.relationships, receipt, intent.relationshipId)).sort(compareEvents);
  if (candidates.length > 0 && membership.status === "deferred") ackDeferred.push(`${candidates.length} acknowledging observation${candidates.length > 1 ? "s await" : " awaits"} the message's membership`);
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

/**
 * Does an observation of the acknowledged message ID witness the
 * acknowledgment record: the same wire ID, local key and authenticated
 * peer key, its `ack` naming the outbound, and the standing every
 * acknowledging observation must have? `unknown` while a matching
 * observation's resolution or standing is not yet known, or while none
 * of the message's observations is here; `none` when every one here
 * falls short.
 */
function witnessOf(context: Context, messageId: MessageId, relationshipId: RelationshipId, data: VaultData["delivery.acknowledged"]): "matched" | "unknown" | "none" {
  let unknown = false;
  for (const receipt of context.ackers.get(messageId) ?? []) {
    if (receipt.data.messageId !== data.ackMessageId || receipt.data.wireMessageId !== data.ackWireMessageId || receipt.data.localKeyName !== data.localKeyName) continue;
    if (receipt.data.peerResolutionEventId === null) continue;
    const resolved = context.set.resolve(receipt.data.peerResolutionEventId, "peer.resolved");
    if (resolved.status === "missing") {
      unknown = true;
      continue;
    }
    if (resolved.status !== "present" || resolved.event.data.peerPublicKey !== data.peerPublicKey) continue;
    const standing = witnessStanding(context.relationships, receipt, relationshipId);
    if (standing === "complete") return "matched";
    if (standing === "incomplete") unknown = true;
  }
  if (unknown) return "unknown";
  return context.relationships.groups.has(data.ackMessageId) ? "none" : "unknown";
}

/**
 * Where an acknowledging observation stands: complete when its own row
 * is scoped in the relationship and its group is complete there;
 * incomplete while its scope or its group still waits; none when
 * either contradicts or lies elsewhere.
 */
function witnessStanding(relationships: RelationshipFold, receipt: Receipt, relationshipId: RelationshipId): "complete" | "incomplete" | "none" {
  const scope = relationships.observations.get(receipt.eventId);
  if (scope === undefined) return "incomplete";
  if (scope.status === "deferred") return scope.relationshipId === null || scope.relationshipId === relationshipId ? "incomplete" : "none";
  if (scope.status !== "scoped" || scope.relationshipId !== relationshipId) return "none";
  const group = relationships.groups.get(receipt.data.messageId);
  if (group === undefined || group.status === "incomplete") return "incomplete";
  return group.status === "complete" && group.relationshipId === relationshipId ? "complete" : "none";
}

/** A complete observation, scoped in the relationship, in a complete group: what acknowledges. */
function isWitness(relationships: RelationshipFold, receipt: Receipt, relationshipId: RelationshipId): boolean {
  return witnessStanding(relationships, receipt, relationshipId) === "complete";
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
function judgeMembership(intent: MessageOut | null, relationship: Relationship | undefined, drafts: ReadonlyMap<PackageId, PackageDraft>, context: Context, faults: string[], deferred: string[]): { packages: Map<PackageId, Package>; standing: Membership } {
  const own: Verdict = { faults: [], deferred: [] };
  const packages = judgeMessage(intent, relationship, drafts, context, own, faults, deferred);
  faults.push(...own.faults);
  deferred.push(...own.deferred);
  const standing: Membership = own.faults.length > 0 ? { status: "conflict", because: own.faults.join("; ") } : own.deferred.length > 0 ? { status: "deferred", because: own.deferred.join("; ") } : { status: "verified" };
  return { packages, standing };
}

function judgeMessage(intent: MessageOut | null, relationship: Relationship | undefined, drafts: ReadonlyMap<PackageId, PackageDraft>, context: Context, own: Verdict, faults: string[], deferred: string[]): Map<PackageId, Package> {
  const packages = new Map<PackageId, Package>();
  const settle = (membership: Membership) => {
    for (const draft of drafts.values()) packages.set(draft.packageId, { ...draft, active: draft.retired === null && draft.failed === null, membership });
    return packages;
  };
  if (intent === null) return settle({ status: "conflict", because: "the intent events disagree" });
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

/** The observation groups by the execution ID their relationship and wire ID derive, each with the intent of every observation of it whose own row is scoped, and every group's wire ID. */
type Carriers = { byExecution: ReadonlyMap<ExecutionId, readonly Carrier[]>; wires: ReadonlyMap<MessageId, WireMessageId> };
type Carrier = { group: ObservationGroup; scopedIntents: readonly VaultData["message.in"]["intentHash"][] };

function carriersOf(set: VaultEventSet, relationships: RelationshipFold): Carriers {
  const wires = new Map<MessageId, WireMessageId>();
  const scopedIntents = new Map<MessageId, Carrier["scopedIntents"][number][]>();
  for (const receipt of set.of("message.in")) {
    wires.set(receipt.data.messageId, receipt.data.wireMessageId);
    if (relationships.observations.get(receipt.eventId)?.status !== "scoped") continue;
    const intents = scopedIntents.get(receipt.data.messageId);
    if (intents === undefined) scopedIntents.set(receipt.data.messageId, [receipt.data.intentHash]);
    else intents.push(receipt.data.intentHash);
  }
  const byExecution = new Map<ExecutionId, Carrier[]>();
  for (const [messageId, group] of relationships.groups) {
    if (group.status === "anonymous" || group.relationshipId === null) continue;
    const executionId = executionIdOf(group.relationshipId, wires.get(messageId)!);
    const carrier = { group, scopedIntents: scopedIntents.get(messageId) ?? [] };
    const list = byExecution.get(executionId);
    if (list === undefined) byExecution.set(executionId, [carrier]);
    else list.push(carrier);
  }
  return { byExecution, wires };
}

/**
 * An automatic intent's carrier: the observation groups whose
 * relationship and wire ID derive the intent's execution ID. Every
 * observation of them whose own row is scoped there proves the intent
 * it carried, and two that disagree contradict the execution — the
 * peer's prior and successor keys may each have carried the message,
 * and one execution cannot answer two intents — whatever another
 * observation of their groups later waits for or contradicts, since a
 * proven disagreement is not undone by less evidence; an observation
 * whose row is not scoped proves nothing. Short of that, one group
 * must be complete in the intent's own relationship: a carrier scoped
 * elsewhere or in conflict contradicts the intent; one still waiting,
 * or not here, defers it. When no group derives the ID from its own
 * relationship, the groups are looked up by the intent's relationship
 * instead: a group that derives it so but is anonymous, or scoped
 * elsewhere, contradicts the intent, since the intent claims a scope
 * the carrier does not have; one whose scope is not yet known waits.
 */
function judgeCarrier(intent: MessageOut, context: Context, faults: string[], deferred: string[]): void {
  const executionId = intent.executionId!;
  const carriers = context.carriers.byExecution.get(executionId) ?? [];
  if (carriers.length > 0) {
    const groups = carriers.map((carrier) => carrier.group);
    const scoped = groups[0]! as { relationshipId: RelationshipId };
    const proven = carriers.flatMap((carrier) => carrier.scopedIntents);
    if (scoped.relationshipId !== intent.relationshipId) faults.push(`the carrier of execution ${executionId} is scoped in ${scoped.relationshipId}, not ${intent.relationshipId}`);
    else if (new Set(proven).size > 1) faults.push(`the carrier of execution ${executionId} is ${proven.length} scoped observations that disagree on the intent`);
    else if (groups.some((group) => group.status === "complete")) return;
    else if (groups.some((group) => group.status === "incomplete")) deferred.push(`the carrier of execution ${executionId} awaits its evidence`);
    else faults.push(`the carrier of execution ${executionId} is in conflict: ${(groups.find((group) => group.status === "conflict") as { because: string }).because}`);
    return;
  }
  for (const [messageId, group] of context.relationships.groups) {
    if (executionIdOf(intent.relationshipId, context.carriers.wires.get(messageId)!) !== executionId) continue;
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
