import { v7 as uuidv7 } from "uuid";
import type { VaultBackend } from "../backend/types.js";
import { text, utf8 } from "./layout.js";

/**
 * An append-only JSONL log kept as segments in one directory: writers
 * append to one segment, readers concatenate every `<uuidv7>.jsonl` in
 * name order. Segments are not about size — they are how a merge works:
 * importing another copy of the vault drops what is new into a segment of
 * its own, and nothing already here is rewritten. The message log and the
 * delivery log are both this, with their own line shape.
 *
 * A segment's name is minted when the segment is created, never computed
 * from what else is in the directory (no "highest number plus one"): the
 * same rule as every other id in the vault. uuidv7 makes name order the
 * order segments were made, which is all `read` promises — nothing may
 * lean on cross-segment order for chronology; records carry their own
 * time.
 */

/** A line that would not parse — reported to `read`'s caller, then skipped. */
export interface DamagedLine {
  /** `<segment>:<line number>` */
  where: string;
  line: string;
  error: string;
}

/** Turn one line's JSON into a record, or throw. `where` names the line for the error. */
export type LineParser<T> = (line: string, where: string) => T;

export class SegmentedLog<T> {
  /** appends run one at a time; two in flight would compute the same offset */
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * The segment this instance appends to — the newest one present when it
   * first appends, or a fresh one if the directory is empty; null until then.
   */
  private segment: string | null = null;

  constructor(
    private readonly backend: VaultBackend,
    readonly dir: string,
    private readonly parseLine: LineParser<T>
  ) {}

  /**
   * Append one record. Appends are serialised through this instance: the
   * backend's append is read-size-then-write, so two in flight would land
   * on the same offset and one would overwrite the other.
   *
   * The first append picks the segment — the newest one there is, so a
   * session after an import carries on behind what came in — and heals a
   * crash: a segment that does not end in a newline holds a line whose
   * append was cut short, and writing straight after it would fuse the
   * fragment and the new record into one bad line — the fragment gets its
   * own line terminator first, so it stays a skippable damaged line and
   * the new record stays whole.
   */
  append(record: T): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.segment === null) {
        const segments = orderSegments(await this.backend.list(this.dir));
        this.segment = segments.at(-1) ?? newSegment();
        const path = `${this.dir}/${this.segment}`;
        const bytes = await this.backend.read(path);
        if (bytes !== null && bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
          await this.backend.append(path, utf8("\n"));
        }
      }
      await this.backend.append(`${this.dir}/${this.segment}`, utf8(JSON.stringify(record) + "\n"));
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Every record across every segment, in segment order then line order.
   * A line that does not parse — a cut-short append, a corrupted byte — is
   * reported through `onDamaged` and skipped, never fatal: one bad line
   * must not take the whole history with it. Callers wanting to know pass
   * a callback; the log itself never invents records to fill the gap.
   */
  async read(onDamaged?: (damaged: DamagedLine) => void): Promise<T[]> {
    const segments = orderSegments(await this.backend.list(this.dir));
    const records: T[] = [];
    for (const segment of segments) {
      const bytes = await this.backend.read(`${this.dir}/${segment}`);
      if (bytes === null) {
        continue;
      }
      records.push(...parseSegment(text(bytes), segment, this.parseLine, onDamaged));
    }
    return records;
  }

  /** The records in one segment's text — see `parseSegment`. */
  parse(content: string, segment: string, onDamaged?: (damaged: DamagedLine) => void): T[] {
    return parseSegment(content, segment, this.parseLine, onDamaged);
  }

  /** Lay `records` down as a segment of their own, under a fresh name. */
  async writeSegment(records: T[]): Promise<string> {
    const segment = newSegment();
    await this.backend.write(
      `${this.dir}/${segment}`,
      utf8(records.map((record) => JSON.stringify(record)).join("\n") + "\n")
    );
    return segment;
  }
}

/**
 * The records in one segment's text, in line order, with the same damaged-line
 * policy as `read` — shared with vault import, which reads segments that are
 * not (yet) in any backend.
 */
export function parseSegment<T>(
  content: string,
  segment: string,
  parseLine: LineParser<T>,
  onDamaged?: (damaged: DamagedLine) => void
): T[] {
  const records: T[] = [];
  // Every element but the last was terminated by "\n"; the last is ""
  // when the file ended cleanly, otherwise a partial line.
  content.split("\n").forEach((line, i) => {
    if (line === "") {
      return;
    }
    const where = `${segment}:${i + 1}`;
    try {
      records.push(parseLine(line, where));
    } catch (err) {
      onDamaged?.({
        where,
        line,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return records;
}

const SEGMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/;

/** Whether `name` is a segment file: `<uuidv7>.jsonl`, lowercase. */
export function isSegment(name: string): boolean {
  return SEGMENT_NAME.test(name);
}

/**
 * The segment files among `names`, in name order — which, the names being
 * uuidv7, is the order the segments were made. Files that are not
 * `<uuidv7>.jsonl` are not segments and are left out — a stray file in
 * the directory is not history.
 */
export function orderSegments(names: string[]): string[] {
  return names.filter(isSegment).sort();
}

/**
 * A fresh segment name. Left to itself, uuidv7 keeps names monotonic within
 * a process even inside one millisecond; `now` pins the time part instead
 * (tests) and gives that up.
 */
export function newSegment(now?: Date): string {
  return `${now === undefined ? uuidv7() : uuidv7({ msecs: now.getTime() })}.jsonl`;
}
