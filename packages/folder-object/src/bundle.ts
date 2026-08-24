import { zipSync, unzipSync } from "fflate";
import { readObject } from "./object.js";
import { MalformedObjectError, type Bundle, type FolderObject, type TreeFiles } from "./types.js";

/** Lay an object (and its card) out as a bundle mapping (spec §5). */
export function bundleTree(object: FolderObject, card?: string): TreeFiles {
  const out: TreeFiles = {};
  for (const [path, bytes] of Object.entries(object.tree)) out[`object/${path}`] = bytes;
  if (card !== undefined) out["card.jws"] = new TextEncoder().encode(card);
  return out;
}

/** Recognize a bundle or a bare object in a mapping (spec §5, §7). */
export function readBundle(mapping: TreeFiles): Bundle {
  if ("object/index.json" in mapping) {
    const inner: TreeFiles = {};
    for (const [path, bytes] of Object.entries(mapping)) {
      if (path.startsWith("object/")) inner[path.slice("object/".length)] = bytes;
    }
    const cardBytes = mapping["card.jws"];
    const card = cardBytes ? new TextDecoder().decode(cardBytes).trim() : undefined;
    return card === undefined ? { object: readObject(inner) } : { object: readObject(inner), card };
  }
  if ("index.json" in mapping) return { object: readObject(mapping) };
  throw new MalformedObjectError("format", "neither object/index.json nor index.json found");
}

/** The self-contained file projection: a zip of the bundle. Deterministic (fixed mtime). */
export function zipBundle(object: FolderObject, card?: string): Uint8Array {
  const tree = bundleTree(object, card);
  const zippable: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const path of Object.keys(tree).sort()) {
    zippable[path] = [tree[path]!, { mtime: new Date(1980, 0, 2) }];
  }
  return zipSync(zippable, { level: 6 });
}

/** Reproduce the mapping from a zip; duplicate entries make the container malformed. */
export function unzipMapping(zip: Uint8Array): TreeFiles {
  const seen = new Set<string>();
  const out: TreeFiles = {};
  for (const [path, bytes] of Object.entries(unzipSync(zip))) {
    if (path.endsWith("/")) continue;
    if (seen.has(path)) throw new Error(`container: duplicate entry ${path}`);
    seen.add(path);
    out[path] = bytes;
  }
  return out;
}
