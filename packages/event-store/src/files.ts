/**
 * Files (event-store.md §6): everything in a vault that is neither an
 * event nor a blob, named by path. The paths are the folder's
 * (`vault-folder.md` §6); the store carries what it does not understand.
 */

import { isStoreDir, kindOf } from "./folder/layout.js";

export interface FileStore {
  read(path: string): Promise<Uint8Array | null>;
  /** Refuses what is not a file's path (§6): a segment's or a blob's shape, `local/`, a directory the layout owns, or a file and a directory of one name. */
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

/**
 * A path a file store takes (§6): `checkPath`, and a file's by shape
 * (`vault-folder.md` §9.6) — not a segment's or a blob's, not under
 * `local/`, not a directory the layout owns. Throws otherwise.
 */
export function checkFilePath(path: string): string {
  checkPath(path);
  const kind = kindOf(path);
  if (kind !== "file") {
    throw new Error(`not a file path (${kind}): ${path}`);
  }
  if (isStoreDir(path)) {
    throw new Error(`not a file path (a directory the layout owns): ${path}`);
  }
  return path;
}

/** The paths above `path`: `a`, `a/b` for `a/b/c`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(checkFilePath(path))?.slice() ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    checkFilePath(path);
    for (const ancestor of ancestorsOf(path)) {
      if (this.files.has(ancestor)) {
        throw new Error(`${ancestor} is a file: cannot write ${path}`);
      }
    }
    for (const have of this.files.keys()) {
      if (have.startsWith(`${path}/`)) {
        throw new Error(`${path} is a directory (${have}): cannot write it as a file`);
      }
    }
    this.files.set(path, bytes.slice());
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
}
