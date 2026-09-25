import { describe, expect, it, test } from "vitest";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { InvalidIdentifier, didcommServiceUris, scanVault, vaultDraft, type DidId, type RouteId } from "@estoc/vault";

import { EntityConflict, OOB_INVITATION, Unregistered, Unusable, WrongMediator, configureRoute, createDid, disclose, ensureRoute, establish, invitationUrl, mediatedRouteOf, parseInvitation, retireDid, routeTargetOf } from "../src/index.js";
import { freshVault, newMediator, party } from "./helpers.js";

const ENDPOINT = "https://ingress.example/didcomm";
const ROUTE = "019b0000-0000-7000-8000-00000000000a" as RouteId;
const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;

describe("routes", () => {
  test("a mediated route needs a usable arrangement; a direct one needs nothing; the same ID says the same or is refused", async () => {
    const p = await party(await newMediator());
    await expect(configureRoute(p.runtime, p.keys, { kind: "mediated", mediationId: p.mediationId })).rejects.toBeInstanceOf(Unusable);
    const direct = await configureRoute(p.runtime, p.keys, { kind: "direct", endpoint: ENDPOINT }, ROUTE);
    expect(direct.data).toEqual({ routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT });
    expect((await configureRoute(p.runtime, p.keys, { kind: "direct", endpoint: ENDPOINT }, ROUTE)).cid).toBe(direct.cid);
    await expect(configureRoute(p.runtime, p.keys, { kind: "direct", endpoint: "https://elsewhere.example/" }, ROUTE)).rejects.toBeInstanceOf(EntityConflict);

    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    expect(await ensureRoute(p.runtime, p.keys, p.mediationId)).toBe(routeId);
    const fold = await scanVault(p.runtime.vault, p.keys);
    expect(mediatedRouteOf(fold, p.mediationId)?.routeId).toBe(routeId);
    expect(routeTargetOf(fold, routeId)).toEqual({ kind: "mediated", routingDid: p.mediator.did });
    expect(routeTargetOf(fold, ROUTE)).toEqual({ kind: "direct", endpoint: ENDPOINT });
    await p.runtime.close();
  });
});

describe("communication DIDs", () => {
  it("is minted from its ID and route alone: the document sends to the route, the same ID gives the same DID and writes nothing twice", async () => {
    const { runtime, keys } = await freshVault();
    await configureRoute(runtime, keys, { kind: "direct", endpoint: ENDPOINT }, ROUTE);
    const first = await createDid(runtime, keys, ROUTE, DID);
    expect(first.existed).toBe(false);
    expect(first.created.data).toEqual({ didId: DID, did: first.minted.did, longFormDid: first.minted.longFormDid, boundRouteId: ROUTE });
    expect(didcommServiceUris(first.minted.inputDocument)).toEqual([ENDPOINT]);
    const doc = await resolveDIDCommDoc(first.minted.longFormDid);
    expect(doc?.keyAgreement).toEqual([`${first.minted.longFormDid}#key-2`]);

    const again = await createDid(runtime, keys, ROUTE, DID);
    expect(again.existed).toBe(true);
    expect(again.created.cid).toBe(first.created.cid);
    expect(again.minted.did).toBe(first.minted.did);
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.set.of("did.created")).toHaveLength(1);
    expect(fold.routes.dids.get(DID)?.live).toBe(true);
    await runtime.close();
  });

  it("is minted under a UUIDv7 only: a UUIDv5 is refused and nothing written", async () => {
    const { runtime, keys } = await freshVault();
    await configureRoute(runtime, keys, { kind: "direct", endpoint: ENDPOINT }, ROUTE);
    await expect(createDid(runtime, keys, ROUTE, "019b0000-0000-5000-8000-00000000000c" as DidId)).rejects.toBeInstanceOf(InvalidIdentifier);
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.set.of("did.created")).toEqual([]);
    expect(fold.routes.dids.size).toBe(0);
    await runtime.close();
  });

  it("cannot be recreated on another route, and is not minted on a route that is not usable", async () => {
    const { runtime, keys } = await freshVault();
    await configureRoute(runtime, keys, { kind: "direct", endpoint: ENDPOINT }, ROUTE);
    await createDid(runtime, keys, ROUTE, DID);
    const other = await configureRoute(runtime, keys, { kind: "direct", endpoint: "https://elsewhere.example/" });
    await expect(createDid(runtime, keys, other.data.routeId, DID)).rejects.toBeInstanceOf(EntityConflict);
    await runtime.vault.commit([], [vaultDraft("route.retired", { routeId: ROUTE, because: "test" })]);
    await expect(createDid(runtime, keys, ROUTE)).rejects.toBeInstanceOf(Unusable);
    await expect(createDid(runtime, keys, "019b0000-0000-7000-8000-0000000000ff" as RouteId)).rejects.toThrow(/no route/);
    await runtime.close();
  });

  it("retires once: new sending and disclosure stop, the record stays", async () => {
    const { runtime, keys } = await freshVault();
    await configureRoute(runtime, keys, { kind: "direct", endpoint: ENDPOINT }, ROUTE);
    await createDid(runtime, keys, ROUTE, DID);
    const retired = await retireDid(runtime, keys, DID, "user");
    expect(retired.data).toEqual({ didId: DID, because: "user" });
    expect((await retireDid(runtime, keys, DID, "again")).cid).toBe(retired.cid);
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.routes.dids.get(DID)).toMatchObject({ live: false, retired: "user" });
    await expect(disclose(null, runtime, keys, DID, { as: "direct", uses: "many" })).rejects.toBeInstanceOf(Unusable);
    await runtime.close();
  });
});

describe("disclosure", () => {
  test("a direct address is disclosed without a mediator; an oob disclosure carries the long form in an invitation", async () => {
    const { runtime, keys } = await freshVault();
    await configureRoute(runtime, keys, { kind: "direct", endpoint: ENDPOINT }, ROUTE);
    const { minted } = await createDid(runtime, keys, ROUTE, DID);
    const oob = await disclose(null, runtime, keys, DID, { as: "oob", uses: "one", goal: "Write to Alice" });
    expect(oob.disclosed.data).toMatchObject({ didId: DID, as: "oob", uses: "one", goal: "Write to Alice" });
    expect(oob.invitation).toEqual({ type: OOB_INVITATION, id: oob.disclosed.data.oobId, typ: "application/didcomm-plain+json", from: minted.longFormDid, body: { goal_code: "connect", goal: "Write to Alice", accept: ["didcomm/v2"] } });
    expect(parseInvitation(invitationUrl("https://estoc.net/i", oob.invitation!))).toEqual(oob.invitation);
    const direct = await disclose(null, runtime, keys, DID, { as: "direct", uses: "many" });
    expect(direct.disclosed.data).toEqual({ didId: DID, as: "direct", uses: "many", oobId: null, goal: null });
    expect(direct.invitation).toBeNull();
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.routes.dids.get(DID)?.disclosures).toHaveLength(2);
    await runtime.close();
  });

  it("republishes an invitation under its oobId, in sequence or concurrently, and refuses the ID for anything else", async () => {
    const { runtime, keys } = await freshVault();
    await configureRoute(runtime, keys, { kind: "direct", endpoint: ENDPOINT }, ROUTE);
    await createDid(runtime, keys, ROUTE, DID);
    const other = await createDid(runtime, keys, ROUTE);
    const invitation = { as: "oob", uses: "one", oobId: "invite-1", goal: "Write to Alice" } as const;
    const first = await disclose(null, runtime, keys, DID, invitation);
    const again = await disclose(null, runtime, keys, DID, invitation);
    expect(again.disclosed.cid).toBe(first.disclosed.cid);
    expect(again.invitation).toEqual(first.invitation);
    const [x, y] = await Promise.all([disclose(null, runtime, keys, DID, { ...invitation, oobId: "invite-2" }), disclose(null, runtime, keys, DID, { ...invitation, oobId: "invite-2" })]);
    expect(y.disclosed.cid).toBe(x.disclosed.cid);
    await expect(disclose(null, runtime, keys, DID, { ...invitation, goal: "Write to Bob" })).rejects.toBeInstanceOf(EntityConflict);
    await expect(disclose(null, runtime, keys, DID, { ...invitation, uses: "many" })).rejects.toBeInstanceOf(EntityConflict);
    await expect(disclose(null, runtime, keys, other.created.data.didId, invitation)).rejects.toThrow(/another DID/);
    expect((await scanVault(runtime.vault, keys)).set.of("did.disclosed").map((event) => event.data.oobId)).toEqual(["invite-1", "invite-2"]);
    await runtime.close();
  });

  test("a mediated address is disclosed only once the mediator holds it, over the arrangement's own link", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const { minted } = await createDid(p.runtime, p.keys, routeId, DID);
    await expect(disclose(null, p.runtime, p.keys, DID, { as: "oob", uses: "one" })).rejects.toBeInstanceOf(WrongMediator);
    mediator.refuse.add(minted.did);
    await expect(disclose(p.link, p.runtime, p.keys, DID, { as: "oob", uses: "one" })).rejects.toBeInstanceOf(Unregistered);
    expect((await scanVault(p.runtime.vault, p.keys)).routes.dids.get(DID)?.disclosures).toEqual([]);
    mediator.refuse.delete(minted.did);
    const disclosed = await disclose(p.link, p.runtime, p.keys, DID, { as: "oob", uses: "many", oobId: "invite-1" });
    expect(disclosed.invitation?.id).toBe("invite-1");
    expect(disclosed.invitation?.from).toBe(minted.longFormDid);
    expect(mediator.recipients.get(minted.did)).toBe(p.created.data.me.did);
    await p.runtime.close();
  });
});
