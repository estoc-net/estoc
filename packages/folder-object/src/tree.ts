/**
 * Whole-tree operations over UnixFS (IPIP-499 profile `unixfs-v1-2025`):
 * hash a snapshot, verify an object set, resolve one path. Bytes only
 * ever pass through — nothing here reads storage or keeps file contents
 * beyond the produced blocks.
 *
 * Profile parameters (set by ipfs-unixfs-importer's `profile` option):
 * CIDv1, sha-256, raw leaves, 1 MiB fixed-size chunks, balanced layout
 * with 1024 links per node, HAMT sharding past 256 KiB (block-bytes
 * estimation). Link order inside directory nodes is the DAG-PB codec's
 * job: the spec makes encoders sort links by Name bytes (UTF-8 byte
 * order), and @ipld/dag-pb's prepare() does exactly that — which is why
 * the same snapshot roots the same CID here and in `ipfs add`,
 * whatever order the input arrives in.
 *
 * The profile is taken whole, empty directories included: `hashTree({})`
 * roots the well-known empty directory, `HashOptions.dirs` puts empty
 * directories anywhere in a tree, and the verify side accepts a
 * directory node with zero links like any other.
 */

import { CID } from "multiformats/cid";
import { importer, type ImportCandidate } from "ipfs-unixfs-importer";
import { exporter, type ReadableStorage } from "ipfs-unixfs-exporter";
import * as dagPB from "@ipld/dag-pb";
import * as raw from "multiformats/codecs/raw";
import { UnixFS } from "ipfs-unixfs";
import { checkCid, compareNames, dagPbCode, isRawCid } from "./cid.js";
import type {
  HashOptions,
  HashedTree,
  TreeFiles,
  VerifiedTree,
  VerifyOptions,
} from "./types.js";
import { checkName, segmentsOf } from "./path.js";

const PROFILE = "unixfs-v1-2025" as const;

/** Normalize and reject unsafe or conflicting paths. */
function candidatesOf(
  files: TreeFiles,
  dirs: Iterable<string>,
): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  const filePaths = new Set<string>();
  const dirPaths = new Set<string>();
  for (const [path, bytes] of Object.entries(files)) {
    const segments = segmentsOf(path);
    const normalized = segments.join("/");
    if (filePaths.has(normalized)) {
      throw new Error(`duplicate path: ${normalized}`);
    }
    filePaths.add(normalized);
    for (let i = 1; i < segments.length; i++) {
      dirPaths.add(segments.slice(0, i).join("/"));
    }
    out.push({ path: normalized, content: bytes });
  }
  for (const path of dirs) {
    const normalized = segmentsOf(path).join("/");
    if (!dirPaths.has(normalized)) {
      dirPaths.add(normalized);
      out.push({ path: normalized });
    }
  }
  for (const path of filePaths) {
    if (dirPaths.has(path)) {
      throw new Error(`${path} is both a file and a directory`);
    }
  }
  return out;
}

/**
 * Hash a snapshot into a UnixFS DAG under the unixfs-v1-2025 profile.
 * Deterministic in content only — insertion order of the input never
 * changes the root. The empty snapshot roots the empty directory;
 * `options.dirs` adds empty directories below the root.
 */
export async function hashTree(
  files: TreeFiles,
  options: HashOptions = {},
): Promise<HashedTree> {
  const source = candidatesOf(files, options.dirs ?? []);

  const blocks = new Map<string, Uint8Array>();
  const store = {
    async put(cid: CID, bytes: Uint8Array): Promise<CID> {
      blocks.set(cid.toString(), bytes);
      return cid;
    },
  };

  const fileCids = new Map<string, string>();
  let root: string | undefined;
  let rootIsDir = false;
  for await (const entry of importer(source, store, {
    profile: PROFILE,
    wrapWithDirectory: true,
  })) {
    const type = entry.unixfs?.type;
    const isDir = type === "directory" || type === "hamt-sharded-directory";
    const cid = entry.cid.toString();
    if (!isDir && entry.path !== undefined && entry.path !== "") {
      if (!fileCids.has(cid)) fileCids.set(cid, entry.path);
    }
    root = cid;
    rootIsDir = isDir;
  }
  if (root === undefined || !rootIsDir) {
    throw new Error("importer did not produce a directory root");
  }
  // A single-block file's root is the raw CID of its bare bytes — the
  // caller already holds those bytes, so don't keep a copy here.
  for (const cid of fileCids.keys()) {
    if (isRawCid(cid)) blocks.delete(cid);
  }
  return { root, nodes: blocks, files: fileCids };
}

/** A block source: CID string → bytes, or null when not held. */
export type GetBlock = (cid: string) => Promise<Uint8Array | null>;

/** Fetch one block and prove its bytes match the CID asked for. */
async function fetchChecked(
  getObject: GetBlock,
  cid: CID,
): Promise<Uint8Array> {
  const bytes = await getObject(cid.toString());
  if (bytes === null) {
    throw new Error(`missing object ${cid.toString()}`);
  }
  await checkCid(cid, bytes);
  return bytes;
}

/** A blockstore whose every get proves the bytes match the CID asked for. */
function verifyingStore(getObject: GetBlock): ReadableStorage {
  return {
    async *get(cid: CID): AsyncGenerator<Uint8Array> {
      yield await fetchChecked(getObject, cid);
    },
  };
}

/** A decoded dag-pb node with its UnixFS Data field. */
interface PbNode {
  cid: CID;
  node: dagPB.PBNode;
  data: UnixFS;
}

/** Fetch, check and decode a dag-pb node (a skeleton block — never optional). */
async function fetchNode(get: GetBlock, cid: CID): Promise<PbNode> {
  if (cid.code !== dagPbCode) {
    throw new Error(`${cid.toString()} is not a dag-pb node`);
  }
  const bytes = await fetchChecked(get, cid);
  const node = dagPB.decode(bytes);
  if (node.Data === undefined) {
    throw new Error(`dag-pb node ${cid.toString()} has no UnixFS data`);
  }
  return { cid, node, data: UnixFS.unmarshal(node.Data) };
}

/** The walk's state: what to collect, and whether a missing leaf is a fact or a fault. */
interface Walk {
  get: GetBlock;
  out: VerifiedTree;
  leavesOptional: boolean;
}

/**
 * Every block of a file: raw leaves checked when present and recorded
 * under `path` when absent (or thrown, when leaves are required);
 * dag-pb chunk indexes always fetched and recursed into.
 */
async function walkFileBlocks(
  w: Walk,
  cid: CID,
  size: number,
  path: string,
): Promise<void> {
  if (cid.code === raw.code) {
    const bytes = await w.get(cid.toString());
    if (bytes === null) {
      if (!w.leavesOptional) {
        throw new Error(`missing object ${cid.toString()}`);
      }
      w.out.missing.set(cid.toString(), size);
      const gaps = w.out.partial.get(path) ?? [];
      gaps.push(cid.toString());
      w.out.partial.set(path, gaps);
      return;
    }
    await checkCid(cid, bytes);
    return;
  }
  const { node, data } = await fetchNode(w.get, cid);
  if (data.type !== "file") {
    throw new Error(`${path} is a ${data.type}, not a file`);
  }
  for (const link of node.Links) {
    await walkFileBlocks(w, link.Hash, link.Tsize ?? 0, path);
  }
}

/** One directory entry, whichever kind the link turns out to name. */
async function walkEntry(
  w: Walk,
  link: dagPB.PBLink,
  name: string,
  prefix: string,
  seen: Set<string>,
): Promise<void> {
  checkName(name);
  if (seen.has(name)) {
    throw new Error(`duplicate entry name: ${JSON.stringify(name)}`);
  }
  seen.add(name);
  const path = prefix + name;
  const cid = link.Hash;
  if (cid.code === raw.code) {
    await walkFileBlocks(w, cid, link.Tsize ?? 0, path);
    w.out.files.set(path, cid.toString());
    return;
  }
  const pb = await fetchNode(w.get, cid);
  if (pb.data.type === "directory" || pb.data.type === "hamt-sharded-directory") {
    await walkDir(w, pb, `${path}/`);
  } else if (pb.data.type === "file") {
    for (const child of pb.node.Links) {
      await walkFileBlocks(w, child.Hash, child.Tsize ?? 0, path);
    }
    w.out.files.set(path, cid.toString());
  } else {
    throw new Error(`unsupported node kind at ${path}: ${pb.data.type}`);
  }
}

/**
 * The entries of a HAMT shard: a link named by exactly its two hex
 * bucket characters is a sub-shard, any longer name is an entry whose
 * name follows the two characters.
 */
async function walkShard(
  w: Walk,
  pb: PbNode,
  prefix: string,
  seen: Set<string>,
): Promise<void> {
  for (const link of pb.node.Links) {
    const label = link.Name ?? "";
    if (label.length < 2) {
      throw new Error(`shard ${prefix || "/"} has a link without a bucket label`);
    }
    if (label.length === 2) {
      const sub = await fetchNode(w.get, link.Hash);
      if (sub.data.type !== "hamt-sharded-directory") {
        throw new Error(`shard ${prefix || "/"} links a ${sub.data.type} as a sub-shard`);
      }
      await walkShard(w, sub, prefix, seen);
    } else {
      await walkEntry(w, link, label.slice(2), prefix, seen);
    }
  }
}

async function walkDir(w: Walk, pb: PbNode, prefix: string): Promise<void> {
  w.out.dirs.set(prefix.replace(/\/$/, ""), pb.cid.toString());
  const seen = new Set<string>();
  if (pb.data.type === "directory") {
    // Canonical form: flat directory links strictly ascending in UTF-8
    // byte order (also rules out duplicates). HAMT shards order links by
    // hash structure instead, so only flat nodes are checked here.
    const names = pb.node.Links.map((l) => l.Name ?? "");
    for (let i = 1; i < names.length; i++) {
      if (compareNames(names[i - 1] as string, names[i] as string) >= 0) {
        throw new Error(
          `directory ${prefix || "/"} links are not in canonical order`,
        );
      }
    }
    for (const link of pb.node.Links) {
      await walkEntry(w, link, link.Name ?? "", prefix, seen);
    }
  } else {
    await walkShard(w, pb, prefix, seen);
  }
}

/**
 * Recompute a tree from an object set and confirm it reaches `root`.
 * Every object's bytes are hashed against the CID that references them,
 * so a verified result is proof the set is exactly the tree the root
 * names. Returns path → CID for every file (the file's root CID — raw
 * for single-block files, dag-pb for chunked ones) and for every
 * directory (the root under `""`). Throws on any missing object, hash
 * mismatch, malformed node, or non-canonical link order. Extra objects
 * in the map are ignored.
 *
 * With `leaves: "optional"` the skeleton — every dag-pb block — is still
 * required, but a raw block (a single-block file, a chunk) may be
 * absent: the walk records it in `missing` (CID → size the link claims)
 * and its file in `partial`, and the result is proof of the tree's
 * shape and of every leaf that is present. The object set may be a map
 * or a lookup function.
 */
export async function verifyTree(
  root: string,
  objects: Map<string, Uint8Array> | GetBlock,
  options: VerifyOptions = {},
): Promise<VerifiedTree> {
  const get: GetBlock =
    typeof objects === "function"
      ? objects
      : async (cid) => objects.get(cid) ?? null;
  const rootCid = CID.parse(root);
  if (rootCid.code !== dagPbCode) {
    throw new Error("root is not a UnixFS directory");
  }
  const pb = await fetchNode(get, rootCid);
  if (pb.data.type !== "directory" && pb.data.type !== "hamt-sharded-directory") {
    throw new Error("root is not a UnixFS directory");
  }
  const out: VerifiedTree = {
    files: new Map(),
    dirs: new Map(),
    missing: new Map(),
    partial: new Map(),
  };
  await walkDir({ get, out, leavesOptional: options.leaves === "optional" }, pb, "");
  return out;
}

/** What resolvePath found at the end of the path. */
export interface Resolved {
  kind: "file" | "dir";
  cid: string;
  /**
   * Full file bytes (chunks re-joined), or the dir node's dag-pb bytes.
   * Already verified. Unlike the dag-json branch this is O(depth +
   * chunks) fetches for a file, not O(depth) — a chunked file's bytes
   * live in many blocks.
   */
  bytes: Uint8Array;
}

/**
 * Walk one path from the root, verifying every object against the CID
 * that named it — the read side of the trustless gateway idea
 * (IPIP-402): the caller needs the root (from a verified card) and an
 * object fetcher, and ends up with proven bytes.
 *
 * `""` resolves to the root directory itself.
 */
export async function resolvePath(
  root: string,
  path: string,
  getObject: (cid: string) => Promise<Uint8Array | null>,
): Promise<Resolved> {
  const store = verifyingStore(getObject);
  const target =
    path === "" ? CID.parse(root) : `${root}/${segmentsOf(path).join("/")}`;
  const entry = await exporter(target, store);
  if (entry.type === "directory") {
    return {
      kind: "dir",
      cid: entry.cid.toString(),
      bytes: await fetchChecked(getObject, entry.cid),
    };
  }
  if (entry.type === "file" || entry.type === "raw") {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of entry.content()) {
      chunks.push(chunk);
      length += chunk.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { kind: "file", cid: entry.cid.toString(), bytes };
  }
  throw new Error(`unsupported node kind: ${entry.type}`);
}
