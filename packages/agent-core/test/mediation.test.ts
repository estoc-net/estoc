import { describe, expect, it } from "vitest";

import { longToShort, resolveDIDCommDoc, type Secret } from "@estoc/did-peer";
import { mediationKeyName, scanVault, type Did, type MediationId } from "@estoc/vault";

import { Message } from "@estoc/didcomm-node";


import {
  AgentTrace,
  EntityConflict,
  MEDIATE_GRANT,
  MEDIATE_REQUEST,
  MediatorLink,
  RECIPIENT,
  RECIPIENT_QUERY,
  RECIPIENT_UPDATE,
  RECIPIENT_UPDATE_RESPONSE,
  Unregistered,
  Unusable,
  UnverifiedReply,
  WrongAccount,
  WrongMediator,
  createDid,
  createMediation,
  disclose,
  ensureRoute,
  establish,
  plainMessage,
  reconcile,
  registered,
  retireDid,
  secretsResolverFor,
  selectMediation,
  type IMessage,
} from "../src/index.js";
import { MEDIATOR_HTTP } from "./fake-mediator.js";
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

  it("refuses a link speaking as another arrangement's identity, even toward the same mediator", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const mine = await createDid(p.runtime, p.keys, routeId);
    await reconcile(p.link, p.runtime, p.keys, p.mediationId);
    const second = await createMediation(p.runtime, p.keys, mediator.did as Did);
    const seen = mediator.seenTypes.length;
    await expect(establish(p.link, p.runtime, p.keys, second.data.mediationId)).rejects.toBeInstanceOf(WrongAccount);
    await expect(reconcile(p.link, p.runtime, p.keys, second.data.mediationId)).rejects.toBeInstanceOf(WrongAccount);
    expect(mediator.seenTypes).toHaveLength(seen);
    expect(mediator.granted.has(second.data.me.did)).toBe(false);
    expect(mediator.recipients.get(mine.minted.did)).toBe(p.created.data.me.did);
    const fold = await scanVault(p.runtime.vault, p.keys);
    expect(fold.mediations.mediations.get(second.data.mediationId)?.status).toBe("pending");

    const own = new MediatorLink({ ...p.linkOptions, me: second.data.me.did });
    await reloaded(p);
    expect((await establish(own, p.runtime, p.keys, second.data.mediationId)).mediation.status).toBe("usable");
    expect(mediator.granted.has(second.data.me.did)).toBe(true);
    await p.runtime.close();
  });

  it("takes only a reply the mediator sealed to the arrangement's identity: plaintext, anonymous, signed under an anonymous seal, another sealer and another recipient of ours are refused", async () => {
    const mediator = await newMediator();
    const impostor = await newMediator(201, "http://impostor/");
    const p = await party(mediator);
    const otherAccount = await createMediation(p.runtime, p.keys, mediator.did as Did);
    await reloaded(p);
    const to = p.created.data.me.did;
    let forge: ((message: IMessage) => Promise<string>) | null = null;
    const forged = (
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (forge === null) return mediator.fetch(input, init);
        const message = plainMessage(MEDIATE_GRANT, impostor.did, to, { routing_did: [impostor.did] });
        return new Response(await forge(message), { status: 200 });
      }) as typeof fetch
    );
    const link = new MediatorLink({ ...p.linkOptions, fetch: forged });
    const packWith = (secrets: Secret[]) => async (message: IMessage, from: string | null, recipient = to, signBy: string | null = null) =>
      (await new Message(message).pack_encrypted(recipient, from, signBy, { resolve: resolveDIDCommDoc }, secretsResolverFor(secrets), { forward: false }))[0];
    const forgeries: Record<string, (message: IMessage) => Promise<string>> = {
      plaintext: async (message) => JSON.stringify({ ...message, from: mediator.did }),
      anonymous: (message) => packWith(impostor.secrets)({ ...message, from: mediator.did }, null),
      "signed by the mediator, sealed anonymously": (message) => packWith(mediator.secrets)({ ...message, from: mediator.did }, null, to, mediator.did),
      "another sealer": (message) => packWith(impostor.secrets)(message, impostor.did),
      "another recipient": (message) => packWith(mediator.secrets)({ ...message, from: mediator.did, to: [otherAccount.data.me.did] }, mediator.did, otherAccount.data.me.did),
    };
    for (const [name, forgery] of Object.entries(forgeries)) {
      forge = forgery;
      await expect(establish(link, p.runtime, p.keys, p.mediationId), name).rejects.toBeInstanceOf(UnverifiedReply);
      expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(p.mediationId)?.status, name).toBe("pending");
    }
    expect((await p.trace.read({ type: "envelope.rejected" })).map((entry) => entry.data["reason"])).toEqual([
      "not authenticated encryption",
      "not authenticated encryption",
      "not authenticated encryption",
      `sealed by ${impostor.did}`,
      `sealed to ${otherAccount.data.me.did}`,
    ]);
    // the signed one did open as authenticated: the signature verified, and that is not what the boundary asks
    const signed = (await p.trace.read({ type: "envelope.open" })).find((entry) => entry.data["sign_from"] !== undefined);
    expect(signed?.data["from_kid"]).toBeUndefined();
    expect(String(signed?.data["sign_from"]).startsWith(`${mediator.did}#`)).toBe(true);
    forge = null;
    expect((await establish(link, p.runtime, p.keys, p.mediationId)).mediation.routingDid).toBe(mediator.did);
    await p.runtime.close();
  });

  it("takes the mediator's reply with its sender protected: an anonymous layer over the mediator's authcrypt still proves it", async () => {
    const mediator = await newMediator();
    mediator.protectSender = true;
    const p = await party(mediator);
    const opened = await p.link.exchange(MEDIATE_REQUEST, {});
    expect(opened.msg.type).toBe(MEDIATE_GRANT);
    expect(opened.metadata).toMatchObject({ encrypted: true, authenticated: true, anonymous_sender: true });
    expect(opened.sender).toBe(mediator.did);
    expect((await establish(p.link, p.runtime, p.keys, p.mediationId)).mediation.status).toBe("usable");
    expect(await p.trace.read({ type: "envelope.rejected" })).toEqual([]);
    await p.runtime.close();
  });

  it("refuses a forged reply by the deadline even when the note of the refusal never settles, and the account's next procedure goes on", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const stalled = Object.create(p.trace) as AgentTrace;
    (stalled as { append: AgentTrace["append"] }).append = (stream, what, data) => (stream === "envelope" && what === "rejected" ? new Promise(() => undefined) : p.trace.append(stream, what, data));
    const forged = plainMessage(RECIPIENT, mediator.did, p.link.me, { dids: [], pagination: { count: 0, offset: 0, remaining: 0 } });
    const link = new MediatorLink({ ...p.linkOptions, trace: stalled, timeoutMs: 300, fetch: async () => new Response(JSON.stringify(forged), { status: 200 }) });
    const started = Date.now();
    const first = reconcile(link, p.runtime, p.keys, p.mediationId);
    const second = reconcile(p.link, p.runtime, p.keys, p.mediationId);
    await expect(first).rejects.toBeInstanceOf(UnverifiedReply);
    expect((await second).desired).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(p.log).toContain("trace not written: the deadline passed while noting");
    await p.runtime.close();
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
    const first = await reconcile(p.link, p.runtime, p.keys, p.mediationId);
    expect(first.desired.sort()).toEqual([a.minted.did, b.minted.did].sort());
    expect(first.added.sort()).toEqual([a.minted.did, b.minted.did].sort());
    expect(first.removed).toEqual(["did:peer:2.Ez6stale"]);
    expect(registered(first, a.minted.did)).toBe(true);
    expect([...mediator.recipients.keys()].sort()).toEqual([a.minted.did, b.minted.did].sort());
    expect(mediator.recipients.get(a.minted.did)).toBe(p.created.data.me.did);

    const second = await reconcile(p.link, p.runtime, p.keys, p.mediationId);
    expect(second).toMatchObject({ added: [], removed: [], refused: [] });
    expect(second.held.sort()).toEqual([a.minted.did, b.minted.did].sort());
    expect(mediator.seenTypes.filter((type) => type === RECIPIENT_UPDATE)).toHaveLength(1);

    await retireDid(p.runtime, p.keys, b.minted.didId, "user");
    const third = await reconcile(p.link, p.runtime, p.keys, p.mediationId);
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
    const reconciled = await reconcile(p.link, p.runtime, p.keys, p.mediationId);
    expect(reconciled.refused).toEqual([a.minted.did]);
    expect(reconciled.added).toEqual([]);
    expect(registered(reconciled, a.minted.did)).toBe(false);
    await p.runtime.close();
  });

  it("refuses a mediator whose pages make no progress or never end, and is ready for the account's next procedure", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const a = await createDid(p.runtime, p.keys, routeId);
    const established = mediator.seenTypes.filter((type) => type === RECIPIENT_QUERY).length;
    const queries = () => mediator.seenTypes.filter((type) => type === RECIPIENT_QUERY).length - established;
    const offsetOf = (msg: IMessage) => (msg.body as { paginate: { offset: number } }).paginate.offset;
    const paging = (entries: (msg: IMessage) => unknown[]) => {
      mediator.intercept = (msg, from) => (msg.type === RECIPIENT_QUERY ? mediator.reply(RECIPIENT, from!, { dids: entries(msg), pagination: { count: 1, offset: offsetOf(msg), remaining: 1 } }, msg.id) : undefined);
    };

    paging(() => [{ recipient_did: a.minted.did }]);
    await expect(reconcile(p.link, p.runtime, p.keys, p.mediationId)).rejects.toThrow(/recipient-query lists .* again at offset 1/);
    expect(queries()).toBe(2);

    paging((msg) => [{ recipient_did: `did:peer:2.Ez6page${offsetOf(msg)}` }]);
    await expect(reconcile(p.link, p.runtime, p.keys, p.mediationId)).rejects.toThrow(/recipient-query lists more than 100 pages/);
    expect(queries()).toBe(102);

    paging(() => [{ action: "add" }]);
    await expect(reconcile(p.link, p.runtime, p.keys, p.mediationId)).rejects.toThrow(/recipient-query names no recipient at offset 0/);
    expect(queries()).toBe(103);

    mediator.intercept = null;
    expect(registered(await reconcile(p.link, p.runtime, p.keys, p.mediationId), a.minted.did)).toBe(true);
    expect(mediator.seenTypes.filter((type) => type === RECIPIENT_UPDATE)).toHaveLength(1);
    await p.runtime.close();
  });

  it("needs a usable arrangement", async () => {
    const p = await party(await newMediator());
    await expect(reconcile(p.link, p.runtime, p.keys, p.mediationId)).rejects.toBeInstanceOf(Unusable);
    await p.runtime.close();
  });

  it("pairs each answer with the update it answers: a removal's success is no registration", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const a = await createDid(p.runtime, p.keys, routeId);
    const answers: Record<string, unknown>[][] = [
      [{ recipient_did: a.minted.did, action: "remove", result: "success" }],
      [{ recipient_did: a.minted.did, result: "success" }],
      [],
      [
        { recipient_did: a.minted.did, action: "add", result: "success" },
        { recipient_did: a.minted.did, action: "add", result: "server_error" },
      ],
    ];
    mediator.intercept = (msg, from) => {
      if (msg.type !== RECIPIENT_UPDATE) return undefined;
      return mediator.reply(RECIPIENT_UPDATE_RESPONSE, from as string, { updated: answers.shift() }, msg.id);
    };
    while (answers.length > 0) {
      const reconciled = await reconcile(p.link, p.runtime, p.keys, p.mediationId);
      expect(reconciled.refused).toEqual([a.minted.did]);
      expect(registered(reconciled, a.minted.did)).toBe(false);
      await expect(disclose(p.link, p.runtime, p.keys, a.minted.didId, { as: "oob", uses: "one" })).rejects.toBeInstanceOf(Unregistered);
    }
    expect(mediator.recipients.has(a.minted.did)).toBe(false);
    mediator.intercept = null;
    expect(registered(await reconcile(p.link, p.runtime, p.keys, p.mediationId), a.minted.did)).toBe(true);
    await p.runtime.close();
  });

  it("runs one procedure at a time per account, whichever link, so a reconciliation cannot remove what was disclosed while it waited", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const first = await createDid(p.runtime, p.keys, routeId);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = (): void => undefined;
    const paused = new Promise<void>((resolve) => (entered = resolve));
    let queries = 0;
    mediator.intercept = async (msg) => {
      if (msg.type === RECIPIENT_QUERY && queries++ === 0) {
        entered();
        await gate;
      }
      return undefined;
    };
    const firstDisclosure = disclose(p.link, p.runtime, p.keys, first.minted.didId, { as: "oob", uses: "one" });
    await paused;
    const second = await createDid(p.runtime, p.keys, routeId);
    const other = new MediatorLink({ ...p.linkOptions, me: p.created.data.me.did });
    const secondDisclosure = disclose(other, p.runtime, p.keys, second.minted.didId, { as: "oob", uses: "one" });
    expect(mediator.seenTypes.filter((type) => type === RECIPIENT_QUERY)).toHaveLength(2);
    expect(mediator.recipients.size).toBe(0);
    release();
    await Promise.all([firstDisclosure, secondDisclosure]);
    expect(mediator.seenTypes.slice(-4)).toEqual([RECIPIENT_QUERY, RECIPIENT_UPDATE, RECIPIENT_QUERY, RECIPIENT_UPDATE]);
    expect([...mediator.recipients.keys()].sort()).toEqual([first.minted.did, second.minted.did].sort());
    const fold = await scanVault(p.runtime.vault, p.keys);
    expect(fold.set.of("did.disclosed")).toHaveLength(2);
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
