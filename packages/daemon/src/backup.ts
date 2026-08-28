import { unzipSync, zipSync } from "fflate";
import {
  CONFIG_PATH,
  ESTOC_DIR,
  importVault,
  snapshotVault,
  type ImportOutcome,
  type VaultBackend,
  type VaultFiles,
} from "@estoc/agent-core";

/**
 * The backup file: the vault directory zipped, nothing converted. Its
 * entries are the vault's paths as they are (`.estoc/config.json`, …), so
 * unzipping it on a laptop yields the folder every Estoc client reads.
 * Import takes that zip back — or one somebody wrapped in a folder, or
 * one made from inside `.estoc/` — and hands the files to agent-core,
 * whose import merges rather than overwrites.
 */

export async function exportBackup(backend: VaultBackend, label: string): Promise<{ name: string; bytes: Uint8Array }> {
  const files = await snapshotVault(backend);
  const bytes = zipSync(files, { level: 6 });
  const stamp = new Date().toISOString().slice(0, 10);
  const stem = label.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "vault";
  return { name: `${stem}-${stamp}.estoc.zip`, bytes };
}

/**
 * The vault files inside a zip, re-rooted so `.estoc/config.json` is where
 * agent-core expects it, whatever folder the archive put around it.
 */
export function vaultFilesFromZip(zip: Uint8Array): VaultFiles {
  const entries = unzipSync(zip);
  const names = Object.keys(entries).filter(
    (name) => !name.endsWith("/") && !name.startsWith("__MACOSX/")
  );
  // where is config.json? prefer one inside a `.estoc/` directory
  const marker = `${ESTOC_DIR}/config.json`;
  let prefix: string | null = null;
  let addEstoc = false;
  const inEstoc = names.find((name) => name === marker || name.endsWith(`/${marker}`));
  if (inEstoc !== undefined) {
    prefix = inEstoc.slice(0, inEstoc.length - marker.length);
  } else {
    const bare = names.find((name) => name === "config.json" || name.endsWith("/config.json"));
    if (bare === undefined) {
      throw new Error("that zip holds no vault (no config.json inside)");
    }
    prefix = bare.slice(0, bare.length - "config.json".length);
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
  if (files[CONFIG_PATH] === undefined) {
    throw new Error("that zip holds no vault (no config.json inside)");
  }
  return files;
}

export async function importBackup(backend: VaultBackend, zip: Uint8Array): Promise<ImportOutcome> {
  return importVault(backend, vaultFilesFromZip(zip));
}
