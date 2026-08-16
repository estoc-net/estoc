import { segmentsOf, type VaultBackend } from "./types.js";

/**
 * A vault held in a Map — the test double, and the shape any snapshot
 * (a zip, a JSON blob) unpacks into before it is written somewhere real.
 */
export class MemoryBackend implements VaultBackend {
  readonly files = new Map<string, Uint8Array>();

  private key(path: string): string {
    return segmentsOf(path).join("/");
  }

  async read(path: string): Promise<Uint8Array | null> {
    const data = this.files.get(this.key(path));
    return data === undefined ? null : data.slice();
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(this.key(path), data.slice());
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    const key = this.key(path);
    const existing = this.files.get(key);
    if (existing === undefined) {
      this.files.set(key, data.slice());
      return;
    }
    const joined = new Uint8Array(existing.length + data.length);
    joined.set(existing);
    joined.set(data, existing.length);
    this.files.set(key, joined);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(this.key(path));
  }

  async list(dir: string): Promise<string[]> {
    const prefix = segmentsOf(dir).join("/") + "/";
    const names: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) {
          names.push(rest);
        }
      }
    }
    return names;
  }
}
