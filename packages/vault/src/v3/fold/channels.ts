/**
 * The raw channel evidence: what each inbound observation establishes
 * on its own, before any graph is built over it. A source is one
 * `message.in` with the local entity its key belongs to and the channel
 * its actual endpoints form; its standing says whether the receipt's
 * own authentication evidence is complete, missing or contradicted,
 * and the local side of that evidence is the seed's word that the
 * entity is ours. A carrier is a source that brought a `from_prior`
 * proof, whose signature the checks beside the fold verified against
 * the issuer's document; a verified proof with legal endpoints is one
 * peer link. A decision is a `did.rotationSelected` checked as far as
 * its own fields and source allow; what passes is one local-link
 * candidate. The continuity fold owns everything that needs the whole
 * graph: confirmation of a decision's predecessor, joins, contexts,
 * conflicts and the final status of each carrier. Alongside, the
 * receipt ordinals give the allocator's high-water mark and the
 * integrity conflicts of one author reusing an ordinal.
 */

import { isLongForm } from "@estoc/did-peer";

import { InvalidDidDocument, InvalidFromPrior, InvalidPublicKey } from "../errors.js";
import { carriedClaims, fromPriorClaims, issuerDocumentOf, verifyFromPrior, type CarriedClaims } from "../from-prior.js";
import { channelOf, didKeyName, inboundMessageId } from "../ids.js";
import { methodPublicKey } from "../peer-document.js";
import { agreementKey, decodePublicKey, type DecodedPublicKey, type KeyType } from "../public-key.js";
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

/** The peer replaced its DID: one endpoint of a channel, derived from one carrier's verified proof. */
export interface PeerLink {
  readonly from: Channel;
  readonly to: Channel;
  readonly carrier: EventId;
}

/**
 * What a carrier's proof establishes on its own. Invalid is for good:
 * a form or claim the carrier itself contradicts, a predecessor that
 * is the carrier's own local DID, or a signature its issuer's document
 * refuses. Pending while the issuer's document is not here or not yet
 * checked; a proof refused without the document stays refused.
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
  const decisions = foldDecisions(set, routes, sources, carriers, checks.proofChecks ?? none);
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
 * authenticated one is complete when the entity its key name derives
 * from is consistent, the seed has confirmed the entity's keys, the
 * key is the entity's key-agreement key, the resolution it names is
 * here, is its own — same key, same sender under the same spelling —
 * and is verified against its document, the peer key it selected
 * agrees keys and is on the curve the entity's own key-agreement key
 * is, and its message ID is the one its endpoints and wire ID derive.
 * Whatever contradicts the observation does so for good, however much
 * else is still missing, so each contradiction is looked for as soon
 * as what it needs is here, and every one before any absence is
 * reported. An anonymous one has nothing to authenticate and no
 * channel.
 */
export function foldSources(set: VaultEventSet, routes: RouteFold, resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>): Map<EventId, Source> {
  const sources = new Map<EventId, Source>();
  for (const event of set.of("message.in")) {
    const localDidId = routes.entityOfKey(event.data.localKeyName);
    const local = localDidId === null ? null : routes.dids.get(localDidId)!;
    sources.set(event.eventId, sourceOf(event, localDidId, local, set, resolutionChecks));
  }
  return sources;
}

function sourceOf(event: VaultEvent<"message.in">, localDidId: DidId | null, local: LocalDidEntity | null, set: VaultEventSet, resolutionChecks: ReadonlyMap<EventId, EvidenceCheck>): Source {
  const { data } = event;
  if (data.peerResolutionEventId === null || data.did === null) return { event, localDidId, resolution: null, channel: null, standing: { status: "complete" } };
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

  const resolved = set.resolve(data.peerResolutionEventId, "peer.resolved");
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
    const check = resolutionChecks.get(resolution.eventId);
    if (check === "invalid") return conflict("the resolution's snapshot is not its document's");
    if (localKeyType !== null && peerKey.type !== localKeyType) return conflict(`the peer key is ${peerKey.type} and the entity's key-agreement key ${localKeyType}: no key is agreed across curves`);
    if (check === undefined) missing.push("the resolution's document is not here");
  }

  const standing: Standing = missing.length === 0 ? { status: "complete" } : { status: "incomplete", because: missing[0]! };
  return { event, localDidId, resolution, channel, standing };
}

function keyAgreementTypeOf(local: LocalDidEntity): KeyType | null {
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

/**
 * Each authenticated source that brought a proof, read on its own.
 * The claims are checked against the carrier first, which needs no
 * document: their form, their fit with the carrier, and that the
 * predecessor they name is not the carrier's own local DID, since no
 * document makes a pair of one DID with itself. The signature's
 * verdict comes from the checks beside the fold. A verified proof
 * names the peer's predecessor; with the carrier's own endpoints it is
 * a link. One carrier's verdict says nothing about another's.
 */
export function foldCarriers(sources: ReadonlyMap<EventId, Source>, proofChecks: ReadonlyMap<EventId, EvidenceCheck>): Map<EventId, Carrier> {
  const carriers = new Map<EventId, Carrier>();
  for (const source of sources.values()) {
    const { eventId, data } = source.event;
    if (data.fromPrior === null || data.presentedDid === null) continue;
    const local = source.channel?.localDid ?? null;
    const proof = proofOf(data.fromPrior, data.presentedDid, local, proofChecks.get(eventId));
    const link: PeerLink | null =
      proof.status === "verified" && source.channel !== null && local !== null && source.standing.status === "complete"
        ? { from: channelOf(local, proof.claims.predecessorDid), to: source.channel, carrier: eventId }
        : null;
    carriers.set(eventId, { source, proof, link });
  }
  return carriers;
}

function proofOf(jwt: string, presentedDid: Did, local: Did | null, check: EvidenceCheck | undefined): Proof {
  let claims: CarriedClaims;
  try {
    claims = carriedClaims(jwt, presentedDid);
  } catch (err) {
    if (!(err instanceof InvalidFromPrior)) throw err;
    return { status: "invalid", because: err.message };
  }
  if (local !== null && claims.predecessorDid === local) return { status: "invalid", because: "the predecessor is the local DID" };
  if (check === undefined) return { status: "pending-proof" };
  if (check === "invalid") return { status: "invalid", because: "the proof does not verify under the issuer's document" };
  return { status: "verified", claims };
}

/**
 * Each rotation decision checked against its own fields: both entities
 * consistent, created and confirmed by the seed, the successor another
 * DID than the peer (another entity than the predecessor by the
 * schema, and no two consistent entities share a DID), the frozen
 * proof spelled over the two entities' exact long forms and verified
 * under the predecessor's document, and the source, when named, a
 * positive observation in the very pair the decision rotates away
 * from: from the peer the decision names, at the predecessor's
 * key-agreement key. What contradicts the decision does so for good
 * — an entity in conflict, a proof refused, a source that can never be
 * positive: anonymous, of another pair, its authentication
 * contradicted, its own proof refused — so each is looked for as soon
 * as what it needs is here, all before the decision is left pending on
 * what may still arrive. What the predecessor was confirmed by is the
 * graph's question, not asked here.
 */
export function foldDecisions(
  set: VaultEventSet,
  routes: RouteFold,
  sources: ReadonlyMap<EventId, Source>,
  carriers: ReadonlyMap<EventId, Carrier>,
  proofChecks: ReadonlyMap<EventId, EvidenceCheck>
): Map<EventId, Decision> {
  const decisions = new Map<EventId, Decision>();
  for (const event of set.of("did.rotationSelected")) {
    const { data } = event;
    const from = routes.dids.get(data.fromDidId);
    const to = routes.dids.get(data.toDidId);
    const channel = from?.created == null || from.conflict || from.created.did === data.peerDid ? null : channelOf(from.created.did, data.peerDid);
    const status = decisionStatus(event, from, to, channel, set, sources, carriers, proofChecks.get(event.eventId));
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
  carriers: ReadonlyMap<EventId, Carrier>,
  check: EvidenceCheck | undefined
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

  let iss: string;
  let sub: string;
  try {
    ({ iss, sub } = fromPriorClaims(data.fromPrior));
  } catch (err) {
    if (!(err instanceof InvalidFromPrior)) throw err;
    return invalid(err.message);
  }
  if (predecessor !== null && iss !== predecessor.longFormDid) return invalid("the proof's iss is not the predecessor's long form");
  if (successor !== null && sub !== successor.longFormDid) return invalid("the proof's sub is not the successor's long form");
  if (check === "invalid") return invalid("the proof does not verify under the predecessor's document");
  if (check === undefined) missing.push("the proof is not yet checked");

  if (data.sourceEventId !== null) {
    const resolved = set.resolve(data.sourceEventId, "message.in");
    if (resolved.status === "missing") missing.push("the source it names is not here");
    else if (resolved.status === "mismatched") return conflict(`the source it names is a ${resolved.event.type}`);
    else {
      const source = sources.get(data.sourceEventId)!;
      if (source.event.data.peerResolutionEventId === null) return conflict("the source is anonymous, in no pair");
      if (source.event.data.did !== data.peerDid) return conflict("the source is not from the peer the decision rotates away from");
      if (source.event.data.localKeyName !== didKeyName(data.fromDidId, "key-agreement")) return conflict("the source is not at the predecessor's key-agreement key");
      if (source.standing.status === "conflict") return conflict(`the source's authentication is in conflict: ${source.standing.because}`);
      const carrier = carriers.get(data.sourceEventId);
      if (carrier?.proof.status === "invalid") return conflict(`the source's proof is invalid: ${carrier.proof.because}`);
      if (source.standing.status === "incomplete") missing.push(`the source's authentication is incomplete: ${source.standing.because}`);
      if (carrier?.proof.status === "pending-proof") missing.push("the source's proof is not yet verified");
    }
  }

  if (missing.length > 0) return { status: "pending", because: missing[0]! };
  return { status: "candidate", link: { from: channel!, to: channelOf(successor!.did, data.peerDid), decision: event.eventId, source: data.sourceEventId } };
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
 * Every proof in the set against its issuer's document: each carried
 * `from_prior` against the document its issuer's long form derives or
 * a verified retained resolution of its short form retains, each
 * decision's frozen proof against the document its own long-form
 * issuer derives. A proof whose form or carrier claims fail, or a
 * decision's whose issuer is not a long form, is invalid before any
 * document is asked for; otherwise there is no verdict while the
 * issuer's document is not here. What depends on the local endpoint,
 * the entities' creations or the source is the fold's to refuse.
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
