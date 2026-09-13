/**
 * The decisions a contact ID holds on its own: created, named, flagged,
 * pointed at one of our DIDs, given discovery seeds, grouped with
 * another for display, deleted. What a contact holds through its
 * relationships — their scopes, addresses, profiles and messages — is
 * folded where those are.
 */

import type { EventId } from "@estoc/event-store/v3";

import type { ContactId, ContactOrigin, Did, DidId } from "../types.js";
import { groupBy, latest, type VaultEventSet } from "./set.js";

export type PeerDidSeed = { did: Did; because: string; eventId: EventId };

export interface ContactDecisions {
  readonly contactId: ContactId;
  /** the first creation's origin in canonical order, null while none */
  readonly origin: ContactOrigin | null;
  readonly deleted: boolean;
  /** the latest petname, null while none */
  readonly petname: string | null;
  /** each flag's latest value, by flag name */
  readonly flags: ReadonlyMap<string, boolean>;
  /** the latest outbound address preference among our DID entities */
  readonly useDid: { didId: DidId; because: string } | null;
  /** every peer DID added and not removed, in canonical order of the adds */
  readonly peerDidSeeds: readonly PeerDidSeed[];
  /** the other contacts grouped with this one for display, transitively, sorted */
  readonly mergedWith: readonly ContactId[];
  /** removals whose add is not here, or is another contact's or another type's */
  readonly faults: readonly string[];
}

export function foldContacts(set: VaultEventSet): ReadonlyMap<ContactId, ContactDecisions> {
  const created = groupBy(set.of("contact.created"), (event) => event.data.contactId);
  const petnames = groupBy(set.of("contact.petname"), (event) => event.data.contactId);
  const flagged = groupBy(set.of("contact.flag"), (event) => event.data.contactId);
  const useDids = groupBy(set.of("contact.useDid"), (event) => event.data.contactId);
  const added = groupBy(set.of("contact.peerDidAdded"), (event) => event.data.contactId);
  const removed = groupBy(set.of("contact.peerDidRemoved"), (event) => event.data.contactId);
  const deleted = new Set(set.of("contact.deleted").map((event) => event.data.contactId));
  const groups = mergeGroups(set);

  const ids = new Set<ContactId>(deleted);
  for (const table of [created, petnames, flagged, useDids, added, removed]) for (const id of table.keys()) ids.add(id);
  for (const id of groups.keys()) ids.add(id);

  const contacts = new Map<ContactId, ContactDecisions>();
  for (const contactId of [...ids].sort()) {
    const faults: string[] = [];
    const removedAdds = new Set<EventId>();
    for (const removal of removed.get(contactId) ?? []) {
      const add = set.resolve(removal.data.addEventId, "contact.peerDidAdded");
      if (add.status === "missing") faults.push(`removal ${removal.eventId} names an add that is not here`);
      else if (add.status === "mismatched") faults.push(`removal ${removal.eventId} names ${add.event.type} ${add.event.eventId}, not an add`);
      else if (add.event.data.contactId !== contactId) faults.push(`removal ${removal.eventId} names contact ${add.event.data.contactId}'s add`);
      else removedAdds.add(add.event.eventId);
    }
    const flags = new Map<string, boolean>();
    for (const [flag, events] of [...groupBy(flagged.get(contactId) ?? [], (event) => event.data.flag)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      flags.set(flag, latest(events)!.data.value);
    }
    const useDid = latest(useDids.get(contactId) ?? []);
    contacts.set(contactId, {
      contactId,
      origin: created.get(contactId)?.[0]?.data.because ?? null,
      deleted: deleted.has(contactId),
      petname: latest(petnames.get(contactId) ?? [])?.data.name ?? null,
      flags,
      useDid: useDid === null ? null : { didId: useDid.data.didId, because: useDid.data.because },
      peerDidSeeds: (added.get(contactId) ?? []).filter((add) => !removedAdds.has(add.eventId)).map((add) => ({ did: add.data.did, because: add.data.because, eventId: add.eventId })),
      mergedWith: (groups.get(contactId) ?? []).filter((member) => member !== contactId),
      faults,
    });
  }
  return contacts;
}

/** The display groups `contact.merged` draws, each member listed with its whole group sorted. */
function mergeGroups(set: VaultEventSet): Map<ContactId, ContactId[]> {
  const parent = new Map<ContactId, ContactId>();
  const find = (id: ContactId): ContactId => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const event of set.of("contact.merged")) {
    const { contactId, fromContactId } = event.data;
    for (const id of [contactId, fromContactId]) if (!parent.has(id)) parent.set(id, id);
    const [a, b] = [find(contactId), find(fromContactId)];
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const members = new Map<ContactId, ContactId[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = members.get(root);
    if (group === undefined) members.set(root, [id]);
    else group.push(id);
  }
  const groups = new Map<ContactId, ContactId[]>();
  for (const group of members.values()) {
    group.sort();
    for (const id of group) groups.set(id, group);
  }
  return groups;
}
