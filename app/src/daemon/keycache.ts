/**
 * The unlocked seed between sessions. `keystore.json` seals the seed under
 * the passphrase — that is what a backup zip carries and what a new device
 * needs typed. Here, the passphrase is typed once: the unlocked seed is a
 * WebCrypto key that never leaves the browser (HKDF, non-extractable, so
 * `deriveBits` works but reading it out does not), and IndexedDB stores
 * CryptoKey objects as such. Clearing site data drops it with everything
 * else; "Lock" drops it on purpose, and the passphrase is asked again.
 */

const DB_NAME = "estoc";
const STORE = "keys";
const SEED = "seed";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cachedSeedKey(): Promise<CryptoKey | null> {
  try {
    const db = await openDb();
    const key = await done(db.transaction(STORE, "readonly").objectStore(STORE).get(SEED));
    db.close();
    return key instanceof CryptoKey ? key : null;
  } catch {
    return null;
  }
}

export async function cacheSeedKey(key: CryptoKey): Promise<void> {
  const db = await openDb();
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(key, SEED));
  db.close();
}

/** What this device keeps of what it observes (the trace level), remembered beside the seed. */
const TRACE_LEVEL = "trace-level";

export async function traceLevel(): Promise<"off" | "normal" | "verbose"> {
  try {
    const db = await openDb();
    const level: unknown = await done(db.transaction(STORE, "readonly").objectStore(STORE).get(TRACE_LEVEL));
    db.close();
    return level === "off" || level === "verbose" ? level : "normal";
  } catch {
    return "normal";
  }
}

export async function setTraceLevel(level: "off" | "normal" | "verbose"): Promise<void> {
  const db = await openDb();
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(level, TRACE_LEVEL));
  db.close();
}

export async function forgetSeedKey(): Promise<void> {
  try {
    const db = await openDb();
    await done(db.transaction(STORE, "readwrite").objectStore(STORE).delete(SEED));
    db.close();
  } catch {
    // nothing cached, nothing to forget
  }
}
