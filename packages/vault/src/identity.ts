/**
 * The identity operations (vault-events.md §2, §5) against
 * `@estoc/keystore` v3: one seed, keys derived by name, the log the
 * truth about which names exist and `keystore.json`'s `keys[]` a cache
 * of it (vault-folder.md §6.2). Every mint appends the event that names
 * the key first and writes the cache second — a crash between the two
 * leaves a name the log derives on demand, never a key nobody references.
 *
 * What a key is minted *as* is the caller's: a `MintDid` turns a derived
 * key and a routing DID into a did:peer:4 (the agent) or anything with a
 * `did` (a test).
 */

import type { EventStore, FileStore } from "@estoc/event-store";
import { KEYSTORE_FILE, NotAVault } from "@estoc/event-store";
import { addDerivedKey, deriveIdentity, parseSeedKeystore, serializeKeystore, type DerivedIdentity, type SeedKey, type SeedKeystoreDocument } from "@estoc/keystore";
import { v7 as uuidv7 } from "uuid";

import { drafts } from "./drafts.js";
import type { VaultFold } from "./fold.js";
import { KEY_ANCHOR, didKeyName, mediationKeyName, type VaultEvent } from "./types.js";

/** A DID minted from a key: whatever the minter returns, as long as it names the DID. */
export interface MintedDid {
  did: string;
}

/**
 * How a derived key and a DIDComm service become a DID. Deterministic:
 * the same identity and service give the same DID, which is how recorded
 * DIDs are checked against the seed.
 */
export type MintDid<M extends MintedDid = MintedDid> = (identity: DerivedIdentity, serviceUri: string | null) => M;

export interface KeysOptions<M extends MintedDid = MintedDid> {
  mint: MintDid<M>;
  clock?: () => Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Keys<M extends MintedDid = MintedDid> {
  private constructor(
    private readonly events: EventStore,
    private readonly files: FileStore,
    public keystore: SeedKeystoreDocument,
    private readonly seedKey: SeedKey,
    private readonly options: KeysOptions<M>
  ) {}

  private now(): Date {
    return this.options.clock === undefined ? new Date() : this.options.clock();
  }

  /** Open over a vault that has a `keystore.json`. */
  static async open<M extends MintedDid = MintedDid>(vault: { events: EventStore; files: FileStore }, seedKey: SeedKey, options: KeysOptions<M>): Promise<Keys<M>> {
    const bytes = await vault.files.read(KEYSTORE_FILE);
    if (bytes === null) {
      throw new NotAVault(`no ${KEYSTORE_FILE}`);
    }
    return new Keys(vault.events, vault.files, parseSeedKeystore(decoder.decode(bytes)), seedKey, options);
  }

  /**
   * First open of a fresh vault: take a fresh keystore document (no keys),
   * cache the anchor in it, write `keystore.json`. The anchor `KeyRef`
   * for `config.json` is the caller's to have fixed first (`anchorOf`).
   */
  static async init<M extends MintedDid = MintedDid>(
    vault: { events: EventStore; files: FileStore },
    doc: SeedKeystoreDocument,
    seedKey: SeedKey,
    options: KeysOptions<M>
  ): Promise<Keys<M>> {
    if (doc.keys.length !== 0) {
      throw new Error("init wants a fresh keystore with no keys");
    }
    const keys = new Keys(vault.events, vault.files, doc, seedKey, options);
    await keys.remember(KEY_ANCHOR);
    return keys;
  }

  /** The identity's anchor: the did:key the key named `anchor` derives (§2). */
  static async anchorOf(seedKey: SeedKey): Promise<{ key: string; did: string }> {
    const identity = await deriveIdentity(seedKey, KEY_ANCHOR);
    return { key: KEY_ANCHOR, did: identity.did };
  }

  /**
   * The seed in hand must be the seed this vault was made from: the key
   * named `anchor` must derive the anchor DID `config.json` records —
   * checked before anything is derived or sent, because it is what "the
   * same identity" means.
   */
  async verifyAnchor(did: string): Promise<void> {
    const anchor = await Keys.anchorOf(this.seedKey);
    if (anchor.did !== did) {
      throw new Error(`the seed does not derive this vault's anchor DID (${did}): wrong seed for this vault`);
    }
  }

  /** The identity a name derives; the cache entry, when there is one, must agree. */
  async derive(name: string): Promise<DerivedIdentity> {
    const { identity } = await addDerivedKey(this.keystore, this.seedKey, name, { now: this.now() });
    return identity;
  }

  /** Re-mint the DID a key derives with `serviceUri`: what unlocks and signs as it. */
  async identity(name: string, serviceUri: string | null): Promise<M> {
    return this.options.mint(await this.derive(name), serviceUri);
  }

  /** Derive and list in the cache, then write `keystore.json`; idempotent. */
  private async remember(name: string): Promise<DerivedIdentity> {
    const { doc, identity } = await addDerivedKey(this.keystore, this.seedKey, name, { now: this.now() });
    if (doc !== this.keystore) {
      this.keystore = doc;
      await this.files.write(KEYSTORE_FILE, encoder.encode(serializeKeystore(doc)));
    }
    return identity;
  }

  /**
   * Mint a DID of ours to hand to people (§2, §5): the key `did/<id>`,
   * `did.minted` appended (the record), the cache written after.
   * `mediation` is the arrangement whose routing DID goes in its service,
   * or null for a DID only ever picked up from.
   */
  async mintDid(fold: VaultFold, mediation: { id: string; routingDid: string } | null): Promise<{ event: VaultEvent<"did.minted">; key: string; identity: M }> {
    const key = didKeyName(uuidv7({ msecs: this.now().getTime() }));
    const identity = this.options.mint(await this.derive(key), mediation?.routingDid ?? null);
    const event = (await this.events.append(
      drafts.didMinted({ key, did: identity.did, routingDid: mediation?.routingDid ?? null, mediation: mediation?.id ?? null })
    )) as VaultEvent<"did.minted">;
    fold.apply(event);
    await this.remember(key);
    return { event, key, identity };
  }

  /**
   * This device's arrangement with one mediator (§5): mint the mediation
   * id and the `me` key (no service — its mail is picked up, never
   * pushed), append `mediation.created`, cache after. `granted` and
   * `retired` are plain observations and decisions: `drafts` and the wire.
   */
  async createMediation(fold: VaultFold, mediatorDid: string): Promise<{ event: VaultEvent<"mediation.created">; id: string; key: string; identity: M }> {
    const id = uuidv7({ msecs: this.now().getTime() });
    const key = mediationKeyName(id);
    const identity = this.options.mint(await this.derive(key), null);
    const event = (await this.events.append(drafts.mediationCreated({ id, mediatorDid, me: { key, did: identity.did } }))) as VaultEvent<"mediation.created">;
    fold.apply(event);
    await this.remember(key);
    return { event, id, key, identity };
  }

  /**
   * Rebuild the key cache from the log (§2): every `did.minted` and
   * `mediation.created` name, and the anchor, derived and listed.
   * Returns the names that were missing.
   */
  async rebuildCache(fold: VaultFold): Promise<string[]> {
    const names = new Set<string>([KEY_ANCHOR]);
    for (const key of fold.myKeys()) {
      if (key.minted !== null) {
        names.add(key.key);
      }
    }
    for (const device of fold.devices()) {
      for (const mediation of device.mediations) {
        names.add(mediation.me.key);
      }
    }
    const added: string[] = [];
    for (const name of [...names].sort()) {
      if (!this.keystore.keys.some((entry) => entry.name === name)) {
        added.push(name);
      }
      await this.remember(name);
    }
    return added;
  }
}
