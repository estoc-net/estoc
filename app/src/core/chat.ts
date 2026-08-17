import { BASIC_MESSAGE, PROFILE, type MessageRecord } from "@estoc/agent-core";

/**
 * The chat projection of a log record: what a thread view renders. Only
 * basicmessage/2.0 and user-profile/1.0 profile messages project; the
 * mediator's coordination traffic, anything unknown, and inbound mail the
 * envelope did not attribute to anyone yield null.
 * A projection, not a copy — the log record in the vault stays the fact.
 * This lives in the app, not agent-core: the library hands out records
 * and the contact they belong to; how they look on screen is ours.
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
  /**
   * The contact this belongs to, resolved through the contacts' DID
   * histories — so a thread survives the contact rotating to a new DID.
   * Absent when no contact has ever used the DID.
   */
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
