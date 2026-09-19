/**
 * The hard gate before the vault, as pure decisions over the fold and
 * the envelope: which key of this vault an envelope may be opened with,
 * decided before anything is decrypted; the sender's document, from
 * what the vault holds and never from the network; and, once the
 * envelope is open, whether what it proves of its sender matches that
 * document.
 */

import { base64urlToUtf8, isPeerDID4, isShortForm } from "@estoc/did-peer";
import { splitDidUrl, type Did, type DidId, type DidUrl, type KeyName, type PublicKey, type VaultFold } from "@estoc/vault/v3";

import type { Unpacked } from "../../protocol/didcomm.js";
import { authorizedKeys } from "../evidence.js";
import { knownLongForms, resolve, type Resolution } from "../resolver.js";
import { sameDid } from "../same-did.js";

export type Recipients =
  | { verdict: "eligible"; kid: DidUrl; didId: DidId; did: Did; localKeyName: KeyName }
  /** a recipient of this vault lacks only something recoverable: the delivery waits, unopened, on those entities */
  | { verdict: "pending"; reason: string; waitingOn: DidId[] }
  | { verdict: "terminal"; reason: string };

/**
 * Which key of this vault the envelope may be opened with: the first
 * recipient, in the envelope's order, naming the exact key-agreement
 * method of an entity that may receive — live, or retired with its
 * route intact, since retirement ends new sending but not the draining
 * of what was addressed here. A method is named by whatever follows
 * the DID in the document's own `id`, a fragment or a query with one.
 * Short of an eligible recipient, one whose entity lacks only something
 * recoverable — its route's configuration, a grant, the key check —
 * keeps the delivery pending. Everything else is terminal: a method the
 * document does not have or authorizes only for authentication, a
 * route or mediation retired or in conflict, and an envelope naming no
 * key of this vault at all, which is told apart so that a vault
 * restored to before one of its DIDs was created shows what it lacks
 * without claiming why.
 */
export function classifyRecipients(fold: VaultFold, kids: readonly string[]): Recipients {
  if (kids.length === 0) return { verdict: "terminal", reason: "the envelope names no recipient key" };
  const refused: string[] = [];
  const pending: string[] = [];
  const waitingOn = new Set<DidId>();
  let anyOfOurs = false;
  for (const kid of new Set(kids)) {
    const [did, reference] = splitDidUrl(kid);
    const didId = fold.routes.entityOfDid(did);
    const entity = didId === null ? undefined : fold.routes.dids.get(didId);
    if (didId === null || entity === undefined || entity.created === null) continue;
    anyOfOurs = true;
    const named = (ids: readonly DidUrl[]): boolean => ids.some((id) => splitDidUrl(id)[1] === reference);
    if (!named(entity.methodIds.keyAgreement)) {
      refused.push(named(entity.methodIds.authentication) ? `${kid} is an authentication method, not a key-agreement one` : `${kid} names no method of ${did}`);
      continue;
    }
    switch (fold.routes.receipt(didId)) {
      case "eligible":
        return { verdict: "eligible", kid: kid as DidUrl, didId, did: entity.created.did, localKeyName: entity.keyNames.keyAgreement };
      case "pending":
        pending.push(`${kid}: ${entity.faults.join("; ")}`);
        waitingOn.add(didId);
        break;
      case "terminal":
        refused.push(`${kid}: its route or mediation is retired or in conflict`);
        break;
    }
  }
  if (pending.length > 0) return { verdict: "pending", reason: pending.join("; "), waitingOn: [...waitingOn] };
  if (!anyOfOurs) return { verdict: "terminal", reason: `local recipient material is unavailable for ${kids.join(", ")}; the delivery was discarded` };
  return { verdict: "terminal", reason: refused.join("; ") };
}

/** What the outer protected header says of the sender: the key it names, and the `apu` that must repeat it. Null where the header has none, as under an anonymous seal. */
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

/**
 * The document of the sender the outer header names, from what the
 * vault holds alone; null for an anonymous seal. A sender that cannot
 * be resolved here cannot be authenticated, which is terminal. A short
 * form whose long form is not in evidence is told without naming the
 * claimed sender as anyone in particular: a vault restored to before
 * that long form arrived sees exactly this.
 */
export async function senderEvidence(fold: VaultFold, skid: string | null): Promise<{ resolution: Resolution | null } | { terminal: string }> {
  if (skid === null) return { resolution: null };
  const [did] = splitDidUrl(skid);
  if (!isPeerDID4(did)) return { terminal: `the sender ${did} is not a did:peer:4, the one method a channel endpoint may use` };
  const answer = await resolve(did, knownLongForms(fold));
  if (answer.outcome === "resolved") return { resolution: answer.resolution };
  if (isShortForm(did)) return { terminal: `sender material is unavailable for ${did}; the delivery was discarded` };
  return { terminal: `the sender ${did} does not resolve: ${answer.reason}` };
}

/** The sender an opened envelope authenticates, as the receipt records it. */
export interface AuthenticatedSender {
  /** the sender's document, as the vault holds it */
  resolution: Resolution;
  /** the key-agreement method that sealed the envelope */
  kid: DidUrl;
  /** that method's key */
  peerPublicKey: PublicKey;
}

export type SenderProof = { sender: AuthenticatedSender | null } | { refused: string };

/**
 * What an opened envelope proves of its sender: null when no one sealed
 * it, in which case the plaintext may not claim a sender either, since
 * nothing would authenticate the claim. A signature inside the envelope
 * proves nothing about the sender here and is not looked at.
 */
export function senderProof(unpacked: Unpacked, sealing: Sealing, resolution: Resolution | null): SenderProof {
  const { sender, plaintext } = unpacked;
  if (sender === null) {
    if (plaintext.from !== undefined) return { refused: `the envelope is anonymous, but its plaintext claims to be from ${plaintext.from}` };
    return { sender: null };
  }
  if (sealing.skid !== sender.kid) return { refused: `the header names ${sealing.skid ?? "no key"} as the sender's key, but ${sender.kid} sealed the envelope` };
  if (sealing.apu !== sealing.skid) return { refused: `the header's apu ${JSON.stringify(sealing.apu)} is not its skid ${sealing.skid}` };
  if (resolution === null || resolution.presentedDid !== sender.did) return { refused: `${sender.did} was not the sender resolved for this delivery` };
  const peerPublicKey = methodKey(resolution, sender.kid);
  if (peerPublicKey === null) return { refused: `${sender.kid} is no key-agreement method of ${sender.did}'s document` };
  return { sender: { resolution, kid: sender.kid as DidUrl, peerPublicKey } };
}

/** The key the document authorizes for key agreement under the method `kid` names, whichever spelling of the DID the two are written in. */
function methodKey(resolution: Resolution, kid: string): PublicKey | null {
  const [did, reference] = splitDidUrl(kid);
  for (const [id, key] of authorizedKeys(resolution, "keyAgreement")) {
    const [owner, own] = splitDidUrl(id);
    if (own === reference && sameDid(owner, did)) return key;
  }
  return null;
}
