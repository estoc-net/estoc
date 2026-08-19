/**
 * The two object kinds and their CIDs.
 *
 * File object  = the bare bytes, named by a CIDv1 with the raw codec and
 *                sha-256 — the same digest R2 checksums, WebCrypto, and
 *                SRI compute, no git-style `blob <len>\0` header.
 * Dir object   = dag-json bytes `{"entries":[…]}`, named by a CIDv1 with
 *                the dag-json codec. dag-json brings canonical encoding
 *                (sorted keys, no whitespace) and a native link type, so
 *                canonicalisation is the codec's job, not ours.
 *
 * A reader tells the kinds apart by the codec bits of the CID itself.
 */

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import * as dagJson from "@ipld/dag-json";
import type { DirEntry } from "./types.js";

/** CID string (raw codec, sha-256) naming these bare bytes. */
export async function fileCid(bytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(bytes);
  return CID.create(1, raw.code, digest).toString();
}

/** Does this CID name a directory node (dag-json) rather than file bytes? */
export function isDirCid(cid: string): boolean {
  return CID.parse(cid).code === dagJson.code;
}

/**
 * Compare names as UTF-8 byte sequences — the sort order of directory
 * entries. (Plain JS string comparison is UTF-16 code-unit order, which
 * disagrees beyond the BMP.)
 */
export function compareNames(a: string, b: string): number {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ab[i] as number) - (bb[i] as number);
    if (d !== 0) return d;
  }
  return ab.length - bb.length;
}

function checkName(name: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/")) {
    throw new Error(`invalid entry name: ${JSON.stringify(name)}`);
  }
}

/**
 * Encode a directory node from its entries. Sorts by name (UTF-8 byte
 * order), rejects invalid or duplicate names, and turns `hash` strings
 * into dag-json links so the wire form is `{"/":"bafy…"}`.
 */
export async function encodeDirNode(
  entries: DirEntry[],
): Promise<{ cid: string; bytes: Uint8Array }> {
  const sorted = [...entries].sort((a, b) => compareNames(a.name, b.name));
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i] as DirEntry;
    checkName(entry.name);
    if (i > 0 && (sorted[i - 1] as DirEntry).name === entry.name) {
      throw new Error(`duplicate entry name: ${JSON.stringify(entry.name)}`);
    }
  }
  const node = {
    entries: sorted.map((e) => ({
      name: e.name,
      type: e.type,
      hash: CID.parse(e.hash),
      size: e.size,
    })),
  };
  const bytes = dagJson.encode(node);
  const digest = await sha256.digest(bytes);
  const cid = CID.create(1, dagJson.code, digest).toString();
  return { cid, bytes };
}

/**
 * Decode a directory node, checking shape. Trust in the *bytes* comes
 * from hashing them against their CID — callers do that before or after
 * decoding (verifyTree and resolvePath both do).
 */
export function decodeDirNode(bytes: Uint8Array): DirEntry[] {
  let node: unknown;
  try {
    node = dagJson.decode(bytes);
  } catch {
    throw new Error("not a dag-json directory node");
  }
  const entries = (node as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error("directory node has no entries array");
  }
  return entries.map((e: unknown): DirEntry => {
    const { name, type, hash, size } = (e ?? {}) as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      (type !== "file" && type !== "dir") ||
      !(hash instanceof CID) ||
      typeof size !== "number"
    ) {
      throw new Error("malformed directory entry");
    }
    checkName(name);
    return { name, type, hash: hash.toString(), size };
  });
}
