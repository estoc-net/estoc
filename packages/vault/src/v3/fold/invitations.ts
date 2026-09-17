/**
 * The one-use invitations: each OOB disclosure for one use, the
 * consumption records that name it, and the receipts that could
 * consume it. A record is read on its own first — its disclosure and
 * source resolved, the source proof-free, addressed to the disclosed
 * DID under the invitation's `pthid`, and a complete witness — and only
 * complete records establish a consumer, the source's canonical peer
 * DID; then the records together give the invitation its state. A
 * recorded consumer is never reopened: erasure, retirement, denial, a
 * later conflict or a duplicate disclosure may make the invitation
 * unavailable or conflicted, but the consumer stays recorded. The
 * fold assigns no consumer and appends nothing: the candidates it
 * lists, in first-receipt order and each with why it may or may not be
 * consumed, are what the runtime walks to record one.
 */

import { didKeyName } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Did, DidId, EventId } from "../types.js";
import type { ChannelEvidence, Source } from "./channels.js";
import { compareReceiptKeys, receiptOrderKey } from "./channels.js";
import type { Continuity } from "./continuity.js";
import type { Erasures } from "./held.js";
import type { LocalDidEntity, RouteFold } from "./routes.js";
import { groupBy, type VaultEventSet } from "./set.js";

/**
 * What one `invitation.consumed` establishes on its own. Complete
 * names the consumer. Pending waits for a reference or evidence that
 * may still arrive. Invalid contradicts the record for good: a
 * disclosure that is not a one-use invitation, a source that is not a
 * proof-free receipt of that invitation at its DID, or a source whose
 * own evidence refuses it. Conflict is a source whose authentication
 * evidence contradicts itself.
 */
export type ConsumptionStatus = { status: "complete"; consumer: Did } | { status: "pending"; because: string } | { status: "invalid"; because: string } | { status: "conflict"; because: string };

export interface Consumption {
  readonly event: VaultEvent<"invitation.consumed">;
  readonly status: ConsumptionStatus;
}

/**
 * Whether a receipt may be recorded as the invitation's consumption
 * now. Eligible may. Deferred waits for evidence, and stops the walk
 * behind it: nothing later is selected past it. Refused is current
 * policy — the disclosed DID no longer live, the channel denied or the
 * peer superseded — and invalid is evidence that refuses the receipt
 * for good; both are skipped. An integrity conflict is an ordinal one
 * author gave to two observations; it leaves the invitation
 * conflicted and selects nothing.
 */
export type Eligibility = { status: "eligible" } | { status: "deferred"; because: string } | { status: "refused"; because: string } | { status: "invalid"; because: string } | { status: "integrity-conflict" };

export interface Candidate {
  readonly source: Source;
  readonly eligibility: Eligibility;
}

/**
 * Available while no consumer is recorded and nothing stands in the
 * way of recording one; consumed once exactly one consumer is; pending
 * while a record that could establish a consumer is incomplete;
 * unavailable while the disclosed DID cannot acquire a consumer;
 * conflict when the records disagree, the invitation's ID is disclosed
 * twice, or a candidate is caught in a receipt-integrity conflict.
 */
export type InvitationStatus = { status: "available" } | { status: "consumed"; consumer: Did } | { status: "pending"; because: string } | { status: "unavailable"; because: string } | { status: "conflict"; because: string };

export interface Invitation {
  readonly disclosure: VaultEvent<"did.disclosed">;
  readonly oobId: string;
  readonly didId: DidId;
  /** the disclosed DID's short form, once its entity reads consistently */
  readonly localDid: Did | null;
  /** every record naming this disclosure, in canonical order */
  readonly consumptions: readonly Consumption[];
  /** the one consumer the complete records agree on; null while none or while they disagree */
  readonly consumer: Did | null;
  readonly status: InvitationStatus;
  /** every retained, unerased, proof-free receipt at the disclosed DID under this invitation's ID, in first-receipt order */
  readonly candidates: readonly Candidate[];
}

export interface InvitationFold {
  /** each one-use OOB disclosure, by its event */
  readonly invitations: ReadonlyMap<EventId, Invitation>;
  /** every consumption record, by its event, whatever it names */
  readonly consumptions: ReadonlyMap<EventId, Consumption>;
  /** the invitations disclosed under one ID, in canonical order: more than one is a conflict */
  under(oobId: string): readonly Invitation[];
}

export function foldInvitations(set: VaultEventSet, routes: RouteFold, evidence: ChannelEvidence, continuity: Continuity, erasures: Erasures): InvitationFold {
  const disclosures = set.of("did.disclosed").filter(isOneUseInvitation);
  const byOobId = groupBy(disclosures, (event) => event.data.oobId!);
  const records = groupBy(set.of("invitation.consumed"), (event) => event.data.disclosureEventId as EventId);
  const receipts = groupBy(
    set.of("message.in").filter((event) => event.data.fromPrior === null && event.data.pthid !== null && !erasures.has(event.data.messageId)),
    (event) => `${event.data.localKeyName} ${event.data.pthid}`
  );

  const consumptions = new Map<EventId, Consumption>();
  for (const event of set.of("invitation.consumed")) consumptions.set(event.eventId, { event, status: consumptionStatus(event, set, evidence, continuity) });

  const invitations = new Map<EventId, Invitation>();
  for (const disclosure of disclosures) {
    const oobId = disclosure.data.oobId!;
    const entity = routes.dids.get(disclosure.data.didId);
    const own = (records.get(disclosure.eventId) ?? []).map((event) => consumptions.get(event.eventId)!);
    const candidates = (receipts.get(`${didKeyName(disclosure.data.didId, "key-agreement")} ${oobId}`) ?? [])
      .sort((a, b) => compareReceiptKeys(receiptOrderKey(a), receiptOrderKey(b)))
      .map((event) => candidateOf(evidence.sources.get(event.eventId)!, entity, evidence, continuity));
    const consumer = consumerOf(own);
    invitations.set(disclosure.eventId, {
      disclosure,
      oobId,
      didId: disclosure.data.didId,
      localDid: entity?.created?.did ?? null,
      consumptions: own,
      consumer,
      status: invitationStatus(own, consumer, byOobId.get(oobId)!.length, entity, candidates),
      candidates,
    });
  }
  return {
    invitations,
    consumptions,
    under: (oobId) => (byOobId.get(oobId) ?? []).map((event) => invitations.get(event.eventId)!),
  };
}

const isOneUseInvitation = (event: VaultEvent<"did.disclosed">) => event.data.as === "oob" && event.data.uses === "one";

function consumptionStatus(event: VaultEvent<"invitation.consumed">, set: VaultEventSet, evidence: ChannelEvidence, continuity: Continuity): ConsumptionStatus {
  const invalid = (because: string): ConsumptionStatus => ({ status: "invalid", because });
  const missing: string[] = [];

  const disclosed = set.resolve(event.data.disclosureEventId, "did.disclosed");
  let disclosure: VaultEvent<"did.disclosed"> | null = null;
  if (disclosed.status === "missing") missing.push("the disclosure it names is not here");
  else if (disclosed.status === "mismatched") return invalid(`the disclosure it names is a ${disclosed.event.type}`);
  else if (!isOneUseInvitation(disclosed.event)) return invalid("the disclosure it names is not a one-use invitation");
  else disclosure = disclosed.event;

  const resolved = set.resolve(event.data.sourceEventId, "message.in");
  if (resolved.status === "missing") missing.push("the source it names is not here");
  else if (resolved.status === "mismatched") return invalid(`the source it names is a ${resolved.event.type}`);
  else {
    const source = evidence.sources.get(resolved.event.eventId)!;
    const { data } = source.event;
    if (data.fromPrior !== null) return invalid("the source carries a proof");
    if (data.peerResolutionEventId === null) return invalid("the source is anonymous, in no pair");
    if (disclosure !== null) {
      if (data.localKeyName !== didKeyName(disclosure.data.didId, "key-agreement")) return invalid("the source is not at the disclosed DID's key-agreement key");
      if (data.pthid !== disclosure.data.oobId) return invalid("the source's pthid is not the invitation's ID");
    }
    const witness = continuity.witness(source.event.eventId);
    if (witness.status === "invalid") return invalid(`the source is no complete witness: ${witness.because}`);
    if (witness.status === "conflict") return { status: "conflict", because: `the source is no complete witness: ${witness.because}` };
    if (witness.status === "pending") missing.push(`the source is no complete witness: ${witness.because}`);
    else if (missing.length === 0) return { status: "complete", consumer: source.channel!.peerDid };
  }
  return { status: "pending", because: missing[0]! };
}

/** The one consumer the complete records name, null while they name none or more than one. */
function consumerOf(consumptions: readonly Consumption[]): Did | null {
  const consumers = new Set<Did>();
  for (const { status } of consumptions) if (status.status === "complete") consumers.add(status.consumer);
  return consumers.size === 1 ? [...consumers][0]! : null;
}

function invitationStatus(consumptions: readonly Consumption[], consumer: Did | null, disclosed: number, entity: LocalDidEntity | undefined, candidates: readonly Candidate[]): InvitationStatus {
  const conflict = (because: string): InvitationStatus => ({ status: "conflict", because });
  if (disclosed > 1) return conflict("the invitation's ID is disclosed more than once");
  const complete = consumptions.filter(({ status }) => status.status === "complete");
  if (complete.length > 0 && consumer === null) return conflict("the complete records name different consumers");
  for (const { status } of consumptions) if (status.status === "conflict") return conflict(status.because);
  if (consumer !== null) return { status: "consumed", consumer };
  for (const { status } of consumptions) if (status.status === "pending") return { status: "pending", because: status.because };
  if (entity === undefined || entity.created === null) return { status: "unavailable", because: "the disclosed DID has no consistent creation here" };
  if (entity.conflict) return { status: "unavailable", because: `the disclosed DID is in conflict: ${entity.faults[0]}` };
  if (entity.retired !== null) return { status: "unavailable", because: "the disclosed DID is retired" };
  for (const { eligibility } of candidates) {
    if (eligibility.status === "integrity-conflict") return conflict("a candidate receipt is caught in a receipt-integrity conflict");
    if (eligibility.status === "deferred") return { status: "pending", because: eligibility.because };
    if (eligibility.status === "eligible") break;
  }
  return { status: "available" };
}

/**
 * A receipt's eligibility to be recorded now, in the order the verdicts
 * are final: what refuses the receipt for good, then what current
 * policy refuses, then what only waits. A complete witness at the
 * disclosed DID has that DID's entity consistent and confirmed; what
 * can still keep the entity from being live is its route or mediation,
 * which may recover.
 */
function candidateOf(source: Source, entity: LocalDidEntity | undefined, evidence: ChannelEvidence, continuity: Continuity): Candidate {
  const candidate = (eligibility: Eligibility): Candidate => ({ source, eligibility });
  if (evidence.receipts.affected.has(source.event.data.messageId)) return candidate({ status: "integrity-conflict" });
  const witness = continuity.witness(source.event.eventId);
  if (witness.status === "invalid" || witness.status === "conflict") return candidate({ status: "invalid", because: witness.because });
  if (entity?.retired != null) return candidate({ status: "refused", because: "the disclosed DID is retired" });
  if (witness.status === "pending") return candidate({ status: "deferred", because: witness.because });
  const channel = source.channel!;
  if (continuity.blocked(channel).length > 0) return candidate({ status: "refused", because: "the channel is denied" });
  if (continuity.superseded(channel)) return candidate({ status: "refused", because: "the peer has replaced its DID" });
  if (!entity!.live) return candidate({ status: "deferred", because: entity!.faults[0]! });
  return candidate({ status: "eligible" });
}
