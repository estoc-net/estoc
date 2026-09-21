/**
 * `@estoc/event-store/node` — what needs Node: the SQLite driver over
 * `node:sqlite`. Kept out of the main entry so the browser build never
 * sees a Node import.
 */
export { openNodeSqlite, type NodeSqliteOptions } from "./node/sqlite.js";
