import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import nodePath from "node:path";
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
    const abs = nodePath.join(e.parentPath ?? (e as { path: string }).path, e.name);
    const rel = nodePath.relative(dir, abs).split(nodePath.sep).join("/");
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

/** The part of `node:path` a projection needs — `path.posix` or `path.win32` in tests, the platform's in use. */
export type PathModule = Pick<typeof nodePath, "resolve" | "join" | "relative" | "isAbsolute" | "basename" | "dirname" | "sep">;

/**
 * Where a path of a mapping lands under `dir` on this platform, or a
 * throw: every segment must be exactly one entry name here — on
 * Windows, `a\..` and `a\b` are not, though a mapping may hold them —
 * and the result must be inside `dir`. A mapping is untrusted input;
 * projecting it onto a file system is the one place its paths meet a
 * platform's, and no segment may reach past the directory it was given.
 */
export function placeUnder(dir: string, path: string, p: PathModule = nodePath): string {
  const base = p.resolve(dir);
  let target = base;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new Error(`unsafe path segment in ${JSON.stringify(path)}`);
    const next = p.join(target, segment);
    if (p.basename(next) !== segment || p.dirname(next) !== target) {
      throw new Error(`${JSON.stringify(segment)} in ${JSON.stringify(path)} is not one entry name on this platform`);
    }
    target = next;
  }
  const rel = p.relative(base, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) {
    throw new Error(`${JSON.stringify(path)} does not stay inside ${JSON.stringify(dir)}`);
  }
  return target;
}

/**
 * Write a mapping under a directory. Every top-level entry the mapping
 * names (`object/`, `card.jws`, …) is replaced whole, so nothing stale
 * survives inside it; entries the mapping does not name are left alone —
 * a rendered page can live beside a signed object. Every path is placed
 * with `placeUnder` first: nothing is removed or written until the whole
 * mapping is known to land inside `dir`.
 */
export async function writeTree(dir: string, tree: TreeFiles): Promise<void> {
  const placed = new Map<string, Uint8Array>();
  const tops = new Map<string, string>();
  for (const [path, bytes] of Object.entries(tree)) {
    placed.set(placeUnder(dir, path), bytes);
    const top = path.split("/")[0] as string;
    tops.set(top, placeUnder(dir, top));
  }
  for (const top of tops.values()) await rm(top, { recursive: true, force: true });
  for (const [abs, bytes] of placed) {
    await mkdir(nodePath.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }
}
