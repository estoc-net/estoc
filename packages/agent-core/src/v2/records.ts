/**
 * The records: what the agent hands its callers, each a reading of the
 * fold and nothing a file. A message with its plaintext read back from
 * the blob store (vault-events.md §4, §8.2), a contact with the name it
 * is shown by, an invitation with the flags a list of them asks for.
 * The fold's `Delivery` is handed over as it is.
 */

import type { BlobStore } from "@estoc/event-store";
import { readRoot, type Absence, type ChannelKey, type Contact, type Invitation, type Message, type MessageIn, type MessageOut, type VaultFold } from "@estoc/vault/v2";

/** A DIDComm plaintext message as JSON: what didcomm-rust's as_value() yields. */
export interface PlainMessage {
  id: string;
  typ?: string;
  type: string;
  from?: string;
  to?: string[];
  thid?: string;
  pthid?: string;
  created_time?: number;
  expires_time?: number;
  body: Record<string, unknown>;
  attachments?: unknown[];
  from_prior?: string;
  [extra: string]: unknown;
}

// ---- messages --------------------------------------------------------------

/** How the body stands (§8.2): the erase asked first, the blocks second; bytes that are not a plaintext message count as missing. */
export type BodyState = Absence["state"];

export interface MessageRecord {
  /** the local primary key, uuidv7 */
  mid: string;
  /** when the skeleton was appended, by the appending device's clock */
  at: string;
  direction: "in" | "out";
  pair: ChannelKey;
  /**
   * Inbound: the DID the peer key wore at the message — the pair's latest
   * `peer.resolved` at or before it, else the DID it was first seen with,
   * else null (anonymous). Outbound: null; the addressee is `msg.to[0]`.
   */
  sender: string | null;
  skeleton: MessageIn | MessageOut;
  /** the plaintext, when the body is present */
  msg: PlainMessage | null;
  body: BodyState;
}

/** The message as a caller reads it, or null for a mid the fold has no skeleton for. */
export async function messageRecord(fold: VaultFold, blobs: BlobStore, mid: string): Promise<MessageRecord | null> {
  const message = fold.message(mid);
  if (message === null) {
    return null;
  }
  const { state } = await readRoot(blobs, fold, mid, message.skeleton.body);
  const msg = state === "present" ? await plaintextOf(blobs, message) : null;
  return {
    mid: message.mid,
    at: message.at,
    direction: message.direction,
    pair: message.pair,
    sender: senderOf(fold, message),
    skeleton: message.skeleton,
    msg,
    body: msg === null && state === "present" ? "missing" : state,
  };
}

async function plaintextOf(blobs: BlobStore, message: Message): Promise<PlainMessage | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await blobs.get(message.skeleton.body);
  } catch {
    return null; // a root that is not a file: damage, absence to §8.2
  }
  if (bytes === null) {
    return null; // collected between the two reads
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isPlainMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainMessage(value: unknown): value is PlainMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  return typeof msg["id"] === "string" && typeof msg["type"] === "string" && typeof msg["body"] === "object" && msg["body"] !== null && !Array.isArray(msg["body"]);
}

function senderOf(fold: VaultFold, message: Message): string | null {
  if (message.direction === "out") {
    return null;
  }
  const channel = fold.channel(message.pair);
  if (channel === null) {
    return null;
  }
  // the latest resolution at or before the message: a later one is a rotation the message predates
  let latest: { did: string; at: string } | null = null;
  for (const entry of channel.resolved) {
    if (entry.at <= message.at && (latest === null || entry.at > latest.at || (entry.at === latest.at && entry.did > latest.did))) {
      latest = entry;
    }
  }
  return latest?.did ?? channel.firstSeen?.firstDid ?? null;
}

// ---- contacts --------------------------------------------------------------

/** The contact as the fold has it, its thread left to `messageRecord`, and a name to show. */
export type ContactRecord = Omit<Contact, "thread"> & { name: string };

export function contactRecord(contact: Contact): ContactRecord {
  const { thread, ...rest } = contact;
  return { ...rest, name: nameOf(contact) };
}

/** What a contact is shown by: the petname, else what they claimed, else a stand-in for their current DID, else for the cid. */
export function nameOf(contact: Contact): string {
  return contact.petname ?? contact.claimedName ?? didPlaceholder(contact.currentDids.at(-1) ?? contact.cid);
}

/** The stand-in a contact carries until something names it. */
export function didPlaceholder(did: string): string {
  return did.length <= 30 ? did : `${did.slice(0, 20)}…${did.slice(-6)}`;
}

// ---- invitations -----------------------------------------------------------

export type InvitationRecord = Invitation & {
  /** the out-of-band message id, what an answer names as `pthid`; the key's name when the publish carried none */
  id: string;
  /** whether this device's mediator accepted the DID as a recipient */
  registered: boolean;
  /** whether the key is retired: nothing arriving on it is read */
  retired: boolean;
};

export function invitationRecord(fold: VaultFold, invitation: Invitation): InvitationRecord {
  const key = fold.myKey(invitation.key);
  return {
    ...invitation,
    id: invitation.oobId ?? invitation.key,
    registered: key?.registered.includes(fold.self) ?? false,
    retired: key !== null && key.retired !== null,
  };
}
