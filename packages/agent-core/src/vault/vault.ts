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
import { InvitationStore, type InvitationRecord } from "./invitations.js";
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
/**
 * The mediator-facing key and the public key are minted once per
 * mediation: `mediator` and `public` for the first, `mediator/2` and
 * `public/2` after the first change of mediator, and so on — a mediator
 * change re-mints both (see `Vault.setMediator`), and the retired public
 * key stays in the index because contacts may still be told about the
 * move by it.
 */
export const KEY_MEDIATOR = "mediator";
export const KEY_PUBLIC = "public";

/** The nth mediation's name for a key: bare for the first, `/n` after. */
export function mediationKeyName(base: string, n: number): string {
  return n === 1 ? base : `${base}/${n}`;
}

/** Which mediation a `mediator`/`public` key belongs to: `mediator` → 1, `mediator/3` → 3. */
export function mediationGeneration(keyName: string): number {
  const slash = keyName.indexOf("/");
  return slash === -1 ? 1 : Number(keyName.slice(slash + 1));
}
/** Pairwise keys are named `pair/<cid>/<n>`: the contact, and the nth DID minted toward them. */
export const KEY_PAIRWISE_PREFIX = "pair/";
/** Invitation keys are named `invite/<id>`; the key keeps its name once someone takes the invitation. */
export const KEY_INVITE_PREFIX = "invite/";

/** Is this keystore entry a DID minted for one relationship — toward a contact, or waiting in an invitation? */
export function isRelationshipKey(name: string): boolean {
  return name.startsWith(KEY_PAIRWISE_PREFIX) || name.startsWith(KEY_INVITE_PREFIX);
}

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
  readonly invitations: InvitationStore;
  readonly messages: MessageLog;

  private constructor(
    private readonly backend: VaultBackend,
    public config: VaultConfig,
    public keystore: SeedKeystoreDocument
  ) {
    this.contacts = new ContactStore(backend);
    this.invitations = new InvitationStore(backend);
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
   * did:peer:4 the mediator will know it by (a `mediator` key, no
   * service). Reachability is a decision taken after the identity exists,
   * and this is where it is taken — and retaken: a vault that already has
   * a mediator moves. Moving means every DID whose service is the old
   * mediator's routing DID is retired: the public one here (a new one is
   * minted after the new grant, under `public/<n>`), and the DIDs toward
   * contacts, which the agent re-mints once it holds the new routing DID.
   * What this layer does for the move is the bookkeeping the old public DID
   * needs: a contact who wrote to it and was never answered gets it as the
   * closed first entry of `myDids`, so the answer, whenever it comes, can
   * be signed over from it (`from_prior`). Open invitations are the
   * agent's to withdraw — their DIDs lead to the old mediator too.
   */
  async setMediator(seedKey: SeedKey, mediatorDid: string, now = new Date()): Promise<void> {
    const before = this.config.mediation;
    if (before !== null && before.mediatorDid === mediatorDid) {
      throw new Error("this vault is already reached via that mediator");
    }
    const at = now.toISOString();
    if (before?.public != null) {
      await this.retirePublicDid(before.public, at);
    }
    const generation = before === null ? 1 : mediationGeneration(before.me.key) + 1;
    const key = mediationKeyName(KEY_MEDIATOR, generation);
    const hasKey = this.keystore.keys.some((entry) => entry.name === key);
    const me = hasKey ? await this.derive(seedKey, key) : await this.mintKey(seedKey, key, now);
    this.config.mediation = {
      mediatorDid,
      me: { key, did: mintPeerDid(me, null).did },
      routingDid: null,
      public: null,
    };
    await this.saveConfig();
  }

  /**
   * The public DID is about to stop being ours to receive at: every
   * contact whose latest envelope was sealed to it, and who has no DID of
   * ours toward them yet, records it as the (closed) opening entry of
   * their `myDids` — the prior a later `from_prior` will name.
   */
  private async retirePublicDid(pub: KeyRef, at: string): Promise<void> {
    for (const contact of await this.contacts.all()) {
      const uses = contact.myDids ?? [];
      if (contact.addressedAs !== pub.did || uses.some((use) => use.did === pub.did)) {
        continue;
      }
      contact.myDids = [{ did: pub.did, key: pub.key, from: contact.createdAt, until: at }, ...uses];
      await this.contacts.put(contact);
    }
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
   * Mint the DID a single-use invitation hands out — the key `invite/<id>`,
   * the mediator's routing DID as its service — and record the invitation
   * as open. Whoever answers first takes it (see the agent). Registering
   * the DID with the mediator is, again, the agent's business.
   */
  async createInvitation(
    seedKey: SeedKey,
    routingDid: string,
    goal: string,
    now = new Date()
  ): Promise<{ record: InvitationRecord; identity: PeerIdentity }> {
    const id = crypto.randomUUID();
    const key = `${KEY_INVITE_PREFIX}${id}`;
    const identity = mintPeerDid(await this.mintKey(seedKey, key, now), routingDid);
    const record: InvitationRecord = {
      id,
      key,
      did: identity.did,
      createdAt: now.toISOString(),
      goal,
    };
    await this.invitations.put(record);
    return { record, identity };
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
