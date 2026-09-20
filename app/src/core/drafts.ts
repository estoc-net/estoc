import { reactive } from "vue";

import { pairKey } from "./conversations.js";
import type { ChannelRecord } from "./types.js";

/**
 * What is being written, held by the channel it is to go out in and
 * never by the conversation on screen. How channels are grouped under
 * contacts is display, and can change with an import; who reads a
 * message is decided by the pair it is sealed for. A draft therefore
 * moves only along verified continuity, to the head its channel leads
 * to, and shows again wherever that channel is the one written in.
 */
export interface Draft {
  pair: string;
  text: string;
}

// at most one draft to a pair
const drafts = reactive<Draft[]>([]);

const held = (pair: string) => drafts.find((draft) => draft.pair === pair) ?? null;

export function draftIn(pair: string): Draft | null {
  const draft = held(pair);
  return draft === null || draft.text === "" ? null : draft;
}

export function writeDraft(pair: string, text: string): void {
  const draft = held(pair);
  if (draft === null) drafts.push({ pair, text });
  else draft.text = text;
}

function rehome(draft: Draft, pair: string): void {
  const there = held(pair);
  if (there !== null) drafts.splice(drafts.indexOf(there), 1);
  draft.pair = pair;
}

/** Hand what is written in one channel to another the person picked instead, unless something is written there. */
export function moveDraft(from: string, to: string): void {
  const draft = draftIn(from);
  if (draft !== null && from !== to && draftIn(to) === null) rehome(draft, to);
}

/**
 * Follow each draft to the head its channel now leads to. One whose
 * channel has no single successor stays where it is. A draft keeps its
 * identity as it moves, so a send begun before the move still clears it.
 */
export function carryDrafts(channels: readonly ChannelRecord[]): void {
  const heads = new Map(channels.map(({ channel, head }) => [pairKey(channel), head === null ? null : pairKey(head)]));
  for (const draft of [...drafts]) {
    const head = heads.get(draft.pair) ?? null;
    if (head === null || head === draft.pair || draft.text === "") continue;
    const there = draftIn(head);
    if (there === null) rehome(draft, head);
    else {
      there.text = `${draft.text} ${there.text}`;
      drafts.splice(drafts.indexOf(draft), 1);
    }
  }
}
