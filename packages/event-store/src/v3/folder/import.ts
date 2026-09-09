/**
 * The import barrier: what an import into a folder writes under
 * `import/` so that a crash at any point leaves the folder either as it
 * was or on the way to the complete merged view, never in between.
 *
 * One import is one directory, `import/<uuidv7>/`. Everything the
 * import will publish is first written whole under `staged/`, at the
 * path it will have in the layout. Only when every item stands there is
 * `journal.json` written beside them, naming them all; then each is
 * moved to its place, objects first, so that no segment is published
 * before the objects it names; then the journal and the directory go.
 * The journal is the boundary: a directory without one is an import
 * that never got to publication, and is rolled back; a directory with
 * one is an import that must be finished, and is, item by item — an
 * item still staged is moved, one already at its place is done. Nothing
 * about the source is needed for either.
 *
 * A writable open runs that recovery once it holds ownership and before
 * it opens the stores, whatever became of `local/` meanwhile. Whatever
 * under `import/` is not one of these two states, exactly as this
 * version leaves them — the sibling a backend was writing an item or
 * the journal to when the process died included — blocks the open as
 * `PendingImport`, untouched: a recovery this version does not
 * understand is a human's, never guessed at. A read-only open recovers
 * nothing and reports any of it the same way.
 */

import { v7 } from "uuid";

import type { VaultBackend } from "../../backend/types.js";
import { unfinishedWriteOf, walk } from "../../backend/types.js";
import { PendingImport } from "../errors.js";
import { isAuthorId, isUuidv7 } from "../event.js";
import { ancestorsOf, checkPath, comparePaths } from "../files.js";
import { parseStrict } from "../jcs.js";
import { isJsonObject } from "../json.js";
import { EVENTS_DIR, IMPORT_DIR, OBJECTS_DIR, kindOf, prettyJson, text, type PathKind } from "./layout.js";

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
    // A path may hold a noncharacter, which the event format's JSON may not.
    value = parseStrict(text(bytes), { noncharacters: true });
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
    if (!publishable(item)) return refuse(`${item} is not a path an import publishes`);
    if (seen.has(item)) return refuse(`${item} is named twice`);
    seen.add(item);
  }
  return publicationOrder(seen);
}

/** A conforming path of a kind an import publishes. */
function publishable(rel: string): boolean {
  try {
    checkPath(rel);
  } catch {
    return false;
  }
  return rank(rel) >= 0;
}

/** The sibling a backend was writing `rel` to when the process died, for a `rel` that passes `to`: what staging leaves without having staged anything at `rel`. */
function unfinishedStaging(rel: string, to: (target: string) => boolean): boolean {
  const target = unfinishedWriteOf(rel);
  return target !== null && to(target);
}

/**
 * A directory an import's staging makes on the way to a publishable
 * path, and nothing else: `objects/`, `events/`, an author's directory,
 * or a directory outside the structural roots.
 */
function stagingDirectory(rel: string): boolean {
  try {
    checkPath(rel);
  } catch {
    return false;
  }
  const parts = rel.split("/");
  if (parts[0] === OBJECTS_DIR) return parts.length === 1;
  if (parts[0] === EVENTS_DIR) return parts.length === 1 || (parts.length === 2 && isAuthorId(parts[1]));
  return kindOf(rel) === "opaque";
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
 * One import's barrier under `import/<id>/`. The journal's write is the
 * point of no return, and a write that fails may still have landed: from
 * the moment it is attempted the import is finished unless `withdraw`
 * can show that nothing of it stands.
 */
export class Staging {
  readonly dir: string;
  private readonly items: string[] = [];
  private journal: "unwritten" | "attempted" | "written" = "unwritten";

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

  async write(rel: string, bytes: Uint8Array): Promise<void> {
    await this.backend.write(this.staged(rel), bytes);
    this.items.push(rel);
  }

  /** Nothing staged when `source` throws. */
  async create(rel: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    await this.backend.create(this.staged(rel), source);
    this.items.push(rel);
  }

  async publish(): Promise<void> {
    this.journal = "attempted";
    await this.backend.write(`${this.dir}/${JOURNAL_FILE}`, encodeJournal(this.items));
    this.journal = "written";
    await finish(this.backend, this.base, this.dir, publicationOrder(this.items), []);
  }

  /**
   * The import taken back where it still can be: the directory
   * removed, staged items and all. True when the folder is as it was,
   * or holds only staging no open will finish; false when the journal
   * stands — written, or attempted and then not certainly removed — so
   * that the import is the folder's to finish, and this runtime must
   * not go on reading the folder as the vault.
   */
  async withdraw(): Promise<boolean> {
    if (this.journal === "written") return false;
    try {
      await removeTree(this.backend, this.dir);
      return true;
    } catch {
      return this.journal === "unwritten";
    }
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

async function removeTree(backend: VaultBackend, dir: string): Promise<void> {
  for (const path of await walk(backend, dir)) await backend.remove(path);
  await removeDirs(backend, dir);
}

async function removeDirs(backend: VaultBackend, dir: string): Promise<void> {
  for (const name of await backend.dirs(dir)) await removeDirs(backend, `${dir}/${name}`);
  await backend.remove(dir);
}

/** The files and the directories under `dir`, relative to it. */
async function tree(backend: VaultBackend, dir: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    const at = rel === "" ? dir : `${dir}/${rel}`;
    for (const name of await backend.list(at)) files.push(rel === "" ? name : `${rel}/${name}`);
    for (const name of await backend.dirs(at)) {
      const sub = rel === "" ? name : `${rel}/${name}`;
      dirs.push(sub);
      await visit(sub);
    }
  };
  await visit("");
  return { files: files.sort(comparePaths), dirs: dirs.sort(comparePaths) };
}

/**
 * What a writable open does with `import/` once it holds ownership:
 * each import's directory rolled back or finished as the journal says,
 * and anything else refused as `PendingImport` before any of them is
 * touched. An import's directory is understood only in the shapes this
 * version leaves: without a journal, files and directories under
 * `staged/` on the way to publishable paths — the sibling a backend
 * was writing one of them, or the journal itself, to when the process
 * died included, since the journal stands only once it is at its name
 * — and nothing else; with one, the journal, and under `staged/` only
 * items it names and the directories on their way, every item having
 * been written whole before the journal was. Nothing is done while
 * anything under `import/` is not understood — a journal that is a
 * directory, a directory beside `staged/`, an empty directory the
 * staging of no named item would leave, a sibling beside a journal
 * that stands — since an import this version cannot finish is left
 * whole for whoever can.
 */
export async function recoverImports(backend: VaultBackend, base: string): Promise<void> {
  const entries = await pendingEntries(backend, base);
  if (entries.length === 0) return;
  const root = `${base}/${IMPORT_DIR}`;
  const files = await backend.list(root);
  if (files.length > 0) throw new PendingImport(entries, `${files.sort(comparePaths)[0]} is a file directly under ${IMPORT_DIR}/, which holds only an import's directory`);
  const plans: (() => Promise<void>)[] = [];
  for (const name of (await backend.dirs(root)).sort(comparePaths)) {
    const where = `${IMPORT_DIR}/${name}`;
    const refuse = (what: string, why: string): never => {
      throw new PendingImport(entries, `${where}/${what} ${why}`);
    };
    if (!isUuidv7(name)) throw new PendingImport(entries, `${where} is not an import this version recorded`);
    const dir = `${root}/${name}`;
    const held = await tree(backend, dir);
    const staged = `${STAGED_DIR}/`;
    const journal = await backend.read(`${dir}/${JOURNAL_FILE}`);
    for (const file of held.files) {
      if (file === JOURNAL_FILE || file.startsWith(staged)) continue;
      if (journal === null && unfinishedStaging(file, (target) => target === JOURNAL_FILE)) continue;
      refuse(file, journal === null ? "is neither the journal, its unfinished write, nor staging" : "is neither the journal nor staging");
    }
    for (const sub of held.dirs) {
      if (sub === JOURNAL_FILE) refuse(sub, "is a directory, not a journal");
      if (sub !== STAGED_DIR && !sub.startsWith(staged)) refuse(sub, "is a directory an import does not make");
    }
    if (journal === null) {
      for (const file of held.files) {
        if (!file.startsWith(staged)) continue;
        const rel = file.slice(staged.length);
        if (!publishable(rel) && !unfinishedStaging(rel, publishable)) refuse(file, "is not the staging of a path an import publishes, nor its unfinished write, and there is no journal");
      }
      for (const sub of held.dirs) if (sub !== STAGED_DIR && !stagingDirectory(sub.slice(staged.length))) refuse(sub, "is not a directory staging makes, and there is no journal");
      plans.push(() => removeTree(backend, dir));
      continue;
    }
    const items = parseJournal(journal, `${where}/${JOURNAL_FILE}`, entries);
    const named = new Set(items.map((item) => `${staged}${item}`));
    const onTheWay = new Set(items.flatMap((item) => ancestorsOf(item).map((a) => `${staged}${a}`)));
    for (const file of held.files) if (file !== JOURNAL_FILE && !named.has(file)) refuse(file, "is neither the journal nor an item it names");
    for (const sub of held.dirs) if (sub !== STAGED_DIR && !onTheWay.has(sub)) refuse(sub, "is a directory on the way to no item the journal names");
    for (const item of items) {
      if ((await backend.size(`${dir}/${staged}${item}`)) === null && (await backend.size(`${base}/${item}`)) === null) {
        throw new PendingImport(entries, `${item} is neither staged nor at its place: the import can be neither finished nor rolled back`);
      }
    }
    plans.push(() => finish(backend, base, dir, items, entries));
  }
  for (const plan of plans) await plan();
}
