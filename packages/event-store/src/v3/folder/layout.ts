/**
 * The version-3 folder's shape (vault-folder.md §3): the six structural
 * roots, the grammar of a segment path and an object path, and
 * `kindOf`, which says what a path under `.estoc/` is — so that a
 * reader can tell the layout's own files from an opaque portable file,
 * and either from damage (§3, VF-16). Paths here are relative to
 * `.estoc/`, as the specification writes them; `ESTOC_DIR` is the
 * directory a backend rooted at the vault's parent puts in front.
 */

import { isAuthorId, isRawCid, isUuidv7 } from "../event.js";
import { OWNED_ROOTS } from "../files.js";

/** The machine's half of a portable vault: the directory the layout lives in (§1). */
export const ESTOC_DIR = ".estoc";
export const CONFIG_FILE = "config.json";
export const KEYSTORE_FILE = "keystore.json";
export const EVENTS_DIR = "events";
export const OBJECTS_DIR = "objects";
export const IMPORT_DIR = "import";
export const LOCAL_DIR = "local";
/** This copy's replica identity (§10.1), under `local/`. */
export const REPLICA_FILE = `${LOCAL_DIR}/replica.json`;

export { OWNED_ROOTS };

const SEGMENT_SUFFIX = ".jsonl";

/** Whether `name` is a segment file's name (§8): `<uuidv7>.jsonl`, the UUID canonical lowercase. */
export function isSegmentName(name: string): boolean {
  return name.endsWith(SEGMENT_SUFFIX) && isUuidv7(name.slice(0, -SEGMENT_SUFFIX.length));
}

/** The segment path of `segment` under `author` (§6, §8): `events/<author>/<segment>.jsonl`. */
export function segmentPath(author: string, segment: string): string {
  return `${EVENTS_DIR}/${author}/${segment}${SEGMENT_SUFFIX}`;
}

/** The author directory of `author` (§6): `events/<author>`. */
export function authorDir(author: string): string {
  return `${EVENTS_DIR}/${author}`;
}

export type PathKind =
  /** `config.json` (§4) */
  | "config"
  /** `keystore.json` (§5) */
  | "keystore"
  /** `events/<author>/<segment>.jsonl` (§6, §8) */
  | "segment"
  /** `objects/<raw cid>` (§9) */
  | "object"
  /** anything under `import/` (§3): backend-private staging, whose owner reads it */
  | "import"
  /** anything under `local/` (§10): this copy's own, whose owner reads it */
  | "local"
  /** an entry inside a structural root that is none of the above (§3, VF-16) */
  | "damage"
  /** a top-level path outside every structural root (§7.3): carried, never read */
  | "opaque";

/**
 * What a conforming path relative to `.estoc/` is (§3). The structural
 * roots are closed: under `events/` only `<author>/<segment>.jsonl`, under
 * `objects/` only `<raw cid>`, and `config.json` and `keystore.json` are
 * files — anything else under a root, a file where a directory belongs
 * included, is damage. `import/` and `local/` are their owners' to read.
 * Everything outside the roots is an opaque portable file.
 */
export function kindOf(path: string): PathKind {
  const parts = path.split("/");
  const root = parts[0] as string;
  switch (root) {
    case CONFIG_FILE:
      return parts.length === 1 ? "config" : "damage";
    case KEYSTORE_FILE:
      return parts.length === 1 ? "keystore" : "damage";
    case EVENTS_DIR:
      return parts.length === 3 && isAuthorId(parts[1]) && isSegmentName(parts[2] as string) ? "segment" : "damage";
    case OBJECTS_DIR:
      return parts.length === 2 && isRawCid(parts[1]) ? "object" : "damage";
    case IMPORT_DIR:
      return "import";
    case LOCAL_DIR:
      return "local";
    default:
      return "opaque";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** `bytes` as text; throws `TypeError` on bytes that are not UTF-8. */
export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** A JSON file as the folder writes one (§2): pretty-printed, ending in `\n`. */
export function prettyJson(value: unknown): Uint8Array {
  return utf8(`${JSON.stringify(value, null, 2)}\n`);
}

/** One byte string from many: the lines of a segment written whole. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
