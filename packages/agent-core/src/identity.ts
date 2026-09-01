/**
 * The v2 vault as the agent knows it: `@estoc/vault/v2`'s folder,
 * minting did:peer:4 (`mintPeerDid`) — Multikey long form, one Ed25519
 * and one X25519 key, the mediator's routing DID as the service when
 * there is one. The format records the DIDs; this binding decides what
 * they are.
 */

import type { OpenVaultOptions, VaultBackend } from "@estoc/event-store";
import { FolderVault, KEYSTORE_FILE, NotAVault } from "@estoc/event-store";
import { parseSeedKeystore, type SeedKey, type SeedKeystoreDocument } from "@estoc/keystore";
import { createFolderVault, drafts, openFolderVault, record, type FolderOptions, type Opened } from "@estoc/vault/v2";

import { mintPeerDid, type PeerIdentity } from "./identity/peer.js";

/** What an open hands back: the folder, the keys minting did:peer:4, the fold, the anchor. */
export type PeerVault = Opened<PeerIdentity>;

/** The device's side of an open: a clock, and the folder's own options (grace, trace rotation). */
export type OpenOptions = Omit<FolderOptions<PeerIdentity>, "mint">;

export interface CreateVaultOptions extends OpenOptions {
  /** a fresh keystore document, no keys */
  keystore: SeedKeystoreDocument;
  seedKey: SeedKey;
  /** what the identity calls itself: the first `identity.label` */
  label: string;
}

/** `openFolderVault` with did:peer:4 minting: the seed checked against the anchor, the fold folded. */
export function openVault(backend: VaultBackend, seedKey: SeedKey, options: OpenOptions = {}): Promise<PeerVault> {
  return openFolderVault(backend, seedKey, { ...options, mint: mintPeerDid });
}

/** `createFolderVault` with did:peer:4 minting, then the label recorded; a mediator comes later (`Agent.setMediator`). */
export async function createVault(backend: VaultBackend, { keystore, seedKey, label, ...options }: CreateVaultOptions): Promise<PeerVault> {
  const opened = await createFolderVault(backend, keystore, seedKey, { ...options, mint: mintPeerDid });
  await record(opened.vault.events, opened.fold, drafts.identityLabel({ name: label }));
  return opened;
}

export interface Inspected {
  vault: FolderVault;
  /** `keystore.json` as it is: sealed, nothing derived */
  keystore: SeedKeystoreDocument;
}

/**
 * The vault without its seed — what a locked daemon holds: the folder
 * opened (a v1 folder, or none, is `NotAVault`) and the keystore read,
 * so the passphrase can be asked for and checked against it before
 * anything is derived. `openVault` is the next step once the seed is in hand.
 */
export async function inspectVault(backend: VaultBackend, options: OpenVaultOptions = {}): Promise<Inspected> {
  const vault = await FolderVault.open(backend, options);
  const bytes = await vault.files.read(KEYSTORE_FILE);
  if (bytes === null) {
    throw new NotAVault(`no ${KEYSTORE_FILE}`);
  }
  return { vault, keystore: parseSeedKeystore(new TextDecoder().decode(bytes)) };
}
