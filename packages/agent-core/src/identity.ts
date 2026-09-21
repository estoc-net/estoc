/**
 * The vault as the agent opens it: the SQLite runtime under
 * `@estoc/event-store` with the seed's keys under `@estoc/vault`.
 * The host opens the driver — a file on Node, the access-handle pool
 * in a browser Worker — in the mode each entry asks for, and the
 * driver's ownership is the runtime's from then on: an open that
 * fails closes it. Every writable open verifies the seed against the
 * vault's anchor before anything is derived or written; the fold is
 * read once at open, as the first step of recovery, and re-read by
 * every procedure under the lock.
 */

import {
  SqliteVault,
  createRuntime,
  openInspector,
  openPortable,
  openRuntime,
  validatePortable,
  type PortableDatabase,
  type SqliteDriver,
  type SqliteVaultOptions,
  type Validated,
  type WrappedSeed,
} from "@estoc/event-store";
import { unlockSeedKeystore, type SeedKey } from "@estoc/keystore";
import { Keys, scanVault, vaultDraft, vaultHeldRoots, type ScanOptions, type VaultFold } from "@estoc/vault";

/** What a writable open hands back: the runtime, the seed's keys, and the fold as the vault stood at open. */
export interface OpenedVault {
  runtime: SqliteVault;
  keys: Keys;
  fold: VaultFold;
}

export interface VaultOptions extends SqliteVaultOptions, ScanOptions {}

export interface OpenVaultOptions extends VaultOptions {
  /**
   * The runtime takes a fresh replica ID and store generation as it
   * opens, its history untouched: for a copy of a vault that went on
   * being written elsewhere under the same replica ID, which a merge
   * refuses as a forked author until one of the two is renewed.
   */
  resetIdentity?: boolean;
}

/** The seed in hand, or the passphrase that unlocks the wrapped seed the vault holds. */
export type Unlock = SeedKey | { passphrase: string };

/**
 * Opens the runtime in `driver`, opened `readwrite`, and verifies the
 * seed: given outright, its anchor is compared with the vault's; given
 * as a passphrase, the vault's wrapped seed is unlocked with it first,
 * so a wrong passphrase fails before any comparison. Either failure
 * closes the driver.
 */
export async function openVault(driver: SqliteDriver, unlock: Unlock, { resetIdentity, ...options }: OpenVaultOptions = {}): Promise<OpenedVault> {
  let seedKey: SeedKey | undefined = "passphrase" in unlock ? undefined : unlock;
  const db = await openRuntime(driver, {
    anchor: async (wrapped) => {
      if (seedKey === undefined) seedKey = await unlockSeedKeystore({ version: 3, seedJwe: wrapped.seedJwe }, (unlock as { passphrase: string }).passphrase);
      return Keys.anchorOf(seedKey);
    },
    ...(resetIdentity === true ? { resetIdentity } : {}),
  });
  const keys = await Keys.open(seedKey as SeedKey, db.metadata.anchor);
  return opened(new SqliteVault(db, options), keys, options);
}

export interface CreateVaultOptions extends VaultOptions {
  seedKey: SeedKey;
  /** the seed sealed under the passphrase, as `@estoc/keystore` version 3 seals it: what the vault keeps and every snapshot carries */
  wrapped: WrappedSeed;
  /** what the identity calls itself: the first `identity.label` */
  label: string;
}

/** Creates the vault in `driver`, opened to create, under the seed's anchor, and records its label. */
export async function createVault(driver: SqliteDriver, { seedKey, wrapped, label, ...options }: CreateVaultOptions): Promise<OpenedVault> {
  const anchor = await Keys.anchorOf(seedKey);
  const db = createRuntime(driver, { metadata: { version: 3, anchor }, wrapped });
  const keys = await Keys.open(seedKey, anchor);
  const runtime = new SqliteVault(db, options);
  try {
    await runtime.vault.commit([], [vaultDraft("identity.label", { name: label })]);
  } catch (err) {
    await runtime.close();
    throw err;
  }
  return opened(runtime, keys, options);
}

async function opened(runtime: SqliteVault, keys: Keys, options: ScanOptions): Promise<OpenedVault> {
  try {
    return { runtime, keys, fold: await scanVault(runtime.vault, keys, options) };
  } catch (err) {
    await runtime.close();
    throw err;
  }
}

/** A runtime looked at without its seed: nothing is written, nothing derived; the fold carries no key verdicts. */
export interface InspectedRuntime {
  runtime: SqliteVault;
  /** the wrapped seed as it is, for a passphrase to be tried against (`Keys.unlock`) before the vault is reopened to run */
  wrapped: WrappedSeed;
  fold: VaultFold;
}

/**
 * The runtime in `driver`, opened `readwrite` — the one mode that owns
 * the file — to look at: what a locked host holds before the passphrase
 * is given. Every write is refused. Running the vault is a second open,
 * on a fresh driver, once this one is closed.
 */
export async function inspectRuntime(driver: SqliteDriver, options: VaultOptions = {}): Promise<InspectedRuntime> {
  const db = openInspector(driver);
  const runtime = new SqliteVault(db, options);
  try {
    const wrapped = await runtime.keystore.read();
    return { runtime, wrapped, fold: await scanVault(runtime.vault, null, options) };
  } catch (err) {
    await runtime.close();
    throw err;
  }
}

/** A portable snapshot looked at: validated whole against its own fold's retention, then folded without key verdicts. */
export interface InspectedSnapshot {
  snapshot: PortableDatabase;
  validated: Validated;
  fold: VaultFold;
}

export interface InspectSnapshotOptions extends ScanOptions {
  /** the most bytes the file may hold; unbounded when left out */
  maxFileBytes?: number;
}

/** The snapshot in `driver`, opened `readonly`: its headers and metadata checked, its events and objects validated, its fold read. An invalid snapshot closes the driver. */
export async function inspectSnapshot(driver: SqliteDriver, options: InspectSnapshotOptions = {}): Promise<InspectedSnapshot> {
  const snapshot = openPortable(driver, options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes });
  try {
    const validated = await validatePortable(snapshot, { heldRoots: vaultHeldRoots(null, options) });
    return { snapshot, validated, fold: await scanVault(snapshot.vault, null, options) };
  } catch (err) {
    snapshot.close();
    throw err;
  }
}
