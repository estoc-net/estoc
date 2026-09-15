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
import { splitDidUrl, type Did, type DidId, type DidUrl, type KeyName, type PublicKey, type VaultFold } from "@estoc/vault/v3";

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

/**
 * What of the vault decides whether a delivery at this address pair can
 * select its relationship: the relationships whose histories hold the
 * pair, how they stand, and the claims that keep a proof-free delivery
 * there waiting. A wait for relationship evidence is retried when this
 * changes, and only then.
 */
export function pairEvidence(fold: VaultFold, localDid: Did, peerDid: Did): string {
  const { relationships } = fold;
  return JSON.stringify({
    claimants: relationships.claimants(localDid, peerDid).map((relationshipId) => {
      const relationship = relationships.relationships.get(relationshipId);
      return [relationshipId, relationship?.conflict ?? null, relationship?.faults ?? [], relationship?.deferred ?? [], relationship?.localChain.length ?? 0, relationship?.peerChain.length ?? 0];
    }),
    pending: relationships.pendingAt(localDid, peerDid).map((claim) => [claim.because, claim.eventIds, claim.conflict]),
  });
}
