/**
 * `@estoc/event-store/node` — what needs Node: the backend over
 * `node:fs`, a vault in a folder on disk; and the SQLite driver over
 * `node:sqlite`. Kept out of the main entry so the browser build never
 * sees a Node import.
 */
export { FsBackend } from "./node/fs.js";
export { openNodeSqlite, type NodeSqliteOptions } from "./node/sqlite.js";
