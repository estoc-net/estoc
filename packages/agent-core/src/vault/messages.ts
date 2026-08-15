import { v7 as uuidv7 } from "uuid";

import type { VaultBackend } from "../backend/types.js";
import { FIRST_SEGMENT, MESSAGES_DIR, text, utf8 } from "./layout.js";

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
 * Writers append to one segment; readers concatenate every `*.jsonl` in
 * name order — so a merge (importing another copy of the vault) is just
 * dropping its segments in beside ours.
 */

/**
 * One captured layer of a message's envelope onion — the see-through
 * messenger's whole point. `payload` is the exact wire object, pretty
 * printed; `visibleTo` names who could read this layer.
 */
export interface EnvelopeLayer {
  kind: "plaintext" | "authcrypt" | "anoncrypt" | "forward";
  title: string;
  payload: string;
  visibleTo: string;
  note: string;
}

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
  layers?: EnvelopeLayer[];
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

export class MessageLog {
  constructor(
    private readonly backend: VaultBackend,
    private readonly segment: string = FIRST_SEGMENT
  ) {}

  async append(record: MessageRecord): Promise<void> {
    await this.backend.append(
      `${MESSAGES_DIR}/${this.segment}`,
      utf8(JSON.stringify(record) + "\n")
    );
  }

  /**
   * Every record across every segment, in segment order then line order.
   * A truncated final line (a crash mid-append) is skipped; a bad line
   * anywhere else is corruption and throws.
   */
  async read(): Promise<MessageRecord[]> {
    const segments = (await this.backend.list(MESSAGES_DIR))
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    const records: MessageRecord[] = [];
    for (const segment of segments) {
      const bytes = await this.backend.read(`${MESSAGES_DIR}/${segment}`);
      if (bytes === null) {
        continue;
      }
      const lines = text(bytes).split("\n");
      // Every element but the last was terminated by "\n"; the last is ""
      // when the file ended cleanly, otherwise a partial line.
      const tail = lines.pop() as string;
      lines.forEach((line, i) => {
        if (line !== "") {
          records.push(parseLine(line, `${segment}:${i + 1}`));
        }
      });
      if (tail !== "") {
        try {
          records.push(parseLine(tail, `${segment}:${lines.length + 1}`));
        } catch {
          // a partial last line: the append was cut short; the next
          // pickup redelivers, and dedup on msg.id absorbs it
        }
      }
    }
    return records;
  }
}
