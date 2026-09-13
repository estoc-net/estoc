/**
 * The relationships: each an unordered pair of birth addresses under a
 * stable ID, with two ends that move independently. The binding pins
 * the root local DID and the exact peer document; the local chain grows
 * by transitions we signed, the peer chain by proofs a carrier brought,
 * each verified against the exact document the chain already holds,
 * never a fresher one. Every edge is judged on its own evidence before
 * equal edges are merged, so a contradiction in one duplicate is never
 * covered by another; what contradicts is a conflict, what is not here
 * yet defers the node and every node after it, and canonical time
 * chooses nothing. The two chains depend on each other — a local edge
 * needs input the peer chain gives scope to, a peer edge needs a local
 * key the local chain retains — so they are folded together until
 * neither grows. The address index is every historical local DID
 * against every historical peer DID of every relationship; a pair two
 * relationships claim conflicts them both. What needs the retained
 * documents — whether a proof verifies, whether a resolution's
 * snapshot is the document it says — runs beside the fold as
 * `verifyTransitions` and `verifyResolutions`; an edge or a root whose
 * verdict is not in is deferred, never applied.
 */

import { isJsonObject, parseStrict, type JsonObject } from "@estoc/event-store/v3";
import { isLongForm } from "@estoc/did-peer";

import { rawCidOfBytes } from "../document.js";
import { InvalidDidDocument, InvalidFromPrior, InvalidIdentifier, InvalidPublicKey } from "../errors.js";
import { fromPriorClaims, verifyFromPrior } from "../from-prior.js";
import { didKeyName, inboundMessageId, relationshipId } from "../ids.js";
import { authorizedMethodIds, canonicalDidOf, methodPublicKey, peerResolution } from "../peer-document.js";
import type { VaultEvent } from "../schema.js";
import type { Cid, ContactId, Did, DidId, DidUrl, EventId, EventReference, KeyName, RelationshipId, VaultData } from "../types.js";
import type { RouteFold } from "./routes.js";
import { groupBy, samePayload, type VaultEventSet } from "./set.js";

/** A verdict on a proof or a snapshot from evidence outside the event set: the documents. */
export type EvidenceCheck = "verified" | "invalid";

export interface LocalNode {
  readonly didId: DidId;
  readonly did: Did;
  readonly keyNames: { readonly authentication: KeyName; readonly keyAgreement: KeyName };
  /** the transition that added the node, null for the root */
  readonly edgeEventId: EventId | null;
}

/** A peer address in a chain, with the exact document pinned for it: the binding's for the root, the transition's for a successor. */
export interface PeerNode {
  readonly did: Did;
  readonly resolutionEventId: EventReference<"peer.resolved">;
  readonly documentCid: Cid;
  readonly keyAgreementMethodIds: readonly DidUrl[];
  /** the transition that added the node, null for the root */
  readonly edgeEventId: EventId | null;
}

/**
 * What became of a transition event: `applied` is a node of its chain;
 * `deferred` waits for evidence, its own or a prefix's; `conflict` can
 * never be applied.
 */
export type TransitionStatus = { readonly status: "applied" } | { readonly status: "deferred"; readonly because: string } | { readonly status: "conflict"; readonly because: string };

export interface Relationship {
  readonly relationshipId: RelationshipId;
  /** the consistent binding, null while there is none, its evidence is missing or unverified, or bindings disagree */
  readonly binding: VaultData["relationship.bound"] | null;
  /** every binding event under this ID, in canonical order */
  readonly bindingEventIds: readonly EventReference<"relationship.bound">[];
  /** the validated local history from the root; empty while the binding does not stand */
  readonly localChain: readonly LocalNode[];
  /** the validated peer history from the pinned root document; empty while the binding does not stand */
  readonly peerChain: readonly PeerNode[];
  readonly currentLocalDidId: DidId | null;
  readonly currentPeerDid: Did | null;
  /** every key of every node of the local chain: the keys input in this relationship may arrive at */
  readonly recipientKeyNames: ReadonlySet<KeyName>;
  /** the one assigned contact, null while none or while assignments disagree */
  readonly contactId: ContactId | null;
  readonly deferred: readonly string[];
  /** what contradicts: disagreeing bindings or assignments, an edge that cannot stand, a pair another relationship claims */
  readonly faults: readonly string[];
  readonly conflict: boolean;
}

/**
 * A claim on a local/peer address pair that no validated chain yet
 * carries, so a proof-free delivery at that pair must wait rather than
 * form a birth: a committed carrier whose proof names the sender as
 * successor and that no applied transition witnesses, or a deferred
 * transition, at every pair it would add. The local end is by key; its
 * DID is null while no consistent entity derives the key.
 */
export interface PendingClaim {
  readonly localKeyName: KeyName;
  readonly localDid: Did | null;
  readonly peerDid: Did;
  readonly because: "carrier" | "edge";
  readonly eventIds: readonly EventId[];
  /** a transition for this carrier at this key is in conflict: conflicting membership, not a wait */
  readonly conflict: boolean;
}

export interface RelationshipFold {
  readonly relationships: ReadonlyMap<RelationshipId, Relationship>;
  /** every local DID entity in some validated local chain: retained, whatever its liveness */
  readonly retainedDidIds: ReadonlySet<DidId>;
  readonly transitions: ReadonlyMap<EventId, TransitionStatus>;
  readonly pendingClaims: readonly PendingClaim[];
  /** the relationships whose validated histories contain this pair, sorted; more than one is a conflict for each */
  claimants(localDid: Did, peerDid: Did): readonly RelationshipId[];
  /** the claims that make a proof-free delivery at this pair wait */
  pendingAt(localDid: Did, peerDid: Did): readonly PendingClaim[];
}

export type RelationshipFoldOptions = {
  /** each transition event's proof, by event ID */
  proofChecks?: ReadonlyMap<EventId, EvidenceCheck>;
  /** each `peer.resolved` event's snapshot against its document, by event ID */
  resolutionChecks?: ReadonlyMap<EventId, EvidenceCheck>;
};

type Verdict = { faults: string[]; deferred: string[] };

type Root = { localDidId: DidId; localDid: Did; peerDid: Did; resolution: VaultEvent<"peer.resolved"> };

type LocalEdge = VaultEvent<"relationship.localTransitioned">;
type PeerEdge = VaultEvent<"relationship.peerTransitioned">;
type Receipt = VaultEvent<"message.in">;
type Resolution = VaultEvent<"peer.resolved">;

/** An edge judged on its own evidence: what contradicts and what is absent. */
type Judged<E> = { edge: E; faults: string[]; deferred: string[] };

/** What every check in one relationship reads. */
type Context = {
  set: VaultEventSet;
  routes: RouteFold;
  proofChecks: ReadonlyMap<EventId, EvidenceCheck>;
  resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>;
  receipts: readonly Receipt[];
  receiptsByMessage: ReadonlyMap<string, Receipt[]>;
  bindingEventIds: readonly EventReference<"relationship.bound">[];
};

const pairKey = (localDid: Did, peerDid: Did) => JSON.stringify([localDid, peerDid]);
const NO_CHECKS: ReadonlyMap<EventId, EvidenceCheck> = new Map();

export function foldRelationships(set: VaultEventSet, routes: RouteFold, options: RelationshipFoldOptions = {}): RelationshipFold {
  const proofChecks = options.proofChecks ?? NO_CHECKS;
  const resolutionChecks = options.resolutionChecks ?? NO_CHECKS;
  const bound = groupBy(set.of("relationship.bound"), (event) => event.data.relationshipId);
  const assigned = groupBy(set.of("relationship.contactAssigned"), (event) => event.data.relationshipId);
  const localEdges = groupBy(set.of("relationship.localTransitioned"), (event) => event.data.relationshipId);
  const peerEdges = groupBy(set.of("relationship.peerTransitioned"), (event) => event.data.relationshipId);
  const receipts = set.of("message.in");
  const receiptsByMessage = groupBy(receipts, (event) => event.data.messageId);
  const ids = [...new Set([...bound.keys(), ...assigned.keys(), ...localEdges.keys(), ...peerEdges.keys()])].sort();

  const transitions = new Map<EventId, TransitionStatus>();
  const folded = new Map<RelationshipId, { relationship: Omit<Relationship, "faults" | "conflict">; faults: string[] }>();
  for (const id of ids) {
    const verdict: Verdict = { faults: [], deferred: [] };
    const bindings = bound.get(id) ?? [];
    const context: Context = { set, routes, proofChecks, resolutionChecks, receipts, receiptsByMessage, bindingEventIds: bindings.map((event) => event.eventId as EventReference<"relationship.bound">) };
    const { binding, root } = foldBinding(bindings, context, verdict);

    let localChain: LocalNode[] = [];
    let peerChain: PeerNode[] = [];
    if (root !== null) {
      const chains = foldChains(root, localEdges.get(id) ?? [], peerEdges.get(id) ?? [], context, verdict, transitions);
      localChain = chains.local;
      peerChain = chains.peer;
    } else {
      for (const edge of [...(localEdges.get(id) ?? []), ...(peerEdges.get(id) ?? [])]) transitions.set(edge.eventId, { status: "deferred", because: "the relationship's binding does not stand" });
    }

    const contactIds = [...new Set((assigned.get(id) ?? []).map((event) => event.data.contactId))].sort();
    if (contactIds.length > 1) verdict.faults.push(`assigned to ${contactIds.length} contacts`);

    folded.set(id, {
      relationship: {
        relationshipId: id,
        binding,
        bindingEventIds: context.bindingEventIds,
        localChain,
        peerChain,
        currentLocalDidId: localChain.at(-1)?.didId ?? null,
        currentPeerDid: peerChain.at(-1)?.did ?? null,
        recipientKeyNames: keyNamesOf(localChain),
        contactId: contactIds.length === 1 ? contactIds[0]! : null,
        deferred: verdict.deferred,
      },
      faults: verdict.faults,
    });
  }

  const index = new Map<string, RelationshipId[]>();
  for (const { relationship } of folded.values()) {
    for (const local of relationship.localChain) {
      for (const peer of relationship.peerChain) {
        const key = pairKey(local.did, peer.did);
        const claimants = index.get(key);
        if (claimants === undefined) index.set(key, [relationship.relationshipId]);
        else claimants.push(relationship.relationshipId);
      }
    }
  }
  for (const [key, claimants] of index) {
    if (claimants.length < 2) continue;
    claimants.sort();
    const [localDid, peerDid] = JSON.parse(key) as [Did, Did];
    for (const id of claimants) folded.get(id)!.faults.push(`the pair ${localDid} / ${peerDid} is also claimed by ${claimants.filter((other) => other !== id).join(", ")}`);
  }

  const relationships = new Map<RelationshipId, Relationship>();
  const retainedDidIds = new Set<DidId>();
  for (const [id, { relationship, faults }] of folded) {
    relationships.set(id, { ...relationship, faults, conflict: faults.length > 0 });
    for (const node of relationship.localChain) retainedDidIds.add(node.didId);
  }

  const pendingClaims = foldPendingClaims(set, routes, relationships, transitions, receipts);
  const pendingByPair = new Map<string, PendingClaim[]>();
  for (const claim of pendingClaims) {
    if (claim.localDid === null) continue;
    const key = pairKey(claim.localDid, claim.peerDid);
    const claims = pendingByPair.get(key);
    if (claims === undefined) pendingByPair.set(key, [claim]);
    else claims.push(claim);
  }

  return {
    relationships,
    retainedDidIds,
    transitions,
    pendingClaims,
    claimants: (localDid, peerDid) => index.get(pairKey(localDid, peerDid)) ?? [],
    pendingAt: (localDid, peerDid) => pendingByPair.get(pairKey(localDid, peerDid)) ?? [],
  };
}

/**
 * The relationship's binding as far as the evidence goes: every bound
 * event under the ID must agree on the root local DID and, where its
 * resolution is here, on the peer's canonical DID and exact document,
 * and each present resolution must hold with its own binding.
 * Equivalent bindings are one; a resolution still missing is noted and
 * can only add a conflict when it arrives. The root stands once its
 * local DID is created and a root snapshot has been verified against
 * the document it names.
 */
function foldBinding(bindings: readonly VaultEvent<"relationship.bound">[], context: Context, verdict: Verdict): { binding: VaultData["relationship.bound"] | null; root: Root | null } {
  if (bindings.length === 0) {
    verdict.deferred.push("no binding");
    return { binding: null, root: null };
  }
  if (new Set(bindings.map((event) => event.data.localDidId)).size > 1) verdict.faults.push("bindings disagree on the root local DID");
  const resolutions: { event: VaultEvent<"relationship.bound">; resolution: Resolution }[] = [];
  let missing = 0;
  for (const event of bindings) {
    const resolved = context.set.resolve(event.data.peerResolutionEventId, "peer.resolved");
    if (resolved.status === "missing") missing++;
    else if (resolved.status === "mismatched") verdict.faults.push(`binding ${event.eventId} names ${resolved.event.type} as its peer resolution`);
    else {
      resolutions.push({ event, resolution: resolved.event });
      const localDid = context.routes.dids.get(event.data.localDidId)?.created?.did ?? null;
      if (bindingHolds(event.data, resolved.event.data, localDid) === "contradicted") verdict.faults.push(`binding ${event.eventId} does not hold: its resolution, local DID and relationship ID disagree`);
      if (context.resolutionChecks.get(resolved.event.eventId) === "invalid") verdict.faults.push(`the root resolution ${resolved.event.eventId} is not its document's`);
    }
  }
  if (new Set(resolutions.map(({ resolution }) => resolution.data.did)).size > 1) verdict.faults.push("bindings disagree on the root peer DID");
  if (new Set(resolutions.map(({ resolution }) => resolution.data.documentCid)).size > 1) verdict.faults.push("bindings disagree on the root peer document");
  if (verdict.faults.length > 0) return { binding: null, root: null };
  if (missing > 0) verdict.deferred.push(`${missing} binding${missing > 1 ? "s name" : " names"} a peer resolution that is not here`);
  const first = resolutions[0];
  if (first === undefined) return { binding: null, root: null };
  const localDid = context.routes.dids.get(first.event.data.localDidId)?.created?.did ?? null;
  if (localDid === null) {
    verdict.deferred.push(`the root local DID ${first.event.data.localDidId} is not created`);
    return { binding: first.event.data, root: null };
  }
  const verified = resolutions.find(({ resolution }) => context.resolutionChecks.get(resolution.eventId) === "verified");
  if (verified === undefined) {
    verdict.deferred.push("no root resolution is yet verified against its document");
    return { binding: first.event.data, root: null };
  }
  return { binding: first.event.data, root: { localDidId: first.event.data.localDidId, localDid, peerDid: verified.resolution.data.did, resolution: verified.resolution } };
}

/**
 * Whether a binding's evidence holds together: its resolution was
 * taken at the local DID's key-agreement key, the two root DIDs are
 * distinct and derive the recorded relationship ID. Each check runs as
 * soon as what it needs is here, so a contradiction is found without
 * waiting for the rest; `unknown` only while the local DID's own
 * spelling is still missing and nothing present contradicts.
 */
export function bindingHolds(binding: VaultData["relationship.bound"], root: VaultData["peer.resolved"], localDid: Did | null): "holds" | "contradicted" | "unknown" {
  if (root.localKeyName !== didKeyName(binding.localDidId, "key-agreement")) return "contradicted";
  if (localDid === null) return "unknown";
  if (root.did === localDid) return "contradicted";
  try {
    return relationshipId(localDid, root.did) === binding.relationshipId ? "holds" : "contradicted";
  } catch (err) {
    if (err instanceof InvalidIdentifier) return "contradicted";
    throw err;
  }
}

function keyNamesOf(chain: readonly LocalNode[]): Set<KeyName> {
  const names = new Set<KeyName>();
  for (const node of chain) names.add(node.keyNames.authentication).add(node.keyNames.keyAgreement);
  return names;
}

function localNode(didId: DidId, did: Did, edgeEventId: EventId | null): LocalNode {
  return { didId, did, keyNames: { authentication: didKeyName(didId, "authentication"), keyAgreement: didKeyName(didId, "key-agreement") }, edgeEventId };
}

function peerNode(resolution: Resolution, edgeEventId: EventId | null): PeerNode {
  const { did, documentCid, keyAgreementMethodIds } = resolution.data;
  return { did, resolutionEventId: resolution.eventId as EventReference<"peer.resolved">, documentCid, keyAgreementMethodIds, edgeEventId };
}

/**
 * The two chains folded together until neither grows: each pass walks
 * both from the root over the other's last result, and the last pass
 * is the verdict. Growth is monotone and bounded by the edges, so the
 * passes end, and the result is the same from any order of events.
 */
function foldChains(root: Root, localEdges: readonly LocalEdge[], peerEdges: readonly PeerEdge[], context: Context, verdict: Verdict, transitions: Map<EventId, TransitionStatus>): { local: LocalNode[]; peer: PeerNode[] } {
  let local: { chain: LocalNode[]; complete: boolean } = { chain: [localNode(root.localDidId, root.localDid, null)], complete: false };
  let peer: PeerNode[] = [peerNode(root.resolution, null)];
  for (;;) {
    const pass: Verdict = { faults: [], deferred: [] };
    const statuses = new Map<EventId, TransitionStatus>();
    const scope = scopeOf(context, peer);
    const nextLocal = foldLocalChain(root, localEdges, context, scope, pass, statuses);
    const nextPeer = foldPeerChain(root, peerEdges, context, nextLocal.chain, nextLocal.complete, pass, statuses);
    const grew = nextLocal.chain.length > local.chain.length || nextPeer.length > peer.length;
    local = nextLocal;
    peer = nextPeer;
    if (!grew) {
      verdict.faults.push(...pass.faults);
      verdict.deferred.push(...pass.deferred);
      for (const [eventId, status] of statuses) transitions.set(eventId, status);
      return { local: local.chain, peer };
    }
  }
}

/**
 * The resolution an observation names, once it is here and says what
 * the observation says: the same local key, canonical DID and presented
 * spelling, and the observation's message ID derived from that key and
 * its wire ID. `missing` while the resolution is absent; `contradicted`
 * when it is here and disagrees, an observation no claim can rest on.
 */
function authenticated(context: Context, receipt: Receipt): { status: "present"; resolution: Resolution } | { status: "missing" } | { status: "contradicted" } {
  const { peerResolutionEventId, localKeyName, did, presentedDid, messageId, wireMessageId } = receipt.data;
  if (peerResolutionEventId === null) return { status: "contradicted" };
  const resolved = context.set.resolve(peerResolutionEventId, "peer.resolved");
  if (resolved.status === "missing") return { status: "missing" };
  if (resolved.status === "mismatched") return { status: "contradicted" };
  const { data } = resolved.event;
  if (data.localKeyName !== localKeyName || data.did !== did || data.presentedDid !== presentedDid) return { status: "contradicted" };
  if (inboundMessageId(data.peerPublicKey, wireMessageId) !== messageId) return { status: "contradicted" };
  return { status: "present", resolution: resolved.event };
}

/** Does this observation carry exactly the proof a peer edge names, at its key, from its successor, bound to this relationship if bound at all? */
function witnesses(bindingEventIds: readonly EventReference<"relationship.bound">[], receipt: Receipt, edge: PeerEdge["data"]): boolean {
  const { data } = receipt;
  return (
    data.fromPrior === edge.fromPrior &&
    data.localKeyName === edge.localKeyName &&
    data.peerResolutionEventId === edge.peerResolutionEventId &&
    data.presentedDid === edge.presentedToDid &&
    data.did === edge.toDid &&
    (data.relationshipBindingEventId === null || bindingEventIds.includes(data.relationshipBindingEventId))
  );
}

/** The observations of one message ID disagree on the intent: the group can witness nothing until resolved. */
function intentConflict(context: Context, messageId: string): boolean {
  const group = context.receiptsByMessage.get(messageId) ?? [];
  return group.some((receipt) => receipt.data.intentHash !== group[0]!.data.intentHash);
}

/**
 * Whether an observation has scope in this relationship, given the
 * peer chain as folded so far: `scoped` when its evidence is complete
 * and authorizes it — a proof-free root sender by the pinned root
 * document, a proof-free successor by the applied transition it names
 * and that transition's exact document, a carrier by an applied
 * transition it witnesses — `incomplete` while what would decide is
 * absent, `none` when the evidence here does not give it this scope.
 * Which local key it arrived at is the caller's to check against the
 * prefix it needs.
 */
type Scope = (receipt: Receipt) => "scoped" | "incomplete" | "none";

function scopeOf(context: Context, peerChain: readonly PeerNode[]): Scope {
  const nodeByEdge = new Map<EventId, PeerNode>();
  for (const node of peerChain) if (node.edgeEventId !== null) nodeByEdge.set(node.edgeEventId, node);
  const edges = context.set.of("relationship.peerTransitioned");
  const applied = edges.filter((edge) => nodeByEdge.has(edge.eventId));
  return (receipt) => {
    const auth = authenticated(context, receipt);
    if (auth.status !== "present") return auth.status === "missing" ? "incomplete" : "none";
    if (intentConflict(context, receipt.data.messageId)) return "none";
    const { relationshipBindingEventId, peerTransitionEventId, fromPrior, messageId, localKeyName } = receipt.data;
    const { did, documentCid } = auth.resolution.data;
    if (fromPrior !== null) {
      if (relationshipBindingEventId !== null && !context.bindingEventIds.includes(relationshipBindingEventId)) return "none";
      if (applied.some((edge) => witnesses(context.bindingEventIds, receipt, edge.data))) return "scoped";
      const named = edges.filter((edge) => edge.data.messageId === messageId && edge.data.localKeyName === localKeyName);
      return named.length === 0 || named.some((edge) => !nodeByEdge.has(edge.eventId)) ? "incomplete" : "none";
    }
    if (relationshipBindingEventId === null || !context.bindingEventIds.includes(relationshipBindingEventId)) return "none";
    if (peerTransitionEventId === null) {
      const root = peerChain[0]!;
      return did === root.did && documentCid === root.documentCid ? "scoped" : "none";
    }
    const node = nodeByEdge.get(peerTransitionEventId);
    if (node !== undefined) return did === node.did && documentCid === node.documentCid ? "scoped" : "none";
    return context.set.resolve(peerTransitionEventId, "relationship.peerTransitioned").status === "mismatched" ? "none" : "incomplete";
  };
}

/**
 * A local edge judged on its own evidence, in every order the same:
 * the successor's entity, the proof's verdict, the trigger it names,
 * and whether input scoped to this relationship confirms the
 * predecessor at its own keys. The trigger must itself be such a
 * confirmation. Conflicts and absences are both collected in full.
 */
function judgeLocalEdge(edge: LocalEdge, context: Context, scope: Scope): Judged<LocalEdge> {
  const { fromDidId, toDidId, triggerEventId } = edge.data;
  const faults: string[] = [];
  const deferred: string[] = [];
  const successor = context.routes.dids.get(toDidId);
  if (successor === undefined || successor.created === null) deferred.push(`successor ${toDidId} is not created`);
  else if (successor.conflict) faults.push(`successor entity ${toDidId} is in conflict`);
  const check = context.proofChecks.get(edge.eventId);
  if (check === "invalid") faults.push("the proof does not verify against the predecessor's document");
  else if (check === undefined) deferred.push("the proof is not yet verified");
  const predecessorKeys = new Set([didKeyName(fromDidId, "authentication"), didKeyName(fromDidId, "key-agreement")]);
  const confirms = (receipt: Receipt) => (predecessorKeys.has(receipt.data.localKeyName) ? scope(receipt) : "none");
  if (triggerEventId !== null) {
    const trigger = context.set.resolve(triggerEventId, "message.in");
    if (trigger.status === "mismatched") faults.push(`the trigger ${triggerEventId} is a ${trigger.event.type}`);
    else if (trigger.status === "missing") deferred.push(`the trigger ${triggerEventId} is not here`);
    else {
      const confirmation = confirms(trigger.event);
      if (confirmation === "none") faults.push(`the trigger ${triggerEventId} does not confirm ${fromDidId}`);
      else if (confirmation === "incomplete") deferred.push(`the trigger ${triggerEventId} awaits its evidence`);
    }
  }
  if (!context.receipts.some((receipt) => confirms(receipt) === "scoped")) deferred.push(`${fromDidId} is not confirmed by input in this relationship`);
  return { edge, faults, deferred };
}

/**
 * A peer edge judged on its own evidence, in every order the same: the
 * prior and successor resolutions it names, the successor's agreement
 * with the edge and its snapshot verdict, the local key's presence in
 * the local history, the observation that witnesses the proof, and the
 * proof's verdict. Conflicts and absences are both collected in full.
 */
function judgePeerEdge(edge: PeerEdge, context: Context, recipientKeyNames: ReadonlySet<KeyName>, localComplete: boolean): Judged<PeerEdge> & { successor: Resolution | null } {
  const { fromDid, toDid, presentedToDid, localKeyName, peerPublicKey, priorResolutionEventId, peerResolutionEventId, messageId } = edge.data;
  const faults: string[] = [];
  const deferred: string[] = [];
  const prior = context.set.resolve(priorResolutionEventId, "peer.resolved");
  if (prior.status === "mismatched") faults.push(`the prior resolution is a ${prior.event.type}`);
  else if (prior.status === "missing") deferred.push("the prior resolution is not here");
  else if (prior.event.data.did !== fromDid) faults.push(`the prior resolution is ${prior.event.data.did}'s, not ${fromDid}'s`);
  const resolved = context.set.resolve(peerResolutionEventId, "peer.resolved");
  let successor: Resolution | null = null;
  if (resolved.status === "mismatched") faults.push(`the successor's resolution is a ${resolved.event.type}`);
  else if (resolved.status === "missing") deferred.push("the successor's resolution is not here");
  else {
    successor = resolved.event;
    const { data } = successor;
    if (data.did !== toDid) faults.push(`the successor's resolution is ${data.did}'s, not ${toDid}'s`);
    if (data.presentedDid !== presentedToDid) faults.push("the successor's resolution presents another spelling");
    if (data.localKeyName !== localKeyName) faults.push("the successor's resolution was taken at another key");
    if (data.peerPublicKey !== peerPublicKey) faults.push("the successor's resolution authenticates another key");
    const check = context.resolutionChecks.get(successor.eventId);
    if (check === "invalid") faults.push("the successor's resolution is not its document's");
    else if (check === undefined) deferred.push("the successor's resolution is not yet verified against its document");
  }
  if (!recipientKeyNames.has(localKeyName)) {
    if (localComplete) faults.push(`${localKeyName} is not in the local history`);
    else deferred.push(`${localKeyName} is not yet in the local history`);
  }
  const candidates = context.receiptsByMessage.get(messageId) ?? [];
  if (intentConflict(context, messageId)) faults.push(`the observations of message ${messageId} disagree on the intent`);
  else {
    let witness = false;
    let incomplete = false;
    for (const receipt of candidates) {
      if (!witnesses(context.bindingEventIds, receipt, edge.data)) {
        const binding = receipt.data.relationshipBindingEventId;
        if (binding !== null && !context.bindingEventIds.includes(binding) && context.set.resolve(binding, "relationship.bound").status === "present") faults.push(`observation ${receipt.eventId} of message ${messageId} is bound to another relationship`);
        continue;
      }
      const auth = authenticated(context, receipt);
      if (auth.status === "present") witness = true;
      else if (auth.status === "missing") incomplete = true;
    }
    if (!witness) deferred.push(candidates.length === 0 ? `no observation of message ${messageId} is here` : incomplete ? `the observation of message ${messageId} awaits its resolution` : `no observation of message ${messageId} carries this proof at this key`);
  }
  const check = context.proofChecks.get(edge.eventId);
  if (check === "invalid") faults.push("the proof does not verify against the pinned predecessor document");
  else if (check === undefined) deferred.push("the proof is not yet verified");
  return { edge, faults, deferred, successor };
}

/** Equal transitions among the judged edges, grouped by predecessor; an edge with a fault of its own is settled first and never grouped. */
function classesOf<E extends LocalEdge | PeerEdge, K>(judged: readonly Judged<E>[], describe: (edge: E) => string, predecessorOf: (edge: E) => K, sameTransition: (a: Judged<E>, b: Judged<E>) => boolean, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): Map<K, Judged<E>[][]> {
  const classes = new Map<K, Judged<E>[][]>();
  for (const item of judged) {
    if (item.faults.length > 0) {
      verdict.faults.push(...item.faults.map((fault) => `${describe(item.edge)}: ${fault}`));
      statuses.set(item.edge.eventId, { status: "conflict", because: item.faults.join("; ") });
      continue;
    }
    const key = predecessorOf(item.edge);
    const list = classes.get(key) ?? [];
    classes.set(key, list);
    const same = list.find((cls) => sameTransition(cls[0]!, item));
    if (same === undefined) list.push([item]);
    else same.push(item);
  }
  for (const [from, list] of classes) {
    if (list.length < 2) continue;
    verdict.faults.push(`competing successors of ${String(from)}`);
    for (const cls of list) for (const item of cls) statuses.set(item.edge.eventId, { status: "conflict", because: `competing successors of ${String(from)}` });
  }
  return classes;
}

/** A class applies when one of its equal edges is complete; the others keep their own absences on record until their evidence is in. */
function settleClass<E extends LocalEdge | PeerEdge>(cls: readonly Judged<E>[], describe: (edge: E) => string, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): Judged<E> | null {
  const complete = cls.find((item) => item.deferred.length === 0) ?? null;
  for (const item of cls) {
    if (item.deferred.length === 0) statuses.set(item.edge.eventId, { status: "applied" });
    else {
      if (complete === null) verdict.deferred.push(...item.deferred.map((why) => `${describe(item.edge)}: ${why}`));
      statuses.set(item.edge.eventId, { status: "deferred", because: item.deferred.join("; ") });
    }
  }
  return complete;
}

/** Every class the walk did not reach: its edges wait for a rooted prefix, or for their own evidence. */
function settleUnreached<E extends LocalEdge | PeerEdge, K>(classes: ReadonlyMap<K, Judged<E>[][]>, reached: ReadonlySet<Judged<E>[]>, describe: (edge: E) => string, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): boolean {
  let all = true;
  for (const list of classes.values()) {
    if (list.length > 1) {
      all = false;
      continue;
    }
    for (const cls of list) {
      if (reached.has(cls)) continue;
      all = false;
      for (const item of cls) {
        const because = [...item.deferred, "no rooted prefix reaches the edge"].join("; ");
        verdict.deferred.push(`${describe(item.edge)}: ${because}`);
        statuses.set(item.edge.eventId, { status: "deferred", because });
      }
    }
  }
  return all;
}

function foldLocalChain(root: Root, edges: readonly LocalEdge[], context: Context, scope: Scope, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): { chain: LocalNode[]; complete: boolean } {
  const describe = (edge: LocalEdge) => `local edge ${edge.data.fromDidId} → ${edge.data.toDidId}`;
  const judged = edges.map((edge) => judgeLocalEdge(edge, context, scope));
  const classes = classesOf(judged, describe, (edge) => edge.data.fromDidId, (a, b) => samePayload(a.edge.data, b.edge.data), verdict, statuses);
  const chain = [localNode(root.localDidId, root.localDid, null)];
  const inChain = new Set([root.localDidId]);
  const reached = new Set<Judged<LocalEdge>[]>();
  let stopped = false;
  for (let node = chain[0]!; ; ) {
    const list = classes.get(node.didId);
    if (list === undefined || list.length !== 1) break;
    const cls = list[0]!;
    reached.add(cls);
    const { toDidId } = cls[0]!.edge.data;
    if (inChain.has(toDidId)) {
      verdict.faults.push(`${describe(cls[0]!.edge)}: ${toDidId} is already in the local chain`);
      for (const item of cls) statuses.set(item.edge.eventId, { status: "conflict", because: `${toDidId} is already in the local chain` });
      stopped = true;
      break;
    }
    const complete = settleClass(cls, describe, verdict, statuses);
    if (complete === null) {
      stopped = true;
      break;
    }
    node = localNode(toDidId, context.routes.dids.get(toDidId)!.created!.did, complete.edge.eventId);
    chain.push(node);
    inChain.add(toDidId);
  }
  const allReached = settleUnreached(classes, reached, describe, verdict, statuses);
  return { chain, complete: !stopped && allReached && judged.every((item) => item.faults.length === 0) };
}

function foldPeerChain(root: Root, edges: readonly PeerEdge[], context: Context, localChain: readonly LocalNode[], localComplete: boolean, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): PeerNode[] {
  const describe = (edge: PeerEdge) => `peer edge ${edge.data.fromDid} → ${edge.data.toDid}`;
  const recipientKeyNames = keyNamesOf(localChain);
  const judged = edges.map((edge) => judgePeerEdge(edge, context, recipientKeyNames, localComplete));
  const successorOf = new Map(judged.map((item) => [item.edge, item.successor] as const));
  const sameTransition = (a: Judged<PeerEdge>, b: Judged<PeerEdge>) => {
    const [sa, sb] = [successorOf.get(a.edge), successorOf.get(b.edge)];
    return a.edge.data.fromPrior === b.edge.data.fromPrior && a.edge.data.toDid === b.edge.data.toDid && sa != null && sb != null && sa.data.documentCid === sb.data.documentCid;
  };
  const classes = classesOf(judged, describe, (edge) => edge.data.fromDid, sameTransition, verdict, statuses);
  const chain = [peerNode(root.resolution, null)];
  const inChain = new Set([root.peerDid]);
  const reached = new Set<Judged<PeerEdge>[]>();
  for (let node = chain[0]!; ; ) {
    const list = classes.get(node.did);
    if (list === undefined || list.length !== 1) break;
    const cls = list[0]!;
    reached.add(cls);
    const { toDid } = cls[0]!.edge.data;
    const faults: string[] = [];
    if (inChain.has(toDid)) faults.push(`${toDid} is already in the peer chain`);
    for (const item of cls) {
      const prior = context.set.resolve(item.edge.data.priorResolutionEventId, "peer.resolved");
      if (prior.status === "present" && prior.event.data.documentCid !== node.documentCid) faults.push("the prior resolution is not the chain's document");
    }
    if (faults.length > 0) {
      verdict.faults.push(...faults.map((fault) => `${describe(cls[0]!.edge)}: ${fault}`));
      for (const item of cls) statuses.set(item.edge.eventId, { status: "conflict", because: faults.join("; ") });
      break;
    }
    const complete = settleClass(cls, describe, verdict, statuses);
    if (complete === null) break;
    node = peerNode(successorOf.get(complete.edge)!, complete.edge.eventId);
    chain.push(node);
    inChain.add(toDid);
  }
  settleUnreached(classes, reached, describe, verdict, statuses);
  return chain;
}

/**
 * The pairs a proof-free delivery must wait at: each committed carrier
 * whose proof names its authenticated sender as successor and that no
 * applied transition witnesses, at its own key only; and each deferred
 * transition at every pair it would add to the index — a peer
 * successor against every validated local DID of its relationship, a
 * local successor against every validated peer DID.
 */
function foldPendingClaims(set: VaultEventSet, routes: RouteFold, relationships: ReadonlyMap<RelationshipId, Relationship>, transitions: ReadonlyMap<EventId, TransitionStatus>, receipts: readonly Receipt[]): PendingClaim[] {
  const localDidOf = (keyName: KeyName): Did | null => {
    const didId = routes.entityOfKey(keyName);
    return didId === null ? null : (routes.dids.get(didId)?.created?.did ?? null);
  };
  const edges = set.of("relationship.peerTransitioned");
  const claims = new Map<string, { localKeyName: KeyName; localDid: Did | null; peerDid: Did; because: PendingClaim["because"]; eventIds: EventId[]; conflict: boolean }>();
  const claim = (localKeyName: KeyName, peerDid: Did, because: PendingClaim["because"], eventId: EventId, conflict: boolean) => {
    const key = JSON.stringify([localKeyName, peerDid, because]);
    const known = claims.get(key);
    if (known === undefined) claims.set(key, { localKeyName, localDid: localDidOf(localKeyName), peerDid, because, eventIds: [eventId], conflict });
    else {
      if (!known.eventIds.includes(eventId)) known.eventIds.push(eventId);
      known.conflict ||= conflict;
    }
  };
  for (const receipt of receipts) {
    const { fromPrior, peerResolutionEventId, presentedDid, did, localKeyName, messageId } = receipt.data;
    if (fromPrior === null || peerResolutionEventId === null || presentedDid === null || did === null) continue;
    let sub: string;
    try {
      sub = fromPriorClaims(fromPrior).sub;
    } catch (err) {
      if (err instanceof InvalidFromPrior) continue;
      throw err;
    }
    if (sub !== presentedDid) continue;
    const named = edges.filter((edge) => edge.data.messageId === messageId && edge.data.localKeyName === localKeyName);
    const covered = named.some((edge) => transitions.get(edge.eventId)?.status === "applied" && witnesses(relationships.get(edge.data.relationshipId)?.bindingEventIds ?? [], receipt, edge.data));
    if (covered) continue;
    claim(localKeyName, did, "carrier", receipt.eventId, named.some((edge) => transitions.get(edge.eventId)?.status === "conflict"));
  }
  for (const edge of edges) {
    if (transitions.get(edge.eventId)?.status !== "deferred") continue;
    claim(edge.data.localKeyName, edge.data.toDid, "edge", edge.eventId, false);
    for (const node of relationships.get(edge.data.relationshipId)?.localChain ?? []) claim(node.keyNames.keyAgreement, edge.data.toDid, "edge", edge.eventId, false);
  }
  for (const edge of set.of("relationship.localTransitioned")) {
    if (transitions.get(edge.eventId)?.status !== "deferred") continue;
    for (const peer of relationships.get(edge.data.relationshipId)?.peerChain ?? []) claim(didKeyName(edge.data.toDidId, "key-agreement"), peer.did, "edge", edge.eventId, false);
  }
  return [...claims.values()].sort((a, b) => (a.localKeyName < b.localKeyName ? -1 : a.localKeyName > b.localKeyName ? 1 : a.peerDid < b.peerDid ? -1 : a.peerDid > b.peerDid ? 1 : a.because < b.because ? -1 : a.because > b.because ? 1 : 0));
}

/** Reads the retained object a CID names: null while the object is not here. */
export type ReadObject = (cid: Cid) => Promise<Uint8Array | null>;

/**
 * The document a resolution names, as the vault retains it: for a
 * numalgo-4 long form derived from the spelling itself, for anything
 * else read from the object store by CID and checked to be those
 * bytes. Null while the object is not here; a throw when what is here
 * is not the document the resolution says.
 */
async function documentOf(resolution: VaultData["peer.resolved"], readObject: ReadObject): Promise<JsonObject | null> {
  if (isLongForm(resolution.presentedDid)) {
    const derived = peerResolution(resolution.presentedDid);
    if (derived.did !== resolution.did) throw new InvalidDidDocument(`the long form is ${derived.did}'s, not ${resolution.did}'s`);
    if (derived.cid !== resolution.documentCid) throw new InvalidDidDocument(`the long form derives ${derived.cid}, not the recorded ${resolution.documentCid}`);
    return derived.document;
  }
  const bytes = await readObject(resolution.documentCid);
  if (bytes === null) return null;
  if (rawCidOfBytes(bytes) !== resolution.documentCid) throw new InvalidDidDocument(`the object read is not ${resolution.documentCid}`);
  let document: unknown;
  try {
    document = parseStrict(bytes);
  } catch (err) {
    throw new InvalidDidDocument(`the retained document is not strict JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isJsonObject(document)) throw new InvalidDidDocument("the retained document is a JSON object");
  const id = document["id"];
  if (typeof id !== "string" || canonicalDidOf(id) !== resolution.did) throw new InvalidDidDocument(`the retained document is not ${resolution.did}'s`);
  return document;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Every `peer.resolved` event's snapshot checked against its own
 * document: the method IDs it enumerates are exactly the ones the
 * document authorizes, in document order, and the key it
 * authenticates is one of them. No verdict while the object is not
 * here.
 */
export async function verifyResolutions(set: VaultEventSet, readObject: ReadObject): Promise<Map<EventId, EvidenceCheck>> {
  const checks = new Map<EventId, EvidenceCheck>();
  for (const event of set.of("peer.resolved")) {
    const { data } = event;
    try {
      const document = await documentOf(data, readObject);
      if (document === null) continue;
      const authentication = authorizedMethodIds(document, "authentication");
      const keyAgreement = authorizedMethodIds(document, "keyAgreement");
      if (!sameIds(authentication, data.authenticationMethodIds)) throw new InvalidDidDocument("the authentication methods are not the document's");
      if (!sameIds(keyAgreement, data.keyAgreementMethodIds)) throw new InvalidDidDocument("the key-agreement methods are not the document's");
      const keys = [...authentication, ...keyAgreement].flatMap((id) => {
        try {
          return [methodPublicKey(document, id)];
        } catch (err) {
          if (err instanceof InvalidDidDocument || err instanceof InvalidPublicKey) return [];
          throw err;
        }
      });
      if (!keys.includes(data.peerPublicKey)) throw new InvalidDidDocument(`${data.peerPublicKey} is not a key the document authorizes`);
      checks.set(event.eventId, "verified");
    } catch (err) {
      if (!(err instanceof InvalidDidDocument || err instanceof InvalidPublicKey)) throw err;
      checks.set(event.eventId, "invalid");
    }
  }
  return checks;
}

/**
 * Every transition's proof checked against the exact predecessor
 * document: a local edge's against the predecessor entity's own
 * document, with `iss` and `sub` the two entities' long forms byte for
 * byte; a peer edge's against the document of the named prior
 * resolution, with `iss` the presented predecessor, `sub` the presented
 * successor and `sub` canonicalizing to the successor DID. An edge
 * whose predecessor document is not here gets no verdict.
 */
export async function verifyTransitions(set: VaultEventSet, routes: RouteFold, readObject: ReadObject): Promise<Map<EventId, EvidenceCheck>> {
  const checks = new Map<EventId, EvidenceCheck>();
  const verdict = async (eventId: EventId, verify: () => Promise<void>) => {
    try {
      await verify();
      checks.set(eventId, "verified");
    } catch (err) {
      if (!(err instanceof InvalidFromPrior || err instanceof InvalidDidDocument)) throw err;
      checks.set(eventId, "invalid");
    }
  };
  for (const edge of set.of("relationship.localTransitioned")) {
    const predecessor = routes.dids.get(edge.data.fromDidId);
    const successor = routes.dids.get(edge.data.toDidId)?.created ?? null;
    if (predecessor === undefined || predecessor.created === null || predecessor.resolution === null || successor === null) continue;
    const { created, resolution } = predecessor;
    await verdict(edge.eventId, async () => {
      const claims = await verifyFromPrior(edge.data.fromPrior, { did: created.did, document: resolution.document });
      if (claims.iss !== created.longFormDid) throw new InvalidFromPrior(`iss is ${claims.iss}, not the predecessor's long form`);
      if (claims.sub !== successor.longFormDid) throw new InvalidFromPrior(`sub is ${claims.sub}, not the successor's long form`);
    });
  }
  for (const edge of set.of("relationship.peerTransitioned")) {
    const prior = set.resolve(edge.data.priorResolutionEventId, "peer.resolved");
    if (prior.status !== "present") continue;
    let document: JsonObject | null;
    try {
      document = await documentOf(prior.event.data, readObject);
    } catch (err) {
      if (!(err instanceof InvalidDidDocument)) throw err;
      checks.set(edge.eventId, "invalid");
      continue;
    }
    if (document === null) continue;
    const pinned = { did: prior.event.data.did, document };
    await verdict(edge.eventId, async () => {
      const claims = await verifyFromPrior(edge.data.fromPrior, pinned);
      if (claims.iss !== edge.data.presentedFromDid) throw new InvalidFromPrior(`iss is ${claims.iss}, not the presented predecessor`);
      if (claims.sub !== edge.data.presentedToDid) throw new InvalidFromPrior(`sub is ${claims.sub}, not the presented successor`);
      if (canonicalDidOf(claims.sub) !== edge.data.toDid) throw new InvalidFromPrior(`sub ${claims.sub} is not ${edge.data.toDid}`);
    });
  }
  return checks;
}

/** The relationship fold with every document consulted: each snapshot and each proof checked once, the verdicts folded back in. */
export async function foldRelationshipsVerified(set: VaultEventSet, routes: RouteFold, readObject: ReadObject): Promise<RelationshipFold> {
  const [resolutionChecks, proofChecks] = await Promise.all([verifyResolutions(set, readObject), verifyTransitions(set, routes, readObject)]);
  return foldRelationships(set, routes, { proofChecks, resolutionChecks });
}
