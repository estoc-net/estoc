/**
 * The procedures (vault-events.md §8–§10): what a device appends when a
 * person erases, deletes a contact, or merges — each a set of ordinary
 * events on the stores, decided over the fold, and the fold advanced as
 * they land. Plus the vault's `ImportPolicy` (event-store.md §10.3):
 * held, purged and installed are folds, and this is where the store gets
 * them without reading a type.
 */

import type { BlobStore, Cid, Draft, Event, EventStore, ImportPolicy, JsonObject } from "@estoc/event-store";
import { linksOf } from "@estoc/event-store";

import { drafts } from "./drafts.js";
import { VaultFold, type Message } from "./fold.js";
import type { ChannelFirstSeen, EraseCause, MessageIn, PeerResolved } from "./types.js";

/** The vault's two stores as the procedures need them. */
export interface VaultSide {
  events: EventStore;
  blobs: BlobStore;
}

/** Append and fold in one motion: every procedure's write. */
export async function record<D extends JsonObject>(events: EventStore, fold: VaultFold, draft: Draft<D>): Promise<Event<D>> {
  const event = await events.append(draft);
  fold.apply(event);
  return event;
}

/** The batch of `record`: the drafts land as one write (`appendAll`), all or none, then fold in order. */
export async function recordAll(events: EventStore, fold: VaultFold, batch: Draft<JsonObject>[]): Promise<Event[]> {
  const appended = await events.appendAll(batch);
  for (const event of appended) {
    fold.apply(event);
  }
  return appended;
}

// ---- import policy (event-store.md §10.3) ----------------------------------

/** A fold over `events` alone: for policy questions, where no device is asking. */
const NOBODY = "aaaaaa";

function foldOf(events: Event[]): VaultFold {
  const fold = new VaultFold(NOBODY);
  for (const event of events) {
    fold.apply(event);
  }
  return fold;
}

/** The roots the merged vault set holds (§8.3). */
export function heldRoots(events: Event[]): Cid[] {
  return foldOf(events).held();
}

/** Every root an event of the set references: an extension's, whose erase the vault does not know (§8.3). */
export function allRoots(events: Event[]): Cid[] {
  const roots = new Set<Cid>();
  for (const event of events) {
    for (const root of event.blobs) {
      roots.add(root);
    }
  }
  return [...roots].sort();
}

/**
 * What `importVault` asks and the vault's types answer (event-store.md
 * §10.3): held roots by the erases (vault's set) or whole (an
 * extension's, §8.3), the purged extensions, the installed ones.
 */
export function importPolicy(): ImportPolicy {
  return {
    held: (store, events) => (store === "vault" ? heldRoots(events) : allRoots(events)),
    purged: (events) => foldOf(events).extensions().filter((ext) => ext.purged).map((ext) => ext.ext),
    installed: (events) => foldOf(events).extensions().map((ext) => ext.ext),
  };
}

// ---- observations that check the fold first (§3.1) -------------------------

/** `channel.firstSeen` once per device (§3.1): appended unless `self` has one on this pair already. */
export async function noteFirstSeen(events: EventStore, fold: VaultFold, data: ChannelFirstSeen): Promise<Event | null> {
  if (fold.channel(data)?.seenBy.includes(fold.self) ?? false) {
    return null;
  }
  return record(events, fold, drafts.channelFirstSeen(data));
}

/** `peer.resolved`, written only when it differs from the pair's latest for that DID (§3.1). */
export async function notePeerResolved(events: EventStore, fold: VaultFold, data: PeerResolved): Promise<Event | null> {
  const have = fold.channel(data)?.resolved.find((entry) => entry.did === data.did);
  if (have !== undefined && sameList(have.keys, data.keys) && have.service === (data.service ?? null)) {
    return null;
  }
  return record(events, fold, drafts.peerResolved(data));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// ---- bodies (§4) -----------------------------------------------------------

/**
 * A message, body first (§4): the plaintext into the blob store, then the
 * skeleton naming its root — never the other order. Attachment blobs are
 * the caller's to have put the same way, before this.
 */
export async function recordMessage(
  vault: VaultSide,
  fold: VaultFold,
  direction: "in" | "out",
  plaintext: Uint8Array,
  skeleton: Omit<MessageIn, "body" | "bytes">
): Promise<Event> {
  const body = await vault.blobs.put(plaintext);
  const data = { ...skeleton, bytes: plaintext.length, body };
  return record(vault.events, fold, direction === "in" ? drafts.messageIn(data) : drafts.messageOut(data));
}

// ---- erasing (§8) ----------------------------------------------------------

/**
 * Erase roots of one message (§8.1): the event, appended; collection is a
 * separate step (`collectBlobs`), run whenever. `drop` left out is the
 * whole of it — body and attachments. Roots already erased are not
 * re-dropped; null when nothing is left to drop.
 */
export async function eraseMessage(events: EventStore, fold: VaultFold, mid: string, because: EraseCause, drop?: Cid[]): Promise<Event | null> {
  const message = fold.message(mid);
  if (message === null) {
    throw new Error(`no message ${mid}`);
  }
  const named = drop ?? [message.skeleton.body, ...message.skeleton.attachments];
  const left = [...new Set(named)].filter((root) => !message.erased.includes(root)).sort();
  if (left.length === 0) {
    return null;
  }
  return record(events, fold, drafts.messageErased({ myKey: message.pair.myKey, peerKey: message.pair.peerKey, mid, drop: left, because }));
}

/** `collect` with the fold's keep-set (§8.3): unlink what no held root reaches, grace allowing. */
export async function collectBlobs(blobs: BlobStore, fold: VaultFold): Promise<{ unlinked: Cid[]; young: Cid[] }> {
  return blobs.collect(fold.held());
}

/** How a reader shows a root a line names (§8.2): the erase asked first, the blocks second. */
export type Absence = { state: "erased" } | { state: "present" } | { state: "missing" };

export async function readRoot(blobs: BlobStore, fold: VaultFold, mid: string, root: Cid): Promise<Absence> {
  if (fold.erased(mid, root)) {
    return { state: "erased" };
  }
  const pending = [root];
  const seen = new Set<Cid>();
  while (pending.length > 0) {
    const cid = pending.pop() as Cid;
    if (seen.has(cid)) {
      continue;
    }
    seen.add(cid);
    const bytes = await blobs.getBlock(cid);
    if (bytes === null) {
      return { state: "missing" };
    }
    try {
      pending.push(...linksOf(cid, bytes));
    } catch {
      return { state: "missing" }; // damage is absence to this rule (§8.2)
    }
  }
  return { state: "present" };
}

// ---- deleting a contact (§9) -----------------------------------------------

/**
 * Step 2, on its own and idempotent: for every channel attributed exactly
 * to a deleted contact, erase every message's roots that are not erased
 * yet — what this device sees that the deleting device had not (§9).
 * Returns the erases appended; collection is the caller's next step.
 */
export async function sweepDeleted(events: EventStore, fold: VaultFold): Promise<Event[]> {
  const appended: Event[] = [];
  for (const gone of fold.deletedContacts()) {
    for (const pair of gone.channels) {
      const attribution = fold.attribution(pair);
      if (attribution.kind !== "deleted" || attribution.cids.length !== 1) {
        continue; // in conflict: left until the conflict is resolved (§9)
      }
      for (const mid of fold.channel(pair)?.messages ?? []) {
        const erased = await eraseMessage(events, fold, mid, "contact-deleted");
        if (erased !== null) {
          appended.push(erased);
        }
      }
    }
  }
  return appended;
}

export interface Deleted {
  tombstones: Event[];
  erased: Event[];
  retired: Event[];
  collected: { unlinked: Cid[]; young: Cid[] };
}

/** §9 step 3, idempotent: retire every key of `keyList` that was the contact's alone and that no one else uses. */
async function retireDeleted(events: EventStore, fold: VaultFold, rep: string, keyList: { key: string; because: string }[]): Promise<Event[]> {
  const retired: Event[] = [];
  for (const entry of keyList) {
    const key = fold.myKey(entry.key);
    if (key === null || key.retired !== null) {
      continue;
    }
    const oneUse = key.published.some((published) => published.uses === "one");
    if (!oneUse && entry.because !== "minted") {
      continue; // not this contact's alone by minting or invitation (§9 step 3)
    }
    if (key.usedBy.some((user) => user !== rep)) {
      continue; // another contact still uses it
    }
    retired.push(await record(events, fold, drafts.didRetired({ key: entry.key, because: "contact-deleted" })));
  }
  return retired;
}

/**
 * Delete a contact (§9): a tombstone per member, the erases over its
 * channels, `did.retired` for every key minted toward it alone, and a
 * collection. No event is removed. Interrupted after the tombstones, a
 * second call finishes: the sweep, the retirements, the collection —
 * and never widens to a member merged in after the tombstone (§9).
 */
export async function deleteContact(vault: VaultSide, fold: VaultFold, cid: string): Promise<Deleted> {
  const gone = fold.deletedContacts().find((entry) => entry.cid === cid || entry.members.includes(cid));
  if (gone !== undefined) {
    // `cid` is tombstoned already — an interrupted first call, or a retry after a late merge hung it
    // on a live contact. Finish its own group and touch nothing live: the tombstone covers only what
    // it names (§9 step 1), so the live representative is not this deletion's to widen into.
    const erased = await sweepDeleted(vault.events, fold);
    const retired = await retireDeleted(vault.events, fold, gone.cid, gone.keys);
    return { tombstones: [], erased, retired, collected: await collectBlobs(vault.blobs, fold) };
  }
  const contact = fold.contact(cid);
  if (contact === null) {
    throw new Error(`no contact ${cid}`);
  }
  // a late merge can hang tombstoned members on a live contact: their keys are still §9's to retire
  const hiddenKeys = fold.deletedContacts().filter((entry) => entry.members.some((member) => contact.hidden.includes(member))).flatMap((entry) => entry.keys);
  const keys = [...new Map([...hiddenKeys, ...contact.keys].map((entry) => [entry.key, entry] as const)).values()];
  // one write (`appendAll`): a crash leaves every member tombstoned or none — §9 step 1 cannot half-land
  const tombstones = await recordAll(
    vault.events,
    fold,
    contact.members.map((member) => drafts.contactDeleted({ cid: member }))
  );
  const erased = await sweepDeleted(vault.events, fold);
  const retired = await retireDeleted(vault.events, fold, contact.cid, keys);
  const collected = await collectBlobs(vault.blobs, fold);
  return { tombstones, erased, retired, collected };
}

// ---- merge (§10) -----------------------------------------------------------

/**
 * Held after merge (§10): one `delivery.held { imported }` from `self`
 * for every other device's `message.out` that is not sent and that
 * `self` has not held before. Run after an import or a restore;
 * importing the same backup twice appends nothing.
 */
export async function holdImported(events: EventStore, fold: VaultFold): Promise<Event[]> {
  const appended: Event[] = [];
  for (const message of fold.messages()) {
    if (message.direction !== "out" || message.author === fold.self) {
      continue;
    }
    const delivery = message.delivery as NonNullable<Message["delivery"]>;
    if (delivery.status === "sent" || delivery.heldBy.some((held) => held.dev === fold.self)) {
      continue;
    }
    appended.push(await record(events, fold, drafts.deliveryHeld({ myKey: message.pair.myKey, peerKey: message.pair.peerKey, mid: message.mid, because: "imported" })));
  }
  return appended;
}
