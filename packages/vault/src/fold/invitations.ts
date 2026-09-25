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
 * unavailable or conflicted, but the consumer stays recorded. A new
 * consumer is held to more than the record: its receipt is one
 * observation of a logical input, and an input whose authenticated
 * intents disagree consumes nothing, whichever observation of it the
 * invitation would take. The fold assigns no consumer and appends
 * nothing: the candidates it lists, in first-receipt order and each
 * with why it may or may not be consumed, are what the runtime walks
 * to record one.
 */

import { didKeyName } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Did, DidId, EventCid } from "../types.js";
import type { ChannelEvidence, Source } from "./channels.js";
import { compareReceiptKeys, receiptOrderKey } from "./channels.js";
import type { Continuity } from "./continuity.js";
import type { Erasures } from "./held.js";
import type { InboundFold } from "./inbound.js";
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
 * policy — the disclosed DID or its route ended, the channel denied,
 * the peer superseded or the channel in a continuity conflict — and
 * invalid is evidence that refuses the receipt for good: its own, or
 * the disagreement of its input's authenticated intents; both are
 * skipped. An integrity conflict is an ordinal one author gave to two
 * observations; reached before an eligible receipt, it leaves the
 * invitation conflicted and selects nothing.
 */
export type Eligibility = { status: "eligible" } | { status: "deferred"; because: string } | { status: "refused"; because: string } | { status: "invalid"; because: string } | { status: "integrity-conflict" };

export interface Candidate {
  readonly source: Source;
  readonly eligibility: Eligibility;
}

/**
 * Available while no consumer is recorded and nothing stands in the
 * way of recording one; consumed once exactly one consumer is; pending
 * while a record that could establish a consumer is incomplete, or a
 * candidate ahead of every eligible one waits for evidence;
 * unavailable while the disclosed DID's lifecycle refuses a consumer;
 * conflict when the records disagree, the invitation's ID is disclosed
 * twice, or the walk reaches a receipt-integrity conflict before an
 * eligible receipt.
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
  readonly invitations: ReadonlyMap<EventCid, Invitation>;
  /** every consumption record, by its event, whatever it names */
  readonly consumptions: ReadonlyMap<EventCid, Consumption>;
  /** the one-use invitations disclosed under one ID, in canonical order; any other OOB disclosure of the ID conflicts them too */
  under(oobId: string): readonly Invitation[];
}

export function foldInvitations(set: VaultEventSet, routes: RouteFold, evidence: ChannelEvidence, continuity: Continuity, inbound: InboundFold, erasures: Erasures): InvitationFold {
  const byOobId = groupBy(
    set.of("did.disclosed").filter((event) => event.data.as === "oob"),
    (event) => event.data.oobId!
  );
  const disclosures = set.of("did.disclosed").filter(isOneUseInvitation);
  const records = groupBy(set.of("invitation.consumed"), (event) => event.data.disclosureEventCid as EventCid);
  const receipts = groupBy(
    set.of("message.in").filter((event) => event.data.fromPrior === null && event.data.pthid !== null && !erasures.has(event.data.messageId)),
    (event) => `${event.data.localKeyName} ${event.data.pthid}`
  );

  const consumptions = new Map<EventCid, Consumption>();
  for (const event of set.of("invitation.consumed")) consumptions.set(event.cid, { event, status: consumptionStatus(event, set, evidence, continuity) });

  const invitations = new Map<EventCid, Invitation>();
  for (const disclosure of disclosures) {
    const oobId = disclosure.data.oobId!;
    const entity = routes.dids.get(disclosure.data.didId);
    const lifecycle = lifecycleOf(entity, routes);
    const own = (records.get(disclosure.cid) ?? []).map((event) => consumptions.get(event.cid)!);
    const candidates = (receipts.get(`${didKeyName(disclosure.data.didId, "key-agreement")} ${oobId}`) ?? [])
      .sort((a, b) => compareReceiptKeys(receiptOrderKey(a), receiptOrderKey(b)))
      .map((event) => candidateOf(evidence.sources.get(event.cid)!, lifecycle, evidence, continuity, inbound));
    const consumer = consumerOf(own);
    invitations.set(disclosure.cid, {
      disclosure,
      oobId,
      didId: disclosure.data.didId,
      localDid: entity?.created?.did ?? null,
      consumptions: own,
      consumer,
      status: invitationStatus(own, consumer, byOobId.get(oobId)!.length, lifecycle, candidates),
      candidates,
    });
  }
  return {
    invitations,
    consumptions,
    under: (oobId) => (byOobId.get(oobId) ?? []).filter(isOneUseInvitation).map((event) => invitations.get(event.cid)!),
  };
}

const isOneUseInvitation = (event: VaultEvent<"did.disclosed">) => event.data.as === "oob" && event.data.uses === "one";

function consumptionStatus(event: VaultEvent<"invitation.consumed">, set: VaultEventSet, evidence: ChannelEvidence, continuity: Continuity): ConsumptionStatus {
  const invalid = (because: string): ConsumptionStatus => ({ status: "invalid", because });
  const missing: string[] = [];

  const disclosed = set.resolve(event.data.disclosureEventCid, "did.disclosed");
  let disclosure: VaultEvent<"did.disclosed"> | null = null;
  if (disclosed.status === "missing") missing.push("the disclosure it names is not here");
  else if (disclosed.status === "mismatched") return invalid(`the disclosure it names is a ${disclosed.event.type}`);
  else if (!isOneUseInvitation(disclosed.event)) return invalid("the disclosure it names is not a one-use invitation");
  else disclosure = disclosed.event;

  const resolved = set.resolve(event.data.sourceEventCid, "message.in");
  if (resolved.status === "missing") missing.push("the source it names is not here");
  else if (resolved.status === "mismatched") return invalid(`the source it names is a ${resolved.event.type}`);
  else {
    const source = evidence.sources.get(resolved.event.cid)!;
    const { data } = source.event;
    if (data.fromPrior !== null) return invalid("the source carries a proof");
    if (data.peerResolutionEventCid === null) return invalid("the source is anonymous, in no pair");
    if (disclosure !== null) {
      if (data.localKeyName !== didKeyName(disclosure.data.didId, "key-agreement")) return invalid("the source is not at the disclosed DID's key-agreement key");
      if (data.pthid !== disclosure.data.oobId) return invalid("the source's pthid is not the invitation's ID");
    }
    const witness = continuity.witness(source.event.cid);
    if (witness.status === "invalid") return invalid(`the source is no complete witness: ${witness.because}`);
    if (witness.status === "conflict") return { status: "conflict", because: `the source is no complete witness: ${witness.because}` };
    if (witness.status === "pending") missing.push(`the source is no complete witness: ${witness.because}`);
    else if (missing.length === 0) return { status: "complete", consumer: source.channel!.peerDid };
  }
  return { status: "pending", because: missing[0]! };
}

function consumerOf(consumptions: readonly Consumption[]): Did | null {
  const consumers = new Set<Did>();
  for (const { status } of consumptions) if (status.status === "complete") consumers.add(status.consumer);
  return consumers.size === 1 ? [...consumers][0]! : null;
}

/**
 * What the disclosed DID's lifecycle says about acquiring a consumer
 * now: ended — no new consumer while the DID is retired or in
 * conflict, its route retired, misconfigured or on a terminal
 * mediation, or its creation not yet here — or waiting on something
 * that may recover: the route's configuration, the mediation's grant,
 * the seed's check of the keys. Only retirement and conflict are
 * final; a creation still to arrive reopens the DID.
 */
type Lifecycle = { readonly ended: string | null; readonly waiting: string | null };

function lifecycleOf(entity: LocalDidEntity | undefined, routes: RouteFold): Lifecycle {
  const ended = (because: string): Lifecycle => ({ ended: because, waiting: null });
  if (entity === undefined || entity.created === null) return ended("the disclosed DID has no consistent creation here");
  if (entity.conflict) return ended(`the disclosed DID is in conflict: ${entity.faults[0]}`);
  if (entity.retired !== null) return ended("the disclosed DID is retired");
  const route = routes.routes.get(entity.created.boundRouteId);
  if (route?.terminal === true) {
    if (route.retired !== null) return ended("the bound route is retired");
    if (route.conflict) return ended("the bound route's configurations disagree");
    return ended("the bound route's mediation is terminal");
  }
  return { ended: null, waiting: entity.live ? null : entity.faults[0]! };
}

function invitationStatus(consumptions: readonly Consumption[], consumer: Did | null, disclosed: number, lifecycle: Lifecycle, candidates: readonly Candidate[]): InvitationStatus {
  const conflict = (because: string): InvitationStatus => ({ status: "conflict", because });
  if (disclosed > 1) return conflict("the invitation's ID is disclosed more than once");
  const complete = consumptions.filter(({ status }) => status.status === "complete");
  if (complete.length > 0 && consumer === null) return conflict("the complete records name different consumers");
  for (const { status } of consumptions) if (status.status === "conflict") return conflict(status.because);
  if (consumer !== null) return { status: "consumed", consumer };
  for (const { status } of consumptions) if (status.status === "pending") return { status: "pending", because: status.because };
  if (lifecycle.ended !== null) return { status: "unavailable", because: lifecycle.ended };
  for (const { eligibility } of candidates) {
    if (eligibility.status === "integrity-conflict") return conflict("a candidate receipt is caught in a receipt-integrity conflict");
    if (eligibility.status === "deferred") return { status: "pending", because: eligibility.because };
    if (eligibility.status === "eligible") break;
  }
  return { status: "available" };
}

/**
 * A receipt's eligibility to be recorded now, in the order the verdicts
 * are final: what refuses the receipt for good — its own witness, or
 * the intent conflict of the input it observes, which its siblings may
 * have raised under another thread or with a proof and which no later
 * evidence settles — then what current policy refuses, known from the
 * lifecycle and from the channel's ends, which a receipt names even
 * while its witness is incomplete, and only then what waits: the
 * witness, or a route or mediation that may recover. A refusal that is
 * already certain is not deferred, so a missing document behind a
 * denied or superseded channel holds up nothing behind it.
 */
function candidateOf(source: Source, lifecycle: Lifecycle, evidence: ChannelEvidence, continuity: Continuity, inbound: InboundFold): Candidate {
  const candidate = (eligibility: Eligibility): Candidate => ({ source, eligibility });
  if (evidence.receipts.affected.has(source.event.data.messageId)) return candidate({ status: "integrity-conflict" });
  const witness = continuity.witness(source.event.cid);
  if (witness.status === "invalid" || witness.status === "conflict") return candidate({ status: "invalid", because: witness.because });
  const execution = inbound.ofSource(source.event.cid);
  if (execution?.status.status === "conflict") return candidate({ status: "invalid", because: `the input is in an intent conflict: ${execution.status.because}` });
  if (lifecycle.ended !== null) return candidate({ status: "refused", because: lifecycle.ended });
  const channel = source.channel;
  if (channel !== null) {
    if (continuity.blocked(channel).length > 0) return candidate({ status: "refused", because: "the channel is denied" });
    if (continuity.conflicted(channel)) return candidate({ status: "refused", because: "the channel is in a continuity conflict" });
    if (continuity.superseded(channel)) return candidate({ status: "refused", because: "the peer has replaced its DID" });
  }
  if (witness.status === "pending") return candidate({ status: "deferred", because: witness.because });
  if (lifecycle.waiting !== null) return candidate({ status: "deferred", because: lifecycle.waiting });
  return candidate({ status: "eligible" });
}
