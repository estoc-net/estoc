import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join, relative, dirname, sep } from "node:path";
import type { TreeFiles } from "./types.js";

/**
 * Read a directory into a mapping (relative posix paths → bytes). Empty
 * directories vanish; hidden entries (a `.`-prefixed name at any depth) are
 * not read at all. A fact has no symbolic links, so a symlink — or any other
 * entry that is neither a file nor a directory — is an error, never silently
 * dropped and never followed.
 */
export async function readTree(dir: string): Promise<TreeFiles> {
  const out: TreeFiles = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    const abs = join(e.parentPath ?? (e as { path: string }).path, e.name);
    const rel = relative(dir, abs).split(sep).join("/");
    if (rel.split("/").some((s) => s.startsWith("."))) continue;
    if (e.isDirectory()) continue;
    if (!e.isFile()) {
      const kind = e.isSymbolicLink() ? "a symbolic link" : "not a regular file";
      throw new Error(`${rel} is ${kind}; a fact holds only files`);
    }
    out[rel] = new Uint8Array(await readFile(abs));
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
