import { zipSync, unzipSync } from "fflate";
import type { TreeFiles } from "./types.js";

/**
 * A mapping as one file. Deterministic (sorted entries, fixed mtime):
 * the same tree zips to the same bytes. Spec §7: a fact is a mapping,
 * and any faithful container is legal — this is the one we ship.
 */
export function zipTree(tree: TreeFiles): Uint8Array {
  const zippable: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const path of Object.keys(tree).sort()) {
    zippable[path] = [tree[path]!, { mtime: new Date(1980, 0, 2) }];
  }
  return zipSync(zippable, { level: 6 });
}

/** The mapping back from a zip; duplicate entries make the container malformed. */
export function unzipTree(zip: Uint8Array): TreeFiles {
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
