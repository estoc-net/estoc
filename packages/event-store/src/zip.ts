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
 * a folder has it stripped. The root is the shallowest `config.json`
 * either way — a nested one, in `state/` or carried under a stray
 * `.estoc/`, is a file of the vault, not its root. Throws when no
 * `config.json` is inside.
 */
export function filesFromZip(zip: Uint8Array): VaultFiles {
  const entries = unzipSync(zip);
  const names = Object.keys(entries).filter((name) => !name.endsWith("/") && !name.startsWith("__MACOSX/"));
  const marker = `${ESTOC_DIR}/${CONFIG_FILE}`;
  const inEstoc = rootOf(names, marker);
  const bare = rootOf(names, CONFIG_FILE);
  let prefix: string;
  let addEstoc = false;
  if (inEstoc !== null && (bare === null || inEstoc.length <= bare.length)) {
    prefix = inEstoc;
  } else if (bare !== null) {
    prefix = bare;
    addEstoc = true;
  } else {
    throw new Error(`that zip holds no vault (no ${CONFIG_FILE} inside)`);
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

/**
 * The folder `marker` is at the root of: the shortest prefix any entry
 * puts before it, whatever order the archive lists them in — or null
 * when no entry ends in it.
 */
function rootOf(names: string[], marker: string): string | null {
  let best: string | null = null;
  for (const name of names) {
    if (name !== marker && !name.endsWith(`/${marker}`)) {
      continue;
    }
    const prefix = name.slice(0, name.length - marker.length);
    if (best === null || prefix.length < best.length) {
      best = prefix;
    }
  }
  return best;
}
