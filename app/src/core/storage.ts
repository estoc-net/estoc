/**
 * What the page itself asks the browser about its storage. The vault is
 * the daemon's (src/daemon/worker.ts: `.estoc/` at the root of this
 * origin's private file system); these two calls are Window-only, so the
 * UI makes them and shows the answer in the rail.
 */

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
