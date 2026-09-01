/**
 * Blocks of the `unixfs-v1-2025` profile (event-store.md §5.1): naming
 * bytes, checking a block against its name, reading a file back from its
 * blocks, and walking what a root reaches. Pure: every store's blob side
 * is these over its own bytes.
 */

import * as dagPB from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { importer } from "ipfs-unixfs-importer";
import type { CID } from "multiformats/cid";
import { DAG_PB_CODE, RAW_CODE, nameOf, parseCid } from "./cid.js";
import { BadBlock, NotAFile } from "./errors.js";

export const PROFILE = "unixfs-v1-2025" as const;
/** The most bytes a raw block holds: the profile's chunk size. */
export const MAX_RAW_BYTES = 1024 * 1024;

/** A block source: CID → bytes, or null when not held. */
export type GetBlock = (cid: string) => Promise<Uint8Array | null>;

const NODE_KINDS = ["file", "directory", "hamt-sharded-directory"] as const;

/**
 * The three checks of §5.1, or a throw: `cid` is a profile name; `bytes`
 * hash to it and a raw block is at most 1 MiB; a dag-pb block decodes as
 * a node the profile makes (`decodeNode`). Not a closure check.
 */
export async function checkBlock(cid: string, bytes: Uint8Array): Promise<CID> {
  const parsed = parseCid(cid);
  if (parsed === null) {
    throw new BadBlock(cid, "not a profile name (CIDv1, sha-256, raw or dag-pb, base32 lower)");
  }
  if (parsed.code === RAW_CODE && bytes.length > MAX_RAW_BYTES) {
    throw new BadBlock(cid, `a raw block holds at most ${MAX_RAW_BYTES} bytes, not ${bytes.length}`);
  }
  if ((await nameOf(parsed.code, bytes)) !== cid) {
    throw new BadBlock(cid, "bytes do not hash to the name");
  }
  if (parsed.code === DAG_PB_CODE) {
    decodeNode(cid, bytes);
  }
  return parsed;
}

/** A decoded dag-pb block: the node and its UnixFS data. */
export interface Node {
  node: dagPB.PBNode;
  data: UnixFS;
}

/**
 * The fanout the profile shards with. Its hash function (murmur3-x64-64)
 * is not checked: `ipfs-unixfs` does not surface `hashType` on unmarshal.
 */
const HAMT_FANOUT = 256n;

/**
 * Decode `bytes` as a node the profile makes, or throw `BadBlock`: dag-pb
 * with UnixFS data of kind file, directory or HAMT shard; every link a
 * profile name; and the shape the profile gives each kind — a file node
 * of at least two chunks with one size per link and no inline bytes (one
 * chunk, or the empty file, is a raw block, not a node), directory
 * entries named and strictly ascending with no inline bytes, a shard
 * 256-way whose inline bytes are its bitfield. Not the balanced layout
 * itself: that a chunk is 1 MiB, that a node has at most 1024 links, is
 * what a root reaches, read when read.
 */
export function decodeNode(cid: string, bytes: Uint8Array): Node {
  let node: dagPB.PBNode;
  try {
    node = dagPB.decode(bytes);
  } catch (err) {
    throw new BadBlock(cid, `not dag-pb: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (node.Data === undefined) {
    throw new BadBlock(cid, "a dag-pb node without UnixFS data");
  }
  let data: UnixFS;
  try {
    data = UnixFS.unmarshal(node.Data);
  } catch (err) {
    throw new BadBlock(cid, `not a UnixFS node: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!(NODE_KINDS as readonly string[]).includes(data.type)) {
    throw new BadBlock(cid, `a UnixFS ${data.type} is not a node the profile makes`);
  }
  for (const link of node.Links) {
    if (parseCid(link.Hash.toString()) === null) {
      throw new BadBlock(cid, `links ${link.Hash.toString()}, which is not a profile name`);
    }
  }
  const inline = data.data !== undefined && data.data.length > 0;
  if (data.type === "file") {
    if (inline) {
      throw new BadBlock(cid, "a file node with inline bytes, which the profile never makes");
    }
    if (node.Links.length < 2) {
      throw new BadBlock(cid, "a file node of fewer than two chunks, which the profile makes a raw block");
    }
    if (data.blockSizes.length !== node.Links.length) {
      throw new BadBlock(cid, "a file node whose block sizes do not match its links");
    }
  } else if (data.type === "directory") {
    if (inline) {
      throw new BadBlock(cid, "a directory node with inline bytes, which the profile never makes");
    }
  } else if (data.fanout !== HAMT_FANOUT || !inline) {
    throw new BadBlock(cid, "a shard that is not 256-way with a bitfield, which the profile never makes");
  }
  if (data.type !== "file") {
    let previous: string | undefined;
    for (const link of node.Links) {
      const name = link.Name ?? "";
      if (name === "" || name === "." || name === ".." || name.includes("/")) {
        throw new BadBlock(cid, `a directory entry named ${JSON.stringify(name)}`);
      }
      if (data.type === "directory" && previous !== undefined && compareNames(previous, name) >= 0) {
        throw new BadBlock(cid, "directory entries not in strictly ascending order");
      }
      previous = name;
    }
  }
  return { node, data };
}

/** Names as UTF-8 byte sequences: the order of directory entries (`@estoc/folder-object`'s rule). */
function compareNames(a: string, b: string): number {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ab[i] as number) - (bb[i] as number);
    if (d !== 0) {
      return d;
    }
  }
  return ab.length - bb.length;
}

/** The blocks `cid` links, for a block already checked: none for raw, the node's for dag-pb. */
export function linksOf(cid: string, bytes: Uint8Array): string[] {
  const parsed = parseCid(cid);
  if (parsed === null || parsed.code === RAW_CODE) {
    return [];
  }
  return decodeNode(cid, bytes).node.Links.map((link) => link.Hash.toString());
}

/** A file hashed by the profile: its root and every block, the root included. */
export interface HashedFile {
  root: string;
  blocks: Map<string, Uint8Array>;
}

/**
 * Hash `bytes` as one file of the profile: a raw block when they fit in
 * one, else raw 1 MiB chunks under a dag-pb root in the balanced layout —
 * the same root `@estoc/folder-object` gives the file inside a tree.
 */
export async function hashFile(bytes: Uint8Array): Promise<HashedFile> {
  const blocks = new Map<string, Uint8Array>();
  const store = {
    async put(cid: CID, block: Uint8Array): Promise<CID> {
      blocks.set(cid.toString(), block);
      return cid;
    },
  };
  let root: string | undefined;
  for await (const entry of importer([{ content: bytes }], store, { profile: PROFILE })) {
    root = entry.cid.toString();
  }
  if (root === undefined || !blocks.has(root)) {
    throw new Error("importer did not produce a file root");
  }
  return { root, blocks };
}

/** Thrown inside a walk when a block is not held; caught at the top and turned into `null`. */
class Absent extends Error {}

/**
 * The file `root` names, its chunks rejoined; null if the root or any
 * chunk is absent; throws `NotAFile` on a directory or shard.
 */
export async function readFile(root: string, get: GetBlock): Promise<Uint8Array | null> {
  if (parseCid(root) === null) {
    throw new BadBlock(root, "not a profile name");
  }
  const parts: Uint8Array[] = [];
  const walk = async (cid: string): Promise<void> => {
    const bytes = await get(cid);
    if (bytes === null) {
      throw new Absent();
    }
    if ((parseCid(cid) as CID).code === RAW_CODE) {
      parts.push(bytes);
      return;
    }
    const { node, data } = decodeNode(cid, bytes);
    if (data.type !== "file") {
      throw new NotAFile(root);
    }
    if (node.Links.length === 0) {
      // The profile hashes with raw leaves, so a file node carries no bytes
      // of its own; tolerated all the same, as a reader of blocks made elsewhere.
      if (data.data !== undefined) {
        parts.push(data.data);
      }
      return;
    }
    for (const link of node.Links) {
      await walk(link.Hash.toString());
    }
  };
  try {
    await walk(root);
  } catch (err) {
    if (err instanceof Absent) {
      return null;
    }
    throw err;
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** What a walk from some roots found: the blocks it reached, and the names it asked `get` for and did not find — under which nothing is known. */
export interface Reach {
  reached: Set<string>;
  absent: Set<string>;
}

/**
 * Every block any of `roots` reaches through the blocks `get` holds, and
 * every name the walk asked for that `get` did not hold — a root, or a
 * link of a reached block. An absent block is not walked past, and
 * nothing is checked. A block that does not decode is reached and not
 * walked past either: damage the store sets aside on its own finding.
 */
export async function reach(roots: Iterable<string>, get: GetBlock): Promise<Reach> {
  const reached = new Set<string>();
  const absent = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const cid = pending.pop() as string;
    if (reached.has(cid) || absent.has(cid) || parseCid(cid) === null) {
      continue;
    }
    const bytes = await get(cid);
    if (bytes === null) {
      absent.add(cid);
      continue;
    }
    reached.add(cid);
    let links: string[];
    try {
      links = linksOf(cid, bytes);
    } catch {
      continue;
    }
    pending.push(...links);
  }
  return { reached, absent };
}

/** Every block any of `roots` reaches through the blocks `get` holds — what a collector keeps; an absent block ends the walk there, unremarked. */
export async function reachable(roots: Iterable<string>, get: GetBlock): Promise<Set<string>> {
  return (await reach(roots, get)).reached;
}
