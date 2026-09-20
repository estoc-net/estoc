import type { Channel, ChannelRecord, Conversation, ConversationChannel, MessageRecord, Snapshot } from "./types.js";

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

function claimedNameOf(channels: readonly ChannelRecord[]): string | null {
  const claims = channels.flatMap((channel) => (channel.peerName === null ? [] : [channel.peerName]));
  return claims.sort((a, b) => (a.messageId < b.messageId ? 1 : -1))[0]?.name ?? null;
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
      diagnostics: [],
    });
  }
  return conversations;
}
