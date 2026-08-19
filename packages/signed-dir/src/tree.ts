/**
 * Whole-tree operations: hash a snapshot, verify an object set, resolve
 * one path with O(depth) proof. Bytes only ever pass through — nothing
 * here reads storage or keeps file contents.
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagJson from "@ipld/dag-json";
import { decodeDirNode, encodeDirNode, fileCid, isDirCid } from "./cid.js";
import type { DirEntry, HashedTree, TreeFiles } from "./types.js";
import { segmentsOf } from "./path.js";

interface DirTree {
  dirs: Map<string, DirTree>;
  files: Map<string, Uint8Array>;
}

function newDir(): DirTree {
  return { dirs: new Map(), files: new Map() };
}

/** Fold the flat snapshot into nesting, rejecting unsafe paths. */
function nest(files: TreeFiles): DirTree {
  const root = newDir();
  for (const [path, bytes] of Object.entries(files)) {
    const segments = segmentsOf(path);
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      if (dir.files.has(segment)) {
        throw new Error(`${segment} is both a file and a directory`);
      }
      let child = dir.dirs.get(segment);
      if (!child) {
        child = newDir();
        dir.dirs.set(segment, child);
      }
      dir = child;
    }
    const leaf = segments[segments.length - 1] as string;
    if (dir.dirs.has(leaf)) {
      throw new Error(`${leaf} is both a file and a directory`);
    }
    dir.files.set(leaf, bytes);
  }
  return root;
}

/**
 * The recursive hash of §5.1: raw CIDs for files, dag-json nodes for
 * directories, root = the root directory node's CID. Deterministic in
 * content only — insertion order of the input never changes the root.
 */
export async function hashTree(files: TreeFiles): Promise<HashedTree> {
  const nodes = new Map<string, Uint8Array>();
  const fileCids = new Map<string, string>();

  async function hashDir(
    dir: DirTree,
    prefix: string,
  ): Promise<{ cid: string; size: number }> {
    const entries: DirEntry[] = [];
    for (const [name, bytes] of dir.files) {
      const cid = await fileCid(bytes);
      if (!fileCids.has(cid)) fileCids.set(cid, prefix + name);
      entries.push({ name, type: "file", hash: cid, size: bytes.length });
    }
    for (const [name, child] of dir.dirs) {
      const sub = await hashDir(child, `${prefix}${name}/`);
      entries.push({ name, type: "dir", hash: sub.cid, size: sub.size });
    }
    const { cid, bytes } = await encodeDirNode(entries);
    nodes.set(cid, bytes);
    return { cid, size: entries.reduce((sum, e) => sum + e.size, 0) };
  }

  const { cid: root } = await hashDir(nest(files), "");
  return { root, nodes, files: fileCids };
}

/**
 * Recompute a tree from an object set and confirm it reaches `root`.
 * Every object's bytes are hashed against the CID that references them,
 * so a verified map is proof the set is exactly the tree the root names.
 * Returns path → CID for every file. Throws on any missing object,
 * hash mismatch, or malformed node. Extra objects in the map are ignored.
 */
export async function verifyTree(
  root: string,
  objects: Map<string, Uint8Array>,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function check(cid: string, bytes: Uint8Array): Promise<void> {
    const parsed = CID.parse(cid);
    const digest = await sha256.digest(bytes);
    const expected = CID.create(1, parsed.code, digest).toString();
    if (expected !== cid) {
      throw new Error(`object bytes do not hash to ${cid}`);
    }
  }

  async function walk(cid: string, prefix: string): Promise<void> {
    const bytes = objects.get(cid);
    if (bytes === undefined) {
      throw new Error(`missing object ${cid} (${prefix || "/"})`);
    }
    await check(cid, bytes);
    for (const entry of decodeDirNode(bytes)) {
      const path = prefix + entry.name;
      if (entry.type === "dir") {
        if (!isDirCid(entry.hash)) {
          throw new Error(`dir entry ${path} does not link a dag-json node`);
        }
        await walk(entry.hash, `${path}/`);
      } else {
        const fileBytes = objects.get(entry.hash);
        if (fileBytes === undefined) {
          throw new Error(`missing object ${entry.hash} (${path})`);
        }
        await check(entry.hash, fileBytes);
        files.set(path, entry.hash);
      }
    }
  }

  if (!isDirCid(root)) {
    throw new Error("root is not a dag-json directory node CID");
  }
  await walk(root, "");
  return files;
}

/** What resolvePath found at the end of the path. */
export interface Resolved {
  kind: "file" | "dir";
  cid: string;
  /** File bytes, or the dir node's dag-json bytes. Already verified. */
  bytes: Uint8Array;
}

/**
 * Walk one path from the root with O(depth) fetches, verifying every
 * object against the CID that named it — the read side of the trustless
 * gateway idea (IPIP-402): the caller needs the root (from a verified
 * card) and an object fetcher, and ends up with proven bytes.
 *
 * `""` resolves to the root directory itself.
 */
export async function resolvePath(
  root: string,
  path: string,
  getObject: (cid: string) => Promise<Uint8Array | null>,
): Promise<Resolved> {
  async function fetchChecked(cid: string): Promise<Uint8Array> {
    const bytes = await getObject(cid);
    if (bytes === null) throw new Error(`missing object ${cid}`);
    const parsed = CID.parse(cid);
    const digest = await sha256.digest(bytes);
    if (CID.create(1, parsed.code, digest).toString() !== cid) {
      throw new Error(`object bytes do not hash to ${cid}`);
    }
    return bytes;
  }

  let cid = root;
  let bytes = await fetchChecked(cid);
  let kind: "file" | "dir" = "dir";
  const segments = path === "" ? [] : segmentsOf(path);
  for (const segment of segments) {
    if (kind === "file") {
      throw new Error(`${segment}: not a directory`);
    }
    const entry = decodeDirNode(bytes).find((e) => e.name === segment);
    if (!entry) {
      throw new Error(`not found: ${segment} in ${path}`);
    }
    cid = entry.hash;
    kind = entry.type;
    bytes = await fetchChecked(cid);
  }
  return { kind, cid, bytes };
}

