/**
 * The bytes layer under a folder store: a small file-system interface —
 * read, write, append, remove, size, modified, list, dirs — that the
 * folder store is written against and knows the tree above. Three
 * implementations ship: OPFS for the browser, a folder on disk for Node,
 * memory for tests. Paths are `/`-separated, relative to the vault root,
 * never absolute, never containing `.` or `..`. A file and a directory
 * are told apart by every query: what asks about a file (`read`, `size`,
 * `modified`) answers null for a directory, and what asks about a
 * directory (`list`, `dirs`) answers [] for a file, as each does for a
 * path that is not there.
 *
 * Whole-file writes are atomic in the sense a crash never leaves a
 * half-written file where a good one was; appends may leave a cut-short
 * last line, which the folder store reports and heals. A backend that
 * gets there by writing beside the place and moving in names the
 * sibling as `tempName` does, and a crash may leave it standing; that
 * is the only file a backend ever leaves that the store did not name.
 *
 * Three members are for bytes too large to hold whole: `open` streams a
 * file out, `create` streams one in and makes it visible only once its
 * source has ended — a source that throws leaves the path as it was —
 * and `rename` moves a file into place, replacing what stood there, so a
 * file can be written before its name is known.
 */
export interface VaultBackend {
  /** File contents, or null if there is no such file (a directory is not one). */
  read(path: string): Promise<Uint8Array | null>;
  /** Replace (or create) a file, creating parent directories as needed. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Append to a file, creating it (and parents) if missing. */
  append(path: string, data: Uint8Array): Promise<void>;
  /** Delete a file, or an empty directory; deleting a missing path is not an error, and a directory with entries is refused. */
  remove(path: string): Promise<void>;
  /** Size of a file in bytes without reading it, or null if there is no such file (a directory is not one). */
  size(path: string): Promise<number | null>;
  /** When the file was last written, in milliseconds since the epoch of the local clock; null if there is no such file. */
  modified(path: string): Promise<number | null>;
  /** Names of the files (not directories) directly inside `dir`, unsorted; [] if missing or a file. */
  list(dir: string): Promise<string[]>;
  /** Names of the directories directly inside `dir`, unsorted; [] if missing or a file. */
  dirs(dir: string): Promise<string[]>;
  /**
   * A file's contents as a stream of chunks, or null if there is no such
   * file (a directory is not one). The bytes are the file's as of the
   * open, as far as the platform can promise; cancelling the stream
   * releases whatever it holds.
   */
  open(path: string): Promise<ReadableStream<Uint8Array> | null>;
  /**
   * Replace (or create) a file with every chunk of `source`, in order,
   * creating parent directories as needed. Nothing is visible at `path`
   * until `source` has ended: a crash midway, or a source that throws,
   * leaves the file that was there, or none — never a part. A source
   * that throws is rethrown.
   */
  create(path: string, source: AsyncIterable<Uint8Array>): Promise<void>;
  /**
   * Move the file at `from` to `to`, creating parent directories as
   * needed and replacing any file at `to` whole: at every moment `to`
   * holds the old file, or the new one. Throws if there is no file at
   * `from`.
   */
  rename(from: string, to: string): Promise<void>;
  /**
   * Take exclusive ownership of the name `path` — a path under the
   * vault root that the backend may or may not make a file of — or
   * throw `VaultOwned` at once when another holder has it; never wait.
   * Ownership is a process's: it ends at `release`, or when the
   * process holding it is gone.
   */
  own(path: string): Promise<Ownership>;
}

/** Ownership taken by `own`: released once; releasing again does nothing. */
export interface Ownership {
  release(): Promise<void>;
}

/** `own` found the name held by another holder: nothing was taken. */
export class VaultOwned extends Error {
  constructor(
    readonly path: string,
    detail: string
  ) {
    super(`${path} is owned elsewhere: ${detail}`);
    this.name = "VaultOwned";
  }
}

const TEMP_SUFFIX = /^(.+)\.([0-9a-f]{12})\.tmp$/;

/** The sibling a backend writes `name` to before moving it into place: `<name>.<12 hex>.tmp`, the hex fresh for each write. */
export function tempName(name: string): string {
  const random = new Uint8Array(6);
  crypto.getRandomValues(random);
  return `${name}.${[...random].map((b) => b.toString(16).padStart(2, "0")).join("")}.tmp`;
}

/** The name a `tempName` sibling was written for, or null for a name of any other shape. */
export function unfinishedWriteOf(name: string): string | null {
  return TEMP_SUFFIX.exec(name)?.[1] ?? null;
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
