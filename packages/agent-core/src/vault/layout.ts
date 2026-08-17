/**
 * The `.estoc` layout — the on-disk contract shared by every Estoc client,
 * whatever backend holds the bytes:
 *
 *   .estoc/
 *     config.json          label, identity anchor, mediation snapshot
 *     keystore.json        @estoc/keystore v2: one sealed seed + key index
 *     contacts/<name>.json one mutable record per contact, cid-anchored
 *     invitations/<id>.json  single-use invitations issued, by message id
 *     messages/NNNN.jsonl  append-only log; readers take every segment
 *     deliveries/NNNN.jsonl  what became of each outbound message, same shape
 */
export const ESTOC_DIR = ".estoc";
export const CONFIG_PATH = `${ESTOC_DIR}/config.json`;
export const KEYSTORE_PATH = `${ESTOC_DIR}/keystore.json`;
export const CONTACTS_DIR = `${ESTOC_DIR}/contacts`;
export const INVITATIONS_DIR = `${ESTOC_DIR}/invitations`;
export const MESSAGES_DIR = `${ESTOC_DIR}/messages`;
export const DELIVERIES_DIR = `${ESTOC_DIR}/deliveries`;
/** The one segment the v1 writer appends to; readers never assume it is the only one. */
export const FIRST_SEGMENT = "0001.jsonl";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
