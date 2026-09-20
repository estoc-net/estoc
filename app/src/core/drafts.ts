import { reactive } from "vue";

import { pairKey, samePair } from "./conversations.js";
import type { Channel, Did, DidId, Snapshot } from "./types.js";

/**
 * What is being written, held by the channel it is to go out in and
 * never by the conversation on screen. How channels are grouped under
 * contacts is display, and can change with an import; who reads a
 * message is decided by the pair it is sealed for. On its own a draft
 * therefore moves only along verified continuity, to the head its
 * channel leads to; to any other channel only when the person hands it
 * there. It is kept even when no conversation shows its channel any
 * more, so that what was written can still be read and dealt with.
 */
export interface Draft {
  channel: Channel;
  text: string;
}

// at most one draft to a pair
const drafts = reactive<Draft[]>([]);

const held = (channel: Channel) => drafts.find((draft) => samePair(draft.channel, channel)) ?? null;

export function draftIn(channel: Channel): Draft | null {
  const draft = held(channel);
  return draft === null || draft.text === "" ? null : draft;
}

export function writtenDrafts(): Draft[] {
  return drafts.filter((draft) => draft.text !== "");
}

export function writeDraft(channel: Channel, text: string): void {
  const draft = held(channel);
  if (draft === null) drafts.push({ channel, text });
  else draft.text = text;
}

// only ever into a channel with nothing written in it: what is left there is an emptied draft
function rehome(draft: Draft, channel: Channel): void {
  const emptied = held(channel);
  if (emptied !== null) drafts.splice(drafts.indexOf(emptied), 1);
  draft.channel = channel;
}

export function dropDrafts(): void {
  drafts.splice(0);
  created.clear();
}

/** Hand what is written in one channel to another the person picked instead, unless something is written there. */
export function moveDraft(from: Channel, to: Channel): void {
  const draft = draftIn(from);
  if (draft !== null && !samePair(from, to) && draftIn(to) === null) rehome(draft, to);
}

// each DID a snapshot has named, under the entity of the vault it was created as
const created = new Map<Did, DidId>();

/**
 * Bring the drafts to a snapshot, before anything shows it.
 *
 * A draft is of the vault that holds the DID it is written as. Which
 * vault a snapshot is of cannot be told from what led up to it: a page
 * cut off from its daemon comes back to whatever vault is there by then,
 * with no word of one forgotten and another made in between. So each
 * snapshot is asked, and a draft written as a DID of no entity of the
 * vault is dropped.
 *
 * It is the entity that is asked for, not the DID. An import can bring a
 * second, different creation of an entity; the vault then names no DID
 * for it and closes its sends, but it is the same vault, and what was
 * being written stays to be read. So a DID is remembered under its
 * entity from when the vault still named it. A lock, a reconnection and
 * a withdrawn selection leave the entities, and the drafts; so does a
 * restore of the same identity from a backup that holds the entity.
 *
 * Then each draft follows its channel to the head it now leads to. One
 * whose channel has no single successor stays where it is, and so does
 * one whose head already has something written in it: two drafts are
 * never made one, and neither is dropped for the other. A draft is the
 * same object wherever it is, so a send begun before a move still clears
 * what it sent and nothing else.
 */
export function carryDrafts({ dids, channels }: Pick<Snapshot, "dids" | "channels">): void {
  const entities = new Set(dids.map(({ didId }) => didId));
  for (const [did, didId] of created) if (!entities.has(didId)) created.delete(did);
  for (const { did, didId } of dids) if (did !== null) created.set(did, didId);
  for (const draft of [...drafts]) if (!created.has(draft.channel.localDid)) drafts.splice(drafts.indexOf(draft), 1);
  const heads = new Map(channels.map(({ channel, head }) => [pairKey(channel), head]));
  for (const draft of writtenDrafts()) {
    const head = heads.get(pairKey(draft.channel)) ?? null;
    if (head !== null && !samePair(head, draft.channel) && draftIn(head) === null) rehome(draft, head);
  }
}
