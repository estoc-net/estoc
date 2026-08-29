/**
 * The bytes layer under a vault: a tiny file-system interface that every
 * store above it (config, keystore, contacts, message log) is written
 * against. Two implementations ship — OPFS for the browser and memory for
 * tests — and a Node `fs` one would be a page. Paths are `/`-separated,
 * relative to the vault root, never absolute, never containing `..`.
 *
 * Whole-file writes must be atomic in the sense a crash never leaves a
 * half-written file where a good one was; appends may leave a truncated
 * last line, which the message log reader tolerates.
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
