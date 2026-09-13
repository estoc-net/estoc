/**
 * The vault's own keys and communication DIDs. One seed derives every
 * key by name: the anchor that is the vault's identity, the two keys of
 * each communication-DID entity and the one key of each mediation
 * arrangement. Each name derives an Ed25519 key; a key-agreement use
 * takes that key's X25519 form, the did:key convention. Nothing derived
 * is stored: a DID entity's spelling is recomputed from the seed, the
 * entity ID and the route its document encodes, which is how a recorded
 * `did.created` is checked against the seed.
 */

import type { JsonObject, WrappedSeed } from "@estoc/event-store/v3";
import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { deriveIdentity, unlockSeedKeystore, type SeedKey } from "@estoc/keystore";
import { edwardsToMontgomeryPriv, edwardsToMontgomeryPub } from "@noble/curves/ed25519";
import { base64urlnopad } from "@scure/base";

import { IdentityMismatch, Locked } from "./errors.js";
import { ANCHOR_KEY_NAME, didKeyName, mediationKeyName } from "./ids.js";
import { canonicalPublicKey } from "./public-key.js";
import type { Did, DidId, KeyName, MediationId, PublicKey, VaultData } from "./types.js";

/** An OKP private key as RFC 8037 spells it. */
export type OkpPrivateJwk = { kty: "OKP"; crv: "Ed25519" | "X25519"; x: string; d: string };

/** One derived key in one of its two uses, with the private half closed over. */
export interface LocalKey {
  readonly name: KeyName;
  readonly type: "Ed25519" | "X25519";
  /** The canonical public-key value, as a document lists it and as evidence names it. */
  readonly publicKey: PublicKey;
  publicKeyBytes(): Uint8Array;
  /** A fresh copy each call, for a library that runs its own crypto. */
  privateJwk(): OkpPrivateJwk;
}

/** The two keys of a communication-DID entity, or the two uses of a mediation arrangement's one key. */
export type DidKeys = { authentication: LocalKey; keyAgreement: LocalKey };

function localKey(name: KeyName, type: "Ed25519" | "X25519", publicKey: Uint8Array, privateKey: Uint8Array): LocalKey {
  return {
    name,
    type,
    publicKey: canonicalPublicKey({ kty: "OKP", crv: type, x: base64urlnopad.encode(publicKey) }),
    publicKeyBytes: () => publicKey.slice(),
    privateJwk: () => ({ kty: "OKP", crv: type, x: base64urlnopad.encode(publicKey), d: base64urlnopad.encode(privateKey) }),
  };
}

export class Keys {
  private seedKey: SeedKey | null;

  private constructor(seedKey: SeedKey) {
    this.seedKey = seedKey;
  }

  /** The anchor DID a seed derives: the vault identity that seed belongs to. */
  static async anchorOf(seedKey: SeedKey): Promise<Did> {
    return (await deriveIdentity(seedKey, ANCHOR_KEY_NAME)).did as Did;
  }

  /** Keys over a seed, once it has derived the anchor the vault records. */
  static async open(seedKey: SeedKey, anchor: string): Promise<Keys> {
    const derived = await Keys.anchorOf(seedKey);
    if (derived !== anchor) throw new IdentityMismatch(`the seed derives the anchor ${derived}, not this vault's ${anchor}`);
    return new Keys(seedKey);
  }

  /** Unseal the vault's wrapped seed with the passphrase and open over it. */
  static async unlock(wrapped: WrappedSeed, passphrase: string, anchor: string): Promise<Keys> {
    return Keys.open(await unlockSeedKeystore({ version: 3, seedJwe: wrapped.seedJwe, keys: [] }, passphrase), anchor);
  }

  get locked(): boolean {
    return this.seedKey === null;
  }

  /** Drop the seed; every later derivation throws. Keys already handed out keep their material. */
  lock(): void {
    this.seedKey = null;
  }

  private async derive(name: KeyName): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
    if (this.seedKey === null) throw new Locked();
    const identity = await deriveIdentity(this.seedKey, name);
    return { publicKey: identity.signer.publicKey(), privateKey: base64urlnopad.decode(identity.privateJwks().ed25519.d as string) };
  }

  /** The Ed25519 key a name derives. */
  async signing(name: KeyName): Promise<LocalKey> {
    const { publicKey, privateKey } = await this.derive(name);
    return localKey(name, "Ed25519", publicKey, privateKey);
  }

  /** The X25519 form of the Ed25519 key a name derives. */
  async agreement(name: KeyName): Promise<LocalKey> {
    const { publicKey, privateKey } = await this.derive(name);
    return localKey(name, "X25519", edwardsToMontgomeryPub(publicKey), edwardsToMontgomeryPriv(privateKey));
  }

  /** The fixed keys of a communication-DID entity: one name for authentication, another for key agreement. */
  async didKeys(didId: DidId): Promise<DidKeys> {
    return { authentication: await this.signing(didKeyName(didId, "authentication")), keyAgreement: await this.agreement(didKeyName(didId, "key-agreement")) };
  }

  /** The DIDComm identity of a mediation arrangement: one name in both uses. */
  async mediationKeys(mediationId: MediationId): Promise<DidKeys> {
    const name = mediationKeyName(mediationId);
    return { authentication: await this.signing(name), keyAgreement: await this.agreement(name) };
  }
}

/** Where a communication DID's document sends its traffic: a mediator's routing DID, or a direct HTTPS or WSS endpoint. */
export type RouteTarget = { kind: "mediated"; routingDid: Did } | { kind: "direct"; endpoint: string };

/** A did:peer:4 the vault controls: both spellings and the input document the long form encodes. */
export type LocalDid = { did: Did; longFormDid: Did; inputDocument: JsonObject };

/** A communication DID with the entity ID it belongs to: what `did.created` records, short of the route ID. */
export type MintedDid = LocalDid & { didId: DidId };

export const AUTHENTICATION_METHOD = "#key-1";
export const KEY_AGREEMENT_METHOD = "#key-2";
export const DIDCOMM_SERVICE = "#service";

/**
 * The numalgo-4 input document of a local DID: one Multikey per use
 * and, when the DID is written to, one DIDComm v2 service at the
 * route's target. Member order is fixed because the long form hashes
 * the document's own serialization.
 */
export function inputDocumentOf(keys: DidKeys, service: string | null): JsonObject {
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    verificationMethod: [
      { id: AUTHENTICATION_METHOD, type: "Multikey", publicKeyMultibase: keys.authentication.publicKey },
      { id: KEY_AGREEMENT_METHOD, type: "Multikey", publicKeyMultibase: keys.keyAgreement.publicKey },
    ],
    authentication: [AUTHENTICATION_METHOD],
    keyAgreement: [KEY_AGREEMENT_METHOD],
    ...(service === null ? {} : { service: [{ id: DIDCOMM_SERVICE, type: "DIDCommMessaging", serviceEndpoint: { uri: service, accept: ["didcomm/v2"] } }] }),
  };
}

function localDidOf(inputDocument: JsonObject): LocalDid {
  const longFormDid = encodeLongForm(inputDocument) as Did;
  return { did: longToShort(longFormDid) as Did, longFormDid, inputDocument };
}

/** The communication DID an entity ID and a route give: the same DID every time, from the seed alone. */
export async function mintDid(keys: Keys, didId: DidId, route: RouteTarget): Promise<MintedDid> {
  return { didId, ...localDidOf(inputDocumentOf(await keys.didKeys(didId), route.kind === "mediated" ? route.routingDid : route.endpoint)) };
}

/** The DID a mediation arrangement is known to its mediator by: no service, its mail is picked up. */
export async function mintMediationDid(keys: Keys, mediationId: MediationId): Promise<LocalDid> {
  return localDidOf(inputDocumentOf(await keys.mediationKeys(mediationId), null));
}

/** A recorded DID entity against the seed: its spellings must be the ones its ID and route derive. */
export async function checkDidCreated(keys: Keys, created: Pick<VaultData["did.created"], "didId" | "did" | "longFormDid">, route: RouteTarget): Promise<void> {
  const minted = await mintDid(keys, created.didId, route);
  if (minted.longFormDid !== created.longFormDid || minted.did !== created.did) {
    throw new IdentityMismatch(`DID entity ${created.didId} does not derive from the seed and its route`);
  }
}

/** A recorded mediation arrangement against the seed: `me.did` must be the DID its ID derives. */
export async function checkMediationCreated(keys: Keys, created: Pick<VaultData["mediation.created"], "mediationId" | "me">): Promise<void> {
  const minted = await mintMediationDid(keys, created.mediationId);
  if (minted.longFormDid !== created.me.did) throw new IdentityMismatch(`mediation ${created.mediationId} does not derive its DID from the seed`);
}
