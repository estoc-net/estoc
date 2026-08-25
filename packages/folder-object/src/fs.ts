import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join, relative, dirname, sep } from "node:path";
import type { TreeFiles } from "./types.js";

/** Read a directory into a mapping (relative posix paths → bytes). Empty directories vanish. */
export async function readTree(dir: string): Promise<TreeFiles> {
  const out: TreeFiles = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath ?? (e as { path: string }).path, e.name);
    out[relative(dir, abs).split(sep).join("/")] = new Uint8Array(await readFile(abs));
  }
  return out;
}

/**
 * Write a mapping under a directory. Every top-level entry the mapping
 * names (`object/`, `card.jws`, …) is replaced whole, so nothing stale
 * survives inside it; entries the mapping does not name are left alone —
 * a rendered page can live beside a signed object.
 */
export async function writeTree(dir: string, tree: TreeFiles): Promise<void> {
  const tops = new Set(Object.keys(tree).map((p) => p.split("/")[0]!));
  for (const top of tops) await rm(join(dir, top), { recursive: true, force: true });
  for (const [path, bytes] of Object.entries(tree)) {
    const abs = join(dir, ...path.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }
}
