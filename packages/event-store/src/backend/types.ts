/**
 * The bytes layer under a folder store (vault-folder.md §9): a small
 * file-system interface — read, write, append, remove, size, modified,
 * list, dirs — that the folder store is written against and knows the
 * tree above. Three implementations ship: OPFS for the browser, a folder
 * on disk for Node, memory for tests. Paths are `/`-separated, relative
 * to the vault root, never absolute, never containing `.` or `..`.
 *
 * Whole-file writes are atomic in the sense a crash never leaves a
 * half-written file where a good one was; appends may leave a cut-short
 * last line, which the folder store reports and heals (§5).
 */
export interface VaultBackend {
  /** File contents, or null if there is no such file. */
  read(path: string): Promise<Uint8Array | null>;
  /** Replace (or create) a file, creating parent directories as needed. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Append to a file, creating it (and parents) if missing. */
  append(path: string, data: Uint8Array): Promise<void>;
  /** Delete a file; deleting a missing file is not an error. */
  remove(path: string): Promise<void>;
  /** Size of a file in bytes without reading it, or null if there is no such file. */
  size(path: string): Promise<number | null>;
  /** When the file was last written, in milliseconds since the epoch of the local clock; null if there is no such file. */
  modified(path: string): Promise<number | null>;
  /** Names of the files (not directories) directly inside `dir`, unsorted; [] if missing. */
  list(dir: string): Promise<string[]>;
  /** Names of the directories directly inside `dir`, unsorted; [] if missing. */
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

/** Split a vault-relative path into segments, rejecting anything unsafe. */
export function segmentsOf(path: string): string[] {
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.length === 0) {
    throw new Error("empty path");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`unsafe path segment in ${path}`);
    }
  }
  return segments;
}
