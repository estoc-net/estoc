import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addDerivedKey,
  createSeedKeystore,
  parseSeedKeystore,
  serializeKeystore,
  unlockSeedKeystore,
  type DerivedIdentity,
  type SeedKeystoreDocument,
} from "@estoc/keystore";
import { CONFIG_PATH, ESTOC_DIR, FolderVault, KEYSTORE_FILE, NotAVault, isJsonObject, readConfig as checkConfig } from "@estoc/event-store";
import { FsBackend } from "@estoc/event-store/node";
import { KEY_ANCHOR, VaultFold, createFolderVault, drafts, openFolderVault, record, type MintDid } from "@estoc/vault/v2";

export { ESTOC_DIR };

/**
 * A vault is any folder the user owns with a `.estoc` directory inside —
 * the git model: the folder holds the user's content, `.estoc` holds ours.
 * The on-disk format is version 2 of `@estoc/vault` (docs/vault-folder.md,
 * docs/vault-events.md); this module finds the folder and opens it on a
 * folder-on-disk backend for what a CLI needs — the config, the keystore,
 * keys by name.
 */
export interface Vault {
  /** The user's folder. */
  root: string;
  /** `root`/.estoc */
  dir: string;
}

/** A key by the name it derives under, and the did:key it derives. */
export interface KeyRef {
  key: string;
  did: string;
}

/**
 * What `estoc status` shows of a vault: `config.json` (vault-folder §6.1)
 * plus the label the identity gave itself in its events.
 */
export interface VaultConfig {
  format: "estoc";
  version: 2;
  /** the latest `identity.label`; null before one is recorded */
  label: string | null;
  identity: { anchor: KeyRef };
}

/** The identity's root key (vault-folder §6.1): what `estoc init` mints. */
export const ANCHOR_KEY_NAME = KEY_ANCHOR;

/**
 * The CLI mints no DIDs beyond the keystore's own did:key: it has no
 * mediator to name and no contacts to write to. A vault opened here is
 * read, and its keys are derived, never turned into a did:peer.
 */
const noDids: MintDid = () => {
  throw new Error("estoc mints no DIDs of its own; the app and the daemon do");
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
 * Create `root`/.estoc with a fresh seed sealed under `passphrase`, the
 * anchor key derived from it, and `label` recorded as the identity's
 * first `identity.label`. Creates `root` itself if needed; refuses to
 * touch an existing `.estoc` — it holds keys. `createFolderVault` writes
 * the keystore before the config, so a crash midway leaves "no vault", not
 * a vault without keys (vault-folder §6.2); `.estoc` is 0700 and the
 * keystore 0600 from its first byte: an empty 0600 placeholder is laid
 * down before `create`, and the backend's rewrite keeps that mode.
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
  // Seed the keystore path at 0600 so the backend's mode-preserving rewrite
  // inherits it; key material is never on disk at a wider mode, even briefly.
  await writeFile(path.join(vault.dir, KEYSTORE_FILE), "", { mode: 0o600 });
  const created = await createFolderVault(new FsBackend(vault.root), doc, seedKey, { mint: noDids });
  await record(created.vault.events, created.fold, drafts.identityLabel({ name: label }));
  return { vault, did: created.anchor.did };
}

/**
 * Where every read of a vault starts (vault-folder §11): `config.json`
 * says `estoc`, version 2, and names the anchor, or nothing else of the
 * folder is read — a version 1 vault, an unknown version or a damaged
 * config is refused here, before the keystore or the events.
 */
async function preflight(backend: FsBackend, vault: Vault): Promise<KeyRef> {
  const bytes = await backend.read(CONFIG_PATH);
  if (bytes === null) {
    throw new NotAVault(`no ${CONFIG_PATH} in ${vault.root}`);
  }
  const config = checkConfig(bytes);
  const identity = config["identity"];
  const anchor = isJsonObject(identity) ? identity["anchor"] : null;
  if (!isJsonObject(anchor) || anchor["key"] !== KEY_ANCHOR || typeof anchor["did"] !== "string") {
    throw new NotAVault(`config.json has no identity.anchor { key: ${JSON.stringify(KEY_ANCHOR)}, did }`);
  }
  return { key: KEY_ANCHOR, did: anchor["did"] };
}

/** `config.json` checked (format `estoc`, version 2, an anchor), and the label folded from the events. */
export async function readConfig(vault: Vault): Promise<VaultConfig> {
  const backend = new FsBackend(vault.root);
  const anchor = await preflight(backend, vault);
  const folder = await FolderVault.open(backend);
  const fold = await VaultFold.of(folder.events);
  return { format: "estoc", version: 2, label: fold.label(), identity: { anchor } };
}

/** `keystore.json` as it is: sealed, nothing derived — after the config is checked, never before. */
export async function readKeystore(vault: Vault): Promise<SeedKeystoreDocument> {
  const backend = new FsBackend(vault.root);
  await preflight(backend, vault);
  const bytes = await backend.read(`${ESTOC_DIR}/${KEYSTORE_FILE}`);
  if (bytes === null) {
    throw new NotAVault(`no ${KEYSTORE_FILE} in ${vault.dir}`);
  }
  return parseSeedKeystore(decoder.decode(bytes));
}

/**
 * Open the key named `name`: unlock the seed with the vault passphrase and
 * derive. The open checks the anchor first (vault-folder §6.1): a seed that
 * does not derive the recorded anchor is the wrong seed for this vault.
 */
export async function openVaultKey(vault: Vault, name: string, passphrase: string): Promise<DerivedIdentity> {
  const seedKey = await unlockSeedKeystore(await readKeystore(vault), passphrase);
  const opened = await openFolderVault(new FsBackend(vault.root), seedKey, { mint: noDids });
  return opened.keys.derive(name);
}

/**
 * Mint (record in the keystore cache) the key named `name`. Derivation is
 * by name, so the same name always gives the same key; adding an existing
 * name is refused here so a typo does not look like success. Returns its
 * did:key.
 */
export async function createVaultKey(vault: Vault, name: string, passphrase: string): Promise<string> {
  const keystore = await readKeystore(vault);
  if (keystore.keys.some((k) => k.name === name)) {
    throw new Error(`key ${JSON.stringify(name)} already exists`);
  }
  const seedKey = await unlockSeedKeystore(keystore, passphrase);
  const opened = await openFolderVault(new FsBackend(vault.root), seedKey, { mint: noDids });
  const { doc, identity } = await addDerivedKey(opened.keys.keystore, seedKey, name);
  await opened.vault.files.write(KEYSTORE_FILE, encoder.encode(serializeKeystore(doc)));
  return identity.did;
}
