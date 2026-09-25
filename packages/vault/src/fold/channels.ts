/**
 * The raw channel evidence, what each event establishes on its own,
 * kept apart from the continuity model derived over it. A source is
 * one `message.in` read against the local entity and the resolution it
 * names; a carrier is a source that brought a `from_prior` proof, read
 * first against the profile and the receipt alone, then against the
 * verdict reached beside the fold under the issuer's document; a
 * decision is a `did.rotationSelected` checked as far as its own fields
 * and its source allow. Whatever needs the whole history, confirmation
 * of a predecessor, joins, contexts, conflicts, is the model's question
 * and is not asked here.
 */

import type { ContinuityFact, LocalDecision } from "@estoc/continuity";
import { InvalidFromPrior, bindFromPrior, precheckFromPrior, verifyFromPrior, type VerifiedFromPrior } from "@estoc/continuity/from-prior";
import { isLongForm, longToShort } from "@estoc/did-peer";

import { InvalidDidDocument, InvalidPublicKey } from "../errors.js";
import { issuerLongFormOf } from "../from-prior.js";
import { methodPublicKey } from "../peer-document.js";
import { channelOf, decisionFactId, didKeyName, inboundMessageId, observationFactId, transitionFactId } from "../ids.js";
import { agreementKey, decodePublicKey, type DecodedPublicKey, type KeyType } from "../public-key.js";
import type { VaultEvent } from "../schema.js";
import type { AuthorId, Channel, Did, DidId, EventCid, MessageId, VaultData } from "../types.js";
import type { EvidenceCheck, ReadObject } from "./evidence.js";
import type { LocalDidEntity, RouteFold } from "./routes.js";
import { groupBy, type VaultEventSet } from "./set.js";

/**
 * Whether a receipt's own authentication evidence is all here and
 * consistent. Missing evidence is incomplete and may still arrive;
 * evidence that contradicts the observation is a conflict for good.
 */
export type Standing = { status: "complete" } | { status: "incomplete"; because: string } | { status: "conflict"; because: string };

export interface Source {
  readonly event: VaultEvent<"message.in">;
  /** the entity the local key name derives from, whatever its state; null while no entity here records that name */
  readonly localDidId: DidId | null;
  /** the resolution the observation names, once it is here and is one */
  readonly resolution: VaultEvent<"peer.resolved"> | null;
  /** the actual pair; null for an anonymous observation, while the local endpoint is unknown, and for a standing in conflict */
  readonly channel: Channel | null;
  readonly standing: Standing;
}

/** A receipt's place in first-receipt order: its exact ordinal, then its author. */
export type ReceiptKey = { readonly ordinal: bigint; readonly author: AuthorId };

export interface ReceiptIntegrity {
  /** one past the largest ordinal any author ever assigned, erased messages included */
  readonly nextReceiptOrdinal: bigint;
  /** each set of distinct observations one author gave the same ordinal */
  readonly conflicts: readonly (readonly VaultEvent<"message.in">[])[];
  /** the logical messages those observations belong to: no new ACK target, no invitation candidate */
  readonly affected: ReadonlySet<MessageId>;
}

/**
 * What a carrier's proof establishes on its own. Invalid is for good:
 * a form or profile the token fails, a successor that is not the
 * sender, a predecessor that is the carrier's own local DID, a
 * signature its issuer's document refuses, or a binding the receipt
 * contradicts. Unsupported is for good too: an ending, which this
 * vault retains as a diagnostic and applies to no relationship.
 * Pending while the issuer's document is not here or not yet checked.
 */
export type Proof = { status: "invalid"; because: string } | { status: "unsupported"; because: string } | { status: "pending-proof" } | { status: "verified"; proof: VerifiedFromPrior };

export interface Carrier {
  readonly source: Source;
  readonly proof: Proof;
  /** the peer transition and the observation of its successor, both of this receipt; empty until the proof is verified and the standing complete */
  readonly facts: readonly ContinuityFact[];
}

/**
 * A decision checked without the history. Invalid contradicts its own
 * fields or proof; conflict contradicts the evidence it references;
 * pending waits for evidence that may still arrive. A candidate is the
 * local-decision fact the continuity model confirms or leaves waiting.
 */
export type DecisionStatus = { status: "invalid"; because: string } | { status: "conflict"; because: string } | { status: "pending"; because: string } | { status: "candidate"; fact: LocalDecision };

export interface Decision {
  readonly event: VaultEvent<"did.rotationSelected">;
  /** the pair the decision rotates away from, once its predecessor entity reads */
  readonly channel: Channel | null;
  readonly status: DecisionStatus;
}

export interface ChannelEvidence {
  readonly sources: ReadonlyMap<EventCid, Source>;
  readonly receipts: ReceiptIntegrity;
  /** every source that brought a proof, by its event */
  readonly carriers: ReadonlyMap<EventCid, Carrier>;
  readonly decisions: ReadonlyMap<EventCid, Decision>;
  /**
   * Does this observation stand as an address observation? Its
   * standing is complete, it has a channel, and any proof it brought
   * is verified and bound. This is what the continuity model is
   * derived from and what intent conflicts are detected over; it
   * authorizes no operation by itself.
   */
  positive(sourceEventCid: EventCid): boolean;
}

/** The verdict on a proof reached under its issuer's document; none while the document is not here. */
export type ProofCheck = { status: "verified"; proof: VerifiedFromPrior } | { status: "invalid"; because: string };

export type ChannelChecks = {
  resolutionChecks?: ReadonlyMap<EventCid, EvidenceCheck>;
  /** each carried or frozen proof against its issuer's document, from `verifyProofs` */
  proofChecks?: ReadonlyMap<EventCid, ProofCheck>;
};

const noResolutionChecks = new Map<EventCid, EvidenceCheck>();
const noProofChecks = new Map<EventCid, ProofCheck>();

export function foldChannelEvidence(set: VaultEventSet, routes: RouteFold, checks: ChannelChecks = {}): ChannelEvidence {
  const sources = foldSources(set, routes, checks.resolutionChecks ?? noResolutionChecks);
  const carriers = foldCarriers(sources, checks.proofChecks ?? noProofChecks);
  const positive = (id: EventCid) => {
    const source = sources.get(id);
    if (source === undefined || source.channel === null || source.standing.status !== "complete") return false;
    return source.event.data.fromPrior === null || (carriers.get(id)?.facts.length ?? 0) > 0;
  };
  return { sources, receipts: foldReceipts(set), carriers, decisions: foldDecisions(set, routes, sources, carriers, checks.proofChecks ?? noProofChecks), positive };
}

/**
 * Whatever contradicts an observation does so for good, however much
 * else is still missing, so each contradiction is looked for as soon
 * as what it needs is here, and every one is reported before any
 * absence.
 */
export function foldSources(set: VaultEventSet, routes: RouteFold, resolutionChecks: ReadonlyMap<EventCid, EvidenceCheck>): Map<EventCid, Source> {
  const sources = new Map<EventCid, Source>();
  for (const event of set.of("message.in")) {
    const localDidId = routes.entityOfKey(event.data.localKeyName);
    const local = localDidId === null ? null : routes.dids.get(localDidId)!;
    sources.set(event.cid, sourceOf(event, localDidId, local, set, resolutionChecks));
  }
  return sources;
}

function sourceOf(event: VaultEvent<"message.in">, localDidId: DidId | null, local: LocalDidEntity | null, set: VaultEventSet, resolutionChecks: ReadonlyMap<EventCid, EvidenceCheck>): Source {
  const { data } = event;
  if (data.peerResolutionEventCid === null || data.did === null) return { event, localDidId, resolution: null, channel: null, standing: { status: "complete" } };
  const missing: string[] = [];
  let channel: Channel | null = null;
  let resolution: VaultEvent<"peer.resolved"> | null = null;
  let localKeyType: KeyType | null = null;
  const conflict = (because: string): Source => ({ event, localDidId, resolution, channel: null, standing: { status: "conflict", because } });

  if (local === null) missing.push("no communication DID here derives the local key");
  else if (local.conflict) return conflict(`the local entity is in conflict: ${local.faults[0]}`);
  else if (local.keyNames.keyAgreement !== data.localKeyName) return conflict("the local key is not the entity's key-agreement key");
  else if (local.created === null) missing.push("the local entity has no creation here");
  else {
    if (local.created.did === data.did) return conflict("the sender is the recipient");
    channel = channelOf(local.created.did, data.did);
    const expected = inboundMessageId(data.did, local.created.did, data.wireMessageId);
    if (data.messageId !== expected) return conflict(`the message ID is not the one the endpoints and wire ID derive, ${expected}`);
    localKeyType = keyAgreementTypeOf(local);
    if (local.identity === "unchecked") missing.push("the local entity's keys are not yet checked against the seed");
  }

  const resolved = set.resolve(data.peerResolutionEventCid, "peer.resolved");
  if (resolved.status === "missing") missing.push("the resolution it names is not here");
  else if (resolved.status === "mismatched") return conflict(`the resolution it names is a ${resolved.event.type}`);
  else {
    resolution = resolved.event;
    if (resolution.data.localKeyName !== data.localKeyName || resolution.data.did !== data.did || resolution.data.presentedDid !== data.presentedDid) {
      return conflict("the resolution it names is not of this sender at this key");
    }
    let peerKey: DecodedPublicKey;
    try {
      peerKey = agreementKey(resolution.data.peerPublicKey);
    } catch (err) {
      if (!(err instanceof InvalidPublicKey)) throw err;
      return conflict(err.message);
    }
    const check = resolutionChecks.get(resolution.cid);
    if (check === "invalid") return conflict("the resolution's snapshot is not its document's");
    if (localKeyType !== null && peerKey.type !== localKeyType) return conflict(`the peer key is ${peerKey.type} and the entity's key-agreement key ${localKeyType}: no key is agreed across curves`);
    if (check === undefined) missing.push("the resolution's document is not here");
  }

  const standing: Standing = missing.length === 0 ? { status: "complete" } : { status: "incomplete", because: missing[0]! };
  return { event, localDidId, resolution, channel, standing };
}

/** The curve of the entity's own key-agreement key, null while its document does not read. */
export function keyAgreementTypeOf(local: LocalDidEntity): KeyType | null {
  const [id] = local.methodIds.keyAgreement;
  if (local.resolution === null || id === undefined) return null;
  try {
    return decodePublicKey(methodPublicKey(local.resolution.document, id)).type;
  } catch (err) {
    if (err instanceof InvalidDidDocument || err instanceof InvalidPublicKey) return null;
    throw err;
  }
}

export const receiptOrderKey = (event: VaultEvent<"message.in">): ReceiptKey => ({ ordinal: BigInt(event.data.receiptOrdinal), author: event.author });

export function compareReceiptKeys(a: ReceiptKey, b: ReceiptKey): number {
  if (a.ordinal !== b.ordinal) return a.ordinal < b.ordinal ? -1 : 1;
  return a.author < b.author ? -1 : a.author > b.author ? 1 : 0;
}

export function foldReceipts(set: VaultEventSet): ReceiptIntegrity {
  let max = 0n;
  const byKey = groupBy(set.of("message.in"), (event) => `${event.author} ${event.data.receiptOrdinal}`);
  const conflicts: VaultEvent<"message.in">[][] = [];
  const affected = new Set<MessageId>();
  for (const group of byKey.values()) {
    const ordinal = BigInt(group[0]!.data.receiptOrdinal);
    if (ordinal > max) max = ordinal;
    if (group.length < 2) continue;
    conflicts.push(group);
    for (const event of group) affected.add(event.data.messageId);
  }
  conflicts.sort((a, b) => compareReceiptKeys(receiptOrderKey(a[0]!), receiptOrderKey(b[0]!)));
  return { nextReceiptOrdinal: max + 1n, conflicts, affected };
}

/** Each proof read against its own carrier alone: one carrier's verdict says nothing about another's. */
export function foldCarriers(sources: ReadonlyMap<EventCid, Source>, proofChecks: ReadonlyMap<EventCid, ProofCheck>): Map<EventCid, Carrier> {
  const carriers = new Map<EventCid, Carrier>();
  for (const source of sources.values()) {
    const { cid, data } = source.event;
    if (data.fromPrior === null || data.presentedDid === null) continue;
    carriers.set(cid, { source, ...carrierOf(source, data.fromPrior, data.presentedDid, proofChecks.get(cid)) });
  }
  return carriers;
}

function carrierOf(source: Source, jwt: string, sender: Did, check: ProofCheck | undefined): { proof: Proof; facts: readonly ContinuityFact[] } {
  const refused = (proof: Proof) => ({ proof, facts: [] });
  let claims: ReturnType<typeof precheckFromPrior>;
  try {
    claims = precheckFromPrior(jwt, { authenticatedSender: sender });
  } catch (err) {
    if (!(err instanceof InvalidFromPrior)) throw err;
    return refused({ status: "invalid", because: err.message });
  }
  if (claims.claims.sub === undefined) return refused({ status: "unsupported", because: "an ending is not applied: this vault retains it and ends no relationship by it" });
  const local = source.channel?.localDid ?? null;
  if (local !== null && shortFormOf(claims.claims.iss) === local) return refused({ status: "invalid", because: "the predecessor is the local DID" });
  if (check === undefined) return refused({ status: "pending-proof" });
  if (check.status === "invalid") return refused({ status: "invalid", because: check.because });
  const proof: Proof = { status: "verified", proof: check.proof };
  if (source.channel === null || source.standing.status !== "complete") return { proof, facts: [] };
  const { cid } = source.event;
  const binding = bindFromPrior(check.proof, { ref: cid, token: jwt, recipient: source.channel.localDid, sender }, { transitionId: transitionFactId(cid), observationId: observationFactId(cid) });
  if (binding.status !== "bound") return refused({ status: "invalid", because: binding.because });
  return { proof, facts: binding.facts };
}

/**
 * The identity a did:peer:4 spelling the profile has already validated
 * names. Only spellings are compared here; whether the issuer's
 * document supports the proof is the shared proof verifier's verdict,
 * and the vault's full document validator, which can throw, is not
 * applied to an identity comparison.
 */
const shortFormOf = (did: string): string => (isLongForm(did) ? longToShort(did) : did);

/**
 * What contradicts a decision does so for good, so each contradiction
 * is looked for as soon as what it needs is here, before the decision
 * is left pending on what may still arrive. A frozen proof is held to
 * the two entities' exact long forms, since the vault signed it that
 * way itself. What the predecessor was confirmed by is the model's
 * question.
 */
export function foldDecisions(
  set: VaultEventSet,
  routes: RouteFold,
  sources: ReadonlyMap<EventCid, Source>,
  carriers: ReadonlyMap<EventCid, Carrier>,
  proofChecks: ReadonlyMap<EventCid, ProofCheck>
): Map<EventCid, Decision> {
  const decisions = new Map<EventCid, Decision>();
  for (const event of set.of("did.rotationSelected")) {
    const { data } = event;
    const from = routes.dids.get(data.fromDidId);
    const to = routes.dids.get(data.toDidId);
    const channel = from?.created == null || from.conflict || from.created.did === data.peerDid ? null : channelOf(from.created.did, data.peerDid);
    const status = decisionStatus(event, from, to, channel, set, sources, carriers, proofChecks.get(event.cid));
    decisions.set(event.cid, { event, channel, status });
  }
  return decisions;
}

function decisionStatus(
  event: VaultEvent<"did.rotationSelected">,
  from: LocalDidEntity | undefined,
  to: LocalDidEntity | undefined,
  channel: Channel | null,
  set: VaultEventSet,
  sources: ReadonlyMap<EventCid, Source>,
  carriers: ReadonlyMap<EventCid, Carrier>,
  check: ProofCheck | undefined
): DecisionStatus {
  const { data } = event;
  const missing: string[] = [];
  const invalid = (because: string): DecisionStatus => ({ status: "invalid", because });
  const conflict = (because: string): DecisionStatus => ({ status: "conflict", because });

  const predecessor = creationOf(from, "predecessor", missing);
  if (typeof predecessor === "string") return conflict(predecessor);
  const successor = creationOf(to, "successor", missing);
  if (typeof successor === "string") return conflict(successor);
  if (predecessor !== null && channel === null) return invalid("the peer is the predecessor's own DID");
  if (successor !== null && successor.did === data.peerDid) return invalid("the successor is the peer's DID");
  if (predecessor !== null && successor !== null && successor.did === predecessor.did) return invalid("the successor is the predecessor's DID");

  let claims: ReturnType<typeof precheckFromPrior>["claims"];
  try {
    ({ claims } = precheckFromPrior(data.fromPrior));
  } catch (err) {
    if (!(err instanceof InvalidFromPrior)) throw err;
    return invalid(err.message);
  }
  if (claims.sub === undefined) return invalid("the proof is an ending, not a rotation");
  if (predecessor !== null && claims.iss !== predecessor.longFormDid) return invalid("the proof's iss is not the predecessor's long form");
  if (successor !== null && claims.sub !== successor.longFormDid) return invalid("the proof's sub is not the successor's long form");
  if (check?.status === "invalid") return invalid(check.because);
  if (check === undefined) missing.push("the proof is not yet checked");

  if (data.sourceEventCid !== null) {
    const resolved = set.resolve(data.sourceEventCid, "message.in");
    if (resolved.status === "missing") missing.push("the source it names is not here");
    else if (resolved.status === "mismatched") return conflict(`the source it names is a ${resolved.event.type}`);
    else {
      const source = sources.get(data.sourceEventCid)!;
      if (source.event.data.peerResolutionEventCid === null) return conflict("the source is anonymous, in no pair");
      if (source.event.data.did !== data.peerDid) return conflict("the source is not from the peer the decision rotates away from");
      if (source.event.data.localKeyName !== didKeyName(data.fromDidId, "key-agreement")) return conflict("the source is not at the predecessor's key-agreement key");
      if (source.standing.status === "conflict") return conflict(`the source's authentication is in conflict: ${source.standing.because}`);
      const carrier = carriers.get(data.sourceEventCid);
      if (carrier?.proof.status === "invalid" || carrier?.proof.status === "unsupported") return conflict(`the source's proof is ${carrier.proof.status}: ${carrier.proof.because}`);
      if (source.standing.status === "incomplete") missing.push(`the source's authentication is incomplete: ${source.standing.because}`);
      if (carrier?.proof.status === "pending-proof") missing.push("the source's proof is not yet verified");
    }
  }

  if (missing.length > 0) return { status: "pending", because: missing[0]! };
  return {
    status: "candidate",
    fact: {
      kind: "local-decision",
      id: decisionFactId(event.cid),
      at: channel!,
      change: { kind: "rotate", successor: successor!.did },
      source: data.sourceEventCid === null ? null : observationFactId(data.sourceEventCid),
      decision: event.cid,
    },
  };
}

function creationOf(entity: LocalDidEntity | undefined, role: string, missing: string[]): VaultData["did.created"] | string | null {
  if (entity?.conflict === true) return `the ${role} entity is in conflict: ${entity.faults[0]}`;
  if (entity?.created == null) {
    missing.push(`the ${role} entity has no consistent creation here`);
    return null;
  }
  if (entity.identity === "unchecked") missing.push(`the ${role} entity's keys are not yet checked against the seed`);
  return entity.created;
}

/**
 * Every proof in the set against its issuer's document, read here
 * rather than in the fold because the material is asynchronous. A
 * token the profile refuses without a document, or an ending, gets no
 * verdict: the fold reads those on its own. What depends on the local
 * endpoint, the entities' creations or the source is the fold's to
 * refuse.
 */
export async function verifyProofs(set: VaultEventSet, resolutionChecks: ReadonlyMap<EventCid, EvidenceCheck>, readObject: ReadObject): Promise<Map<EventCid, ProofCheck>> {
  const retained: { ref: string; data: VaultData["peer.resolved"] }[] = [];
  for (const event of set.of("peer.resolved")) if (resolutionChecks.get(event.cid) === "verified") retained.push({ ref: event.cid, data: event.data });
  const longForms = new Map<string, ReturnType<typeof issuerLongFormOf>>();
  const longFormOf = (iss: Did) => {
    let longForm = longForms.get(iss);
    if (longForm === undefined) {
      longForm = issuerLongFormOf(iss, retained, readObject);
      longForms.set(iss, longForm);
    }
    return longForm;
  };
  const checks = new Map<EventCid, ProofCheck>();
  const prechecked = (jwt: string, sender: Did | null): ReturnType<typeof precheckFromPrior>["claims"] | null => {
    try {
      return precheckFromPrior(jwt, sender === null ? undefined : { authenticatedSender: sender }).claims;
    } catch (err) {
      if (!(err instanceof InvalidFromPrior)) throw err;
      return null;
    }
  };
  const verify = async (cid: EventCid, jwt: string, iss: Did) => {
    const evidence = await longFormOf(iss);
    if (evidence === null) return;
    try {
      checks.set(cid, { status: "verified", proof: await verifyFromPrior(jwt, evidence) });
    } catch (err) {
      if (!(err instanceof InvalidFromPrior)) throw err;
      checks.set(cid, { status: "invalid", because: err.message });
    }
  };
  for (const event of set.of("message.in")) {
    const { fromPrior, presentedDid } = event.data;
    if (fromPrior === null || presentedDid === null) continue;
    const claims = prechecked(fromPrior, presentedDid);
    if (claims === null || claims.sub === undefined) continue;
    await verify(event.cid, fromPrior, claims.iss as Did);
  }
  for (const event of set.of("did.rotationSelected")) {
    const { fromPrior } = event.data;
    const claims = prechecked(fromPrior, null);
    if (claims === null || claims.sub === undefined) continue;
    if (!isLongForm(claims.iss)) checks.set(event.cid, { status: "invalid", because: "a decision's issuer is its own long form" });
    else await verify(event.cid, fromPrior, claims.iss as Did);
  }
  return checks;
}
