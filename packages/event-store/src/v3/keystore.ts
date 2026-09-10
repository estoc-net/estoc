/**
 * What a vault carries about itself besides events and objects: the
 * immutable metadata — the format version and the anchor DID — and the
 * wrapped seed, the one compact JWE `@estoc/keystore` version 3
 * produces, reached through `KeystoreAccess`. The shapes and their
 * checks; how a store keeps them is the store's.
 */

import { NotAVault } from "./errors.js";

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

/** A compact JWE: five base64url segments, the first — the protected header — non-empty. */
const COMPACT_JWE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]*){4}$/;

/** `value` as vault metadata, frozen; `NotAVault` on any other shape. */
export function checkMetadata(value: unknown): VaultMetadata {
  if (typeof value !== "object" || value === null) throw new NotAVault("vault metadata is an object");
  const { version, anchor } = value as { version?: unknown; anchor?: unknown };
  if (version !== 3) throw new NotAVault(`vault version ${JSON.stringify(version)} is not 3`);
  if (typeof anchor !== "string" || !anchor.startsWith("did:") || anchor.length <= 4) throw new NotAVault("the anchor is a DID");
  return Object.freeze({ version: 3, anchor });
}

/** `value` as a wrapped seed, frozen; `NotAVault` on any other shape. Only the shape: unlocking is the keystore package's. */
export function checkWrappedSeed(value: unknown): WrappedSeed {
  if (typeof value !== "object" || value === null) throw new NotAVault("a wrapped seed is an object");
  const { version, seedJwe } = value as { version?: unknown; seedJwe?: unknown };
  if (version !== 3) throw new NotAVault(`keystore version ${JSON.stringify(version)} is not 3`);
  if (typeof seedJwe !== "string" || !COMPACT_JWE.test(seedJwe)) throw new NotAVault("seedJwe is a compact JWE");
  return Object.freeze({ version: 3, seedJwe });
}
