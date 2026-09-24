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

/** Which endpoint a change replaces: `peer` for the peer's rotation or ending, `local` for ours. */
export type Side = Replaces;

export type Conflict =
  /** two different changes of one endpoint claimed in one context, a saved decision counted whether or not it is confirmed yet */
  | { kind: "competing-changes"; side: Side; context: readonly Channel[]; changes: readonly { change: Change; facts: readonly FactId[] }[] }
  /** links that lead back to a pair they left */
  | { kind: "cycle"; channels: readonly Channel[]; facts: readonly FactId[] }
  /** a join that would pair a DID with itself */
  | { kind: "identity-collision"; channels: readonly Channel[]; facts: readonly FactId[] }
  /** one fact ID carrying more than one value; every variant is kept and none is chosen */
  | { kind: "identity-conflict"; id: FactId; variants: readonly ContinuityFact[] };

/**
 * The answer to `head`, in the order the variants take precedence: a
 * conflict reaching the pair outranks an ending, an ending outranks
 * choices still waiting, and only then is a unique usable forward pair
 * the head. A known forward change without usable continuation never
 * falls back to the old pair.
 */
export type HeadResult =
  /** the unique pair the usable forward links lead to, the queried pair itself when none leads away; `support` re-derives those links */
  | { status: "head"; channel: Channel; support: readonly FactId[] }
  /** an unambiguous ending of either side applies to the pair through usable links */
  | { status: "ended"; endings: readonly FactId[] }
  /** saved rotations of the endpoint are not established yet: `waiting` names them, `missing` the exact references they need that are not here */
  | { status: "unresolved"; waiting: readonly FactId[]; missing: readonly FactId[] }
  /** a conflict reaches the pair, or a claim reaches it only through history no usable link vouches for; `facts` are the claims involved */
  | { status: "conflict"; facts: readonly FactId[] }
  /** no fact mentions the pair, not even as a successor */
  | { status: "no-evidence" };

/** What a fact contributes to the snapshot; a change record and an ending record carry it beside the fact. */
export type FactStatus =
  /** no fact has this ID */
  | { status: "unknown" }
  /** the ID has more than one value */
  | { status: "identity-conflict"; variants: readonly ContinuityFact[] }
  /** the exact reference it names is of the wrong kind or the wrong pair, so it can never link */
  | { status: "invalid"; because: string }
  /** an exact reference it names is not in the snapshot; another replica may supply it */
  | { status: "unresolved"; missing: readonly FactId[] }
  /** its pair, its successor pair or a reference it names is in conflict */
  | { status: "conflict"; facts: readonly FactId[]; because: string }
  /** a rotation whose predecessor address no usable observation confirms yet */
  | { status: "waiting"; because: string }
  /** it links or witnesses with authority; `support` is the fact and everything its authority rests on */
  | { status: "usable"; support: readonly FactId[] };

export type PathResult =
  /** one directed usable path, the queried pair first; `support` re-derives every link on it */
  | { status: "path"; channels: readonly Channel[]; support: readonly FactId[] }
  /** no usable path preserves the roles from one pair to the other */
  | { status: "none" }
  /** a conflict reaches either end */
  | { status: "conflict"; facts: readonly FactId[] };

/** One observation that confirms the address, with a complete witness: the observation, the transition it carried and the usable peer path to the observer. */
export type Confirmation = { id: FactId; at: Channel; support: readonly FactId[] };

export type ConfirmationResult =
  /** the usable observations by which the peer, or a usable successor of it, wrote to exactly this local DID */
  | { status: "confirmed"; observations: readonly Confirmation[] }
  /** no such observation is usable; `unusable` lists the observations that would confirm it but stand on ambiguous or conflicted evidence */
  | { status: "unconfirmed"; unusable: readonly FactId[] }
  /** a conflict reaches the pair */
  | { status: "conflict"; facts: readonly FactId[] };

/** A rotation or ending as it was claimed, `to` the successor pair it names or null for an ending. */
export type ChangeRecord = { id: FactId; at: Channel; change: Change; to: Channel | null; status: FactStatus };

/**
 * A link of the positive graph: every rotation the evidence shows, and
 * every join two rotations imply, whether or not an operation may rely
 * on it. `derived` marks a join; `usable` marks a link the usable graph
 * has too.
 */
export type PositiveLink = { from: Channel; to: Channel; replaces: Side; support: readonly FactId[]; derived: boolean; usable: boolean };

export type EndingRecord = { id: FactId; at: Channel; side: Side; status: FactStatus };

/** Everything the positive graph connects to a channel, and the two contexts the channel is in. */
export type History = { links: readonly PositiveLink[]; endings: readonly EndingRecord[]; localContext: readonly Channel[]; peerContext: readonly Channel[] };

/**
 * Deterministic queries over one snapshot. Every answer is relative to
 * the facts supplied: the model cannot say that unknown history does
 * not exist, and more facts may expose a conflict that removes an
 * answer given before. Answers preserve support rather than only a
 * verdict, and the support of an affirmative answer re-derives it under
 * the same profile on its own. Nothing here authorizes an operation:
 * whether a head may be written to, or a path admits a message, is the
 * host's decision under its own policy.
 */
export interface Continuity {
  /** the facts as derived over, in canonical order, every variant of a repeated ID included */
  readonly facts: readonly ContinuityFact[];
  /**
   * The unique usable pair the forward changes of `channel` lead to.
   * Saved rotations of the endpoint anywhere in the pair's positive
   * context are answered for: one the same usable change covers is
   * provenance, one at a pair usable links connect is `unresolved`, and
   * one only diagnostic history connects is `conflict`. A collided or
   * waiting claim of a change that independent unambiguous facts
   * establish anyway does not block the head.
   */
  head(channel: Channel): HeadResult;
  /** the changes of that side's endpoint across the channel's context, whatever their status; a supersession check reads these */
  changes(channel: Channel, side: Side): readonly ChangeRecord[];
  /** one directed usable path from one pair to the other, preserving roles; alternative paths are not enumerated */
  path(from: Channel, to: Channel): PathResult;
  /**
   * Whether the peer, or a usable successor of it, has written to
   * exactly this local DID. Each observation comes with one complete
   * witness; alternative paths to the same observation are not
   * enumerated. Confirms nothing about any other local address.
   */
  confirmation(localDid: Did, peerDid: Did): ConfirmationResult;
  /** every positive link connected to the channel, the endings in its contexts and the contexts themselves; connectivity here is history, not current usability */
  history(channel: Channel): History;
  /**
   * Every saved decision rotating away from the channel's local DID, or
   * ending there, across its peer-only context. Only decisions in the
   * snapshot: a saved choice the host has not projected yet is invisible
   * here, so an empty answer alone does not clear allocating a successor.
   */
  localDecisions(channel: Channel): readonly ChangeRecord[];
  /** every domain conflict with its scope, then every identity conflict; none is resolved and no history is dropped */
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
   * A pair that only a conflicted link leads to is in that conflict. A
   * branch that only provenance leads to either rejoins the usable
   * history through the joins it implies, or is a branch of its own and
   * is reported as such.
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
