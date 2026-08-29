/**
 * `@estoc/vault/node` — the backend that needs `node:fs`: a vault in a
 * folder on disk. Kept out of the main entry so the browser build never
 * sees a Node import.
 */
export { FsBackend } from "./node/fs.js";
