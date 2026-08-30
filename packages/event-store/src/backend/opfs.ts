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

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}

/** Nothing of the kind asked for is there: not found, or an entry of the other kind (`TypeMismatchError`). */
function isAbsent(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "NotFoundError" || err.name === "TypeMismatchError");
}
