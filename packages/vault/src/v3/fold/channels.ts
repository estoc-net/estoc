/**
 * The raw channel evidence: what each inbound observation establishes
 * on its own, before any graph is built over it. A source is one
 * `message.in` with the local entity its key belongs to and the channel
 * its actual endpoints form; its standing says whether the receipt's
 * own authentication evidence is complete, missing or contradicted. A
 * carrier is a source that brought a `from_prior` proof, whose
 * signature the checks beside the fold verified against the issuer's
 * document; a verified proof with legal endpoints is one peer link. A decision
 * is a `did.rotationSelected` checked as far as its own fields and
 * source allow; what passes is one local-link candidate. The
 * continuity fold owns everything that needs the whole graph:
 * confirmation of a decision's predecessor, joins, contexts, conflicts
 * and the final status of each carrier. Alongside, the receipt
 * ordinals give the allocator's high-water mark and the integrity
 * conflicts of one author reusing an ordinal.
 */

import { isLongForm } from "@estoc/did-peer";

import { InvalidFromPrior } from "../errors.js";
import { carriedClaims, fromPriorClaims, issuerDocumentOf, verifyFromPrior, type CarriedClaims } from "../from-prior.js";
import { channelKey, channelOf, inboundMessageId } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { AuthorId, Channel, Did, DidId, EventId, MessageId, VaultData } from "../types.js";
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
  /** the entity whose key-agreement key received it; null while no consistent entity derives the key */
  readonly localDidId: DidId | null;
  /** the resolution the observation names, once it is here and is one */
  readonly resolution: VaultEvent<"peer.resolved"> | null;
  /** the actual pair; null for an anonymous observation, or while the local endpoint is unknown */
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

/** The peer replaced its DID: one endpoint of a channel, derived from one carrier's verified proof. */
export interface PeerLink {
  readonly from: Channel;
  readonly to: Channel;
  readonly carrier: EventId;
}

/**
 * What a carrier's proof establishes on its own. Invalid is for good:
 * a form or claim the carrier itself contradicts, a signature its
 * issuer's document refuses, or a predecessor that is our own DID.
 * Pending while the issuer's document is not here or not yet checked.
 */
export type Proof = { status: "invalid"; because: string } | { status: "pending-proof" } | { status: "verified"; claims: CarriedClaims };

export interface Carrier {
  readonly source: Source;
  readonly proof: Proof;
  /** the link this carrier supports: only when its standing is complete and its proof verified */
  readonly link: PeerLink | null;
}

/** We replaced our DID toward one peer: one endpoint of a channel, decided locally. */
export interface LocalLink {
  readonly from: Channel;
  readonly to: Channel;
  readonly decision: EventId;
  readonly source: EventId | null;
}

/**
 * A decision checked without the graph. Invalid contradicts its own
 * fields or proof; conflict contradicts the evidence it references;
 * pending waits for evidence that may still arrive. A candidate is a
 * local link whose predecessor confirmation the continuity fold still
 * has to find.
 */
export type DecisionStatus = { status: "invalid"; because: string } | { status: "conflict"; because: string } | { status: "pending"; because: string } | { status: "candidate"; link: LocalLink };

export interface Decision {
  readonly event: VaultEvent<"did.rotationSelected">;
  /** the pair the decision rotates away from, once its predecessor entity reads */
  readonly channel: Channel | null;
  readonly status: DecisionStatus;
}

export interface ChannelEvidence {
  readonly sources: ReadonlyMap<EventId, Source>;
  readonly receipts: ReceiptIntegrity;
  /** every source that brought a proof, by its event */
  readonly carriers: ReadonlyMap<EventId, Carrier>;
  /** the links of the carriers that support one, in canonical event order */
  readonly peerLinks: readonly PeerLink[];
  readonly decisions: ReadonlyMap<EventId, Decision>;
  /** the candidate links of the decisions that pass, in canonical event order */
  readonly localLinks: readonly LocalLink[];
  /**
   * May this observation stand in the graph? Its standing is complete,
   * it has a channel, and any proof it brought supports a link. This is
   * what the continuity fold builds from and what intent conflicts are
   * detected over; it authorizes no operation by itself.
   */
  positive(sourceEventId: EventId): boolean;
}

export type ChannelChecks = {
  resolutionChecks?: ReadonlyMap<EventId, EvidenceCheck>;
  /** each carried or frozen proof against its issuer's document, from `verifyProofs` */
  proofChecks?: ReadonlyMap<EventId, EvidenceCheck>;
};

const none = new Map<EventId, EvidenceCheck>();

export function foldChannelEvidence(set: VaultEventSet, routes: RouteFold, checks: ChannelChecks = {}): ChannelEvidence {
  const sources = foldSources(set, routes, checks.resolutionChecks ?? none);
  const carriers = foldCarriers(sources, checks.proofChecks ?? none);
  const positive = (id: EventId) => {
    const source = sources.get(id);
    if (source === undefined || source.channel === null || source.standing.status !== "complete") return false;
    return source.event.data.fromPrior === null || carriers.get(id)?.link != null;
  };
  const decisions = foldDecisions(set, routes, sources, positive, checks.proofChecks ?? none);
  return {
    sources,
    receipts: foldReceipts(set),
    carriers,
    peerLinks: [...carriers.values()].flatMap((carrier) => (carrier.link === null ? [] : [carrier.link])),
    decisions,
    localLinks: [...decisions.values()].flatMap((decision) => (decision.status.status === "candidate" ? [decision.status.link] : [])),
    positive,
  };
}

/**
 * Each observation with the entity and channel it belongs to. An
 * authenticated one is complete when a consistent entity's
 * key-agreement key received it, the resolution it names is here, is
 * its own — same key, same sender under the same spelling — and is
 * verified against its document, and its message ID is the one its
 * endpoints and wire ID derive. An anonymous one has nothing to
 * authenticate and no channel.
 */
export function foldSources(set: VaultEventSet, routes: RouteFold, resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>): Map<EventId, Source> {
  const sources = new Map<EventId, Source>();
  for (const event of set.of("message.in")) {
    const { data } = event;
    const localDidId = routes.entityOfKey(data.localKeyName);
    const local = localDidId === null ? null : routes.dids.get(localDidId) ?? null;
    if (data.peerResolutionEventId === null || data.did === null) {
      sources.set(event.eventId, { event, localDidId, resolution: null, channel: null, standing: { status: "complete" } });
      continue;
    }
    const incomplete = (because: string): Source => ({ event, localDidId, resolution: null, channel: null, standing: { status: "incomplete", because } });
    const conflict = (resolution: VaultEvent<"peer.resolved"> | null, because: string): Source => ({ event, localDidId, resolution, channel: null, standing: { status: "conflict", because } });
    if (local?.created == null) {
      sources.set(event.eventId, incomplete("no consistent communication DID derives the local key"));
      continue;
    }
    if (local.keyNames.keyAgreement !== data.localKeyName) {
      sources.set(event.eventId, conflict(null, "the local key is not the entity's key-agreement key"));
      continue;
    }
    if (local.created.did === data.did) {
      sources.set(event.eventId, conflict(null, "the sender is the recipient"));
      continue;
    }
    const channel = channelOf(local.created.did, data.did);
    const expected = inboundMessageId(data.did, local.created.did, data.wireMessageId);
    if (data.messageId !== expected) {
      sources.set(event.eventId, conflict(null, `the message ID is not the one the endpoints and wire ID derive, ${expected}`));
      continue;
    }
    const resolved = set.resolve(data.peerResolutionEventId, "peer.resolved");
    if (resolved.status === "missing") {
      sources.set(event.eventId, incomplete("the resolution it names is not here"));
      continue;
    }
    if (resolved.status === "mismatched") {
      sources.set(event.eventId, conflict(null, `the resolution it names is a ${resolved.event.type}`));
      continue;
    }
    const resolution = resolved.event;
    if (resolution.data.localKeyName !== data.localKeyName || resolution.data.did !== data.did || resolution.data.presentedDid !== data.presentedDid) {
      sources.set(event.eventId, conflict(resolution, "the resolution it names is not of this sender at this key"));
      continue;
    }
    const check = resolutionChecks.get(resolution.eventId);
    if (check === "invalid") {
      sources.set(event.eventId, conflict(resolution, "the resolution's snapshot is not its document's"));
      continue;
    }
    sources.set(event.eventId, {
      event,
      localDidId,
      resolution,
      channel,
      standing: check === undefined ? { status: "incomplete", because: "the resolution's document is not here" } : { status: "complete" },
    });
  }
  return sources;
}

export const receiptOrderKey = (event: VaultEvent<"message.in">): ReceiptKey => ({ ordinal: BigInt(event.data.receiptOrdinal), author: event.author });

/** First-receipt order: by exact ordinal, then by author. */
export function compareReceiptKeys(a: ReceiptKey, b: ReceiptKey): number {
  if (a.ordinal !== b.ordinal) return a.ordinal < b.ordinal ? -1 : 1;
  return a.author < b.author ? -1 : a.author > b.author ? 1 : 0;
}

/** The allocator's high-water mark over every observation ever committed, and the ordinals one author gave twice. */
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

/**
 * Each authenticated source that brought a proof, read on its own.
 * The claims are checked against the carrier first, which needs no
 * document; the signature's verdict comes from the checks beside the
 * fold. A verified proof names the peer's predecessor; with the
 * carrier's own endpoints it is a link, provided the predecessor is
 * not our own DID. One carrier's verdict says nothing about another's.
 */
export function foldCarriers(sources: ReadonlyMap<EventId, Source>, proofChecks: ReadonlyMap<EventId, EvidenceCheck>): Map<EventId, Carrier> {
  const carriers = new Map<EventId, Carrier>();
  for (const source of sources.values()) {
    const { eventId, data } = source.event;
    if (data.fromPrior === null || data.presentedDid === null) continue;
    let proof = proofOf(data.fromPrior, data.presentedDid, proofChecks.get(eventId));
    const local = source.channel?.localDid ?? null;
    if (proof.status === "verified" && proof.claims.predecessorDid === local) proof = { status: "invalid", because: "the predecessor is the local DID" };
    const link: PeerLink | null =
      proof.status === "verified" && source.channel !== null && local !== null && source.standing.status === "complete"
        ? { from: channelOf(local, proof.claims.predecessorDid), to: source.channel, carrier: eventId }
        : null;
    carriers.set(eventId, { source, proof, link });
  }
  return carriers;
}

function proofOf(jwt: string, presentedDid: Did, check: EvidenceCheck | undefined): Proof {
  let claims: CarriedClaims;
  try {
    claims = carriedClaims(jwt, presentedDid);
  } catch (err) {
    if (!(err instanceof InvalidFromPrior)) throw err;
    return { status: "invalid", because: err.message };
  }
  if (check === undefined) return { status: "pending-proof" };
  if (check === "invalid") return { status: "invalid", because: "the proof does not verify under the issuer's document" };
  return { status: "verified", claims };
}

/**
 * Each rotation decision checked against its own fields: both entities
 * consistent and created, the successor another DID than both old
 * endpoints, the frozen proof spelled over the two entities' exact
 * long forms and verified under the predecessor's document, and the
 * source, when named, a positive observation in the very pair the
 * decision rotates away from. What the predecessor was confirmed by is
 * the graph's question, not asked here.
 */
export function foldDecisions(
  set: VaultEventSet,
  routes: RouteFold,
  sources: ReadonlyMap<EventId, Source>,
  positive: (sourceEventId: EventId) => boolean,
  proofChecks: ReadonlyMap<EventId, EvidenceCheck>
): Map<EventId, Decision> {
  const decisions = new Map<EventId, Decision>();
  for (const event of set.of("did.rotationSelected")) {
    const { data } = event;
    const from = routes.dids.get(data.fromDidId);
    const to = routes.dids.get(data.toDidId);
    const channel = from?.created == null || from.conflict || from.created.did === data.peerDid ? null : channelOf(from.created.did, data.peerDid);
    const status = decisionStatus(event, from, to, channel, set, sources, positive, proofChecks.get(event.eventId));
    decisions.set(event.eventId, { event, channel, status });
  }
  return decisions;
}

function decisionStatus(
  event: VaultEvent<"did.rotationSelected">,
  from: LocalDidEntity | undefined,
  to: LocalDidEntity | undefined,
  channel: Channel | null,
  set: VaultEventSet,
  sources: ReadonlyMap<EventId, Source>,
  positive: (sourceEventId: EventId) => boolean,
  check: EvidenceCheck | undefined
): DecisionStatus {
  const { data } = event;
  const invalid = (because: string): DecisionStatus => ({ status: "invalid", because });
  const conflict = (because: string): DecisionStatus => ({ status: "conflict", because });
  const pending = (because: string): DecisionStatus => ({ status: "pending", because });
  const predecessor = creationOf(from, "predecessor");
  if ("status" in predecessor) return predecessor;
  const successor = creationOf(to, "successor");
  if ("status" in successor) return successor;
  if (channel === null) return invalid("the peer is the predecessor's own DID");
  if (successor.did === predecessor.did || successor.did === data.peerDid) return invalid("the successor is one of the old endpoints");
  let iss: string;
  let sub: string;
  try {
    ({ iss, sub } = fromPriorClaims(data.fromPrior));
  } catch (err) {
    if (!(err instanceof InvalidFromPrior)) throw err;
    return invalid(err.message);
  }
  if (iss !== predecessor.longFormDid) return invalid("the proof's iss is not the predecessor's long form");
  if (sub !== successor.longFormDid) return invalid("the proof's sub is not the successor's long form");
  if (check === "invalid") return invalid("the proof does not verify under the predecessor's document");
  if (check === undefined) return pending("the proof is not yet checked");
  const link: LocalLink = { from: channel, to: channelOf(successor.did, data.peerDid), decision: event.eventId, source: data.sourceEventId };
  if (data.sourceEventId === null) return { status: "candidate", link };
  const resolved = set.resolve(data.sourceEventId, "message.in");
  if (resolved.status === "missing") return pending("the source it names is not here");
  if (resolved.status === "mismatched") return conflict(`the source it names is a ${resolved.event.type}`);
  const source = sources.get(data.sourceEventId)!;
  if (source.channel !== null && channelKey(source.channel) !== channelKey(channel)) return conflict("the source is not in the pair the decision rotates away from");
  if (source.standing.status === "conflict") return conflict(`the source's authentication is in conflict: ${source.standing.because}`);
  if (!positive(data.sourceEventId)) return pending("the source is not yet positive");
  return { status: "candidate", link };
}

function creationOf(entity: LocalDidEntity | undefined, role: string): VaultData["did.created"] | DecisionStatus {
  if (entity?.conflict === true) return { status: "conflict", because: `the ${role} entity is in conflict` };
  if (entity?.created == null) return { status: "pending", because: `the ${role} entity has no consistent creation here` };
  return entity.created;
}

/**
 * Every proof in the set against its issuer's document: each carried
 * `from_prior` against the document its issuer's long form derives or
 * a verified retained resolution of its short form retains, each
 * decision's frozen proof against the document its own long-form
 * issuer derives. No verdict while the issuer's document is not here;
 * a claim the fold can refuse without the document is left to it.
 */
export async function verifyProofs(set: VaultEventSet, resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>, readObject: ReadObject): Promise<Map<EventId, EvidenceCheck>> {
  const retained: VaultData["peer.resolved"][] = [];
  for (const event of set.of("peer.resolved")) if (resolutionChecks.get(event.eventId) === "verified") retained.push(event.data);
  const documents = new Map<Did, ReturnType<typeof issuerDocumentOf>>();
  const documentOf = (iss: Did) => {
    let document = documents.get(iss);
    if (document === undefined) {
      document = issuerDocumentOf(iss, retained, readObject);
      documents.set(iss, document);
    }
    return document;
  };
  const checks = new Map<EventId, EvidenceCheck>();
  const verify = async (eventId: EventId, jwt: string, claims: () => { iss: Did }) => {
    try {
      const document = await documentOf(claims().iss);
      if (document === null) return;
      await verifyFromPrior(jwt, document);
      checks.set(eventId, "verified");
    } catch (err) {
      if (!(err instanceof InvalidFromPrior)) throw err;
      checks.set(eventId, "invalid");
    }
  };
  for (const event of set.of("message.in")) {
    const { fromPrior, presentedDid } = event.data;
    if (fromPrior === null || presentedDid === null) continue;
    await verify(event.eventId, fromPrior, () => carriedClaims(fromPrior, presentedDid));
  }
  for (const event of set.of("did.rotationSelected")) {
    const { fromPrior } = event.data;
    await verify(event.eventId, fromPrior, () => {
      const claims = fromPriorClaims(fromPrior);
      if (!isLongForm(claims.iss)) throw new InvalidFromPrior("a decision's issuer is its own long form");
      return claims;
    });
  }
  return checks;
}
