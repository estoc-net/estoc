import { v7 as uuidv7 } from "uuid";

import type { VaultBackend } from "./backend/types.js";
import { MESSAGES_DIR } from "./layout.js";
import { SegmentedLog, parseSegment as parseLog, type DamagedLine } from "./log.js";

export type { DamagedLine } from "./log.js";

/**
 * The message log: append-only JSONL, one event per line, `mid` (uuidv7,
 * assigned at append) as the local primary key. The wire `msg.id` is the
 * sender's claim — a dedup key and thread reference, never a storage
 * identity. `msg` is the unpacked plaintext exactly as it arrived or left,
 * so every protocol field stays available to later readers.
 *
 * The log encodes facts, not interpretations: whose message it is (which
 * contact) is resolved at read time through the contacts' DID histories,
 * which is what lets a contact's rotation, merge, or re-creation re-home
 * old messages without rewriting a line.
 *
 * Writers append to one segment; readers concatenate every `<uuidv7>.jsonl` in
 * name order — so a merge (importing another copy of the vault) is just
 * dropping its segments in beside ours (see `SegmentedLog`).
 */

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

export interface MessageRecord {
  /** local primary key, uuidv7, assigned when the line was written */
  mid: string;
  /** ISO time of the append */
  at: string;
  direction: "in" | "out";
  /**
   * For inbound mail, the DID the envelope actually proves sent it (the
   * authcrypt key's DID) — didcomm-rust does not compare it with the
   * plaintext's `from`, so attribution keys off this. Null when the
   * envelope was anonymous.
   */
  sender?: string | null;
  msg: PlainMessage;
}

export function newMessageRecord(
  fields: Omit<MessageRecord, "mid" | "at">,
  now = new Date()
): MessageRecord {
  return {
    mid: uuidv7({ msecs: now.getTime() }),
    at: now.toISOString(),
    ...fields,
  };
}

/**
 * The DID on the other side of a record: for inbound mail the DID the
 * envelope proved sent it, for outbound the addressee. Null for an
 * anonymous inbound envelope — the plaintext `from` is unverified and is
 * never used for attribution, so such a record belongs to nobody.
 */
export function counterpartyOf(record: MessageRecord): string | null {
  if (record.direction === "in") {
    return record.sender ?? null;
  }
  return record.msg.to?.[0] ?? null;
}

function parseLine(line: string, where: string): MessageRecord {
  const record = JSON.parse(line) as Partial<MessageRecord>;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.mid !== "string" ||
    typeof record.at !== "string" ||
    (record.direction !== "in" && record.direction !== "out") ||
    typeof record.msg !== "object" ||
    record.msg === null ||
    typeof record.msg.id !== "string" ||
    typeof record.msg.type !== "string"
  ) {
    throw new Error(`${where} is not a message record`);
  }
  return record as MessageRecord;
}

export class MessageLog extends SegmentedLog<MessageRecord> {
  constructor(backend: VaultBackend) {
    super(backend, MESSAGES_DIR, parseLine);
  }
}

/**
 * The message records in one segment's text — shared with vault import,
 * which reads segments that are not (yet) in any backend.
 */
export function parseSegment(
  content: string,
  segment: string,
  onDamaged?: (damaged: DamagedLine) => void
): MessageRecord[] {
  return parseLog(content, segment, parseLine, onDamaged);
}
