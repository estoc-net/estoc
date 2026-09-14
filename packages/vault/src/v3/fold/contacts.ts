/**
 * The contacts. The decisions a contact ID holds on its own — created,
 * named, flagged, pointed at one of our DIDs, given discovery seeds,
 * grouped with another for display, deleted — are `foldContacts`. The
 * view of a contact, `foldContactViews`, adds what it holds through
 * the relationships uniquely assigned to it and nothing else: an
 * unassigned relationship, or one assigned to two contacts, gives no
 * contact a name, a message or a diagnostic. From those relationships
 * it takes the latest claimed name across them, the disclosures of our
 * profile each was sent, the local addresses still in use and the
 * current ends, which of them may be written to — standing, not
 * contradicted, with a live current local end and no local transition
 * still unjudged — and the thread: each complete application message
 * of theirs once, at its earliest observation, control input and
 * anything unresolved or in conflict left out. Two diagnostics are
 * read for each relationship, the same-DID key change (an
 * authenticated proof-free observation at one of the relationship's
 * keys, from the current peer DID under a document the peer chain
 * does not pin: preserved, never scoped, and named rather than waited
 * on) and the remote error (a no-response problem report whose parent
 * thread is exactly one outbound of the relationship, its code shown
 * while its body is here and unerased), and shown at the contact the
 * relationship is uniquely assigned to.
 */

import { InvalidJson, parseStrict, type EventId } from "@estoc/event-store/v3";

import { readStoredDocument } from "../document.js";
import { InvalidPlaintext } from "../errors.js";
import { inboundMessageId } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Cid, ContactId, ContactOrigin, Did, DidId, EventReference, ExecutionId, MessageId, RelationshipId, WireMessageId } from "../types.js";
import { erased, foldErasures, type Erasures } from "./held.js";
import { PROBLEM_REPORT, type Execution, type InboundFold } from "./inbound.js";
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
      /** the one outbound the report's parent thread names */
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
  profiles: ReadonlyMap<RelationshipId, Profile>;
};

export type ContactViewOptions = {
  /** each problem report observation's body as read from its object, by event ID; none read while absent */
  problemReports?: ReadonlyMap<EventId, ProblemReport>;
  erasures?: Erasures;
};

export function foldContactViews(set: VaultEventSet, folds: ContactViewInputs, options: ContactViewOptions = {}): ReadonlyMap<ContactId, ContactView> {
  const { routes, relationships, inbound, profiles } = folds;
  const decisions = foldContacts(set);
  const diagnostics = foldDiagnostics(set, relationships, inbound, { problemReports: options.problemReports ?? new Map(), erasures: options.erasures ?? foldErasures(set) });
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
 * remote errors. A key change is an authenticated observation without
 * a proof, bound to the relationship, arrived at one of its keys, from
 * its current peer DID under a document no node of the peer chain
 * pins; its resolution must be here and be the one that authenticated
 * it — same key, DID, spelling and message ID — since the diagnostic
 * reads the key from that evidence; whether that snapshot has been
 * checked against its document does not hold the diagnostic back,
 * which names the change rather than waiting on more evidence. A remote error is a
 * complete no-response problem report whose parent thread exactly one
 * outbound intent of the relationship opened, contradicted intents
 * counted, with a body here and unerased at every observation of it;
 * ambiguity, absence and erasure each supply none.
 */
export function foldDiagnostics(set: VaultEventSet, relationships: RelationshipFold, inbound: InboundFold, options: { problemReports: ReadonlyMap<EventId, ProblemReport>; erasures: Erasures }): ReadonlyMap<RelationshipId, readonly Diagnostic[]> {
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
    if (relationship === undefined || relationship.currentPeerDid !== did || !relationship.recipientKeyNames.has(localKeyName)) continue;
    const resolved = set.resolve(peerResolutionEventId, "peer.resolved");
    if (resolved.status !== "present") continue;
    const resolution = resolved.event.data;
    if (resolution.did !== did || resolution.presentedDid !== presentedDid || resolution.localKeyName !== localKeyName || inboundMessageId(resolution.peerPublicKey, wireMessageId) !== messageId) continue;
    if (relationship.peerChain.some((node) => node.did === did && node.documentCid === resolution.documentCid)) continue;
    add(relationship.relationshipId, { kind: "peer-key-changed", relationshipId: relationship.relationshipId, eventId: receipt.eventId, resolutionEventId: peerResolutionEventId, did }, { at: receipt.at, eventId: receipt.eventId, author: receipt.author });
  }

  const threads = new Map<RelationshipId, Map<string, Set<MessageId>>>();
  for (const event of set.of("message.out")) {
    const { relationshipId, thid, messageId } = event.data;
    let opened = threads.get(relationshipId);
    if (opened === undefined) threads.set(relationshipId, (opened = new Map()));
    const key = thid ?? messageId;
    const ids = opened.get(key);
    if (ids === undefined) opened.set(key, new Set([messageId]));
    else ids.add(messageId);
  }
  for (const execution of inbound.executions.values()) {
    if (execution.kind !== "error") continue;
    const report = reportOf(execution, receipts, options);
    if (report === null) continue;
    const opened = threads.get(execution.relationshipId)?.get(execution.intent!.pthid!);
    if (opened === undefined || opened.size !== 1) continue;
    add(execution.relationshipId, { kind: "remote-error", relationshipId: execution.relationshipId, executionId: execution.executionId, messageId: [...opened][0]!, code: report.code, comment: report.comment, sourceKey: execution.sourceKey! }, execution.sourceKey!);
  }

  const diagnostics = new Map<RelationshipId, readonly Diagnostic[]>();
  for (const [relationshipId, list] of [...drafts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    diagnostics.set(relationshipId, list.sort((a, b) => compareKeys(a.sourceKey, b.sourceKey)).map((entry) => entry.diagnostic));
  }
  return diagnostics;
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
 * The body of every problem report observation whose object reads: a
 * stored document whose body carries a non-empty `code` and, if a
 * comment, a string one. An object that is not here, does not read
 * or has no code gives no report, and no report is a diagnostic.
 */
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
    if (typeof body.code !== "string" || body.code.length === 0) return null;
    const comment = body.comment;
    if (comment !== undefined && typeof comment !== "string") return null;
    return { code: body.code, comment: comment ?? null };
  } catch (err) {
    if (err instanceof InvalidJson || err instanceof InvalidPlaintext) return null;
    throw err;
  }
}
