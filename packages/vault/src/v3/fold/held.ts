/**
 * What the vault must keep: every root an accepted event retains,
 * except what a message's erasure released from that message's events
 * and a prepared envelope whose message is closed. Erasure is the one
 * explicit release; submission and termination are the others, read
 * from the outbound fold, and submission counts only once the message
 * is verified, since contested or missing evidence releases nothing.
 * An event of a type this version does not name, or one whose payload
 * does not read, holds every root it names, and so does every event
 * that is not a message's: a peer document stays as long as the
 * resolution that pinned it. Reading a root asks the same question
 * from the other side: erased before absent, so that missing bytes
 * never read as a deletion.
 */

import type { Cid, MessageId } from "../types.js";
import type { Outbound, OutboundFold, Package } from "./outbound.js";
import type { VaultEventSet } from "./set.js";

/** The roots each message's erasures released, by message ID. */
export type Erasures = ReadonlyMap<MessageId, ReadonlySet<Cid>>;

export function foldErasures(set: VaultEventSet): Erasures {
  const erasures = new Map<MessageId, Set<Cid>>();
  for (const event of set.of("message.erased")) {
    const roots = erasures.get(event.data.messageId);
    if (roots === undefined) erasures.set(event.data.messageId, new Set(event.data.dropCids));
    else for (const cid of event.data.dropCids) roots.add(cid);
  }
  return erasures;
}

export function erased(erasures: Erasures, messageId: MessageId, root: Cid): boolean {
  return erasures.get(messageId)?.has(root) ?? false;
}

/**
 * Whether a package's envelope is still held for its message: not
 * erased from it, the message neither submitted nor failed, the
 * package neither retired nor failed. Nothing else releases it, an
 * acknowledgment or an unreachable route included.
 */
export function retainEnvelope(outbound: Outbound, pkg: Package, erasures: Erasures): boolean {
  return !erased(erasures, outbound.messageId, pkg.data.envelopeCid) && !outbound.submitted && pkg.retired === null && pkg.failed === null && outbound.failed === null;
}

/** Every root the event set holds: what collection must keep. */
export function heldRoots(set: VaultEventSet, outbound: OutboundFold, erasures: Erasures = foldErasures(set)): Set<Cid> {
  const held = new Set<Cid>();
  for (const event of set.unapplied()) for (const root of event.roots) held.add(root);
  for (const event of set.applied()) {
    if (event.type === "message.out" || event.type === "message.in") {
      for (const root of event.roots) if (!erased(erasures, event.data.messageId, root)) held.add(root);
    } else if (event.type === "message.prepared") {
      const { messageId, packageId, envelopeCid } = event.data;
      const message = outbound.outbounds.get(messageId);
      const pkg = message?.packages.get(packageId);
      const retained = message !== undefined && pkg !== undefined && pkg.eventIds.includes(event.eventId as Package["eventIds"][number]) ? retainEnvelope(message, pkg, erasures) : !erased(erasures, messageId, envelopeCid);
      if (retained) held.add(envelopeCid);
    } else for (const root of event.roots) held.add(root);
  }
  return held;
}

/**
 * What a message root reads as: erased when an erasure of the message
 * names it, whatever bytes remain; available when its object is here;
 * not yet fetched when the view permits partial presence; missing
 * otherwise.
 */
export type ReadState = "erased" | "available" | "not-yet-fetched" | "missing";

export function readState(erasures: Erasures, messageId: MessageId, root: Cid, present: boolean, partialPermitted = false): ReadState {
  if (erased(erasures, messageId, root)) return "erased";
  if (present) return "available";
  return partialPermitted ? "not-yet-fetched" : "missing";
}
