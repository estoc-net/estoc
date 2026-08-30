/**
 * The bytes layer under a folder store (vault-folder.md §9): a small
 * file-system interface — read, write, append, remove, size, modified,
 * list, dirs — that the folder store is written against and knows the
 * tree above. Three implementations ship: OPFS for the browser, a folder
 * on disk for Node, memory for tests. Paths are `/`-separated, relative
 * to the vault root, never absolute, never containing `.` or `..`.
 * A file and a directory are told apart by every query: what asks
 * about a file (`read`, `size`, `modified`) answers null for a
 * directory, and what asks about a directory (`list`, `dirs`) answers
 * [] for a file, as each does for a path that is not there.
 *
 * Whole-file writes are atomic in the sense a crash never leaves a
 * half-written file where a good one was; appends may leave a cut-short
 * last line, which the folder store reports and heals (§5).
 */
export interface VaultBackend {
  /** File contents, or null if there is no such file (a directory is not one). */
  read(path: string): Promise<Uint8Array | null>;
  /** Replace (or create) a file, creating parent directories as needed. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Append to a file, creating it (and parents) if missing. */
  append(path: string, data: Uint8Array): Promise<void>;
  /** Delete a file; deleting a missing file is not an error. */
  remove(path: string): Promise<void>;
  /** Size of a file in bytes without reading it, or null if there is no such file (a directory is not one). */
  size(path: string): Promise<number | null>;
  /** When the file was last written, in milliseconds since the epoch of the local clock; null if there is no such file. */
  modified(path: string): Promise<number | null>;
  /** Names of the files (not directories) directly inside `dir`, unsorted; [] if missing or a file. */
  list(dir: string): Promise<string[]>;
  /** Names of the directories directly inside `dir`, unsorted; [] if missing or a file. */
  dirs(dir: string): Promise<string[]>;
}

/**
 * Every file under `dir`, recursively, as vault-relative paths, sorted.
 * The whole-tree view a snapshot wants: not a list of the directories
 * this version knows, but whatever is there.
 */
export async function walk(backend: VaultBackend, dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const name of await backend.list(dir)) {
    paths.push(`${dir}/${name}`);
  }
  for (const name of await backend.dirs(dir)) {
    paths.push(...(await walk(backend, `${dir}/${name}`)));
  }
  return paths.sort();
}

/**
 * Split a vault-relative path into segments, rejecting anything a
 * backend could take for more than a name under its root: an empty
 * path, an absolute one, an empty segment, `.` or `..`, and a backslash
 * — Windows reads it as a separator, so `..\\x` would climb out.
 */
export function segmentsOf(path: string): string[] {
  if (path === "") {
    throw new Error("empty path");
  }
  if (path.startsWith("/")) {
    throw new Error(`not a relative path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\\")) {
      throw new Error(`unsafe path segment in ${JSON.stringify(path)}`);
    }
  }
  return segments;
}
