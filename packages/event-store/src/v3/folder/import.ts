/**
 * The import barrier: what an import into a folder writes under
 * `import/` so that a crash at any point leaves the folder either as it
 * was or on the way to the complete merged view, never in between.
 *
 * One import is one directory, `import/<uuidv7>/`. Everything the
 * import will publish — a segment per incoming author, each required
 * object, each opaque file to be added — is first written whole under
 * `staged/`, at the path it will have in the layout. Only when every
 * item stands there is `journal.json` written beside them, naming them
 * all; then each is moved to its place, objects first, so that no
 * segment is published before the objects it names; then the journal
 * and the directory go. The journal is the boundary: a directory
 * without one is an import that never got to publication, and is rolled
 * back; a directory with one is an import that must be finished, and
 * is, item by item — an item still staged is moved, one already at its
 * place is done. Nothing about the source is needed for either.
 *
 * A writable open runs that recovery once it holds ownership and before
 * it opens the stores, whatever became of `local/` meanwhile. Whatever
 * under `import/` is not one of these two states — a file at the top, a
 * directory not named by a UUIDv7, a journal that does not parse or
 * names paths of another shape, a staged file the journal does not
 * name, an item found neither staged nor published — blocks the open as
 * `PendingImport`: a recovery this version does not understand is a
 * human's, never guessed at. A read-only open recovers nothing and
 * reports any of it the same way.
 */

import { v7 } from "uuid";

import type { VaultBackend } from "../../backend/types.js";
import { walk } from "../../backend/types.js";
import { PendingImport } from "../errors.js";
import { isUuidv7 } from "../event.js";
import { checkPath, comparePaths } from "../files.js";
import { parseStrict } from "../jcs.js";
import { isJsonObject } from "../json.js";
import { IMPORT_DIR, kindOf, prettyJson, text, type PathKind } from "./layout.js";

/** The publication journal of one import: written once every item is staged, removed once every item is at its place. */
export const JOURNAL_FILE = "journal.json";
/** Where an import's items stand before publication, each at the path it will have in the layout. */
export const STAGED_DIR = "staged";

const JOURNAL_FORMAT = "estoc-import";
const JOURNAL_VERSION = 1;

/** The kinds of path an import publishes, in the order it publishes them: an object before any segment that names it, opaque files last. */
const PUBLISHED: readonly PathKind[] = ["object", "segment", "opaque"];

function rank(item: string): number {
  return PUBLISHED.indexOf(kindOf(item));
}

/** `items` in publication order: objects, then segments, then opaque files, each kind in path order. */
export function publicationOrder(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => rank(a) - rank(b) || comparePaths(a, b));
}

/** The journal as the folder writes it: pretty-printed, the items in publication order. */
export function encodeJournal(items: Iterable<string>): Uint8Array {
  return prettyJson({ format: JOURNAL_FORMAT, version: JOURNAL_VERSION, items: publicationOrder(items) });
}

/**
 * The items a journal names, in publication order, or a throw: a JSON
 * object with exactly `format`, `version` and `items`; the format and
 * version this module writes; every item a conforming path of a kind an
 * import publishes, none twice. `entries` is what stands under
 * `import/`, for the error.
 */
export function parseJournal(bytes: Uint8Array, where: string, entries: string[]): string[] {
  const refuse = (why: string): never => {
    throw new PendingImport(entries, `${where}: ${why}`);
  };
  let value: unknown;
  try {
    value = parseStrict(text(bytes));
  } catch (err) {
    return refuse(err instanceof TypeError ? "not UTF-8" : err instanceof Error ? err.message : String(err));
  }
  if (!isJsonObject(value)) return refuse("not a JSON object");
  const members = Object.keys(value).sort();
  if (members.join(",") !== "format,items,version") return refuse(`the members are ${members.map((m) => JSON.stringify(m)).join(", ")}, not format, version and items`);
  if (value["format"] !== JOURNAL_FORMAT) return refuse(`format is ${JSON.stringify(value["format"])}, not ${JSON.stringify(JOURNAL_FORMAT)}`);
  if (value["version"] !== JOURNAL_VERSION) return refuse(`version ${JSON.stringify(value["version"])} is not ${JOURNAL_VERSION}`);
  const items = value["items"];
  if (!Array.isArray(items)) return refuse("items is not an array");
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") return refuse("an item is not a string");
    try {
      checkPath(item);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    if (rank(item) < 0) return refuse(`${item} is not a path an import publishes`);
    if (seen.has(item)) return refuse(`${item} is named twice`);
    seen.add(item);
  }
  return publicationOrder(seen);
}

/** Everything directly under `import/`: files and directories, in path order. */
export async function pendingEntries(backend: VaultBackend, base: string): Promise<string[]> {
  const dir = `${base}/${IMPORT_DIR}`;
  return [...(await backend.list(dir)), ...(await backend.dirs(dir))].sort(comparePaths);
}

/**
 * Anything under `import/` refuses: for a read-only open, a restore or
 * an import source, whatever stands there is an import its owner has
 * not finished — recoverable or not, it is that owner's writable open
 * that finishes it — and what `events/` and `objects/` hold meanwhile is
 * not a complete view. An empty or absent `import/` is nothing pending.
 */
export async function checkImport(backend: VaultBackend, base: string): Promise<void> {
  const entries = await pendingEntries(backend, base);
  if (entries.length > 0) throw new PendingImport(entries);
}

/**
 * One import's barrier under `import/<id>/`: items written under
 * `staged/`, then published — the journal written, every item moved to
 * its place, the directory removed. `rollback` removes the directory
 * before publication began; once `publish` has written the journal the
 * import is the folder's to finish, here or at the next writable open.
 */
export class Staging {
  readonly dir: string;
  private readonly items: string[] = [];
  private journaled = false;

  constructor(
    private readonly backend: VaultBackend,
    private readonly base: string,
    readonly id: string = v7()
  ) {
    this.dir = `${base}/${IMPORT_DIR}/${id}`;
  }

  private staged(rel: string): string {
    if (rank(rel) < 0) throw new Error(`${rel} is not a path an import publishes`);
    return `${this.dir}/${STAGED_DIR}/${rel}`;
  }

  /** `bytes` staged for `rel`. */
  async write(rel: string, bytes: Uint8Array): Promise<void> {
    await this.backend.write(this.staged(rel), bytes);
    this.items.push(rel);
  }

  /** `source` streamed into the staging of `rel`; nothing staged when it throws. */
  async create(rel: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    await this.backend.create(this.staged(rel), source);
    this.items.push(rel);
  }

  /** Whether the journal has been written: from then on the import is finished, never rolled back. */
  get published(): boolean {
    return this.journaled;
  }

  /** The journal written, then every item moved to its place and the directory removed. */
  async publish(): Promise<void> {
    await this.backend.write(`${this.dir}/${JOURNAL_FILE}`, encodeJournal(this.items));
    this.journaled = true;
    await finish(this.backend, this.base, this.dir, publicationOrder(this.items), []);
  }

  /** The directory removed, staged items and all; only before the journal is written. */
  async rollback(): Promise<void> {
    if (this.journaled) throw new Error("the journal is written: the import is finished, not rolled back");
    await removeTree(this.backend, this.dir);
  }
}

/**
 * Every item of a journaled import moved to its place — one still
 * staged is moved, one already there is done, one found in neither
 * place cannot be finished — then the journal removed, then the
 * directory. Idempotent: a crash anywhere in it is taken up by the
 * next run from wherever it stopped.
 */
async function finish(backend: VaultBackend, base: string, dir: string, items: string[], entries: string[]): Promise<void> {
  for (const item of items) {
    const staged = `${dir}/${STAGED_DIR}/${item}`;
    if ((await backend.size(staged)) !== null) await backend.rename(staged, `${base}/${item}`);
    else if ((await backend.size(`${base}/${item}`)) === null) {
      throw new PendingImport(entries, `${item} is neither staged nor at its place: the import can be neither finished nor rolled back`);
    }
  }
  await backend.remove(`${dir}/${JOURNAL_FILE}`);
  await removeTree(backend, dir);
}

/** Every file under `dir` removed, then every directory, deepest first, then `dir` itself. */
async function removeTree(backend: VaultBackend, dir: string): Promise<void> {
  for (const path of await walk(backend, dir)) await backend.remove(path);
  await removeDirs(backend, dir);
}

async function removeDirs(backend: VaultBackend, dir: string): Promise<void> {
  for (const name of await backend.dirs(dir)) await removeDirs(backend, `${dir}/${name}`);
  await backend.remove(dir);
}

/**
 * What a writable open does with `import/` once it holds ownership:
 * each import's directory rolled back or finished as the journal says,
 * and anything else refused as `PendingImport` before any of them is
 * touched. Nothing is done while anything under `import/` is not
 * understood: an import this version cannot finish is left whole for
 * whoever can.
 */
export async function recoverImports(backend: VaultBackend, base: string): Promise<void> {
  const entries = await pendingEntries(backend, base);
  if (entries.length === 0) return;
  const root = `${base}/${IMPORT_DIR}`;
  const files = await backend.list(root);
  if (files.length > 0) throw new PendingImport(entries, `${files.sort(comparePaths)[0]} is a file directly under ${IMPORT_DIR}/, which holds only an import's directory`);
  const plans: (() => Promise<void>)[] = [];
  for (const name of (await backend.dirs(root)).sort(comparePaths)) {
    if (!isUuidv7(name)) throw new PendingImport(entries, `${IMPORT_DIR}/${name} is not an import this version recorded`);
    const dir = `${root}/${name}`;
    const held = (await walk(backend, dir)).map((path) => path.slice(dir.length + 1));
    const journal = await backend.read(`${dir}/${JOURNAL_FILE}`);
    if (journal === null) {
      const stray = held.find((rel) => !rel.startsWith(`${STAGED_DIR}/`));
      if (stray !== undefined) throw new PendingImport(entries, `${IMPORT_DIR}/${name}/${stray} is not staging, and there is no journal`);
      plans.push(() => removeTree(backend, dir));
      continue;
    }
    const items = parseJournal(journal, `${IMPORT_DIR}/${name}/${JOURNAL_FILE}`, entries);
    const named = new Set([JOURNAL_FILE, ...items.map((item) => `${STAGED_DIR}/${item}`)]);
    const stray = held.find((rel) => !named.has(rel));
    if (stray !== undefined) throw new PendingImport(entries, `${IMPORT_DIR}/${name}/${stray} is neither the journal nor an item it names`);
    for (const item of items) {
      if ((await backend.size(`${dir}/${STAGED_DIR}/${item}`)) === null && (await backend.size(`${base}/${item}`)) === null) {
        throw new PendingImport(entries, `${item} is neither staged nor at its place: the import can be neither finished nor rolled back`);
      }
    }
    plans.push(() => finish(backend, base, dir, items, entries));
  }
  for (const plan of plans) await plan();
}
