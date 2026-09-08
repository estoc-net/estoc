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
import type { AuthorId, Cid, Damaged, Event } from "./event.js";
import { canonicalText } from "./jcs.js";
import { checkPath, comparePaths } from "./files.js";
import { chunksOf, rawCidFromDigest, rawCidOf, sortCids } from "./objects.js";
import type { Held, KeepUnderLock, VaultRuntime } from "./vault.js";
import { parseConfig } from "./folder/config.js";
import { checkKeystore } from "./folder/keystore.js";
import { CONFIG_FILE, ESTOC_DIR, KEYSTORE_FILE, kindOf, objectPath, segmentPath } from "./folder/layout.js";
import { decodeSegment, encodeLines } from "./folder/lines.js";
import { OWNER_FILE, checkEmpty } from "./folder/vault.js";

/** What an export or a restore wrote, counted. */
export interface Copied {
  /** events rendered or segments' events copied */
  events: number;
  /** objects copied */
  objects: number;
  /** portable files copied: `config.json`, `keystore.json` and every opaque file */
  files: number;
}

// ---- laying a folder down -----------------------------------------------

/**
 * Writes into a destination that is being laid down as a vault: every
 * path relative to the layout's directory, and every one remembered, so
 * that a failure can take back what was written. `config.json` is not
 * written through here: it is the publication, and `laying` writes it
 * last.
 */
interface Lay {
  write(rel: string, bytes: Uint8Array): Promise<void>;
  create(rel: string, source: AsyncIterable<Uint8Array>): Promise<void>;
}

/**
 * Lay a vault down in `into` under `base`: the folder required empty of
 * everything but ownership's own files, before and again after ownership
 * is taken, so that no other create, restore or export lands in the same
 * folder meanwhile; `work` writes everything but `config.json`; then
 * `config.json`, which is what makes it a vault. A failure anywhere
 * takes back what was written, as far as the backend allows, and leaves
 * no `config.json`: an unpublished destination, never one that looks
 * complete. Ownership is released either way.
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
    for (const path of written.reverse()) await into.remove(path).catch(() => undefined);
    throw err;
  } finally {
    await ownership.release();
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
 * the export aborts. Every object is copied through the store's own
 * verified stream: a held root found missing or damaged aborts the
 * export; any other object found damaged or gone is skipped and
 * reported, since nothing retains it. Nothing under `local/` or
 * `import/` is read.
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
          await lay.create(rel, chunksOf(stream));
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
  /** every present object, in CID order */
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
  for (const rel of await held.files.list()) {
    const bytes = await held.files.read(rel);
    if (bytes === null) continue;
    if (rel === CONFIG_FILE) config = bytes;
    else files.push([rel, bytes]);
  }
  if (config === null) throw new NotAVault(`no ${CONFIG_FILE} to export`);
  const objects: Cid[] = [];
  for await (const cid of held.objects.list()) objects.push(cid);
  objects.sort((a, b) => comparePaths(a, b));
  const present = new Set(objects);
  const roots = new Set(sortCids([...(await heldRoots(held))].map((cid) => rawCidOf(cid).text as Cid)));
  for (const root of roots) {
    if (!present.has(root)) problems.push({ where: objectPath(root), error: "a held root is not present" });
  }
  if (problems.length > 0) throw new IncompleteSnapshot(problems);
  return { config, files, events: new Map([...events].sort(([a], [b]) => comparePaths(a, b))), count, objects, roots };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- restore --------------------------------------------------------------

export interface RestoreOptions {
  /** the layout's directory in `into`, relative to the backend's root; `.estoc` when left out */
  base?: string;
  /** the layout's directory in `from`; `.estoc` when left out */
  fromBase?: string;
}

/**
 * A portable folder read from `from` into the empty backend `into`,
 * validated first and written second: `config.json` parsed and
 * `keystore.json` checked by shape; every path conforming and of a kind
 * the layout defines, an entry the layout does not define inside a
 * structural root refused; every segment decoded whole, each line its
 * event's canonical bytes under the directory's author, a fragment or
 * a conflict refused; every object's bytes required to hash to its name
 * as they are copied. Nothing is written until everything but the
 * objects has passed, and a failure leaves no `config.json`. The
 * source's `local/` and `import/` are never read, whatever a hand-made
 * archive put there: recovery state is the source backend's to finish,
 * never instructions for the target, and a staged half-object is not a
 * portable file. The target opens as a new replica.
 */
export async function restoreFolder(from: VaultBackend, into: VaultBackend, options: RestoreOptions = {}): Promise<Copied> {
  const base = options.base ?? ESTOC_DIR;
  const fromBase = options.fromBase ?? ESTOC_DIR;
  const source = await preflight(from, fromBase);
  return laying(into, base, source.config, async (lay) => {
    await lay.write(KEYSTORE_FILE, source.keystore);
    for (const [rel, bytes] of source.segments) await lay.write(rel, bytes);
    for (const rel of source.opaque) await lay.create(rel, await opened(from, `${fromBase}/${rel}`, rel));
    for (const cid of source.objects) {
      const rel = objectPath(cid);
      await lay.create(rel, verifying(cid, rel, await opened(from, `${fromBase}/${rel}`, rel)));
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

async function preflight(from: VaultBackend, fromBase: string): Promise<Source> {
  const config = await from.read(`${fromBase}/${CONFIG_FILE}`);
  if (config === null) throw new NotAVault(`no ${fromBase}/${CONFIG_FILE}: not a vault`);
  parseConfig(config, CONFIG_FILE);
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
  const seen = new Map<string, string>();
  const prefix = `${fromBase}/`;
  for (const path of await walk(from, fromBase)) {
    const rel = path.slice(prefix.length);
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
          if (before === undefined) seen.set(decoded.event.eventId, text);
          else if (before !== text) problems.push({ where: `${rel}:${decoded.n}`, error: `${decoded.event.eventId} again with different canonical bytes` });
        }
        source.segments.push([rel, bytes]);
        break;
      }
    }
  }
  if (problems.length > 0) throw new InvalidSnapshot(problems);
  source.events = seen.size;
  source.objects = sortCids(source.objects);
  source.opaque.sort(comparePaths);
  return source;
}

async function opened(from: VaultBackend, path: string, rel: string): Promise<AsyncIterable<Uint8Array>> {
  const stream = await from.open(path);
  if (stream === null) throw new InvalidSnapshot([{ where: rel, error: "gone between the source's listing and its reading" }]);
  return chunksOf(stream);
}

/** `source` passed through, hashed; the object refused at its end when the bytes do not spell `cid`, so that `create` leaves nothing. */
async function* verifying(cid: Cid, rel: string, source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const hash = sha256.create();
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
  if (rawCidFromDigest(hash.digest()).text !== cid) throw new InvalidSnapshot([{ where: rel, error: "the bytes do not hash to the name" }]);
}
