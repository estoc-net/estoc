import { CompactEncrypt, compactDecrypt } from "jose";
import { deriveIdentity, generateSeed, importSeed, SEED_LENGTH, type DerivedIdentity, type SeedKey } from "./seed.js";
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
  return { doc: { version: 2, seedJwe, nextIndex: 0, keys: [] }, seedKey };
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

/**
 * Allocate the next derivation index under `name`. Returns the new document
 * (input not mutated) and the derived identity. Indices are never reused,
 * even after removal — reuse would resurrect a removed DID.
 */
export async function addDerivedKey(
  doc: SeedKeystoreDocument,
  seedKey: SeedKey,
  name: string,
  options: AddDerivedKeyOptions = {},
): Promise<{ doc: SeedKeystoreDocument; identity: DerivedIdentity }> {
  if (name.length === 0) throw new Error("key name must not be empty");
  if (doc.keys.some((k) => k.name === name)) {
    throw new Error(`key ${JSON.stringify(name)} already exists`);
  }
  const index = doc.nextIndex;
  const identity = await deriveIdentity(seedKey, index);
  const entry: DerivedKeyEntry = {
    name,
    index,
    did: identity.did,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  return {
    doc: { ...doc, nextIndex: index + 1, keys: [...doc.keys, entry] },
    identity,
  };
}

/** Re-derive the identity named `name`, checking it still matches its recorded DID. */
export async function openDerivedKey(
  doc: SeedKeystoreDocument,
  seedKey: SeedKey,
  name: string,
): Promise<DerivedIdentity> {
  const entry = doc.keys.find((k) => k.name === name);
  if (!entry) throw new Error(`no key named ${JSON.stringify(name)}`);
  const identity = await deriveIdentity(seedKey, entry.index);
  if (identity.did !== entry.did) {
    throw new Error(
      `entry ${JSON.stringify(name)}: seed does not derive its recorded DID (wrong seed or corrupted entry)`,
    );
  }
  return identity;
}

/** Remove the entry named `name`. Its index stays burned (see addDerivedKey). */
export function removeDerivedKey(doc: SeedKeystoreDocument, name: string): SeedKeystoreDocument {
  if (!doc.keys.some((k) => k.name === name)) {
    throw new Error(`no key named ${JSON.stringify(name)}`);
  }
  return { ...doc, keys: doc.keys.filter((k) => k.name !== name) };
}

/** Parse and structurally validate a persisted seed store. */
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
  const doc = raw as { version?: unknown; seedJwe?: unknown; nextIndex?: unknown; keys?: unknown };
  if (doc.version !== 2) {
    throw new Error(`unsupported seed keystore version: ${String(doc.version)}`);
  }
  if (typeof doc.seedJwe !== "string") throw new Error("keystore seedJwe must be a string");
  if (!Number.isInteger(doc.nextIndex) || (doc.nextIndex as number) < 0) {
    throw new Error("keystore nextIndex must be a non-negative integer");
  }
  if (!Array.isArray(doc.keys)) throw new Error("keystore keys must be an array");
  const names = new Set<string>();
  const indices = new Set<number>();
  for (const entry of doc.keys as unknown[]) {
    const e = entry as Record<string, unknown>;
    for (const field of ["name", "did", "createdAt"] as const) {
      if (typeof e?.[field] !== "string") {
        throw new Error(`keystore entry is missing string field ${JSON.stringify(field)}`);
      }
    }
    if (!Number.isInteger(e.index) || (e.index as number) < 0 || (e.index as number) >= (doc.nextIndex as number)) {
      throw new Error(`keystore entry ${JSON.stringify(e.name)} has an invalid index`);
    }
    if (names.has(e.name as string)) throw new Error(`duplicate key name ${JSON.stringify(e.name)}`);
    if (indices.has(e.index as number)) throw new Error(`duplicate key index ${String(e.index)}`);
    names.add(e.name as string);
    indices.add(e.index as number);
  }
  return raw as SeedKeystoreDocument;
}
