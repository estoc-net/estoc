/**
 * Continuity over the channel evidence, derived by `@estoc/continuity`.
 * The evidence is projected into the package's facts under IDs every
 * replica derives from the same event CIDs: an authenticated proof-free
 * receipt is an address observation at its pair; a receipt whose proof
 * verified and bound is the peer transition and the observation of the
 * successor, both of that one receipt; a decision that passes its own
 * checks is a local decision at its fixed predecessor pair, naming its
 * source's observation when it has one. The package derives the one
 * model over all of them — links, joins, contexts, conflicts, heads,
 * confirmation — and nothing here builds a second graph. What is here
 * is the host's reading of that model beside the evidence's own
 * verdicts: each carrier's or decision's status and each source's
 * standing as a witness, the evidence's refusals first and the model's
 * second; which channels take no new work; the admitted witness by
 * which an address is confirmed for new work, since the model confirms
 * by every usable observation and a saved decision may rest on one no
 * admission names, while nothing new may; the denials that cover a
 * channel through the history; and the saved decisions of a context,
 * projected or not, since a decision still waiting for its evidence
 * already forbids another successor.
 */

import { deriveContinuity, successorChannel, type Conflict, type ContinuityFact, type Continuity as ContinuityModel, type FactId, type HeadResult } from "@estoc/continuity";

import { channelKey, channelOf, compareChannels, observationFactId, sameChannel, transitionFactId } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Channel, EventCid } from "../types.js";
import type { AdmissionFold } from "./admission.js";
import type { ChannelEvidence, Decision, Source } from "./channels.js";
import type { VaultEventSet } from "./set.js";

/** The continuity a carrier's proof, or a decision, has reached; what a UI shows beside the message. */
export type Status =
  | { status: "not-present" }
  | { status: "pending-proof" }
  | { status: "pending-history"; because: string }
  | { status: "verified" }
  /** an ending: retained, applied to nothing */
  | { status: "unsupported"; because: string }
  | { status: "invalid"; because: string }
  | { status: "conflict"; because: string };

/**
 * Whether a source is a complete witness: authenticated, in a pair,
 * and any proof it brought verified, bound and not in a conflict. A
 * proof-free receipt witnesses on its own authentication alone: a
 * conflict in the continuity around its pair stops new work there, but
 * does not unmake what the receipt observed. This is what an operation
 * checks before it derives anything from the source; positive evidence
 * alone authorizes nothing.
 */
export type Witness = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string } | { status: "invalid"; because: string };

/** A conflict of the model with the channels its scope reaches: its context and the successors the claims in it name. */
export interface ScopedConflict {
  readonly conflict: Conflict;
  readonly channels: readonly Channel[];
}

export interface Continuity {
  /** the facts the evidence projects, in the model's canonical order */
  readonly facts: readonly ContinuityFact[];
  /** the package's model over them, for what the queries below do not summarize */
  readonly model: ContinuityModel;
  readonly conflicts: readonly ScopedConflict[];
  /** a carrier's or a decision's status; a proof-free source is `not-present` */
  status(cid: EventCid): Status;
  witness(sourceEventCid: EventCid): Witness;
  /** does a conflict reach the channel or what lies ahead of it: no new work, no head */
  conflicted(channel: Channel): boolean;
  /** has the peer replaced its DID anywhere in the channel's local-only context: no new work from the old peer */
  superseded(channel: Channel): boolean;
  /** the unique usable channel forward replacements lead to, the channel itself when no fact mentions it; null while a replacement waits, conflicts or is not unique */
  head(channel: Channel): Channel | null;
  /**
   * The first admitted observation, in the model's order, by which the
   * peer or a usable successor of it wrote to exactly this local DID:
   * what a new decision, a proof-free package or a disclosure to a
   * mediator rests on. Null while no such observation is admitted,
   * whatever the model confirms by observations no admission names: a
   * saved decision is validated over those, and nothing new is.
   */
  confirmedBy(localDid: Channel["localDid"], peerDid: Channel["peerDid"]): Source | null;
  /** may a carrier in `carrier` acknowledge an outbound of `outbound`: the same channel or a usable role-preserving path */
  ackPath(outbound: Channel, carrier: Channel): boolean;
  /** the denials that cover the channel: on the pair itself, or on a pair the history makes it succeed, conflicted or not, when that denial includes successors */
  blocked(channel: Channel): readonly VaultEvent<"channel.blocked">[];
  /** every decision rotating away from the channel's local DID anywhere in its peer-only context, whatever its status and whether or not it is projected */
  decisionsIn(channel: Channel): readonly Decision[];
}

/** The facts the channel evidence establishes: every complete proof-free receipt, every bound proof, every decision that passes its own checks. */
export function projectFacts(evidence: ChannelEvidence): ContinuityFact[] {
  const facts: ContinuityFact[] = [];
  for (const source of evidence.sources.values()) {
    if (source.channel === null || source.standing.status !== "complete") continue;
    const { cid, data } = source.event;
    if (data.fromPrior === null) facts.push({ kind: "address-observed", id: observationFactId(cid), at: source.channel, carriedTransition: null, receipt: cid });
    else facts.push(...(evidence.carriers.get(cid)?.facts ?? []));
  }
  for (const decision of evidence.decisions.values()) if (decision.status.status === "candidate") facts.push(decision.status.fact);
  return facts;
}

export function foldContinuity(set: VaultEventSet, evidence: ChannelEvidence, admissions: AdmissionFold): Continuity {
  return new ContinuityFold(set, evidence, admissions, deriveContinuity(projectFacts(evidence)));
}

/** A channel as the model returns it, which compares DIDs byte for byte and never parses them, so it is the one the fold gave it. */
type ModelChannel = Readonly<{ localDid: string; peerDid: string }>;
const asChannel = (channel: ModelChannel): Channel => channel as Channel;

class ContinuityFold implements Continuity {
  readonly facts: readonly ContinuityFact[];
  readonly conflicts: readonly ScopedConflict[];
  private readonly denials: readonly VaultEvent<"channel.blocked">[];
  private readonly heads = new Map<string, HeadResult>();
  private readonly covered = new Map<EventCid, ReadonlySet<string>>();
  private readonly observed = new Map<FactId, Source>();

  constructor(
    set: VaultEventSet,
    private readonly evidence: ChannelEvidence,
    private readonly admissions: AdmissionFold,
    readonly model: ContinuityModel
  ) {
    this.facts = model.facts;
    const byId = new Map(model.facts.map((fact) => [fact.id, fact]));
    this.conflicts = model.conflicts().map((conflict) => ({ conflict, channels: scopeOf(conflict, byId) }));
    this.denials = set.of("channel.blocked");
    for (const source of evidence.sources.values()) this.observed.set(observationFactId(source.event.cid), source);
  }

  private headOf(channel: Channel): HeadResult {
    const key = channelKey(channel);
    let head = this.heads.get(key);
    if (head === undefined) this.heads.set(key, (head = this.model.head(channel)));
    return head;
  }

  status(cid: EventCid): Status {
    const carrier = this.evidence.carriers.get(cid);
    if (carrier !== undefined) {
      const { proof, source } = carrier;
      if (proof.status === "invalid" || proof.status === "unsupported") return proof;
      if (source.standing.status === "conflict") return { status: "invalid", because: `the carrier's own authentication is contradicted: ${source.standing.because}` };
      if (proof.status === "pending-proof") return proof;
      if (source.standing.status === "incomplete") return { status: "pending-history", because: `the carrier's own authentication is incomplete: ${source.standing.because}` };
      return this.factStatus(transitionFactId(cid));
    }
    if (this.evidence.sources.has(cid)) return { status: "not-present" };
    const decision = this.evidence.decisions.get(cid);
    if (decision === undefined) return { status: "pending-history", because: "no carrier or decision here has this ID" };
    const { status } = decision;
    if (status.status === "pending") return { status: "pending-history", because: status.because };
    if (status.status !== "candidate") return status;
    return this.factStatus(status.fact.id);
  }

  /** The model's status of a projected fact as the host reports it: usable is verified, waiting or an unresolved reference is history still to arrive. */
  private factStatus(id: FactId): Status {
    const status = this.model.status(id);
    switch (status.status) {
      case "usable":
        return { status: "verified" };
      case "conflict":
        return { status: "conflict", because: status.because };
      case "waiting":
        return { status: "pending-history", because: status.because };
      case "unresolved":
        return { status: "pending-history", because: `${status.missing.join(", ")} is not here` };
      case "invalid":
        return { status: "invalid", because: status.because };
      case "identity-conflict":
        return { status: "conflict", because: "the fact has more than one value" };
      case "unknown":
        return { status: "pending-history", because: "the fact is not projected" };
    }
  }

  witness(sourceEventCid: EventCid): Witness {
    const source = this.evidence.sources.get(sourceEventCid);
    if (source === undefined) return { status: "pending", because: "the source is not here" };
    if (source.event.data.peerResolutionEventCid === null) return { status: "invalid", because: "the source is anonymous, in no pair" };
    if (source.standing.status === "conflict") return { status: "conflict", because: source.standing.because };
    const proof = this.evidence.carriers.get(sourceEventCid)?.proof;
    if (proof?.status === "invalid" || proof?.status === "unsupported") return { status: "invalid", because: proof.because };
    if (source.standing.status === "incomplete") return { status: "pending", because: source.standing.because };
    if (proof?.status === "pending-proof") return { status: "pending", because: "the proof is not yet verified" };
    if (proof === undefined) return { status: "complete" };
    const status = this.model.status(observationFactId(sourceEventCid));
    if (status.status === "usable") return { status: "complete" };
    return { status: "conflict", because: "because" in status ? status.because : `the observation is ${status.status}` };
  }

  conflicted(channel: Channel): boolean {
    return this.headOf(channel).status === "conflict";
  }

  superseded(channel: Channel): boolean {
    return this.model.changes(channel, "peer").some((record) => record.change.kind === "rotate");
  }

  head(channel: Channel): Channel | null {
    const head = this.headOf(channel);
    if (head.status === "head") return asChannel(head.channel);
    return head.status === "no-evidence" ? channel : null;
  }

  confirmedBy(localDid: Channel["localDid"], peerDid: Channel["peerDid"]): Source | null {
    if (localDid === peerDid) return null;
    const confirmation = this.model.confirmation(localDid, peerDid);
    if (confirmation.status !== "confirmed") return null;
    for (const { id } of confirmation.observations) {
      const source = this.observed.get(id);
      if (source !== undefined && this.admissions.admitted(source.event.cid)) return source;
    }
    return null;
  }

  ackPath(outbound: Channel, carrier: Channel): boolean {
    return sameChannel(outbound, carrier) || this.model.path(outbound, carrier).status === "path";
  }

  blocked(channel: Channel): readonly VaultEvent<"channel.blocked">[] {
    const key = channelKey(channel);
    return this.denials.filter((denial) => {
      const pair = channelOf(denial.data.localDid, denial.data.peerDid);
      if (sameChannel(pair, channel)) return true;
      if (!denial.data.includeSuccessors) return false;
      let covered = this.covered.get(denial.cid);
      if (covered === undefined) this.covered.set(denial.cid, (covered = this.successorsOf(pair)));
      return covered.has(key);
    });
  }

  /** The keys of every channel the positive history leads forward to from the pair, the pair's own included. */
  private successorsOf(pair: Channel): ReadonlySet<string> {
    const forward = new Map<string, string[]>();
    for (const link of this.model.history(pair).links) {
      const from = channelKey(asChannel(link.from));
      const list = forward.get(from);
      if (list === undefined) forward.set(from, [channelKey(asChannel(link.to))]);
      else list.push(channelKey(asChannel(link.to)));
    }
    const reached = new Set<string>([channelKey(pair)]);
    const frontier = [channelKey(pair)];
    while (frontier.length > 0) {
      for (const next of forward.get(frontier.pop()!) ?? []) {
        if (reached.has(next)) continue;
        reached.add(next);
        frontier.push(next);
      }
    }
    return reached;
  }

  decisionsIn(channel: Channel): readonly Decision[] {
    const context = new Set(this.model.history(channel).peerContext.map((member) => channelKey(asChannel(member))));
    const decisions: Decision[] = [];
    for (const decision of this.evidence.decisions.values()) {
      if (decision.channel === null || decision.channel.localDid !== channel.localDid) continue;
      if (context.has(channelKey(decision.channel))) decisions.push(decision);
    }
    return decisions;
  }
}

/** The channels a conflict reaches: its context and the successors its claims name, the channels of a cycle or a refused join, the pairs of a repeated ID's variants. */
function scopeOf(conflict: Conflict, byId: ReadonlyMap<FactId, ContinuityFact>): Channel[] {
  const channels = new Map<string, Channel>();
  const add = (channel: ModelChannel | null) => {
    if (channel !== null) channels.set(channelKey(asChannel(channel)), asChannel(channel));
  };
  switch (conflict.kind) {
    case "competing-changes":
      for (const channel of conflict.context) add(channel);
      for (const { facts } of conflict.changes) {
        for (const id of facts) {
          const fact = byId.get(id);
          if (fact !== undefined && fact.kind !== "address-observed") add(successorChannel(fact));
        }
      }
      break;
    case "cycle":
    case "identity-collision":
      for (const channel of conflict.channels) add(channel);
      break;
    case "identity-conflict":
      for (const fact of conflict.variants) {
        add(fact.at);
        if (fact.kind !== "address-observed") add(successorChannel(fact));
      }
      break;
  }
  return [...channels.values()].sort(compareChannels);
}
