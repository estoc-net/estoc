import { segmentsOf, type VaultBackend } from "./types.js";

/**
 * A vault inside the Origin Private File System, rooted at any directory
 * handle — typically `vaults/<id>` under `navigator.storage.getDirectory()`.
 *
 * Whole-file writes go through `createWritable()`, which OPFS commits
 * atomically on close (a swap file replaces the original), so a crash
 * mid-write never truncates a keystore. Appends reopen with
 * `keepExistingData` and write at the end; a crash there can leave a
 * partial last line, which the folder store reports and heals.
 * `modified` is the file's `lastModified`, which a rewrite renews.
 *
 * A streamed `create` over an existing file is one `createWritable()`
 * too, closed once the source has ended and aborted — the swap file
 * discarded, the original kept — when it throws. Over a path with no
 * file, getting a handle would make an empty file visible before the
 * source has ended (r1-B), so the source is written to a temp sibling
 * and moved into place by `FileSystemFileHandle.move()`, which is atomic
 * and replaces a file at the destination. `rename` is `move` too. Where
 * the platform has no `move`, a fresh destination cannot be filled
 * atomically at all: `create` and `rename` to one refuse before touching
 * it, and only `rename` over an existing file — a copy through
 * `createWritable()`, atomic on close, then a removal of the source —
 * still works. `open` is the file's own `stream()`.
 *
 * `createWritable()` is what this needs from the platform; browsers that
 * only offer OPFS through sync access handles in workers are not served
 * by this adapter yet — the constructor says so up front.
 */
export class OpfsBackend implements VaultBackend {
  constructor(private readonly root: FileSystemDirectoryHandle) {
    if (
      typeof (root as { getFileHandle?: unknown }).getFileHandle !== "function" ||
      typeof (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable !== "function"
    ) {
      throw new Error("OPFS with createWritable() is not available here");
    }
  }

  private async dir(segments: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let handle = this.root;
    for (const segment of segments) {
      try {
        handle = await handle.getDirectoryHandle(segment, { create });
      } catch (err) {
        if (!create && isAbsent(err)) {
          return null;
        }
        throw err;
      }
    }
    return handle;
  }

  private async file(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const segments = segmentsOf(path);
    const name = segments.pop() as string;
    const dir = await this.dir(segments, create);
    if (dir === null) {
      return null;
    }
    try {
      return await dir.getFileHandle(name, { create });
    } catch (err) {
      if (!create && isAbsent(err)) {
        return null;
      }
      throw err;
    }
  }

  async read(path: string): Promise<Uint8Array | null> {
    const handle = await this.file(path, false);
    if (handle === null) {
      return null;
    }
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const handle = (await this.file(path, true)) as FileSystemFileHandle;
    const writable = await handle.createWritable();
    try {
      await writable.write(data as unknown as ArrayBufferView<ArrayBuffer>);
    } finally {
      await writable.close();
    }
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    const handle = (await this.file(path, true)) as FileSystemFileHandle;
    const size = (await handle.getFile()).size;
    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(size);
      await writable.write(data as unknown as ArrayBufferView<ArrayBuffer>);
    } finally {
      await writable.close();
    }
  }

  async open(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const handle = await this.file(path, false);
    if (handle === null) {
      return null;
    }
    return (await handle.getFile()).stream() as ReadableStream<Uint8Array>;
  }

  async create(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const existing = await this.file(path, false);
    if (existing !== null) {
      await fill(existing, source);
      return;
    }
    // No file there yet: written beside its place under a temp name and
    // moved in whole, so nothing stands at `path` until the source has
    // ended (r1-B). Without `move` there is no way to do that.
    const segments = segmentsOf(path);
    const name = segments.pop() as string;
    const dir = (await this.dir(segments, true)) as FileSystemDirectoryHandle;
    if (!hasMove()) throw noMove(`create ${JSON.stringify(path)}`);
    const tmpName = `${name}.${randomHex(6)}.tmp`;
    const tmp = await dir.getFileHandle(tmpName, { create: true });
    try {
      await fill(tmp, source);
      await (tmp as Movable).move(dir, name);
    } catch (err) {
      await dir.removeEntry(tmpName).catch(() => undefined);
      throw err;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await this.file(from, false);
    if (source === null) {
      throw new Error(`no such file: ${JSON.stringify(from)}`);
    }
    const segments = segmentsOf(to);
    const name = segments.pop() as string;
    const dir = (await this.dir(segments, true)) as FileSystemDirectoryHandle;
    if (hasMove()) {
      await (source as Movable).move(dir, name); // atomic, over a file at the destination too
      return;
    }
    // No `move`: a file already at the destination can be replaced whole
    // through its own writable, which is atomic on close; a fresh
    // destination cannot be, and is refused untouched (r1-B).
    const target = await this.file(to, false);
    if (target === null) throw noMove(`rename to ${JSON.stringify(to)}`);
    await fill(target, streamChunks((await source.getFile()).stream() as ReadableStream<Uint8Array>));
    await this.remove(from);
  }

  async remove(path: string): Promise<void> {
    const segments = segmentsOf(path);
    const name = segments.pop() as string;
    const dir = await this.dir(segments, false);
    if (dir === null) {
      return;
    }
    try {
      await dir.removeEntry(name);
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
  }

  async size(path: string): Promise<number | null> {
    const handle = await this.file(path, false);
    return handle === null ? null : (await handle.getFile()).size;
  }

  async modified(path: string): Promise<number | null> {
    const handle = await this.file(path, false);
    return handle === null ? null : (await handle.getFile()).lastModified;
  }

  async list(dir: string): Promise<string[]> {
    return this.entries(dir, "file");
  }

  async dirs(dir: string): Promise<string[]> {
    return this.entries(dir, "directory");
  }

  private async entries(dir: string, kind: FileSystemHandleKind): Promise<string[]> {
    const handle = await this.dir(segmentsOf(dir), false);
    if (handle === null) {
      return [];
    }
    const names: string[] = [];
    for await (const [name, entry] of handle as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (entry.kind === kind) {
        names.push(name);
      }
    }
    return names;
  }
}

type Movable = FileSystemFileHandle & { move: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> };

/** Does the platform give file handles `move()`? Chromium does; not every browser with `createWritable()` does. */
function hasMove(): boolean {
  return typeof (FileSystemFileHandle.prototype as { move?: unknown }).move === "function";
}

function noMove(what: string): Error {
  return new Error(`${what}: OPFS here has no FileSystemFileHandle.move(), so a file cannot be put in place whole`);
}

function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `handle`'s contents replaced by every chunk of `source`, atomically on close; on a throw the swap file is discarded and the file is as it was. */
async function fill(handle: FileSystemFileHandle, source: AsyncIterable<Uint8Array>): Promise<void> {
  const writable = await handle.createWritable();
  try {
    for await (const chunk of source) {
      await writable.write(chunk as unknown as ArrayBufferView<ArrayBuffer>);
    }
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
  await writable.close();
}

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}

/** Nothing of the kind asked for is there: not found, or an entry of the other kind (`TypeMismatchError`). */
function isAbsent(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "NotFoundError" || err.name === "TypeMismatchError");
}
