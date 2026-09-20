import type { Channel, ChannelRecord, Conversation, ConversationChannel, MessageRecord, Snapshot, UnplacedInput } from "./types.js";

export function pairKey(channel: Channel): string {
  return JSON.stringify([channel.localDid, channel.peerDid]);
}

export function samePair(a: Channel, b: Channel): boolean {
  return a.localDid === b.localDid && a.peerDid === b.peerDid;
}

/** One thread of several channels: each message once, in the order this vault first recorded them. */
function threadOf(channels: readonly ChannelRecord[]): MessageRecord[] {
  const messages = new Map<string, MessageRecord>();
  for (const channel of channels) for (const message of channel.messages) messages.set(message.messageId, message);
  return [...messages.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * The name claimed last across the channels: by when this vault recorded
 * the input that claimed it. A message ID is derived from the pair and
 * says nothing of order; it only settles two claims recorded at once.
 */
function unplacedOf(channels: readonly ChannelRecord[]): UnplacedInput[] {
  const inputs = new Map<string, UnplacedInput>();
  for (const channel of channels) for (const input of channel.unplaced) inputs.set(input.sourceEventId, input);
  return [...inputs.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function claimedNameOf(channels: readonly ChannelRecord[]): string | null {
  const claims = channels.flatMap(({ peerName, messages }) => {
    if (peerName === null) return [];
    return [{ ...peerName, at: messages.find((message) => message.messageId === peerName.messageId)?.at ?? "" }];
  });
  claims.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.messageId < b.messageId ? 1 : -1));
  return claims[0]?.name ?? null;
}

/**
 * The conversation that now shows channels another one showed: the same
 * conversation under the key it moved to when its head did or it was
 * given a name. None while several conversations show them, which only
 * the person can tell apart.
 */
export function successorOf(pairs: ReadonlySet<string>, conversations: readonly Conversation[]): Conversation | null {
  const heirs = conversations.filter(({ channels }) => channels.some(({ channel }) => pairs.has(pairKey(channel))));
  return heirs.length === 1 ? heirs[0]! : null;
}

export function conversationsOf(snapshot: Snapshot): Conversation[] {
  const records = new Map(snapshot.channels.map((record) => [pairKey(record.channel), record]));
  const claimed = new Set<string>();
  const conversations: Conversation[] = [];

  for (const contact of snapshot.contacts) {
    const channels: ConversationChannel[] = [];
    for (const { channel, selected } of contact.channels) {
      const record = records.get(pairKey(channel));
      if (record === undefined) continue;
      claimed.add(pairKey(channel));
      channels.push({ ...record, selected });
    }
    conversations.push({
      key: contact.contacts.map(({ contactId }) => contactId).join("+"),
      contactId: contact.contacts.find(({ deleted }) => !deleted)?.contactId ?? null,
      petname: contact.petname,
      claimedName: claimedNameOf(channels),
      channels,
      writeTo: contact.writeTo,
      defaultWriteTo: contact.defaultWriteTo,
      messages: threadOf(channels),
      unplaced: unplacedOf(channels),
      diagnostics: contact.diagnostics,
    });
  }

  const nameless = new Map<string, ConversationChannel[]>();
  for (const record of snapshot.channels) {
    if (claimed.has(pairKey(record.channel))) continue;
    const key = pairKey(record.head ?? record.channel);
    nameless.set(key, [...(nameless.get(key) ?? []), { ...record, selected: false }]);
  }
  for (const [key, channels] of nameless) {
    const head = channels.find((record) => pairKey(record.channel) === key);
    const open = head !== undefined && head.send.status === "open" ? [head.channel] : [];
    conversations.push({
      key,
      contactId: null,
      petname: null,
      claimedName: claimedNameOf(channels),
      channels,
      writeTo: open,
      defaultWriteTo: open[0] ?? null,
      messages: threadOf(channels),
      unplaced: unplacedOf(channels),
      diagnostics: [],
    });
  }
  return conversations;
}
