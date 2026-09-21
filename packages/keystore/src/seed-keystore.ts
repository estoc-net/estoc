import { CompactEncrypt, compactDecrypt } from "jose";
import { generateSeed, importSeed, SEED_LENGTH, type SeedKey } from "./seed.js";
import type { SeedKeystoreDocument } from "./types.js";

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
  return { doc: { version: 3, seedJwe }, seedKey };
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

/** Re-seal the seed under a new passphrase. */
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

/** Serialize a store for persistence. Stable field order, trailing newline, 0600-worthy. */
export function serializeKeystore(doc: SeedKeystoreDocument): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Parse and structurally validate a persisted seed store. Unknown fields
 * are kept. Earlier formats are refused, not migrated: v1 sealed each key
 * on its own and v2 derived by index — neither holds keys this version
 * can reach by name. A document that lists `keys` is a folder-format
 * vault's cache of names, and is refused with it.
 */
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
  if (doc.version === 1) {
    throw new Error("v1 (per-key) keystores are no longer supported");
  }
  if (doc.version === 2) {
    throw new Error("v2 (index-derived) seed keystores are no longer supported");
  }
  if (doc.version !== 3) {
    throw new Error(`unsupported seed keystore version: ${String(doc.version)}`);
  }
  if (typeof doc.seedJwe !== "string") throw new Error("keystore seedJwe must be a string");
  if ("keys" in doc) throw new Error("keystores that list their keys are no longer supported");
  return raw as SeedKeystoreDocument;
}
