import { reactive } from "vue";

import { pairKey, samePair } from "./conversations.js";
import type { Channel, ChannelRecord } from "./types.js";

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

/**
 * Drafts are of one vault. They outlive a lock, which leaves the vault
 * where it is, and nothing else: whoever has this page after the vault
 * is gone is not to read what was being written in it.
 */
export function dropDrafts(): void {
  drafts.splice(0);
}

/** Hand what is written in one channel to another the person picked instead, unless something is written there. */
export function moveDraft(from: Channel, to: Channel): void {
  const draft = draftIn(from);
  if (draft !== null && !samePair(from, to) && draftIn(to) === null) rehome(draft, to);
}

/**
 * Follow each draft to the head its channel now leads to. One whose
 * channel has no single successor stays where it is, and so does one
 * whose head already has something written in it: two drafts are never
 * made one, and neither is dropped for the other. A draft is the same
 * object wherever it is, so a send begun before a move still clears
 * what it sent and nothing else.
 */
export function carryDrafts(channels: readonly ChannelRecord[]): void {
  const heads = new Map(channels.map(({ channel, head }) => [pairKey(channel), head]));
  for (const draft of writtenDrafts()) {
    const head = heads.get(pairKey(draft.channel)) ?? null;
    if (head !== null && !samePair(head, draft.channel) && draftIn(head) === null) rehome(draft, head);
  }
}
