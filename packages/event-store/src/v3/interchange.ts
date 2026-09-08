/**
 * Interchange, version 3: the folder is the form a vault travels in.
 * `exportVault` writes any runtime's vault as a portable folder into an
 * empty backend, as one consistent cut taken and copied under the
 * writer lock; `restoreFolder` reads a portable folder from one backend
 * into another, empty, one. Both write the portable half only — never
 * `local/`, never `import/` — and both publish by writing `config.json`
 * last, so that a destination interrupted midway is not a vault rather
 * than a vault missing pieces.
 *
 * A folder in a `MemoryBackend` is what a zip unpacks into and is made
 * from; a folder in an `FsBackend` is a directory on disk. Neither
 * function knows which it has.
 */

import { sha256 } from "@noble/hashes/sha2";
import { v7 } from "uuid";

import type { Ownership, VaultBackend } from "../backend/types.js";
import { walk } from "../backend/types.js";
import { DamagedObject, IncompleteSnapshot, InvalidSnapshot, NotAVault } from "./errors.js";
import { isAuthorId, type AuthorId, type Cid, type Damaged, type Event } from "./event.js";
import { canonicalText } from "./jcs.js";
import { checkPath, comparePaths } from "./files.js";
import { rawCidFromDigest, rawCidOf, sortCids } from "./objects.js";
import { MemoryVault, type Held, type KeepUnderLock, type VaultRuntime } from "./vault.js";
import { parseConfig } from "./folder/config.js";
import { checkKeystore } from "./folder/keystore.js";
import { CONFIG_FILE, ESTOC_DIR, EVENTS_DIR, KEYSTORE_FILE, OBJECTS_DIR, authorDir, kindOf, objectPath, segmentPath } from "./folder/layout.js";
import { decodeSegment, encodeLines } from "./folder/lines.js";
import { OWNER_FILE, checkEmpty, checkImport, layoutDamage } from "./folder/vault.js";

/** What an export or a restore wrote, counted. */
export interface Copied {
  /** events rendered or segments' events copied */
  events: number;
  objects: number;
  /** portable files copied: `config.json`, `keystore.json` and every opaque file */
  files: number;
}

// ---- laying a folder down -----------------------------------------------

/** Writes into a destination being laid down as a vault, every path relative to the layout's directory; `config.json` is refused here, since it is the publication. */
interface Lay {
  write(rel: string, bytes: Uint8Array): Promise<void>;
  create(rel: string, source: AsyncIterable<Uint8Array>): Promise<void>;
}

/**
 * Lay a vault down in `into` under `base`: the folder required empty of
 * everything but ownership's own files, before and again after ownership
 * is taken, so that no other create, restore or export lands in the same
 * folder meanwhile; `work` writes everything but `config.json`; then
 * `config.json`, which is what makes it a vault. A failure anywhere is
 * withdrawn as `withdraw` says. Ownership is released either way.
 */
async function laying<T>(into: VaultBackend, base: string, config: Uint8Array, work: (lay: Lay) => Promise<T>): Promise<T> {
  await checkEmpty(into, base);
  const ownership: Ownership = await into.own(`${base}/${OWNER_FILE}`);
  const written: string[] = [];
  const at = (rel: string): string => {
    if (rel === CONFIG_FILE) throw new Error(`${CONFIG_FILE} is written last, by publication`);
    written.push(`${base}/${rel}`);
    return `${base}/${rel}`;
  };
  try {
    await checkEmpty(into, base);
    const result = await work({
      write: (rel, bytes) => into.write(at(rel), bytes),
      create: (rel, source) => into.create(at(rel), source),
    });
    await into.write(`${base}/${CONFIG_FILE}`, config);
    return result;
  } catch (err) {
    await withdraw(into, base, written);
    throw err;
  } finally {
    await ownership.release();
  }
}

/**
 * What a failed laying leaves behind. A write that rejects may still
 * have landed its bytes, and the publication's are the ones that
 * matter: `config.json` is removed first and required gone before
 * anything else is touched, and then the rest is taken back, as far as
 * the backend allows. When the publication cannot be withdrawn the rest
 * is left standing too: everything else was written whole before the
 * publication began, so under a `config.json` that stands the folder is
 * a complete vault, while taking the rest back from under it would leave
 * one that opens on nothing.
 */
async function withdraw(into: VaultBackend, base: string, written: string[]): Promise<void> {
  const config = `${base}/${CONFIG_FILE}`;
  await into.remove(config).catch(() => undefined);
  if ((await into.size(config).catch(() => 0)) !== null) return;
  for (const path of written.reverse()) await into.remove(path).catch(() => undefined);
}

/**
 * `stream` copied to `rel` through `create`, the chunks passed through
 * `through` on the way. The stream is this function's to end: cancelled
 * once `create` has settled, whether the copy ran to its end, failed
 * midway, or never began — a destination that fails before it pulls
 * leaves the stream, and whatever it holds open or latched, untouched
 * otherwise.
 */
async function copy(lay: Lay, rel: string, stream: ReadableStream<Uint8Array>, through: (chunks: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array> = (chunks) => chunks): Promise<void> {
  const reader = stream.getReader();
  try {
    await lay.create(rel, through(chunksFrom(reader)));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function* chunksFrom(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<Uint8Array> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

// ---- export ---------------------------------------------------------------

export interface ExportOptions {
  /**
   * The exact held roots of the cut, computed under the writer lock from
   * the events the export reads: every one must be a present, sound
   * object, or the export aborts unpublished. What the vault's fold
   * supplies; the same function `collect` takes.
   */
  heldRoots: KeepUnderLock;
  /** the layout's directory in `into`, relative to the backend's root; `.estoc` when left out */
  base?: string;
}

/** What an export wrote, and the objects it left out. */
export interface Exported extends Copied {
  /** objects no held root names whose bytes were found not to spell their name, or which had gone: left out, the rest written */
  skipped: Damaged[];
}

/**
 * Any runtime's vault as a portable folder in an empty backend: under
 * the writer lock, one cut — every event, every portable file, every
 * present object, and the held roots computed from that event set — is
 * selected, copied and verified, and only then published by writing
 * `config.json`; erasure, collection, commits and file writes wait
 * meanwhile, so nothing of the cut goes dangling while it is copied.
 *
 * Events are rendered afresh, one segment per author, each line the
 * event's RFC 8785 canonical bytes and an LF; a folder vault's own
 * segment files are not copied, and nothing about them is remembered. An
 * event set with damage or a conflict in it is not a consistent cut:
 * the export aborts. `config.json` and `keystore.json` are checked as a
 * restore would check them, so that what is published restores. Every
 * object is copied through the store's own verified stream: a held root
 * found missing or damaged aborts the export; any other object found
 * damaged or gone is skipped and reported, since nothing retains it.
 * Nothing under `local/` or `import/` is read.
 */
export async function exportVault(runtime: VaultRuntime, into: VaultBackend, options: ExportOptions): Promise<Exported> {
  const base = options.base ?? ESTOC_DIR;
  return runtime.locked(async (held) => {
    const cut = await select(held, options.heldRoots);
    return laying(into, base, cut.config, async (lay) => {
      const skipped: Damaged[] = [];
      let files = 1;
      for (const [rel, bytes] of cut.files) {
        await lay.write(rel, bytes);
        files += 1;
      }
      let objects = 0;
      for (const cid of cut.objects) {
        const rel = objectPath(cid);
        const required = cut.roots.has(cid);
        try {
          const stream = await held.objects.open(cid);
          if (stream === null) throw new IncompleteSnapshot([{ where: rel, error: "the object is not present" }]);
          await copy(lay, rel, stream);
          objects += 1;
        } catch (err) {
          if (required) throw err instanceof IncompleteSnapshot ? err : new IncompleteSnapshot([{ where: rel, error: message(err) }]);
          if (!(err instanceof DamagedObject || err instanceof IncompleteSnapshot)) throw err;
          skipped.push({ where: rel, error: message(err) });
        }
      }
      for (const [author, events] of cut.events) await lay.write(segmentPath(author, v7()), encodeLines(events));
      return { events: cut.count, objects, files, skipped };
    });
  });
}

/** The cut an export copies, selected under the lock: nothing of it can change until the export is done. */
interface Cut {
  config: Uint8Array;
  /** every portable file but `config.json`, in path order */
  files: [string, Uint8Array][];
  /** the events, by author in author order, each author's in canonical order */
  events: Map<AuthorId, Event[]>;
  count: number;
  /** every present object, in binary-CID order */
  objects: Cid[];
  /** the held roots of the cut, each required present */
  roots: Set<Cid>;
}

async function select(held: Held, heldRoots: KeepUnderLock): Promise<Cut> {
  const problems: Damaged[] = [
    ...(await held.events.damaged()).map(({ where, error }) => ({ where, error })),
    ...(await held.events.conflicting()).map((conflict) => ({ where: `events:${conflict.eventId}`, error: "the same eventId with different canonical bytes" })),
  ];
  const events = new Map<AuthorId, Event[]>();
  let count = 0;
  for await (const event of held.events.scan()) {
    const mine = events.get(event.author);
    if (mine === undefined) events.set(event.author, [event]);
    else mine.push(event);
    count += 1;
  }
  const files: [string, Uint8Array][] = [];
  let config: Uint8Array | null = null;
  let keystore: Uint8Array | null = null;
  for (const rel of await held.files.list()) {
    const bytes = await held.files.read(rel);
    if (bytes === null) continue;
    if (rel === CONFIG_FILE) config = bytes;
    else {
      if (rel === KEYSTORE_FILE) keystore = bytes;
      files.push([rel, bytes]);
    }
  }
  if (config === null) throw new NotAVault(`no ${CONFIG_FILE} to export`);
  parseConfig(config, CONFIG_FILE);
  if (keystore === null) throw new NotAVault(`no ${KEYSTORE_FILE} to export: a snapshot carries the seed's wrapper`);
  checkKeystore(keystore, KEYSTORE_FILE);
  const objects: Cid[] = [];
  for await (const cid of held.objects.list()) objects.push(cid);
  const present = new Set(objects);
  const roots = new Set(sortCids([...(await heldRoots(held))].map((cid) => rawCidOf(cid).text as Cid)));
  for (const root of roots) {
    if (!present.has(root)) problems.push({ where: objectPath(root), error: "a held root is not present" });
  }
  if (problems.length > 0) throw new IncompleteSnapshot(problems);
  return { config, files, events: new Map([...events].sort(([a], [b]) => comparePaths(a, b))), count, objects: sortCids(objects), roots };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- restore --------------------------------------------------------------

export interface RestoreOptions {
  /**
   * The exact held roots of the source's event set, which the fold
   * computes over that set held as a vault in memory: every one must be
   * among the source's objects, or the source is not a complete
   * snapshot and nothing is written. The same function `collect` and
   * `exportVault` take.
   */
  heldRoots: KeepUnderLock;
  /** the layout's directory in `into`, relative to the backend's root; `.estoc` when left out */
  base?: string;
  /** the layout's directory in `from`; `.estoc` when left out */
  fromBase?: string;
}

/**
 * A portable folder read from `from` into the empty backend `into`,
 * validated first and written second: `config.json` parsed and
 * `keystore.json` checked by shape; the source's `import/` required
 * empty, since whatever stands there is an import its owner has not
 * finished, and leaving it out does not make what `events/` and
 * `objects/` hold complete; every structural root holding only what the
 * layout defines, an empty directory that is not one included; every
 * path conforming; every segment decoded whole, each line its event's
 * canonical bytes under the directory's author, a fragment or a
 * conflict refused; every held root of that event set present among the
 * objects; every object's bytes required to hash to its name as they
 * are copied. Nothing is written until everything but the objects has
 * passed, and a failure leaves no `config.json`. The source's `local/`
 * and `import/` are never read, whatever a hand-made archive put there:
 * recovery state is the source backend's to finish, never instructions
 * for the target, and a staged half-object is not a portable file. The
 * target opens as a new replica.
 */
export async function restoreFolder(from: VaultBackend, into: VaultBackend, options: RestoreOptions): Promise<Copied> {
  const base = options.base ?? ESTOC_DIR;
  const fromBase = options.fromBase ?? ESTOC_DIR;
  const source = await preflight(from, fromBase, options.heldRoots);
  return laying(into, base, source.config, async (lay) => {
    await lay.write(KEYSTORE_FILE, source.keystore);
    for (const [rel, bytes] of source.segments) await lay.write(rel, bytes);
    for (const rel of source.opaque) await copy(lay, rel, await opened(from, `${fromBase}/${rel}`, rel));
    for (const cid of source.objects) {
      const rel = objectPath(cid);
      await copy(lay, rel, await opened(from, `${fromBase}/${rel}`, rel), (chunks) => verifying(cid, rel, chunks));
    }
    return { events: source.events, objects: source.objects.length, files: 2 + source.opaque.length };
  });
}

/** The source as `preflight` read it: what to write, the objects still to verify while copied. */
interface Source {
  config: Uint8Array;
  keystore: Uint8Array;
  segments: [string, Uint8Array][];
  events: number;
  objects: Cid[];
  opaque: string[];
}

async function preflight(from: VaultBackend, fromBase: string, heldRoots: KeepUnderLock): Promise<Source> {
  const config = await from.read(`${fromBase}/${CONFIG_FILE}`);
  if (config === null) throw new NotAVault(`no ${fromBase}/${CONFIG_FILE}: not a vault`);
  parseConfig(config, CONFIG_FILE);
  await checkImport(from, fromBase);
  const problems: Damaged[] = [];
  const keystore = await from.read(`${fromBase}/${KEYSTORE_FILE}`);
  if (keystore === null) problems.push({ where: KEYSTORE_FILE, error: "absent: a snapshot carries the seed's wrapper" });
  else {
    try {
      checkKeystore(keystore, KEYSTORE_FILE);
    } catch (err) {
      problems.push({ where: KEYSTORE_FILE, error: message(err) });
    }
  }
  const source: Source = { config, keystore: keystore ?? new Uint8Array(), segments: [], events: 0, objects: [], opaque: [] };
  const misplaced = await misplacedDirectories(from, fromBase);
  problems.push(...misplaced);
  const events: Event[] = [];
  const seen = new Map<string, string>();
  const prefix = `${fromBase}/`;
  for (const path of await walk(from, fromBase)) {
    const rel = path.slice(prefix.length);
    if (misplaced.some((dir) => rel.startsWith(`${dir.where}/`))) continue;
    try {
      checkPath(rel);
    } catch (err) {
      problems.push({ where: rel, error: message(err) });
      continue;
    }
    switch (kindOf(rel)) {
      case "config":
      case "keystore":
      case "local":
      case "import":
        break;
      case "damage":
        problems.push({ where: rel, error: "an entry the layout does not define inside a structural root" });
        break;
      case "opaque":
        source.opaque.push(rel);
        break;
      case "object":
        source.objects.push(rel.split("/")[1] as Cid);
        break;
      case "segment": {
        const bytes = await from.read(path);
        if (bytes === null) break;
        const read = decodeSegment(bytes, rel, rel.split("/")[1] as string);
        for (const { where, error } of read.damaged) problems.push({ where, error });
        for (const decoded of read.events) {
          const text = canonicalText(decoded.event);
          const before = seen.get(decoded.event.eventId);
          if (before === undefined) {
            seen.set(decoded.event.eventId, text);
            events.push(decoded.event);
          } else if (before !== text) problems.push({ where: `${rel}:${decoded.n}`, error: `${decoded.event.eventId} again with different canonical bytes` });
        }
        source.segments.push([rel, bytes]);
        break;
      }
    }
  }
  if (problems.length > 0) throw new InvalidSnapshot(problems);
  const present = new Set(source.objects);
  for (const root of await rootsOf(events, heldRoots)) {
    if (!present.has(root)) problems.push({ where: objectPath(root), error: "a held root is not present" });
  }
  if (problems.length > 0) throw new InvalidSnapshot(problems);
  source.events = seen.size;
  source.objects = sortCids(source.objects);
  source.opaque.sort(comparePaths);
  return source;
}

/**
 * The directories in the structural roots that the layout does not
 * define, which a walk of the files would pass over when they are
 * empty: a file where `import/` or `local/` belongs and a directory
 * where a singleton belongs besides.
 */
async function misplacedDirectories(from: VaultBackend, fromBase: string): Promise<Damaged[]> {
  const damaged = await layoutDamage(from, fromBase);
  const events = `${fromBase}/${EVENTS_DIR}`;
  for (const name of await from.dirs(events)) {
    if (!isAuthorId(name)) {
      damaged.push({ where: authorDir(name), error: "not an author directory: the name is not a canonical UUIDv7" });
      continue;
    }
    for (const sub of await from.dirs(`${events}/${name}`)) damaged.push({ where: `${authorDir(name)}/${sub}`, error: "a directory where a segment belongs" });
  }
  for (const name of await from.dirs(`${fromBase}/${OBJECTS_DIR}`)) damaged.push({ where: objectPath(name), error: "a directory where an object belongs" });
  return damaged.sort((a, b) => comparePaths(a.where, b.where));
}

/** The held roots of `events`, as the fold computes them over the set held as a vault in memory. */
async function rootsOf(events: Event[], heldRoots: KeepUnderLock): Promise<Cid[]> {
  const vault = new MemoryVault();
  await vault.ingest(events);
  return vault.locked(async (held) => sortCids([...(await heldRoots(held))].map((cid) => rawCidOf(cid).text as Cid)));
}

async function opened(from: VaultBackend, path: string, rel: string): Promise<ReadableStream<Uint8Array>> {
  const stream = await from.open(path);
  if (stream === null) throw new InvalidSnapshot([{ where: rel, error: "gone between the source's listing and its reading" }]);
  return stream;
}

/** `chunks` passed through, hashed; the object refused at its end when the bytes do not spell `cid`, so that `create` leaves nothing. */
async function* verifying(cid: Cid, rel: string, chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const hash = sha256.create();
  for await (const chunk of chunks) {
    hash.update(chunk);
    yield chunk;
  }
  if (rawCidFromDigest(hash.digest()).text !== cid) throw new InvalidSnapshot([{ where: rel, error: "the bytes do not hash to the name" }]);
}
