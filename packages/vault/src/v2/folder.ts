/**
 * A v2 vault on a folder (vault-folder.md), opened for an identity: the
 * anchor fixed in `config.json` at creation (§6.1), the seed checked
 * against it on every open, the keystore beside it (§6.2), and the fold
 * over every device's events — the application's first read (§7.3 of
 * vault-events.md).
 */

import type { OpenVaultOptions, VaultBackend } from "@estoc/event-store";
import { CONFIG_PATH, ESTOC_DIR, FolderVault, KEYSTORE_FILE, NotAVault, isJsonObject, readConfig } from "@estoc/event-store";
import { addDerivedKey, serializeKeystore, type SeedKey, type SeedKeystoreDocument } from "@estoc/keystore";

import { VaultFold } from "./fold.js";
import { Keys, type KeysOptions, type MintedDid } from "./identity.js";
import { KEY_ANCHOR } from "./types.js";

export interface FolderOptions<M extends MintedDid = MintedDid> extends KeysOptions<M> {
  /** the folder's own options (grace, trace rotation); the clock above is handed down */
  vault?: OpenVaultOptions;
}

export interface Opened<M extends MintedDid = MintedDid> {
  vault: FolderVault;
  keys: Keys<M>;
  fold: VaultFold;
  anchor: { key: string; did: string };
}

function folderOptions<M extends MintedDid>(options: FolderOptions<M>): OpenVaultOptions {
  return options.clock === undefined ? { ...options.vault } : { clock: options.clock, ...options.vault };
}

/**
 * Lay down a new vault in an empty backend: an existing vault refused
 * before anything is written — creating never touches a standing
 * vault's keystore — then the anchor derived from the seed, the
 * keystore written first, alone — `open` is "config.json is
 * there", so a crash between the two leaves no vault rather than a
 * headless one — then `config.json` with the anchor, fixed for the
 * vault's life. The backend has no atomic create, so two racing creates are
 * detected, not excluded: the keystore is read back after
 * `config.json` lands, and `open` checks the cached anchor against
 * the config's — a raced vault fails loudly, at this create or at the
 * latest on its next open, never quietly inconsistent. Real mutual
 * exclusion is the caller's serialization (event-store.md §4.1): a
 * Web Lock in the browser, one process on disk.
 */
export async function createFolderVault<M extends MintedDid = MintedDid>(
  backend: VaultBackend,
  doc: SeedKeystoreDocument,
  seedKey: SeedKey,
  options: FolderOptions<M>
): Promise<Opened<M>> {
  if (doc.keys.length !== 0) {
    throw new Error("createFolderVault wants a fresh keystore with no keys");
  }
  if ((await backend.size(CONFIG_PATH)) !== null) {
    throw new NotAVault(`${CONFIG_PATH} exists already`);
  }
  const anchor = await Keys.anchorOf(seedKey);
  const { doc: withAnchor } = await addDerivedKey(doc, seedKey, KEY_ANCHOR, options.clock === undefined ? {} : { now: options.clock() });
  const text = serializeKeystore(withAnchor);
  await backend.write(`${ESTOC_DIR}/${KEYSTORE_FILE}`, new TextEncoder().encode(text));
  const vault = await FolderVault.create(backend, { identity: { anchor } }, folderOptions(options));
  const readBack = await backend.read(`${ESTOC_DIR}/${KEYSTORE_FILE}`);
  if (readBack === null || new TextDecoder().decode(readBack) !== text) {
    throw new NotAVault(`${ESTOC_DIR}/${KEYSTORE_FILE} is not the one this create wrote: another create raced it`);
  }
  const keys = await Keys.open<M>(vault, seedKey, options);
  const fold = await VaultFold.of(vault.events);
  return { vault, keys, fold, anchor };
}

/** Open a v2 vault: the folder checked, the seed checked against the anchor, the fold folded. */
export async function openFolderVault<M extends MintedDid = MintedDid>(backend: VaultBackend, seedKey: SeedKey, options: FolderOptions<M>): Promise<Opened<M>> {
  const vault = await FolderVault.open(backend, folderOptions(options));
  const config = readConfig((await backend.read(CONFIG_PATH)) as Uint8Array);
  const identity = config["identity"];
  const anchor = isJsonObject(identity) ? identity["anchor"] : null;
  if (!isJsonObject(anchor) || anchor["key"] !== KEY_ANCHOR || typeof anchor["did"] !== "string") {
    throw new NotAVault(`config.json has no identity.anchor { key: ${JSON.stringify(KEY_ANCHOR)}, did }`);
  }
  const keys = await Keys.open<M>(vault, seedKey, options);
  await keys.verifyAnchor(anchor["did"]);
  const cached = keys.keystore.keys.find((entry) => entry.name === KEY_ANCHOR);
  if (cached !== undefined && cached.did !== anchor["did"]) {
    throw new NotAVault(`keystore.json caches another seed's anchor (${cached.did}): a raced create left it — restore this seed's keystore`);
  }
  const fold = await VaultFold.of(vault.events);
  return { vault, keys, fold, anchor: { key: KEY_ANCHOR, did: anchor["did"] } };
}
