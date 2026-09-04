/**
 * Interchange (event-store.md §10, vault-folder.md §10): the folder is
 * the form a vault travels in. `snapshot` takes a folder's tree,
 * `exportVault` renders any store's as one, `importVault` reads one into
 * any store by the one algorithm of §10.3, `restoreFolder` copies one
 * into an empty backend. The tree in memory is `VaultFiles`: vault-
 * relative path → bytes, `.estoc/config.json` and on — what a zip holds
 * (`zip.ts`) and what a backend unpacks.
 */

import type { VaultBackend } from "./backend/types.js";
import { walk } from "./backend/types.js";
import type { BlobStore } from "./blobs.js";
import { checkBlock, reachable } from "./blocks.js";
import { BadBlock, ForkedSelf, NotAVault, NotSameVault } from "./errors.js";
import { EidMinter, compareEvents, type Cid, type DamagedLine, type Event, type Ingested } from "./event.js";
import { checkPath } from "./files.js";
import { readConfig } from "./folder/config.js";
import {
  BLOBS_DIR,
  CONFIG_FILE,
  DEVICES_DIR,
  ESTOC_DIR,
  EXTENSIONS_DIR,
  KEYSTORE_FILE,
  LOCAL_DIR,
  SELF_FILE,
  concat,
  isStoreDir,
  jsonLine,
  kindOf,
  prettyJson,
  text,
  type PathKind,
} from "./folder/layout.js";
import { decodeEvent, decodeSegment } from "./folder/lines.js";
import { DEVICE_MINTED } from "./folder/vault.js";
import { isJsonObject, sameJson, type JsonObject } from "./json.js";
import type { Stores, VaultStores } from "./vault.js";

/** The interchange tree in memory: vault-relative path (`.estoc/…`) → bytes. */
export type VaultFiles = Record<string, Uint8Array>;

/** `.estoc/config.json`: where every reader starts. */
export const CONFIG_PATH = `${ESTOC_DIR}/${CONFIG_FILE}`;

const ROOT = `${ESTOC_DIR}/`;
const LOCAL = `${ROOT}${LOCAL_DIR}/`;
const LOCAL_PATH = `${ROOT}${LOCAL_DIR}`;
const SELF_PATH = `${LOCAL}${SELF_FILE}`;

/** Whether `path` is in a snapshot (vault-folder.md §10.1): under `.estoc/` and not this copy's own. */
export function isSnapshotPath(path: string): boolean {
  return path.startsWith(ROOT) && !path.startsWith(LOCAL);
}

// ---- snapshot and export -------------------------------------------------

/** Everything under `.estoc/` except `local/` (vault-folder.md §10.1), byte for byte. */
export async function snapshot(backend: VaultBackend): Promise<VaultFiles> {
  const files: VaultFiles = {};
  for (const path of await walk(backend, ESTOC_DIR)) {
    if (!isSnapshotPath(path)) {
      continue;
    }
    const bytes = await backend.read(path);
    if (bytes !== null) {
      files[path] = bytes;
    }
  }
  return files;
}

export interface ExportOptions {
  /** what the segments minted at export are named after; the wall clock when left out */
  clock?: () => Date;
}

/**
 * Any store's vault as a folder (§10.2): every event a line under
 * `devices/<author>/`, one segment per author minted now; every block
 * under `blobs/`; every file in place; each extension store the same
 * way under `extensions/<ext>/`; no `local/`. Nothing about the chunking
 * is remembered. A folder store's export is `snapshot`.
 */
export async function exportVault(vault: VaultStores, options: ExportOptions = {}): Promise<VaultFiles> {
  const clock = options.clock ?? (() => new Date());
  const names = new EidMinter();
  const mint = (): string => names.mint(clock().getTime());
  const files: VaultFiles = {};
  for (const path of await vault.files.list()) {
    const bytes = await vault.files.read(path);
    if (bytes !== null) {
      files[`${ROOT}${path}`] = bytes;
    }
  }
  await render(vault, ROOT, files, mint);
  for (const ext of await vault.extensions()) {
    await render(vault.extension(ext), `${ROOT}${EXTENSIONS_DIR}/${ext}/`, files, mint);
  }
  return files;
}

/** One store's events and blocks into `into` under `base`. */
async function render(stores: Stores, base: string, into: VaultFiles, mint: () => string): Promise<void> {
  const byAuthor = new Map<string, Uint8Array[]>();
  for await (const event of stores.events.scan()) {
    const lines = byAuthor.get(event.author);
    if (lines === undefined) {
      byAuthor.set(event.author, [jsonLine(event)]);
    } else {
      lines.push(jsonLine(event));
    }
  }
  for (const [author, lines] of [...byAuthor].sort(([a], [b]) => (a < b ? -1 : 1))) {
    into[`${base}${DEVICES_DIR}/${author}/${mint()}.jsonl`] = concat(lines);
  }
  for (const cid of await stores.blobs.list()) {
    const bytes = await stores.blobs.getBlock(cid);
    if (bytes !== null) {
      into[`${base}${BLOBS_DIR}/${cid}`] = bytes;
    }
  }
}

// ---- reading a source --------------------------------------------------

/** One store's half of a source: every line that was an event, in path order, not deduplicated; every block by name. */
interface SourceStore {
  events: Event[];
  blocks: Map<string, Uint8Array>;
}

interface Source {
  config: JsonObject;
  vault: SourceStore;
  /** by ext, in order */
  exts: Map<string, SourceStore>;
  /** every file, by path relative to `.estoc/`; `config.json` excluded */
  files: Map<string, Uint8Array>;
  damaged: DamagedLine[];
}

function emptyStore(): SourceStore {
  return { events: [], blocks: new Map() };
}

/**
 * The whole source, read (§10.3 preflight): `config.json` first, or
 * `NotAVault`; then every line of every segment under `devices/<dev>/`
 * and `extensions/<ext>/devices/<dev>/` decoded (vault-folder.md §4), every block
 * named, every file kept. `local/` and anything outside `.estoc/` is
 * not looked at.
 */
function readSource(files: VaultFiles): Source {
  const config = files[CONFIG_PATH];
  if (config === undefined) {
    throw new NotAVault(`no ${CONFIG_PATH} in the source`);
  }
  const source: Source = { config: readConfig(config), vault: emptyStore(), exts: new Map(), files: new Map(), damaged: [] };
  for (const { path, rel, kind } of sourcePaths(files)) {
    if (path === CONFIG_PATH) {
      continue;
    }
    const bytes = files[path] as Uint8Array;
    if (kind === "file") {
      source.files.set(rel, bytes);
      continue;
    }
    const parts = rel.split("/");
    let store = source.vault;
    if (parts[0] === EXTENSIONS_DIR) {
      const ext = parts[1] as string;
      store = source.exts.get(ext) ?? emptyStore();
      source.exts.set(ext, store);
      parts.splice(0, 2);
    }
    if (kind === "segment") {
      const dev = parts[1] as string;
      const read = decodeSegment(bytes, path, (line) => decodeEvent(line, dev));
      store.events.push(...read.events);
      source.damaged.push(...read.damaged);
    } else {
      store.blocks.set(parts[1] as string, bytes);
    }
  }
  return source;
}

/**
 * The paths of a source that a reader writes, in order — under `.estoc/`,
 * not `local/` — each checked as every store checks a path (`files.ts`),
 * and the tree checked as one a folder can hold (`checkTree`): what a
 * store would refuse, or a file system could not lay down, refuses the
 * import here, not after the events went in.
 */
function sourcePaths(files: VaultFiles): { path: string; rel: string; kind: Exclude<PathKind, "local"> }[] {
  const found: { path: string; rel: string; kind: Exclude<PathKind, "local"> }[] = [];
  for (const path of Object.keys(files).sort()) {
    if (!isSnapshotPath(path)) {
      continue;
    }
    const rel = path.slice(ROOT.length);
    try {
      checkPath(rel);
    } catch (err) {
      throw new NotAVault(`not a vault path: ${JSON.stringify(path)} (${err instanceof Error ? err.message : String(err)})`);
    }
    const kind = kindOf(rel);
    if (kind === "local" && rel !== LOCAL_DIR) {
      continue;
    }
    if (kind !== "segment" && kind !== "blob" && isStoreDir(rel)) {
      throw new NotAVault(`not a vault path: ${JSON.stringify(path)} is a file where the layout has a directory`);
    }
    found.push({ path, rel, kind: kind as Exclude<PathKind, "local"> });
  }
  checkTree(found.map((f) => f.rel), "the source");
  return found;
}

/** Refuse a set of paths a file system could not hold at once: one that is a file and a directory both. */
function checkTree(paths: string[], whose: string): void {
  const set = new Set(paths);
  for (const path of paths) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join("/");
      if (set.has(ancestor)) {
        throw new NotAVault(`${whose}: ${ancestor} is a file and a directory both (${path})`);
      }
    }
  }
}

// ---- import ------------------------------------------------------------

/**
 * What the import asks of the folds (§10.3): which roots the merged
 * event set holds, and which extensions it says are purged — read from
 * event types the store does not know. Left out, every root any event
 * names is held and nothing is purged: a merge that knows no type.
 */
export interface ImportPolicy {
  /** The roots held over `events`, the merged set of one store (`vault-events.md` §8.3); `store` is `vault` or the ext. */
  held?(store: string, events: Event[]): Cid[] | Promise<Cid[]>;
  /** The extensions the fold over the merged vault set says are purged (`vault-events.md` §7.3): not read. */
  purged?(events: Event[]): string[] | Promise<string[]>;
  /** The extensions the merged vault set accounts for; when given, a store read that is not among them is reported. */
  installed?(events: Event[]): string[] | Promise<string[]>;
}

export interface Imported {
  /** `restored` when this store held no `config.json`: the source's was written last */
  kind: "merged" | "restored";
  /** what `ingest` did, per store: `vault`, then each extension read */
  events: Record<string, Ingested>;
  blobs: {
    copied: number;
    /** blocks of the source that fail the check (§5.1): damage there, not copied */
    damaged: { store: string; cid: string; error: string }[];
  };
  files: {
    /** paths copied because absent here */
    copied: string[];
    /** key names the source's `keystore.json` listed that this one did not */
    keysAdded: number;
  };
  /** devices whose events arrived without their `device.minted` in the merged vault set */
  incomplete: string[];
  /** extension stores the source holds that the fold says are purged: not read */
  purged: string[];
  /** extension stores read that no `extension.installed` accounts for (when the policy can say) */
  unaccounted: string[];
  /** lines of the source that were not events */
  damaged: DamagedLine[];
}

/**
 * Read `files` into `target` by §10.3: preflight — a version-2 vault,
 * the same `config.json` as this one's, no forked self in any store the
 * import will write — with nothing written on any failure; then the
 * events, the blobs a held root reaches, the files by their policies;
 * then each extension store the fold lets in. Into a store with no
 * `config.json` it is a restore — the same steps into an empty store,
 * and the config is written last.
 */
export async function importVault(target: VaultStores, files: VaultFiles, policy: ImportPolicy = {}): Promise<Imported> {
  const source = readSource(files);
  const config = await target.files.read(CONFIG_FILE);
  const restore = config === null;
  const mine = await target.files.list();
  const held = await heldBy(target.events);
  if (restore) {
    if (mine.length > 0 || held.size > 0 || (await target.blobs.list()).length > 0 || (await target.extensions()).length > 0) {
      throw new NotAVault("this store holds no config.json but is not empty: a restore needs an empty store");
    }
  } else if (!sameJson(readConfig(config), source.config)) {
    throw new NotSameVault(`the source's ${CONFIG_FILE} is not this vault's: another identity, or another format`);
  }
  const keystore = planKeystore(source.files.get(KEYSTORE_FILE), await target.files.read(KEYSTORE_FILE));
  // a folder no store wrote (vault-folder.md §9.6): a file of this vault's where a store has its directory
  for (const path of mine) {
    if (isStoreDir(path)) {
      throw new NotAVault(`this vault's files: ${path} is a file where the layout has a directory`);
    }
  }

  // the merged vault set, for the folds; the fork check over every store before the first write
  const self = target.events.self;
  const mergedVault = merged(held, source.vault.events);
  const purged = new Set(await policy.purged?.(mergedVault));
  const installed = policy.installed === undefined ? null : new Set(await policy.installed(mergedVault));
  // the files this will write — absent here, not a purged extension's — must fit among the files here: none a file and a directory both
  const have = new Set(mine);
  const purgedList = [...purged];
  checkTree([...mine, ...[...source.files.keys()].filter((path) => !have.has(path) && !underAny(path, purgedList))], "this vault's files");
  const forked = forksIn(self, held, source.vault.events);
  const exts: { ext: string; stores: Stores; source: SourceStore; merged: Event[] }[] = [];
  for (const [ext, src] of source.exts) {
    if (purged.has(ext)) {
      continue;
    }
    const stores = target.extension(ext);
    const heldExt = await heldBy(stores.events);
    forked.push(...forksIn(self, heldExt, src.events));
    exts.push({ ext, stores, source: src, merged: merged(heldExt, src.events) });
  }
  if (forked.length > 0) {
    throw new ForkedSelf(self, forked);
  }
  const minted = new Set(mergedVault.filter((event) => event.type === DEVICE_MINTED).map((event) => event.author));
  const authors = new Set([source.vault, ...exts.map((e) => e.source)].flatMap((store) => store.events.map((event) => event.author)));
  const report: Imported = {
    kind: restore ? "restored" : "merged",
    events: {},
    blobs: { copied: 0, damaged: [] },
    files: { copied: [], keysAdded: keystore.added },
    incomplete: [...authors].filter((dev) => !minted.has(dev)).sort(),
    purged: [...source.exts.keys()].filter((ext) => purged.has(ext)),
    unaccounted: installed === null ? [] : exts.map((e) => e.ext).filter((ext) => !installed.has(ext)),
    damaged: source.damaged,
  };

  // 1–3: the vault's events, blobs, files
  report.events["vault"] = await target.events.ingest(source.vault.events);
  await copyBlocks("vault", target.blobs, source.vault.blocks, mergedVault, policy, report);
  for (const [path, bytes] of source.files) {
    if (path === KEYSTORE_FILE) {
      if (keystore.write !== null) {
        await target.files.write(path, keystore.write);
        if (keystore.copied) {
          report.files.copied.push(path);
        }
      }
    } else if (!underAny(path, report.purged) && (await target.files.read(path)) === null) {
      await target.files.write(path, bytes);
      report.files.copied.push(path);
    }
  }
  // then each extension store, by the same two rules
  for (const { ext, stores, source: src, merged: mergedExt } of exts) {
    report.events[ext] = await stores.events.ingest(src.events);
    await copyBlocks(ext, stores.blobs, src.blocks, mergedExt, policy, report);
  }
  if (restore) {
    await target.files.write(CONFIG_FILE, files[CONFIG_PATH] as Uint8Array);
  }
  return report;
}

/** A store's whole set, by eid. */
async function heldBy(events: Stores["events"]): Promise<Map<string, Event>> {
  const held = new Map<string, Event>();
  for await (const event of events.scan()) {
    held.set(event.eid, event);
  }
  return held;
}

/** What `ingest` will leave: what is held, then what came that is not — first in wins — in canonical order. */
function merged(held: Map<string, Event>, incoming: Event[]): Event[] {
  const all = new Map(held);
  for (const event of incoming) {
    if (!all.has(event.eid)) {
      all.set(event.eid, event);
    }
  }
  return [...all.values()].sort(compareEvents);
}

/** The events of `self` among `incoming` that `held` does not have as they are (§4.2): what `ingest` would refuse. */
function forksIn(self: string, held: Map<string, Event>, incoming: Event[]): Event[] {
  const forked: Event[] = [];
  for (const event of incoming) {
    if (event.author !== self) {
      continue;
    }
    const have = held.get(event.eid);
    if (have === undefined || !sameJson(have, event)) {
      forked.push(event);
    }
  }
  return forked;
}

/**
 * Rule 2 (§10.3): a block absent here — a damaged one is absent — and
 * present in the source is copied iff a held root reaches it, walking
 * the blocks either copy holds, and iff it passes the check; one that
 * does not is damage in the source, reported. Damage is absent on the
 * walk too: bytes that fail the check are not a block, so what they
 * link is not reached through them — else a name over another block's
 * bytes would let everything that block links in under no held root.
 */
async function copyBlocks(store: string, blobs: BlobStore, blocks: Map<string, Uint8Array>, events: Event[], policy: ImportPolicy, report: Imported): Promise<void> {
  if (blocks.size === 0) {
    return;
  }
  const roots = policy.held === undefined ? events.flatMap((event) => event.blobs) : await policy.held(store, events);
  // this copy's block when it holds it sound — reading it sets a damaged one aside (§5.1) — else the source's, checked
  const here = new Map<string, boolean>();
  const sound = new Map<string, Uint8Array | null>();
  const reached = await reachable(roots, async (cid) => {
    const mine = await blobs.getBlock(cid);
    here.set(cid, mine !== null);
    if (mine !== null) {
      return mine;
    }
    const theirs = blocks.get(cid);
    if (theirs === undefined) {
      return null;
    }
    let checked = sound.get(cid);
    if (checked === undefined) {
      try {
        await checkBlock(cid, theirs);
        checked = theirs;
      } catch (err) {
        if (!(err instanceof BadBlock)) {
          throw err;
        }
        report.blobs.damaged.push({ store, cid, error: err.message });
        checked = null;
      }
      sound.set(cid, checked);
    }
    return checked;
  });
  for (const [cid, bytes] of [...blocks].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!reached.has(cid) || here.get(cid) === true) {
      continue;
    }
    await blobs.putBlock(cid, bytes);
    report.blobs.copied += 1;
  }
}

/** Whether `path` (relative to `.estoc/`) is inside one of the extension trees named. */
function underAny(path: string, exts: string[]): boolean {
  return exts.some((ext) => path.startsWith(`${EXTENSIONS_DIR}/${ext}/`));
}

/**
 * `keystore.json` (vault-folder.md §6.2): copied when this vault has
 * none; else the seed stays this one's and `keys[]` is the union by
 * name. Decided in preflight, both sides read, so that a keystore that
 * is not one refuses the import before anything is written.
 */
function planKeystore(theirs: Uint8Array | undefined, mine: Uint8Array | null): { write: Uint8Array | null; added: number; copied: boolean } {
  if (theirs === undefined) {
    return { write: null, added: 0, copied: false };
  }
  const b = readKeystore(theirs, "the source's");
  if (mine === null) {
    return { write: theirs, added: 0, copied: true };
  }
  const a = readKeystore(mine, "this vault's");
  const known = new Set(a.keys.map((key) => key["name"]));
  const fresh = b.keys.filter((key) => !known.has(key["name"]));
  if (fresh.length === 0) {
    return { write: null, added: 0, copied: false };
  }
  return { write: prettyJson({ ...a.doc, keys: [...a.keys, ...fresh] }), added: fresh.length, copied: false };
}

/** A key name as `@estoc/keystore` v3 has it (vault-folder.md §6.2). */
const KEY_NAME = /^[A-Za-z0-9._/-]+$/;

/**
 * A keystore as vault-folder.md §6.2 names it: `@estoc/keystore` v3 —
 * `version` 3, `seedJwe` a string, `keys[]` each a name of the grammar,
 * a did and a createdAt, the names unique — or `NotAVault`.
 */
function readKeystore(bytes: Uint8Array, whose: string): { doc: JsonObject; keys: JsonObject[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text(bytes));
  } catch {
    throw new NotAVault(`${whose} ${KEYSTORE_FILE} is not JSON`);
  }
  const bad = (why: string): NotAVault => new NotAVault(`${whose} ${KEYSTORE_FILE} is not a v3 keystore: ${why}`);
  if (!isJsonObject(doc)) {
    throw bad("not an object");
  }
  if (doc["version"] !== 3) {
    throw bad(`version ${JSON.stringify(doc["version"])}`);
  }
  if (typeof doc["seedJwe"] !== "string") {
    throw bad("no seedJwe");
  }
  const keys = doc["keys"];
  if (!Array.isArray(keys)) {
    throw bad("no keys[]");
  }
  const names = new Set<string>();
  for (const key of keys) {
    if (!isJsonObject(key) || ["name", "did", "createdAt"].some((field) => typeof key[field] !== "string")) {
      throw bad("a key without name, did and createdAt");
    }
    const name = key["name"] as string;
    if (!KEY_NAME.test(name)) {
      throw bad(`a key named ${JSON.stringify(name)}`);
    }
    if (names.has(name)) {
      throw bad(`two keys named ${JSON.stringify(name)}`);
    }
    names.add(name);
  }
  return { doc, keys: keys as JsonObject[] };
}

// ---- restore -----------------------------------------------------------

/**
 * A folder store restoring into an empty backend (vault-folder.md
 * §10.4): the snapshot copied as it is, `config.json` last, so that a
 * crash midway leaves no vault rather than a vault missing pieces.
 * Refuses a backend with anything at `.estoc` — a vault, the remains of
 * one, an empty directory the copy would land in — and a source that is
 * not one, before writing. The one thing that may already be there is
 * `local/` without `self.json`: what a device keeps beside a vault
 * rather than in it (a daemon's pid file, a preference, §7) is not the
 * vault, and stays; `self.json` is a previous copy's device pointer, and
 * the restore that has to open as a fresh device refuses it. `local/` in
 * the source, should a hand-made zip carry one, stays out.
 */
export async function restoreFolder(backend: VaultBackend, files: VaultFiles): Promise<{ files: number }> {
  const there = [...(await backend.list(ESTOC_DIR)), ...(await backend.dirs(ESTOC_DIR)).filter((name) => name !== LOCAL_DIR)];
  if (there.length > 0 || (await backend.size(ESTOC_DIR)) !== null) {
    throw new NotAVault(`${ESTOC_DIR} is not empty${there.length > 0 ? ` (${there[0]}${there.length > 1 ? ", …" : ""})` : ""}: a restore needs an empty backend`);
  }
  // anything at that path, a directory of that name included: `size` is null for both absent and directory
  if ((await backend.list(LOCAL_PATH)).includes(SELF_FILE) || (await backend.dirs(LOCAL_PATH)).includes(SELF_FILE)) {
    throw new NotAVault(`${SELF_PATH} is here: a restore opens as a fresh device, and a previous copy's local/ is not an empty backend`);
  }
  const config = files[CONFIG_PATH];
  if (config === undefined) {
    throw new NotAVault(`no ${CONFIG_PATH} in the source`);
  }
  readConfig(config);
  const paths = sourcePaths(files)
    .map((f) => f.path)
    .filter((path) => path !== CONFIG_PATH);
  for (const path of paths) {
    await backend.write(path, files[path] as Uint8Array);
  }
  await backend.write(CONFIG_PATH, config);
  return { files: paths.length + 1 };
}
