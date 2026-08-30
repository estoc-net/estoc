import { segmentsOf, type VaultBackend } from "./types.js";

export interface MemoryBackendOptions {
  /** the clock `modified` reads; the wall clock when left out */
  clock?: () => Date;
}

/**
 * A vault held in a Map — the test double, and the shape any snapshot
 * (a zip, a JSON blob) unpacks into before it is written somewhere real.
 * `modified` is the clock at the last write, so a test that pins the
 * clock can age a blob past its grace.
 */
export class MemoryBackend implements VaultBackend {
  readonly files = new Map<string, Uint8Array>();
  private readonly times = new Map<string, number>();
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

  async read(path: string): Promise<Uint8Array | null> {
    const data = this.files.get(this.key(path));
    return data === undefined ? null : data.slice();
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const key = this.key(path);
    this.files.set(key, data.slice());
    this.touch(key);
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    const key = this.key(path);
    const existing = this.files.get(key);
    if (existing === undefined) {
      this.files.set(key, data.slice());
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
}
