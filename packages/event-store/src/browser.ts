/**
 * `@estoc/event-store/browser` — what needs the browser: the SQLite
 * driver over `@sqlite.org/sqlite-wasm` and its OPFS access-handle pool,
 * for a Worker. Kept out of the main entry so a Node build never sees
 * the wasm module.
 */
export { openSqlitePool, type SqlitePool, type SqlitePoolOptions } from "./browser/sqlite.js";
