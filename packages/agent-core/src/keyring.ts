/**
 * The keys of ours this device holds (vault-events.md §2, §5): every
 * `did/<id>` the fold says was minted and the `me` of every mediation
 * this device made, retired or not — inbound still opens — each derived
 * from its name and checked against the DID the log recorded. What a
 * DID of ours is named, what a name derives, the secrets didcomm opens
 * with. Minting goes through `Keys` (the event first, the cache after)
 * and lands here at once. The ring holds derived identities and nothing
 * else: which key is `me`, which is `pub`, is the fold's answer, read
 * fresh each time — so what a running ring holds is what a reopened
 * one derives, whatever was retired in between.
 */

import type { Secret } from "@estoc/did-peer";
import { drafts, record, type Mediation, type MyKey } from "@estoc/vault";

import type { PeerIdentity } from "./identity/peer.js";
import type { KeyOfDid } from "./channel.js";
import type { PeerVault } from "./identity.js";

/** A key of ours in hand: its name (§2) and what the name derives. */
export interface MyIdentity {
  /** `did/<id>` or `mediation/<id>/me` */
  key: string;
  identity: PeerIdentity;
}

/** A recorded key this seed does not derive as recorded (a log this device did not write, minted another way): left out of the ring. */
export interface Skipped {
  key: string;
  /** the DID the log records */
  did: string;
  /** the DID the name derives here */
  derived: string;
}

/** The mediation a mint takes its service from: granted, so it has a routing DID. */
export interface Routed {
  id: string;
  routingDid: string;
}

export class Keyring {
  private readonly byName = new Map<string, PeerIdentity>();
  private readonly byDid = new Map<string, string>();
  private readonly left: Skipped[] = [];

  private constructor(private readonly opened: PeerVault) {}

  /**
   * Derive what the fold says is ours: every minted `did/<id>` (§7.3)
   * and the `me` of every mediation this device made (§5), retired ones
   * included, each checked against the DID the log recorded — a name
   * that derives another DID is skipped, and said so in `skipped`.
   */
  static async load(opened: PeerVault): Promise<Keyring> {
    const ring = new Keyring(opened);
    await ring.reload();
    return ring;
  }

  /**
   * Bring the ring back up to the fold: derive whatever it does not
   * hold yet, and take the skip list fresh. A restart reloads the one
   * ring rather than building another — a mint lands in the ring its
   * composer holds, so the current ring and every composer's must be
   * the same object for inbound to open mail to a key minted while the
   * reload ran. Deriving is by name and lands the same material every
   * time: rerunning over a concurrent mint is harmless.
   */
  async reload(): Promise<void> {
    this.left.length = 0;
    for (const key of this.opened.fold.myKeys()) {
      if (key.minted !== null && this.byName.get(key.key)?.did !== key.minted.did) {
        await this.derive(key.key, key.minted.routingDid, key.minted.did);
      }
    }
    for (const mediation of this.opened.fold.device(this.opened.vault.self)?.mediations ?? []) {
      if (this.byName.get(mediation.me.key)?.did !== mediation.me.did) {
        await this.derive(mediation.me.key, null, mediation.me.did);
      }
    }
  }

  /** The recorded keys this seed does not derive as recorded. */
  get skipped(): readonly Skipped[] {
    return this.left;
  }

  // ---- what is ours ---------------------------------------------------------

  /** The name of a DID of ours; null for a DID that is no one of ours — `inboundPair`'s `keyOfDid`. */
  readonly keyOfDid: KeyOfDid = (did) => this.byDid.get(did) ?? null;

  /** What a name derives; null for a name not held (never minted, or skipped). */
  identityOf(name: string): PeerIdentity | null {
    return this.byName.get(name) ?? null;
  }

  /**
   * Hold a key the fold shows minted that this ring has not derived —
   * a mint that reached the fold without passing through this ring: an
   * import, an earlier process's record. Derives by name and checks the
   * recorded DID, exactly as
   * `load` does; null when the fold has no mint for the name, or the
   * seed derives another DID (skipped then, as at load).
   */
  async holdMinted(name: string): Promise<MyIdentity | null> {
    const have = this.held(name);
    if (have !== null) {
      return have;
    }
    const minted = this.opened.fold.myKey(name)?.minted ?? null;
    if (minted === null) {
      return null;
    }
    await this.derive(name, minted.routingDid, minted.did);
    return this.held(name);
  }

  /** Every held key's secrets: what didcomm's `SecretsResolver` hands out. */
  secrets(): Secret[] {
    return [...this.byName.values()].flatMap((identity) => identity.secrets);
  }

  /** This device's current mediation (§5): the fold's, read fresh. */
  current(): Mediation | null {
    return this.opened.fold.device(this.opened.vault.self)?.mediation ?? null;
  }

  /** The `me` of the current mediation: how the mediator knows us. Null without a mediation, or with one whose key was skipped. */
  get me(): MyIdentity | null {
    const mediation = this.current();
    return mediation === null ? null : this.held(mediation.me.key);
  }

  /**
   * The DID of ours the current mediation publishes as a profile
   * (`did.published { as: "profile" }`, §5): minted under it and its
   * current routing DID — a later `mediation.granted` moves the route,
   * and a DID whose service names the old one is no address — not
   * retired, held here; the latest minted when there are several. Null
   * when there is none, or the mediation is not granted: `mintPublic` is
   * the next step, once it is.
   */
  pub(): MyIdentity | null {
    const mediation = this.current();
    if (mediation === null || mediation.routingDid === null) {
      return null;
    }
    const profiles = this.opened.fold
      .myKeys()
      .filter((key) => under(key, mediation) && key.retired === null && key.published.some((entry) => entry.as === "profile"));
    for (const profile of profiles.reverse()) {
      const held = this.held(profile.key);
      if (held !== null) {
        return held;
      }
    }
    return null;
  }

  // ---- minting (§5, §6): the event first, the cache after, the ring at once --

  /** This device's arrangement with a mediator: `mediation.created` and its `me` key (`Keys.createMediation`); `me` is it from here on. */
  async createMediation(mediatorDid: string): Promise<{ id: string; me: MyIdentity }> {
    const { id, key, identity } = await this.opened.keys.createMediation(this.opened.fold, mediatorDid);
    this.hold(key, identity);
    return { id, me: { key, identity } };
  }

  /** A DID for one contact: minted, then `contact.useKey { because: "minted" }` (§6). */
  async mintToward(cid: string, mediation: Routed): Promise<MyIdentity> {
    const minted = await this.mint(mediation);
    await record(this.opened.vault.events, this.opened.fold, drafts.contactUseKey({ cid, key: minted.key, because: "minted" }));
    return minted;
  }

  /** A DID for one taker: minted, then `did.published { as: "oob", uses: "one" }` — an open invitation (§7.4). */
  async mintInvitation(mediation: Routed, oobId: string, goal: string | null): Promise<MyIdentity> {
    const minted = await this.mint(mediation);
    await record(this.opened.vault.events, this.opened.fold, drafts.didPublished({ key: minted.key, as: "oob", uses: "one", oobId, ...(goal === null ? {} : { goal }) }));
    return minted;
  }

  /**
   * A DID for anyone: `did.published { as: "profile", uses: "many" }` on
   * a key minted under `mediation` and its routing DID — a fresh one, or
   * an orphan (minted under both, never published, retired or given to a
   * contact: a mint that stopped before its publish), so the interrupted
   * mint heals rather than piling up. Whether one is wanted is `pub()`,
   * asked first.
   */
  async mintPublic(mediation: Routed): Promise<MyIdentity> {
    const minted = this.orphan(mediation) ?? (await this.mint(mediation));
    await record(this.opened.vault.events, this.opened.fold, drafts.didPublished({ key: minted.key, as: "profile", uses: "many" }));
    return minted;
  }

  // ---- inside ---------------------------------------------------------------

  /** A held key minted under `mediation` and its routing DID that nothing has happened to since: the first, or null. */
  private orphan(mediation: Routed): MyIdentity | null {
    const idle = (key: MyKey): boolean => under(key, mediation) && key.published.length === 0 && key.retired === null && key.usedBy.length === 0 && key.takenBy.length === 0;
    for (const key of this.opened.fold.myKeys()) {
      const held = idle(key) ? this.held(key.key) : null;
      if (held !== null) {
        return held;
      }
    }
    return null;
  }

  private held(name: string): MyIdentity | null {
    const identity = this.byName.get(name);
    return identity === undefined ? null : { key: name, identity };
  }

  private async mint(mediation: Routed): Promise<MyIdentity> {
    const { key, identity } = await this.opened.keys.mintDid(this.opened.fold, mediation);
    this.hold(key, identity);
    return { key, identity };
  }

  /** Derive `name` with `serviceUri` and hold it when it derives `did`; else note the skip. */
  private async derive(name: string, serviceUri: string | null, did: string): Promise<void> {
    const identity = await this.opened.keys.identity(name, serviceUri);
    if (identity.did === did) {
      this.hold(name, identity);
    } else {
      this.left.push({ key: name, did, derived: identity.did });
    }
  }

  private hold(name: string, identity: PeerIdentity): void {
    this.byName.set(name, identity);
    this.byDid.set(identity.did, name);
  }
}

/** Minted under this mediation *and* its routing DID: the service the DID carries is the route the mediation has now. */
function under(key: MyKey, mediation: { id: string; routingDid: string | null }): boolean {
  return key.minted !== null && key.minted.mediation === mediation.id && key.minted.routingDid === mediation.routingDid;
}
