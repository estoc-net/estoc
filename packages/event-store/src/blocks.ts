/**
 * Blocks of a vault (event-store.md §5.1): DASL blocks — naming bytes,
 * checking a block against its name, reading a file back from its
 * block, and walking what a root reaches. Pure: every store's blob side
 * is these over its own bytes.
 */

import { Link, compareBytes, decodeDrisl, encodeDrisl, rawCid, type DaslCid, type Drisl } from "@estoc/dasl";
import { DRISL_CODE, RAW_CODE, nameOf, parseCid } from "./cid.js";
import { BadBlock, NotAFile } from "./errors.js";

/** A block source: CID → bytes, or null when not held. */
export type GetBlock = (cid: string) => Promise<Uint8Array | null>;

/**
 * The check of §5.1, or a throw: `cid` is a DASL CID; `bytes` hash to
 * it; and, for a drisl block, `bytes` are one canonical DRISL document
 * (`decodeDocument`) whose links are DASL CIDs — the decoder admits no
 * other. Not the manifest shape: whether a document is a manifest is
 * `@estoc/folder-object`'s judgment, so a DRISL block that is not one
 * is not damage. Not a closure check. No size bound: a raw block is a
 * whole file, whatever its size.
 */
export async function checkBlock(cid: string, bytes: Uint8Array): Promise<DaslCid> {
  const parsed = parseCid(cid);
  if (parsed === null) {
    throw new BadBlock(cid, "not a DASL CID (CIDv1, sha-256, raw or drisl, base32 lower)");
  }
  if ((await nameOf(parsed.code, bytes)) !== cid) {
    throw new BadBlock(cid, "bytes do not hash to the name");
  }
  if (parsed.code === DRISL_CODE) {
    decodeDocument(cid, bytes);
  }
  return parsed;
}

/**
 * Decode `bytes` as one canonical DRISL document, or throw `BadBlock`:
 * the strict decoder refuses every non-canonical form — a non-shortest
 * integer, an unsorted map, an indefinite length, a tag but 42, a link
 * that is not a DASL CID, trailing bytes — and the re-encode is the
 * backstop: the bytes must be the one byte string their value has,
 * else the block's CID is not a function of its content.
 */
export function decodeDocument(cid: string, bytes: Uint8Array): Drisl {
  let doc: Drisl;
  try {
    doc = decodeDrisl(bytes);
  } catch (err) {
    throw new BadBlock(cid, `not DRISL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (compareBytes(encodeDrisl(doc), bytes) !== 0) {
    throw new BadBlock(cid, "not canonical DRISL: the document does not re-encode to these bytes");
  }
  return doc;
}

/**
 * The blocks `cid` links, for a block already checked: none for raw;
 * for drisl every link anywhere in the document — arrays and maps
 * walked, document order kept, each name once. Which of them a
 * manifest's leaves are is not asked: a link is a link.
 */
export function linksOf(cid: string, bytes: Uint8Array): string[] {
  const parsed = parseCid(cid);
  if (parsed === null || parsed.code === RAW_CODE) {
    return [];
  }
  const links: string[] = [];
  const seen = new Set<string>();
  const walk = (value: Drisl): void => {
    if (value instanceof Link) {
      if (!seen.has(value.cid.text)) {
        seen.add(value.cid.text);
        links.push(value.cid.text);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
    } else if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
      for (const key of Object.keys(value)) {
        walk(value[key] as Drisl);
      }
    }
  };
  walk(decodeDocument(cid, bytes));
  return links;
}

/** A file hashed: its root and every block, the root included — one raw block, under its raw CID. */
export interface HashedFile {
  root: string;
  blocks: Map<string, Uint8Array>;
}

/**
 * Hash `bytes` as one file: one raw block whatever its size, its raw
 * CID the root — the same name `@estoc/folder-object` gives the file
 * as a leaf of a tree.
 */
export async function hashFile(bytes: Uint8Array): Promise<HashedFile> {
  const root = await rawCid(bytes);
  return { root, blocks: new Map([[root, bytes]]) };
}

/**
 * The file `root` names: its raw block's bytes, or null if the block is
 * absent; throws `NotAFile` on a drisl root, which names a document — a
 * manifest, say — and never a file. The codec is in the name, so the
 * answer needs no block.
 */
export async function readFile(root: string, get: GetBlock): Promise<Uint8Array | null> {
  const parsed = parseCid(root);
  if (parsed === null) {
    throw new BadBlock(root, "not a DASL CID");
  }
  if (parsed.code !== RAW_CODE) {
    throw new NotAFile(root);
  }
  return get(root);
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
