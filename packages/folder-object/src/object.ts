/**
 * The object layer (spec §2–§4, §8): a mapping read as an object — an
 * `index.json` that says what it is, and `files/…` — its canonical tree
 * taken by enumeration, its version identity the root of that tree
 * (`tree.ts`), and an object read back out of a root and the blocks at
 * hand (`verifyObject`).
 */

import { getterOf, fetchManifest, hashTree, ManifestError, walkLeaves, type GetBlock, type VerifiedTree, type VerifyOptions } from "./tree.js";
import { MalformedObjectError, type FolderObject, type IndexJson, type TreeFiles } from "./types.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the shape of an index (spec §3.1, §8 format layer). */
export function parseIndex(bytes: Uint8Array): IndexJson {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MalformedObjectError("format", "index.json is not JSON");
  }
  if (!isPlainObject(value)) throw new MalformedObjectError("format", "index.json is not a JSON object");
  const { format, id, content } = value;
  if (typeof format !== "string" || format === "") throw new MalformedObjectError("format", "missing format");
  if (typeof id !== "string" || !UUID_V7.test(id)) throw new MalformedObjectError("format", "id is not a UUIDv7");
  if (content !== undefined) {
    if (!isPlainObject(content) || typeof content.mediaType !== "string") {
      throw new MalformedObjectError("format", "content must carry a mediaType");
    }
    const hasPath = typeof content.path === "string";
    const hasText = typeof content.text === "string";
    if (hasPath === hasText) throw new MalformedObjectError("format", "content needs exactly one of path or text");
    if (hasPath && !isInsideFiles(content.path as string)) {
      throw new MalformedObjectError("format", "content.path must point into files/");
    }
  }
  return value as IndexJson;
}

/**
 * Hidden (spec §4): any path segment beginning with `.`. Purely a
 * function of the name — the mapping has no platform attributes to
 * consult — so it is the same everywhere.
 */
export function isHidden(path: string): boolean {
  return path.split("/").some((s) => s.startsWith("."));
}

/** `files/<something>`, normalized, no traversal, nothing hidden. */
export function isInsideFiles(path: string): boolean {
  if (!path.startsWith("files/")) return false;
  const segments = path.split("/");
  return segments.every((s) => s !== "" && !s.startsWith("."));
}

/**
 * Take an object out of a mapping rooted at the object folder. The canonical
 * tree is taken by enumeration: `index.json` and everything under `files/`
 * except hidden entries (§4); any other entry is litter and is dropped (§2).
 */
export function readObject(mapping: TreeFiles): FolderObject {
  const indexBytes = mapping["index.json"];
  if (!indexBytes) throw new MalformedObjectError("format", "no index.json at the root");
  const meta = parseIndex(indexBytes);
  const tree: TreeFiles = { "index.json": indexBytes };
  for (const [path, bytes] of Object.entries(mapping)) {
    if (isInsideFiles(path)) tree[path] = bytes;
  }
  if (meta.content && "path" in meta.content && !(meta.content.path in tree)) {
    throw new MalformedObjectError("closure", `content.path ${meta.content.path} has no bytes`);
  }
  return { meta, tree };
}

/** The object's version identity: the manifest root of its canonical tree (spec §2.1). */
export async function hashObject(object: FolderObject): Promise<string> {
  const { root } = await hashTree(object.tree);
  return root;
}

/** The principal bytes, whichever form `content` takes. */
export function contentOf(object: FolderObject): { mediaType: string; bytes: Uint8Array } | undefined {
  const c = object.meta.content;
  if (!c) return undefined;
  if ("text" in c) return { mediaType: c.mediaType, bytes: new TextEncoder().encode(c.text) };
  const bytes = object.tree[c.path];
  if (!bytes) throw new MalformedObjectError("closure", `content.path ${c.path} has no bytes`);
  return { mediaType: c.mediaType, bytes };
}

/**
 * Is this listing an object's? The manifest of an object names exactly
 * the canonical tree — `index.json` and paths inside `files/`, none
 * hidden — and nothing else: a root that reaches litter, a card, or a
 * hidden file was not computed over an object, and no canonical tree
 * hashes to it. (A mapping read from a container may hold all of those
 * beside the object, and `readObject` drops them; a *hashed* tree may
 * not, and this refuses it.) Throws a format-layer MalformedObjectError.
 */
export function checkObjectPaths(paths: Iterable<string>): void {
  let index = false;
  for (const path of paths) {
    if (path === "index.json") index = true;
    else if (!isInsideFiles(path)) {
      throw new MalformedObjectError("format", `the manifest names ${JSON.stringify(path)}, which no canonical tree holds`);
    }
  }
  if (!index) throw new MalformedObjectError("format", "no index.json in the manifest");
}

/** An object read out of a verified tree: as much of it as the blocks at hand make. */
export interface VerifiedObject {
  /**
   * The object, when `index.json`'s bytes are here; `tree` (the
   * `FolderObject`'s) holds only the files whose bytes are here. Null
   * when they are not — the leaf is absent (`tree.partial` names it) or
   * declined (`tree.declined` does): every path and size known, the
   * object not yet readable here.
   */
  object: FolderObject | null;
  /** What the manifest says and what was checked: every path, size, absent or declined leaf. */
  tree: VerifiedTree;
  /** No leaf is missing and none was declined: the object is whole, and verified whole. */
  complete: boolean;
}

/**
 * Verify a tree from its root and read the object out of it, judging
 * each layer where it can be judged (spec §8): the manifest is fetched
 * and must be the canonical form naming exactly a canonical tree with
 * `index.json` (format layer — decided before any leaf is asked for);
 * then the leaves; then `index.json` must be well-formed (format) and
 * `content.path` a path the manifest names (closure). A leaf the blocks
 * lack is, with `leaves: "optional"`, a partial object — every path and
 * size known, some bytes not yet here — never a defect, `index.json`'s
 * own bytes included: then `object` is null.
 */
export async function verifyObject(
  root: string,
  objects: Map<string, Uint8Array> | GetBlock,
  options: VerifyOptions = {},
): Promise<VerifiedObject> {
  const get = getterOf(objects);
  let walked: Awaited<ReturnType<typeof walkLeaves>>;
  try {
    const { entries } = await fetchManifest(root, get);
    checkObjectPaths(entries.map((e) => e.path));
    walked = await walkLeaves(root, entries, get, options);
  } catch (err) {
    // A manifest that is not the canonical form is a format-layer defect
    // (spec §8); a missing block or a leaf that fails its hash is not.
    if (err instanceof ManifestError) throw new MalformedObjectError("format", err.message);
    throw err;
  }
  const { tree, leaves } = walked;
  const complete = tree.missing.size === 0 && tree.declined.size === 0;
  const indexBytes = leaves.get("index.json");
  if (indexBytes === undefined) return { object: null, tree, complete };
  const meta = parseIndex(indexBytes);
  if (meta.content && "path" in meta.content && !tree.files.has(meta.content.path)) {
    throw new MalformedObjectError("closure", `content.path ${meta.content.path} is not in the manifest`);
  }
  const files: TreeFiles = {};
  for (const [path, bytes] of leaves) files[path] = bytes;
  return { object: { meta, tree: files }, tree, complete };
}
