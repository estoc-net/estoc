import { CompactEncrypt, compactDecrypt } from "jose";
import {
  deriveIdentity,
  generateSeed,
  importSeed,
  isValidKeyName,
  SEED_LENGTH,
  type DerivedIdentity,
  type SeedKey,
} from "./seed.js";
import type { DerivedKeyEntry, SeedKeystoreDocument } from "./types.js";

/** Same PBES2 parameters as the v1 per-key entries; see keystore.ts. */
const PBES2_ITERATIONS = 220_000;
const MAX_PBES2_ITERATIONS = 5_000_000;
const JWE_ALG = "PBES2-HS512+A256KW";
const JWE_ENC = "A256GCM";

async function sealSeed(seed: Uint8Array, passphrase: string): Promise<string> {
  return new CompactEncrypt(seed)
    .setProtectedHeader({ alg: JWE_ALG, enc: JWE_ENC })
    .setKeyManagementParameters({ p2c: PBES2_ITERATIONS })
    .encrypt(new TextEncoder().encode(passphrase));
}

async function unsealSeed(seedJwe: string, passphrase: string): Promise<Uint8Array> {
  let plaintext: Uint8Array;
  try {
    ({ plaintext } = await compactDecrypt(seedJwe, new TextEncoder().encode(passphrase), {
      keyManagementAlgorithms: [JWE_ALG],
      contentEncryptionAlgorithms: [JWE_ENC],
      maxPBES2Count: MAX_PBES2_ITERATIONS,
    }));
  } catch {
    throw new Error("cannot open seed: wrong passphrase or corrupted keystore");
  }
  if (plaintext.length !== SEED_LENGTH) {
    throw new Error(`keystore seed has ${plaintext.length} bytes, expected ${SEED_LENGTH}`);
  }
  return plaintext;
}

export interface CreateSeedKeystoreOptions {
  /** Supply the 32-byte seed instead of generating one (tests, restores). */
  seed?: Uint8Array;
}

/**
 * A new store around a fresh (or supplied) seed, sealed with `passphrase`.
 * Returns the document and the already-imported SeedKey, so the caller
 * need not unlock what it just created.
 */
export async function createSeedKeystore(
  passphrase: string,
  options: CreateSeedKeystoreOptions = {},
): Promise<{ doc: SeedKeystoreDocument; seedKey: SeedKey }> {
  const seed = options.seed ?? generateSeed();
  const seedJwe = await sealSeed(seed, passphrase);
  const seedKey = await importSeed(seed);
  return { doc: { version: 3, seedJwe, keys: [] }, seedKey };
}

/**
 * The once-per-installation step: unseal the seed with the passphrase and
 * hand back a non-extractable SeedKey. Persist that (IndexedDB) and every
 * later derivation is passphrase-free.
 */
export async function unlockSeedKeystore(doc: SeedKeystoreDocument, passphrase: string): Promise<SeedKey> {
  const seed = await unsealSeed(doc.seedJwe, passphrase);
  const key = await importSeed(seed);
  seed.fill(0);
  return key;
}

/** Re-seal the seed under a new passphrase. Entries are untouched. */
export async function changeSeedPassphrase(
  doc: SeedKeystoreDocument,
  oldPassphrase: string,
  newPassphrase: string,
): Promise<SeedKeystoreDocument> {
  const seed = await unsealSeed(doc.seedJwe, oldPassphrase);
  const seedJwe = await sealSeed(seed, newPassphrase);
  seed.fill(0);
  return { ...doc, seedJwe };
}

export interface AddDerivedKeyOptions {
  /** Override the creation timestamp (tests). */
  now?: Date;
}

function verify(identity: DerivedIdentity, recordedDid: string): void {
  if (identity.did !== recordedDid) {
    throw new Error(
      `entry ${JSON.stringify(identity.name)}: seed does not derive its recorded DID (wrong seed or corrupted entry)`,
    );
  }
}

/**
 * Derive the key named `name` and record it in the store's cache. Returns
 * the new document (input not mutated) and the derived identity.
 *
 * Idempotent by name: the name is the derivation path, so adding a name
 * that is already listed derives the same key, checks it against the
 * recorded DID, and returns the document unchanged. Callers pick names
 * that are never reused for a different key (an id of the thing the key
 * belongs to, not a counter).
 */
export async function addDerivedKey(
  doc: SeedKeystoreDocument,
  seedKey: SeedKey,
  name: string,
  options: AddDerivedKeyOptions = {},
): Promise<{ doc: SeedKeystoreDocument; identity: DerivedIdentity }> {
  const identity = await deriveIdentity(seedKey, name);
  const existing = doc.keys.find((k) => k.name === name);
  if (existing) {
    verify(identity, existing.did);
    return { doc, identity };
  }
  const entry: DerivedKeyEntry = {
    name,
    did: identity.did,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  return { doc: { ...doc, keys: [...doc.keys, entry] }, identity };
}

/**
 * Derive the identity named `name`. The cache entry is optional — a name
 * from another file (a config, a contact record) derives whether or not
 * this store has listed it — but when present its DID must match.
 */
export async function openDerivedKey(
  doc: SeedKeystoreDocument,
  seedKey: SeedKey,
  name: string,
): Promise<DerivedIdentity> {
  const identity = await deriveIdentity(seedKey, name);
  const entry = doc.keys.find((k) => k.name === name);
  if (entry) verify(identity, entry.did);
  return identity;
}

/**
 * Drop the cache entry named `name`. This forgets the listing, not the key:
 * the same name still derives the same key, which is why names are never
 * reused for something else.
 */
export function removeDerivedKey(doc: SeedKeystoreDocument, name: string): SeedKeystoreDocument {
  if (!doc.keys.some((k) => k.name === name)) {
    throw new Error(`no key named ${JSON.stringify(name)}`);
  }
  return { ...doc, keys: doc.keys.filter((k) => k.name !== name) };
}

/** Parse and structurally validate a persisted seed store. Unknown fields are kept. */
export function parseSeedKeystore(json: string): SeedKeystoreDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("keystore file is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("keystore file must be a JSON object");
  }
  const doc = raw as { version?: unknown; seedJwe?: unknown; keys?: unknown };
  if (doc.version === 2) {
    throw new Error("v2 (index-derived) seed keystores are no longer supported");
  }
  if (doc.version !== 3) {
    throw new Error(`unsupported seed keystore version: ${String(doc.version)}`);
  }
  if (typeof doc.seedJwe !== "string") throw new Error("keystore seedJwe must be a string");
  if (!Array.isArray(doc.keys)) throw new Error("keystore keys must be an array");
  const names = new Set<string>();
  for (const entry of doc.keys as unknown[]) {
    const e = entry as Record<string, unknown>;
    for (const field of ["name", "did", "createdAt"] as const) {
      if (typeof e?.[field] !== "string") {
        throw new Error(`keystore entry is missing string field ${JSON.stringify(field)}`);
      }
    }
    if (!isValidKeyName(e.name as string)) {
      throw new Error(`keystore entry has an invalid name ${JSON.stringify(e.name)}`);
    }
    if (names.has(e.name as string)) throw new Error(`duplicate key name ${JSON.stringify(e.name)}`);
    names.add(e.name as string);
  }
  return raw as SeedKeystoreDocument;
}
