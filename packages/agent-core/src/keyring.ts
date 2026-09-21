/**
 * The keys this runtime holds in hand: the two of every consistent
 * communication-DID entity the fold has, retired or not — a retired
 * address still receives what its route retains — and the two of every
 * consistent mediation arrangement's own identity. Each is derived
 * from its name and held only while the fold has the entity
 * consistent and the seed found to derive what the record carries; an
 * entity in conflict — disagreeing creations, a spelling two entities
 * claim, keys the seed does not derive — is not held, whether it came
 * that way or fell into conflict since the ring was last loaded. The
 * ring answers didcomm's secrets resolver under both spellings of each
 * entity, since a peer seals to whichever it resolved.
 */

import type { Secret } from "@estoc/did-peer";
import { longToShort } from "@estoc/did-peer";
import { authorizedMethodIds, peerResolution, splitDidUrl, type DidId, type DidKeys, type Keys, type LocalKey, type MediationId, type VaultFold } from "@estoc/vault";

/** A held identity: its keys, and the DID URLs of each method under every spelling the entity has. */
interface Held {
  keys: DidKeys;
  secrets: Secret[];
}

/** The secrets didcomm asks for by key ID: each of the two keys under every method that carries it, under every spelling given. */
export function secretsOf(keys: DidKeys, spellings: readonly string[], methods: { authentication: readonly string[]; keyAgreement: readonly string[] }): Secret[] {
  const secrets: Secret[] = [];
  const add = (ids: readonly string[], key: LocalKey): void => {
    for (const id of ids) {
      const fragment = splitDidUrl(id)[1];
      for (const spelling of spellings) secrets.push({ id: spelling + fragment, type: "JsonWebKey2020", privateKeyJwk: key.privateJwk() });
    }
  };
  add(methods.authentication, keys.authentication);
  add(methods.keyAgreement, keys.keyAgreement);
  return secrets;
}

export class Keyring {
  private dids = new Map<DidId, Held>();
  private mediations = new Map<MediationId, Held>();

  private constructor(private readonly keys: Keys) {}

  /** Derive what the fold says is ours and the seed confirms: every consistent, verified DID entity and mediation identity. */
  static async load(keys: Keys, fold: VaultFold): Promise<Keyring> {
    const ring = new Keyring(keys);
    await ring.reload(fold);
    return ring;
  }

  /**
   * Bring the ring to the fold: what the fold has consistent and
   * verified is held, whatever was held before is not. Loading a fresh
   * ring over a fold and reloading an older one to it land the same
   * ring; deriving is by name and lands the same material every time.
   */
  async reload(fold: VaultFold): Promise<void> {
    const dids = new Map<DidId, Held>();
    for (const entity of fold.routes.dids.values()) {
      if (entity.created === null || entity.resolution === null || entity.conflict || entity.identity !== "verified") continue;
      const keys = this.dids.get(entity.didId)?.keys ?? (await this.keys.didKeys(entity.didId));
      dids.set(entity.didId, { keys, secrets: secretsOf(keys, [entity.created.longFormDid, entity.created.did], entity.methodIds) });
    }
    const mediations = new Map<MediationId, Held>();
    for (const mediation of fold.mediations.mediations.values()) {
      if (mediation.me === null || mediation.status === "conflict" || mediation.identity !== "verified") continue;
      const keys = this.mediations.get(mediation.mediationId)?.keys ?? (await this.keys.mediationKeys(mediation.mediationId));
      const { document } = peerResolution(mediation.me.did);
      const methods = { authentication: authorizedMethodIds(document, "authentication"), keyAgreement: authorizedMethodIds(document, "keyAgreement") };
      mediations.set(mediation.mediationId, { keys, secrets: secretsOf(keys, [mediation.me.did, longToShort(mediation.me.did)], methods) });
    }
    this.dids = dids;
    this.mediations = mediations;
  }

  didKeys(didId: DidId): DidKeys | null {
    return this.dids.get(didId)?.keys ?? null;
  }

  mediationKeys(mediationId: MediationId): DidKeys | null {
    return this.mediations.get(mediationId)?.keys ?? null;
  }

  /** Every held key's secrets under every spelling: what didcomm's secrets resolver hands out. */
  secrets(): Secret[] {
    const all: Secret[] = [];
    for (const held of this.dids.values()) all.push(...held.secrets);
    for (const held of this.mediations.values()) all.push(...held.secrets);
    return all;
  }
}
