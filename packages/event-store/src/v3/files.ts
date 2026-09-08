/**
 * Portable files, version 3: what a vault carries that is neither an
 * event nor an object, named by path. The paths are the folder's; the
 * six structural roots are owned by the operations that write them, and
 * a file store refuses them; everything else is an opaque portable file
 * the store carries without reading. The interface, the path rules
 * every store agrees on, and the store in memory.
 */

export interface FileStore {
  /** The bytes at `path`, or `null`; throws on a path that is not a file's. */
  read(path: string): Promise<Uint8Array | null>;
  /** Replace or create the portable file at `path`, whole; throws on an owned or structural path, or one that would be both a file and a directory. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Every portable file's path, sorted by code point; never a segment, an object, or anything under `local/` or `import/`. */
  list(): Promise<string[]>;
}

/** The folder's structural roots, which a file store never writes. */
export const OWNED_ROOTS: readonly string[] = Object.freeze(["config.json", "keystore.json", "events", "objects", "import", "local"]);

/** A UTF-16 code unit that is not part of a pair: a string holding one has no UTF-8 form. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

/**
 * A conforming relative path: `/`-separated, non-empty components, none
 * `.` or `..`, no NUL, no backslash, not absolute, and UTF-8 — so no
 * unpaired surrogate, which no folder or archive could hold as the name
 * it was given. Returns `path`; throws otherwise. Unicode is allowed
 * and compared by code point, never case-folded or normalized.
 */
export function checkPath(path: string): string {
  if (typeof path !== "string" || path === "") throw new Error(`not a path: ${JSON.stringify(path)}`);
  if (path.includes("\0") || path.includes("\\")) throw new Error(`not a conforming path (NUL or backslash): ${JSON.stringify(path)}`);
  if (UNPAIRED_SURROGATE.test(path)) throw new Error(`not a UTF-8 path (unpaired surrogate): ${JSON.stringify(path)}`);
  if (path.startsWith("/")) throw new Error(`not a relative path: ${JSON.stringify(path)}`);
  for (const component of path.split("/")) {
    if (component === "" || component === "." || component === "..") throw new Error(`not a relative path: ${JSON.stringify(path)}`);
  }
  return path;
}

/** Is `path` one of the owned roots, or under one? A checked path. */
export function isOwnedPath(path: string): boolean {
  const root = path.split("/", 1)[0] as string;
  return OWNED_ROOTS.includes(root);
}

/**
 * A path a file store writes: `checkPath`, and not owned. Throws
 * otherwise. `config.json` and `keystore.json` are written by the
 * operation that creates or restores a vault, never through this
 * interface.
 */
export function checkFilePath(path: string): string {
  checkPath(path);
  if (isOwnedPath(path)) throw new Error(`not a portable file path (owned by the layout): ${path}`);
  return path;
}

/** The paths above `path`: `a`, `a/b` for `a/b/c`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Code-point order, which `<` on strings is not for characters outside the BMP. */
export function comparePaths(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx - cy;
  }
}

/**
 * The file store as a map in memory: the reference for the interface,
 * and what the vault in memory carries. The two singletons are given at
 * construction, when the vault has them, and reach `read` and `list`
 * as in a folder. Bytes in and out are copies —
 * what is held is the store's own. Nothing persists, so the
 * process-durable half of a file write's promise is vacuous here; the
 * whole-file half is not: a write is one synchronous replacement.
 */
export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Uint8Array>();

  /** `singletons`: `config.json` and `keystore.json` as the vault they belong to fixed them — read and listed, never written through the store. */
  constructor(singletons: { config?: Uint8Array; keystore?: Uint8Array } = {}) {
    if (singletons.config !== undefined) this.files.set("config.json", new Uint8Array(singletons.config));
    if (singletons.keystore !== undefined) this.files.set("keystore.json", new Uint8Array(singletons.keystore));
  }

  async read(path: string): Promise<Uint8Array | null> {
    checkPath(path);
    const bytes = this.files.get(path);
    return bytes === undefined ? null : new Uint8Array(bytes);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    checkFilePath(path);
    if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes is a Uint8Array");
    for (const ancestor of ancestorsOf(path)) {
      if (this.files.has(ancestor)) throw new Error(`${ancestor} is a file: cannot write ${path}`);
    }
    for (const have of this.files.keys()) {
      if (have.startsWith(`${path}/`)) throw new Error(`${path} is a directory (${have}): cannot write it as a file`);
    }
    this.files.set(path, new Uint8Array(bytes));
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()].sort(comparePaths);
  }
}
