/**
 * What a vault carries about itself besides events and objects: the
 * immutable metadata — the format version and the anchor DID — and the
 * wrapped seed, the one compact JWE `@estoc/keystore` version 3
 * produces, reached through `KeystoreAccess`. The shapes and their
 * checks; how a store keeps them is the store's.
 */

import { NotAVault } from "./errors.js";
import { parseStrict } from "./jcs.js";
import { isJsonObject } from "./json.js";

/** The vault's identity as every copy states it: the format version, and the anchor DID the seed derives. */
export type VaultMetadata = Readonly<{ version: 3; anchor: string }>;

/** The wrapped seed as the API carries it: the keystore package's compact JWE string, as it is. */
export type WrappedSeed = Readonly<{ version: 3; seedJwe: string }>;

/**
 * The wrapped seed of an open vault. `read` hands out a detached value,
 * never authority over the identity; `rewrap` replaces the wrapper under
 * the vault's operation lock, and is the unlocked host's to call once it
 * has checked that the replacement opens to the same seed — this
 * interface cannot, and does not.
 */
export interface KeystoreAccess {
  read(): Promise<WrappedSeed>;
  rewrap(next: WrappedSeed): Promise<void>;
}

/** `value` as vault metadata, frozen; `NotAVault` on any other shape. */
export function checkMetadata(value: unknown): VaultMetadata {
  if (typeof value !== "object" || value === null) throw new NotAVault("vault metadata is an object");
  const { version, anchor } = value as { version?: unknown; anchor?: unknown };
  if (version !== 3) throw new NotAVault(`vault version ${JSON.stringify(version)} is not 3`);
  if (typeof anchor !== "string" || !anchor.startsWith("did:") || anchor.length <= 4) throw new NotAVault("the anchor is a DID");
  return Object.freeze({ version: 3, anchor });
}

/**
 * The wrapper `@estoc/keystore` version 3 seals a seed in, as far as it
 * can be checked without the passphrase. The iteration bound is the one
 * the package itself refuses to unseal beyond.
 */
const PROFILE = {
  alg: "PBES2-HS512+A256KW",
  enc: "A256GCM",
  maxIterations: 5_000_000,
  leastSaltBytes: 8,
  encryptedKeyBytes: 40,
  ivBytes: 12,
  ciphertextBytes: 32,
  tagBytes: 16,
};

/** `value` as a wrapped seed of the keystore package's profile, frozen; `NotAVault` on any other. The profile, not the passphrase: whether it unseals is the keystore package's to find out. */
export function checkWrappedSeed(value: unknown): WrappedSeed {
  if (typeof value !== "object" || value === null) throw new NotAVault("a wrapped seed is an object");
  const { version, seedJwe } = value as { version?: unknown; seedJwe?: unknown };
  if (version !== 3) throw new NotAVault(`keystore version ${JSON.stringify(version)} is not 3`);
  if (typeof seedJwe !== "string") throw new NotAVault("seedJwe is a compact JWE");
  const segments = seedJwe.split(".");
  if (segments.length !== 5) throw new NotAVault("seedJwe is a compact JWE: five segments");
  const [header, ...parts] = segments.map((segment, i) => base64url(segment, `seedJwe segment ${i + 1}`)) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  checkHeader(header);
  const lengths: [number, string][] = [
    [PROFILE.encryptedKeyBytes, "encrypted key"],
    [PROFILE.ivBytes, "initialization vector"],
    [PROFILE.ciphertextBytes, "ciphertext"],
    [PROFILE.tagBytes, "authentication tag"],
  ];
  parts.forEach((bytes, i) => {
    const [expected, what] = lengths[i] as [number, string];
    if (bytes.length !== expected) throw new NotAVault(`seedJwe ${what} is ${bytes.length} bytes, not ${expected}`);
  });
  return Object.freeze({ version: 3, seedJwe });
}

function checkHeader(bytes: Uint8Array): void {
  let header: unknown;
  try {
    header = parseStrict(bytes);
  } catch (err) {
    throw new NotAVault(`seedJwe protected header is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isJsonObject(header)) throw new NotAVault("seedJwe protected header is an object");
  const names = Object.keys(header).sort();
  if (names.join(",") !== "alg,enc,p2c,p2s") throw new NotAVault(`seedJwe protected header has ${names.join(", ") || "nothing"}; the profile has alg, enc, p2c and p2s`);
  if (header["alg"] !== PROFILE.alg) throw new NotAVault(`seedJwe alg ${JSON.stringify(header["alg"])} is not ${PROFILE.alg}`);
  if (header["enc"] !== PROFILE.enc) throw new NotAVault(`seedJwe enc ${JSON.stringify(header["enc"])} is not ${PROFILE.enc}`);
  const p2c = header["p2c"];
  if (typeof p2c !== "number" || !Number.isInteger(p2c) || p2c < 1 || p2c > PROFILE.maxIterations) {
    throw new NotAVault(`seedJwe p2c ${JSON.stringify(p2c)} is not an iteration count up to ${PROFILE.maxIterations}`);
  }
  const p2s = header["p2s"];
  if (typeof p2s !== "string" || base64url(p2s, "seedJwe p2s").length < PROFILE.leastSaltBytes) throw new NotAVault(`seedJwe p2s is not a salt of at least ${PROFILE.leastSaltBytes} bytes`);
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function base64url(segment: string, what: string): Uint8Array {
  if (!BASE64URL.test(segment) || segment.length % 4 === 1) throw new NotAVault(`${what} is not base64url`);
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
