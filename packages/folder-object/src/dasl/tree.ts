/**
 * The tree, DASL style: one DRISL document — a MASL manifest in bundle
 * mode (https://dasl.ing/masl.html) — that maps every path of the fact
 * to the raw CID and the size of its bytes:
 *
 *     { "resources": {
 *         "/index.json":     { "src": <tag-42 raw CID>, "size": 213 },
 *         "/files/body.md":  { "src": <tag-42 raw CID>, "size": 89 } } }
 *
 * The root — the object's version identity, the card's `root` — is the
 * drisl CID of that document. A file is one raw block, hashed whole;
 * there are no directory nodes, no chunks, no shards: the manifest *is*
 * the mapping the spec calls a fact, and DRISL makes its bytes a
 * function of it. Verifying a tree is one block for its shape and one
 * block per file for its bytes; resolving a path is two fetches, ever.
 *
 * The manifest is derived, never authored: a reader refuses one that
 * carries anything but exactly these members, or whose paths could not
 * be laid out as a file tree, or whose bytes are not canonical DRISL —
 * so that one mapping has one root, and a root reaches one mapping.
 */

import { checkCid, compareBytes, DRISL_CODE, drislCid, parseCid, RAW_CODE, rawCid } from "./cid.js";
import { decodeDrisl, encodeDrisl, Link, type Drisl } from "./drisl.js";
import type { TreeFiles } from "../types.js";

/**
 * The most bytes a manifest block may have (spec §2.1): it must fit the
 * skeleton's inline budget anyway, and the bound is what a reader
 * decodes before it trusts anything — about ten thousand entries.
 */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** One line of the manifest: a path of the mapping, the raw CID of its bytes, their length. */
export interface ManifestEntry {
  path: string;
  cid: string;
  size: number;
}

/** The result of hashing a mapping. */
export interface HashedManifest {
  /** drisl CID of the manifest block — the card's `root`. */
  root: string;
  /** The manifest block's bytes (canonical DRISL). */
  manifest: Uint8Array;
  /** Every entry, in manifest order (the DRISL key order). */
  entries: ManifestEntry[];
  /**
   * File CID → one path holding those bytes. The complete object set is
   * the manifest block plus the input bytes of every entry here; paths
   * with identical bytes share one CID and one (arbitrary) path.
   */
  files: Map<string, string>;
}

/** The result of verifying a manifest against an object set. */
export interface VerifiedManifest {
  root: string;
  /** Path → raw CID, for every entry. */
  files: Map<string, string>;
  /** Path → size the manifest states. */
  sizes: Map<string, number>;
  /** Raw CID → size, for every leaf the object set does not hold (only with `leaves: "optional"`). */
  missing: Map<string, number>;
  /** Path → its absent CID (one per file: a file is one block), for every file with one. */
  partial: Map<string, string[]>;
  /**
   * Path → size, for every leaf this reader declined to fetch because its
   * stated size exceeds `maxLeafBytes` — unverifiable by this reader, not
   * missing and not malformed (spec §2.1).
   */
  declined: Map<string, number>;
}

export interface VerifyOptions {
  /** `"required"` (default): every leaf must be present. `"optional"`: an absent leaf is recorded, not thrown. */
  leaves?: "required" | "optional";
  /**
   * The largest leaf this reader will fetch and hash; a leaf whose stated
   * `size` is larger is never asked for and lands in `declined`. Absent,
   * every leaf is fetched — the block source must then bound its own reads,
   * since `size` is a claim.
   */
  maxLeafBytes?: number;
}

/** A block source: CID string → bytes, or null when not held. */
export type GetBlock = (cid: string) => Promise<Uint8Array | null>;

/* ------------------------------------------------------------------ paths */

/**
 * Split a `/`-separated relative path, refusing what a file tree cannot
 * hold: an empty segment, `.` or `..`, a NUL byte. Hidden segments are
 * not refused here — whether they belong to a tree is the object
 * layer's rule (spec §4), not the encoding's.
 */
export function segmentsOf(path: string): string[] {
  if (path === "") throw new Error("empty path");
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") throw new Error(`empty segment in ${JSON.stringify(path)}`);
    if (segment === "." || segment === "..") throw new Error(`unsafe path segment in ${JSON.stringify(path)}`);
    if (segment.includes("\0")) throw new Error(`NUL in path ${JSON.stringify(path)}`);
  }
  return segments;
}

/** Refuse a set of paths a file tree cannot hold: a path that is also a directory, or a duplicate. */
function checkLayout(paths: Iterable<string>): void {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const path of paths) {
    const segments = segmentsOf(path);
    if (files.has(path)) throw new Error(`duplicate path: ${path}`);
    files.add(path);
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  for (const path of files) {
    if (dirs.has(path)) throw new Error(`${path} is both a file and a directory`);
  }
}

/* --------------------------------------------------------------- manifest */

/** One `src`, one `size`: two entries that share bytes and disagree about their length were not computed over a mapping. */
function checkSizes(entries: Iterable<ManifestEntry>): void {
  const sizes = new Map<string, number>();
  for (const { path, cid, size } of entries) {
    const seen = sizes.get(cid);
    if (seen !== undefined && seen !== size) throw new Error(`${path}: size ${size} for a CID another entry sizes ${seen}`);
    sizes.set(cid, size);
  }
}

/** Encode entries as the manifest block. Paths are checked; order does not matter. */
export function encodeManifest(entries: Iterable<ManifestEntry>): Uint8Array {
  const resources: { [key: string]: Drisl } = {};
  const paths: string[] = [];
  const list: ManifestEntry[] = [];
  for (const entry of entries) {
    const { path, cid, size } = entry;
    const parsed = parseCid(cid);
    if (parsed.code !== RAW_CODE) throw new Error(`${path}: src must be a raw CID`);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${path}: size must be a non-negative integer`);
    paths.push(path);
    list.push(entry);
    resources[`/${path}`] = { src: new Link(parsed), size };
  }
  checkLayout(paths);
  checkSizes(list);
  const bytes = encodeDrisl({ resources });
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error(`manifest is ${bytes.length} bytes; the most is ${MAX_MANIFEST_BYTES}`);
  return bytes;
}

function isMap(v: Drisl | undefined): v is { [key: string]: Drisl } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Link);
}

/**
 * Decode a manifest block strictly: canonical DRISL; a map with exactly
 * `resources`; every key `/` + a path a tree can hold; every value a map
 * with exactly `src` (a raw CID) and `size` (a non-negative integer);
 * no two keys the same path and none a directory of another.
 */
export function decodeManifest(bytes: Uint8Array): ManifestEntry[] {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error(`manifest is ${bytes.length} bytes; the most is ${MAX_MANIFEST_BYTES}`);
  let doc: Drisl;
  try {
    doc = decodeDrisl(bytes);
  } catch (err) {
    throw new Error(`manifest is not canonical DRISL: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The decoder refuses every non-canonical form it can tell apart; the
  // one it cannot — a float whose value is an integer — and anything a
  // future edit might let through are caught by the backstop: the value
  // must re-encode to exactly these bytes.
  if (compareBytes(encodeDrisl(doc), bytes) !== 0) {
    throw new Error("manifest is not canonical DRISL: its bytes are not the encoding of their value");
  }
  if (!isMap(doc)) throw new Error("manifest is not a map");
  const keys = Object.keys(doc);
  if (keys.length !== 1 || keys[0] !== "resources") throw new Error("manifest must have exactly one member, resources");
  const resources = doc["resources"];
  if (!isMap(resources)) throw new Error("resources is not a map");
  const entries: ManifestEntry[] = [];
  for (const [key, value] of Object.entries(resources)) {
    if (!key.startsWith("/")) throw new Error(`resource key ${JSON.stringify(key)} does not start with /`);
    const path = key.slice(1);
    segmentsOf(path);
    if (!isMap(value)) throw new Error(`${key}: entry is not a map`);
    const members = Object.keys(value).sort();
    if (members.length !== 2 || members[0] !== "size" || members[1] !== "src") {
      throw new Error(`${key}: entry must have exactly src and size`);
    }
    const src = value["src"];
    if (!(src instanceof Link) || src.cid.code !== RAW_CODE) throw new Error(`${key}: src is not a raw CID`);
    const size = value["size"];
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`${key}: size is not a non-negative integer`);
    }
    entries.push({ path, cid: src.cid.text, size });
  }
  checkLayout(entries.map((e) => e.path));
  checkSizes(entries);
  return entries;
}

/* ----------------------------------------------------------- hash / verify */

/**
 * Hash a mapping: the raw CID of every file, the manifest over them, and
 * its drisl CID as the root. Deterministic in content only — insertion
 * order never changes the root. The empty mapping hashes to the empty
 * manifest.
 */
export async function hashTree(files: TreeFiles): Promise<HashedManifest> {
  const paths = Object.keys(files);
  checkLayout(paths);
  const entries: ManifestEntry[] = await Promise.all(
    paths.map(async (path) => {
      const bytes = files[path] as Uint8Array;
      return { path, cid: await rawCid(bytes), size: bytes.length };
    }),
  );
  const manifest = encodeManifest(entries);
  const root = await drislCid(manifest);
  const ordered = decodeManifest(manifest);
  const fileCids = new Map<string, string>();
  for (const { cid, path } of ordered) if (!fileCids.has(cid)) fileCids.set(cid, path);
  return { root, manifest, entries: ordered, files: fileCids };
}

/** Fetch the manifest block `root` names, prove it, and decode it. */
export async function fetchManifest(root: string, get: GetBlock): Promise<{ bytes: Uint8Array; entries: ManifestEntry[] }> {
  const cid = parseCid(root);
  if (cid.code !== DRISL_CODE) throw new Error("root is not a drisl CID: not a manifest");
  const bytes = await get(root);
  if (bytes === null) throw new Error(`missing object ${root}`);
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error(`manifest is ${bytes.length} bytes; the most is ${MAX_MANIFEST_BYTES}`);
  await checkCid(cid, bytes);
  return { bytes, entries: decodeManifest(bytes) };
}

/**
 * Recompute a tree from an object set and confirm it reaches `root`:
 * the manifest block hashes to the root and decodes as a manifest, and
 * every leaf present hashes to its CID and has its stated size. Throws
 * on a missing leaf unless `leaves: "optional"`, which records it in
 * `missing` (CID → size) and `partial` (path → [CID]) instead.
 */
export async function verifyTree(
  root: string,
  objects: Map<string, Uint8Array> | GetBlock,
  options: VerifyOptions = {},
): Promise<VerifiedManifest> {
  return (await walkTree(root, objects, options)).tree;
}

/** A block source as a function, whichever form the caller gave. */
export function getterOf(objects: Map<string, Uint8Array> | GetBlock): GetBlock {
  return typeof objects === "function" ? objects : async (cid) => objects.get(cid) ?? null;
}

/**
 * The walk behind `verifyTree`, keeping the leaves it proved: path → bytes
 * for every file whose block was present (the object layer reads the
 * object out of these).
 */
export async function walkTree(
  root: string,
  objects: Map<string, Uint8Array> | GetBlock,
  options: VerifyOptions = {},
): Promise<{ tree: VerifiedManifest; leaves: Map<string, Uint8Array> }> {
  const get = getterOf(objects);
  const { entries } = await fetchManifest(root, get);
  const tree: VerifiedManifest = {
    root,
    files: new Map(),
    sizes: new Map(),
    missing: new Map(),
    partial: new Map(),
    declined: new Map(),
  };
  const leaves = new Map<string, Uint8Array>();
  const checked = new Map<string, Promise<Uint8Array | null>>();
  for (const { path, cid, size } of entries) {
    tree.files.set(path, cid);
    tree.sizes.set(path, size);
    if (options.maxLeafBytes !== undefined && size > options.maxLeafBytes) {
      tree.declined.set(path, size);
      continue;
    }
    let leaf = checked.get(cid);
    if (leaf === undefined) {
      leaf = (async () => {
        const bytes = await get(cid);
        if (bytes === null) return null;
        await checkCid(cid, bytes);
        return bytes;
      })();
      checked.set(cid, leaf);
    }
    const bytes = await leaf;
    if (bytes === null) {
      if (options.leaves !== "optional") throw new Error(`missing object ${cid}`);
      tree.missing.set(cid, size);
      tree.partial.set(path, [cid]);
      continue;
    }
    if (bytes.length !== size) throw new Error(`${path}: manifest says ${size} bytes, the block holds ${bytes.length}`);
    leaves.set(path, bytes);
  }
  return { tree, leaves };
}

/** What `resolvePath` found. */
export interface Resolved {
  cid: string;
  size: number;
  /** The file's bytes, proven against its CID. */
  bytes: Uint8Array;
}

/**
 * One path from the root: the manifest (proven against the root), then
 * the leaf (proven against its CID). Two fetches, whatever the depth.
 */
export async function resolvePath(root: string, path: string, get: GetBlock): Promise<Resolved> {
  const { entries } = await fetchManifest(root, get);
  const normalized = segmentsOf(path).join("/");
  const entry = entries.find((e) => e.path === normalized);
  if (entry === undefined) throw new Error(`no such path: ${normalized}`);
  const bytes = await get(entry.cid);
  if (bytes === null) throw new Error(`missing object ${entry.cid}`);
  await checkCid(entry.cid, bytes);
  if (bytes.length !== entry.size) throw new Error(`${normalized}: manifest says ${entry.size} bytes, the block holds ${bytes.length}`);
  return { cid: entry.cid, size: entry.size, bytes };
}
