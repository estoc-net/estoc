/**
 * Whether a channel takes new work now, decided once for every path to
 * the wire — a user send, an automatic reply, a package, a transport
 * call first or retried — whatever the caller. A channel takes none
 * when its local DID cannot send, the pair is denied, its continuity
 * is in conflict, the peer has replaced its DID in that context, or
 * the local DID has been replaced here by a successor, or by a
 * decision still waiting for its evidence. A message a replacement
 * caught queued or prepared keeps its intent, its package and whatever
 * call was made before, and is carried by nothing after.
 */

import type { Continuity } from "./fold/continuity.js";
import type { DidFold } from "./fold/dids.js";
import { sameChannel } from "./ids.js";
import type { Channel } from "./types.js";

export type SendGate = { status: "open" } | { status: "closed"; because: string };

export function senderGate(fold: { readonly dids: DidFold; readonly continuity: Continuity }, channel: Channel): SendGate {
  const didId = fold.dids.entityOfDid(channel.localDid);
  const entity = didId === null ? undefined : fold.dids.entities.get(didId);
  if (entity === undefined) return { status: "closed", because: "the local DID is not one of ours" };
  if (!entity.live) return { status: "closed", because: `the local DID cannot send: ${entity.faults[0] ?? `retired: ${entity.retired}`}` };
  const denied = channelPolicy(fold, channel);
  if (denied !== null) return { status: "closed", because: denied };
  const head = fold.continuity.head(channel);
  if (head === null || fold.continuity.decisionsIn(channel).some((decision) => decision.status.status === "pending")) return { status: "closed", because: "a rotation of the local DID here waits for its evidence" };
  if (!sameChannel(head, channel)) return { status: "closed", because: `the local DID is replaced here by ${head.localDid}` };
  return { status: "open" };
}

/** What current policy holds against the pair itself, whatever its local DID's state: denied, in conflict, or its peer replaced; null when nothing. */
export function channelPolicy(fold: { readonly continuity: Continuity }, channel: Channel): string | null {
  if (fold.continuity.blocked(channel).length > 0) return "the channel is denied";
  if (fold.continuity.conflicted(channel)) return "the channel's continuity is in conflict";
  if (fold.continuity.superseded(channel)) return "the peer has replaced its DID";
  return null;
}
