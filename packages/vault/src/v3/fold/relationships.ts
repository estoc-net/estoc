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
 * chooses nothing. A contradiction in any observation of a message
 * conflicts every edge the message witnesses or confirms; an
 * observation still waiting for its own scope holds back nothing but
 * itself. The two chains depend on each other — a local edge needs
 * input the peer chain gives scope to, a peer edge needs a local key
 * the local chain retains — so they are folded together until nothing
 * changes. The address index is every historical local DID
 * against every historical peer DID of every relationship; a pair two
 * relationships claim conflicts them both. What needs the retained
 * documents — whether a proof verifies, whether a resolution's
 * snapshot is the document it says — runs beside the fold as
 * `verifyTransitions` and `verifyResolutions`; an edge or a root whose
 * verdict is not in is deferred, never applied.
 */

import { canonicalText, canonicalize, isJsonObject, parseStrict, type JsonObject } from "@estoc/event-store/v3";
import { isLongForm } from "@estoc/did-peer";

import { rawCidOfBytes } from "../document.js";
import { InvalidDidDocument, InvalidFromPrior, InvalidIdentifier, InvalidPublicKey } from "../errors.js";
import { fromPriorClaims, verifyFromPrior } from "../from-prior.js";
import { didKeyName, inboundMessageId, relationshipId } from "../ids.js";
import { authorizedMethodIds, canonicalDidOf, methodPublicKey, peerResolution } from "../peer-document.js";
import type { VaultEvent } from "../schema.js";
import type { Cid, ContactId, Did, DidId, DidUrl, EventId, EventReference, KeyName, RelationshipId, VaultData } from "../types.js";
import type { RouteFold } from "./routes.js";
import { groupBy, type VaultEventSet } from "./set.js";

/** A verdict on a proof or a snapshot from evidence outside the event set: the documents. */
export type EvidenceCheck = "verified" | "invalid";

export interface LocalNode {
  readonly didId: DidId;
  readonly did: Did;
  readonly keyNames: { readonly authentication: KeyName; readonly keyAgreement: KeyName };
  /** every applied transition that adds the node, in canonical order; none for the root */
  readonly edgeEventIds: readonly EventId[];
}

/** A peer address in a chain, with the exact document pinned for it: the binding's for the root, the transition's for a successor. */
export interface PeerNode {
  readonly did: Did;
  readonly resolutionEventId: EventReference<"peer.resolved">;
  readonly documentCid: Cid;
  readonly keyAgreementMethodIds: readonly DidUrl[];
  /** every applied transition that adds the node, in canonical order; none for the root */
  readonly edgeEventIds: readonly EventId[];
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

type Judged<E> = { edge: E; faults: string[]; deferred: string[] };

type Context = {
  set: VaultEventSet;
  routes: RouteFold;
  proofChecks: ReadonlyMap<EventId, EvidenceCheck>;
  resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>;
  receipts: readonly Receipt[];
  receiptsByMessage: ReadonlyMap<string, Receipt[]>;
  relationshipId: RelationshipId;
  bindingEventIds: readonly EventReference<"relationship.bound">[];
  peerEdges: readonly PeerEdge[];
  /** every key a local node could have: the bindings' root DIDs' and every local edge's successor's */
  namedKeyNames: ReadonlySet<KeyName>;
};

const pairKey = (localDid: Did, peerDid: Did) => JSON.stringify([localDid, peerDid]);
const NO_CHECKS: ReadonlyMap<EventId, EvidenceCheck> = new Map();
const PEER4_PREFIX = "did:peer:4";

/** Control input starts no rotation, whatever else it may confirm. */
const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set(["https://didcomm.org/empty/1.0/empty", "https://didcomm.org/trust-ping/2.0/ping-response", "https://didcomm.org/report-problem/2.0/problem-report"]);

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
    const context: Context = {
      set,
      routes,
      proofChecks,
      resolutionChecks,
      receipts,
      receiptsByMessage,
      relationshipId: id,
      bindingEventIds: bindings.map((event) => event.eventId as EventReference<"relationship.bound">),
      peerEdges: peerEdges.get(id) ?? [],
      namedKeyNames: namedKeyNames([...bindings.map((event) => event.data.localDidId), ...(localEdges.get(id) ?? []).map((edge) => edge.data.toDidId)]),
    };
    const { binding, root } = foldBinding(bindings, context, verdict);

    let localChain: LocalNode[] = [];
    let peerChain: PeerNode[] = [];
    if (root !== null) {
      const chains = foldChains(root, localEdges.get(id) ?? [], peerEdges.get(id) ?? [], context, verdict, transitions);
      localChain = chains.local;
      peerChain = chains.peer;
    } else judgeUnrooted(localEdges.get(id) ?? [], peerEdges.get(id) ?? [], context, verdict, transitions);

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
  return namedKeyNames(chain.map((node) => node.didId));
}

function namedKeyNames(didIds: readonly DidId[]): Set<KeyName> {
  const names = new Set<KeyName>();
  for (const didId of didIds) names.add(didKeyName(didId, "authentication")).add(didKeyName(didId, "key-agreement"));
  return names;
}

function localNode(didId: DidId, did: Did, edgeEventIds: readonly EventId[]): LocalNode {
  return { didId, did, keyNames: { authentication: didKeyName(didId, "authentication"), keyAgreement: didKeyName(didId, "key-agreement") }, edgeEventIds };
}

function peerNode(resolution: Resolution, edgeEventIds: readonly EventId[]): PeerNode {
  const { did, documentCid, keyAgreementMethodIds } = resolution.data;
  return { did, resolutionEventId: resolution.eventId as EventReference<"peer.resolved">, documentCid, keyAgreementMethodIds, edgeEventIds };
}

type Chains = { local: LocalNode[]; peer: PeerNode[]; nodeByEdge: ReadonlyMap<EventId, PeerNode> };

/**
 * What one pass judges every edge and observation against: the chains
 * as the last pass left them, whether a root stands at all, and the
 * observations already judged against those chains.
 */
type Evidence = {
  context: Context;
  rooted: boolean;
  recipientKeyNames: ReadonlySet<KeyName>;
  peerChain: readonly PeerNode[];
  nodeByEdge: ReadonlyMap<EventId, PeerNode>;
  scopes: Map<string, Verdict>;
  conflicts: Map<string, string | null>;
};

function evidenceOf(context: Context, chains: Chains, rooted: boolean): Evidence {
  return { context, rooted, recipientKeyNames: keyNamesOf(chains.local), peerChain: chains.peer, nodeByEdge: chains.nodeByEdge, scopes: new Map(), conflicts: new Map() };
}

/**
 * Where a key stands in the local history: `in` it; `awaited` while no
 * root stands or while a local edge that would add it is not applied;
 * `outside` when nothing in this relationship could ever add it. The
 * edges name what could be added, so the answer never flips as the
 * chain grows.
 */
function keyStanding(evidence: Evidence, keyName: KeyName): "in" | "awaited" | "outside" {
  if (evidence.recipientKeyNames.has(keyName)) return "in";
  return !evidence.rooted || evidence.context.namedKeyNames.has(keyName) ? "awaited" : "outside";
}

/** Everything a pass judges against, as text: the nodes of the two chains and the applied edges at each. */
const chainsKey = (chains: Chains) => canonicalText({ local: chains.local.map((node) => [node.didId, node.edgeEventIds]), peer: chains.peer.map((node) => [node.did, node.documentCid, node.edgeEventIds]) });

/**
 * The two chains folded together until nothing changes: each pass
 * judges every edge against the chains the last pass produced, and the
 * last pass is the verdict. What contradicts is judged from the events
 * alone, never from the chains, so a pass takes back nothing an
 * earlier one applied: each change adds a node or an applied edge to a
 * chain, the passes are bounded by the edges, and the result is the
 * same from any order of events.
 */
function foldChains(root: Root, localEdges: readonly LocalEdge[], peerEdges: readonly PeerEdge[], context: Context, verdict: Verdict, transitions: Map<EventId, TransitionStatus>): { local: LocalNode[]; peer: PeerNode[] } {
  let chains: Chains = { local: [localNode(root.localDidId, root.localDid, [])], peer: [peerNode(root.resolution, [])], nodeByEdge: new Map() };
  for (let passes = localEdges.length + peerEdges.length + 2; ; passes--) {
    const found: Verdict = { faults: [], deferred: [] };
    const statuses = new Map<EventId, TransitionStatus>();
    const evidence = evidenceOf(context, chains, true);
    const local = foldLocalChain(root, localEdges, evidence, found, statuses);
    const peer = foldPeerChain(root, peerEdges, evidence, found, statuses);
    const next: Chains = { local, peer: peer.chain, nodeByEdge: peer.nodeByEdge };
    const changed = chainsKey(next) !== chainsKey(chains);
    chains = next;
    if (changed && passes > 0) continue;
    verdict.faults.push(...found.faults);
    verdict.deferred.push(...found.deferred);
    for (const [eventId, status] of statuses) transitions.set(eventId, status);
    return { local: chains.local, peer: chains.peer };
  }
}

/**
 * While the binding does not stand, an edge is judged against empty
 * chains: what needs no root — a proof found invalid, a reference of
 * another type, a snapshot that says otherwise, a trigger that could
 * never confirm — is a conflict now; everything else waits.
 */
function judgeUnrooted(localEdges: readonly LocalEdge[], peerEdges: readonly PeerEdge[], context: Context, verdict: Verdict, transitions: Map<EventId, TransitionStatus>): void {
  const evidence = evidenceOf(context, { local: [], peer: [], nodeByEdge: new Map() }, false);
  const judged: Judged<LocalEdge | PeerEdge>[] = [...localEdges.map((edge) => judgeLocalEdge(edge, evidence)), ...peerEdges.map((edge) => judgePeerEdge(edge, evidence))];
  for (const item of judged) {
    if (item.faults.length > 0) {
      verdict.faults.push(...item.faults.map((fault) => `${describeEdge(item.edge)}: ${fault}`));
      transitions.set(item.edge.eventId, { status: "conflict", because: item.faults.join("; ") });
    } else transitions.set(item.edge.eventId, { status: "deferred", because: [...item.deferred, "the relationship's binding does not stand"].join("; ") });
  }
}

function describeEdge(edge: LocalEdge | PeerEdge): string {
  return edge.type === "relationship.localTransitioned" ? `local edge ${edge.data.fromDidId} → ${edge.data.toDidId}` : `peer edge ${edge.data.fromDid} → ${edge.data.toDid}`;
}

/**
 * The resolution an observation names, once it is here, checked against
 * its document, and says what the observation says: the same local key,
 * canonical DID and presented spelling, and the observation's message
 * ID derived from that key and its wire ID. `missing` while the
 * resolution is absent or its verdict is not in; `contradicted` when it
 * disagrees or is not its document's, an observation no claim can rest
 * on.
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
  const check = context.resolutionChecks.get(resolved.event.eventId);
  if (check === "invalid") return { status: "contradicted" };
  if (check === undefined) return { status: "missing" };
  return { status: "present", resolution: resolved.event };
}

/** Does this observation carry exactly the proof a peer edge names, at its key, from its successor, bound to this relationship if bound at all? */
function witnesses(bindingEventIds: readonly EventReference<"relationship.bound">[], receipt: Receipt, edge: PeerEdge["data"]): boolean {
  const { data } = receipt;
  return (
    data.messageId === edge.messageId &&
    data.fromPrior === edge.fromPrior &&
    data.localKeyName === edge.localKeyName &&
    data.peerResolutionEventId === edge.peerResolutionEventId &&
    data.presentedDid === edge.presentedToDid &&
    data.did === edge.toDid &&
    (data.relationshipBindingEventId === null || bindingEventIds.includes(data.relationshipBindingEventId))
  );
}

/** One proof from one predecessor DID to one successor DID, pinning one document: the same successor reference, or successor snapshots here with one CID. */
function sameTransition(context: Context, a: PeerEdge["data"], b: PeerEdge["data"]): boolean {
  if (a.fromDid !== b.fromDid || a.fromPrior !== b.fromPrior || a.toDid !== b.toDid) return false;
  if (a.peerResolutionEventId === b.peerResolutionEventId) return true;
  const cidOf = (edge: PeerEdge["data"]) => {
    const resolved = context.set.resolve(edge.peerResolutionEventId, "peer.resolved");
    return resolved.status === "present" ? resolved.event.data.documentCid : null;
  };
  const cid = cidOf(a);
  return cid !== null && cid === cidOf(b);
}

/**
 * One observation's scope in this relationship, by the row it claims:
 * what contradicts is judged from the events it names, what it waits
 * for from the chains so far. An applied transition equal to the one a
 * proof-free successor names scopes it, since equal edges are one
 * transition; the transition under judgement stands in for the applied
 * one a carrier or a proof-free successor waits for, when it is that
 * transition or equal to it, since otherwise the edge would wait for
 * its observations and they for the edge. Nothing else is taken on
 * trust.
 */
function observationScope(evidence: Evidence, receipt: Receipt, judging: PeerEdge | null): Verdict {
  const key = judging === null ? receipt.eventId : `${receipt.eventId} ${judging.eventId}`;
  const known = evidence.scopes.get(key);
  if (known !== undefined) return known;
  const scope = judgeObservation(evidence, receipt, judging);
  evidence.scopes.set(key, scope);
  return scope;
}

function judgeObservation(evidence: Evidence, receipt: Receipt, judging: PeerEdge | null): Verdict {
  const { context } = evidence;
  const faults: string[] = [];
  const deferred: string[] = [];
  const { relationshipBindingEventId, peerTransitionEventId, fromPrior, localKeyName, presentedDid } = receipt.data;
  const auth = authenticated(context, receipt);
  if (auth.status === "contradicted") faults.push("contradicts its resolution");
  else if (auth.status === "missing") deferred.push("awaits its resolution");
  if (relationshipBindingEventId !== null) {
    const binding = context.set.resolve(relationshipBindingEventId, "relationship.bound");
    if (binding.status === "mismatched") faults.push(`names ${binding.event.type} as its binding`);
    else if (binding.status === "missing") deferred.push("awaits its binding");
    else if (binding.event.data.relationshipId !== context.relationshipId) faults.push("is bound to another relationship");
  }
  const standing = keyStanding(evidence, localKeyName);
  if (standing === "outside") faults.push("arrived at a key outside the local history");
  else if (standing === "awaited") deferred.push("arrived at a key not yet in the local history");
  const notFrom = (did: Did, documentCid: Cid | null) => auth.status === "present" && (auth.resolution.data.did !== did || (documentCid !== null && auth.resolution.data.documentCid !== documentCid));
  const stands = (transition: PeerEdge) => context.peerEdges.some((edge) => (evidence.nodeByEdge.has(edge.eventId) || (judging !== null && edge === judging)) && sameTransition(context, edge.data, transition.data));
  if (fromPrior === null) {
    if (relationshipBindingEventId === null) faults.push("carries neither a proof nor a binding");
    else if (peerTransitionEventId === null) {
      const root = evidence.peerChain[0];
      if (root === undefined) deferred.push("awaits the root");
      else if (notFrom(root.did, root.documentCid)) faults.push("is not from the document the root pins");
    } else {
      const transition = context.set.resolve(peerTransitionEventId, "relationship.peerTransitioned");
      if (transition.status === "mismatched") faults.push(`names ${transition.event.type} as its transition`);
      else if (transition.status === "missing") deferred.push("awaits the transition it names");
      else if (transition.event.data.relationshipId !== context.relationshipId) faults.push("names a transition of another relationship");
      else {
        const successor = context.set.resolve(transition.event.data.peerResolutionEventId, "peer.resolved");
        if (notFrom(transition.event.data.toDid, successor.status === "present" ? successor.event.data.documentCid : null)) faults.push("is not from the document the transition it names pins");
        else if (!stands(transition.event)) deferred.push("awaits the transition it names");
      }
    }
  } else {
    let sub: string | null = null;
    try {
      sub = fromPriorClaims(fromPrior).sub;
    } catch (err) {
      if (!(err instanceof InvalidFromPrior)) throw err;
    }
    if (sub === null) faults.push("carries a proof that does not parse");
    else if (sub !== presentedDid) faults.push("carries a proof that does not name its sender");
    const carrying = context.peerEdges.filter((edge) => witnesses(context.bindingEventIds, receipt, edge.data));
    const verdicts = carrying.map((edge) => context.proofChecks.get(edge.eventId));
    if (verdicts.includes("invalid") && !verdicts.includes("verified")) faults.push("carries a proof found invalid");
    else if (!carrying.some((edge) => evidence.nodeByEdge.has(edge.eventId) || (judging !== null && sameTransition(context, edge.data, judging.data)))) deferred.push("awaits the transition carrying its proof");
  }
  return { faults, deferred };
}

/**
 * What contradicts among the observations of one message ID in this
 * relationship: a disagreement on the intent, or any observation whose
 * row contradicts. Such a group witnesses no proof and confirms no
 * address; an observation still waiting holds back only itself.
 */
function groupConflict(evidence: Evidence, messageId: string, judging: PeerEdge | null): string | null {
  const key = judging === null ? messageId : `${messageId} ${judging.eventId}`;
  const known = evidence.conflicts.get(key);
  if (known !== undefined) return known;
  const observations = evidence.context.receiptsByMessage.get(messageId) ?? [];
  const conflicts: string[] = [];
  if (observations.some((receipt) => receipt.data.intentHash !== observations[0]!.data.intentHash)) conflicts.push(`the observations of message ${messageId} disagree on the intent`);
  for (const receipt of observations) conflicts.push(...observationScope(evidence, receipt, judging).faults.map((fault) => `observation ${receipt.eventId} of message ${messageId} ${fault}`));
  const conflict = conflicts.length > 0 ? conflicts.join("; ") : null;
  evidence.conflicts.set(key, conflict);
  return conflict;
}

/** One observation as a witness or a confirmation: its group must not contradict, and its own row must be complete. */
function standingOf(evidence: Evidence, receipt: Receipt, judging: PeerEdge | null): { status: "complete" } | { status: "incomplete"; because: string } | { status: "conflict"; because: string } {
  const conflict = groupConflict(evidence, receipt.data.messageId, judging);
  if (conflict !== null) return { status: "conflict", because: conflict };
  const { deferred } = observationScope(evidence, receipt, judging);
  return deferred.length > 0 ? { status: "incomplete", because: deferred.map((why) => `observation ${receipt.eventId} of message ${receipt.data.messageId} ${why}`).join("; ") } : { status: "complete" };
}

/**
 * A local edge judged on its own evidence, in every order the same:
 * the successor's entity, the proof's verdict, the trigger it names,
 * and whether an observation at the predecessor's own keys, complete
 * in a group that does not contradict, confirms it. The trigger must
 * itself be such a confirmation and application input, since control
 * input starts no rotation. Conflicts and absences are both collected
 * in full.
 */
function judgeLocalEdge(edge: LocalEdge, evidence: Evidence): Judged<LocalEdge> {
  const { context } = evidence;
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
  const confirms = (receipt: Receipt) => (predecessorKeys.has(receipt.data.localKeyName) ? standingOf(evidence, receipt, null) : { status: "none" as const });
  if (triggerEventId !== null) {
    const trigger = context.set.resolve(triggerEventId, "message.in");
    if (trigger.status === "mismatched") faults.push(`the trigger ${triggerEventId} is a ${trigger.event.type}`);
    else if (trigger.status === "missing") deferred.push(`the trigger ${triggerEventId} is not here`);
    else {
      if (CONTROL_MESSAGE_TYPES.has(trigger.event.data.msgType)) faults.push(`the trigger ${triggerEventId} is control input, which starts no rotation`);
      const confirmation = confirms(trigger.event);
      if (confirmation.status === "none") faults.push(`the trigger ${triggerEventId} does not confirm ${fromDidId}`);
      else if (confirmation.status === "conflict") faults.push(`the trigger ${triggerEventId} does not confirm ${fromDidId}: ${confirmation.because}`);
      else if (confirmation.status === "incomplete") deferred.push(`the trigger ${triggerEventId} awaits its evidence: ${confirmation.because}`);
    }
  }
  if (!context.receipts.some((receipt) => confirms(receipt).status === "complete")) deferred.push(`${fromDidId} is not confirmed by input in this relationship`);
  return { edge, faults, deferred };
}

/**
 * A peer edge judged on its own evidence, in every order the same: the
 * prior and successor resolutions it names and their snapshot verdicts,
 * the successor's agreement with the edge, the local key's standing in
 * the local history, a complete witness in a group that does not
 * contradict — judged with this edge as the transition its carriers
 * await — and the proof's verdict. Conflicts and absences are both
 * collected in full.
 */
function judgePeerEdge(edge: PeerEdge, evidence: Evidence): Judged<PeerEdge> & { successor: Resolution | null } {
  const { context } = evidence;
  const { fromDid, toDid, presentedToDid, localKeyName, peerPublicKey, priorResolutionEventId, peerResolutionEventId, messageId } = edge.data;
  const faults: string[] = [];
  const deferred: string[] = [];
  const prior = context.set.resolve(priorResolutionEventId, "peer.resolved");
  if (prior.status === "mismatched") faults.push(`the prior resolution is a ${prior.event.type}`);
  else if (prior.status === "missing") deferred.push("the prior resolution is not here");
  else {
    if (prior.event.data.did !== fromDid) faults.push(`the prior resolution is ${prior.event.data.did}'s, not ${fromDid}'s`);
    const check = context.resolutionChecks.get(prior.event.eventId);
    if (check === "invalid") faults.push("the prior resolution is not its document's");
    else if (check === undefined) deferred.push("the prior resolution is not yet verified against its document");
  }
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
  const standing = keyStanding(evidence, localKeyName);
  if (standing === "outside") faults.push(`${localKeyName} is not in the local history`);
  else if (standing === "awaited") deferred.push(`${localKeyName} is not yet in the local history`);
  const candidates = context.receiptsByMessage.get(messageId) ?? [];
  const conflict = groupConflict(evidence, messageId, edge);
  if (conflict !== null) faults.push(conflict);
  else {
    const carrying = candidates.filter((receipt) => witnesses(context.bindingEventIds, receipt, edge.data)).map((receipt) => standingOf(evidence, receipt, edge));
    if (carrying.length === 0) deferred.push(candidates.length === 0 ? `no observation of message ${messageId} is here` : `no observation of message ${messageId} carries this proof at this key`);
    else if (!carrying.some((witness) => witness.status === "complete")) deferred.push(...carrying.flatMap((witness) => (witness.status === "incomplete" ? [witness.because] : [])));
  }
  const check = context.proofChecks.get(edge.eventId);
  if (check === "invalid") faults.push("the proof does not verify against the pinned predecessor document");
  else if (check === undefined) deferred.push("the proof is not yet verified");
  return { edge, faults, deferred, successor };
}

/**
 * Equal transitions among the judged edges, grouped by predecessor. An
 * edge with a fault of its own is settled first and never grouped; a
 * class whose members contradict each other is settled as a whole; a
 * predecessor with more than one class has competing successors, and
 * every edge leaving it conflicts.
 */
function classesOf<E extends LocalEdge | PeerEdge, K>(judged: readonly Judged<E>[], describe: (edge: E) => string, predecessorOf: (edge: E) => K, classKey: (edge: E) => string, contradiction: (cls: readonly Judged<E>[]) => string | null, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): Map<K, Judged<E>[][]> {
  const classes = new Map<K, Judged<E>[][]>();
  const keys = new Map<Judged<E>[], string>();
  for (const item of judged) {
    if (item.faults.length > 0) {
      verdict.faults.push(...item.faults.map((fault) => `${describe(item.edge)}: ${fault}`));
      statuses.set(item.edge.eventId, { status: "conflict", because: item.faults.join("; ") });
      continue;
    }
    const list = classes.get(predecessorOf(item.edge)) ?? [];
    classes.set(predecessorOf(item.edge), list);
    const key = classKey(item.edge);
    const same = list.find((cls) => keys.get(cls) === key);
    if (same === undefined) {
      list.push([item]);
      keys.set(list.at(-1)!, key);
    } else same.push(item);
  }
  for (const [from, list] of classes) {
    for (const cls of list) {
      const because = contradiction(cls);
      if (because === null) continue;
      verdict.faults.push(`${describe(cls[0]!.edge)}: ${because}`);
      for (const item of cls) statuses.set(item.edge.eventId, { status: "conflict", because });
    }
    if (list.length < 2) continue;
    verdict.faults.push(`competing successors of ${String(from)}`);
    for (const cls of list) for (const item of cls) statuses.set(item.edge.eventId, { status: "conflict", because: `competing successors of ${String(from)}` });
  }
  return classes;
}

/** A class applies when one of its equal edges is complete; the others keep their own absences on record until their evidence is in. */
function settleClass<E extends LocalEdge | PeerEdge>(cls: readonly Judged<E>[], describe: (edge: E) => string, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): Judged<E>[] {
  const applied = cls.filter((item) => item.deferred.length === 0);
  for (const item of cls) {
    if (item.deferred.length === 0) statuses.set(item.edge.eventId, { status: "applied" });
    else {
      if (applied.length === 0) verdict.deferred.push(...item.deferred.map((why) => `${describe(item.edge)}: ${why}`));
      statuses.set(item.edge.eventId, { status: "deferred", because: item.deferred.join("; ") });
    }
  }
  return applied;
}

/** Every class the walk did not reach: its edges wait for a rooted prefix, or for their own evidence. */
function settleUnreached<E extends LocalEdge | PeerEdge, K>(classes: ReadonlyMap<K, Judged<E>[][]>, reached: ReadonlySet<Judged<E>[]>, describe: (edge: E) => string, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): void {
  for (const list of classes.values()) {
    if (list.length > 1) continue;
    for (const cls of list) {
      if (reached.has(cls)) continue;
      if (statuses.get(cls[0]!.edge.eventId)?.status === "conflict") continue;
      for (const item of cls) {
        const because = [...item.deferred, "no rooted prefix reaches the edge"].join("; ");
        verdict.deferred.push(`${describe(item.edge)}: ${because}`);
        statuses.set(item.edge.eventId, { status: "deferred", because });
      }
    }
  }
}

function foldLocalChain(root: Root, edges: readonly LocalEdge[], evidence: Evidence, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): LocalNode[] {
  const { context } = evidence;
  const judged = edges.map((edge) => judgeLocalEdge(edge, evidence));
  const classes = classesOf(judged, describeEdge, (edge) => edge.data.fromDidId, (edge) => canonicalText(edge.data), () => null, verdict, statuses);
  const chain = [localNode(root.localDidId, root.localDid, [])];
  const inChain = new Set([root.localDidId]);
  const reached = new Set<Judged<LocalEdge>[]>();
  for (let node = chain[0]!; ; ) {
    const list = classes.get(node.didId);
    if (list === undefined || list.length !== 1) break;
    const cls = list[0]!;
    reached.add(cls);
    const { toDidId } = cls[0]!.edge.data;
    if (statuses.get(cls[0]!.edge.eventId)?.status === "conflict") break;
    if (inChain.has(toDidId)) {
      verdict.faults.push(`${describeEdge(cls[0]!.edge)}: ${toDidId} is already in the local chain`);
      for (const item of cls) statuses.set(item.edge.eventId, { status: "conflict", because: `${toDidId} is already in the local chain` });
      break;
    }
    const applied = settleClass(cls, describeEdge, verdict, statuses);
    if (applied.length === 0) break;
    node = localNode(toDidId, context.routes.dids.get(toDidId)!.created!.did, applied.map((item) => item.edge.eventId));
    chain.push(node);
    inChain.add(toDidId);
  }
  settleUnreached(classes, reached, describeEdge, verdict, statuses);
  return chain;
}

/**
 * Peer edges are the same transition when they carry one proof to one
 * successor DID; their successor snapshots must then be one document.
 * A snapshot not here yet is not a second document, so such a
 * duplicate shares the class and waits on its own; two snapshots here
 * that differ contradict the class.
 */
function foldPeerChain(root: Root, edges: readonly PeerEdge[], evidence: Evidence, verdict: Verdict, statuses: Map<EventId, TransitionStatus>): { chain: PeerNode[]; nodeByEdge: ReadonlyMap<EventId, PeerNode> } {
  const { context } = evidence;
  const judged = edges.map((edge) => judgePeerEdge(edge, evidence));
  const successorOf = new Map(judged.map((item) => [item.edge, item.successor] as const));
  const twoDocuments = (cls: readonly Judged<PeerEdge>[]) => (new Set(cls.flatMap((item) => (successorOf.get(item.edge) === null ? [] : [successorOf.get(item.edge)!.data.documentCid]))).size > 1 ? "one proof pins two successor documents" : null);
  const classes = classesOf(judged, describeEdge, (edge) => edge.data.fromDid, (edge) => canonicalText([edge.data.fromPrior, edge.data.toDid]), twoDocuments, verdict, statuses);
  const chain = [peerNode(root.resolution, [])];
  const nodeByEdge = new Map<EventId, PeerNode>();
  const inChain = new Set([root.peerDid]);
  const reached = new Set<Judged<PeerEdge>[]>();
  for (let node = chain[0]!; ; ) {
    const list = classes.get(node.did);
    if (list === undefined || list.length !== 1) break;
    const cls = list[0]!;
    reached.add(cls);
    if (statuses.get(cls[0]!.edge.eventId)?.status === "conflict") break;
    const { toDid } = cls[0]!.edge.data;
    const faults: string[] = [];
    if (inChain.has(toDid)) faults.push(`${toDid} is already in the peer chain`);
    for (const item of cls) {
      const prior = context.set.resolve(item.edge.data.priorResolutionEventId, "peer.resolved");
      if (prior.status === "present" && prior.event.data.documentCid !== node.documentCid) faults.push("the prior resolution is not the chain's document");
    }
    if (faults.length > 0) {
      verdict.faults.push(...faults.map((fault) => `${describeEdge(cls[0]!.edge)}: ${fault}`));
      for (const item of cls) statuses.set(item.edge.eventId, { status: "conflict", because: faults.join("; ") });
      break;
    }
    const applied = settleClass(cls, describeEdge, verdict, statuses);
    if (applied.length === 0) break;
    node = peerNode(successorOf.get(applied[0]!.edge)!, applied.map((item) => item.edge.eventId));
    for (const item of applied) nodeByEdge.set(item.edge.eventId, node);
    chain.push(node);
    inChain.add(toDid);
  }
  settleUnreached(classes, reached, describeEdge, verdict, statuses);
  return { chain, nodeByEdge };
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
 * The document a resolution names, as the vault retains it, once the
 * presented spelling is one of the canonical DID's: for a numalgo-4
 * long form derived from the spelling itself, for anything else read
 * from the object store by CID and checked to be those bytes in
 * canonical form. A numalgo-4 document read back must be exactly what its own
 * long form derives, since that derivation is the only retained
 * representation and a document's `id` alone is any key's to claim.
 * Null while the object is not here; a throw when what is here is not
 * the document the resolution says.
 */
async function documentOf(resolution: VaultData["peer.resolved"], readObject: ReadObject): Promise<JsonObject | null> {
  if (canonicalDidOf(resolution.presentedDid) !== resolution.did) throw new InvalidDidDocument(`${resolution.presentedDid} is not a spelling of ${resolution.did}`);
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
  if (!resolution.did.startsWith(PEER4_PREFIX)) {
    if (rawCidOfBytes(canonicalize(document)) !== resolution.documentCid) throw new InvalidDidDocument("the retained document is not in canonical form");
    return document;
  }
  if (!isLongForm(id)) throw new InvalidDidDocument("the retained document's id is not the long form");
  const derived = peerResolution(id);
  if (derived.cid !== resolution.documentCid) throw new InvalidDidDocument(`the retained document is not what ${id} derives`);
  return derived.document;
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
