/**
 * The lines of a segment (vault-folder.md §2, §6, §8, §11.5). A complete
 * line, its LF excluded, is exactly `canonicalEventBytes(event)` (VF-9):
 * anything else — a trailing fragment, bad UTF-8, bad JSON, a
 * non-canonical spelling, a bad envelope, an author the path does not
 * confirm (VF-2) — is damage, reported by position and never fused with
 * the line after it (VF-10). What a line decodes to is what its bytes
 * parse to, and nothing is recovered from the path: the path confirms
 * authorship, it never supplies it (§6).
 */

import { InvalidEvent } from "../errors.js";
import { canonicalEventBytes, validateEvent, type Damaged, type Event } from "../event.js";
import { canonicalText, parseStrict } from "../jcs.js";
import { concat, utf8 } from "./layout.js";

const LF = 0x0a;

/** One line's bytes and where it sits: 1-based number, byte range `[start, end)` excluding the LF; `whole` is false for the unterminated tail. */
export interface Line {
  n: number;
  start: number;
  end: number;
  whole: boolean;
}

/** The lines of a segment's bytes, in order; a trailing fragment is the last, `whole: false`. */
export function splitLines(bytes: Uint8Array): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF) {
      lines.push({ n: lines.length + 1, start, end: i, whole: true });
      start = i + 1;
    }
  }
  if (start < bytes.length) lines.push({ n: lines.length + 1, start, end: bytes.length, whole: false });
  return lines;
}

/** The byte length of a segment's complete lines (§10.3): the offset after its last LF, 0 when it has none. */
export function acceptedLength(bytes: Uint8Array): number {
  return bytes.lastIndexOf(LF) + 1;
}

/** Whether a segment's bytes end where a writer may append (§8.1): empty, or terminated. */
export function endsClean(bytes: Uint8Array): boolean {
  return bytes.length === 0 || bytes[bytes.length - 1] === LF;
}

/** One event as a segment holds it: the event its canonical bytes parse to, and that canonical text. */
export interface Decoded {
  event: Event;
  text: string;
}

/**
 * The event one complete line holds (§6, §11.5): UTF-8, JSON, a valid
 * envelope, spelled canonically, and authored by `author` — the
 * directory's. The bytes go to the parser as bytes and are compared as
 * bytes: a byte order mark, which a text decoder would drop, is three
 * bytes the canonical form does not have. Throws `InvalidJson`
 * or `InvalidEvent` naming the first rule broken.
 */
export function decodeLine(bytes: Uint8Array, author: string): Decoded {
  const value = parseStrict(bytes); // `InvalidJson` on bad UTF-8, a BOM, bad syntax, a duplicate member, an unpaired surrogate, a number outside binary64
  const event = validateEvent(value);
  const canonical = canonicalEventBytes(event);
  if (!sameBytes(canonical, bytes)) throw new InvalidEvent("not the event's RFC 8785 canonical bytes");
  if (event.author !== author) throw new InvalidEvent(`author ${event.author} in a segment of ${author}`);
  const text = canonicalText(event);
  return { event: parseStrict(text) as Event, text };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** What one line decoded to, and where. */
export interface SegmentEvent extends Decoded {
  /** the segment's path, in the backend's terms */
  path: string;
  /** 1-based line number */
  n: number;
  /** the byte offset after this line's LF: the accepted length that includes it */
  end: number;
}

/** What reading one segment found. */
export interface SegmentRead {
  events: SegmentEvent[];
  damaged: Damaged[];
  /** the byte length of the complete lines (§10.3) */
  accepted: number;
}

/**
 * Every line of a segment at `path` under the author directory `author`:
 * the events, and what was not one as `Damaged` naming `<path>:<n>`
 * (§11.5). Only lines within `[from, to)` of the segment's bytes are
 * read; both default to the whole. A fragment is damage wherever it
 * stands, and is never joined with what follows.
 */
export function decodeSegment(bytes: Uint8Array, path: string, author: string, from = 0, to = bytes.length): SegmentRead {
  const read: SegmentRead = { events: [], damaged: [], accepted: acceptedLength(bytes) };
  for (const line of splitLines(bytes)) {
    if (line.start < from || line.start >= to) continue;
    const where = `${path}:${line.n}`;
    const slice = bytes.subarray(line.start, line.end);
    if (!line.whole) {
      read.damaged.push({ where, bytes: new Uint8Array(slice), error: "incomplete final fragment" });
      continue;
    }
    try {
      read.events.push({ ...decodeLine(slice, author), path, n: line.n, end: line.end + 1 });
    } catch (err) {
      read.damaged.push({ where, bytes: new Uint8Array(slice), error: err instanceof Error ? err.message : String(err) });
    }
  }
  return read;
}

/** The lines of a segment written whole (§8): each event's canonical bytes followed by LF (ES-10). */
export function encodeLines(events: Event[]): Uint8Array {
  return concat(events.flatMap((event) => [canonicalEventBytes(event), utf8("\n")]));
}
