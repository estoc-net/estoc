import { VaultOwned, segmentsOf, type Ownership, type VaultBackend } from "./types.js";

export interface MemoryBackendOptions {
  /** the clock `modified` reads; the wall clock when left out */
  clock?: () => Date;
}

/**
 * A vault held in a Map — the test double, and the shape any snapshot
 * (a zip, a JSON blob) unpacks into before it is written somewhere real.
 * `modified` is the clock at the last write, so a test that pins the
 * clock can age a blob past its grace.
 *
 * What comes in is copied and what goes out is a copy, by `new
 * Uint8Array(bytes)`, which copies whatever typed array it is given: a
 * Node `Buffer` is a `Uint8Array` whose `slice` is a view onto the same
 * memory, so `bytes.slice()` would have kept the caller's buffer as the
 * stored file, and a later write into it would have changed the file
 * with no write here (r2-A). And a write lands only where a file system
 * would let it: not below a file, not onto a directory (r3-A).
 */
/** How much of a file one pull of `open` hands out. */
const STREAM_CHUNK = 64 * 1024;

export class MemoryBackend implements VaultBackend {
  readonly files = new Map<string, Uint8Array>();
  private readonly times = new Map<string, number>();
  /** the names owned right now: one backend instance is one folder, so one set is its whole world */
  private readonly owned = new Set<string>();
  private readonly clock: () => Date;

  constructor(options: MemoryBackendOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  private key(path: string): string {
    return segmentsOf(path).join("/");
  }

  private touch(key: string): void {
    this.times.set(key, this.clock().getTime());
  }

  /**
   * A key a write may land on, as a file system would judge it (r3-A):
   * no file on the way down — `a/b` cannot be written while `a` is a
   * file — and not a directory itself — `a` cannot be written while
   * `a/b` exists. A flat map would take either; a disk refuses both.
   */
  private writable(key: string): string {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (this.files.has(ancestor)) {
        throw new Error(`not a directory: ${JSON.stringify(ancestor)} is a file`);
      }
    }
    const prefix = `${key}/`;
    for (const other of this.files.keys()) {
      if (other.startsWith(prefix)) {
        throw new Error(`is a directory: ${JSON.stringify(key)}`);
      }
    }
    return key;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const data = this.files.get(this.key(path));
    return data === undefined ? null : new Uint8Array(data);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const key = this.writable(this.key(path));
    this.files.set(key, new Uint8Array(data));
    this.touch(key);
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    const key = this.writable(this.key(path));
    const existing = this.files.get(key);
    if (existing === undefined) {
      this.files.set(key, new Uint8Array(data));
    } else {
      const joined = new Uint8Array(existing.length + data.length);
      joined.set(existing);
      joined.set(data, existing.length);
      this.files.set(key, joined);
    }
    this.touch(key);
  }

  async remove(path: string): Promise<void> {
    const key = this.key(path);
    this.files.delete(key);
    this.times.delete(key);
  }

  async size(path: string): Promise<number | null> {
    const data = this.files.get(this.key(path));
    return data === undefined ? null : data.length;
  }

  async modified(path: string): Promise<number | null> {
    return this.times.get(this.key(path)) ?? null;
  }

  async open(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const data = this.files.get(this.key(path));
    if (data === undefined) return null;
    // A copy taken at the open, handed out a chunk at a time: what a
    // later write here changes is the map's bytes, not this stream's.
    const bytes = new Uint8Array(data);
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(at + STREAM_CHUNK, bytes.length);
        controller.enqueue(bytes.slice(at, end));
        at = end;
      },
    });
  }

  async create(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const key = this.writable(this.key(path));
    // Gathered whole, then set in one step: a source that throws has put
    // nothing here.
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of source) {
      parts.push(new Uint8Array(chunk));
      size += chunk.length;
    }
    const joined = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    this.files.set(key, joined);
    this.touch(key);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.key(from);
    const data = this.files.get(source);
    if (data === undefined) throw new Error(`no such file: ${JSON.stringify(from)}`);
    const target = this.writable(this.key(to));
    this.files.set(target, data);
    this.times.set(target, this.times.get(source) as number);
    if (target !== source) {
      this.files.delete(source);
      this.times.delete(source);
    }
  }

  async list(dir: string): Promise<string[]> {
    return this.children(dir).files;
  }

  async dirs(dir: string): Promise<string[]> {
    return this.children(dir).dirs;
  }

  /** A directory exists here exactly when some file lives below it. */
  private children(dir: string): { files: string[]; dirs: string[] } {
    const prefix = segmentsOf(dir).join("/") + "/";
    const files: string[] = [];
    const dirs = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        files.push(rest);
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    return { files, dirs: [...dirs] };
  }

  /** Ownership as a name in a set: exclusive within this instance, which is the folder. Makes no file. */
  async own(path: string): Promise<Ownership> {
    const key = this.key(path);
    if (this.owned.has(key)) throw new VaultOwned(path, "another holder in this process has it");
    this.owned.add(key);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.owned.delete(key);
      },
    };
  }
}
