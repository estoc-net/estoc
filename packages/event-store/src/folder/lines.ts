/**
 * Lines of a segment (vault-folder.md §4, §9.5): each is one event or
 * damage. A line is whole only when terminated; the fragment a crash
 * leaves is reported, never fused with what follows.
 */

import { InvalidEvent } from "../errors.js";
import { validateEvent, type DamagedLine, type Event } from "../event.js";
import { deepFreeze } from "../json.js";
import { isLocalEvent, type LocalEvent } from "../local.js";
import { text } from "./layout.js";

/** One line of a segment's text with its 1-based number; `whole` is false for an unterminated tail. */
export interface Line {
  n: number;
  line: string;
  whole: boolean;
}

/** The lines of a segment's bytes, in order; a trailing fragment is the last, `whole: false`. */
export function splitLines(bytes: Uint8Array): Line[] {
  const parts = text(bytes).split("\n");
  const last = parts.pop() as string;
  const lines: Line[] = parts.map((line, i) => ({ n: i + 1, line, whole: true }));
  if (last !== "") {
    lines.push({ n: parts.length + 1, line: last, whole: false });
  }
  return lines;
}

/** `decodeEvent(path, line)` of §4: the event, its envelope checked and its `author` held against the directory's `dev`. */
export function decodeEvent(line: string, dev: string): Event {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new InvalidEvent(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const event = validateEvent(parsed);
  if (event.author !== dev) {
    throw new InvalidEvent(`author ${event.author} in a segment of device ${dev}`);
  }
  return deepFreeze(event);
}

/** A trace line (event-store.md §7.2): the local event's shape and nothing more. */
export function decodeLocalEvent(line: string): LocalEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new InvalidEvent(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isLocalEvent(parsed)) {
    throw new InvalidEvent("not a local event");
  }
  return deepFreeze(parsed);
}

/**
 * Every line of a segment through `decode`: what decoded, and what did
 * not as `DamagedLine`s naming `where` (`<path>:<n>`).
 */
export function decodeSegment<T>(bytes: Uint8Array, path: string, decode: (line: string) => T): { events: T[]; damaged: DamagedLine[] } {
  const events: T[] = [];
  const damaged: DamagedLine[] = [];
  for (const { n, line, whole } of splitLines(bytes)) {
    if (line === "" && whole) {
      continue;
    }
    const where = `${path}:${n}`;
    if (!whole) {
      damaged.push({ where, line, error: "unterminated line" });
      continue;
    }
    try {
      events.push(decode(line));
    } catch (err) {
      damaged.push({ where, line, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { events, damaged };
}

/** Whether a segment's bytes end where a writer may append: empty, or terminated. */
export function endsClean(bytes: Uint8Array): boolean {
  return bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
}
