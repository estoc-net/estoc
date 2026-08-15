import {
  addDerivedKey,
  openDerivedKey,
  parseSeedKeystore,
  serializeKeystore,
  type DerivedIdentity,
  type SeedKey,
  type SeedKeystoreDocument,
} from "@estoc/keystore";

import type { VaultBackend } from "../backend/types.js";
import { mintPeerDid, type PeerIdentity } from "../identity/peer.js";
import { parseConfig, type KeyRef, type VaultConfig } from "./config.js";
import { ContactStore } from "./contacts.js";
import { CONFIG_PATH, KEYSTORE_PATH, prettyJson, text, utf8 } from "./layout.js";
import { MessageLog } from "./messages.js";

/**
 * A vault: the `.estoc` directory as an object. Holds the config and the
 * keystore index in memory (both small, both ours to write), and exposes
 * the contact store and message log. Deriving keys needs the unlocked
 * seed, which the vault never keeps — callers hold the `SeedKey` and pass
 * it in, so how a passphrase becomes a seed (typed once, cached in
 * IndexedDB, or a demo's empty passphrase) stays application policy.
 */

/** Names of the keys every mediated vault has in its keystore index. */
export const KEY_ANCHOR = "anchor";
export const KEY_MEDIATOR = "mediator";
export const KEY_PUBLIC = "public";

export interface CreateVaultOptions {
  label: string;
  /** a fresh v2 keystore document (from createSeedKeystore) — the vault adds its keys to it */
  keystore: SeedKeystoreDocument;
  seedKey: SeedKey;
  /** the mediator this vault will ask for mediation; null for a vault that has none yet */
  mediatorDid: string | null;
  now?: Date;
}

export class Vault {
  readonly contacts: ContactStore;
  readonly messages: MessageLog;

  private constructor(
    private readonly backend: VaultBackend,
    public config: VaultConfig,
    public keystore: SeedKeystoreDocument
  ) {
    this.contacts = new ContactStore(backend);
    this.messages = new MessageLog(backend);
  }

  /** Is there a vault (a config.json) at this backend's root? */
  static async exists(backend: VaultBackend): Promise<boolean> {
    return (await backend.read(CONFIG_PATH)) !== null;
  }

  static async open(backend: VaultBackend): Promise<Vault> {
    const configBytes = await backend.read(CONFIG_PATH);
    if (configBytes === null) {
      throw new Error("no vault here: config.json is missing");
    }
    const keystoreBytes = await backend.read(KEYSTORE_PATH);
    if (keystoreBytes === null) {
      throw new Error("vault has no keystore.json");
    }
    return new Vault(
      backend,
      parseConfig(text(configBytes)),
      parseSeedKeystore(text(keystoreBytes))
    );
  }

  /**
   * Lay down a new vault: the anchor (index 0, a did:key) and, when a
   * mediator is named, the mediator-facing did:peer:4 (no service). The
   * public DID waits for mediate-grant, since its service is the routing
   * DID the grant hands out.
   */
  static async create(backend: VaultBackend, options: CreateVaultOptions): Promise<Vault> {
    if (await Vault.exists(backend)) {
      throw new Error("a vault already exists here");
    }
    if (options.keystore.keys.length !== 0) {
      throw new Error("createVault wants a fresh keystore with no keys");
    }
    const now = options.now ?? new Date();
    let keystore = options.keystore;

    const anchor = await addDerivedKey(keystore, options.seedKey, KEY_ANCHOR, { now });
    keystore = anchor.doc;

    let mediation: VaultConfig["mediation"] = null;
    if (options.mediatorDid !== null) {
      const me = await addDerivedKey(keystore, options.seedKey, KEY_MEDIATOR, { now });
      keystore = me.doc;
      mediation = {
        mediatorDid: options.mediatorDid,
        me: { key: KEY_MEDIATOR, did: mintPeerDid(me.identity, null).did },
        routingDid: null,
        public: null,
      };
    }

    const config: VaultConfig = {
      format: "estoc",
      version: 1,
      label: options.label,
      identity: { anchor: { key: KEY_ANCHOR, did: anchor.identity.did } },
      mediation,
    };
    const vault = new Vault(backend, config, keystore);
    await vault.saveKeystore();
    await vault.saveConfig();
    return vault;
  }

  async saveConfig(): Promise<void> {
    await this.backend.write(CONFIG_PATH, utf8(prettyJson(this.config)));
  }

  async saveKeystore(): Promise<void> {
    await this.backend.write(KEYSTORE_PATH, utf8(serializeKeystore(this.keystore)));
  }

  /** The seed-derived identity behind a keystore entry. */
  async derive(seedKey: SeedKey, name: string): Promise<DerivedIdentity> {
    return openDerivedKey(this.keystore, seedKey, name);
  }

  /**
   * Add a key to the index and derive it. The caller decides what DID to
   * mint from it and records that DID where it belongs (config or a
   * contact's myDids) — the keystore only knows the did:key of the index.
   */
  async mintKey(seedKey: SeedKey, name: string, now = new Date()): Promise<DerivedIdentity> {
    const { doc, identity } = await addDerivedKey(this.keystore, seedKey, name, { now });
    this.keystore = doc;
    await this.saveKeystore();
    return identity;
  }

  /**
   * Re-mint the did:peer:4 a key ref names and check it matches what was
   * recorded — the seed in the keystore must be the seed that minted this
   * vault's DIDs, or nothing sealed to them could be opened.
   */
  async peerIdentity(
    seedKey: SeedKey,
    ref: KeyRef,
    serviceUri: string | null
  ): Promise<PeerIdentity> {
    const identity = await this.derive(seedKey, ref.key);
    const minted = mintPeerDid(identity, serviceUri);
    if (minted.did !== ref.did) {
      throw new Error(`key "${ref.key}" no longer derives its recorded DID`);
    }
    return minted;
  }
}
