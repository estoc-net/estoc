/**
 * Files (event-store.md §6): everything in a vault that is neither an
 * event nor a blob, named by path. The paths are the folder's
 * (`vault-folder.md` §6); the store carries what it does not understand.
 */

export interface FileStore {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<string[]>;
}

// printable ASCII less the backslash, which a folder on Windows cannot hold as part of a name
const PRINTABLE_ASCII = /^[\x21-\x5b\x5d-\x7e]+$/;

/**
 * A relative path of `/`-separated non-empty segments of printable
 * ASCII, none of them `.` or `..`, no backslash (`vault-folder.md` §1):
 * what every store accepts, so that no store holds a path a folder
 * cannot. Throws otherwise.
 */
export function checkPath(path: string): string {
  if (path === "" || path.startsWith("/") || path.endsWith("/")) {
    throw new Error(`not a relative path: ${JSON.stringify(path)}`);
  }
  if (!PRINTABLE_ASCII.test(path)) {
    throw new Error(`not a printable ASCII path: ${JSON.stringify(path)}`);
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`not a relative path: ${JSON.stringify(path)}`);
    }
  }
  return path;
}

export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(checkPath(path))?.slice() ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(checkPath(path), bytes.slice());
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
}
