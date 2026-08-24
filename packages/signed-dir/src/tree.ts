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
 * Deliberate deviation from the profile: empty directories are rejected,
 * both at hash time (an empty snapshot has no root) and at verify time
 * (a directory node with zero entries fails). TreeFiles cannot express
 * them, so nothing is lost — this just closes the door on a relay
 * serving one.
 */

import { CID } from "multiformats/cid";
import { importer, type FileCandidate } from "ipfs-unixfs-importer";
import {
  exporter,
  type ReadableStorage,
  type UnixFSDirectory,
} from "ipfs-unixfs-exporter";
import { checkCid, compareNames, isRawCid } from "./cid.js";
import type { HashedTree, TreeFiles } from "./types.js";
import { checkName, segmentsOf } from "./path.js";

const PROFILE = "unixfs-v1-2025" as const;

/** Normalize and reject unsafe or conflicting paths. */
function candidatesOf(files: TreeFiles): FileCandidate[] {
  const out: FileCandidate[] = [];
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
 * changes the root. Rejects the empty snapshot: an empty directory has
 * no representation in this scheme.
 */
export async function hashTree(files: TreeFiles): Promise<HashedTree> {
  const source = candidatesOf(files);
  if (source.length === 0) {
    throw new Error("empty tree: empty directories are rejected");
  }

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

/** Fetch one block and prove its bytes match the CID asked for. */
async function fetchChecked(
  getObject: (cid: string) => Promise<Uint8Array | null>,
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
function verifyingStore(
  getObject: (cid: string) => Promise<Uint8Array | null>,
): ReadableStorage {
  return {
    async *get(cid: CID): AsyncGenerator<Uint8Array> {
      yield await fetchChecked(getObject, cid);
    },
  };
}

async function walkDir(
  dir: UnixFSDirectory,
  prefix: string,
  store: ReadableStorage,
  files: Map<string, string>,
): Promise<void> {
  if (dir.unixfs.type === "directory") {
    // Canonical form: flat directory links strictly ascending in UTF-8
    // byte order (also rules out duplicates). HAMT shards order links by
    // hash structure instead, so only flat nodes are checked here.
    const names = dir.node.Links.map((l) => l.Name ?? "");
    for (let i = 1; i < names.length; i++) {
      if (compareNames(names[i - 1] as string, names[i] as string) >= 0) {
        throw new Error(
          `directory ${prefix || "/"} links are not in canonical order`,
        );
      }
    }
  }
  let count = 0;
  const seen = new Set<string>();
  for await (const child of dir.entries()) {
    count++;
    checkName(child.name);
    if (seen.has(child.name)) {
      throw new Error(`duplicate entry name: ${JSON.stringify(child.name)}`);
    }
    seen.add(child.name);
    const path = prefix + child.name;
    const entry = await exporter(child.cid, store);
    if (entry.type === "directory") {
      await walkDir(entry, `${path}/`, store, files);
    } else if (entry.type === "file" || entry.type === "raw") {
      // Pull every leaf through the verifying store — presence and hash
      // of each chunk block is proven as a side effect.
      for await (const _ of entry.content()) {
        // bytes discarded; the store already checked them
      }
      files.set(path, child.cid.toString());
    } else {
      throw new Error(`unsupported node kind at ${path}: ${entry.type}`);
    }
  }
  if (count === 0) {
    throw new Error(
      `empty directory at ${prefix || "/"}: empty directories are rejected`,
    );
  }
}

/**
 * Recompute a tree from an object set and confirm it reaches `root`.
 * Every object's bytes are hashed against the CID that references them,
 * so a verified map is proof the set is exactly the tree the root names.
 * Returns path → CID for every file (the file's root CID — raw for
 * single-block files, dag-pb for chunked ones). Throws on any missing
 * object, hash mismatch, malformed node, non-canonical link order, or
 * empty directory. Extra objects in the map are ignored.
 */
export async function verifyTree(
  root: string,
  objects: Map<string, Uint8Array>,
): Promise<Map<string, string>> {
  const store = verifyingStore(async (cid) => objects.get(cid) ?? null);
  const rootEntry = await exporter(CID.parse(root), store);
  if (rootEntry.type !== "directory") {
    throw new Error("root is not a UnixFS directory");
  }
  const files = new Map<string, string>();
  await walkDir(rootEntry, "", store, files);
  return files;
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
    if (entry.node.Links.length === 0) {
      throw new Error("empty directory: empty directories are rejected");
    }
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
