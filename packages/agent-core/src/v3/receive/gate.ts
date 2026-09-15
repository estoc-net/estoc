/**
 * The hard gate before the vault, as pure decisions. Before anything is
 * decrypted, the recipients an envelope names decide whether this vault
 * may open it at all: the exact key-agreement method of a DID of its
 * own, still able to receive. After it opens, what it proves of its
 * sender is checked against the sender's document as resolved for this
 * delivery: the key that sealed it, or signed it when no one sealed it,
 * authorized there for that use, and the plaintext's `from` naming that
 * same DID.
 */

import { base64urlToUtf8 } from "@estoc/did-peer";
import { bindingHolds, didKeyName, relationshipId as relationshipIdOf, splitDidUrl, type Cid, type Did, type DidId, type DidUrl, type KeyName, type PublicKey, type Relationship, type RelationshipId, type VaultFold } from "@estoc/vault/v3";

import type { IMessage, UnpackMetadata } from "../../protocol/didcomm.js";
import { authorizedKeys } from "../evidence.js";
import type { Resolution } from "../resolver.js";
import { sameDid } from "../same-did.js";

export type Recipients =
  | { verdict: "eligible"; kid: DidUrl; didId: DidId; did: Did; localKeyName: KeyName }
  | { verdict: "pending"; reason: string }
  | { verdict: "terminal"; reason: string };

/**
 * Which key of this vault the envelope may be opened with: the first
 * recipient, in the envelope's order, naming the exact key-agreement
 * method of an entity that may receive. Short of one, a recipient whose
 * entity lacks only something recoverable — its route's configuration,
 * a grant, the key check — keeps the delivery pending. Everything else
 * is terminal: a DID that is not this vault's, a method the document
 * does not have or authorizes only for authentication, a retired DID no
 * relationship retains, a route or mediation retired or in conflict.
 */
export function classifyRecipients(fold: VaultFold, kids: readonly string[]): Recipients {
  if (kids.length === 0) return { verdict: "terminal", reason: "the envelope names no recipient key" };
  const refused: string[] = [];
  const pending: string[] = [];
  for (const kid of kids) {
    const [did, fragment] = splitDidUrl(kid);
    const didId = fragment.startsWith("#") ? fold.routes.entityOfDid(did) : null;
    const entity = didId === null ? undefined : fold.routes.dids.get(didId);
    if (didId === null || entity === undefined || entity.created === null) {
      refused.push(`${kid} is no key of this vault`);
      continue;
    }
    const named = (ids: readonly DidUrl[]): boolean => ids.some((id) => splitDidUrl(id)[1] === fragment);
    if (!named(entity.methodIds.keyAgreement)) {
      refused.push(named(entity.methodIds.authentication) ? `${kid} is an authentication method, not a key-agreement one` : `${kid} names no method of ${did}`);
      continue;
    }
    switch (fold.routes.receipt(didId, fold.relationships.retainedDidIds)) {
      case "eligible":
        return { verdict: "eligible", kid: kid as DidUrl, didId, did: entity.created.did, localKeyName: entity.keyNames.keyAgreement };
      case "pending":
        pending.push(`${kid}: ${entity.faults.join("; ")}`);
        break;
      case "terminal":
        refused.push(entity.retired !== null && !fold.relationships.retainedDidIds.has(didId) ? `${kid}: ${did} is retired and in no relationship's history` : `${kid}: its route or mediation is retired or in conflict`);
        break;
    }
  }
  if (pending.length > 0) return { verdict: "pending", reason: pending.join("; ") };
  return { verdict: "terminal", reason: refused.join("; ") };
}

/** What the outer protected header says of the sender: the key it names, and the `apu` that must repeat it. Null where the header has none, as under sender protection. */
export interface Sealing {
  skid: string | null;
  apu: string | null;
}

export function sealingOf(packed: string): Sealing {
  try {
    const outer = JSON.parse(packed) as { protected?: unknown };
    if (typeof outer.protected !== "string") return { skid: null, apu: null };
    const header = JSON.parse(base64urlToUtf8(outer.protected)) as { skid?: unknown; apu?: unknown };
    return { skid: typeof header.skid === "string" ? header.skid : null, apu: typeof header.apu === "string" ? base64urlToUtf8(header.apu) : null };
  } catch {
    return { skid: null, apu: null };
  }
}

/** The sender an opened envelope authenticates, as the receipt records it. */
export interface AuthenticatedSender {
  /** the sender's DID resolved for this delivery */
  resolution: Resolution;
  /** the method that sealed the envelope, or signed it when no one sealed it */
  kid: DidUrl;
  /** that method's key */
  peerPublicKey: PublicKey;
  /** the key of a signature on the plaintext, when one rode */
  signedBy: PublicKey | null;
}

export type SenderProof = { sender: AuthenticatedSender | null } | { refused: string };

/**
 * What an opened envelope proves of its sender: null when no key of
 * theirs sealed or signed it. `resolution` is the sender's document as
 * resolved while it was opened. A signature beside a seal must be the
 * same DID's.
 */
export function senderProof(plaintext: IMessage, metadata: UnpackMetadata, sealing: Sealing, resolution: Resolution | null): SenderProof {
  const sealer = typeof metadata.encrypted_from_kid === "string" ? metadata.encrypted_from_kid : null;
  const signer = metadata.non_repudiation && typeof metadata.sign_from === "string" ? metadata.sign_from : null;
  const kid = sealer ?? signer;
  if (kid === null) return { sender: null };
  if (sealing.skid !== null) {
    if (sealer !== sealing.skid) return { refused: `the header names ${sealing.skid} as the sender's key, but ${sealer ?? "no key"} sealed the envelope` };
    if (sealing.apu !== sealing.skid) return { refused: `the header's apu ${JSON.stringify(sealing.apu)} is not its skid ${sealing.skid}` };
  }
  const [did] = splitDidUrl(kid);
  if (plaintext.from !== did) return { refused: `the plaintext is from ${JSON.stringify(plaintext.from ?? null)}, not ${did}, whose key ${sealer === null ? "signed" : "sealed"} it` };
  if (resolution === null || resolution.presentedDid !== did) return { refused: `${did} was not resolved for this delivery` };
  const use = sealer === null ? "authentication" : "keyAgreement";
  const peerPublicKey = methodKey(resolution, use, kid);
  if (peerPublicKey === null) return { refused: `${kid} is no ${use} method of ${did}'s document` };
  let signedBy: PublicKey | null = null;
  if (signer !== null) {
    if (splitDidUrl(signer)[0] !== did) return { refused: `the plaintext is signed by ${signer}, not by its sender ${did}` };
    signedBy = methodKey(resolution, "authentication", signer);
    if (signedBy === null) return { refused: `${signer} is no authentication method of ${did}'s document` };
  }
  return { sender: { resolution, kid: kid as DidUrl, peerPublicKey, signedBy } };
}

/** The key the document authorizes for `use` under the method `kid` names, whichever spelling of the DID the two are written in. */
function methodKey(resolution: Resolution, use: "authentication" | "keyAgreement", kid: string): PublicKey | null {
  const [did, fragment] = splitDidUrl(kid);
  for (const [id, key] of authorizedKeys(resolution, use)) {
    const [owner, own] = splitDidUrl(id);
    if (own === fragment && sameDid(owner, did)) return key;
  }
  return null;
}

/** What a held delivery waits on in the vault: the evidence that places an address pair, or the evidence of who took an invitation. */
export type Dependency = { kind: "pair"; localDid: Did; peerDid: Did } | { kind: "invitation"; oobId: string };

/**
 * What the vault says about one address pair, as a delivery at it is
 * placed: the relationships whose histories hold it, what claims it
 * from evidence that is all here and disagrees with itself, and what
 * claims it while evidence may yet settle the claim. Everything the
 * placement reads is read here, so that a wait for evidence watches
 * the whole of what decided it.
 */
export interface PairEvidence {
  /** the relationships whose validated histories hold the pair; more than one is a conflict for each */
  readonly claimants: readonly RelationshipId[];
  /** claims nothing can ever apply: no delivery is born at the pair */
  readonly contradicted: readonly string[];
  /** claims evidence may yet settle: a delivery waits among them rather than being born beside them */
  readonly awaited: readonly string[];
}

/**
 * Everything retained that claims the pair: a carrier or a transition
 * the fold holds pending there, a relationship whose binding and
 * transitions name both of its addresses, the ID a birth there would
 * take, and an observation already recorded at it that is not scoped.
 * A claim is contradicted only where the evidence deciding it is all
 * here and disagrees with itself. A conflict a missing event explains —
 * a transition whose local prefix is absent, an observation at a key
 * the history does not reach yet — is waited on instead, since
 * recovering that event settles it.
 */
export function pairEvidence(fold: VaultFold, localDid: Did, peerDid: Did): PairEvidence {
  const { relationships } = fold;
  const contradicted: string[] = [];
  const awaited: string[] = [];
  const claimed = new Set<string>();
  for (const claim of relationships.pendingAt(localDid, peerDid)) {
    for (const eventId of claim.eventIds) claimed.add(eventId);
    awaited.push(`the evidence of ${claim.eventIds.join(", ")}`);
  }
  for (const relationshipId of claiming(fold, localDid, peerDid)) {
    const contradiction = contradictingBindings(fold, relationshipId);
    if (contradiction !== null) contradicted.push(`the binding of ${relationshipId}, which does not stand: ${contradiction}`);
    else awaited.push(`the claim of ${relationshipId}, which does not hold the pair yet${standingOf(relationships.relationships.get(relationshipId))}`);
  }
  const didId = fold.routes.entityOfDid(localDid);
  const localKeyName = didId === null ? null : didKeyName(didId, "key-agreement");
  for (const event of fold.set.of("message.in")) {
    if (event.data.localKeyName !== localKeyName || event.data.did !== peerDid || claimed.has(event.eventId)) continue;
    const scope = relationships.observations.get(event.eventId);
    if (scope === undefined || scope.status === "scoped" || scope.status === "anonymous") continue;
    awaited.push(`the standing of ${event.eventId} at the same pair, which ${scope.because}`);
  }
  return { claimants: relationships.claimants(localDid, peerDid), contradicted, awaited };
}

/** Why a relationship does not hold the pair yet, as the fold puts it. */
function standingOf(relationship: Relationship | undefined): string {
  const why = relationship === undefined ? [] : [...relationship.deferred, ...relationship.faults];
  return why.length === 0 ? "" : `: ${why.join("; ")}`;
}

/**
 * The relationships that name both addresses of the pair in evidence
 * they retain, while their validated histories do not hold it: a
 * binding whose root local DID is this recipient and whose root peer is
 * this sender — by the resolution it pins, or, while that resolution is
 * not here, by the ID the two derive — a transition naming either
 * address at the end it moves, and the ID a birth at the pair would
 * take. Their evidence points at the pair before any chain reaches it,
 * so a birth beside them would claim what they claim.
 */
function claiming(fold: VaultFold, localDid: Did, peerDid: Did): RelationshipId[] {
  const birth = birthOf(localDid, peerDid);
  const locals = new Set<RelationshipId>();
  const peers = new Set<RelationshipId>();
  const naming = new Set<RelationshipId>();
  for (const event of fold.set.of("relationship.bound")) {
    const { relationshipId, localDidId, peerResolutionEventId } = event.data;
    if (relationshipId === birth) naming.add(relationshipId);
    const rootLocal = didOf(fold, localDidId);
    if (rootLocal === localDid) locals.add(relationshipId);
    const resolved = fold.set.resolve(peerResolutionEventId, "peer.resolved");
    if (resolved.status === "present" ? resolved.event.data.did === peerDid : rootLocal !== null && birthOf(rootLocal, peerDid) === relationshipId) peers.add(relationshipId);
  }
  for (const edge of fold.set.of("relationship.localTransitioned")) if (didOf(fold, edge.data.toDidId) === localDid) locals.add(edge.data.relationshipId);
  for (const edge of fold.set.of("relationship.peerTransitioned")) if (edge.data.toDid === peerDid) peers.add(edge.data.relationshipId);
  for (const relationshipId of locals) if (peers.has(relationshipId)) naming.add(relationshipId);
  const holding = new Set(fold.relationships.claimants(localDid, peerDid));
  return [...naming].filter((relationshipId) => !holding.has(relationshipId)).sort();
}

/**
 * What the bindings under one relationship ID disagree on, with every
 * event deciding it here: two root local DIDs, two root peer DIDs or
 * documents, or a binding its own resolution refutes. Nothing later
 * makes such a relationship stand, since each of those references is
 * immutable, so no delivery is ever born at a pair it claims.
 */
function contradictingBindings(fold: VaultFold, relationshipId: RelationshipId): string | null {
  const localDidIds = new Set<DidId>();
  const dids = new Set<Did>();
  const documents = new Set<Cid>();
  for (const event of fold.set.of("relationship.bound")) {
    if (event.data.relationshipId !== relationshipId) continue;
    localDidIds.add(event.data.localDidId);
    const resolved = fold.set.resolve(event.data.peerResolutionEventId, "peer.resolved");
    if (resolved.status === "mismatched") return `binding ${event.eventId} names ${resolved.event.type} as its peer resolution`;
    if (resolved.status === "missing") continue;
    if (bindingHolds(event.data, resolved.event.data, didOf(fold, event.data.localDidId)) === "contradicted") return `binding ${event.eventId} does not hold: its resolution, local DID and relationship ID disagree`;
    dids.add(resolved.event.data.did);
    documents.add(resolved.event.data.documentCid);
  }
  if (localDidIds.size > 1) return "bindings disagree on the root local DID";
  if (dids.size > 1) return "bindings disagree on the root peer DID";
  if (documents.size > 1) return "bindings disagree on the root peer document";
  return null;
}

const didOf = (fold: VaultFold, didId: DidId): Did | null => fold.routes.dids.get(didId)?.created?.did ?? null;

/** The ID a birth at the pair takes; null where the two addresses are one, which is no relationship. */
function birthOf(localDid: Did, peerDid: Did): RelationshipId | null {
  return localDid === peerDid ? null : relationshipIdOf(localDid, peerDid);
}

/** What a wait watches, as text: the delivery is retried when this changes, and only then. */
export function evidenceOf(fold: VaultFold, dependencies: readonly Dependency[]): string {
  return JSON.stringify(dependencies.map((dependency) => (dependency.kind === "pair" ? pairFingerprint(fold, dependency.localDid, dependency.peerDid) : invitationFingerprint(fold, dependency.oobId))));
}

function pairFingerprint(fold: VaultFold, localDid: Did, peerDid: Did): unknown {
  const { claimants, contradicted, awaited } = pairEvidence(fold, localDid, peerDid);
  return {
    claimants: claimants.map((relationshipId) => {
      const relationship = fold.relationships.relationships.get(relationshipId);
      return [relationshipId, relationship?.conflict ?? null, relationship?.faults ?? [], relationship?.deferred ?? [], relationship?.localChain.length ?? 0, relationship?.peerChain.length ?? 0];
    }),
    contradicted,
    awaited,
  };
}

function invitationFingerprint(fold: VaultFold, oobId: string): unknown {
  const invitation = fold.invitations.invitations.get(oobId);
  return invitation === undefined ? null : [invitation.consumers, invitation.pending, invitation.inconsistent, invitation.faults, invitation.available];
}
