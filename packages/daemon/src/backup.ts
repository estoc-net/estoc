import { filesFromZip, snapshot, zipFiles, type VaultBackend } from "@estoc/event-store";

/**
 * The backup file: the vault's snapshot zipped, nothing converted
 * (event-store.md §10.1). Its entries are the vault's paths as they are
 * (`.estoc/config.json`, …) — everything but `local/` — so unzipping it
 * on a laptop yields the folder every Estoc client reads. Reading one
 * back (`filesFromZip`) re-roots whatever folder the archive put around
 * it; what the files then become is `importVault` or `restoreFolder`,
 * the daemon's `mergeBackup` and `restoreIdentity`.
 */
export async function exportBackup(backend: VaultBackend, label: string): Promise<{ name: string; bytes: Uint8Array }> {
  const files = await snapshot(backend);
  const bytes = zipFiles(files);
  const stamp = new Date().toISOString().slice(0, 10);
  const stem = label.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "vault";
  return { name: `${stem}-${stamp}.estoc.zip`, bytes };
}

export { filesFromZip };
