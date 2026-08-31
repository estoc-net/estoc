import type { MessageRecord } from "@estoc/vault";

import { BASIC_MESSAGE, PROFILE, type Agent } from "../src/index.js";

/**
 * A chat projection of the log for the tests — the shape the app renders
 * (its own copy lives in app/src/core/chat.ts). Not part of agent-core:
 * the library hands out records and the contact they belong to; what a
 * record looks like on screen is the application's business.
 */
export interface ChatMessage {
  /** the log record's mid */
  mid: string;
  /** the wire message id — dedup key and thread reference */
  id: string;
  kind: "chat" | "profile";
  direction: "sent" | "received";
  /** the counterparty's DID as it was on the wire: the proven sender for inbound, the addressee for outbound */
  contactDid: string;
  /** the contact this belongs to, resolved through the contacts' DID histories */
  contactCid?: string;
  content: string;
  /** epoch milliseconds */
  time: number;
}

export function chatView(record: MessageRecord): ChatMessage | null {
  const { msg } = record;
  if (msg.type !== BASIC_MESSAGE && msg.type !== PROFILE) {
    return null;
  }
  // An inbound record without a proven sender belongs to no thread: the
  // plaintext `from` is unverified and an anonymous envelope could carry
  // anyone's DID there. The record stays in the log; the chat does not
  // show it.
  if (record.direction === "in" && (record.sender ?? null) === null) {
    return null;
  }
  const contactDid =
    record.direction === "in"
      ? (record.sender as string)
      : (msg.to?.[0] ?? "unknown");
  const body = msg.body as {
    content?: unknown;
    profile?: { displayName?: unknown };
  };
  const content =
    msg.type === PROFILE
      ? typeof body.profile?.displayName === "string"
        ? body.profile.displayName
        : ""
      : String(body.content ?? "");
  return {
    mid: record.mid,
    id: msg.id,
    kind: msg.type === PROFILE ? "profile" : "chat",
    direction: record.direction === "in" ? "received" : "sent",
    contactDid,
    content,
    // created_time is spec'd in epoch seconds; tolerate senders that used
    // milliseconds. Outbound records use their own append time.
    time:
      record.direction === "out" || typeof msg.created_time !== "number"
        ? Date.parse(record.at)
        : msg.created_time < 1e12
          ? msg.created_time * 1000
          : msg.created_time,
  };
}

/** Every chat-visible record in log order, homed to its contact through the DID histories. */
export async function history(agent: Agent): Promise<ChatMessage[]> {
  const cidOf = new Map<string, string>();
  for (const contact of await agent.vault.contacts.all()) {
    for (const use of contact.dids) {
      cidOf.set(use.did, contact.cid);
    }
  }
  const views: ChatMessage[] = [];
  for (const record of await agent.vault.messages.read()) {
    const view = chatView(record);
    if (view !== null) {
      const cid = cidOf.get(view.contactDid);
      views.push(cid === undefined ? view : { ...view, contactCid: cid });
    }
  }
  return views;
}
