/**
 * What the runtime does over the whole fold: the retention it hands
 * the event store for collection, export and import; the erasure of a
 * logical message and the closure that keeps an erasure complete when
 * a late observation names roots the erase did not; the deletion of a
 * contact, its tombstone, the erasure of every message attributed to
 * it alone and the retirement of the addresses and routes no one else
 * needs; and the enumeration of unfinished work, everything the events
 * say still has to be done, which recovery reads from the fold rather
 * than from any queue. Each decision is a pure function of the fold,
 * exported as such, and each procedure takes the writer lock, scans,
 * decides, commits what it decided in one batch and collects.
 */

import { heldRootsOf, type Collected, type Event, type HeldRoots, type RetainedRoots, type VaultRuntime } from "@estoc/event-store/v3";

import { UnknownContact } from "./errors.js";
import { erased } from "./fold/held.js";
import { ackTargets } from "./fold/inbound.js";
import type { Work } from "./fold/outbound.js";
import type { PendingClaim } from "./fold/relationships.js";
import { scanVault, type ScanOptions, type VaultFold } from "./fold/vault.js";
import type { Keys } from "./identity.js";
import { contactIdOf } from "./ids.js";
import { vaultDraft, type VaultDraft } from "./schema.js";
import type { Birth, Cid, ContactId, DidId, EventId, EventReference, ExecutionId, MessageId, RelationshipId, RouteId, VaultData, WireMessageId } from "./types.js";

const CONTACT_DELETED = "contact-deleted";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const PING = "https://didcomm.org/trust-ping/2.0/ping";

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

/** The message IDs of the logical message one belongs to: every observation ID of its execution, or the ID on its own. */
export function logicalMessageIds(fold: VaultFold, messageId: MessageId): MessageId[] {
  for (const execution of fold.inbound.executions.values()) if (execution.messageIds.includes(messageId)) return [...execution.messageIds];
  return [messageId];
}

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
 * The equivalent erase each erased logical message is owed for roots
 * learned since its erasure — a late observation's, an alias under
 * another key's, a package prepared after — under the reason of the
 * first erasure in canonical order, one erase per message ID.
 */
export function erasureClosure(fold: VaultFold): VaultDraft<"message.erased">[] {
  const because = new Map<MessageId, string>();
  for (const event of fold.set.of("message.erased")) {
    for (const messageId of logicalMessageIds(fold, event.data.messageId)) if (!because.has(messageId)) because.set(messageId, event.data.because);
  }
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

async function decide(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions, drafts: (fold: VaultFold) => VaultDraft[]): Promise<Committed> {
  return runtime.locked(async (held) => {
    const batch = drafts(await scanVault(held, keys, options));
    const events = batch.length === 0 ? [] : await held.commit([], batch);
    return { events, collected: await held.collect(vaultHeldRoots(keys, options)) };
  });
}

/** Erase a logical message: every root its events and its packages still retain, in one commit, then collect. Nothing left to release commits nothing. */
export function eraseMessage(runtime: VaultRuntime, keys: Keys | null, messageId: MessageId, because = "user", options: ScanOptions = {}): Promise<Committed> {
  return decide(runtime, keys, options, (fold) => eraseDrafts(fold, logicalMessageIds(fold, messageId), because));
}

/** Append the equivalent erases late observations are owed, then collect. */
export function closeErasures(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Committed> {
  return decide(runtime, keys, options, erasureClosure);
}

// ---- contact deletion ----------------------------------------------------

export interface Deletion {
  readonly contactId: ContactId;
  /** the tombstone, null when it is already here */
  readonly tombstone: VaultDraft<"contact.deleted"> | null;
  /** the erases of every message attributed to the contact alone that still retains a root */
  readonly erases: readonly VaultDraft<"message.erased">[];
  /** the local addresses of its relationships no other relationship, queued birth or open disclosure needs, not yet retired */
  readonly retiredDids: readonly DidId[];
  /** the routes every binding address of which is retired, one of them for a deleted contact, not yet retired */
  readonly retiredRoutes: readonly RouteId[];
  readonly drafts: readonly VaultDraft[];
}

/**
 * What deleting a contact appends, from the fold alone: idempotent,
 * so a second call after a crash, or after a late message attributed
 * to the tombstoned contact, finishes what is left. Only the
 * relationships uniquely assigned to the contact are its; a contested
 * one is nobody's to erase. An address is retired when every
 * relationship, binding claim and queued birth naming it is the
 * contact's and every disclosure of it was a one-use invitation those
 * relationships consumed; a route when every address binding it is
 * retired and one of them for a deleted contact.
 */
export function deletionOf(fold: VaultFold, contactId: ContactId): Deletion {
  const view = fold.contacts.get(contactId);
  if (view === undefined) throw new UnknownContact(contactId);
  const own = new Set(view.relationships.map((relationship) => relationship.relationshipId));
  const attributed = new Set<MessageId>();
  const births = new Set<DidId>();
  for (const [messageId, intents] of groupIntents(fold)) {
    if (!intents.every((intent) => own.has(intent.relationshipId))) continue;
    attributed.add(messageId);
    const birth = fold.outbound.outbounds.get(messageId)?.intent?.birth;
    if (birth) births.add(birth.localDidId);
  }
  for (const [messageId, group] of fold.relationships.groups) if (group.status === "complete" && own.has(group.relationshipId)) attributed.add(messageId);
  const users = usersOfDids(fold);
  const retiredDids = [...new Set([...view.localDidIds, ...births])].filter((didId) => exclusive(fold, didId, own, users)).sort();
  const retired = new Set(retiredDids);
  const bound = new Map<RouteId, DidId[]>();
  for (const entity of fold.routes.dids.values()) {
    if (entity.created === null) continue;
    const list = bound.get(entity.created.boundRouteId);
    if (list === undefined) bound.set(entity.created.boundRouteId, [entity.didId]);
    else list.push(entity.didId);
  }
  const retiredRoutes = [...bound]
    .filter(([routeId, didIds]) => {
      const route = fold.routes.routes.get(routeId);
      if (route === undefined || route.retired !== null) return false;
      const gone = (didId: DidId) => retired.has(didId) || fold.routes.dids.get(didId)!.retired !== null;
      const forDeleted = (didId: DidId) => retired.has(didId) || fold.routes.dids.get(didId)!.retired === CONTACT_DELETED;
      return didIds.every(gone) && didIds.some(forDeleted);
    })
    .map(([routeId]) => routeId)
    .sort();
  const tombstone = view.deleted ? null : vaultDraft("contact.deleted", { contactId });
  const erases = eraseDrafts(fold, attributed, CONTACT_DELETED);
  const drafts: VaultDraft[] = [
    ...(tombstone === null ? [] : [tombstone]),
    ...erases,
    ...retiredDids.map((didId) => vaultDraft("did.retired", { didId, because: CONTACT_DELETED })),
    ...retiredRoutes.map((routeId) => vaultDraft("route.retired", { routeId, because: CONTACT_DELETED })),
  ];
  return { contactId, tombstone, erases, retiredDids, retiredRoutes, drafts };
}

function groupIntents(fold: VaultFold): Map<MessageId, VaultData["message.out"][]> {
  const groups = new Map<MessageId, VaultData["message.out"][]>();
  for (const event of fold.set.of("message.out")) {
    const list = groups.get(event.data.messageId);
    if (list === undefined) groups.set(event.data.messageId, [event.data]);
    else list.push(event.data);
  }
  return groups;
}

/** The relationships that name each local address: in a validated local chain, as a binding's root or as a queued birth's. */
function usersOfDids(fold: VaultFold): Map<DidId, Set<RelationshipId>> {
  const users = new Map<DidId, Set<RelationshipId>>();
  const use = (didId: DidId, relationshipId: RelationshipId) => {
    const set = users.get(didId);
    if (set === undefined) users.set(didId, new Set([relationshipId]));
    else set.add(relationshipId);
  };
  for (const relationship of fold.relationships.relationships.values()) for (const node of relationship.localChain) use(node.didId, relationship.relationshipId);
  for (const event of fold.set.of("relationship.bound")) use(event.data.localDidId, event.data.relationshipId);
  for (const event of fold.set.of("message.out")) if (event.data.birth !== null) use(event.data.birth.localDidId, event.data.relationshipId);
  return users;
}

function exclusive(fold: VaultFold, didId: DidId, own: ReadonlySet<RelationshipId>, users: Map<DidId, Set<RelationshipId>>): boolean {
  const entity = fold.routes.dids.get(didId);
  if (entity === undefined || entity.retired !== null) return false;
  for (const relationshipId of users.get(didId) ?? []) if (!own.has(relationshipId)) return false;
  for (const disclosure of entity.disclosures) {
    if (disclosure.data.uses !== "one" || disclosure.data.oobId === null) return false;
    const invitation = fold.invitations.invitations.get(disclosure.data.oobId);
    if (invitation === undefined || invitation.consumers.length === 0 || !invitation.consumers.every((relationshipId) => own.has(relationshipId))) return false;
  }
  return true;
}

export interface Deleted extends Committed {
  readonly deletion: Deletion;
}

/** Delete a contact: its tombstone, the erases and retirements `deletionOf` decides in one commit, then collect. Deleting it again finishes what a crash or a late message left. */
export async function deleteContact(runtime: VaultRuntime, keys: Keys | null, contactId: ContactId, options: ScanOptions = {}): Promise<Deleted> {
  let deletion: Deletion | undefined;
  const committed = await decide(runtime, keys, options, (fold) => {
    deletion = deletionOf(fold, contactId);
    return [...deletion.drafts];
  });
  return { ...committed, deletion: deletion! };
}

/** Finish every deleted contact's cleanup in one commit, then collect: what recovery runs on open. */
export function sweepDeleted(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Committed> {
  return decide(runtime, keys, options, (fold) => deletedContacts(fold).flatMap((contactId) => deletionOf(fold, contactId).drafts));
}

const deletedContacts = (fold: VaultFold): ContactId[] => [...fold.contacts.values()].filter((view) => view.deleted).map((view) => view.contactId);

// ---- unfinished work ------------------------------------------------------

/** Why no reply may be sent in a relationship now, or null when its current local end may send one. */
export function senderGate(fold: VaultFold, relationshipId: RelationshipId): string | null {
  const relationship = fold.relationships.relationships.get(relationshipId);
  if (relationship === undefined) return "the relationship is unknown";
  if (relationship.conflict) return "the relationship is in conflict";
  if (relationship.currentLocalDidId === null) return "the relationship does not stand";
  for (const edge of fold.set.of("relationship.localTransitioned")) {
    if (edge.data.relationshipId === relationshipId && fold.relationships.transitions.get(edge.eventId)?.status === "deferred") return `awaits the local transition ${edge.eventId}`;
  }
  if (fold.routes.dids.get(relationship.currentLocalDidId)?.live !== true) return `the local end ${relationship.currentLocalDidId} is not live`;
  if (relationship.contactId === null) {
    if (fold.set.of("relationship.contactAssigned").some((event) => event.data.relationshipId === relationshipId)) return "the contact assignments disagree";
  } else if (fold.contacts.get(relationship.contactId)?.deleted === true) return `the contact ${relationship.contactId} is deleted`;
  return null;
}

export type ResponseWork = {
  readonly executionId: ExecutionId;
  readonly relationshipId: RelationshipId;
  readonly wireMessageId: WireMessageId;
  /** `ack`: the carrier requested acknowledgments and some target stands; `natural`: its protocol answers it, the body deciding how */
  readonly kind: "ack" | "natural";
  readonly ackTargets: readonly WireMessageId[];
  /** the sender gate's reason while no reply may be sent, null when one may */
  readonly blocked: string | null;
};

export interface UnfinishedWork {
  /** outbounds whose intent selected a birth and whose relationship has no standing binding yet: the binding comes before the package */
  readonly births: readonly { messageId: MessageId; relationshipId: RelationshipId; birth: Birth }[];
  /** every outbound with work: prepare, submit or repack */
  readonly outbound: readonly { messageId: MessageId; relationshipId: RelationshipId; work: Exclude<Work, { kind: "none" }> }[];
  /** standing relationships with application input and no contact assignment, with the contact default policy would assign and whether its tombstone forbids that */
  readonly unassigned: readonly { relationshipId: RelationshipId; contactId: ContactId; tombstoned: boolean }[];
  /** transitions still waiting for evidence */
  readonly transitions: readonly { eventId: EventId; because: string }[];
  readonly pendingClaims: readonly PendingClaim[];
  /** complete executions owed a reply no outbound has yet selected */
  readonly responses: readonly ResponseWork[];
  /** application executions the default early-privacy policy may take as a rotation trigger: the relationship still at its birth address, that address disclosed for many or by invitation, or shared with another relationship's history, and no reply selected */
  readonly rotations: readonly { relationshipId: RelationshipId; executionId: ExecutionId }[];
  /** profile disclosures without a lift: readable inbound ones, and submitted outbound ones */
  readonly lifts: { readonly inbound: readonly { executionId: ExecutionId; relationshipId: RelationshipId }[]; readonly outbound: readonly { messageId: MessageId; relationshipId: RelationshipId }[] };
  /** the equivalent erases late observations are owed */
  readonly erasures: readonly VaultDraft<"message.erased">[];
  /** deleted contacts whose cleanup is not finished */
  readonly deletions: readonly ContactId[];
}

export type WorkOptions = {
  /** the message types of supported profile disclosures; none when left out, since which protocols carry a profile is the application's */
  profileTypes?: ReadonlySet<string>;
  /** the application message types whose protocol defines a natural response; Trust Ping when left out */
  respondsTo?: ReadonlySet<string>;
};

/** Everything the events say is still to be done, read from the fold: what recovery enumerates on open, and what a worker picks from between operations. */
export function unfinishedWork(fold: VaultFold, options: WorkOptions = {}): UnfinishedWork {
  const profileTypes = options.profileTypes ?? new Set<string>();
  const respondsTo = options.respondsTo ?? new Set([PING]);
  const assigned = new Set(fold.set.of("relationship.contactAssigned").map((event) => event.data.relationshipId));
  const localEdges = new Set(fold.set.of("relationship.localTransitioned").map((event) => event.data.relationshipId));
  const stands = (relationshipId: RelationshipId) => {
    const relationship = fold.relationships.relationships.get(relationshipId);
    return relationship !== undefined && !relationship.conflict && relationship.currentLocalDidId !== null ? relationship : null;
  };
  const deletedContact = (relationshipId: RelationshipId) => {
    const contactId = fold.relationships.relationships.get(relationshipId)?.contactId ?? null;
    return contactId !== null && fold.contacts.get(contactId)?.deleted === true;
  };

  const births: UnfinishedWork["births"][number][] = [];
  const outbound: UnfinishedWork["outbound"][number][] = [];
  const outboundLifts: UnfinishedWork["lifts"]["outbound"][number][] = [];
  for (const message of [...fold.outbound.outbounds.values()].sort((a, b) => cmp(a.messageId, b.messageId))) {
    if (message.intent === null) continue;
    const { relationshipId, birth, msgType, bodyCid } = message.intent;
    if (birth !== null && stands(relationshipId) === null && !message.conflict && !message.submitted && message.failed === null) births.push({ messageId: message.messageId, relationshipId, birth });
    if (message.work.kind !== "none") outbound.push({ messageId: message.messageId, relationshipId, work: message.work });
    if (profileTypes.has(msgType) && message.submitted && !erased(fold.erasures, message.messageId, bodyCid) && !deletedContact(relationshipId)) {
      if (!(fold.profiles.get(relationshipId)?.shares ?? []).some((share) => share.messageId === message.messageId)) outboundLifts.push({ messageId: message.messageId, relationshipId });
    }
  }

  const applicationIn = new Set<RelationshipId>();
  const responses: ResponseWork[] = [];
  const rotations: UnfinishedWork["rotations"][number][] = [];
  const inboundLifts: UnfinishedWork["lifts"]["inbound"][number][] = [];
  for (const execution of [...fold.inbound.executions.values()].sort((a, b) => cmp(a.executionId, b.executionId))) {
    if (execution.status !== "complete") continue;
    const { executionId, relationshipId, wireMessageId } = execution;
    const application = execution.kind === "application";
    if (application) applicationIn.add(relationshipId);
    const answered = fold.outbound.responses.has(executionId);
    if (!answered) {
      const targets = ackTargets(fold.inbound, execution);
      const natural = application && respondsTo.has(execution.intent!.msgType);
      if (targets.length > 0 || natural) responses.push({ executionId, relationshipId, wireMessageId, kind: natural ? "natural" : "ack", ackTargets: targets, blocked: senderGate(fold, relationshipId) });
      const relationship = stands(relationshipId);
      if (application && relationship !== null && relationship.localChain.length === 1 && !localEdges.has(relationshipId) && rootShared(fold, relationship.localChain[0]!.didId, relationshipId)) rotations.push({ relationshipId, executionId });
    }
    if (application && profileTypes.has(execution.intent!.msgType) && !deletedContact(relationshipId) && readable(fold, execution.eventIds)) {
      const lifted = (fold.profiles.get(relationshipId)?.claims ?? []).some((claim) => claim.sourceEventIds.some((eventId) => execution.eventIds.includes(eventId)));
      if (!lifted) inboundLifts.push({ executionId, relationshipId });
    }
  }

  const unassigned = [...applicationIn]
    .sort()
    .filter((relationshipId) => !assigned.has(relationshipId) && stands(relationshipId) !== null)
    .map((relationshipId) => {
      const contactId = contactIdOf(relationshipId);
      return { relationshipId, contactId, tombstoned: fold.contacts.get(contactId)?.deleted === true };
    });
  const transitions = [...fold.relationships.transitions]
    .flatMap(([eventId, status]) => (status.status === "deferred" ? [{ eventId, because: status.because }] : []))
    .sort((a, b) => cmp(a.eventId, b.eventId));
  return {
    births,
    outbound,
    unassigned,
    transitions,
    pendingClaims: fold.relationships.pendingClaims,
    responses,
    rotations,
    lifts: { inbound: inboundLifts, outbound: outboundLifts },
    erasures: erasureClosure(fold),
    deletions: deletedContacts(fold).filter((contactId) => deletionOf(fold, contactId).drafts.length > 0),
  };
}

/** The root address is one the default policy would leave: disclosed for many uses or by invitation, or in another relationship's validated local history. */
function rootShared(fold: VaultFold, didId: DidId, relationshipId: RelationshipId): boolean {
  const entity = fold.routes.dids.get(didId);
  if (entity !== undefined && entity.disclosures.some((disclosure) => disclosure.data.as === "oob" || disclosure.data.uses === "many")) return true;
  for (const other of fold.relationships.relationships.values()) {
    if (other.relationshipId !== relationshipId && other.localChain.some((node) => node.didId === didId)) return true;
  }
  return false;
}

/** No observation of the logical message has its body erased. */
function readable(fold: VaultFold, eventIds: readonly EventId[]): boolean {
  for (const eventId of eventIds) {
    const resolved = fold.set.resolve(eventId as EventReference<"message.in">, "message.in");
    if (resolved.status === "present" && erased(fold.erasures, resolved.event.data.messageId, resolved.event.data.bodyCid)) return false;
  }
  return true;
}
