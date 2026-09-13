/**
 * The one-use invitations: each OOB disclosure, whether its DID is
 * still live, and which relationship's root-address receipt consumed
 * it. A receipt consumes an invitation only when it is a root-address
 * receipt — bound, proof-free, decrypted by the binding's root local
 * key, sent by the binding's root peer DID — whose `pthid` is the
 * invitation's ID and whose local recipient is the disclosed DID; its
 * consumer is the binding's relationship, once the binding itself is
 * seen to hold: its resolution taken at its local DID's key, the two
 * root DIDs distinct and deriving its relationship ID. Nothing records
 * consumption: it is read from the receipts, so deletion, erasure and
 * retirement never reopen one.
 */

import { InvalidIdentifier } from "../errors.js";
import { didKeyName, relationshipId } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Did, DidId, DisclosureUses, EventId, RelationshipId } from "../types.js";
import type { RouteFold } from "./routes.js";
import type { VaultEventSet } from "./set.js";

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
  /** receipts that may match but whose binding or resolution evidence is not here yet */
  readonly pending: readonly EventId[];
  /** receipts that would match but whose binding contradicts the events it names: no consumer, a diagnostic */
  readonly inconsistent: readonly EventId[];
  /** what makes the invitation a conflict: disclosures that disagree, or two consumers of one use */
  readonly faults: readonly string[];
  /** unavailable to anyone, and an integrity conflict */
  readonly conflict: boolean;
  /** may be consumed by a relationship that has not: the DID is live, nothing conflicts and, for one use, nothing consumed it */
  readonly available: boolean;
}

export interface InvitationFold {
  readonly invitations: ReadonlyMap<string, Invitation>;
  /**
   * May a root-address receipt for `relationshipId` proceed under this
   * invitation? When it is available, or that relationship already
   * consumed it; never for another consumer of a consumed one, and
   * never under a conflict.
   */
  consumable(oobId: string, relationshipId: RelationshipId): boolean;
}

type Receipts = { consumers: Set<RelationshipId>; pending: EventId[]; inconsistent: EventId[] };

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
    const { pthid, relationshipBindingEventId, peerResolutionEventId } = receipt.data;
    if (pthid === null || relationshipBindingEventId === null || peerResolutionEventId === null || receipt.data.fromPrior !== null || receipt.data.peerTransitionEventId !== null) continue;
    const disclosures = byOob.get(pthid);
    if (disclosures === undefined) continue;
    const entry = receipts.get(pthid) ?? { consumers: new Set<RelationshipId>(), pending: [], inconsistent: [] };
    receipts.set(pthid, entry);

    const binding = set.resolve(relationshipBindingEventId, "relationship.bound");
    if (binding.status === "missing") {
      entry.pending.push(receipt.eventId);
      continue;
    }
    if (binding.status === "mismatched") {
      entry.inconsistent.push(receipt.eventId);
      continue;
    }
    const { localDidId, peerResolutionEventId: rootResolutionEventId } = binding.event.data;
    const rootKey = didKeyName(localDidId, "key-agreement");
    if (receipt.data.localKeyName !== rootKey || !disclosures.some((disclosure) => disclosure.data.didId === localDidId)) continue;

    const own = set.resolve(peerResolutionEventId, "peer.resolved");
    const root = set.resolve(rootResolutionEventId, "peer.resolved");
    const localDid = routes.dids.get(localDidId)?.created?.did ?? null;
    if (own.status === "missing" || root.status === "missing" || localDid === null) {
      entry.pending.push(receipt.eventId);
      continue;
    }
    if (own.status === "mismatched" || own.event.data.did !== receipt.data.did || own.event.data.localKeyName !== rootKey) continue;
    if (root.status === "mismatched" || root.event.data.did !== receipt.data.did) continue;
    const consumer = rootRelationship(binding.event.data, root.event.data, localDid, rootKey);
    if (consumer === null) entry.inconsistent.push(receipt.eventId);
    else entry.consumers.add(consumer);
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
    const live = routes.dids.get(first.didId)?.live === true;
    invitations.set(oobId, {
      oobId,
      didId: first.didId,
      uses: first.uses,
      goal: first.goal,
      disclosures,
      consumers,
      pending: receipt?.pending ?? [],
      inconsistent: receipt?.inconsistent ?? [],
      faults,
      conflict,
      available: live && !conflict && (first.uses === "many" || consumers.length === 0),
    });
  }

  return {
    invitations,
    consumable(oobId, relationshipId) {
      const invitation = invitations.get(oobId);
      if (invitation === undefined || invitation.conflict) return false;
      return invitation.available || (invitation.uses === "one" && invitation.consumers.includes(relationshipId));
    },
  };
}

/**
 * The relationship a binding names, when its evidence holds together:
 * the resolution was taken at the local DID's key-agreement key, the
 * two root DIDs are distinct and derive the recorded relationship ID.
 * Null for a binding the events it names contradict.
 */
function rootRelationship(binding: VaultEvent<"relationship.bound">["data"], root: VaultEvent<"peer.resolved">["data"], localDid: Did, rootKey: string): RelationshipId | null {
  if (root.localKeyName !== rootKey || root.did === localDid) return null;
  try {
    return relationshipId(localDid, root.did) === binding.relationshipId ? binding.relationshipId : null;
  } catch (err) {
    if (err instanceof InvalidIdentifier) return null;
    throw err;
  }
}
