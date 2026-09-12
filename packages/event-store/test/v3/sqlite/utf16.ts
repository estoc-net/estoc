/**
 * Files declared UTF-16, which the wasm build cannot make and Node's
 * SQLite can: a snapshot genuinely written in UTF-16, and a UTF-8
 * snapshot whose header alone claims UTF-16. A build with UTF-16
 * support reads the first and refuses the second outright; a build
 * without cannot parse the first and reads the second as the UTF-8 it
 * is, so only the header can tell it what the file claims.
 */

import { readFile } from "node:fs/promises";

import { openNodeSqlite } from "../../../src/node.js";
import { fillPortable } from "./open-cases.js";

export async function utf16Snapshot(file: string): Promise<Uint8Array> {
  const db = openNodeSqlite(file, { mode: "create", journal: "delete" });
  try {
    db.exec("PRAGMA encoding = 'UTF-16le'");
    fillPortable(db);
  } finally {
    db.close();
  }
  return new Uint8Array(await readFile(file));
}

export async function utf16Forged(file: string): Promise<Uint8Array> {
  const db = openNodeSqlite(file, { mode: "create", journal: "delete" });
  try {
    fillPortable(db);
  } finally {
    db.close();
  }
  const bytes = new Uint8Array(await readFile(file));
  bytes.set([0, 0, 0, 2], 56);
  return bytes;
}
