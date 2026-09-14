/**
 * The keys this runtime holds in hand: the two of every consistent
 * communication-DID entity the fold has, retired or not — a retired
 * address still receives what its route retains — and the two of every
 * mediation arrangement's own identity. Each is derived from its name
 * and held only once the seed has been found to derive what the record
 * carries; an entity whose keys the seed does not derive is left out,
 * as the fold marks it. The ring answers didcomm's secrets resolver
 * under both spellings of each entity, since a peer seals to whichever
 * it resolved.
 */

import type { Secret } from "@estoc/did-peer";
import { longToShort } from "@estoc/did-peer";
import { authorizedMethodIds, peerResolution, splitDidUrl, type DidId, type DidKeys, type Keys, type LocalKey, type MediationId, type VaultFold } from "@estoc/vault/v3";

/** A held identity: its keys, and the DID URLs of each method under every spelling the entity has. */
interface Held {
  keys: DidKeys;
  secrets: Secret[];
}

function secretsOf(keys: DidKeys, spellings: readonly string[], methods: { authentication: readonly string[]; keyAgreement: readonly string[] }): Secret[] {
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
  private readonly dids = new Map<DidId, Held>();
  private readonly mediations = new Map<MediationId, Held>();

  private constructor(private readonly keys: Keys) {}

  /** Derive what the fold says is ours and the seed confirms: every verified DID entity, every verified mediation identity. */
  static async load(keys: Keys, fold: VaultFold): Promise<Keyring> {
    const ring = new Keyring(keys);
    await ring.reload(fold);
    return ring;
  }

  /** Bring the ring up to the fold: derive whatever it does not hold yet. Deriving is by name and lands the same material every time. */
  async reload(fold: VaultFold): Promise<void> {
    for (const entity of fold.routes.dids.values()) {
      if (this.dids.has(entity.didId) || entity.created === null || entity.resolution === null || entity.identity !== "verified") continue;
      const keys = await this.keys.didKeys(entity.didId);
      this.dids.set(entity.didId, { keys, secrets: secretsOf(keys, [entity.created.longFormDid, entity.created.did], entity.methodIds) });
    }
    for (const mediation of fold.mediations.mediations.values()) {
      if (this.mediations.has(mediation.mediationId) || mediation.me === null || mediation.identity !== "verified") continue;
      const keys = await this.keys.mediationKeys(mediation.mediationId);
      const { document } = peerResolution(mediation.me.did);
      const methods = { authentication: authorizedMethodIds(document, "authentication"), keyAgreement: authorizedMethodIds(document, "keyAgreement") };
      this.mediations.set(mediation.mediationId, { keys, secrets: secretsOf(keys, [mediation.me.did, longToShort(mediation.me.did)], methods) });
    }
  }

  /** The two keys of a held DID entity; null for one not held. */
  didKeys(didId: DidId): DidKeys | null {
    return this.dids.get(didId)?.keys ?? null;
  }

  /** The two keys of a held mediation identity; null for one not held. */
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
