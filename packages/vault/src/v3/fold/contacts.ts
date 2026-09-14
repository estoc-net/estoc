/**
 * The contacts. The decisions a contact ID holds on its own — created,
 * named, flagged, pointed at one of our DIDs, given discovery seeds,
 * grouped with another for display, deleted — are `foldContacts`. The
 * view of a contact, `foldContactViews`, adds what it holds through
 * the relationships uniquely assigned to it and nothing else: an
 * unassigned relationship, or one assigned to two contacts, gives no
 * contact a name, a message or a diagnostic. The diagnostics of each
 * relationship are `foldDiagnostics`, and `readProblemReports` reads
 * the problem reports' bodies beside the fold.
 */

import { InvalidJson, parseStrict, type EventId } from "@estoc/event-store/v3";

import { readStoredDocument } from "../document.js";
import { InvalidPlaintext } from "../errors.js";
import { didKeyName, inboundMessageId } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Cid, ContactId, ContactOrigin, Did, DidId, EventReference, ExecutionId, MessageId, RelationshipId, WireMessageId } from "../types.js";
import { erased, foldErasures, type Erasures } from "./held.js";
import { PROBLEM_REPORT, type Execution, type InboundFold } from "./inbound.js";
import type { Outbound, OutboundFold } from "./outbound.js";
import type { Profile } from "./profile.js";
import type { ReadObject, Relationship, RelationshipFold } from "./relationships.js";
import type { RouteFold } from "./routes.js";
import { compareKeys, groupBy, latest, type SourceKey, type VaultEventSet } from "./set.js";

export type PeerDidSeed = { did: Did; because: string; eventId: EventId };

export interface ContactDecisions {
  readonly contactId: ContactId;
  /** the first creation's origin in canonical order, null while none */
  readonly origin: ContactOrigin | null;
  readonly deleted: boolean;
  /** the latest petname, null while none */
  readonly petname: string | null;
  /** each flag's latest value, by flag name */
  readonly flags: ReadonlyMap<string, boolean>;
  /** the latest outbound address preference among our DID entities */
  readonly useDid: { didId: DidId; because: string } | null;
  /** every peer DID added and not removed, in canonical order of the adds */
  readonly peerDidSeeds: readonly PeerDidSeed[];
  /** the other contacts grouped with this one for display, transitively, sorted */
  readonly mergedWith: readonly ContactId[];
  /** removals whose add is not here, or is another contact's or another type's */
  readonly faults: readonly string[];
}

export function foldContacts(set: VaultEventSet): ReadonlyMap<ContactId, ContactDecisions> {
  const created = groupBy(set.of("contact.created"), (event) => event.data.contactId);
  const petnames = groupBy(set.of("contact.petname"), (event) => event.data.contactId);
  const flagged = groupBy(set.of("contact.flag"), (event) => event.data.contactId);
  const useDids = groupBy(set.of("contact.useDid"), (event) => event.data.contactId);
  const added = groupBy(set.of("contact.peerDidAdded"), (event) => event.data.contactId);
  const removed = groupBy(set.of("contact.peerDidRemoved"), (event) => event.data.contactId);
  const deleted = new Set(set.of("contact.deleted").map((event) => event.data.contactId));
  const groups = mergeGroups(set);

  const ids = new Set<ContactId>(deleted);
  for (const table of [created, petnames, flagged, useDids, added, removed]) for (const id of table.keys()) ids.add(id);
  for (const id of groups.keys()) ids.add(id);

  const contacts = new Map<ContactId, ContactDecisions>();
  for (const contactId of [...ids].sort()) {
    const faults: string[] = [];
    const removedAdds = new Set<EventId>();
    for (const removal of removed.get(contactId) ?? []) {
      const add = set.resolve(removal.data.addEventId, "contact.peerDidAdded");
      if (add.status === "missing") faults.push(`removal ${removal.eventId} names an add that is not here`);
      else if (add.status === "mismatched") faults.push(`removal ${removal.eventId} names ${add.event.type} ${add.event.eventId}, not an add`);
      else if (add.event.data.contactId !== contactId) faults.push(`removal ${removal.eventId} names contact ${add.event.data.contactId}'s add`);
      else removedAdds.add(add.event.eventId);
    }
    const flags = new Map<string, boolean>();
    for (const [flag, events] of [...groupBy(flagged.get(contactId) ?? [], (event) => event.data.flag)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      flags.set(flag, latest(events)!.data.value);
    }
    const useDid = latest(useDids.get(contactId) ?? []);
    contacts.set(contactId, {
      contactId,
      origin: created.get(contactId)?.[0]?.data.because ?? null,
      deleted: deleted.has(contactId),
      petname: latest(petnames.get(contactId) ?? [])?.data.name ?? null,
      flags,
      useDid: useDid === null ? null : { didId: useDid.data.didId, because: useDid.data.because },
      peerDidSeeds: (added.get(contactId) ?? []).filter((add) => !removedAdds.has(add.eventId)).map((add) => ({ did: add.data.did, because: add.data.because, eventId: add.eventId })),
      mergedWith: (groups.get(contactId) ?? []).filter((member) => member !== contactId),
      faults,
    });
  }
  return contacts;
}

/** The display groups `contact.merged` draws, each member listed with its whole group sorted. */
function mergeGroups(set: VaultEventSet): Map<ContactId, ContactId[]> {
  const parent = new Map<ContactId, ContactId>();
  const find = (id: ContactId): ContactId => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const event of set.of("contact.merged")) {
    const { contactId, fromContactId } = event.data;
    for (const id of [contactId, fromContactId]) if (!parent.has(id)) parent.set(id, id);
    const [a, b] = [find(contactId), find(fromContactId)];
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const members = new Map<ContactId, ContactId[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = members.get(root);
    if (group === undefined) members.set(root, [id]);
    else group.push(id);
  }
  const groups = new Map<ContactId, ContactId[]>();
  for (const group of members.values()) {
    group.sort();
    for (const id of group) groups.set(id, group);
  }
  return groups;
}

export type RelationshipStanding = "stands" | "pending" | "conflict";

export interface AssignedRelationship {
  readonly relationshipId: RelationshipId;
  /** standing on validated chains; pending while the binding is not here or not yet verified; in conflict when it contradicts */
  readonly standing: RelationshipStanding;
  readonly currentLocalDidId: DidId | null;
  readonly currentPeerDid: Did | null;
}

export interface ThreadEntry {
  readonly executionId: ExecutionId;
  readonly relationshipId: RelationshipId;
  readonly wireMessageId: WireMessageId;
  readonly msgType: string;
  readonly thid: string | null;
  readonly pthid: string | null;
  /** the earliest observation: the message's position */
  readonly sourceKey: SourceKey;
  readonly eventIds: readonly EventId[];
}

export type Diagnostic =
  | {
      readonly kind: "peer-key-changed";
      readonly relationshipId: RelationshipId;
      readonly eventId: EventId;
      readonly resolutionEventId: EventReference<"peer.resolved">;
      readonly did: Did;
    }
  | {
      readonly kind: "remote-error";
      readonly relationshipId: RelationshipId;
      readonly executionId: ExecutionId;
      /** the one outbound of the relationship with a package history whose thread the report's parent thread names, a package of it a verified member of the chains */
      readonly messageId: MessageId;
      readonly code: string;
      readonly comment: string | null;
      /** the report's earliest observation: what orders reports */
      readonly sourceKey: SourceKey;
    };

export interface ContactView extends ContactDecisions {
  /** every relationship uniquely assigned to this contact, sorted */
  readonly relationships: readonly AssignedRelationship[];
  /** the relationships assigned to this contact and to another: chosen by neither, sorted */
  readonly contested: readonly RelationshipId[];
  /** the latest name claimed across the non-contradicted assigned relationships, by source order; null while none */
  readonly claimedName: string | null;
  /** some non-contradicted assigned relationship's profile has a source lifted two names */
  readonly nameConflict: boolean;
  /** each non-contradicted assigned relationship the peer was sent our profile in, with its latest disclosure's source key, by relationship */
  readonly profileShared: readonly { readonly relationshipId: RelationshipId; readonly sourceKey: SourceKey }[];
  /** the non-retired local addresses in the validated local histories of the assigned relationships, sorted */
  readonly localDidIds: readonly DidId[];
  /** the current local ends of the assigned relationships, sorted */
  readonly currentLocalDidIds: readonly DidId[];
  /** the current peer ends of the assigned relationships, sorted */
  readonly peerDids: readonly Did[];
  /** the assigned relationships a new message may be sent in, sorted: standing, not contradicted, the contact not deleted, the current local end live and no local transition unjudged */
  readonly writeTo: readonly RelationshipId[];
  /** the relationships of `writeTo` whose current local end is the one `useDid` names */
  readonly preferred: readonly RelationshipId[];
  /** the complete application messages of the assigned relationships, by earliest observation */
  readonly thread: readonly ThreadEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

/** A problem report's validated body: the code, and the comment if one is there. */
export type ProblemReport = { readonly code: string; readonly comment: string | null };

export type ContactViewInputs = {
  routes: RouteFold;
  relationships: RelationshipFold;
  inbound: InboundFold;
  outbound: OutboundFold;
  profiles: ReadonlyMap<RelationshipId, Profile>;
};

export type ContactViewOptions = {
  /** each problem report observation's body as read from its object, by event ID; none read while absent */
  problemReports?: ReadonlyMap<EventId, ProblemReport>;
  erasures?: Erasures;
};

export function foldContactViews(set: VaultEventSet, folds: ContactViewInputs, options: ContactViewOptions = {}): ReadonlyMap<ContactId, ContactView> {
  const { routes, relationships, inbound, outbound, profiles } = folds;
  const decisions = foldContacts(set);
  const diagnostics = foldDiagnostics(set, relationships, inbound, outbound, { problemReports: options.problemReports ?? new Map(), erasures: options.erasures ?? foldErasures(set) });
  const assignedTo = new Map<ContactId, Set<RelationshipId>>();
  for (const event of set.of("relationship.contactAssigned")) {
    const ids = assignedTo.get(event.data.contactId);
    if (ids === undefined) assignedTo.set(event.data.contactId, new Set([event.data.relationshipId]));
    else ids.add(event.data.relationshipId);
  }
  const threads = new Map<RelationshipId, ThreadEntry[]>();
  for (const execution of inbound.executions.values()) {
    if (execution.status !== "complete" || execution.kind !== "application") continue;
    const entry: ThreadEntry = { executionId: execution.executionId, relationshipId: execution.relationshipId, wireMessageId: execution.wireMessageId, msgType: execution.intent!.msgType, thid: execution.intent!.thid, pthid: execution.intent!.pthid, sourceKey: execution.sourceKey!, eventIds: execution.eventIds };
    const list = threads.get(execution.relationshipId);
    if (list === undefined) threads.set(execution.relationshipId, [entry]);
    else list.push(entry);
  }
  const unjudged = new Set<RelationshipId>();
  for (const edge of set.of("relationship.localTransitioned")) if (relationships.transitions.get(edge.eventId)?.status === "deferred") unjudged.add(edge.data.relationshipId);

  const views = new Map<ContactId, ContactView>();
  for (const contactId of [...new Set([...decisions.keys(), ...assignedTo.keys()])].sort()) {
    const own = decisions.get(contactId) ?? emptyDecisions(contactId);
    const assigned: Relationship[] = [];
    const contested: RelationshipId[] = [];
    for (const relationshipId of [...(assignedTo.get(contactId) ?? [])].sort()) {
      const relationship = relationships.relationships.get(relationshipId)!;
      if (relationship.contactId === contactId) assigned.push(relationship);
      else contested.push(relationshipId);
    }
    const claims = assigned.flatMap((relationship) => (relationship.conflict ? [] : (profiles.get(relationship.relationshipId)?.claims ?? []).filter((claim) => !claim.conflict)));
    const named = claims.sort((a, b) => compareKeys(a.sourceKey, b.sourceKey)).at(-1);
    const writeTo = assigned
      .filter((relationship) => !own.deleted && !relationship.conflict && relationship.localChain.length > 0 && !unjudged.has(relationship.relationshipId) && routes.dids.get(relationship.currentLocalDidId!)?.live === true)
      .map((relationship) => relationship.relationshipId);
    views.set(contactId, {
      ...own,
      relationships: assigned.map((relationship) => ({ relationshipId: relationship.relationshipId, standing: standingOf(relationship), currentLocalDidId: relationship.currentLocalDidId, currentPeerDid: relationship.currentPeerDid })),
      contested,
      claimedName: named?.names[0] ?? null,
      nameConflict: assigned.some((relationship) => !relationship.conflict && profiles.get(relationship.relationshipId)?.nameConflict === true),
      profileShared: assigned.flatMap((relationship) => {
        const shared = relationship.conflict ? null : (profiles.get(relationship.relationshipId)?.shared ?? null);
        return shared === null ? [] : [{ relationshipId: relationship.relationshipId, sourceKey: shared }];
      }),
      localDidIds: sorted(assigned.flatMap((relationship) => relationship.localChain.map((node) => node.didId).filter((didId) => routes.dids.get(didId)?.retired === null))),
      currentLocalDidIds: sorted(assigned.flatMap((relationship) => (relationship.currentLocalDidId === null ? [] : [relationship.currentLocalDidId]))),
      peerDids: sorted(assigned.flatMap((relationship) => (relationship.currentPeerDid === null ? [] : [relationship.currentPeerDid]))),
      writeTo,
      preferred: own.useDid === null ? [] : writeTo.filter((relationshipId) => relationships.relationships.get(relationshipId)!.currentLocalDidId === own.useDid!.didId),
      thread: assigned.flatMap((relationship) => threads.get(relationship.relationshipId) ?? []).sort((a, b) => compareKeys(a.sourceKey, b.sourceKey)),
      diagnostics: assigned.flatMap((relationship) => diagnostics.get(relationship.relationshipId) ?? []),
    });
  }
  return views;
}

const emptyDecisions = (contactId: ContactId): ContactDecisions => ({ contactId, origin: null, deleted: false, petname: null, flags: new Map(), useDid: null, peerDidSeeds: [], mergedWith: [], faults: [] });

const sorted = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

function standingOf(relationship: Relationship): RelationshipStanding {
  if (relationship.conflict) return "conflict";
  return relationship.localChain.length > 0 ? "stands" : "pending";
}

/**
 * The diagnostics of each relationship, in canonical order of the
 * observation each is read from: the same-DID key changes and the
 * remote errors. A key change is named only at an address pair the
 * relationship alone claims, since a pair two relationships claim
 * identifies neither; whether the snapshot has been checked against
 * its document does not hold it back, as it names the change rather
 * than waiting on more evidence. A remote error is shown beside the
 * one outbound its parent thread names among those with a package
 * history, when that one is compatible; a candidate that is
 * contradicted stays a candidate, since dropping it could make another
 * one unique.
 */
export function foldDiagnostics(set: VaultEventSet, relationships: RelationshipFold, inbound: InboundFold, outbound: OutboundFold, options: { problemReports: ReadonlyMap<EventId, ProblemReport>; erasures: Erasures }): ReadonlyMap<RelationshipId, readonly Diagnostic[]> {
  const receipts = new Map(set.of("message.in").map((receipt) => [receipt.eventId, receipt]));
  const drafts = new Map<RelationshipId, { diagnostic: Diagnostic; sourceKey: SourceKey }[]>();
  const add = (relationshipId: RelationshipId, diagnostic: Diagnostic, sourceKey: SourceKey) => {
    const list = drafts.get(relationshipId);
    if (list === undefined) drafts.set(relationshipId, [{ diagnostic, sourceKey }]);
    else list.push({ diagnostic, sourceKey });
  };

  for (const receipt of receipts.values()) {
    const { peerResolutionEventId, relationshipBindingEventId, fromPrior, localKeyName, did, presentedDid, messageId, wireMessageId } = receipt.data;
    if (peerResolutionEventId === null || relationshipBindingEventId === null || fromPrior !== null) continue;
    const binding = set.resolve(relationshipBindingEventId, "relationship.bound");
    if (binding.status !== "present") continue;
    const relationship = relationships.relationships.get(binding.event.data.relationshipId);
    if (relationship === undefined || did === null || relationship.currentPeerDid !== did) continue;
    const local = relationship.localChain.find((node) => didKeyName(node.didId, "key-agreement") === localKeyName || didKeyName(node.didId, "authentication") === localKeyName);
    if (local === undefined) continue;
    const claimants = relationships.claimants(local.did, did);
    if (claimants.length !== 1 || claimants[0] !== relationship.relationshipId) continue;
    const resolved = set.resolve(peerResolutionEventId, "peer.resolved");
    if (resolved.status !== "present") continue;
    const resolution = resolved.event.data;
    if (resolution.did !== did || resolution.presentedDid !== presentedDid || resolution.localKeyName !== localKeyName || inboundMessageId(resolution.peerPublicKey, wireMessageId) !== messageId) continue;
    if (relationship.peerChain.some((node) => node.did === did && node.documentCid === resolution.documentCid)) continue;
    add(relationship.relationshipId, { kind: "peer-key-changed", relationshipId: relationship.relationshipId, eventId: receipt.eventId, resolutionEventId: peerResolutionEventId, did }, { at: receipt.at, eventId: receipt.eventId, author: receipt.author });
  }

  const targets = reportTargets(set, outbound);
  for (const execution of inbound.executions.values()) {
    if (execution.kind !== "error") continue;
    const report = reportOf(execution, receipts, options);
    if (report === null) continue;
    const named = targets.get(execution.relationshipId)?.get(execution.intent!.pthid!);
    if (named === undefined || named.size !== 1) continue;
    const [target] = named.values();
    if (target!.standing !== "compatible") continue;
    add(execution.relationshipId, { kind: "remote-error", relationshipId: execution.relationshipId, executionId: execution.executionId, messageId: target!.messageId, code: report.code, comment: report.comment, sourceKey: execution.sourceKey! }, execution.sourceKey!);
  }

  const diagnostics = new Map<RelationshipId, readonly Diagnostic[]>();
  for (const [relationshipId, list] of [...drafts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    diagnostics.set(relationshipId, list.sort((a, b) => compareKeys(a.sourceKey, b.sourceKey)).map((entry) => entry.diagnostic));
  }
  return diagnostics;
}

/**
 * An outbound a report may name, by relationship and by the thread
 * each of its intent events names — its `thid`, or its own message ID
 * — whenever a package was prepared for it, consistent or not.
 */
type ReportTarget = { readonly messageId: MessageId; readonly standing: "compatible" | "waiting" | "contradicted" };

function reportTargets(set: VaultEventSet, outbound: OutboundFold): ReadonlyMap<RelationshipId, ReadonlyMap<string, ReadonlyMap<MessageId, ReportTarget>>> {
  const prepared = groupBy(set.of("message.prepared"), (event) => event.data.messageId);
  const targets = new Map<RelationshipId, Map<string, Map<MessageId, ReportTarget>>>();
  for (const event of set.of("message.out")) {
    const { relationshipId, thid, messageId } = event.data;
    const history = prepared.get(messageId);
    if (history === undefined) continue;
    let threads = targets.get(relationshipId);
    if (threads === undefined) targets.set(relationshipId, (threads = new Map()));
    const key = thid ?? messageId;
    let named = threads.get(key);
    if (named === undefined) threads.set(key, (named = new Map()));
    named.set(messageId, { messageId, standing: targetStanding(outbound.outbounds.get(messageId)!, history) });
  }
  return targets;
}

/**
 * Compatible when the message's own standing is verified and some
 * package is a verified member of the relationship's chains — sent from
 * a node of the local chain to a document the peer chain pins — the
 * chains being what connect the package's recipient to the report's
 * authenticated sender across any rotation between them. A package
 * recorded with two contents, prepared for two messages, carrying
 * another intent or outside the chains contradicts the whole
 * candidate; short of that, what is still waiting waits, and another
 * package's wait takes nothing from a verified one, just as it takes
 * nothing from a submission.
 */
function targetStanding(message: Outbound, history: readonly VaultEvent<"message.prepared">[]): ReportTarget["standing"] {
  const memberships = [...message.packages.values()].map((pkg) => pkg.membership.status);
  if (message.standing.status === "conflict" || memberships.includes("conflict")) return "contradicted";
  if (history.some((event) => !message.packages.has(event.data.packageId))) return "contradicted";
  if (message.standing.status === "deferred") return "waiting";
  return memberships.includes("verified") ? "compatible" : "waiting";
}

/** The report's body from its first observation with one read, unless the body of any observation of it is erased. */
function reportOf(execution: Execution, receipts: ReadonlyMap<EventId, VaultEvent<"message.in">>, options: { problemReports: ReadonlyMap<EventId, ProblemReport>; erasures: Erasures }): ProblemReport | null {
  let report: ProblemReport | null = null;
  for (const eventId of execution.eventIds) {
    const receipt = receipts.get(eventId)!;
    if (erased(options.erasures, receipt.data.messageId, receipt.data.bodyCid)) return null;
    report ??= options.problemReports.get(eventId) ?? null;
  }
  return report;
}

/**
 * A problem code as the Report Problem 2.0 protocol spells it: a
 * sorter, `e` or `w`, a scope, `p`, `m` or a state name, and
 * descriptors, each token lower kebab-case and the tokens joined by
 * dots. A code with no descriptor is read, since the protocol only
 * asks senders to include one, and a sorter and scope alone still say
 * what failed and what it resets; descriptors beyond the protocol's
 * own list are read, since that list is open.
 */
const PROBLEM_CODE = /^[ew](?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

/** The body of every problem report observation whose object reads as a stored document with a well-formed `code` and, if a comment, a string one; any other supplies no report. */
export async function readProblemReports(set: VaultEventSet, readObject: ReadObject): Promise<Map<EventId, ProblemReport>> {
  const reports = new Map<EventId, ProblemReport>();
  const read = new Map<Cid, ProblemReport | null>();
  for (const receipt of set.of("message.in")) {
    if (receipt.data.msgType !== PROBLEM_REPORT) continue;
    const { bodyCid } = receipt.data;
    let report = read.get(bodyCid);
    if (report === undefined) {
      const bytes = await readObject(bodyCid);
      report = bytes === null ? null : problemReportOf(bytes);
      read.set(bodyCid, report);
    }
    if (report !== null) reports.set(receipt.eventId, report);
  }
  return reports;
}

function problemReportOf(bytes: Uint8Array): ProblemReport | null {
  try {
    const { body } = readStoredDocument(parseStrict(bytes));
    if (typeof body.code !== "string" || !PROBLEM_CODE.test(body.code)) return null;
    const comment = body.comment;
    if (comment !== undefined && typeof comment !== "string") return null;
    return { code: body.code, comment: comment ?? null };
  } catch (err) {
    if (err instanceof InvalidJson || err instanceof InvalidPlaintext) return null;
    throw err;
  }
}
