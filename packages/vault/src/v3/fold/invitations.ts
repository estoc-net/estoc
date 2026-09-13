/**
 * The one-use invitations: each OOB disclosure, whether its DID is
 * still live, and which relationship's root-address receipt consumed
 * it. A receipt consumes an invitation only when it is a root-address
 * receipt — bound, proof-free, decrypted by the binding's root local
 * key, sent by the binding's root peer DID — whose `pthid` is the
 * invitation's ID and whose local recipient is the disclosed DID; its
 * consumer is the binding's relationship, once the binding itself is
 * seen to hold: its resolution taken at its local DID's key, the two
 * root DIDs distinct and deriving its relationship ID. A receipt that
 * may be such a consumption but whose evidence is not here yet holds
 * the invitation: nobody else is admitted until the evidence arrives
 * and says who consumed it, or that nobody did. Nothing records
 * consumption: it is read from the receipts, so deletion, erasure and
 * retirement never reopen one.
 */

import { InvalidIdentifier } from "../errors.js";
import { didKeyName, relationshipId } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Did, DidId, DisclosureUses, EventId, RelationshipId } from "../types.js";
import type { RouteFold } from "./routes.js";
import type { VaultEventSet } from "./set.js";

const NO_RETENTION: ReadonlySet<DidId> = new Set();

export interface Invitation {
  /** the OOB message ID a follower carries as `pthid` */
  readonly oobId: string;
  /** the first disclosure's DID in canonical order; a disclosure of another DID under this ID is a fault */
  readonly didId: DidId;
  /** the first disclosure's use; a disclosure of the other use under this ID is a fault */
  readonly uses: DisclosureUses;
  /** the goal of the first disclosure in canonical order */
  readonly goal: string | null;
  readonly disclosures: readonly VaultEvent<"did.disclosed">[];
  /** every relationship whose root-address receipt matched, in the order of the relationship IDs */
  readonly consumers: readonly RelationshipId[];
  /** receipts that may have consumed it but whose binding or resolution evidence is not here yet; they hold a one-use invitation */
  readonly pending: readonly EventId[];
  /** receipts that would match but whose binding contradicts the events it names: no consumer, a diagnostic */
  readonly inconsistent: readonly EventId[];
  /** what makes the invitation a conflict: disclosures that disagree, or two consumers of one use */
  readonly faults: readonly string[];
  /** unavailable to anyone, and an integrity conflict */
  readonly conflict: boolean;
  /** may be consumed by a relationship that has not: the DID is live, nothing conflicts and, for one use, nothing consumed it or may have */
  readonly available: boolean;
}

/**
 * Whether the invitation stands in the way of a root-address receipt
 * for a relationship; only the invitation, the DID's own eligibility to
 * receive is the route fold's `receipt`. `consumable`: it is available,
 * that relationship already consumed it, or every receipt still waiting
 * for evidence claims that same relationship, which is safe because
 * such a receipt ends up as that relationship's consumption or as
 * inconsistent, never as a second consumer. `pending`: evidence still
 * to arrive decides it, the DID's key check or a waiting receipt that
 * may have consumed it for someone else; the input waits. `unavailable`
 * is terminal: no such invitation, a conflict, a DID that is gone or
 * retired, or another relationship consumed it.
 */
export type Consumability = "consumable" | "pending" | "unavailable";

export interface InvitationFold {
  readonly invitations: ReadonlyMap<string, Invitation>;
  consumable(oobId: string, relationshipId: RelationshipId): Consumability;
}

/** each pending receipt with the relationship its binding claims, null while the binding itself is missing */
type Receipts = { consumers: Set<RelationshipId>; pending: Map<EventId, RelationshipId | null>; inconsistent: EventId[] };

export function foldInvitations(set: VaultEventSet, routes: RouteFold): InvitationFold {
  const byOob = new Map<string, VaultEvent<"did.disclosed">[]>();
  for (const event of set.of("did.disclosed")) {
    if (event.data.oobId === null) continue;
    const group = byOob.get(event.data.oobId);
    if (group === undefined) byOob.set(event.data.oobId, [event]);
    else group.push(event);
  }

  const receipts = new Map<string, Receipts>();
  for (const receipt of set.of("message.in")) {
    const { pthid, relationshipBindingEventId, peerResolutionEventId, localKeyName: rootKey } = receipt.data;
    if (pthid === null || relationshipBindingEventId === null || peerResolutionEventId === null || receipt.data.fromPrior !== null || receipt.data.peerTransitionEventId !== null) continue;
    const disclosed = byOob.get(pthid)?.find((disclosure) => didKeyName(disclosure.data.didId, "key-agreement") === rootKey);
    if (disclosed === undefined) continue;
    const entry = receipts.get(pthid) ?? { consumers: new Set<RelationshipId>(), pending: new Map<EventId, RelationshipId | null>(), inconsistent: [] };
    receipts.set(pthid, entry);

    const binding = set.resolve(relationshipBindingEventId, "relationship.bound");
    if (binding.status === "missing") {
      entry.pending.set(receipt.eventId, null);
      continue;
    }
    if (binding.status === "mismatched") {
      entry.inconsistent.push(receipt.eventId);
      continue;
    }
    const { relationshipId: claimed, localDidId, peerResolutionEventId: rootResolutionEventId } = binding.event.data;
    if (localDidId !== disclosed.data.didId) continue;

    const own = set.resolve(peerResolutionEventId, "peer.resolved");
    if (own.status === "mismatched" || (own.status === "present" && (own.event.data.did !== receipt.data.did || own.event.data.localKeyName !== rootKey))) continue;
    const root = set.resolve(rootResolutionEventId, "peer.resolved");
    if (root.status === "mismatched" || (root.status === "present" && root.event.data.did !== receipt.data.did)) continue;
    const localDid = routes.dids.get(localDidId)?.created?.did ?? null;
    const rootHolds = root.status === "present" ? bindingHolds(binding.event.data, root.event.data, localDid, rootKey) : "unknown";
    if (rootHolds === "contradicted") entry.inconsistent.push(receipt.eventId);
    else if (own.status === "missing" || rootHolds === "unknown") entry.pending.set(receipt.eventId, claimed);
    else entry.consumers.add(claimed);
  }

  const invitations = new Map<string, Invitation>();
  for (const [oobId, disclosures] of [...byOob].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const first = disclosures[0]!.data;
    const faults: string[] = [];
    if (disclosures.some((event) => event.data.didId !== first.didId)) faults.push("disclosures disagree on the DID");
    if (disclosures.some((event) => event.data.uses !== first.uses)) faults.push("disclosures disagree on the use");
    const receipt = receipts.get(oobId);
    const consumers = [...(receipt?.consumers ?? [])].sort();
    if (first.uses === "one" && consumers.length > 1) faults.push(`consumed by ${consumers.length} relationships`);
    const conflict = faults.length > 0;
    const pending = [...(receipt?.pending.keys() ?? [])];
    const live = routes.dids.get(first.didId)?.live === true;
    invitations.set(oobId, {
      oobId,
      didId: first.didId,
      uses: first.uses,
      goal: first.goal,
      disclosures,
      consumers,
      pending,
      inconsistent: receipt?.inconsistent ?? [],
      faults,
      conflict,
      available: live && !conflict && (first.uses === "many" || (consumers.length === 0 && pending.length === 0)),
    });
  }

  return {
    invitations,
    consumable(oobId, relationshipId) {
      const invitation = invitations.get(oobId);
      if (invitation === undefined || invitation.conflict) return "unavailable";
      if (invitation.consumers.includes(relationshipId)) return "consumable";
      const eligibility = routes.receipt(invitation.didId, NO_RETENTION);
      if (eligibility === "terminal") return "unavailable";
      if (invitation.uses === "one") {
        if (invitation.consumers.length > 0) return "unavailable";
        for (const claimed of receipts.get(oobId)?.pending.values() ?? []) if (claimed !== relationshipId) return "pending";
      }
      return eligibility === "eligible" ? "consumable" : "pending";
    },
  };
}

/**
 * Whether a binding's evidence holds together: its resolution was
 * taken at the local DID's key-agreement key, the two root DIDs are
 * distinct and derive the recorded relationship ID. Each check runs as
 * soon as what it needs is here, so a contradiction is found without
 * waiting for the rest; `unknown` only while the local DID's own
 * spelling is still missing and nothing present contradicts.
 */
function bindingHolds(binding: VaultEvent<"relationship.bound">["data"], root: VaultEvent<"peer.resolved">["data"], localDid: Did | null, rootKey: string): "holds" | "contradicted" | "unknown" {
  if (root.localKeyName !== rootKey) return "contradicted";
  if (localDid === null) return "unknown";
  if (root.did === localDid) return "contradicted";
  try {
    return relationshipId(localDid, root.did) === binding.relationshipId ? "holds" : "contradicted";
  } catch (err) {
    if (err instanceof InvalidIdentifier) return "contradicted";
    throw err;
  }
}
