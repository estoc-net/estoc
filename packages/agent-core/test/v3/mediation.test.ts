import { describe, expect, it } from "vitest";

import { longToShort } from "@estoc/did-peer";
import { mediationKeyName, scanVault, type Did, type MediationId } from "@estoc/vault/v3";

import { MEDIATE_REQUEST, RECIPIENT_QUERY, RECIPIENT_UPDATE } from "../../src/index.js";
import { EntityConflict, Unusable, WrongMediator, createDid, createMediation, ensureRoute, establish, reconcile, registered, retireDid, selectMediation } from "../../src/v3/index.js";
import { MEDIATOR_HTTP } from "../fake-mediator.js";
import { newMediator, party, reloaded } from "./helpers.js";

describe("creating an arrangement", () => {
  it("records the vault's identity toward the mediator before any request, and says the same again for the same ID", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    expect(p.created.data.me.keyName).toBe(mediationKeyName(p.mediationId));
    expect(p.created.data.me.did.startsWith("did:peer:4zQm")).toBe(true);
    expect(p.created.data.me.did).toContain(":z");
    expect(mediator.seenTypes).toEqual([]);
    const again = await createMediation(p.runtime, p.keys, mediator.did as Did, p.mediationId);
    expect(again.eventId).toBe(p.created.eventId);
    const other = await newMediator(201, "http://other-mediator/");
    await expect(createMediation(p.runtime, p.keys, other.did as Did, p.mediationId)).rejects.toBeInstanceOf(EntityConflict);
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(p.mediationId)?.status).toBe("pending");
    await p.runtime.close();
  });
});

describe("establishing", () => {
  it("asks for the grant once, records it, reconciles, and does not ask again", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    const first = await establish(p.link, p.runtime, p.keys, p.mediationId);
    expect(first.steps).toEqual(["granted", "reconciled"]);
    expect(first.mediation.status).toBe("usable");
    expect(first.mediation.routingDid).toBe(mediator.did);
    expect(first.reconciled).toMatchObject({ desired: [], held: [], added: [], removed: [], refused: [] });
    const second = await establish(p.link, p.runtime, p.keys, p.mediationId);
    expect(second.steps).toEqual(["reconciled"]);
    expect(mediator.seenTypes.filter((type) => type === MEDIATE_REQUEST)).toHaveLength(1);
    expect((await p.trace.read({ stream: "diag" })).map((entry) => entry.type)).toEqual(["diag.reconcile", "diag.reconcile"]);
    await p.runtime.close();
  });

  it("a failure after the creation leaves a retryable intent, not a half identity", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    p.offline.reason = "no route to host";
    await expect(establish(p.link, p.runtime, p.keys, p.mediationId)).rejects.toThrow(/no route to host/);
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(p.mediationId)?.status).toBe("pending");
    p.offline.reason = null;
    expect((await establish(p.link, p.runtime, p.keys, p.mediationId)).steps).toEqual(["granted", "reconciled"]);
    await p.runtime.close();
  });

  it("refuses a link to another mediator, and an unknown arrangement", async () => {
    const mediator = await newMediator();
    const other = await newMediator(201, "http://other-mediator/");
    const p = await party(mediator);
    const wrong = await party(other, 2);
    await expect(establish(wrong.link, p.runtime, p.keys, p.mediationId)).rejects.toBeInstanceOf(WrongMediator);
    await expect(establish(p.link, p.runtime, p.keys, "019b0000-0000-7000-8000-000000000000" as MediationId)).rejects.toThrow(/no mediation/);
    await p.runtime.close();
    await wrong.runtime.close();
  });
});

describe("reconciling recipients", () => {
  it("makes the mediator hold exactly the live DIDs on the arrangement's routes: added, removed, kept", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const a = await createDid(p.runtime, p.keys, routeId);
    const b = await createDid(p.runtime, p.keys, routeId);
    mediator.recipients.set("did:peer:2.Ez6stale", p.created.data.me.did);
    let fold = await scanVault(p.runtime.vault, p.keys);
    const first = await reconcile(p.link, fold, p.mediationId);
    expect(first.desired.sort()).toEqual([a.minted.did, b.minted.did].sort());
    expect(first.added.sort()).toEqual([a.minted.did, b.minted.did].sort());
    expect(first.removed).toEqual(["did:peer:2.Ez6stale"]);
    expect(registered(first, a.minted.did)).toBe(true);
    expect([...mediator.recipients.keys()].sort()).toEqual([a.minted.did, b.minted.did].sort());
    expect(mediator.recipients.get(a.minted.did)).toBe(p.created.data.me.did);

    const second = await reconcile(p.link, fold, p.mediationId);
    expect(second).toMatchObject({ added: [], removed: [], refused: [] });
    expect(second.held.sort()).toEqual([a.minted.did, b.minted.did].sort());
    expect(mediator.seenTypes.filter((type) => type === RECIPIENT_UPDATE)).toHaveLength(1);

    await retireDid(p.runtime, p.keys, b.minted.didId, "user");
    fold = await scanVault(p.runtime.vault, p.keys);
    const third = await reconcile(p.link, fold, p.mediationId);
    expect(third.removed).toEqual([b.minted.did]);
    expect([...mediator.recipients.keys()]).toEqual([a.minted.did]);
    expect(mediator.seenTypes.filter((type) => type === RECIPIENT_QUERY)).toHaveLength(4);
    await p.runtime.close();
  });

  it("a DID the mediator will not hold is refused, not registered", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const a = await createDid(p.runtime, p.keys, routeId);
    mediator.refuse.add(a.minted.did);
    const reconciled = await reconcile(p.link, await scanVault(p.runtime.vault, p.keys), p.mediationId);
    expect(reconciled.refused).toEqual([a.minted.did]);
    expect(reconciled.added).toEqual([]);
    expect(registered(reconciled, a.minted.did)).toBe(false);
    await p.runtime.close();
  });

  it("needs a usable arrangement", async () => {
    const p = await party(await newMediator());
    await expect(reconcile(p.link, p.fold, p.mediationId)).rejects.toBeInstanceOf(Unusable);
    await p.runtime.close();
  });
});

describe("selecting", () => {
  it("records the preferred arrangement once it is usable, and nothing twice", async () => {
    const p = await party(await newMediator());
    await expect(selectMediation(p.runtime, p.keys, p.mediationId)).rejects.toBeInstanceOf(Unusable);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const selected = await selectMediation(p.runtime, p.keys, p.mediationId);
    expect(selected?.data).toEqual({ mediationId: p.mediationId });
    expect(await selectMediation(p.runtime, p.keys, p.mediationId)).toBeNull();
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.preferred).toBe(p.mediationId);
    await p.runtime.close();
  });
});

describe("the ring over the arrangement", () => {
  it("holds the identity the mediator knows the vault by, in both spellings", async () => {
    const p = await party(await newMediator());
    await reloaded(p);
    const me = p.created.data.me.did;
    expect(p.ring.secrets().map((s) => s.id)).toContain(`${longToShort(me)}#key-2`);
    expect(MEDIATOR_HTTP).toBe("http://fake-mediator/");
    await p.runtime.close();
  });
});
