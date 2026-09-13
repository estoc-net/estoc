/**
 * The relationships: each an unordered pair of birth addresses under a
 * stable ID, with two ends that move independently. The binding pins
 * the root local DID and the exact peer document; the local chain grows
 * by transitions we signed, the peer chain by proofs a carrier brought,
 * each verified against the exact document the chain already holds,
 * never a fresher one. Every check runs as soon as the evidence it
 * needs is here: what contradicts is a conflict, what is not here yet
 * defers the node and every node after it, and canonical time chooses
 * nothing. The address index is every historical local DID against
 * every historical peer DID of every relationship; a pair two
 * relationships claim conflicts them both. Proof verification needs
 * the retained documents and runs beside the fold; an edge whose proof
 * has not been checked is deferred, never applied.
 */

import { isJsonObject, parseStrict } from "@estoc/event-store/v3";
import { isLongForm } from "@estoc/did-peer";

import { InvalidDidDocument, InvalidFromPrior, InvalidIdentifier } from "../errors.js";
import { fromPriorClaims, verifyFromPrior, type PinnedResolution } from "../from-prior.js";
import { didKeyName, relationshipId } from "../ids.js";
import { peerResolution } from "../peer-document.js";
import type { VaultEvent } from "../schema.js";
import type { Cid, ContactId, Did, DidId, DidUrl, EventId, EventReference, KeyName, RelationshipId, VaultData } from "../types.js";
import type { RouteFold } from "./routes.js";
import { groupBy, samePayload, type VaultEventSet } from "./set.js";

export type ProofCheck = "verified" | "invalid";

export interface LocalNode {
  readonly didId: DidId;
  readonly did: Did;
  readonly keyNames: { readonly authentication: KeyName; readonly keyAgreement: KeyName };
  /** the transition that added the node, null for the root */
  readonly edgeEventId: EventId | null;
}

export interface PeerNode {
  readonly did: Did;
  /** the resolution whose document the node is: the binding's for the root, the transition's for a successor */
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
  /** the consistent binding, null while there is none, its evidence is missing, or bindings disagree */
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
  /** what the relationship waits for */
  readonly deferred: readonly string[];
  /** what contradicts: disagreeing bindings or assignments, an edge that cannot stand, a pair another relationship claims */
  readonly faults: readonly string[];
  readonly conflict: boolean;
}

/**
 * A claim on a local/peer address pair that no validated chain yet
 * carries, so a proof-free delivery at that pair must wait rather than
 * form a birth: a committed carrier whose proof names the sender as
 * successor and has no applied transition yet, or a transition that is
 * deferred. The local end is by key; its DID is null while no
 * consistent entity derives the key.
 */
export interface PendingClaim {
  readonly localKeyName: KeyName;
  readonly localDid: Did | null;
  readonly peerDid: Did;
  readonly because: "carrier" | "edge";
  readonly eventIds: readonly EventId[];
  /** a transition for this carrier is in conflict: the claim is conflicting membership, not pending */
  readonly conflict: boolean;
}

export interface RelationshipFold {
  readonly relationships: ReadonlyMap<RelationshipId, Relationship>;
  /** every local DID entity in some validated local chain: retained, whatever its liveness */
  readonly retainedDidIds: ReadonlySet<DidId>;
  /** the status of every transition event, by ID */
  readonly transitions: ReadonlyMap<EventId, TransitionStatus>;
  readonly pendingClaims: readonly PendingClaim[];
  /** the relationships whose validated histories contain this pair, sorted; more than one is a conflict for each */
  claimants(localDid: Did, peerDid: Did): readonly RelationshipId[];
  /** the claims that make a proof-free delivery at this pair wait */
  pendingAt(localDid: Did, peerDid: Did): readonly PendingClaim[];
}

export type RelationshipFoldOptions = { proofChecks?: ReadonlyMap<EventId, ProofCheck> };

type Verdict = { faults: string[]; deferred: string[] };

type Root = { localDidId: DidId; localDid: Did; peerDid: Did; resolution: VaultEvent<"peer.resolved"> };

type LocalEdge = VaultEvent<"relationship.localTransitioned">;
type PeerEdge = VaultEvent<"relationship.peerTransitioned">;

/** One payload's events: equal transitions are one edge, whatever their event IDs. */
type EdgeClass<E extends LocalEdge | PeerEdge> = { events: E[]; data: E["data"] };

const pairKey = (localDid: Did, peerDid: Did) => JSON.stringify([localDid, peerDid]);

export function foldRelationships(set: VaultEventSet, routes: RouteFold, options: RelationshipFoldOptions = {}): RelationshipFold {
  const proofChecks = options.proofChecks ?? new Map<EventId, ProofCheck>();
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
    const bindingEventIds = bindings.map((event) => event.eventId as EventReference<"relationship.bound">);
    const { binding, root } = foldBinding(bindings, set, routes, verdict);
    const confirms = (receipt: VaultEvent<"message.in">, node: LocalNode) =>
      receipt.data.peerResolutionEventId !== null &&
      receipt.data.relationshipBindingEventId !== null &&
      bindingEventIds.includes(receipt.data.relationshipBindingEventId) &&
      (receipt.data.localKeyName === node.keyNames.authentication || receipt.data.localKeyName === node.keyNames.keyAgreement);

    let localChain: LocalNode[] = [];
    let peerChain: PeerNode[] = [];
    let localComplete = false;
    if (root !== null) {
      const local = foldLocalChain(root, localEdges.get(id) ?? [], set, routes, proofChecks, receipts, confirms, verdict, transitions);
      localChain = local.chain;
      localComplete = local.complete;
      const recipientKeyNames = keyNamesOf(localChain);
      peerChain = foldPeerChain(root, peerEdges.get(id) ?? [], set, proofChecks, recipientKeyNames, localComplete, bindingEventIds, receiptsByMessage, verdict, transitions);
    } else {
      for (const edge of [...(localEdges.get(id) ?? []), ...(peerEdges.get(id) ?? [])]) transitions.set(edge.eventId, { status: "deferred", because: "the relationship's binding does not stand" });
    }

    const assignments = assigned.get(id) ?? [];
    const contactIds = [...new Set(assignments.map((event) => event.data.contactId))].sort();
    if (contactIds.length > 1) verdict.faults.push(`assigned to ${contactIds.length} contacts`);

    folded.set(id, {
      relationship: {
        relationshipId: id,
        binding,
        bindingEventIds,
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
 * resolution is here, on the peer's canonical DID and exact document.
 * Equivalent bindings are one; a resolution still missing is noted, and
 * can only add a conflict when it arrives. The root that comes out of
 * it must hold together: resolution taken at the local DID's
 * key-agreement key, distinct addresses deriving the recorded ID.
 */
function foldBinding(bindings: readonly VaultEvent<"relationship.bound">[], set: VaultEventSet, routes: RouteFold, verdict: Verdict): { binding: VaultData["relationship.bound"] | null; root: Root | null } {
  if (bindings.length === 0) {
    verdict.deferred.push("no binding");
    return { binding: null, root: null };
  }
  const localDidIds = new Set(bindings.map((event) => event.data.localDidId));
  if (localDidIds.size > 1) verdict.faults.push("bindings disagree on the root local DID");
  const resolutions: { event: VaultEvent<"relationship.bound">; resolution: VaultEvent<"peer.resolved"> }[] = [];
  let missing = 0;
  for (const event of bindings) {
    const resolved = set.resolve(event.data.peerResolutionEventId, "peer.resolved");
    if (resolved.status === "present") resolutions.push({ event, resolution: resolved.event });
    else if (resolved.status === "missing") missing++;
    else verdict.faults.push(`binding ${event.eventId} names ${resolved.event.type} as its peer resolution`);
  }
  if (new Set(resolutions.map(({ resolution }) => resolution.data.did)).size > 1) verdict.faults.push("bindings disagree on the root peer DID");
  if (new Set(resolutions.map(({ resolution }) => resolution.data.documentCid)).size > 1) verdict.faults.push("bindings disagree on the root peer document");
  if (verdict.faults.length > 0) return { binding: null, root: null };
  if (missing > 0) verdict.deferred.push(`${missing} binding${missing > 1 ? "s name" : " names"} a peer resolution that is not here`);
  const first = resolutions[0];
  if (first === undefined) return { binding: null, root: null };
  const { event, resolution } = first;
  const localDid = routes.dids.get(event.data.localDidId)?.created?.did ?? null;
  const holds = bindingHolds(event.data, resolution.data, localDid);
  if (holds === "contradicted") {
    verdict.faults.push("the binding does not hold: its resolution, local DID and relationship ID disagree");
    return { binding: null, root: null };
  }
  if (localDid === null) {
    verdict.deferred.push(`the root local DID ${event.data.localDidId} is not created`);
    return { binding: event.data, root: null };
  }
  return { binding: event.data, root: { localDidId: event.data.localDidId, localDid, peerDid: resolution.data.did, resolution } };
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

function peerNode(resolution: VaultEvent<"peer.resolved">, edgeEventId: EventId | null): PeerNode {
  const { did, documentCid, keyAgreementMethodIds } = resolution.data;
  return { did, resolutionEventId: resolution.eventId as EventReference<"peer.resolved">, documentCid, keyAgreementMethodIds, edgeEventId };
}

/** Edges grouped by predecessor, equal payloads folded into one class each. */
function classify<E extends LocalEdge | PeerEdge, K>(edges: readonly E[], predecessorOf: (edge: E) => K): Map<K, EdgeClass<E>[]> {
  const classes = new Map<K, EdgeClass<E>[]>();
  for (const edge of edges) {
    const key = predecessorOf(edge);
    const list = classes.get(key) ?? [];
    classes.set(key, list);
    const same = list.find((cls) => samePayload(cls.data, edge.data));
    if (same === undefined) list.push({ events: [edge], data: edge.data });
    else same.events.push(edge);
  }
  return classes;
}

/** The seed's or the documents' verdict on an edge: the first of its equal events that has one. */
function proofCheckOf<E extends LocalEdge | PeerEdge>(cls: EdgeClass<E>, proofChecks: ReadonlyMap<EventId, ProofCheck>): ProofCheck | undefined {
  for (const event of cls.events) {
    const check = proofChecks.get(event.eventId);
    if (check !== undefined) return check;
  }
  return undefined;
}

function settle<E extends LocalEdge | PeerEdge>(cls: EdgeClass<E>, status: TransitionStatus, transitions: Map<EventId, TransitionStatus>): void {
  for (const event of cls.events) transitions.set(event.eventId, status);
}

/**
 * The local chain from the root: at each node the one class of edges
 * leaving it, checked for what can be checked — a cycle, a successor
 * entity that is not one, a proof found invalid, a trigger that is not
 * a confirmation — then for what may still arrive: the proof check, the
 * successor's creation, the predecessor's confirmation. Competing
 * successors of any predecessor conflict whether or not the chain
 * reaches it. `complete` says the chain consumed every edge, so a key
 * outside it is not in this relationship's history for good.
 */
function foldLocalChain(
  root: Root,
  edges: readonly LocalEdge[],
  set: VaultEventSet,
  routes: RouteFold,
  proofChecks: ReadonlyMap<EventId, ProofCheck>,
  receipts: readonly VaultEvent<"message.in">[],
  confirms: (receipt: VaultEvent<"message.in">, node: LocalNode) => boolean,
  verdict: Verdict,
  transitions: Map<EventId, TransitionStatus>
): { chain: LocalNode[]; complete: boolean } {
  const classes = classify(edges, (edge) => edge.data.fromDidId);
  for (const [from, list] of classes) {
    if (list.length > 1) {
      verdict.faults.push(`competing local successors of ${from}`);
      for (const cls of list) settle(cls, { status: "conflict", because: `competing successors of ${from}` }, transitions);
    }
  }
  const chain = [localNode(root.localDidId, root.localDid, null)];
  const inChain = new Set([root.localDidId]);
  const consumed = new Set<EdgeClass<LocalEdge>>();
  let stopped = false;
  for (let node = chain[0]!; !stopped; ) {
    const list = classes.get(node.didId);
    if (list === undefined) break;
    if (list.length > 1) break;
    const cls = list[0]!;
    consumed.add(cls);
    const { toDidId, triggerEventId } = cls.data;
    const faults: string[] = [];
    const deferred: string[] = [];
    if (inChain.has(toDidId)) faults.push(`${toDidId} is already in the local chain`);
    const successor = routes.dids.get(toDidId);
    if (successor === undefined || successor.created === null) deferred.push(`successor ${toDidId} is not created`);
    else if (successor.conflict) faults.push(`successor entity ${toDidId} is in conflict`);
    const check = proofCheckOf(cls, proofChecks);
    if (check === "invalid") faults.push("the proof does not verify against the predecessor's document");
    else if (check === undefined) deferred.push("the proof is not yet verified");
    if (triggerEventId !== null) {
      const trigger = set.resolve(triggerEventId, "message.in");
      if (trigger.status === "mismatched") faults.push(`the trigger ${triggerEventId} is a ${trigger.event.type}`);
      else if (trigger.status === "missing") deferred.push(`the trigger ${triggerEventId} is not here`);
      else if (!confirms(trigger.event, node)) faults.push(`the trigger ${triggerEventId} does not confirm ${node.didId}`);
    }
    if (!receipts.some((receipt) => confirms(receipt, node))) deferred.push(`${node.didId} is not confirmed by input in this relationship`);
    if (faults.length > 0) {
      verdict.faults.push(...faults.map((fault) => `local edge ${node.didId} → ${toDidId}: ${fault}`));
      settle(cls, { status: "conflict", because: faults.join("; ") }, transitions);
      stopped = true;
    } else if (deferred.length > 0) {
      verdict.deferred.push(...deferred.map((why) => `local edge ${node.didId} → ${toDidId}: ${why}`));
      settle(cls, { status: "deferred", because: deferred.join("; ") }, transitions);
      stopped = true;
    } else {
      settle(cls, { status: "applied" }, transitions);
      node = localNode(toDidId, successor!.created!.did, cls.events[0]!.eventId);
      chain.push(node);
      inChain.add(toDidId);
    }
  }
  let complete = !stopped;
  for (const list of classes.values()) {
    if (list.length > 1) {
      complete = false;
      continue;
    }
    const cls = list[0]!;
    if (consumed.has(cls)) continue;
    complete = false;
    verdict.deferred.push(`local edge ${cls.data.fromDidId} → ${cls.data.toDidId}: no rooted prefix reaches it`);
    settle(cls, { status: "deferred", because: "no rooted prefix reaches the edge" }, transitions);
  }
  return { chain, complete };
}

/**
 * The peer chain from the pinned root document. An edge is one class
 * with every equal-payload event; two edges are the same transition
 * when they continue the same predecessor with the same proof to the
 * same successor document, whatever resolution events they name. At
 * each node, the classes leaving it are checked: the named predecessor
 * snapshot must be the chain's own document; the successor's resolution
 * must say what the edge says; the local key must be in the local
 * history; one committed observation of the named message must carry
 * exactly this proof, at this key, from this sender, bound nowhere
 * else; and the proof must have verified. Contradictions conflict;
 * anything absent — a resolution, the witness, the check — defers.
 */
function foldPeerChain(
  root: Root,
  edges: readonly PeerEdge[],
  set: VaultEventSet,
  proofChecks: ReadonlyMap<EventId, ProofCheck>,
  recipientKeyNames: ReadonlySet<KeyName>,
  localComplete: boolean,
  bindingEventIds: readonly EventReference<"relationship.bound">[],
  receiptsByMessage: ReadonlyMap<string, VaultEvent<"message.in">[]>,
  verdict: Verdict,
  transitions: Map<EventId, TransitionStatus>
): PeerNode[] {
  const successors = new Map<PeerEdge, VaultEvent<"peer.resolved"> | null>();
  for (const edge of edges) {
    const resolved = set.resolve(edge.data.peerResolutionEventId, "peer.resolved");
    successors.set(edge, resolved.status === "present" ? resolved.event : null);
  }
  const byPredecessor = groupBy(edges, (edge) => edge.data.fromDid);
  const classes = new Map<Did, { classes: EdgeClass<PeerEdge>[]; unclassified: PeerEdge[] }>();
  for (const [from, list] of byPredecessor) {
    const entry = { classes: [] as EdgeClass<PeerEdge>[], unclassified: [] as PeerEdge[] };
    for (const edge of list) {
      const successor = successors.get(edge);
      if (successor === null || successor === undefined) {
        entry.unclassified.push(edge);
        continue;
      }
      const sameTransition = entry.classes.find((cls) => cls.data.fromPrior === edge.data.fromPrior && cls.data.toDid === edge.data.toDid && successors.get(cls.events[0]!)!.data.documentCid === successor.data.documentCid);
      if (sameTransition === undefined) entry.classes.push({ events: [edge], data: edge.data });
      else sameTransition.events.push(edge);
    }
    classes.set(from, entry);
    if (entry.classes.length > 1) {
      verdict.faults.push(`competing peer successors of ${from}`);
      for (const cls of entry.classes) settle(cls, { status: "conflict", because: `competing successors of ${from}` }, transitions);
    }
  }

  const chain = [peerNode(root.resolution, null)];
  const inChain = new Set([root.peerDid]);
  const consumed = new Set<PeerEdge>();
  let stopped = false;
  for (let node = chain[0]!; !stopped; ) {
    const entry = classes.get(node.did);
    if (entry === undefined) break;
    if (entry.classes.length > 1) break;
    if (entry.classes.length === 0) {
      for (const edge of entry.unclassified) {
        consumed.add(edge);
        verdict.deferred.push(`peer edge ${node.did} → ${edge.data.toDid}: the successor's resolution is not here`);
        transitions.set(edge.eventId, { status: "deferred", because: "the successor's resolution is not here" });
      }
      break;
    }
    const cls = entry.classes[0]!;
    for (const edge of [...cls.events, ...entry.unclassified]) consumed.add(edge);
    const successor = successors.get(cls.events[0]!)!;
    const { toDid, presentedToDid, localKeyName, peerPublicKey, priorResolutionEventId, messageId, fromPrior } = cls.data;
    const faults: string[] = [];
    const deferred: string[] = [];
    if (inChain.has(toDid)) faults.push(`${toDid} is already in the peer chain`);
    const prior = set.resolve(priorResolutionEventId, "peer.resolved");
    if (prior.status === "mismatched") faults.push(`the prior resolution is a ${prior.event.type}`);
    else if (prior.status === "missing") deferred.push("the prior resolution is not here");
    else if (prior.event.data.did !== node.did) faults.push(`the prior resolution is ${prior.event.data.did}'s, not ${node.did}'s`);
    else if (prior.event.data.documentCid !== node.documentCid) faults.push("the prior resolution is not the chain's document");
    if (successor.data.did !== toDid) faults.push(`the successor's resolution is ${successor.data.did}'s, not ${toDid}'s`);
    if (successor.data.presentedDid !== presentedToDid) faults.push("the successor's resolution presents another spelling");
    if (successor.data.localKeyName !== localKeyName) faults.push("the successor's resolution was taken at another key");
    if (successor.data.peerPublicKey !== peerPublicKey) faults.push("the successor's resolution authenticates another key");
    if (!recipientKeyNames.has(localKeyName)) {
      if (localComplete) faults.push(`${localKeyName} is not in the local history`);
      else deferred.push(`${localKeyName} is not yet in the local history`);
    }
    const candidates = receiptsByMessage.get(messageId) ?? [];
    const witness = candidates.some(
      (receipt) =>
        receipt.data.fromPrior === fromPrior &&
        receipt.data.localKeyName === localKeyName &&
        receipt.data.peerResolutionEventId === cls.data.peerResolutionEventId &&
        receipt.data.presentedDid === presentedToDid &&
        receipt.data.did === toDid &&
        (receipt.data.relationshipBindingEventId === null || bindingEventIds.includes(receipt.data.relationshipBindingEventId))
    );
    if (!witness) {
      const elsewhere = candidates.find((receipt) => receipt.data.relationshipBindingEventId !== null && set.resolve(receipt.data.relationshipBindingEventId, "relationship.bound").status === "present" && !bindingEventIds.includes(receipt.data.relationshipBindingEventId));
      if (elsewhere !== undefined) faults.push(`observation ${elsewhere.eventId} of message ${messageId} is bound to another relationship`);
      else deferred.push(candidates.length === 0 ? `no observation of message ${messageId} is here` : `no observation of message ${messageId} carries this proof at this key`);
    }
    const check = proofCheckOf(cls, proofChecks);
    if (check === "invalid") faults.push("the proof does not verify against the pinned predecessor document");
    else if (check === undefined) deferred.push("the proof is not yet verified");
    if (faults.length > 0) {
      verdict.faults.push(...faults.map((fault) => `peer edge ${node.did} → ${toDid}: ${fault}`));
      settle(cls, { status: "conflict", because: faults.join("; ") }, transitions);
      stopped = true;
    } else if (deferred.length > 0 || entry.unclassified.length > 0) {
      for (const edge of entry.unclassified) deferred.push(`edge ${edge.eventId} from the same predecessor names a successor resolution that is not here`);
      verdict.deferred.push(...deferred.map((why) => `peer edge ${node.did} → ${toDid}: ${why}`));
      settle(cls, { status: "deferred", because: deferred.join("; ") }, transitions);
      for (const edge of entry.unclassified) transitions.set(edge.eventId, { status: "deferred", because: "the successor's resolution is not here" });
      stopped = true;
    } else {
      settle(cls, { status: "applied" }, transitions);
      node = peerNode(successor, cls.events[0]!.eventId);
      chain.push(node);
      inChain.add(toDid);
    }
  }
  for (const edge of edges) {
    if (consumed.has(edge) || transitions.has(edge.eventId)) continue;
    const because = successors.get(edge) === null ? "the successor's resolution is not here" : "no rooted prefix reaches the edge";
    verdict.deferred.push(`peer edge ${edge.data.fromDid} → ${edge.data.toDid}: ${because}`);
    transitions.set(edge.eventId, { status: "deferred", because });
  }
  return chain;
}

/**
 * The pairs a proof-free delivery must wait at: each committed carrier
 * whose proof names its authenticated sender as successor and has no
 * applied transition, and each deferred transition, named by the pair
 * it would add to the index.
 */
function foldPendingClaims(set: VaultEventSet, routes: RouteFold, relationships: ReadonlyMap<RelationshipId, Relationship>, transitions: ReadonlyMap<EventId, TransitionStatus>, receipts: readonly VaultEvent<"message.in">[]): PendingClaim[] {
  const localDidOf = (keyName: KeyName): Did | null => {
    const didId = routes.entityOfKey(keyName);
    return didId === null ? null : (routes.dids.get(didId)?.created?.did ?? null);
  };
  const edgesByMessage = new Map<string, TransitionStatus[]>();
  for (const edge of set.of("relationship.peerTransitioned")) {
    const list = edgesByMessage.get(edge.data.messageId) ?? [];
    edgesByMessage.set(edge.data.messageId, list);
    list.push(transitions.get(edge.eventId)!);
  }
  const claims = new Map<string, { localKeyName: KeyName; localDid: Did | null; peerDid: Did; because: PendingClaim["because"]; eventIds: EventId[]; conflict: boolean }>();
  const claim = (localKeyName: KeyName, peerDid: Did, because: PendingClaim["because"], eventId: EventId, conflict: boolean) => {
    const key = JSON.stringify([localKeyName, peerDid, because]);
    const known = claims.get(key);
    if (known === undefined) claims.set(key, { localKeyName, localDid: localDidOf(localKeyName), peerDid, because, eventIds: [eventId], conflict });
    else {
      known.eventIds.push(eventId);
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
    const statuses = edgesByMessage.get(messageId) ?? [];
    if (statuses.some((status) => status.status === "applied")) continue;
    claim(localKeyName, did, "carrier", receipt.eventId, statuses.some((status) => status.status === "conflict"));
  }
  for (const edge of set.of("relationship.peerTransitioned")) {
    if (transitions.get(edge.eventId)?.status !== "deferred") continue;
    claim(edge.data.localKeyName, edge.data.toDid, "edge", edge.eventId, false);
  }
  for (const edge of set.of("relationship.localTransitioned")) {
    if (transitions.get(edge.eventId)?.status !== "deferred") continue;
    const peers = relationships.get(edge.data.relationshipId)?.peerChain ?? [];
    for (const peer of peers) claim(didKeyName(edge.data.toDidId, "key-agreement"), peer.did, "edge", edge.eventId, false);
  }
  return [...claims.values()].sort((a, b) => (a.localKeyName < b.localKeyName ? -1 : a.localKeyName > b.localKeyName ? 1 : a.peerDid < b.peerDid ? -1 : a.peerDid > b.peerDid ? 1 : a.because < b.because ? -1 : a.because > b.because ? 1 : 0));
}

/** Reads the retained document an event's CID names: null while the object is not here. */
export type ReadObject = (cid: Cid) => Promise<Uint8Array | null>;

/**
 * The pinned document a resolution names, as the vault retains it: for
 * a numalgo-4 long form it is derived from the spelling itself and must
 * match the recorded CID; for anything else it is read from the object
 * store. Null while the object is not here.
 */
async function pinnedDocumentOf(resolution: VaultData["peer.resolved"], readObject: ReadObject): Promise<PinnedResolution | null> {
  if (isLongForm(resolution.presentedDid)) {
    const derived = peerResolution(resolution.presentedDid);
    if (derived.did !== resolution.did) throw new InvalidDidDocument(`the long form is ${derived.did}'s, not ${resolution.did}'s`);
    if (derived.cid !== resolution.documentCid) throw new InvalidDidDocument(`the long form derives ${derived.cid}, not the recorded ${resolution.documentCid}`);
    return { did: resolution.did, document: derived.document };
  }
  const bytes = await readObject(resolution.documentCid);
  if (bytes === null) return null;
  let document: unknown;
  try {
    document = parseStrict(bytes);
  } catch (err) {
    throw new InvalidDidDocument(`the retained document is not strict JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isJsonObject(document)) throw new InvalidDidDocument("the retained document is a JSON object");
  return { did: resolution.did, document };
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
export async function verifyTransitions(set: VaultEventSet, routes: RouteFold, readObject: ReadObject): Promise<Map<EventId, ProofCheck>> {
  const checks = new Map<EventId, ProofCheck>();
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
    let pinned: PinnedResolution | null;
    try {
      pinned = await pinnedDocumentOf(prior.event.data, readObject);
    } catch (err) {
      if (!(err instanceof InvalidDidDocument)) throw err;
      checks.set(edge.eventId, "invalid");
      continue;
    }
    if (pinned === null) continue;
    const document = pinned;
    await verdict(edge.eventId, async () => {
      const claims = await verifyFromPrior(edge.data.fromPrior, document);
      if (claims.iss !== edge.data.presentedFromDid) throw new InvalidFromPrior(`iss is ${claims.iss}, not the presented predecessor`);
      if (claims.sub !== edge.data.presentedToDid) throw new InvalidFromPrior(`sub is ${claims.sub}, not the presented successor`);
      if (canonicalOf(claims.sub) !== edge.data.toDid) throw new InvalidFromPrior(`sub ${claims.sub} is not ${edge.data.toDid}`);
    });
  }
  return checks;
}

function canonicalOf(did: Did): Did {
  return isLongForm(did) ? peerResolution(did).did : did;
}

/** The relationship fold with every proof checked: the documents consulted once per edge, the verdicts folded back in. */
export async function foldRelationshipsVerified(set: VaultEventSet, routes: RouteFold, readObject: ReadObject): Promise<RelationshipFold> {
  return foldRelationships(set, routes, { proofChecks: await verifyTransitions(set, routes, readObject) });
}
