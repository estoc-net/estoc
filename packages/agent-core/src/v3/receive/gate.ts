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
import { didKeyName, relationshipId as relationshipIdOf, splitDidUrl, type Did, type DidId, type DidUrl, type EventId, type KeyName, type PublicKey, type Relationship, type RelationshipId, type VaultFold } from "@estoc/vault/v3";

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
 * and no evidence can settle, what claims it and evidence may yet
 * settle, and the relationship a birth there would take. Everything
 * the placement reads is read here, so that a wait for evidence
 * watches the whole of what decided it.
 */
export interface PairEvidence {
  /** the relationships whose validated histories hold the pair; more than one is a conflict for each */
  readonly claimants: readonly RelationshipId[];
  /** claims on the pair that can never be applied: nothing may be born there */
  readonly contradicted: readonly string[];
  /** claims on the pair whose evidence is not all here: it may yet be placed among them */
  readonly awaited: readonly string[];
  /** the relationship a birth at the pair would take, while events already stand under that ID */
  readonly born: Relationship | null;
}

export function pairEvidence(fold: VaultFold, localDid: Did, peerDid: Did): PairEvidence {
  const { relationships } = fold;
  const contradicted: string[] = [];
  const awaited: string[] = [];
  const claimed = new Set<string>();
  for (const claim of relationships.pendingAt(localDid, peerDid)) {
    for (const eventId of claim.eventIds) claimed.add(eventId);
    if (claim.conflict) contradicted.push(`the ${claim.because} ${claim.eventIds.join(", ")}, whose transition is in conflict`);
    else awaited.push(`the evidence of ${claim.eventIds.join(", ")}`);
  }
  for (const eventId of contradictingTransitions(fold, localDid, peerDid)) contradicted.push(`the transition ${eventId}, which is in conflict`);
  const didId = fold.routes.entityOfDid(localDid);
  const localKeyName = didId === null ? null : didKeyName(didId, "key-agreement");
  for (const event of fold.set.of("message.in")) {
    if (event.data.localKeyName !== localKeyName || event.data.did !== peerDid || claimed.has(event.eventId)) continue;
    const scope = relationships.observations.get(event.eventId);
    if (scope === undefined || scope.status === "scoped" || scope.status === "anonymous") continue;
    awaited.push(`the standing of ${event.eventId} at the same pair, which ${scope.because}`);
  }
  const born = localDid === peerDid ? null : (relationships.relationships.get(relationshipIdOf(localDid, peerDid)) ?? null);
  return { claimants: relationships.claimants(localDid, peerDid), contradicted, awaited, born };
}

/** The transitions in conflict that would have put the pair in the address index: they never will, so nothing is born there either. */
function* contradictingTransitions(fold: VaultFold, localDid: Did, peerDid: Did): Generator<string> {
  const { relationships, routes } = fold;
  const contradicts = (eventId: EventId) => relationships.transitions.get(eventId)?.status === "conflict";
  for (const edge of fold.set.of("relationship.localTransitioned")) {
    if (routes.dids.get(edge.data.toDidId)?.created?.did !== localDid || !contradicts(edge.eventId)) continue;
    if (relationships.relationships.get(edge.data.relationshipId)?.peerChain.some((node) => node.did === peerDid) === true) yield edge.eventId;
  }
  for (const edge of fold.set.of("relationship.peerTransitioned")) {
    if (edge.data.toDid !== peerDid || !contradicts(edge.eventId)) continue;
    if (relationships.relationships.get(edge.data.relationshipId)?.localChain.some((node) => node.did === localDid) === true) yield edge.eventId;
  }
}

/** What a wait watches, as text: the delivery is retried when this changes, and only then. */
export function evidenceOf(fold: VaultFold, dependencies: readonly Dependency[]): string {
  return JSON.stringify(dependencies.map((dependency) => (dependency.kind === "pair" ? pairFingerprint(fold, dependency.localDid, dependency.peerDid) : invitationFingerprint(fold, dependency.oobId))));
}

function pairFingerprint(fold: VaultFold, localDid: Did, peerDid: Did): unknown {
  const { claimants, contradicted, awaited, born } = pairEvidence(fold, localDid, peerDid);
  return {
    claimants: claimants.map((relationshipId) => {
      const relationship = fold.relationships.relationships.get(relationshipId);
      return [relationshipId, relationship?.conflict ?? null, relationship?.faults ?? [], relationship?.deferred ?? [], relationship?.localChain.length ?? 0, relationship?.peerChain.length ?? 0];
    }),
    contradicted,
    awaited,
    born: born === null ? null : [born.bindingEventIds, born.deferred, born.faults, born.conflict],
  };
}

function invitationFingerprint(fold: VaultFold, oobId: string): unknown {
  const invitation = fold.invitations.invitations.get(oobId);
  return invitation === undefined ? null : [invitation.consumers, invitation.pending, invitation.inconsistent, invitation.faults, invitation.available];
}
