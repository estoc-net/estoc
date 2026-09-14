import { describe, expect, it } from "vitest";

import { longToShort } from "@estoc/did-peer";
import { scanVault, vaultDraft, type DidId, type RouteId } from "@estoc/vault/v3";

import { Keyring, configureRoute, createDid } from "../../src/v3/index.js";
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
});
