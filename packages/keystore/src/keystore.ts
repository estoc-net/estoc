import { CompactEncrypt, compactDecrypt, base64url } from "jose";
import { ed25519 } from "@noble/curves/ed25519";
import { didKeySignerFromPrivateKey, generatePrivateKey } from "./signer.js";
import type { DidKeySigner, KeyInfo, KeystoreDocument, SeedKeystoreDocument } from "./types.js";

/**
 * PBES2 iteration count for new entries (current OWASP recommendation for
 * PBKDF2-HMAC-SHA512). On decrypt anything up to MAX_PBES2_ITERATIONS is
 * accepted, so this can be raised later without breaking existing stores.
 */
const PBES2_ITERATIONS = 220_000;
const MAX_PBES2_ITERATIONS = 5_000_000;

const JWE_ALG = "PBES2-HS512+A256KW";
const JWE_ENC = "A256GCM";

export interface CreateKeyOptions {
  /** Supply the 32-byte Ed25519 private key instead of generating one (tests, imports). */
  privateKey?: Uint8Array;
  /** Override the creation timestamp (tests). */
  now?: Date;
}

/** A new, empty store document. */
export function emptyKeystore(): KeystoreDocument {
  return { version: 1, keys: [] };
}

/** The public contents — no passphrase involved. Works for both store versions. */
export function listKeys(doc: KeystoreDocument | SeedKeystoreDocument): KeyInfo[] {
  return doc.keys.map(({ name, did, createdAt }) => ({ name, did, createdAt }));
}

/**
 * Add a key under `name`, sealed with `passphrase`. Returns the new document
 * (the input is not mutated) and an already-open Signer for the new key.
 */
export async function createKey(
  doc: KeystoreDocument,
  name: string,
  passphrase: string,
  options: CreateKeyOptions = {},
): Promise<{ doc: KeystoreDocument; signer: DidKeySigner }> {
  if (name.length === 0) throw new Error("key name must not be empty");
  if (doc.keys.some((k) => k.name === name)) {
    throw new Error(`key ${JSON.stringify(name)} already exists`);
  }
  const privateKey = options.privateKey ?? generatePrivateKey();
  const signer = didKeySignerFromPrivateKey(privateKey);

  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: base64url.encode(ed25519.getPublicKey(privateKey)),
    d: base64url.encode(privateKey),
  };
  const privateKeyJwe = await new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(jwk)),
  )
    .setProtectedHeader({ alg: JWE_ALG, enc: JWE_ENC })
    .setKeyManagementParameters({ p2c: PBES2_ITERATIONS })
    .encrypt(new TextEncoder().encode(passphrase));

  const entry = {
    name,
    did: signer.did(),
    createdAt: (options.now ?? new Date()).toISOString(),
    privateKeyJwe,
  };
  return { doc: { version: 1, keys: [...doc.keys, entry] }, signer };
}

/** Unseal the key named `name` and return it as a Signer. */
export async function openKey(
  doc: KeystoreDocument,
  name: string,
  passphrase: string,
): Promise<DidKeySigner> {
  const entry = doc.keys.find((k) => k.name === name);
  if (!entry) throw new Error(`no key named ${JSON.stringify(name)}`);

  let plaintext: Uint8Array;
  try {
    ({ plaintext } = await compactDecrypt(
      entry.privateKeyJwe,
      new TextEncoder().encode(passphrase),
      {
        keyManagementAlgorithms: [JWE_ALG],
        contentEncryptionAlgorithms: [JWE_ENC],
        maxPBES2Count: MAX_PBES2_ITERATIONS,
      },
    ));
  } catch {
    throw new Error(`cannot open key ${JSON.stringify(name)}: wrong passphrase or corrupted entry`);
  }

  const jwk = JSON.parse(new TextDecoder().decode(plaintext)) as {
    kty?: string;
    crv?: string;
    d?: string;
  };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string") {
    throw new Error(`entry ${JSON.stringify(name)} does not hold an Ed25519 private JWK`);
  }
  const signer = didKeySignerFromPrivateKey(base64url.decode(jwk.d));
  if (signer.did() !== entry.did) {
    throw new Error(`entry ${JSON.stringify(name)}: private key does not match its recorded DID`);
  }
  return signer;
}

/** Remove the key named `name`. Returns the new document; the input is not mutated. */
export function removeKey(doc: KeystoreDocument, name: string): KeystoreDocument {
  if (!doc.keys.some((k) => k.name === name)) {
    throw new Error(`no key named ${JSON.stringify(name)}`);
  }
  return { version: 1, keys: doc.keys.filter((k) => k.name !== name) };
}

/** Serialize either store version for persistence. Stable field order, trailing newline, 0600-worthy. */
export function serializeKeystore(doc: KeystoreDocument | SeedKeystoreDocument): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Parse and structurally validate a persisted store. */
export function parseKeystore(json: string): KeystoreDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("keystore file is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("keystore file must be a JSON object");
  }
  const doc = raw as { version?: unknown; keys?: unknown };
  if (doc.version === 2 || doc.version === 3) {
    throw new Error(`this is a v${doc.version} seed keystore; use parseSeedKeystore`);
  }
  if (doc.version !== 1) {
    throw new Error(`unsupported keystore version: ${String(doc.version)}`);
  }
  if (!Array.isArray(doc.keys)) {
    throw new Error("keystore keys must be an array");
  }
  const seen = new Set<string>();
  for (const entry of doc.keys as unknown[]) {
    const e = entry as Record<string, unknown>;
    for (const field of ["name", "did", "createdAt", "privateKeyJwe"] as const) {
      if (typeof e?.[field] !== "string") {
        throw new Error(`keystore entry is missing string field ${JSON.stringify(field)}`);
      }
    }
    if (seen.has(e.name as string)) {
      throw new Error(`duplicate key name ${JSON.stringify(e.name)}`);
    }
    seen.add(e.name as string);
  }
  return raw as KeystoreDocument;
}
