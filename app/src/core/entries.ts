import type { MessageRecord } from "@estoc/agent-core/v2";

/**
 * A log record as the UI holds it: the record itself, plus the two things
 * every renderer needs and none should work out for itself — whose thread
 * it belongs in, and when it happened. Not a copy of the message and not
 * a reading of it: `record` stays the fact, the rest is its address. What
 * a record looks like on screen is decided per type by a renderer
 * (src/renderers), which gets the entry and nothing else.
 */
export interface Entry {
  /** the log record's mid — the row's identity */
  mid: string;
  /** the wire message id — dedup key and thread reference */
  id: string;
  /** the DIDComm message type URI: which renderer draws it */
  type: string;
  direction: "sent" | "received";
  /**
   * The counterparty's DID as it was on the wire: the proven sender for
   * inbound, the addressee for outbound. Null for an anonymous envelope —
   * the plaintext `from` is unverified, so such a record belongs to nobody
   * and appears in no thread.
   */
  contactDid: string | null;
  /**
   * The contact this belongs to, resolved through the contacts' DID
   * histories — so a thread survives the contact rotating to a new DID.
   * Null when no contact has ever used the DID, or the mail was anonymous.
   */
  contactCid: string | null;
  /** epoch milliseconds */
  time: number;
  record: MessageRecord;
}

export function entryOf(record: MessageRecord, contactCid: string | null): Entry {
  return {
    mid: record.mid,
    id: record.skeleton.wireId,
    type: record.skeleton.msgType,
    direction: record.direction === "in" ? "received" : "sent",
    contactDid: counterpartyOf(record),
    contactCid,
    time: timeOf(record),
    record,
  };
}

/** The proven sender for inbound (the skeleton's, not the plaintext's); the addressee for outbound; anonymous, null. */
export function counterpartyOf(record: MessageRecord): string | null {
  if (record.direction === "in") {
    return record.sender;
  }
  return record.msg?.to?.[0] ?? null;
}

/**
 * When a record happened, in epoch milliseconds. created_time is spec'd
 * in epoch seconds; senders that used milliseconds are tolerated. Outbound
 * records use their own append time.
 */
function timeOf(record: MessageRecord): number {
  const created = record.msg?.created_time;
  if (record.direction === "out" || typeof created !== "number") {
    return Date.parse(record.at);
  }
  return created < 1e12 ? created * 1000 : created;
}
