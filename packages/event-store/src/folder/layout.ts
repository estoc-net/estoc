/**
 * The folder's paths (vault-folder.md §3) and the shape tests that tell
 * a segment and a blob from a file (§9.6). Paths here are relative to
 * the vault root; the machine's half is `.estoc/`.
 */

import { isCid } from "../cid.js";
import { isDeviceId, isUuidv7 } from "../event.js";

export const ESTOC_DIR = ".estoc";
export const CONFIG_FILE = "config.json";
export const KEYSTORE_FILE = "keystore.json";
export const DEVICES_DIR = "devices";
export const BLOBS_DIR = "blobs";
export const EXTENSIONS_DIR = "extensions";
export const LOCAL_DIR = "local";
export const SELF_FILE = "self.json";

const SEGMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/;

/** Whether `name` is a segment file: `<uuidv7>.jsonl`, lowercase (§5). */
export function isSegmentName(name: string): boolean {
  return SEGMENT_NAME.test(name);
}

/** Whether `name` is an extension store's directory name: the uuidv7 `extension.installed` minted (§3.1). */
export function isExtId(name: string): boolean {
  return isUuidv7(name);
}

export type PathKind = "segment" | "blob" | "local" | "file";

/**
 * What a path relative to `.estoc/` is (§9.6): a segment
 * (`devices/<dev>/<seg>.jsonl`), a blob (`blobs/<cid>`), the same two
 * under `extensions/<ext>/`, this copy's own (`local/...`), or a file —
 * whatever else, carried and never read.
 */
export function kindOf(path: string): PathKind {
  const parts = path.split("/");
  if (parts[0] === LOCAL_DIR) {
    return "local";
  }
  if (parts[0] === EXTENSIONS_DIR && parts.length > 2 && isExtId(parts[1] as string)) {
    // an extension's tree has segments and blobs and nothing else (§3.1): no local/, no extensions/ of its own
    return storeKind(parts.slice(2));
  }
  return storeKind(parts);
}

/** A segment or a blob by shape, under one store's root; anything else a file. */
function storeKind(parts: string[]): PathKind {
  if (parts.length === 3 && parts[0] === DEVICES_DIR && isDeviceId(parts[1]) && isSegmentName(parts[2] as string)) {
    return "segment";
  }
  if (parts.length === 2 && parts[0] === BLOBS_DIR && isCid(parts[1])) {
    return "blob";
  }
  return "file";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** A JSON file as the folder writes one: pretty-printed, trailing newline (§1). */
export function prettyJson(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value, null, 2) + "\n");
}

/** A JSONL line as the folder writes one: compact, terminated (§1). */
export function jsonLine(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value) + "\n");
}
