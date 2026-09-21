/**
 * The continuity graph over the channel evidence: which channel
 * replaced which, and what that authorizes. Its vertices are channels,
 * its edges replace exactly one endpoint — the peer's DID by a
 * carrier's verified proof, ours by a rotation decision — and a local
 * and a peer replacement leaving the same pair join in the pair of
 * both successors, each replacement transported to the other's
 * successor. The graph is built in three steps that never look back.
 * First the least closure of the positive evidence: every peer link,
 * every decision whose predecessor address the peer or a verified
 * successor has confirmed by writing to exactly that address in the
 * graph so far — so no decision confirms itself through what it
 * derives, and a ring of decisions confirming one another admits
 * nothing — and every join they imply, all branches kept. Then, over
 * the whole graph, the contexts and their conflicts: competing
 * successors of one endpoint in one context, cycles, a join that would
 * pair a DID with itself. Only then what grants authority: the same
 * closure again, admitting no edge that touches a conflicted channel
 * — neither a carrier's, nor a decision's, nor one a join derives —
 * over the carriers that are complete witnesses and the decisions
 * whose source, when they name one, is a complete witness and whose
 * predecessor complete witnesses confirm along the edges so admitted;
 * so a masked carrier confirms no decision, and a join transports a
 * replacement only through channels no conflict reaches. The positive
 * graph keeps every branch for display and says which replacements
 * exist; the authority graph says which of them count. Nothing here
 * appends an event or reads arrival order.
 */

import { Components } from "../components.js";
import { channelKey, channelOf, compareChannels, sameChannel } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Channel, Did, EventId } from "../types.js";
import type { ChannelEvidence, Decision, LocalLink, PeerLink } from "./channels.js";
import type { VaultEventSet } from "./set.js";

export type Replaced = "local" | "peer";

/**
 * One replacement of one endpoint, with every carrier and decision
 * that establishes it: those at this very pair, and for a transported
 * replacement those of both links the join carried it over from.
 */
export interface ContinuityLink {
  readonly from: Channel;
  readonly to: Channel;
  readonly replaces: Replaced;
  readonly carriers: readonly EventId[];
  readonly decisions: readonly EventId[];
  /** does the replacement grant authority: some complete support no conflict masks establishes it */
  readonly verified: boolean;
}

/** What contradicts continuity in a context; it masks authority there and chooses no winner. */
export type Conflict =
  | { kind: "competing-peer-successors"; context: readonly Channel[]; successors: readonly Channel[] }
  | { kind: "competing-local-successors"; context: readonly Channel[]; successors: readonly Channel[] }
  | { kind: "cycle"; channels: readonly Channel[] }
  | { kind: "identity"; channels: readonly Channel[] };

/** The continuity a carrier's proof, or a decision, has reached; what a UI shows beside the message. */
export type Status =
  | { status: "not-present" }
  | { status: "pending-proof" }
  | { status: "pending-history"; because: string }
  | { status: "verified" }
  | { status: "invalid"; because: string }
  | { status: "conflict"; because: string };

/**
 * Whether a source is a complete witness: authenticated, in a pair,
 * and any proof it brought verified and not masked by a conflict. This
 * is what an operation checks before it derives anything from the
 * source; positive evidence alone authorizes nothing.
 */
export type Witness = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string } | { status: "invalid"; because: string };

export interface Continuity {
  /** every edge of the positive closure, conflicted branches included, in canonical channel order */
  readonly links: readonly ContinuityLink[];
  readonly conflicts: readonly Conflict[];
  /** the candidate local links whose predecessor address no one has confirmed yet, by decision */
  readonly unconfirmed: ReadonlyMap<EventId, LocalLink>;
  /** a carrier's or a decision's status; a proof-free source is `not-present` */
  status(eventId: EventId): Status;
  witness(sourceEventId: EventId): Witness;
  /** is the channel in a conflicted context: no new work, no default head through it */
  conflicted(channel: Channel): boolean;
  /** has the peer replaced its DID anywhere in the channel's local-only context: no new work from the old peer */
  superseded(channel: Channel): boolean;
  /** the unique channel forward replacements lead to, itself when none; null when any replacement ahead is not one authority grants, or no end is unique */
  head(channel: Channel): Channel | null;
  /** has the peer, or a verified successor of it, written to exactly this local DID */
  confirmed(localDid: Did, peerDid: Did): boolean;
  /** may a carrier in `carrier` acknowledge an outbound of `outbound`: the same channel or a verified role-preserving path */
  ackPath(outbound: Channel, carrier: Channel): boolean;
  /** the denials that cover the channel: on the pair itself, or on a pair the positive evidence makes it succeed, conflicted or not, when that denial includes successors */
  blocked(channel: Channel): readonly VaultEvent<"channel.blocked">[];
  /** every decision rotating away from the channel's local DID anywhere in its peer-only context, whatever its status */
  decisionsIn(channel: Channel): readonly Decision[];
}

export function foldContinuity(set: VaultEventSet, evidence: ChannelEvidence): Continuity {
  const positives = writersByLocalDid(evidence, (id) => evidence.positive(id));
  const { graph, waiting } = closure(evidence.peerLinks, evidence.localLinks, EVERY_CHANNEL, (graph, link) => graph.confirmedBy(positives.get(link.from.localDid) ?? NO_PEERS, link.from));
  return new ContinuityFold(set, evidence, graph, waiting);
}

const NO_PEERS: ReadonlySet<Did> = new Set();
const EVERY_CHANNEL = () => true;

/**
 * The least graph over the peer links and the candidate local links
 * `confirms` admits, with no edge touching a channel `admits` refuses:
 * a candidate is judged against the graph built without it and every
 * candidate still waiting, so nothing it derives can confirm it, and
 * the graph is rebuilt until no candidate is admitted any more.
 */
function closure(peerLinks: readonly PeerLink[], candidates: readonly LocalLink[], admits: (channel: Channel) => boolean, confirms: (graph: Graph, link: LocalLink) => boolean): { graph: Graph; waiting: Map<EventId, LocalLink> } {
  const admitted: LocalLink[] = [];
  const waiting = new Map(candidates.map((link) => [link.decision, link]));
  let graph = buildGraph(peerLinks, admitted, admits);
  for (;;) {
    const confirmed = [...waiting.values()].filter((link) => confirms(graph, link));
    if (confirmed.length === 0) return { graph, waiting };
    for (const link of confirmed) {
      admitted.push(link);
      waiting.delete(link.decision);
    }
    graph = buildGraph(peerLinks, admitted, admits);
  }
}

/** By local DID, the peers whose sources addressed to it pass `admits`. */
function writersByLocalDid(evidence: ChannelEvidence, admits: (sourceEventId: EventId) => boolean): Map<Did, Set<Did>> {
  const writers = new Map<Did, Set<Did>>();
  for (const [id, source] of evidence.sources) {
    if (source.channel === null || !admits(id)) continue;
    let peers = writers.get(source.channel.localDid);
    if (peers === undefined) writers.set(source.channel.localDid, (peers = new Set()));
    peers.add(source.channel.peerDid);
  }
  return writers;
}

type Edge = { from: Channel; to: Channel; replaces: Replaced; carriers: Set<EventId>; decisions: Set<EventId> };

class Graph {
  readonly channels = new Map<string, Channel>();
  readonly identityConflicts = new Map<string, Channel[]>();
  private readonly out = new Map<string, Map<string, Edge>>();
  private readonly queue: Edge[] = [];

  constructor(private readonly admits: (channel: Channel) => boolean) {}

  add(from: Channel, to: Channel, replaces: Replaced, carriers: Iterable<EventId>, decisions: Iterable<EventId>): void {
    if (!this.admits(from) || !this.admits(to)) return;
    const fromKey = this.vertex(from);
    const toKey = this.vertex(to);
    let edges = this.out.get(fromKey);
    if (edges === undefined) this.out.set(fromKey, (edges = new Map()));
    const existing = edges.get(toKey);
    if (existing === undefined) {
      const edge = { from, to, replaces, carriers: new Set(carriers), decisions: new Set(decisions) };
      edges.set(toKey, edge);
      this.queue.push(edge);
      return;
    }
    const before = existing.carriers.size + existing.decisions.size;
    for (const id of carriers) existing.carriers.add(id);
    for (const id of decisions) existing.decisions.add(id);
    if (existing.carriers.size + existing.decisions.size > before) this.queue.push(existing);
  }

  /** Every join the edges imply, to a fixpoint: the closure is the same whatever order the edges came in. */
  close(): void {
    while (this.queue.length > 0) {
      const edge = this.queue.pop()!;
      for (const partner of this.from(edge.from)) {
        if (partner.replaces === edge.replaces) continue;
        const [local, peer] = edge.replaces === "local" ? [edge, partner] : [partner, edge];
        this.join(local, peer);
      }
    }
  }

  private join(local: Edge, peer: Edge): void {
    const localDid = local.to.localDid;
    const peerDid = peer.to.peerDid;
    if (localDid === peerDid) {
      const channels = [local.from, local.to, peer.to];
      this.identityConflicts.set(channels.map(channelKey).join(" "), channels);
      return;
    }
    const joined = channelOf(localDid, peerDid);
    const carriers = [...local.carriers, ...peer.carriers];
    const decisions = [...local.decisions, ...peer.decisions];
    this.add(local.to, joined, "peer", carriers, decisions);
    this.add(peer.to, joined, "local", carriers, decisions);
  }

  from(channel: Channel): Iterable<Edge> {
    return this.out.get(channelKey(channel))?.values() ?? [];
  }

  has(from: Channel, to: Channel): boolean {
    return this.out.get(channelKey(from))?.has(channelKey(to)) ?? false;
  }

  hasOutgoingReplacement(channel: Channel): boolean {
    return (this.out.get(channelKey(channel))?.size ?? 0) > 0;
  }

  *edges(): IterableIterator<Edge> {
    for (const edges of this.out.values()) yield* edges.values();
  }

  /** The channels forward replacements of the given kinds reach from `start`, `start` included. */
  reach(start: Channel, replaces: Replaced | "any"): Map<string, Channel> {
    const reached = new Map<string, Channel>();
    const frontier = [start];
    reached.set(channelKey(start), start);
    while (frontier.length > 0) {
      const channel = frontier.pop()!;
      for (const edge of this.from(channel)) {
        if (replaces !== "any" && edge.replaces !== replaces) continue;
        const key = channelKey(edge.to);
        if (reached.has(key)) continue;
        reached.set(key, edge.to);
        frontier.push(edge.to);
      }
    }
    return reached;
  }

  /** Is the peer of `channel`, or a peer that replaced it at this local DID along this graph, among `writers`, the peers that wrote to exactly this local DID? */
  confirmedBy(writers: ReadonlySet<Did>, channel: Channel): boolean {
    for (const reached of this.reach(channel, "peer").values()) if (writers.has(reached.peerDid)) return true;
    return false;
  }

  private vertex(channel: Channel): string {
    const key = channelKey(channel);
    if (!this.channels.has(key)) this.channels.set(key, channel);
    return key;
  }
}

function buildGraph(peerLinks: readonly PeerLink[], localLinks: readonly LocalLink[], admits: (channel: Channel) => boolean): Graph {
  const graph = new Graph(admits);
  for (const link of peerLinks) graph.add(link.from, link.to, "peer", [link.carrier], []);
  for (const link of localLinks) graph.add(link.from, link.to, "local", [], [link.decision]);
  graph.close();
  return graph;
}

/** The channels connected by edges of one kind, undirected: a local-only context by local edges, a peer-only context by peer edges. */
class Contexts {
  private readonly components = new Components();

  constructor(graph: Graph, replaces: Replaced) {
    for (const edge of graph.edges()) {
      if (edge.replaces === replaces) this.components.union(channelKey(edge.from), channelKey(edge.to));
    }
  }

  /** the least key of the context, the key itself for a channel no edge of this kind touches */
  root(key: string): string {
    return this.components.has(key) ? this.components.find(key) : key;
  }
}

class ContinuityFold implements Continuity {
  readonly links: readonly ContinuityLink[];
  readonly conflicts: readonly Conflict[];
  private readonly conflictOf = new Map<string, Conflict>();
  private readonly superseding = new Set<string>();
  private readonly local: Contexts;
  private readonly peer: Contexts;
  /** by local DID, the peers whose complete witnesses are addressed to it */
  private readonly writers: ReadonlyMap<Did, ReadonlySet<Did>>;
  private readonly authority: Graph;
  private readonly denials: readonly VaultEvent<"channel.blocked">[];
  private readonly covered = new Map<EventId, Map<string, Channel>>();

  constructor(
    set: VaultEventSet,
    private readonly evidence: ChannelEvidence,
    private readonly graph: Graph,
    readonly unconfirmed: ReadonlyMap<EventId, LocalLink>
  ) {
    this.local = new Contexts(graph, "local");
    this.peer = new Contexts(graph, "peer");
    this.conflicts = this.findConflicts();
    for (const conflict of this.conflicts) {
      const touched = conflict.kind === "cycle" || conflict.kind === "identity" ? conflict.channels : [...conflict.context, ...conflict.successors];
      for (const channel of touched) {
        const key = channelKey(channel);
        if (!this.conflictOf.has(key)) this.conflictOf.set(key, conflict);
      }
    }
    for (const edge of graph.edges()) if (edge.replaces === "peer") this.superseding.add(this.local.root(channelKey(edge.from)));
    this.writers = writersByLocalDid(evidence, (id) => this.witness(id).status === "complete");
    this.authority = closure(
      evidence.peerLinks.filter((link) => this.witness(link.carrier).status === "complete"),
      evidence.localLinks.filter((link) => !unconfirmed.has(link.decision) && this.localLinkStatus(link).status === "verified"),
      (channel) => !this.conflicted(channel),
      (authority, link) => authority.confirmedBy(this.writers.get(link.from.localDid) ?? NO_PEERS, link.from)
    ).graph;
    this.links = [...graph.edges()]
      .map((edge) => ({ from: edge.from, to: edge.to, replaces: edge.replaces, carriers: [...edge.carriers].sort(), decisions: [...edge.decisions].sort(), verified: this.authority.has(edge.from, edge.to) }))
      .sort((a, b) => compareChannels(a.from, b.from) || compareChannels(a.to, b.to));
    this.denials = set.of("channel.blocked");
  }

  status(eventId: EventId): Status {
    const carrier = this.evidence.carriers.get(eventId);
    if (carrier !== undefined) {
      const { proof, source, link } = carrier;
      if (proof.status === "invalid") return { status: "invalid", because: proof.because };
      if (source.standing.status === "conflict") return { status: "invalid", because: `the carrier's own authentication is contradicted: ${source.standing.because}` };
      if (proof.status === "pending-proof") return { status: "pending-proof" };
      if (source.standing.status === "incomplete") return { status: "pending-history", because: `the carrier's own authentication is incomplete: ${source.standing.because}` };
      if (link === null) return { status: "pending-history", because: "the carrier's endpoints are not known" };
      return this.linkStatus(link.from, link.to);
    }
    if (this.evidence.sources.has(eventId)) return { status: "not-present" };
    const decision = this.evidence.decisions.get(eventId);
    if (decision === undefined) return { status: "pending-history", because: "no carrier or decision here has this ID" };
    const { status } = decision;
    if (status.status === "invalid") return { status: "invalid", because: status.because };
    if (status.status === "conflict") return { status: "conflict", because: status.because };
    if (status.status === "pending") return { status: "pending-history", because: status.because };
    if (this.unconfirmed.has(eventId)) return { status: "pending-history", because: "no complete source from the peer or a verified successor is addressed to the predecessor" };
    const own = this.localLinkStatus(status.link);
    if (own.status !== "verified" || this.authority.has(status.link.from, status.link.to)) return own;
    return { status: "conflict", because: "the predecessor is confirmed only through conflicted continuity" };
  }

  private linkStatus(from: Channel, to: Channel): Status {
    const conflict = this.conflictOf.get(channelKey(from)) ?? this.conflictOf.get(channelKey(to));
    return conflict === undefined ? { status: "verified" } : { status: "conflict", because: `its context is in conflict: ${conflict.kind}` };
  }

  /** A decision's link by what it names: its source must be a complete witness, its pairs untouched by any conflict. */
  private localLinkStatus(link: LocalLink): Status {
    if (link.source !== null) {
      const witness = this.witness(link.source);
      if (witness.status === "pending") return { status: "pending-history", because: `its source is no complete witness: ${witness.because}` };
      if (witness.status !== "complete") return { status: witness.status, because: `its source is no complete witness: ${witness.because}` };
    }
    return this.linkStatus(link.from, link.to);
  }

  witness(sourceEventId: EventId): Witness {
    const source = this.evidence.sources.get(sourceEventId);
    if (source === undefined) return { status: "pending", because: "the source is not here" };
    if (source.event.data.peerResolutionEventId === null) return { status: "invalid", because: "the source is anonymous, in no pair" };
    if (source.standing.status === "conflict") return { status: "conflict", because: source.standing.because };
    const carrier = this.evidence.carriers.get(sourceEventId);
    if (carrier?.proof.status === "invalid") return { status: "invalid", because: carrier.proof.because };
    if (source.standing.status === "incomplete") return { status: "pending", because: source.standing.because };
    if (carrier === undefined) return { status: "complete" };
    if (carrier.proof.status === "pending-proof") return { status: "pending", because: "the proof is not yet verified" };
    if (carrier.link === null) return { status: "pending", because: "the carrier's endpoints are not known" };
    const status = this.linkStatus(carrier.link.from, carrier.link.to);
    return status.status === "conflict" ? { status: "conflict", because: status.because } : { status: "complete" };
  }

  conflicted(channel: Channel): boolean {
    return this.conflictOf.has(channelKey(channel));
  }

  superseded(channel: Channel): boolean {
    return this.superseding.has(this.local.root(channelKey(channel)));
  }

  /**
   * Every replacement the positive evidence shows ahead of the channel
   * must be one authority grants: a replacement it does not grant has
   * no usable end, and the channel it left is no default in its place.
   */
  head(channel: Channel): Channel | null {
    if (this.conflicted(channel)) return null;
    const ends: Channel[] = [];
    for (const reached of this.graph.reach(channel, "any").values()) {
      if (!this.graph.hasOutgoingReplacement(reached)) ends.push(reached);
      for (const edge of this.graph.from(reached)) if (!this.authority.has(edge.from, edge.to)) return null;
    }
    return ends.length === 1 ? ends[0]! : null;
  }

  confirmed(localDid: Did, peerDid: Did): boolean {
    const channel = channelOf(localDid, peerDid);
    if (localDid === peerDid || this.conflicted(channel)) return false;
    return this.authority.confirmedBy(this.writers.get(localDid) ?? NO_PEERS, channel);
  }

  ackPath(outbound: Channel, carrier: Channel): boolean {
    if (sameChannel(outbound, carrier)) return true;
    return this.authority.reach(outbound, "any").has(channelKey(carrier));
  }

  blocked(channel: Channel): readonly VaultEvent<"channel.blocked">[] {
    const key = channelKey(channel);
    return this.denials.filter((denial) => {
      const pair = channelOf(denial.data.localDid, denial.data.peerDid);
      if (sameChannel(pair, channel)) return true;
      if (!denial.data.includeSuccessors) return false;
      let covered = this.covered.get(denial.eventId);
      if (covered === undefined) this.covered.set(denial.eventId, (covered = this.graph.reach(pair, "any")));
      return covered.has(key);
    });
  }

  decisionsIn(channel: Channel): readonly Decision[] {
    const context = this.peer.root(channelKey(channel));
    const decisions: Decision[] = [];
    for (const decision of this.evidence.decisions.values()) {
      if (decision.channel === null || decision.channel.localDid !== channel.localDid) continue;
      if (this.peer.root(channelKey(decision.channel)) === context) decisions.push(decision);
    }
    return decisions;
  }

  /**
   * Competing successors of one endpoint across one context: the peer
   * edges leaving a local-only context toward more than one peer DID,
   * the local edges leaving a peer-only context toward more than one
   * local DID. A replacement a join transported to the same successor
   * is the same replacement, not a competitor. Then every cycle, and
   * every join refused for pairing a DID with itself.
   */
  private findConflicts(): Conflict[] {
    const conflicts: Conflict[] = [];
    const leaving = (contexts: Contexts, replaces: Replaced) => {
      const byContext = new Map<string, { context: Map<string, Channel>; successors: Map<string, Channel>; ends: Set<Did> }>();
      for (const channel of this.graph.channels.values()) {
        const root = contexts.root(channelKey(channel));
        let entry = byContext.get(root);
        if (entry === undefined) byContext.set(root, (entry = { context: new Map(), successors: new Map(), ends: new Set() }));
        entry.context.set(channelKey(channel), channel);
        for (const edge of this.graph.from(channel)) {
          if (edge.replaces !== replaces) continue;
          entry.successors.set(channelKey(edge.to), edge.to);
          entry.ends.add(replaces === "peer" ? edge.to.peerDid : edge.to.localDid);
        }
      }
      for (const { context, successors, ends } of byContext.values()) {
        if (ends.size < 2) continue;
        const kind = replaces === "peer" ? "competing-peer-successors" : "competing-local-successors";
        conflicts.push({ kind, context: sorted(context.values()), successors: sorted(successors.values()) });
      }
    };
    leaving(this.local, "peer");
    leaving(this.peer, "local");
    for (const cycle of this.cycles()) conflicts.push({ kind: "cycle", channels: cycle });
    for (const channels of this.graph.identityConflicts.values()) conflicts.push({ kind: "identity", channels });
    return conflicts.sort((a, b) => cmp(a.kind, b.kind) || compareChannels(firstOf(a), firstOf(b)));
  }

  /**
   * Every strongly connected set of more than one channel, each in
   * canonical order: Tarjan's algorithm on an explicit stack, since a
   * replacement history is as deep as the peer made it and the call
   * stack is not.
   */
  private cycles(): Channel[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: Channel[] = [];
    const path: { key: string; edges: Iterator<Edge> }[] = [];
    const cycles: Channel[][] = [];
    let next = 0;
    const enter = (channel: Channel) => {
      const key = channelKey(channel);
      index.set(key, next);
      low.set(key, next);
      next++;
      stack.push(channel);
      onStack.add(key);
      path.push({ key, edges: this.graph.from(channel)[Symbol.iterator]() });
    };
    for (const root of this.graph.channels.values()) {
      if (index.has(channelKey(root))) continue;
      enter(root);
      while (path.length > 0) {
        const frame = path[path.length - 1]!;
        const step = frame.edges.next();
        if (!step.done) {
          const toKey = channelKey(step.value.to);
          if (!index.has(toKey)) enter(step.value.to);
          else if (onStack.has(toKey)) low.set(frame.key, Math.min(low.get(frame.key)!, index.get(toKey)!));
          continue;
        }
        path.pop();
        if (low.get(frame.key) === index.get(frame.key)) {
          const component: Channel[] = [];
          for (;;) {
            const member = stack.pop()!;
            const memberKey = channelKey(member);
            onStack.delete(memberKey);
            component.push(member);
            if (memberKey === frame.key) break;
          }
          if (component.length > 1) cycles.push(component.sort(compareChannels));
        }
        const parent = path[path.length - 1];
        if (parent !== undefined) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      }
    }
    return cycles;
  }
}

const sorted = (channels: Iterable<Channel>) => [...channels].sort(compareChannels);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const firstOf = (conflict: Conflict) => (conflict.kind === "cycle" || conflict.kind === "identity" ? conflict.channels[0]! : conflict.context[0]!);
