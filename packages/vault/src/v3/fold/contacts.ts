/**
 * The contacts: what each contact ID decides on its own. A contact is
 * a display grouping over channels it selects and nothing more — no
 * authority, no identity — so the fold is a table of latest-wins
 * values under one ID: a permanent tombstone, the latest petname, each
 * flag's latest value, the latest local-DID preference, the latest
 * whole channel selection, and the merges that hint at grouping it
 * with others. A selection replaces the whole set, an empty one clears
 * it, and no selection is an empty set; a set for an ID no creation
 * names is kept as it is, presentation being all it affects. What a
 * contact shows through its channels is a view over the other folds,
 * built elsewhere.
 */

import { channelKey } from "../ids.js";
import type { VaultEvent } from "../schema.js";
import type { Channel, ContactId, ContactOrigin, DidId } from "../types.js";
import { groupBy, latest, type VaultEventSet } from "./set.js";

export interface Contact {
  readonly contactId: ContactId;
  /** the first creation's origin in canonical order; null while no creation names the contact */
  readonly origin: ContactOrigin | null;
  readonly deleted: boolean;
  /** the latest petname; null while none */
  readonly petname: string | null;
  /** each flag's latest value */
  readonly flags: ReadonlyMap<string, boolean>;
  /** the latest outbound preference among our DIDs; null while none */
  readonly useDid: { didId: DidId; because: string } | null;
  /** the latest whole selection, in the order it was recorded; empty while none or cleared */
  readonly channels: readonly Channel[];
  /** the contacts a merge hints to group with this one, from either side, in ID order */
  readonly mergedWith: readonly ContactId[];
}

export interface ContactFold {
  /** every contact any contact event names, by ID */
  readonly contacts: ReadonlyMap<ContactId, Contact>;
  /** the undeleted contacts whose selection holds the channel, in ID order */
  selecting(channel: Channel): readonly Contact[];
}

export function foldContacts(set: VaultEventSet): ContactFold {
  const created = groupBy(set.of("contact.created"), (event) => event.data.contactId);
  const deleted = groupBy(set.of("contact.deleted"), (event) => event.data.contactId);
  const petnames = groupBy(set.of("contact.petname"), (event) => event.data.contactId);
  const flags = groupBy(set.of("contact.flag"), (event) => event.data.contactId);
  const preferences = groupBy(set.of("contact.useDid"), (event) => event.data.contactId);
  const selections = groupBy(set.of("contact.channelsSet"), (event) => event.data.contactId);
  const merges = new Map<ContactId, Set<ContactId>>();
  const link = (a: ContactId, b: ContactId) => {
    let others = merges.get(a);
    if (others === undefined) merges.set(a, (others = new Set()));
    others.add(b);
  };
  for (const event of set.of("contact.merged")) {
    link(event.data.contactId, event.data.fromContactId);
    link(event.data.fromContactId, event.data.contactId);
  }

  const ids = new Set<ContactId>([...created.keys(), ...deleted.keys(), ...petnames.keys(), ...flags.keys(), ...preferences.keys(), ...selections.keys(), ...merges.keys()]);
  const contacts = new Map<ContactId, Contact>();
  const byChannel = new Map<string, Contact[]>();
  for (const contactId of [...ids].sort()) {
    const preference = latest(preferences.get(contactId) ?? []);
    const contact: Contact = {
      contactId,
      origin: created.get(contactId)?.[0]?.data.because ?? null,
      deleted: deleted.has(contactId),
      petname: latest(petnames.get(contactId) ?? [])?.data.name ?? null,
      flags: latestFlags(flags.get(contactId) ?? []),
      useDid: preference === null ? null : { didId: preference.data.didId, because: preference.data.because },
      channels: latest(selections.get(contactId) ?? [])?.data.channels ?? [],
      mergedWith: [...(merges.get(contactId) ?? [])].sort(),
    };
    contacts.set(contactId, contact);
    if (contact.deleted) continue;
    for (const channel of contact.channels) {
      const key = channelKey(channel);
      const selecting = byChannel.get(key);
      if (selecting === undefined) byChannel.set(key, [contact]);
      else selecting.push(contact);
    }
  }
  return { contacts, selecting: (channel) => byChannel.get(channelKey(channel)) ?? [] };
}

function latestFlags(events: readonly VaultEvent<"contact.flag">[]): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  for (const [flag, group] of groupBy(events, (event) => event.data.flag)) flags.set(flag, latest(group)!.data.value);
  return flags;
}
