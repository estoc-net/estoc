import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { beforeAll, describe, expect, it } from "vitest";

import {
  Keys,
  VaultEventSet,
  foldMediations,
  foldRoutes,
  foldWithSeed,
  inputDocumentOf,
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
  checksOf,
  createdDid,
  expectOrderFree,
  foldChecked,
  mediatedRoute,
  openKeys,
  type KeyChecks,
} from "./helpers.js";

let keys: Keys;
let me: Did;
let me2: Did;

beforeAll(async () => {
  keys = await openKeys();
  me = (await mintMediationDid(keys, MEDIATION)).longFormDid;
  me2 = (await mintMediationDid(keys, MEDIATION2)).longFormDid;
});

const unchecked = (set: VaultEventSet): RouteFold => foldRoutes(set, foldMediations(set));
/** The route fold with the seed's verdicts on every entity of the scene. */
const checked = async (scene: Scene): Promise<RouteFold> => (await foldWithSeed(scene.set(), keys)).routes;
const both = (set: VaultEventSet, checks: KeyChecks) => foldChecked(set, checks);

/** A DID entity whose document is the seed's, edited before the long form is computed. */
async function editedDid(scene: Scene, didId: DidId, edit: (document: Record<string, unknown>) => void): Promise<VaultData["did.created"]> {
  const document = inputDocumentOf(await keys.didKeys(didId), ROUTING_DID) as Record<string, unknown>;
  edit(document);
  const longFormDid = encodeLongForm(document as never) as Did;
  const data = { didId, did: longToShort(longFormDid) as Did, longFormDid, boundRouteId: ROUTE };
  scene.add("did.created", data);
  return data;
}

describe("the route fold", () => {
  it("makes a route usable with one consistent configuration, a conflict with two, terminal when retired", () => {
    const scene = new Scene();
    scene.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    scene.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    scene.add("route.configured", { routeId: ROUTE2, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    scene.add("route.configured", { routeId: ROUTE2, kind: "direct", mediationId: null, endpoint: "https://elsewhere.example/" });
    const routes = unchecked(scene.set()).routes;
    expect(routes.get(ROUTE)).toMatchObject({ configured: { kind: "direct", endpoint: ENDPOINT }, retired: null, conflict: false, usable: true, terminal: false });
    expect(routes.get(ROUTE2)).toMatchObject({ configured: null, conflict: true, usable: false, terminal: true });
    scene.add("route.retired", { routeId: ROUTE, because: "replaced" });
    expect(unchecked(scene.set()).routes.get(ROUTE)).toMatchObject({ retired: "replaced", usable: false, terminal: true });
    expectOrderFree(scene.events, unchecked);
  });

  it("makes a mediated route terminal through a retired or conflicted mediation, not through a missing grant", async () => {
    const scene = new Scene();
    scene.add("mediation.created", { mediationId: MEDIATION, mediatorDid: "did:web:m.example" as Did, me: { keyName: `mediation/${MEDIATION}/me` as KeyName, did: me } });
    scene.add("route.configured", { routeId: ROUTE, kind: "mediated", mediationId: MEDIATION, endpoint: null });
    scene.add("route.configured", { routeId: ROUTE2, kind: "mediated", mediationId: MEDIATION2, endpoint: null });
    expect((await checked(scene)).routes.get(ROUTE)).toMatchObject({ usable: true, terminal: false });
    expect((await checked(scene)).routes.get(ROUTE2)).toMatchObject({ usable: true, terminal: false });
    scene.add("mediation.retired", { mediationId: MEDIATION, because: "gone" });
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID });
    scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID2 });
    expect((await checked(scene)).routes.get(ROUTE)).toMatchObject({ usable: true, terminal: true });
    expect((await checked(scene)).routes.get(ROUTE2)).toMatchObject({ usable: true, terminal: true });
    expectOrderFree(scene.events, unchecked);
  });
});

describe("the DID fold", () => {
  it("makes an entity live when its record is consistent, the seed derives its keys, its document sends to its usable route and nothing retired it", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    scene.add("route.configured", { routeId: ROUTE2, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    const created = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    const direct = await createdDid(scene, keys, DID_ID2, ROUTE2, DIRECT);
    const disclosure = scene.add("did.disclosed", { didId: DID_ID, as: "oob", uses: "one", oobId: "019b2a57-a947-7502-8fee-4d80d949dbcb", goal: null });
    const routes = await checked(scene);
    const did = routes.dids.get(DID_ID)!;
    expect(did).toMatchObject({
      created,
      live: true,
      conflict: false,
      faults: [],
      retired: null,
      identity: "verified",
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
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).routes);
  });

  it("grants nothing to an entity the seed has not confirmed: no verdict map, a map without the ID, or a document another seed made", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const created = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    await createdDid(scene, await openKeys(OTHER_SEED), DID_ID2, ROUTE, MEDIATED);
    const mediations = foldMediations(scene.set(), { keyChecks: new Map([[MEDIATION, "verified"]]) });
    for (const routes of [foldRoutes(scene.set(), mediations), foldRoutes(scene.set(), mediations, { keyChecks: new Map() }), foldRoutes(scene.set(), mediations, { keyChecks: new Map([[DID_ID2, "verified"]]) })]) {
      expect(routes.dids.get(DID_ID)).toMatchObject({ live: false, conflict: false, identity: "unchecked", faults: ["the keys are not yet checked against the seed"] });
      expect(routes.desiredRecipients.map((recipient) => recipient.didId)).not.toContain(DID_ID);
      expect(routes.receipt(DID_ID, new Set())).toBe("pending");
      expect(routes.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
      expect(routes.entityOfDid(created.did)).toBe(DID_ID);
    }
    expect(foldRoutes(scene.set(), mediations).dids.get(DID_ID2)?.live).toBe(false);
    const keyChecks = await verifyDidKeys(keys, foldRoutes(scene.set(), mediations));
    expect(keyChecks).toEqual(new Map([[DID_ID, "verified"], [DID_ID2, "mismatch"]]));
    const routes = foldRoutes(scene.set(), mediations, { keyChecks });
    expect(routes.dids.get(DID_ID)).toMatchObject({ live: true, identity: "verified", faults: [] });
    expect(routes.dids.get(DID_ID2)).toMatchObject({ live: false, conflict: true, identity: "mismatch", faults: ["the seed does not derive the entity's keys"] });
    expect(routes.entityOfKey(`did/${DID_ID2}/key-agreement` as KeyName)).toBeNull();
    expect(routes.receipt(DID_ID2, new Set())).toBe("terminal");
    expect(routes.desiredRecipients.map((recipient) => recipient.didId)).toEqual([DID_ID]);
    expect(foldRoutes(scene.set(), foldMediations(scene.set()), { keyChecks }).dids.get(DID_ID)).toMatchObject({ live: false, faults: [`mediation ${MEDIATION} is pending`] });
  });

  it("keeps an entity from being live while its route is missing, retired or conflicted, or its mediation is not usable", async () => {
    const scene = new Scene();
    const created = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    expect((await checked(scene)).dids.get(DID_ID)).toMatchObject({ live: false, conflict: false, faults: ["the bound route is not configured"], routeTarget: null });
    scene.add("route.configured", { routeId: ROUTE, kind: "mediated", mediationId: MEDIATION, endpoint: null });
    expect((await checked(scene)).dids.get(DID_ID)).toMatchObject({ live: false, faults: [`mediation ${MEDIATION} is unknown`] });
    scene.add("mediation.created", { mediationId: MEDIATION, mediatorDid: "did:web:m.example" as Did, me: { keyName: `mediation/${MEDIATION}/me` as KeyName, did: me } });
    expect((await checked(scene)).dids.get(DID_ID)).toMatchObject({ live: false, faults: [`mediation ${MEDIATION} is pending`] });
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    expect((await checked(scene)).dids.get(DID_ID)).toMatchObject({ live: true, faults: [] });
    scene.add("route.retired", { routeId: ROUTE, because: "moved" });
    expect((await checked(scene)).dids.get(DID_ID)).toMatchObject({ live: false, faults: ["the bound route is retired"], routeTarget: MEDIATED });
    scene.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    expect((await checked(scene)).dids.get(DID_ID)).toMatchObject({ live: false, faults: ["the bound route's configurations disagree"], created });
    expect((await checked(scene)).desiredRecipients).toEqual([]);
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).routes);
  });

  it("makes a document that sends elsewhere than its bound route a conflict", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    await createdDid(scene, keys, DID_ID, ROUTE, { kind: "mediated", routingDid: ROUTING_DID2 });
    scene.add("route.configured", { routeId: ROUTE2, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    await createdDid(scene, keys, DID_ID2, ROUTE2, MEDIATED);
    const routes = await checked(scene);
    expect(routes.dids.get(DID_ID)).toMatchObject({ live: false, conflict: true, identity: "verified", faults: ["the document does not send to the bound route"] });
    expect(routes.dids.get(DID_ID2)).toMatchObject({ live: false, conflict: true, faults: ["the document does not send to the bound route"] });
    expect(routes.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBeNull();
    expect(routes.receipt(DID_ID, new Set())).toBe("terminal");
  });

  it("records a document whose service or key does not read as that entity's conflict and folds and verifies every other entity", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const noEndpoint = await editedDid(scene, DID_ID, (document) => {
      (document.service as Record<string, unknown>[])[0]!.serviceEndpoint = {};
    });
    const badKey = await editedDid(scene, DID_ID2, (document) => {
      (document.verificationMethod as Record<string, unknown>[])[0]!.publicKeyMultibase = "z2Bad";
    });
    const good = await createdDid(scene, keys, DID_ID3, ROUTE, MEDIATED);
    const before = unchecked(scene.set());
    expect(before.dids.get(DID_ID)).toMatchObject({ conflict: true, created: noEndpoint, resolution: null });
    expect(before.dids.get(DID_ID)?.faults[0]).toMatch(/serviceEndpoint|service/i);
    expect(before.dids.get(DID_ID2)).toMatchObject({ conflict: false, created: badKey });
    const keyChecks = await verifyDidKeys(keys, before);
    expect(keyChecks).toEqual(new Map([[DID_ID2, "mismatch"], [DID_ID3, "verified"]]));
    const routes = await checked(scene);
    expect(routes.dids.get(DID_ID)).toMatchObject({ conflict: true, live: false });
    expect(routes.dids.get(DID_ID2)).toMatchObject({ conflict: true, live: false, identity: "mismatch" });
    expect(routes.dids.get(DID_ID3)).toMatchObject({ conflict: false, live: true, created: good, identity: "verified" });
    expect(routes.desiredRecipients.map((recipient) => recipient.didId)).toEqual([DID_ID3]);
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
    const routes = await checked(scene);
    expect(routes.dids.get(DID_ID)).toMatchObject({ conflict: true, live: false, created: null, resolution: null, faults: ["creations disagree"], methodIds: { authentication: [], keyAgreement: [] } });
    expect(routes.dids.get(DID_ID2)).toMatchObject({ conflict: true, live: false, resolution: null });
    expect(routes.dids.get(DID_ID2)?.faults[0]).toMatch(/long form|resolve|multibase|hash/i);
    expect(routes.dids.get(DID_ID3)).toMatchObject({ conflict: true, live: false, faults: [`${third.did} is also entity 019b6a10-12c0-7410-89ab-38e54b097c22`, `${third.longFormDid} is also entity 019b6a10-12c0-7410-89ab-38e54b097c22`] });
    for (const didId of [DID_ID, DID_ID2, DID_ID3]) expect(routes.entityOfKey(`did/${didId}/key-agreement` as KeyName)).toBeNull();
    expect(routes.entityOfDid(third.did)).toBeNull();
    expect(routes.desiredRecipients).toEqual([]);
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).routes);
  });

  it("counts a spelling claimed by any creation of a conflicted entity against the entity that also records it, in either canonical order", async () => {
    for (const ownFirst of [true, false]) {
      const scene = new Scene();
      mediatedRoute(scene, { me });
      const own = await mintDid(keys, DID_ID, MEDIATED);
      const other = await createdDid(scene, keys, DID_ID2, ROUTE, MEDIATED);
      const claims = [
        { didId: DID_ID, did: own.did, longFormDid: own.longFormDid, boundRouteId: ROUTE },
        { ...other, didId: DID_ID },
      ];
      for (const claim of ownFirst ? claims : claims.reverse()) scene.add("did.created", claim);
      const routes = await checked(scene);
      expect(routes.dids.get(DID_ID)).toMatchObject({ conflict: true, live: false });
      expect(routes.dids.get(DID_ID)?.faults).toContain("creations disagree");
      expect(routes.dids.get(DID_ID2)).toMatchObject({ conflict: true, live: false, faults: [`${other.did} is also entity ${DID_ID}`, `${other.longFormDid} is also entity ${DID_ID}`] });
      expect(routes.entityOfDid(other.did)).toBeNull();
      expect(routes.entityOfKey(`did/${DID_ID2}/key-agreement` as KeyName)).toBeNull();
      const checks = await checksOf(scene.events, keys);
      expectOrderFree(scene.events, (set) => both(set, checks).routes);
    }
  });

  it("retires an entity out of liveness and the desired set while keeping it in the reverse maps", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const created = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    scene.add("did.retired", { didId: DID_ID, because: "contact-deleted" });
    scene.add("did.retired", { didId: DID_ID2, because: "never created" });
    const routes = await checked(scene);
    expect(routes.dids.get(DID_ID)).toMatchObject({ live: false, conflict: false, retired: "contact-deleted", faults: [] });
    expect(routes.dids.get(DID_ID2)).toMatchObject({ live: false, created: null, faults: ["no creation"], retired: "never created" });
    expect(routes.desiredRecipients).toEqual([]);
    expect(routes.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
    expect(routes.entityOfDid(created.did)).toBe(DID_ID);
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).routes);
  });

  it("lists disclosures in canonical order and desired recipients by short form", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const a = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
    const b = await createdDid(scene, keys, DID_ID2, ROUTE, MEDIATED);
    const later = scene.add("did.disclosed", { didId: DID_ID, as: "profile", uses: "many", oobId: null, goal: null }, { at: "2026-09-14T00:00:00.000Z" });
    const earlier = scene.add("did.disclosed", { didId: DID_ID, as: "direct", uses: "many", oobId: null, goal: "hi" }, { at: "2026-09-12T00:00:00.000Z" });
    const routes = await checked(scene);
    expect(routes.dids.get(DID_ID)?.disclosures).toEqual([earlier, later]);
    expect(routes.desiredRecipients.map((recipient) => recipient.did)).toEqual([a.did, b.did].sort());
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).routes);
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
    const routes = await checked(s);
    const none = new Set<DidId>();
    expect(routes.receipt(DID_ID, none)).toBe("eligible");
    expect(routes.receipt(DID_ID2, none)).toBe("terminal");
    expect(routes.receipt(DID_ID2, new Set([DID_ID2]))).toBe("eligible");
    expect(routes.receipt(DID_ID3, new Set([DID_ID3]))).toBe("terminal");
    s.add("route.retired", { routeId: ROUTE2, because: "moved" });
    expect((await checked(s)).receipt(DID_ID2, new Set([DID_ID2]))).toBe("terminal");
  });

  it("settles what is terminal before what is missing: a retired entity nothing retains or a document that sends elsewhere is terminal without its route", async () => {
    const s = new Scene();
    const retiredDid = await createdDid(s, keys, DID_ID, ROUTE, MEDIATED);
    s.add("did.retired", { didId: DID_ID, because: "rotated" });
    expect((await checked(s)).dids.get(DID_ID)).toMatchObject({ created: retiredDid, faults: ["the bound route is not configured"] });
    expect((await checked(s)).receipt(DID_ID, new Set())).toBe("terminal");
    expect((await checked(s)).receipt(DID_ID, new Set([DID_ID]))).toBe("pending");
    const elsewhere = new Scene();
    elsewhere.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: "https://y.example/" });
    await createdDid(elsewhere, keys, DID_ID2, ROUTE, { kind: "direct", endpoint: "https://x.example/" });
    const routes = await checked(elsewhere);
    expect(routes.dids.get(DID_ID2)).toMatchObject({ identity: "verified", conflict: true, faults: ["the document does not send to the bound route"] });
    expect(routes.receipt(DID_ID2, new Set())).toBe("terminal");
  });

  it("defers while a recoverable prerequisite is missing and rejects a conflicted entity for good", async () => {
    const s = new Scene();
    await createdDid(s, keys, DID_ID, ROUTE, MEDIATED);
    expect((await checked(s)).receipt(DID_ID, new Set())).toBe("pending");
    s.add("route.configured", { routeId: ROUTE, kind: "mediated", mediationId: MEDIATION, endpoint: null });
    s.add("mediation.created", { mediationId: MEDIATION, mediatorDid: "did:web:m.example" as Did, me: { keyName: `mediation/${MEDIATION}/me` as KeyName, did: me } });
    expect((await checked(s)).receipt(DID_ID, new Set())).toBe("pending");
    s.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    expect(unchecked(s.set()).receipt(DID_ID, new Set())).toBe("pending");
    expect((await checked(s)).receipt(DID_ID, new Set())).toBe("eligible");
    const mediations = (await foldWithSeed(s.set(), keys)).mediations;
    expect(foldRoutes(s.set(), mediations, { keyChecks: new Map([[DID_ID, "mismatch"]]) }).receipt(DID_ID, new Set())).toBe("terminal");
    s.add("mediation.retired", { mediationId: MEDIATION, because: "gone" });
    expect((await checked(s)).receipt(DID_ID, new Set())).toBe("terminal");
  });

  it("requires the preferred mediation and every mediation a live or retained DID's route depends on, once the seed confirms them", async () => {
    const { scene: s } = await scene();
    const bare = both(s.set(), { mediations: new Map(), dids: new Map() });
    expect(requiredReceivingSet(bare.mediations, bare.routes, new Set([DID_ID2]))).toEqual(new Set());
    let { mediations, routes } = await foldWithSeed(s.set(), keys);
    expect(requiredReceivingSet(mediations, routes)).toEqual(new Set([MEDIATION]));
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID2]))).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("did.retired", { didId: DID_ID, because: "done" });
    ({ mediations, routes } = await foldWithSeed(s.set(), keys));
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID2]))).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("mediation.selected", { mediationId: MEDIATION2 });
    ({ mediations, routes } = await foldWithSeed(s.set(), keys));
    expect(requiredReceivingSet(mediations, routes)).toEqual(new Set([MEDIATION2]));
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID, DID_ID2]))).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("route.retired", { routeId: ROUTE, because: "moved" });
    ({ mediations, routes } = await foldWithSeed(s.set(), keys));
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID, DID_ID2]))).toEqual(new Set([MEDIATION2]));
    const checks = await checksOf(s.events, keys);
    expectOrderFree(s.events, (set) => {
      const folded = both(set, checks);
      return [...requiredReceivingSet(folded.mediations, folded.routes, new Set([DID_ID, DID_ID2]))];
    });
  });

  it("drops a mediation from the required set once it is unusable, whatever depends on it", async () => {
    const { scene: s } = await scene();
    s.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID });
    const { mediations, routes } = await foldWithSeed(s.set(), keys);
    expect(requiredReceivingSet(mediations, routes, new Set([DID_ID2]))).toEqual(new Set([MEDIATION]));
    expect(routes.receipt(DID_ID2, new Set([DID_ID2]))).toBe("terminal");
  });
});
