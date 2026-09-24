/**
 * The continuity model over a snapshot of facts, derived in the order
 * the evidence depends on itself. First every fact's references are
 * resolved: a missing one stays unresolved, one whose ID has several
 * values is ambiguous. Then the positive closure: every peer rotation,
 * every local rotation whose predecessor address an observation
 * confirms in the graph built without it, and every join they imply,
 * all branches kept, every variant of an identity-conflicted ID
 * included so that no competing continuation can hide. Then contexts and conflicts over
 * that whole graph: competing changes of one endpoint in one context,
 * cycles, joins that would pair a DID with itself. Only then usable
 * continuity: the same closure again over unambiguous facts, admitting
 * no channel a conflict reaches. The positive graph says what
 * replacements the evidence shows; the usable graph says which of them
 * an operation may rely on. Nothing here reads arrival order or time.
 */

import { changeKey, channelKey, channelOf, compareChannels, compareUtf8, sortedChannels, sortedIds, successorChannel } from "./facts.js";
import { closure, Contexts, Graph, type Edge, type Link, type Replaces } from "./graph.js";
import { bucketsOf } from "./merge.js";
import type { AddressObservation, Change, Channel, ContinuityFact, Did, FactId, LocalDecision, PeerTransition } from "./types.js";

export type Side = Replaces;

export type Conflict =
  | { kind: "competing-changes"; side: Side; context: readonly Channel[]; changes: readonly { change: Change; facts: readonly FactId[] }[] }
  | { kind: "cycle"; channels: readonly Channel[]; facts: readonly FactId[] }
  | { kind: "identity-collision"; channels: readonly Channel[]; facts: readonly FactId[] }
  | { kind: "identity-conflict"; id: FactId; variants: readonly ContinuityFact[] };

export type HeadResult =
  | { status: "head"; channel: Channel; support: readonly FactId[] }
  | { status: "ended"; endings: readonly FactId[] }
  | { status: "unresolved"; waiting: readonly FactId[]; missing: readonly FactId[] }
  | { status: "conflict"; facts: readonly FactId[] }
  | { status: "no-evidence" };

export type FactStatus =
  | { status: "unknown" }
  | { status: "identity-conflict"; variants: readonly ContinuityFact[] }
  | { status: "invalid"; because: string }
  | { status: "unresolved"; missing: readonly FactId[] }
  | { status: "conflict"; facts: readonly FactId[]; because: string }
  | { status: "waiting"; because: string }
  | { status: "usable"; support: readonly FactId[] };

export type PathResult =
  | { status: "path"; channels: readonly Channel[]; support: readonly FactId[] }
  | { status: "none" }
  | { status: "conflict"; facts: readonly FactId[] };

export type Confirmation = { id: FactId; at: Channel; support: readonly FactId[] };

export type ConfirmationResult =
  | { status: "confirmed"; observations: readonly Confirmation[] }
  | { status: "unconfirmed"; unusable: readonly FactId[] }
  | { status: "conflict"; facts: readonly FactId[] };

export type ChangeRecord = { id: FactId; at: Channel; change: Change; to: Channel | null; status: FactStatus };

export type PositiveLink = { from: Channel; to: Channel; replaces: Side; support: readonly FactId[]; derived: boolean; usable: boolean };

export type EndingRecord = { id: FactId; at: Channel; side: Side; status: FactStatus };

export type History = { links: readonly PositiveLink[]; endings: readonly EndingRecord[]; localContext: readonly Channel[]; peerContext: readonly Channel[] };

export interface Continuity {
  /** the facts as derived over, in canonical order, every variant of a repeated ID included */
  readonly facts: readonly ContinuityFact[];
  /** the unique usable pair forward changes lead to, the channel itself when none is established */
  head(channel: Channel): HeadResult;
  /** the changes of that side's endpoint in the channel's context, whatever their status */
  changes(channel: Channel, side: Side): readonly ChangeRecord[];
  /** a directed usable path preserving roles, and what supports it */
  path(from: Channel, to: Channel): PathResult;
  /** has the peer, or a usable successor of it, written to exactly this local DID */
  confirmation(localDid: Did, peerDid: Did): ConfirmationResult;
  /** every positive link connected to the channel, the endings in its contexts and the contexts themselves */
  history(channel: Channel): History;
  /** every decision rotating away from the channel's local DID, or ending there, in its peer-only context */
  localDecisions(channel: Channel): readonly ChangeRecord[];
  conflicts(): readonly Conflict[];
  status(factId: FactId): FactStatus;
}

export function deriveContinuity(facts: readonly ContinuityFact[]): Continuity {
  return new Model(facts);
}

type Standing = { kind: "ok" } | { kind: "missing"; ids: readonly FactId[] } | { kind: "ambiguous"; ids: readonly FactId[] } | { kind: "invalid"; because: string };

interface Entry {
  readonly fact: ContinuityFact;
  /** the ID has more than one value: this variant may link diagnostically, but gives no usable link or witness */
  readonly tainted: boolean;
  standing: Standing;
}

type Writers = Map<Did, Map<Did, FactId[]>>;

type Candidate = Link & { readonly entry: Entry };

const EVERY_CHANNEL = () => true;

class Model implements Continuity {
  readonly facts: readonly ContinuityFact[];
  private readonly entries = new Map<FactId, Entry[]>();
  private readonly entriesAt = new Map<string, Entry[]>();
  private readonly endings: Entry[] = [];
  private readonly positive: Graph;
  private readonly positiveWaiting: ReadonlySet<FactId>;
  private readonly local: Contexts;
  private readonly peer: Contexts;
  /** the saved local rotations by the root of their positive peer-only context: the onward choices a head in that context must answer for */
  private readonly rotationsByContext = new Map<string, { entry: Entry; successor: Did }[]>();
  private readonly domainConflicts: readonly Conflict[];
  /** the channels a query answers `conflict` for, by channel key: each domain conflict's context and the successors its own claims name */
  private readonly conflictsAt = new Map<string, Conflict[]>();
  private readonly usable: Graph;
  private readonly usableAdmitted: ReadonlyMap<FactId, readonly FactId[]>;
  private readonly usableWriters: Writers;
  private readonly usableLocal: Contexts;
  private readonly usablePeer: Contexts;
  /** the usable links by the side they replace and the successor DID, for finding the same change made at another pair of a context */
  private readonly usableChanges = new Map<string, Edge[]>();

  constructor(facts: readonly ContinuityFact[]) {
    const buckets = bucketsOf(facts);
    const ordered: ContinuityFact[] = [];
    for (const id of [...buckets.keys()].sort(compareUtf8)) {
      const variants = [...buckets.get(id)!.keys()].sort(compareUtf8).map((canonical) => buckets.get(id)!.get(canonical)!);
      this.entries.set(
        id,
        variants.map((fact) => ({ fact, tainted: variants.length > 1, standing: { kind: "ok" } }))
      );
      ordered.push(...variants);
    }
    this.facts = ordered;
    for (const entry of this.all()) {
      entry.standing = this.standingOf(entry.fact);
      const key = channelKey(entry.fact.at);
      let at = this.entriesAt.get(key);
      if (at === undefined) this.entriesAt.set(key, (at = []));
      at.push(entry);
      if (entry.fact.kind !== "address-observed" && entry.fact.change.kind === "end") this.endings.push(entry);
    }

    const positiveWriters = this.writersOf((entry) => this.positiveObservation(entry));
    const positive = closure(
      this.peerLinks(() => true),
      this.candidates((entry) => entry.standing.kind === "ok"),
      EVERY_CHANNEL,
      (graph, link) => this.confirming(graph, link, positiveWriters, (entry) => this.positiveObservation(entry))
    );
    this.positive = positive.graph;
    this.positiveWaiting = new Set([...positive.waiting].map((link) => link.id));
    for (const entry of this.all()) this.positive.vertex(entry.fact.at);
    this.local = new Contexts(this.positive, "local");
    this.peer = new Contexts(this.positive, "peer");
    for (const entry of this.all()) {
      if (entry.fact.kind !== "local-decision" || entry.fact.change.kind !== "rotate") continue;
      const root = this.peer.root(channelKey(entry.fact.at));
      let rotations = this.rotationsByContext.get(root);
      if (rotations === undefined) this.rotationsByContext.set(root, (rotations = []));
      rotations.push({ entry, successor: entry.fact.change.successor });
    }
    const found = this.findConflicts();
    this.domainConflicts = found.map(({ conflict }) => conflict);
    for (const { conflict, scope } of found) {
      for (const channel of scope) {
        const key = channelKey(channel);
        let list = this.conflictsAt.get(key);
        if (list === undefined) this.conflictsAt.set(key, (list = []));
        list.push(conflict);
      }
    }

    this.usableWriters = this.writersOf((entry) => this.usableObservation(entry));
    const usable = closure(
      this.peerLinks((entry) => this.usableTransition(entry)),
      this.candidates((entry) => this.usableCandidate(entry)),
      (channel) => !this.affected(channel),
      (graph, link) => this.confirming(graph, link, this.usableWriters, (entry) => this.usableObservation(entry))
    );
    this.usable = usable.graph;
    this.usableAdmitted = new Map([...usable.admitted].map(([link, support]) => [link.id, support]));
    this.usableLocal = new Contexts(this.usable, "local");
    this.usablePeer = new Contexts(this.usable, "peer");
    for (const edge of this.usable.edges()) {
      const key = changeIndexKey(edge.replaces, edge.replaces === "local" ? edge.to.localDid : edge.to.peerDid);
      let edges = this.usableChanges.get(key);
      if (edges === undefined) this.usableChanges.set(key, (edges = []));
      edges.push(edge);
    }
  }

  private *all(): IterableIterator<Entry> {
    for (const entries of this.entries.values()) yield* entries;
  }

  /** The one entry of an ID, undefined when there is none or more than one. */
  private single(id: FactId): Entry | undefined {
    const entries = this.entries.get(id);
    return entries !== undefined && entries.length === 1 ? entries[0] : undefined;
  }

  private standingOf(fact: ContinuityFact): Standing {
    if (fact.kind === "peer-transition") return { kind: "ok" };
    const ref = fact.kind === "local-decision" ? fact.source : fact.carriedTransition;
    if (ref === null) return { kind: "ok" };
    const entries = this.entries.get(ref);
    if (entries === undefined) return { kind: "missing", ids: [ref] };
    if (entries.length > 1) return { kind: "ambiguous", ids: [ref] };
    const target = entries[0]!.fact;
    if (fact.kind === "local-decision") {
      if (target.kind !== "address-observed") return { kind: "invalid", because: `its source ${ref} is no address observation` };
      if (target.at.localDid !== fact.at.localDid) return { kind: "invalid", because: `its source ${ref} is addressed to ${target.at.localDid}, not to ${fact.at.localDid}` };
      return { kind: "ok" };
    }
    if (target.kind !== "peer-transition") return { kind: "invalid", because: `its carried transition ${ref} is no peer transition` };
    if (target.receipt !== fact.receipt) return { kind: "invalid", because: `its carried transition ${ref} is of another receipt` };
    if (target.change.kind !== "rotate") return { kind: "invalid", because: `its carried transition ${ref} is an ending, which observes no address` };
    if (target.at.localDid !== fact.at.localDid) return { kind: "invalid", because: `its carried transition ${ref} was received by ${target.at.localDid}, not by ${fact.at.localDid}` };
    if (target.change.successor !== fact.at.peerDid) return { kind: "invalid", because: `its carried transition ${ref} names the successor ${target.change.successor}, not ${fact.at.peerDid}` };
    return { kind: "ok" };
  }

  private peerLinks(admits: (entry: Entry) => boolean): Link[] {
    const links: Link[] = [];
    for (const entry of this.all()) {
      if (entry.fact.kind !== "peer-transition" || entry.fact.change.kind !== "rotate" || !admits(entry)) continue;
      links.push({ id: entry.fact.id, from: entry.fact.at, to: successorChannel(entry.fact)! });
    }
    return links;
  }

  private candidates(admits: (entry: Entry) => boolean): Candidate[] {
    const links: Candidate[] = [];
    for (const entry of this.all()) {
      if (entry.fact.kind !== "local-decision" || entry.fact.change.kind !== "rotate" || !admits(entry)) continue;
      links.push({ id: entry.fact.id, from: entry.fact.at, to: successorChannel(entry.fact)!, entry });
    }
    return links;
  }

  /** By local DID, then by peer DID, the observations `admits` of the peer writing to exactly that local DID. */
  private writersOf(admits: (entry: Entry) => boolean): Writers {
    const writers: Writers = new Map();
    for (const entry of this.all()) {
      if (entry.fact.kind !== "address-observed" || !admits(entry)) continue;
      let peers = writers.get(entry.fact.at.localDid);
      if (peers === undefined) writers.set(entry.fact.at.localDid, (peers = new Map()));
      let ids = peers.get(entry.fact.at.peerDid);
      if (ids === undefined) peers.set(entry.fact.at.peerDid, (ids = []));
      ids.push(entry.fact.id);
    }
    return writers;
  }

  /** An observation that stands on its own: unambiguous, resolved, and its carried transition, when any, unambiguous too. */
  private positiveObservation(entry: Entry): boolean {
    if (entry.fact.kind !== "address-observed" || entry.tainted || entry.standing.kind !== "ok") return false;
    return entry.fact.carriedTransition === null || this.single(entry.fact.carriedTransition) !== undefined;
  }

  private usableTransition(entry: Entry): boolean {
    if (entry.fact.kind !== "peer-transition" || entry.tainted) return false;
    const to = successorChannel(entry.fact);
    return !this.affected(entry.fact.at) && (to === null || !this.affected(to));
  }

  private usableObservation(entry: Entry): boolean {
    if (!this.positiveObservation(entry) || this.affected(entry.fact.at)) return false;
    const carried = (entry.fact as AddressObservation).carriedTransition;
    return carried === null || this.usableTransition(this.single(carried)!);
  }

  private usableCandidate(entry: Entry): boolean {
    if (entry.fact.kind !== "local-decision" || entry.tainted || entry.standing.kind !== "ok") return false;
    const to = successorChannel(entry.fact);
    if (this.affected(entry.fact.at) || (to !== null && this.affected(to))) return false;
    return entry.fact.source === null || this.usableObservation(this.single(entry.fact.source)!);
  }

  /**
   * What confirms a candidate's predecessor address in the graph so far:
   * the exact source it names, when that observation is of the peer or
   * of a peer a peer-only path from the predecessor reaches; otherwise
   * any admitted observation addressed to the predecessor by such a
   * peer. The support names the observation, the transition it carried
   * and the path to its peer, so that the support alone re-derives the
   * confirmation.
   */
  private confirming(graph: Graph, link: Candidate, writers: Writers, admits: (entry: Entry) => boolean): readonly FactId[] | null {
    const decision = link.entry.fact as LocalDecision;
    const reach = graph.reach(link.from, "peer");
    const witness = (observationId: FactId, via: readonly Edge[]) => {
      const carried = (this.single(observationId)!.fact as AddressObservation).carriedTransition;
      return [observationId, ...(carried === null ? [] : [carried]), ...via.flatMap((edge) => [...edge.support])];
    };
    if (decision.source !== null) {
      const source = this.single(decision.source)!;
      if (!admits(source)) return null;
      const via = reach.pathTo(source.fact.at);
      return via === undefined ? null : sortedIds(witness(source.fact.id, via));
    }
    const peers = writers.get(link.from.localDid);
    if (peers === undefined) return null;
    const support: FactId[] = [];
    for (const channel of reach.channels()) {
      const ids = peers.get(channel.peerDid);
      if (ids === undefined) continue;
      const via = reach.pathTo(channel)!;
      for (const id of ids) support.push(...witness(id, via));
    }
    return support.length === 0 ? null : sortedIds(support);
  }

  private affected(channel: Channel): boolean {
    return this.conflictsAt.has(channelKey(channel));
  }

  /** The context of a change of `side` at `channel` as usable links connect it: the pairs the change applies to with authority. */
  private usableContextRoot(channel: Channel, side: Side): string {
    return (side === "peer" ? this.usableLocal : this.usablePeer).root(channelKey(channel));
  }

  private usablyEstablished(side: Side, at: Channel, successor: Did): boolean {
    const root = this.usableContextRoot(at, side);
    for (const edge of this.usableChanges.get(changeIndexKey(side, successor)) ?? []) if (this.usableContextRoot(edge.from, side) === root) return true;
    return false;
  }

  private contextOf(channel: Channel, side: Side): Channel[] {
    const contexts = side === "peer" ? this.local : this.peer;
    const root = contexts.root(channelKey(channel));
    const members: Channel[] = [channel];
    for (const [key, vertex] of this.positive.vertices) if (contexts.root(key) === root) members.push(vertex);
    return sortedChannels(members);
  }

  /**
   * Competing changes of one endpoint in one context: the peer's across
   * the local-only context, ours across the peer-only one, every fact
   * counted whatever its status, since a saved decision not yet
   * confirmed is still a fork. Then cycles and refused joins. Each
   * conflict comes with its scope: the context and the successor pairs
   * the claims in that context name. A variant of the same ID claiming
   * something in another context is not in the scope, since it is a
   * different claim.
   */
  private findConflicts(): { conflict: Conflict; scope: readonly Channel[] }[] {
    const found: { conflict: Conflict; scope: readonly Channel[] }[] = [];
    const competing = (side: Side) => {
      const kind = side === "peer" ? "peer-transition" : "local-decision";
      const contexts = side === "peer" ? this.local : this.peer;
      const byContext = new Map<string, { channel: Channel; successors: Channel[]; changes: Map<string, { change: Change; facts: FactId[] }> }>();
      for (const entry of this.all()) {
        if (entry.fact.kind !== kind) continue;
        const root = contexts.root(channelKey(entry.fact.at));
        let group = byContext.get(root);
        if (group === undefined) byContext.set(root, (group = { channel: entry.fact.at, successors: [], changes: new Map() }));
        const key = changeKey(entry.fact.change);
        let change = group.changes.get(key);
        if (change === undefined) group.changes.set(key, (change = { change: entry.fact.change, facts: [] }));
        change.facts.push(entry.fact.id);
        const to = successorChannel(entry.fact);
        if (to !== null) group.successors.push(to);
      }
      for (const { channel, successors, changes } of byContext.values()) {
        if (changes.size < 2) continue;
        const listed = [...changes.values()].map(({ change, facts }) => ({ change, facts: sortedIds(facts) })).sort((a, b) => compareUtf8(changeKey(a.change), changeKey(b.change)));
        const context = this.contextOf(channel, side);
        found.push({ conflict: { kind: "competing-changes", side, context, changes: listed }, scope: sortedChannels([...context, ...successors]) });
      }
    };
    competing("peer");
    competing("local");
    for (const channels of this.positive.cycles()) {
      const members = new Set(channels.map(channelKey));
      const facts: FactId[] = [];
      for (const channel of channels) for (const edge of this.positive.from(channel)) if (members.has(channelKey(edge.to))) facts.push(...edge.support);
      found.push({ conflict: { kind: "cycle", channels, facts: sortedIds(facts) }, scope: channels });
    }
    for (const { channels, support } of this.positive.identityCollisions.values()) found.push({ conflict: { kind: "identity-collision", channels, facts: support }, scope: channels });
    return found.sort((a, b) => compareUtf8(a.conflict.kind, b.conflict.kind) || compareChannels(firstChannelOf(a.conflict), firstChannelOf(b.conflict)));
  }

  private factsOf(conflict: Conflict): readonly FactId[] {
    switch (conflict.kind) {
      case "competing-changes":
        return sortedIds(conflict.changes.flatMap(({ facts }) => facts));
      case "cycle":
      case "identity-collision":
        return conflict.facts;
      case "identity-conflict":
        return [conflict.id];
    }
  }

  private conflictFactsAt(channel: Channel): FactId[] {
    return (this.conflictsAt.get(channelKey(channel)) ?? []).flatMap((conflict) => this.factsOf(conflict));
  }

  private endingsAt(channel: Channel, side: Side): Entry[] {
    const kind = side === "peer" ? "peer-transition" : "local-decision";
    const contexts = side === "peer" ? this.local : this.peer;
    const root = contexts.root(channelKey(channel));
    return this.endings.filter((entry) => entry.fact.kind === kind && contexts.root(channelKey(entry.fact.at)) === root);
  }

  private known(channel: Channel): boolean {
    return this.positive.vertices.has(channelKey(channel));
  }

  /**
   * A local rotation without usable continuation, diagnosed as the fact
   * query diagnoses it, so that a missing or collided reference anywhere
   * along the exact chain it names, an observation's carried transition
   * included, reaches the head the same way it reaches the fact's status.
   */
  private pendingDecision(entry: Entry, conflict: Set<FactId>, waiting: Set<FactId>, missing: Set<FactId>): void {
    const status = this.status(entry.fact.id);
    switch (status.status) {
      case "identity-conflict":
        conflict.add(entry.fact.id);
        return;
      case "conflict":
        for (const id of status.facts) conflict.add(id);
        return;
      case "unresolved":
        waiting.add(entry.fact.id);
        for (const id of status.missing) missing.add(id);
        return;
      case "waiting":
      case "invalid":
        waiting.add(entry.fact.id);
        return;
      case "usable":
      case "unknown":
        return;
    }
  }

  /** A pair some fact is at, or a usable link leads to; one only conflicted links lead to rests on the conflict. */
  private established(channel: Channel): boolean {
    if (this.entriesAt.has(channelKey(channel))) return true;
    for (const _ of this.usable.to(channel)) return true;
    return false;
  }

  /**
   * Conflict reaching the pair outranks everything: a fork is a fork
   * whether its branches are confirmed or not, and a pair that only a
   * conflicted link leads to is in that conflict. Then an established
   * ending, then decisions still waiting, then the unique end of the
   * usable forward paths. A pair no fact establishes but a waiting
   * decision names as its successor is unresolved, not unknown.
   * A collided or waiting claim of a change that independent facts
   * establish usably anyway is provenance, not an obstacle: the same
   * change made by a usable link at any pair of the usable context, or
   * the same side's ending in the usable context by an unambiguous
   * ending. Authority stops at usable links: a claim at a pair that
   * only diagnostic history connects to the query may or may not apply
   * to it, and is reported as the ambiguity it is. Saved rotations of
   * the endpoint are answered for across the whole positive context of
   * each usable pair, not only at the pair itself: one the same change
   * covers is provenance, one at a pair usable links connect is still
   * pending, and one only diagnostic history connects is that ambiguity.
   */
  head(channel: Channel): HeadResult {
    const conflict = new Set<FactId>();
    const waiting = new Set<FactId>();
    const missing = new Set<FactId>();
    if (!this.known(channel)) {
      for (const id of this.conflictFactsAt(channel)) conflict.add(id);
      if (conflict.size > 0) return { status: "conflict", facts: sortedIds(conflict) };
      for (const entry of this.all()) {
        if (entry.fact.kind !== "local-decision" || entry.fact.change.kind !== "rotate") continue;
        if (channelKey(successorChannel(entry.fact)!) === channelKey(channel)) this.pendingDecision(entry, conflict, waiting, missing);
      }
      if (conflict.size > 0) return { status: "conflict", facts: sortedIds(conflict) };
      if (waiting.size > 0) return { status: "unresolved", waiting: sortedIds(waiting), missing: sortedIds(missing) };
      return { status: "no-evidence" };
    }
    const reach = this.positive.reach(channel, "any");
    for (const current of reach.channels()) for (const id of this.conflictFactsAt(current)) conflict.add(id);
    if (!this.established(channel)) for (const edge of this.positive.to(channel)) for (const id of edge.support) conflict.add(id);
    if (conflict.size > 0) return { status: "conflict", facts: sortedIds(conflict) };
    const endings = new Set<FactId>();
    const support = new Set<FactId>();
    const usableReach = this.usable.reach(channel, "any");
    for (const current of reach.channels()) {
      if (!usableReach.has(current)) {
        // a branch only provenance leads to rejoins the usable history through the joins it implies, or it is a branch of its own
        if (!this.positive.hasOutgoing(current)) for (const edge of this.positive.to(current)) for (const id of edge.support) conflict.add(id);
        continue;
      }
      for (const edge of this.positive.from(current)) {
        const usable = this.usable.edge(edge.from, edge.to);
        if (usable !== undefined) for (const id of usable.support) support.add(id);
        else if (!this.usablyEstablished(edge.replaces, current, edge.replaces === "local" ? edge.to.localDid : edge.to.peerDid)) for (const id of edge.support) conflict.add(id);
      }
      for (const side of ["peer", "local"] as const) {
        const found = this.endingsAt(current, side);
        const root = this.usableContextRoot(current, side);
        const affirmative = found.filter((entry) => !entry.tainted && this.usableContextRoot(entry.fact.at, side) === root);
        for (const entry of affirmative) endings.add(entry.fact.id);
        if (affirmative.length === 0) for (const entry of found) conflict.add(entry.fact.id);
      }
      const usableRoot = this.usableContextRoot(current, "local");
      for (const { entry, successor } of this.rotationsByContext.get(this.peer.root(channelKey(current))) ?? []) {
        if (this.usablyEstablished("local", current, successor)) continue;
        if (this.usableContextRoot(entry.fact.at, "local") === usableRoot) this.pendingDecision(entry, conflict, waiting, missing);
        else conflict.add(entry.fact.id);
      }
    }
    if (conflict.size > 0) return { status: "conflict", facts: sortedIds(conflict) };
    if (endings.size > 0) return { status: "ended", endings: sortedIds(endings) };
    if (waiting.size > 0) return { status: "unresolved", waiting: sortedIds(waiting), missing: sortedIds(missing) };
    const ends = [...usableReach.channels()].filter((current) => !this.usable.hasOutgoing(current));
    if (ends.length !== 1) return { status: "conflict", facts: sortedIds(support) };
    return { status: "head", channel: ends[0]!, support: sortedIds(support) };
  }

  changes(channel: Channel, side: Side): readonly ChangeRecord[] {
    const kind = side === "peer" ? "peer-transition" : "local-decision";
    const contexts = side === "peer" ? this.local : this.peer;
    const root = contexts.root(channelKey(channel));
    const records: ChangeRecord[] = [];
    for (const entry of this.all()) {
      if (entry.fact.kind !== kind || contexts.root(channelKey(entry.fact.at)) !== root) continue;
      records.push(this.record(entry));
    }
    return records;
  }

  private record(entry: Entry): ChangeRecord {
    const fact = entry.fact as PeerTransition | LocalDecision;
    return { id: fact.id, at: fact.at, change: fact.change, to: successorChannel(fact), status: this.status(fact.id) };
  }

  path(from: Channel, to: Channel): PathResult {
    const conflict = [...this.conflictFactsAt(from), ...this.conflictFactsAt(to)];
    if (conflict.length > 0) return { status: "conflict", facts: sortedIds(conflict) };
    if (!this.known(from)) return { status: "none" };
    const edges = this.usable.path(from, to);
    if (edges === null) return { status: "none" };
    return { status: "path", channels: [from, ...edges.map((edge) => edge.to)], support: sortedIds(edges.flatMap((edge) => [...edge.support])) };
  }

  confirmation(localDid: Did, peerDid: Did): ConfirmationResult {
    const channel = channelOf(localDid, peerDid);
    const conflict = this.conflictFactsAt(channel);
    if (conflict.length > 0) return { status: "conflict", facts: sortedIds(conflict) };
    const observations: Confirmation[] = [];
    const unusable: FactId[] = [];
    const reach = localDid === peerDid ? null : this.usable.reach(channel, "peer");
    for (const entry of this.all()) {
      if (entry.fact.kind !== "address-observed" || entry.fact.at.localDid !== localDid) continue;
      const via = reach?.pathTo(entry.fact.at);
      if (via === undefined) continue;
      if (!this.usableObservation(entry)) {
        unusable.push(entry.fact.id);
        continue;
      }
      const carried = entry.fact.carriedTransition === null ? [] : [entry.fact.carriedTransition];
      observations.push({ id: entry.fact.id, at: entry.fact.at, support: sortedIds([entry.fact.id, ...carried, ...via.flatMap((edge) => [...edge.support])]) });
    }
    if (observations.length > 0) return { status: "confirmed", observations: observations.sort((a, b) => compareUtf8(a.id, b.id)) };
    return { status: "unconfirmed", unusable: sortedIds(unusable) };
  }

  history(channel: Channel): History {
    const component = new Set<string>([channelKey(channel)]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const edge of this.positive.edges()) {
        const fromIn = component.has(channelKey(edge.from));
        const toIn = component.has(channelKey(edge.to));
        if (fromIn === toIn) continue;
        component.add(fromIn ? channelKey(edge.to) : channelKey(edge.from));
        grew = true;
      }
    }
    const links: PositiveLink[] = [];
    for (const edge of this.positive.edges()) {
      if (!component.has(channelKey(edge.from))) continue;
      links.push(this.link(edge));
    }
    const endings: EndingRecord[] = [];
    for (const side of ["peer", "local"] as const) for (const entry of this.endingsAt(channel, side)) endings.push({ id: entry.fact.id, at: entry.fact.at, side, status: this.status(entry.fact.id) });
    return {
      links: links.sort((a, b) => compareChannels(a.from, b.from) || compareChannels(a.to, b.to)),
      endings: endings.sort((a, b) => compareUtf8(a.id, b.id)),
      localContext: this.contextOf(channel, "peer"),
      peerContext: this.contextOf(channel, "local"),
    };
  }

  private link(edge: Edge): PositiveLink {
    return { from: edge.from, to: edge.to, replaces: edge.replaces, support: sortedIds(edge.support), derived: edge.derived, usable: this.usable.edge(edge.from, edge.to) !== undefined };
  }

  localDecisions(channel: Channel): readonly ChangeRecord[] {
    return this.changes(channel, "local").filter((record) => record.at.localDid === channel.localDid);
  }

  conflicts(): readonly Conflict[] {
    const identity: Conflict[] = [];
    for (const [id, entries] of this.entries) if (entries.length > 1) identity.push({ kind: "identity-conflict", id, variants: entries.map((entry) => entry.fact) });
    return [...this.domainConflicts, ...identity];
  }

  status(factId: FactId): FactStatus {
    const entries = this.entries.get(factId);
    if (entries === undefined) return { status: "unknown" };
    if (entries.length > 1) return { status: "identity-conflict", variants: entries.map((entry) => entry.fact) };
    const entry = entries[0]!;
    const { fact, standing } = entry;
    if (standing.kind === "invalid") return { status: "invalid", because: standing.because };
    if (standing.kind === "missing") return { status: "unresolved", missing: standing.ids };
    if (standing.kind === "ambiguous") return { status: "conflict", facts: standing.ids, because: `it references ${standing.ids.join(", ")}, which has more than one value` };
    const to = fact.kind === "address-observed" ? null : successorChannel(fact);
    const conflict = [...this.conflictFactsAt(fact.at), ...(to === null ? [] : this.conflictFactsAt(to))];
    if (conflict.length > 0) return { status: "conflict", facts: sortedIds(conflict), because: "its context is in conflict" };
    switch (fact.kind) {
      case "peer-transition":
        return { status: "usable", support: [fact.id] };
      case "local-decision": {
        if (fact.change.kind === "end") return { status: "usable", support: [fact.id] };
        const confirming = this.usableAdmitted.get(fact.id);
        if (confirming !== undefined) return { status: "usable", support: sortedIds([fact.id, ...confirming]) };
        if (fact.source !== null) {
          const source = this.status(fact.source);
          if (source.status === "conflict") return { status: "conflict", facts: source.facts, because: `its source ${fact.source} is in conflict` };
          if (source.status === "unresolved") return { status: "unresolved", missing: source.missing };
          if (source.status !== "usable") return { status: "waiting", because: `its source ${fact.source} is not usable: ${source.status}` };
          return { status: "waiting", because: `its source ${fact.source} is not addressed to the predecessor by its peer or a usable successor of that peer` };
        }
        if (this.positiveWaiting.has(fact.id)) return { status: "waiting", because: "no observation addressed to the predecessor by its peer or a successor of that peer" };
        return { status: "waiting", because: "the predecessor is confirmed only through continuity that is not usable" };
      }
      case "address-observed": {
        if (fact.carriedTransition !== null) {
          const carried = this.status(fact.carriedTransition);
          if (carried.status !== "usable") return { status: "conflict", facts: carried.status === "conflict" ? carried.facts : [fact.carriedTransition], because: `its carried transition ${fact.carriedTransition} is ${carried.status}` };
          return { status: "usable", support: sortedIds([fact.id, fact.carriedTransition]) };
        }
        return { status: "usable", support: [fact.id] };
      }
    }
  }
}

function changeIndexKey(side: Side, successor: Did): string {
  return `${side}\u0000${successor}`;
}

function firstChannelOf(conflict: Conflict): Channel {
  switch (conflict.kind) {
    case "competing-changes":
      return conflict.context[0]!;
    case "cycle":
    case "identity-collision":
      return conflict.channels[0]!;
    case "identity-conflict":
      return conflict.variants[0]!.at;
  }
}
