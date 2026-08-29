import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createSeedKeystore,
  unlockSeedKeystore,
  type DerivedIdentity,
  type SeedKeystoreDocument,
} from "@estoc/keystore";
import {
  ESTOC_DIR,
  KEY_ANCHOR,
  KEYSTORE_PATH,
  Vault as EstocVault,
  type KeyRef,
  type MintDid,
  type VaultConfig,
} from "@estoc/vault";
import { FsBackend } from "@estoc/vault/node";

export { ESTOC_DIR, type KeyRef, type VaultConfig };

/**
 * A vault is any folder the user owns with a `.estoc` directory inside —
 * the git model: the folder holds the user's content, `.estoc` holds ours.
 * The on-disk format is `@estoc/vault` (docs/vault-format.md); this module
 * finds the folder and opens it on a folder-on-disk backend for what a CLI
 * needs — the config, the keystore, keys by name.
 */
export interface Vault {
  /** The user's folder. */
  root: string;
  /** `root`/.estoc */
  dir: string;
}

/** The identity's root key (vault-format §5): what `estoc init` mints. */
export const ANCHOR_KEY_NAME = KEY_ANCHOR;

/**
 * The CLI mints no DIDs beyond the keystore's own did:key: it has no
 * mediator to name and no contacts to write to. A vault opened here is
 * read, and its keys are derived, never turned into a did:peer.
 */
const noDids: MintDid = () => {
  throw new Error("estoc mints no DIDs of its own; the app and the daemon do");
};

function vaultAt(root: string): Vault {
  const resolved = path.resolve(root);
  return { root: resolved, dir: path.join(resolved, ESTOC_DIR) };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function open(vault: Vault): Promise<EstocVault> {
  return EstocVault.open(new FsBackend(vault.root), { mint: noDids });
}

/**
 * Walk from `startDir` upward to the filesystem root looking for a `.estoc`
 * directory, like git discovering its repository.
 */
export async function findVault(startDir: string): Promise<Vault | null> {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = vaultAt(current);
    if (await isDirectory(candidate.dir)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The vault whose root is exactly `root`, or an error if none is there. */
export async function openVault(root: string): Promise<Vault> {
  const vault = vaultAt(root);
  if (!(await isDirectory(vault.dir))) {
    throw new Error(`no ${ESTOC_DIR} directory in ${vault.root}`);
  }
  return vault;
}

export interface InitResult {
  vault: Vault;
  /** did:key of the vault's anchor. */
  did: string;
}

/**
 * Create `root`/.estoc with a fresh seed sealed under `passphrase` and the
 * anchor key derived from it. Creates `root` itself if needed; refuses to
 * touch an existing `.estoc` — it holds keys. `Vault.create` writes the
 * keystore before the config, so a crash midway leaves "no vault", not a
 * vault without keys (vault-format §7); `.estoc` is 0700 and the keystore
 * 0600, and the backend keeps that mode across rewrites.
 */
export async function initVault(root: string, label: string, passphrase: string): Promise<InitResult> {
  const vault = vaultAt(root);
  if (await isDirectory(vault.dir)) {
    throw new Error(`${vault.dir} already exists`);
  }
  const { doc, seedKey } = await createSeedKeystore(passphrase);
  // Create the user's folder (if missing) with default modes; only .estoc
  // itself is tightened — the content folder is theirs, not ours.
  await mkdir(vault.root, { recursive: true });
  await mkdir(vault.dir, { mode: 0o700 });
  const created = await EstocVault.create(new FsBackend(vault.root), { label, keystore: doc, seedKey, mint: noDids });
  await chmod(path.join(vault.root, KEYSTORE_PATH), 0o600);
  return { vault, did: created.config.identity.anchor.did };
}

export async function readConfig(vault: Vault): Promise<VaultConfig> {
  return (await open(vault)).config;
}

export async function readKeystore(vault: Vault): Promise<SeedKeystoreDocument> {
  return (await open(vault)).keystore;
}

/**
 * Open the key named `name`: unlock the seed with the vault passphrase and
 * derive. Also checks the anchor first (vault-format §6.1): a seed that
 * does not derive the recorded anchor is the wrong seed for this vault.
 */
export async function openVaultKey(vault: Vault, name: string, passphrase: string): Promise<DerivedIdentity> {
  const opened = await open(vault);
  const seedKey = await unlockSeedKeystore(opened.keystore, passphrase);
  await opened.verifyAnchor(seedKey);
  return opened.derive(seedKey, name);
}

/**
 * Mint (record in the keystore cache) the key named `name`. Derivation is
 * by name, so the same name always gives the same key; adding an existing
 * name is refused here so a typo does not look like success. Returns its
 * did:key.
 */
export async function createVaultKey(vault: Vault, name: string, passphrase: string): Promise<string> {
  const opened = await open(vault);
  if (opened.keystore.keys.some((k) => k.name === name)) {
    throw new Error(`key ${JSON.stringify(name)} already exists`);
  }
  const seedKey = await unlockSeedKeystore(opened.keystore, passphrase);
  return (await opened.mintKey(seedKey, name)).did;
}
