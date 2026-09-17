/**
 * What the vault must keep: every root an accepted event retains,
 * except what a message's erasure released from that message's events.
 * Erasure is the one release; a prepared envelope is held until its
 * message erases it, since no delivery-completion evidence is verified
 * here and a package must not be released on a guess.
 * An event of a type this version does not name, or one whose payload
 * does not read, holds every root it names, and so does every event
 * that is not a message's: a peer document stays as long as the
 * resolution that pinned it. Reading a root asks the same question
 * from the other side: erased before absent, so that missing bytes
 * never read as a deletion.
 */

import type { Retained } from "@estoc/event-store/v3";

import type { Cid, EventId, MessageId } from "../types.js";
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
 * The retention the event set holds, edge by edge: each accepted event
 * with each root of its that it still retains. A message's event — a
 * `message.out`, a `message.in`, a `message.prepared` — retains what its
 * message's erasures did not release; every other event every root it
 * names. In event order, then by root.
 */
export function retainedRoots(set: VaultEventSet, erasures: Erasures = foldErasures(set)): Retained[] {
  const retained: Retained[] = [];
  const retain = (eventId: EventId, root: Cid) => retained.push({ eventId, root });
  for (const event of set.unapplied()) for (const root of event.roots) retain(event.eventId, root);
  for (const event of set.applied()) {
    if (event.type === "message.out" || event.type === "message.in" || event.type === "message.prepared") {
      for (const root of event.roots) if (!erased(erasures, event.data.messageId, root)) retain(event.eventId, root);
    } else for (const root of event.roots) retain(event.eventId, root);
  }
  return retained.sort((a, b) => cmp(a.eventId, b.eventId) || cmp(a.root, b.root));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every root the event set holds: what collection must keep. */
export function heldRoots(set: VaultEventSet, erasures: Erasures = foldErasures(set)): Set<Cid> {
  const held = new Set<Cid>();
  for (const { root } of retainedRoots(set, erasures)) held.add(root);
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
