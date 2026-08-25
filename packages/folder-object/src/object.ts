import { hashTree } from "./tree.js";
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
 * Hidden, as the `unixfs-v1-2025` profile excludes it: any path segment
 * beginning with `.`. Purely a function of the name — the mapping has no
 * platform attributes to consult — so it is the same everywhere.
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

/** The object's version identity: the UnixFS root CID of its canonical tree. */
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
