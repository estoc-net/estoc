import type { Channel, ContactId } from "@estoc/vault/v3";
import type { ChannelRecord, MessageRecord } from "@estoc/agent-core/v3";

export type { Channel, ContactId, Did, DidId, MessageId } from "@estoc/vault/v3";
export type { ChannelRecord, MessageRecord, PendingWork } from "@estoc/agent-core/v3";
export type { Lines, Merged, Phase, Snapshot } from "@estoc/daemon/v3";

/** A channel as a conversation shows it: whether the contact selects it, or it is history reached from one it selects. */
export interface ConversationChannel extends ChannelRecord {
  selected: boolean;
}

/**
 * What the chat pane opens: a contact with every channel it shows, or
 * the channels no contact selects that lead to one head, which are
 * somebody's until they are given a name. The messages stay in the
 * channel they were observed or sent in; a thread is them read together.
 */
export interface Conversation {
  /** stable across snapshots: the contact's ID, or the pair a nameless conversation leads to */
  key: string;
  contactId: ContactId | null;
  petname: string | null;
  /** what the peer last called itself in a channel shown here: a claim, never a name of ours */
  claimedName: string | null;
  channels: ConversationChannel[];
  /** the channels a send may go out in, heads of what is shown */
  writeTo: Channel[];
  /** the one a send goes out in when none is picked; null while there are several and nothing prefers one */
  defaultWriteTo: Channel | null;
  messages: MessageRecord[];
  diagnostics: string[];
}
