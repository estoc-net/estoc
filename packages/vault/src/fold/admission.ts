/**
 * The application admissions: the runtime's durable acceptance of one
 * exact observation for application use, and what every observation
 * stands as without one. A `message.in` records that something was
 * received; only an admission naming it lets it speak for its input's
 * intent, establish the input, consume an invitation or acknowledge
 * an outbound. An admission is effective when its source stands as
 * positive evidence on its own — its authentication complete, its
 * channel known, any proof it brought verified and bound — and no
 * author gave its ordinal to another observation. That is read from
 * the source's own evidence alone, never from the continuity around it
 * or the intents of its input, so that a replacement or a contradiction
 * learned later withdraws no acceptance already recorded. Missing
 * evidence leaves an admission pending; evidence that refuses the
 * source refuses it for good.
 *
 * Whether an observation without one may be admitted now is the second
 * reading here, over the whole fold: what refuses it for good, then
 * what current policy holds against it — the peer's replacement, the
 * channel's denial, a conflict in the continuity its proof needs, a
 * contradiction of the intent its input already admitted — then what
 * still waits. The candidates, in first-receipt order, are what the
 * runtime walks when it records admissions; the fold records none. The
 * disposition sums it up for anyone shown the observation: refused,
 * admitted, ignored because the peer moved on, or still pending with
 * what stands in the way.
 */

import type { VaultEvent } from "../schema.js";
import type { EventCid } from "../types.js";
import type { ChannelEvidence, Source } from "./channels.js";
import { compareReceiptKeys, receiptOrderKey } from "./channels.js";
import type { Continuity } from "./continuity.js";
import type { InboundFold } from "./inbound.js";
import { groupBy, type VaultEventSet } from "./set.js";

/**
 * What one `message.admitted` establishes on its own. Effective admits
 * its source. Pending waits for evidence of the source that may still
 * arrive. Invalid is for good: the record names no observation, or one
 * that is anonymous, contradicted, under a refused proof or caught in a
 * receipt-integrity conflict.
 */
export type AdmissionStatus = { status: "effective" } | { status: "pending"; because: string } | { status: "invalid"; because: string };

export interface Admission {
  readonly event: VaultEvent<"message.admitted">;
  readonly status: AdmissionStatus;
}

export interface AdmissionFold {
  /** every record, by its event */
  readonly admissions: ReadonlyMap<EventCid, Admission>;
  /** every record naming the observation, in canonical order */
  of(sourceEventCid: EventCid): readonly Admission[];
  /** does an effective admission name the observation */
  admitted(sourceEventCid: EventCid): boolean;
}

export function foldAdmissions(set: VaultEventSet, evidence: ChannelEvidence): AdmissionFold {
  const admissions = new Map<EventCid, Admission>();
  for (const event of set.of("message.admitted")) admissions.set(event.cid, { event, status: admissionStatus(event, set, evidence) });
  const bySource = groupBy(admissions.values(), (admission) => admission.event.data.sourceEventCid as EventCid);
  const none: readonly Admission[] = [];
  return {
    admissions,
    of: (sourceEventCid) => bySource.get(sourceEventCid) ?? none,
    admitted: (sourceEventCid) => (bySource.get(sourceEventCid) ?? none).some(({ status }) => status.status === "effective"),
  };
}

/** Why a source can never be admitted, or null: its own evidence read for what contradicts it before what it lacks. */
function refusedForGood(source: Source, evidence: ChannelEvidence): string | null {
  const { cid, data } = source.event;
  if (data.peerResolutionEventCid === null) return "the source is anonymous, in no channel";
  if (source.standing.status === "conflict") return `the source's authentication is contradicted: ${source.standing.because}`;
  const proof = evidence.carriers.get(cid)?.proof;
  if (proof?.status === "invalid" || proof?.status === "unsupported") return `the source's proof is ${proof.status}: ${proof.because}`;
  return null;
}

/** What a source still waits for before it is positive evidence, or null. */
function stillMissing(source: Source, evidence: ChannelEvidence): string | null {
  if (source.standing.status === "incomplete") return `the source's authentication is incomplete: ${source.standing.because}`;
  if (evidence.carriers.get(source.event.cid)?.proof.status === "pending-proof") return "the source's proof is not yet verified";
  return null;
}

const INTEGRITY = "one author gave the source's ordinal to another observation";

function admissionStatus(event: VaultEvent<"message.admitted">, set: VaultEventSet, evidence: ChannelEvidence): AdmissionStatus {
  const resolved = set.resolve(event.data.sourceEventCid, "message.in");
  if (resolved.status === "missing") return { status: "pending", because: "the source it names is not here" };
  if (resolved.status === "mismatched") return { status: "invalid", because: `the source it names is a ${resolved.event.type}` };
  const source = evidence.sources.get(resolved.event.cid)!;
  const refused = refusedForGood(source, evidence);
  if (refused !== null) return { status: "invalid", because: refused };
  if (evidence.receipts.affected.has(source.event.data.messageId)) return { status: "invalid", because: INTEGRITY };
  const missing = stillMissing(source, evidence);
  if (missing !== null) return { status: "pending", because: missing };
  return { status: "effective" };
}

/**
 * Whether an observation may be admitted now. Eligible may. Deferred
 * waits for evidence that may still arrive. Refused is current policy:
 * the peer has replaced its DID in the channel's context, the channel
 * is denied, the continuity the observation's proof needs is in
 * conflict, or the observation contradicts the intent its input has
 * admitted. Invalid is for good. An integrity conflict is an ordinal
 * one author gave to two observations: no admission, and no tie-break
 * by event order.
 */
export type Eligibility = { status: "eligible" } | { status: "deferred"; because: string } | { status: "refused"; because: string } | { status: "invalid"; because: string } | { status: "integrity-conflict" };

export interface AdmissionCandidate {
  readonly source: Source;
  readonly eligibility: Eligibility;
}

/**
 * What an observation is to the application, the first that applies:
 * refused for good, with the reason; admitted by at least one
 * effective admission, whatever policy says now; ignored because the
 * peer has replaced its DID and no admission of it is effective, one
 * still waiting for evidence included; or pending, with the evidence
 * it lacks, the admission that waits or the blocker current policy
 * holds against it.
 */
export type Disposition =
  | { status: "refused"; because: string }
  | { status: "admitted"; admissions: readonly Admission[] }
  | { status: "ignored-superseded" }
  | { status: "pending-admission"; because: string };

export interface Dispositions {
  /** every observation no effective or pending admission names, in first-receipt order, each with whether it may be admitted now */
  readonly candidates: readonly AdmissionCandidate[];
  /** the observation as a candidate; null when an effective or pending admission names it, or it is not here */
  candidate(sourceEventCid: EventCid): AdmissionCandidate | null;
  disposition(sourceEventCid: EventCid): Disposition;
}

export function foldDispositions(evidence: ChannelEvidence, continuity: Continuity, admissions: AdmissionFold, inbound: InboundFold): Dispositions {
  const eligibilities = new Map<EventCid, Eligibility>();
  const candidates: AdmissionCandidate[] = [];
  const byCid = new Map<EventCid, AdmissionCandidate>();
  for (const source of evidence.sources.values()) {
    const { cid } = source.event;
    const eligibility = eligibilityOf(source, evidence, continuity, inbound);
    eligibilities.set(cid, eligibility);
    if (admissions.of(cid).some(({ status }) => status.status !== "invalid")) continue;
    const candidate = { source, eligibility };
    candidates.push(candidate);
    byCid.set(cid, candidate);
  }
  candidates.sort((a, b) => compareReceiptKeys(receiptOrderKey(a.source.event), receiptOrderKey(b.source.event)));
  return {
    candidates,
    candidate: (sourceEventCid) => byCid.get(sourceEventCid) ?? null,
    disposition: (sourceEventCid) => {
      const source = evidence.sources.get(sourceEventCid);
      if (source === undefined) return { status: "pending-admission", because: "the source is not here" };
      const own = admissions.of(sourceEventCid);
      const effective = own.filter(({ status }) => status.status === "effective");
      if (effective.length > 0) return { status: "admitted", admissions: effective };
      const eligibility = eligibilities.get(sourceEventCid)!;
      if (eligibility.status === "invalid") return { status: "refused", because: eligibility.because };
      if (eligibility.status === "integrity-conflict") return { status: "refused", because: INTEGRITY };
      if (source.channel !== null && continuity.superseded(source.channel)) return { status: "ignored-superseded" };
      const waiting = own.find(({ status }) => status.status === "pending");
      if (waiting !== undefined) return { status: "pending-admission", because: `an admission is recorded and waits: ${(waiting.status as { because: string }).because}` };
      if (eligibility.status === "eligible") return { status: "pending-admission", because: "the observation is not yet reconciled" };
      return { status: "pending-admission", because: eligibility.because };
    },
  };
}

/**
 * The verdicts in the order they are final: what refuses the
 * observation for good, the integrity of its receipt, what it still
 * lacks to be positive evidence, then current policy over the
 * channel it is positive in and the input it observes.
 */
function eligibilityOf(source: Source, evidence: ChannelEvidence, continuity: Continuity, inbound: InboundFold): Eligibility {
  const refused = refusedForGood(source, evidence);
  if (refused !== null) return { status: "invalid", because: refused };
  const { cid, data } = source.event;
  if (evidence.receipts.affected.has(data.messageId)) return { status: "integrity-conflict" };
  const missing = stillMissing(source, evidence);
  if (missing !== null) return { status: "deferred", because: missing };
  const witness = continuity.witness(cid);
  if (witness.status === "conflict") return { status: "refused", because: `the continuity its proof establishes is in conflict: ${witness.because}` };
  if (witness.status !== "complete") return { status: "deferred", because: witness.because };
  const channel = source.channel!;
  if (continuity.superseded(channel)) return { status: "refused", because: "the peer has replaced its DID" };
  if (continuity.blocked(channel).length > 0) return { status: "refused", because: "the channel is denied" };
  const execution = inbound.ofSource(cid);
  if (execution?.status.status === "conflict") return { status: "refused", because: `the input's admitted intents disagree: ${execution.status.because}` };
  if (execution !== null && execution.intentHash !== null && execution.intentHash !== data.intentHash) return { status: "refused", because: "the observation contradicts the intent its input has admitted" };
  return { status: "eligible" };
}
