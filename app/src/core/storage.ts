import { ESTOC_DIR, OpfsBackend } from "@estoc/agent-core";

/**
 * Where the vault lives: the `.estoc/` directory at the root of this
 * origin's Origin Private File System — one identity per install, the
 * folder itself the format. Nothing else of the identity is kept anywhere
 * else: what a backup zip holds is exactly this directory.
 *
 * The browser owns the bytes and may, unless storage is persisted, evict
 * them; the rail says which it is, and the zip is the way out either way.
 */

export async function vaultBackend(): Promise<OpfsBackend> {
  return new OpfsBackend(await navigator.storage.getDirectory());
}

/** Remove the vault directory outright — the "forget this identity" action. */
export async function wipeVault(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(ESTOC_DIR, { recursive: true });
  } catch (err) {
    if ((err as { name?: string }).name !== "NotFoundError") {
      throw err;
    }
  }
}

/**
 * Ask the browser to treat this origin's storage as persistent — not
 * evictable under pressure. Chromium grants it silently to installed apps
 * and to sites the user engages with; Firefox asks; Safari grants it to
 * home-screen apps. Returns whether it is now persisted.
 */
export async function persistStorage(): Promise<boolean> {
  if (!("storage" in navigator) || typeof navigator.storage.persist !== "function") {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  if (!("storage" in navigator) || typeof navigator.storage.persisted !== "function") {
    return false;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}
