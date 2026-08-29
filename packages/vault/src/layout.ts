/**
 * The `.estoc` layout — the on-disk contract shared by every Estoc client,
 * whatever backend holds the bytes. The contract itself is
 * `docs/vault-format.md` at the repository root; this file names its paths.
 *
 *   .estoc/
 *     config.json            singleton: label, identity anchor, mediation snapshot
 *     keystore.json          singleton: @estoc/keystore v3 — one sealed seed + a cache of key names
 *     contacts/<cid>.json    record: one mutable file per contact
 *     invitations/<id>.json  record: single-use invitations issued, by message id
 *     messages/<uuid>.jsonl    log: append-only; readers take every segment, in name order
 *     deliveries/<uuid>.jsonl  log: what became of each outbound message
 *     trace/<stream>/<uuid>.jsonl  log, with a retention: this device's observations
 *                            (envelopes, wire, mediation); the one log segments are
 *                            deleted from; never in a snapshot
 *     state/                 reserved: high-churn per-person state (cursors, drafts)
 *     blobs/<hash>           reserved: content-addressed attachment bytes
 *     cache/                 reserved: rebuildable; never in a snapshot, never merged
 *
 * A snapshot is everything under `.estoc/` except `cache/` and `trace/` —
 * not the list above; a client never drops from a backup what another
 * wrote.
 */
export const ESTOC_DIR = ".estoc";
export const CONFIG_PATH = `${ESTOC_DIR}/config.json`;
export const KEYSTORE_PATH = `${ESTOC_DIR}/keystore.json`;
export const CONTACTS_DIR = `${ESTOC_DIR}/contacts`;
export const INVITATIONS_DIR = `${ESTOC_DIR}/invitations`;
export const MESSAGES_DIR = `${ESTOC_DIR}/messages`;
export const DELIVERIES_DIR = `${ESTOC_DIR}/deliveries`;
export const TRACE_DIR = `${ESTOC_DIR}/trace`;
export const STATE_DIR = `${ESTOC_DIR}/state`;
export const BLOBS_DIR = `${ESTOC_DIR}/blobs`;
export const CACHE_DIR = `${ESTOC_DIR}/cache`;

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
