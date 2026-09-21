import { describe, expect, it } from "vitest";

import { longToShort } from "@estoc/did-peer";
import { mintDid, scanVault, vaultDraft, type DidId, type RouteId } from "@estoc/vault";

import { Keyring, configureRoute, createDid, retireDid } from "../src/index.js";
import { freshVault, newMediator, party, reloaded } from "./helpers.js";

const ENDPOINT = "https://ingress.example/didcomm";

describe("the keyring", () => {
  it("holds the mediation's identity under both spellings, and each communication DID once the fold has it", async () => {
    const p = await party(await newMediator());
    const me = p.created.data.me.did;
    expect(p.ring.mediationKeys(p.mediationId)?.authentication.name).toBe(p.created.data.me.keyName);
    expect(p.ring.secrets().map((secret) => secret.id).sort()).toEqual([`${me}#key-1`, `${me}#key-2`, `${longToShort(me)}#key-1`, `${longToShort(me)}#key-2`].sort());

    const route = await configureRoute(p.runtime, p.keys, { kind: "direct", endpoint: ENDPOINT });
    const { minted } = await createDid(p.runtime, p.keys, route.data.routeId);
    expect(p.ring.didKeys(minted.didId)).toBeNull();
    await reloaded(p);
    const keys = p.ring.didKeys(minted.didId);
    expect(keys?.keyAgreement.type).toBe("X25519");
    const ids = p.ring.secrets().map((secret) => secret.id);
    for (const spelling of [minted.did, minted.longFormDid]) {
      expect(ids).toContain(`${spelling}#key-1`);
      expect(ids).toContain(`${spelling}#key-2`);
    }
    expect(ids).toHaveLength(8);
    await p.runtime.close();
  });

  it("leaves out an entity whose keys the seed does not derive", async () => {
    const alice = await freshVault(1);
    const bob = await freshVault(2);
    const route = await configureRoute(alice.runtime, alice.keys, { kind: "direct", endpoint: ENDPOINT });
    const bobsRoute = await configureRoute(bob.runtime, bob.keys, { kind: "direct", endpoint: ENDPOINT });
    const { minted } = await createDid(bob.runtime, bob.keys, bobsRoute.data.routeId);
    // Bob's record under Alice's route: a document the seed of this vault does not derive
    await alice.runtime.vault.commit([], [vaultDraft("did.created", { didId: minted.didId as DidId, did: minted.did, longFormDid: minted.longFormDid, boundRouteId: route.data.routeId as RouteId })]);
    const fold = await scanVault(alice.runtime.vault, alice.keys);
    expect(fold.routes.dids.get(minted.didId)?.identity).toBe("mismatch");
    const ring = await Keyring.load(alice.keys, fold);
    expect(ring.didKeys(minted.didId)).toBeNull();
    expect(ring.secrets()).toEqual([]);
    await alice.runtime.close();
    await bob.runtime.close();
  });

  it("keeps a retired entity's keys, and drops an entity that fell into conflict, fresh or reloaded alike", async () => {
    const p = await freshVault();
    const route = await configureRoute(p.runtime, p.keys, { kind: "direct", endpoint: ENDPOINT });
    const retiring = await createDid(p.runtime, p.keys, route.data.routeId);
    const claimed = await createDid(p.runtime, p.keys, route.data.routeId);
    const rewritten = await createDid(p.runtime, p.keys, route.data.routeId);
    const ring = await Keyring.load(p.keys, await scanVault(p.runtime.vault, p.keys));
    expect(ring.secrets()).toHaveLength(12);

    await retireDid(p.runtime, p.keys, retiring.minted.didId, "user");
    // another entity claiming the same spelling, and the same entity created again with another document
    await p.runtime.vault.commit([], [vaultDraft("did.created", { ...claimed.created.data, didId: "019b0000-0000-7000-8000-000000000bad" as DidId })]);
    const elsewhere = await mintDid(p.keys, rewritten.minted.didId, { kind: "direct", endpoint: "https://elsewhere.example/" });
    await p.runtime.vault.commit([], [vaultDraft("did.created", { ...rewritten.created.data, did: elsewhere.did, longFormDid: elsewhere.longFormDid })]);
    const fold = await scanVault(p.runtime.vault, p.keys);
    expect(fold.routes.dids.get(retiring.minted.didId)).toMatchObject({ live: false, conflict: false });
    expect(fold.routes.dids.get(claimed.minted.didId)).toMatchObject({ identity: "verified", conflict: true });
    expect(fold.routes.dids.get(rewritten.minted.didId)?.conflict).toBe(true);

    await ring.reload(fold);
    const fresh = await Keyring.load(p.keys, fold);
    for (const each of [ring, fresh]) {
      expect(each.didKeys(retiring.minted.didId)).not.toBeNull();
      expect(each.didKeys(claimed.minted.didId)).toBeNull();
      expect(each.didKeys(rewritten.minted.didId)).toBeNull();
      expect(each.secrets().map((secret) => secret.id).sort()).toEqual(fresh.secrets().map((secret) => secret.id).sort());
    }
    expect(ring.secrets()).toHaveLength(4);
    await p.runtime.close();
  });

  it("drops a mediation identity whose arrangement fell into conflict", async () => {
    const p = await party(await newMediator());
    expect(p.ring.mediationKeys(p.mediationId)).not.toBeNull();
    await p.runtime.vault.commit([], [vaultDraft("mediation.created", { ...p.created.data, mediatorDid: "did:web:elsewhere.example" as typeof p.created.data.mediatorDid })]);
    const fold = await scanVault(p.runtime.vault, p.keys);
    expect(fold.mediations.mediations.get(p.mediationId)?.status).toBe("conflict");
    await p.ring.reload(fold);
    expect(p.ring.mediationKeys(p.mediationId)).toBeNull();
    expect(p.ring.secrets()).toEqual([]);
    expect((await Keyring.load(p.keys, fold)).secrets()).toEqual([]);
    await p.runtime.close();
  });
});
