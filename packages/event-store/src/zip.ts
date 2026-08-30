/**
 * The interchange tree as one file (event-store.md §10.1): a backup is a
 * folder in a zip, its entries the vault's paths as they are
 * (`.estoc/config.json`, …), so that unzipping it yields the folder
 * every reader reads. Nothing is converted either way.
 */

import { unzipSync, zipSync } from "fflate";
import { CONFIG_FILE, ESTOC_DIR } from "./folder/layout.js";
import type { VaultFiles } from "./interchange.js";

/** `files` zipped, entries in path order. */
export function zipFiles(files: VaultFiles, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const path of Object.keys(files).sort()) {
    entries[path] = files[path] as Uint8Array;
  }
  return zipSync(entries, { level });
}

/**
 * The vault files inside a zip, re-rooted so that `.estoc/config.json` is
 * where a reader expects it, whatever folder the archive put around it:
 * one made from inside `.estoc/` gets the directory back; one wrapped in
 * a folder has it stripped. Throws when no `config.json` is inside.
 */
export function filesFromZip(zip: Uint8Array): VaultFiles {
  const entries = unzipSync(zip);
  const names = Object.keys(entries).filter((name) => !name.endsWith("/") && !name.startsWith("__MACOSX/"));
  const marker = `${ESTOC_DIR}/${CONFIG_FILE}`;
  let prefix: string;
  let addEstoc = false;
  const inEstoc = names.find((name) => name === marker || name.endsWith(`/${marker}`));
  if (inEstoc !== undefined) {
    prefix = inEstoc.slice(0, inEstoc.length - marker.length);
  } else {
    const bare = names.find((name) => name === CONFIG_FILE || name.endsWith(`/${CONFIG_FILE}`));
    if (bare === undefined) {
      throw new Error(`that zip holds no vault (no ${CONFIG_FILE} inside)`);
    }
    prefix = bare.slice(0, bare.length - CONFIG_FILE.length);
    addEstoc = true;
  }
  const files: VaultFiles = {};
  for (const name of names) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const rel = name.slice(prefix.length);
    files[addEstoc ? `${ESTOC_DIR}/${rel}` : rel] = entries[name] as Uint8Array;
  }
  return files;
}
