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
import { ContactStore, currentMyDid, type ContactRecord } from "./contacts.js";
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
/** Pairwise keys are named `pair/<cid>/<n>`: the contact, and the nth DID minted toward them. */
export const KEY_PAIRWISE_PREFIX = "pair/";

export interface CreateVaultOptions {
  label: string;
  /** a fresh v2 keystore document (from createSeedKeystore) — the vault adds its keys to it */
  keystore: SeedKeystoreDocument;
  seedKey: SeedKey;
  /**
   * The mediator this vault will ask for mediation. Optional: an identity
   * needs no mediator to exist, only to be reached — `setMediator` names
   * one later.
   */
  mediatorDid?: string | null;
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
   * Lay down a new vault: the anchor (index 0, a did:key), and nothing
   * else — an identity is a seed and a name. Naming a mediator here is a
   * convenience for `setMediator`, which adds the mediator-facing
   * did:peer:4 (no service); the public DID waits for mediate-grant, since
   * its service is the routing DID the grant hands out.
   */
  static async create(backend: VaultBackend, options: CreateVaultOptions): Promise<Vault> {
    if (await Vault.exists(backend)) {
      throw new Error("a vault already exists here");
    }
    if (options.keystore.keys.length !== 0) {
      throw new Error("createVault wants a fresh keystore with no keys");
    }
    const now = options.now ?? new Date();
    const anchor = await addDerivedKey(options.keystore, options.seedKey, KEY_ANCHOR, { now });

    const config: VaultConfig = {
      format: "estoc",
      version: 1,
      label: options.label,
      identity: { anchor: { key: KEY_ANCHOR, did: anchor.identity.did } },
      mediation: null,
    };
    const vault = new Vault(backend, config, anchor.doc);
    await vault.saveKeystore();
    await vault.saveConfig();
    if (options.mediatorDid !== null && options.mediatorDid !== undefined) {
      await vault.setMediator(options.seedKey, options.mediatorDid, now);
    }
    return vault;
  }

  /**
   * Name the mediator this vault will ask for mediation, and mint the
   * did:peer:4 the mediator will know it by (the `mediator` key, no
   * service). Reachability is a decision taken after the identity exists,
   * and this is where it is taken. Only for a vault without a mediator:
   * replacing one means re-minting the public DID correspondents hold,
   * which is a rotation they must be told about (from_prior) — not yet
   * offered.
   */
  async setMediator(seedKey: SeedKey, mediatorDid: string, now = new Date()): Promise<void> {
    if (this.config.mediation !== null) {
      throw new Error("vault already has a mediator; changing it is not supported yet");
    }
    const hasKey = this.keystore.keys.some((entry) => entry.name === KEY_MEDIATOR);
    const me = hasKey
      ? await this.derive(seedKey, KEY_MEDIATOR)
      : await this.mintKey(seedKey, KEY_MEDIATOR, now);
    this.config.mediation = {
      mediatorDid,
      me: { key: KEY_MEDIATOR, did: mintPeerDid(me, null).did },
      routingDid: null,
      public: null,
    };
    await this.saveConfig();
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
   * Mint a fresh pairwise did:peer:4 toward a contact — the nth key under
   * `pair/<cid>/`, with the mediator's routing DID as its service — and
   * record it as our current DID toward them, closing the previous one.
   * The record is saved; registering the DID with the mediator is the
   * agent's business (`registeredAt` stays unset here). Returns the
   * identity, whose secrets the agent adds to what it can open.
   */
  async mintPairwise(
    seedKey: SeedKey,
    contact: ContactRecord,
    routingDid: string,
    now = new Date()
  ): Promise<PeerIdentity> {
    const uses = contact.myDids ?? [];
    const n = uses.filter((use) => use.key.startsWith(KEY_PAIRWISE_PREFIX)).length + 1;
    const key = `${KEY_PAIRWISE_PREFIX}${contact.cid}/${n}`;
    // a key already in the index is the residue of a crash between minting
    // it and saving the contact: reuse it, as `establishMediation` does
    const identity = this.keystore.keys.some((entry) => entry.name === key)
      ? await this.derive(seedKey, key)
      : await this.mintKey(seedKey, key, now);
    const minted = mintPeerDid(identity, routingDid);
    const at = now.toISOString();
    const current = currentMyDid(contact);
    if (current !== null) {
      current.until = at;
    }
    contact.myDids = [...uses, { did: minted.did, key, from: at }];
    await this.contacts.put(contact);
    return minted;
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
