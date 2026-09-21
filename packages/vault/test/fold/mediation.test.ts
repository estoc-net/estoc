import { beforeAll, describe, expect, it } from "vitest";

import { Keys, foldMediations, mintMediationDid, verifyMediationKeys, type Did, type KeyName, type MediationId, type VaultEventSet } from "../../src/index.js";
import { MEDIATION, MEDIATION2, OTHER_SEED, ROUTING_DID, ROUTING_DID2, Scene, expectOrderFree, openKeys } from "./helpers.js";

const MEDIATOR = "did:web:mediator.example" as Did;
let keys: Keys;
let me: Did;
let me2: Did;

beforeAll(async () => {
  keys = await openKeys();
  me = (await mintMediationDid(keys, MEDIATION)).longFormDid;
  me2 = (await mintMediationDid(keys, MEDIATION2)).longFormDid;
});

const created = (scene: Scene, mediationId: MediationId, did: Did, mediatorDid = MEDIATOR) =>
  scene.add("mediation.created", { mediationId, mediatorDid, me: { keyName: `mediation/${mediationId}/me` as KeyName, did } });

/** The fold with the seed's verdicts folded in. */
async function checked(scene: Scene): Promise<(set: VaultEventSet) => ReturnType<typeof foldMediations>> {
  const keyChecks = await verifyMediationKeys(keys, foldMediations(scene.set()));
  return (set) => foldMediations(set, { keyChecks });
}

describe("the mediation fold", () => {
  it("makes an arrangement usable with one consistent creation, one grant and the seed's verdict, pending before any of them", async () => {
    const scene = new Scene();
    created(scene, MEDIATION, me);
    expect((await checked(scene))(scene.set()).mediations.get(MEDIATION)).toMatchObject({ status: "pending", routingDid: null, mediatorDid: MEDIATOR, identity: "verified" });
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    created(scene, MEDIATION, me);
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    scene.add("mediation.selected", { mediationId: MEDIATION });
    const unchecked = foldMediations(scene.set());
    expect(unchecked.mediations.get(MEDIATION)).toMatchObject({ status: "pending", routingDid: ROUTING_DID, identity: "unchecked", faults: [] });
    expect(unchecked.usable(MEDIATION)).toBe(false);
    expect(unchecked.preferred).toBeNull();
    expect(foldMediations(scene.set(), { keyChecks: new Map() }).usable(MEDIATION)).toBe(false);
    const fold = (await checked(scene))(scene.set());
    expect(fold.mediations.get(MEDIATION)).toMatchObject({ status: "usable", routingDid: ROUTING_DID, me: { did: me }, retired: null, faults: [], identity: "verified" });
    expect(fold.usable(MEDIATION)).toBe(true);
    expect(fold.preferred).toBe(MEDIATION);
    expect(fold.usable(MEDIATION2)).toBe(false);
    expectOrderFree(scene.events, await checked(scene));
  });

  it("holds a grant, a selection or a retirement whose creation is not here as pending, not usable", () => {
    const scene = new Scene();
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    scene.add("mediation.selected", { mediationId: MEDIATION2 });
    const fold = foldMediations(scene.set());
    expect(fold.mediations.get(MEDIATION)).toMatchObject({ status: "pending", mediatorDid: null, me: null, routingDid: ROUTING_DID });
    expect(fold.mediations.get(MEDIATION2)).toMatchObject({ status: "pending" });
    expect(fold.selected).toBe(MEDIATION2);
    expect(fold.preferred).toBeNull();
  });

  it("makes disagreeing creations or grants a conflict that nothing later resolves", async () => {
    const scene = new Scene();
    created(scene, MEDIATION, me);
    created(scene, MEDIATION, me, "did:web:other.example" as Did);
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    created(scene, MEDIATION2, me2);
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID });
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID2 });
    scene.add("mediation.retired", { mediationId: MEDIATION2, because: "replaced" });
    const fold = (await checked(scene))(scene.set());
    expect(fold.mediations.get(MEDIATION)).toMatchObject({ status: "conflict", faults: ["creations disagree"], mediatorDid: null, me: null, routingDid: null });
    expect(fold.mediations.get(MEDIATION2)).toMatchObject({ status: "conflict", faults: [`grants disagree: ${[ROUTING_DID, ROUTING_DID2].sort().join(", ")}`], routingDid: null, retired: "replaced" });
    expectOrderFree(scene.events, await checked(scene));
  });

  it("retires terminally and prefers the latest selection only while it is usable", async () => {
    const scene = new Scene();
    created(scene, MEDIATION, me);
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    created(scene, MEDIATION2, me2);
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID2 });
    scene.add("mediation.selected", { mediationId: MEDIATION2 });
    scene.add("mediation.selected", { mediationId: MEDIATION });
    expect((await checked(scene))(scene.set()).preferred).toBe(MEDIATION);
    scene.add("mediation.retired", { mediationId: MEDIATION, because: "gone" });
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    const fold = (await checked(scene))(scene.set());
    expect(fold.mediations.get(MEDIATION)).toMatchObject({ status: "retired", retired: "gone", routingDid: ROUTING_DID });
    expect(fold.selected).toBe(MEDIATION);
    expect(fold.preferred).toBeNull();
    expect(fold.usable(MEDIATION2)).toBe(true);
    expectOrderFree(scene.events, await checked(scene));
  });

  it("checks each arrangement's own DID against the seed: a verdict missing leaves it pending, a mismatch makes it a conflict", async () => {
    const scene = new Scene();
    created(scene, MEDIATION, me);
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    created(scene, MEDIATION2, (await mintMediationDid(await openKeys(OTHER_SEED), MEDIATION2)).longFormDid);
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID2 });
    scene.add("mediation.selected", { mediationId: MEDIATION2 });
    const unchecked = foldMediations(scene.set());
    expect(unchecked.mediations.get(MEDIATION2)).toMatchObject({ status: "pending", identity: "unchecked" });
    expect(unchecked.preferred).toBeNull();
    const keyChecks = await verifyMediationKeys(keys, unchecked);
    expect(keyChecks).toEqual(new Map([[MEDIATION, "verified"], [MEDIATION2, "mismatch"]]));
    const partial = foldMediations(scene.set(), { keyChecks: new Map([[MEDIATION, "verified"]]) });
    expect(partial.mediations.get(MEDIATION)?.status).toBe("usable");
    expect(partial.mediations.get(MEDIATION2)?.status).toBe("pending");
    const checked = foldMediations(scene.set(), { keyChecks });
    expect(checked.mediations.get(MEDIATION)).toMatchObject({ status: "usable", identity: "verified" });
    expect(checked.mediations.get(MEDIATION2)).toMatchObject({ status: "conflict", identity: "mismatch", faults: ["the seed does not derive the arrangement's keys"] });
    expect(checked.preferred).toBeNull();
  });

  it("treats an own DID that does not resolve as a mismatch, and skips an arrangement without a consistent creation", async () => {
    const scene = new Scene();
    created(scene, MEDIATION, "did:peer:4zQmNotALongForm:z2Broken" as Did);
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID2 });
    expect(await verifyMediationKeys(keys, foldMediations(scene.set()))).toEqual(new Map([[MEDIATION, "mismatch"]]));
  });
});
