import type { VaultBackend } from "../backend/types.js";
import { FIRST_SEGMENT, text, utf8 } from "./layout.js";

/**
 * An append-only JSONL log kept as segments in one directory: writers
 * append to one segment, readers concatenate every `*.jsonl` in name
 * order. Segments are not about size — they are how a merge works:
 * importing another copy of the vault drops what is new into a segment of
 * its own, and nothing already here is rewritten. The message log and the
 * delivery log are both this, with their own line shape.
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
  /** whether this instance has checked the segment's tail for a cut-short line */
  private tailChecked = false;

  constructor(
    private readonly backend: VaultBackend,
    readonly dir: string,
    private readonly parseLine: LineParser<T>,
    private readonly segment: string = FIRST_SEGMENT
  ) {}

  private get path(): string {
    return `${this.dir}/${this.segment}`;
  }

  /**
   * Append one record. Appends are serialised through this instance: the
   * backend's append is read-size-then-write, so two in flight would land
   * on the same offset and one would overwrite the other.
   *
   * The first append also heals a crash: a segment that does not end in a
   * newline holds a line whose append was cut short, and writing straight
   * after it would fuse the fragment and the new record into one bad line
   * — the fragment gets its own line terminator first, so it stays a
   * skippable damaged line and the new record stays whole.
   */
  append(record: T): Promise<void> {
    const run = this.chain.then(async () => {
      if (!this.tailChecked) {
        const bytes = await this.backend.read(this.path);
        if (bytes !== null && bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
          await this.backend.append(this.path, utf8("\n"));
        }
        this.tailChecked = true;
      }
      await this.backend.append(this.path, utf8(JSON.stringify(record) + "\n"));
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
    const segments = (await this.backend.list(this.dir)).filter((name) => name.endsWith(".jsonl")).sort();
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

  /** Lay `records` down as a new segment, named after the highest one present. */
  async writeSegment(records: T[]): Promise<string> {
    const segment = nextSegment(await this.backend.list(this.dir));
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

/** The next segment name after the highest-numbered `NNNN.jsonl` in `existing`. */
export function nextSegment(existing: string[]): string {
  let max = 0;
  for (const name of existing) {
    const match = /^(\d+)\.jsonl$/.exec(name);
    if (match !== null) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${String(max + 1).padStart(4, "0")}.jsonl`;
}
