/**
 * The one-use invitations: each OOB disclosure, whether its DID is
 * still live, and which relationship's root-address receipt consumed
 * it. A receipt consumes an invitation only when it is a root-address
 * receipt — bound, proof-free, decrypted by the binding's root local
 * key, sent by the binding's root peer DID — whose `pthid` is the
 * invitation's ID and whose local recipient is the disclosed DID; its
 * consumer is the binding's relationship. Nothing records consumption:
 * it is read from the receipts, so deletion, erasure and retirement
 * never reopen one.
 */

import { didKeyName } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { DidId, DisclosureUses, EventId, RelationshipId } from "../types.js";
import type { RouteFold } from "./routes.js";
import type { VaultEventSet } from "./set.js";

export interface Invitation {
  /** the OOB message ID a follower carries as `pthid` */
  readonly oobId: string;
  readonly didId: DidId;
  /** `one` unless some disclosure of this ID says `many` */
  readonly uses: DisclosureUses;
  /** the goal of the first disclosure in canonical order */
  readonly goal: string | null;
  readonly disclosures: readonly VaultEvent<"did.disclosed">[];
  /** every relationship whose root-address receipt matched, in the order of the relationship IDs */
  readonly consumers: readonly RelationshipId[];
  /** receipts that may match but whose binding or resolution evidence is not here yet */
  readonly pending: readonly EventId[];
  /** two distinct consumers of a one-use invitation: unavailable, and an integrity conflict */
  readonly conflict: boolean;
  /** may be consumed by a relationship that has not: the DID is live and, for one use, nothing consumed it */
  readonly available: boolean;
}

export interface InvitationFold {
  readonly invitations: ReadonlyMap<string, Invitation>;
  /**
   * May a root-address receipt for `relationshipId` proceed under this
   * invitation? When it is available, or that relationship already
   * consumed it; never for another consumer of a consumed one.
   */
  consumable(oobId: string, relationshipId: RelationshipId): boolean;
}

export function foldInvitations(set: VaultEventSet, routes: RouteFold): InvitationFold {
  const byOob = new Map<string, VaultEvent<"did.disclosed">[]>();
  for (const event of set.of("did.disclosed")) {
    if (event.data.oobId === null) continue;
    const group = byOob.get(event.data.oobId);
    if (group === undefined) byOob.set(event.data.oobId, [event]);
    else group.push(event);
  }

  const receipts = new Map<string, { consumers: Set<RelationshipId>; pending: EventId[] }>();
  for (const receipt of set.of("message.in")) {
    const { pthid, relationshipBindingEventId } = receipt.data;
    if (pthid === null || !byOob.has(pthid) || relationshipBindingEventId === null || receipt.data.fromPrior !== null || receipt.data.peerTransitionEventId !== null) continue;
    const entry = receipts.get(pthid) ?? { consumers: new Set<RelationshipId>(), pending: [] };
    receipts.set(pthid, entry);
    const binding = set.resolve(relationshipBindingEventId, "relationship.bound");
    if (binding.status === "missing") {
      entry.pending.push(receipt.eventId);
      continue;
    }
    if (binding.status === "mismatched") continue;
    const { relationshipId, localDidId, peerResolutionEventId } = binding.event.data;
    if (receipt.data.localKeyName !== didKeyName(localDidId, "key-agreement")) continue;
    const resolution = set.resolve(peerResolutionEventId, "peer.resolved");
    if (resolution.status === "missing") {
      entry.pending.push(receipt.eventId);
      continue;
    }
    if (resolution.status === "mismatched" || resolution.event.data.did !== receipt.data.did) continue;
    const disclosedHere = byOob.get(pthid)!.some((disclosure) => disclosure.data.didId === localDidId);
    if (disclosedHere) entry.consumers.add(relationshipId);
  }

  const invitations = new Map<string, Invitation>();
  for (const [oobId, disclosures] of [...byOob].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const didId = disclosures[0]!.data.didId;
    const uses: DisclosureUses = disclosures.some((event) => event.data.uses === "many") ? "many" : "one";
    const receipt = receipts.get(oobId);
    const consumers = [...(receipt?.consumers ?? [])].sort();
    const conflict = uses === "one" && consumers.length > 1;
    const live = routes.dids.get(didId)?.live === true;
    invitations.set(oobId, {
      oobId,
      didId,
      uses,
      goal: disclosures[0]!.data.goal,
      disclosures,
      consumers,
      pending: receipt?.pending ?? [],
      conflict,
      available: live && !conflict && (uses === "many" || consumers.length === 0),
    });
  }

  return {
    invitations,
    consumable(oobId, relationshipId) {
      const invitation = invitations.get(oobId);
      if (invitation === undefined) return false;
      return invitation.available || (invitation.uses === "one" && !invitation.conflict && invitation.consumers.includes(relationshipId));
    },
  };
}
