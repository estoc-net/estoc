import { beforeAll, describe, expect, it } from "vitest";

import {
  Keys,
  VaultEventSet,
  foldMediations,
  foldRoutes,
  mintDid,
  mintMediationDid,
  requiredReceivingSet,
  verifyDidKeys,
  type Did,
  type DidId,
  type KeyName,
  type RouteFold,
  type VaultData,
} from "../../../src/v3/index.js";
import {
  DIRECT,
  DID_ID,
  DID_ID2,
  DID_ID3,
  ENDPOINT,
  MEDIATED,
  MEDIATION,
  MEDIATION2,
  OTHER_SEED,
  ROUTE,
  ROUTE2,
  ROUTING_DID,
  ROUTING_DID2,
  Scene,
  createdDid,
  expectOrderFree,
  mediatedRoute,
  openKeys,
} from "./helpers.js";

let keys: Keys;
let me: Did;
let me2: Did;

beforeAll(async () => {
  keys = await openKeys();
  me = (await mintMediationDid(keys, MEDIATION)).longFormDid;
  me2 = (await mintMediationDid(keys, MEDIATION2)).longFormDid;
});

const fold = (set: VaultEventSet, options?: Parameters<typeof foldRoutes>[2]): RouteFold => foldRoutes(set, foldMediations(set), options);
const both = (set: VaultEventSet) => {
  const mediations = foldMediations(set);
  const routes = foldRoutes(set, mediations);
  return { mediations, routes };
};

describe("the route fold", () => {
  it("makes a route usable with one consistent configuration, a conflict with two, terminal when retired", () => {
    const scene = new Scene();
    scene.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    scene.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    scene.add("route.configured", { routeId: ROUTE2, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    scene.add("route.configured", { routeId: ROUTE2, kind: "direct", mediationId: null, endpoint: "https://elsewhere.example/" });
    const routes = fold(scene.set()).routes;
    expect(routes.get(ROUTE)).toMatchObject({ configured: { kind: "direct", endpoint: ENDPOINT }, retired: null, conflict: false, usable: true, terminal: false });
    expect(routes.get(ROUTE2)).toMatchObject({ configured: null, conflict: true, usable: false, terminal: true });
    scene.add("route.retired", { routeId: ROUTE, because: "replaced" });
    expect(fold(scene.set()).routes.get(ROUTE)).toMatchObject({ retired: "replaced", usable: false, terminal: true });
    expectOrderFree(scene.events, fold);
  });

  it("makes a mediated route terminal through a retired or conflicted mediation, not through a missing grant", () => {
    const scene = new Scene();
    scene.add("mediation.created", { mediationId: MEDIATION, mediatorDid: "did:web:m.example" as Did, me: { keyName: `mediation/${MEDIATION}/me` as KeyName, did: me } });
    scene.add("route.configured", { routeId: ROUTE, kind: "mediated", mediationId: MEDIATION, endpoint: null });
    scene.add("route.configured", { routeId: ROUTE2, kind: "mediated", mediationId: MEDIATION2, endpoint: null });
    expect(fold(scene.set()).routes.get(ROUTE)).toMatchObject({ usable: true, terminal: false });
    expect(fold(scene.set()).routes.get(ROUTE2)).toMatchObject({ usable: true, terminal: false });
    scene.add("mediation.retired", { mediationId: MEDIATION, because: "gone" });
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID });
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID2 });
    expect(fold(scene.set()).routes.get(ROUTE)).toMatchObject({ usable: true, terminal: true });
    expect(fold(scene.set()).routes.get(ROUTE2)).toMatchObject({ usable: true, terminal: true });
    expectOrderFree(scene.events, fold);
  });
});

describe("the DID fold", () => {
  it("makes an entity live when its record is consistent, its document sends to its usable route and nothing retired it", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    scene.add("route.configured", { routeId: ROUTE2, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    const created = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    const direct = await createdDid(scene, keys, DID_ID2, ROUTE2, DIRECT);
    const disclosure = scene.add("did.disclosed", { didId: DID_ID, as: "oob", uses: "one", oobId: "019b2a57-a947-7502-8fee-4d80d949dbcb", goal: null });
    const routes = fold(scene.set());
    const did = routes.dids.get(DID_ID)!;
    expect(did).toMatchObject({
      created,
      live: true,
      conflict: false,
      faults: [],
      retired: null,
      identity: "unchecked",
      routeTarget: MEDIATED,
      keyNames: { authentication: `did/${DID_ID}/authentication`, keyAgreement: `did/${DID_ID}/key-agreement` },
      methodIds: { authentication: [`${created.longFormDid}#key-1`], keyAgreement: [`${created.longFormDid}#key-2`] },
    });
    expect(did.disclosures).toEqual([disclosure]);
    expect(did.resolution?.did).toBe(created.did);
    expect(routes.dids.get(DID_ID2)).toMatchObject({ live: true, routeTarget: DIRECT, disclosures: [] });
    expect(routes.desiredRecipients).toEqual([{ did: created.did, didId: DID_ID, routeId: ROUTE, mediationId: MEDIATION }]);
    expect(routes.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
    expect(routes.entityOfKey(`did/${DID_ID2}/authentication` as KeyName)).toBe(DID_ID2);
    expect(routes.entityOfKey(`did/${DID_ID3}/authentication` as KeyName)).toBeNull();
    expect(routes.entityOfDid(created.did)).toBe(DID_ID);
    expect(routes.entityOfDid(created.longFormDid)).toBe(DID_ID);
    expect(routes.entityOfDid(direct.did)).toBe(DID_ID2);
    expect(routes.entityOfDid("did:web:bob.example")).toBeNull();
    expectOrderFree(scene.events, fold);
  });

  it("keeps an entity from being live while its route is missing, retired or conflicted, or its mediation is not usable", async () => {
    const scene = new Scene();
    const created = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    expect(fold(scene.set()).dids.get(DID_ID)).toMatchObject({ live: false, conflict: false, faults: ["the bound route is not configured"], routeTarget: null });
    scene.add("route.configured", { routeId: ROUTE, kind: "mediated", mediationId: MEDIATION, endpoint: null });
    expect(fold(scene.set()).dids.get(DID_ID)).toMatchObject({ live: false, faults: [`mediation ${MEDIATION} is unknown`] });
    scene.add("mediation.created", { mediationId: MEDIATION, mediatorDid: "did:web:m.example" as Did, me: { keyName: `mediation/${MEDIATION}/me` as KeyName, did: me } });
    expect(fold(scene.set()).dids.get(DID_ID)).toMatchObject({ live: false, faults: [`mediation ${MEDIATION} is pending`] });
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    expect(fold(scene.set()).dids.get(DID_ID)).toMatchObject({ live: true, faults: [] });
    scene.add("route.retired", { routeId: ROUTE, because: "moved" });
    expect(fold(scene.set()).dids.get(DID_ID)).toMatchObject({ live: false, faults: ["the bound route is retired"], routeTarget: MEDIATED });
    scene.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    expect(fold(scene.set()).dids.get(DID_ID)).toMatchObject({ live: false, faults: ["the bound route's configurations disagree"], created });
    expect(fold(scene.set()).desiredRecipients).toEqual([]);
    expectOrderFree(scene.events, fold);
  });

  it("faults an entity whose document sends elsewhere than its bound route", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    await createdDid(scene, keys, DID_ID, ROUTE, { kind: "mediated", routingDid: ROUTING_DID2 });
    scene.add("route.configured", { routeId: ROUTE2, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    await createdDid(scene, keys, DID_ID2, ROUTE2, MEDIATED);
    const routes = fold(scene.set());
    expect(routes.dids.get(DID_ID)).toMatchObject({ live: false, conflict: false, faults: ["the document does not send to the bound route"] });
    expect(routes.dids.get(DID_ID2)).toMatchObject({ live: false, conflict: false, faults: ["the document does not send to the bound route"] });
    expect(routes.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
  });

  it("makes disagreeing creations, an unreadable record or a shared spelling a conflict that leaves the reverse maps", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const created = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    scene.add("did.created", { ...created, boundRouteId: ROUTE2 });
    const minted = await mintDid(keys, DID_ID2, MEDIATED);
    scene.add("did.created", { didId: DID_ID2, did: minted.did, longFormDid: `${minted.did}:z2Broken` as Did, boundRouteId: ROUTE });
    const third = await createdDid(scene, keys, DID_ID3, ROUTE, MEDIATED);
    scene.add("did.created", { ...third, didId: "019b6a10-12c0-7410-89ab-38e54b097c22" as DidId });
    const routes = fold(scene.set());
    expect(routes.dids.get(DID_ID)).toMatchObject({ conflict: true, live: false, created: null, resolution: null, faults: ["creations disagree"], methodIds: { authentication: [], keyAgreement: [] } });
    expect(routes.dids.get(DID_ID2)).toMatchObject({ conflict: true, live: false, resolution: null });
    expect(routes.dids.get(DID_ID2)?.faults[0]).toMatch(/long form|resolve|multibase|hash/i);
    expect(routes.dids.get(DID_ID3)).toMatchObject({ conflict: true, live: false, faults: [`${third.did} is also entity 019b6a10-12c0-7410-89ab-38e54b097c22`, `${third.longFormDid} is also entity 019b6a10-12c0-7410-89ab-38e54b097c22`] });
    for (const didId of [DID_ID, DID_ID2, DID_ID3]) expect(routes.entityOfKey(`did/${didId}/key-agreement` as KeyName)).toBeNull();
    expect(routes.entityOfDid(third.did)).toBeNull();
    expect(routes.desiredRecipients).toEqual([]);
    expectOrderFree(scene.events, fold);
  });

  it("retires an entity out of liveness and the desired set while keeping it in the reverse maps", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const created = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    scene.add("did.retired", { didId: DID_ID, because: "contact-deleted" });
    scene.add("did.retired", { didId: DID_ID2, because: "never created" });
    const routes = fold(scene.set());
    expect(routes.dids.get(DID_ID)).toMatchObject({ live: false, conflict: false, retired: "contact-deleted", faults: [] });
    expect(routes.dids.get(DID_ID2)).toMatchObject({ live: false, created: null, faults: ["no creation"], retired: "never created" });
    expect(routes.desiredRecipients).toEqual([]);
    expect(routes.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
    expect(routes.entityOfDid(created.did)).toBe(DID_ID);
    expectOrderFree(scene.events, fold);
  });

  it("lists disclosures in canonical order and desired recipients by short form", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const a = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    const b = await createdDid(scene, keys, DID_ID2, ROUTE, MEDIATED);
    const later = scene.add("did.disclosed", { didId: DID_ID, as: "profile", uses: "many", oobId: null, goal: null }, { at: "2026-09-14T00:00:00.000Z" });
    const earlier = scene.add("did.disclosed", { didId: DID_ID, as: "direct", uses: "many", oobId: null, goal: "hi" }, { at: "2026-09-12T00:00:00.000Z" });
    const routes = fold(scene.set());
    expect(routes.dids.get(DID_ID)?.disclosures).toEqual([earlier, later]);
    expect(routes.desiredRecipients.map((recipient) => recipient.did)).toEqual([a.did, b.did].sort());
    expectOrderFree(scene.events, fold);
  });

  it("checks each readable entity against the seed and treats a mismatch as a conflict", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    await createdDid(scene, await openKeys(OTHER_SEED), DID_ID2, ROUTE, MEDIATED);
    const unchecked = fold(scene.set());
    expect(unchecked.dids.get(DID_ID2)?.live).toBe(true);
    const keyChecks = await verifyDidKeys(keys, unchecked);
    expect(keyChecks).toEqual(new Map([[DID_ID, "verified"], [DID_ID2, "mismatch"]]));
    const checked = fold(scene.set(), { keyChecks });
    expect(checked.dids.get(DID_ID)).toMatchObject({ live: true, identity: "verified" });
    expect(checked.dids.get(DID_ID2)).toMatchObject({ live: false, conflict: true, identity: "mismatch", faults: ["the seed does not derive the entity's keys"] });
    expect(checked.entityOfKey(`did/${DID_ID2}/key-agreement` as KeyName)).toBeNull();
    expect(checked.desiredRecipients.map((recipient) => recipient.didId)).toEqual([DID_ID]);
  });
});

describe("receipt eligibility and the required receiving set", () => {
  async function scene(): Promise<{ scene: Scene; created: VaultData["did.created"]; retiredDid: VaultData["did.created"] }> {
    const s = new Scene();
    mediatedRoute(s, { me });
    mediatedRoute(s, { me: me2 }, MEDIATION2, ROUTE2, ROUTING_DID2);
    s.add("mediation.selected", { mediationId: MEDIATION });
    const created = await createdDid(s, keys, DID_ID, ROUTE, MEDIATED);
    const retiredDid = await createdDid(s, keys, DID_ID2, ROUTE2, { kind: "mediated", routingDid: ROUTING_DID2 });
    s.add("did.retired", { didId: DID_ID2, because: "rotated" });
    return { scene: s, created, retiredDid };
  }

  it("lets a live entity and a retired entity retained in a relationship's history receive, and no other retired one", async () => {
    const { scene: s } = await scene();
    const routes = fold(s.set());
    const none = new Set<DidId>();
    expect(routes.receipt(DID_ID, none)).toBe("eligible");
    expect(routes.receipt(DID_ID2, none)).toBe("terminal");
    expect(routes.receipt(DID_ID2, new Set([DID_ID2]))).toBe("eligible");
    expect(routes.receipt(DID_ID3, new Set([DID_ID3]))).toBe("terminal");
    s.add("route.retired", { routeId: ROUTE2, because: "moved" });
    expect(fold(s.set()).receipt(DID_ID2, new Set([DID_ID2]))).toBe("terminal");
  });

  it("defers while a recoverable prerequisite is missing and rejects a conflicted entity for good", async () => {
    const s = new Scene();
    await createdDid(s, keys, DID_ID, ROUTE, MEDIATED);
    expect(fold(s.set()).receipt(DID_ID, new Set())).toBe("pending");
    s.add("route.configured", { routeId: ROUTE, kind: "mediated", mediationId: MEDIATION, endpoint: null });
    s.add("mediation.created", { mediationId: MEDIATION, mediatorDid: "did:web:m.example" as Did, me: { keyName: `mediation/${MEDIATION}/me` as KeyName, did: me } });
    expect(fold(s.set()).receipt(DID_ID, new Set())).toBe("pending");
    s.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    expect(fold(s.set()).receipt(DID_ID, new Set())).toBe("eligible");
    expect(fold(s.set(), { keyChecks: new Map([[DID_ID, "mismatch"]]) }).receipt(DID_ID, new Set())).toBe("terminal");
    s.add("mediation.retired", { mediationId: MEDIATION, because: "gone" });
    expect(fold(s.set()).receipt(DID_ID, new Set())).toBe("terminal");
  });

  it("requires the preferred mediation and every mediation a live or retained DID's route depends on", async () => {
    const { scene: s } = await scene();
    const set = s.set();
    let { mediations, routes } = both(set);
    expect(requiredReceivingSet(mediations, routes)).toEqual(new Set([MEDIATION]));
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID2]))).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("did.retired", { didId: DID_ID, because: "done" });
    ({ mediations, routes } = both(s.set()));
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID2]))).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("mediation.selected", { mediationId: MEDIATION2 });
    ({ mediations, routes } = both(s.set()));
    expect(requiredReceivingSet(mediations, routes)).toEqual(new Set([MEDIATION2]));
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID, DID_ID2]))).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("route.retired", { routeId: ROUTE, because: "moved" });
    ({ mediations, routes } = both(s.set()));
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID, DID_ID2]))).toEqual(new Set([MEDIATION2]));
    expectOrderFree(s.events, (set) => {
      const folded = both(set);
      return [...requiredReceivingSet(folded.mediations, folded.routes, new Set([DID_ID, DID_ID2]))];
    });
  });

  it("drops a mediation from the required set once it is unusable, whatever depends on it", async () => {
    const { scene: s } = await scene();
    s.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID });
    const { mediations, routes } = both(s.set());
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID2]))).toEqual(new Set([MEDIATION]));
    expect(routes.receipt(DID_ID2, new Set([DID_ID2]))).toBe("terminal");
  });
});
