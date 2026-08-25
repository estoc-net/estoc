import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addDerivedKey,
  createSeedKeystore,
  openDerivedKey,
  parseSeedKeystore,
  serializeKeystore,
  unlockSeedKeystore,
  type DerivedIdentity,
  type SeedKeystoreDocument,
} from "@estoc/keystore";

/**
 * A vault is any folder the user owns with a `.estoc` directory inside —
 * the git model: the folder holds the user's content, `.estoc` holds ours.
 * The on-disk format is docs/vault-format.md; this module reads and writes
 * the two singletons a CLI needs, `config.json` and `keystore.json`.
 */
export const ESTOC_DIR = ".estoc";
/** The identity's root key (vault-format §5): what `estoc init` mints. */
export const ANCHOR_KEY_NAME = "anchor";

export interface Vault {
  /** The user's folder. */
  root: string;
  /** `root`/.estoc */
  dir: string;
}

/** `{key, did}` — a keystore name and the DID it was minted as (vault-format §6.1). */
export interface KeyRef {
  key: string;
  did: string;
}

export interface VaultConfig {
  format: "estoc";
  version: 1;
  /** Human label for this vault; defaults to the folder name at init. */
  label: string;
  identity: { anchor: KeyRef };
  /** Current reachability decision; the CLI never sets one, only preserves it. */
  mediation: unknown;
}

function vaultAt(root: string): Vault {
  const resolved = path.resolve(root);
  return { root: resolved, dir: path.join(resolved, ESTOC_DIR) };
}

function configPath(vault: Vault): string {
  return path.join(vault.dir, "config.json");
}

function keystorePath(vault: Vault): string {
  return path.join(vault.dir, "keystore.json");
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Write via a temp file in the same directory plus rename, so a crash never
 * leaves a truncated keystore behind. `mode` applies from the first byte.
 */
async function writeFileAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, file);
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
 * touch an existing `.estoc` — it holds keys. The keystore is written
 * before the config, so a crash midway leaves "no vault", not a vault
 * without keys (vault-format §7).
 */
export async function initVault(root: string, label: string, passphrase: string): Promise<InitResult> {
  const vault = vaultAt(root);
  if (await isDirectory(vault.dir)) {
    throw new Error(`${vault.dir} already exists`);
  }
  const created = await createSeedKeystore(passphrase);
  const { doc, identity } = await addDerivedKey(created.doc, created.seedKey, ANCHOR_KEY_NAME);
  // Create the user's folder (if missing) with default modes; only .estoc
  // itself is tightened — the content folder is theirs, not ours.
  await mkdir(vault.root, { recursive: true });
  await mkdir(vault.dir, { mode: 0o700 });
  await writeFileAtomic(keystorePath(vault), serializeKeystore(doc), 0o600);
  const config: VaultConfig = {
    format: "estoc",
    version: 1,
    label,
    identity: { anchor: { key: ANCHOR_KEY_NAME, did: identity.did } },
    mediation: null,
  };
  await writeFileAtomic(configPath(vault), JSON.stringify(config, null, 2) + "\n", 0o644);
  return { vault, did: identity.did };
}

export async function readConfig(vault: Vault): Promise<VaultConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath(vault), "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${configPath(vault)}: ${(e as Error).message}`);
  }
  const config = raw as Partial<VaultConfig>;
  if (config?.format !== "estoc") {
    throw new Error(`${configPath(vault)} is not an estoc vault config`);
  }
  if (config.version !== 1) {
    throw new Error(`unsupported vault version: ${String(config.version)}`);
  }
  if (typeof config.label !== "string") {
    throw new Error(`${configPath(vault)} is missing a string "label"`);
  }
  const anchor = config.identity?.anchor;
  if (typeof anchor?.key !== "string" || typeof anchor.did !== "string") {
    throw new Error(`${configPath(vault)} is missing identity.anchor`);
  }
  return {
    format: "estoc",
    version: 1,
    label: config.label,
    identity: { anchor: { key: anchor.key, did: anchor.did } },
    mediation: config.mediation ?? null,
  };
}

export async function readKeystore(vault: Vault): Promise<SeedKeystoreDocument> {
  return parseSeedKeystore(await readFile(keystorePath(vault), "utf8"));
}

export async function writeKeystore(vault: Vault, doc: SeedKeystoreDocument): Promise<void> {
  await writeFileAtomic(keystorePath(vault), serializeKeystore(doc), 0o600);
}

/**
 * Open the key named `name`: unlock the seed with the vault passphrase and
 * derive. Also checks the anchor first (vault-format §6.1): a seed that
 * does not derive the recorded anchor is the wrong seed for this vault.
 */
export async function openVaultKey(vault: Vault, name: string, passphrase: string): Promise<DerivedIdentity> {
  const config = await readConfig(vault);
  const doc = await readKeystore(vault);
  const seedKey = await unlockSeedKeystore(doc, passphrase);
  const anchor = await openDerivedKey(doc, seedKey, config.identity.anchor.key);
  if (anchor.did !== config.identity.anchor.did) {
    throw new Error(`keystore does not derive the vault's anchor ${config.identity.anchor.did}`);
  }
  return name === config.identity.anchor.key ? anchor : openDerivedKey(doc, seedKey, name);
}

/**
 * Mint (record in the keystore cache) the key named `name`. Derivation is
 * by name, so the same name always gives the same key; adding an existing
 * name is refused here so a typo does not look like success. Returns its
 * did:key.
 */
export async function createVaultKey(vault: Vault, name: string, passphrase: string): Promise<string> {
  const doc = await readKeystore(vault);
  if (doc.keys.some((k) => k.name === name)) {
    throw new Error(`key ${JSON.stringify(name)} already exists`);
  }
  const seedKey = await unlockSeedKeystore(doc, passphrase);
  const next = await addDerivedKey(doc, seedKey, name);
  await writeKeystore(vault, next.doc);
  return next.identity.did;
}
