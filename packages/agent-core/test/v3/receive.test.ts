import { describe, expect, it, vi } from "vitest";

import { resolveDIDCommDoc, type Secret } from "@estoc/did-peer";
import type { JsonObject, VaultRuntime } from "@estoc/event-store/v3";
import { didKeyName, relationshipId, scanVault, splitDidUrl, vaultDraft, type DidId, type EventReference, type MediationId, type PublicKey, type RouteId } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { PLAIN_TYP, packEncrypted, packFromPrior, secretsResolverFor, type DIDResolver, type IMessage } from "../../src/protocol/didcomm.js";
import {
  AgentTrace,
  DEFINITIVE_TRANSPORT_CODES,
  Keyring,
  Pickup,
  Receiver,
  authorizedKeys,
  commitResolution,
  createDid,
  deliveryKey,
  didcommDocumentOf,
  ensureRoute,
  establish,
  reconcile,
  resolve,
  retireDid,
  type Authenticated,
  type Delivery,
  type ReceiptOutcome,
  type ReceiverOptions,
  type Resolution,
  type Source,
} from "../../src/v3/index.js";
import { didcomm, directParty, freshVault, handTimers, json, newMediator, party, reloaded, webIdentity, type DirectParty, type Fresh, type WebIdentity } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const OTHER = "019b0000-0000-7000-8000-00000000000c" as DidId;
const MEDIATION = "019b0000-0000-7000-8000-000000000201" as MediationId;
const ALICE_ENDPOINT = "https://alice.example/didcomm";
const CAROL_ENDPOINT = "https://carol.example/didcomm";
const BOB = "did:web:bob.example";
const BOB_URL = "https://bob.example/.well-known/did.json";
const START = 1_800_000_000_000;

const PICKUP: Source = { kind: "pickup", mediationId: MEDIATION, deliveryId: "d1" };
const DIRECT: Source = { kind: "direct" };

/** Someone who seals: a DID, its secrets, and how the documents it seals against resolve. */
interface Sealer {
  did: string;
  secrets: Secret[];
  resolver: DIDResolver;
}

async function webResolution(identity: WebIdentity): Promise<Resolution> {
  const outcome = await resolve(identity.did, () => null, { fetch: async () => json(identity.document) });
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  return outcome.resolution;
}

async function peerResolutionOf(did: string): Promise<Resolution> {
  const outcome = await resolve(did, () => null);
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  return outcome.resolution;
}

async function webSealer(identity: WebIdentity): Promise<Sealer> {
  const document = didcommDocumentOf(await webResolution(identity));
  return { did: identity.did, secrets: identity.secrets, resolver: { resolve: async (did) => (did === identity.did ? document : resolveDIDCommDoc(did)) } };
}

async function peerSealer(holder: DirectParty): Promise<Sealer> {
  const ring = await Keyring.load(holder.keys, await scanVault(holder.runtime.vault, holder.keys));
  return { did: holder.longFormDid, secrets: ring.secrets(), resolver: { resolve: resolveDIDCommDoc } };
}

/** A basic message sealed to `to`: authcrypt from the sealer, anoncrypt without one. */
async function sealed(from: Sealer | null, to: string, extra: Partial<IMessage> = {}): Promise<string> {
  const plain = { id: crypto.randomUUID(), typ: PLAIN_TYP, type: BASIC_MESSAGE, ...(from === null ? {} : { from: from.did }), to: [to], body: { content: "hello" }, ...extra } as IMessage;
  const [packed] = await packEncrypted(didcomm, plain, to, from?.did ?? null, null, from?.resolver ?? { resolve: resolveDIDCommDoc }, secretsResolverFor(from?.secrets ?? []), { forward: false });
  return packed;
}

const kidOf = (packed: string): string => (JSON.parse(packed) as { recipients: { header: { kid: string } }[] }).recipients[0]!.header.kid;

/** The envelope with every recipient's key ID replaced by `kid`: what arrives addressed elsewhere. */
function addressedTo(packed: string, kid: string): string {
  const envelope = JSON.parse(packed) as { recipients: { header: { kid: string } }[] };
  return JSON.stringify({ ...envelope, recipients: envelope.recipients.map((recipient) => ({ ...recipient, header: { ...recipient.header, kid } })) });
}

type Answer = "ok" | number | Error;

/** Bob's host: each fetch gets the next planned answer, and the document it serves once the plan is spent. */
function host(document: JsonObject): { fetch: typeof globalThis.fetch; calls: string[]; state: { document: JsonObject; plan: Answer[] } } {
  const calls: string[] = [];
  const state = { document, plan: [] as Answer[] };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const next = state.plan.shift() ?? "ok";
    if (next instanceof Error) throw next;
    if (typeof next === "number") return new Response("not now", { status: next });
    return url === BOB_URL ? json(state.document) : new Response("no such document", { status: 404 });
  };
  return { fetch, calls, state };
}

/** A receipt that records what reaches it and answers `answer`. */
function recording(answer: () => ReceiptOutcome = () => ({ outcome: "received" })): { receipt: ReceiverOptions["receipt"]; seen: Authenticated[] } {
  const seen: Authenticated[] = [];
  return {
    seen,
    receipt: async (authenticated) => {
      seen.push(authenticated);
      return answer();
    },
  };
}

async function receiverOver(holder: Fresh, options: Omit<ReceiverOptions, "didcomm">): Promise<Receiver> {
  const ring = await Keyring.load(holder.keys, await scanVault(holder.runtime.vault, holder.keys));
  return new Receiver(holder.runtime, holder.keys, ring, { didcomm, ...options });
}

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = START;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function acknowledging(): { acknowledge: NonNullable<ReceiverOptions["acknowledge"]>; acknowledged: Source[] } {
  const acknowledged: Source[] = [];
  return {
    acknowledged,
    acknowledge: async (source) => {
      acknowledged.push(source);
    },
  };
}

function agreementKey(resolution: Resolution): PublicKey {
  const [key] = authorizedKeys(resolution, "keyAgreement").values();
  return key as PublicKey;
}

async function boundRouteOf(holder: Fresh): Promise<RouteId> {
  return (await scanVault(holder.runtime.vault, holder.keys)).routes.dids.get(DID)!.created!.boundRouteId;
}

/** A relationship bound at `DID` with the peer's document as its root, as a receipt binds it. */
async function bindTo(holder: DirectParty, resolution: Resolution): Promise<void> {
  const root = await commitResolution(holder.runtime, { resolution, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: agreementKey(resolution) });
  await holder.runtime.vault.commit([], [vaultDraft("relationship.bound", { relationshipId: relationshipId(holder.did, resolution.did), localDidId: DID, peerResolutionEventId: root.eventId as EventReference<"peer.resolved"> })]);
}

async function eventsOf(runtime: VaultRuntime, type: string): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of runtime.vault.events.scan()) if (event.type === type) events.push(event);
  return events;
}

describe("the gate before the vault", () => {
  it("a delivery to the exact key-agreement method of a DID that may receive opens with that key, its did:web sender resolved for this delivery; the same envelope again is resolved again", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    const { receipt, seen } = recording();
    const trace = await AgentTrace.open(alice.runtime.local);
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch, trace });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);
    const delivery: Delivery = { packed, source: DIRECT };

    expect(await receiver.receive(delivery)).toEqual({ outcome: "received", key: deliveryKey(delivery) });
    const resolution = await webResolution(bob);
    expect(seen.map(({ recipient, sender, plaintext, fromPrior }) => ({ recipient, sender, body: plaintext.body, fromPrior }))).toEqual([
      {
        recipient: { didId: DID, did: alice.did, kid: kidOf(packed), localKeyName: didKeyName(DID, "key-agreement") },
        sender: { resolution, kid: `${BOB}#agree`, peerPublicKey: agreementKey(resolution), signedBy: null },
        body: { content: "hello" },
        fromPrior: null,
      },
    ]);
    expect(web.calls).toEqual([BOB_URL]);

    await receiver.receive(delivery);
    expect(web.calls).toEqual([BOB_URL, BOB_URL]);
    expect(seen).toHaveLength(2);
    expect((await trace.read({ type: "diag.receive" })).map((entry) => entry.data["outcome"])).toEqual(["received", "received"]);
    expect(await trace.read({ type: "envelope.open" })).toHaveLength(2);
    await alice.runtime.close();
  });

  it("an anonymous envelope proves no sender: it reaches the receipt with none, and nothing is resolved", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const web = host({});
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch });

    expect((await receiver.receive({ packed: await sealed(null, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    expect(seen.map(({ sender, recipient }) => [sender, recipient.didId])).toEqual([[null, DID]]);
    expect(web.calls).toEqual([]);
    await alice.runtime.close();
  });

  it("a DID of another vault, a method this DID does not have, an authentication method, an unknown Peer short form and a plaintext are terminal before anything is opened or resolved", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);
    const [, agreement] = splitDidUrl(kidOf(packed));
    const entity = (await scanVault(alice.runtime.vault, alice.keys)).routes.dids.get(DID)!;
    const [, authentication] = splitDidUrl(entity.methodIds.authentication[0]!);

    const refused = async (text: string): Promise<string> => {
      const received = await receiver.receive({ packed: text, source: DIRECT });
      return received.outcome === "terminal" ? received.reason : received.outcome;
    };
    expect(await refused(addressedTo(packed, `${carol.longFormDid}${agreement}`))).toBe(`${carol.longFormDid}${agreement} is no key of this vault`);
    expect(await refused(addressedTo(packed, `${alice.longFormDid}#nowhere`))).toBe(`${alice.longFormDid}#nowhere names no method of ${alice.longFormDid}`);
    expect(await refused(addressedTo(packed, `${alice.longFormDid}${authentication}`))).toBe(`${alice.longFormDid}${authentication} is an authentication method, not a key-agreement one`);
    expect(await refused(addressedTo(packed, `${carol.did}${agreement}`))).toBe(`${carol.did}${agreement} is no key of this vault`);
    expect(await refused(JSON.stringify({ id: "1", typ: PLAIN_TYP, type: BASIC_MESSAGE, body: {} }))).toBe("not an envelope encrypted to its recipients (plain)");
    expect(seen).toEqual([]);
    expect(web.calls).toEqual([]);
    expect(receiver.waiting()).toEqual([]);
    await alice.runtime.close();
  });

  it("a retired DID receives while a relationship's local history retains it and is terminal while nothing does; a DID whose route retired is terminal", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const routeId = await boundRouteOf(alice);
    const { minted: other } = await createDid(alice.runtime, alice.keys, routeId, OTHER);
    const bob = await webIdentity(BOB);
    await bindTo(alice, await webResolution(bob));
    await retireDid(alice.runtime, alice.keys, DID, "rotated");
    await retireDid(alice.runtime, alice.keys, OTHER, "unused");
    const web = host(bob.document);
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch });
    const sealer = await webSealer(bob);

    expect((await receiver.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    const toOther = await sealed(sealer, other.longFormDid);
    expect(await receiver.receive({ packed: toOther, source: DIRECT })).toMatchObject({ outcome: "terminal", reason: `${kidOf(toOther)}: ${other.longFormDid} is retired and in no relationship's history` });

    await alice.runtime.vault.commit([], [vaultDraft("route.retired", { routeId, because: "moved" })]);
    const toRetiredRoute = await sealed(sealer, alice.longFormDid);
    expect(await receiver.receive({ packed: toRetiredRoute, source: DIRECT })).toMatchObject({ outcome: "terminal", reason: `${kidOf(toRetiredRoute)}: its route or mediation is retired or in conflict` });
    expect(seen).toHaveLength(1);
    expect(web.calls).toEqual([BOB_URL]);
    await alice.runtime.close();
  });

  it("a DID whose route is not configured yet holds the delivery without acknowledgement, resolving nothing; once the route arrives it is received from the held bytes and acknowledged", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(await eventsOf(alice.runtime, "did.created"));
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    const { receipt, seen } = recording();
    const { acknowledge, acknowledged } = acknowledging();
    const receiver = await receiverOver(copy, { receipt, fetch: web.fetch, acknowledge });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);

    expect(await receiver.receive({ packed, source: PICKUP })).toMatchObject({ outcome: "deferred", wait: "local", reason: `${kidOf(packed)}: the bound route is not configured` });
    expect(receiver.waiting()).toEqual([expect.objectContaining({ wait: "local", attempts: 0, held: true })]);
    expect(await receiver.localStateChanged()).toMatchObject([{ outcome: "deferred", wait: "local" }]);
    expect([web.calls, seen, acknowledged]).toEqual([[], [], []]);

    await copy.runtime.ingest(await eventsOf(alice.runtime, "route.configured"));
    expect(await receiver.localStateChanged()).toMatchObject([{ outcome: "received" }]);
    expect(seen).toHaveLength(1);
    expect(acknowledged).toEqual([PICKUP]);
    expect(receiver.waiting()).toEqual([]);
    await alice.runtime.close();
    await copy.runtime.close();
  });
});

describe("the sender's resolution", () => {
  it("a sender that does not resolve now holds the delivery: a redelivery before the next call calls nothing, the calls come on time from the held bytes, and running out of calls is terminal and acknowledged", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    web.state.plan.push(503, 503, 503);
    const time = clock();
    const timers = handTimers();
    const { receipt, seen } = recording();
    const { acknowledge, acknowledged } = acknowledging();
    // a deadline already passed caps nothing: the budget ends the sequence
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch, now: time.now, timers, policy: { attempts: 3 }, retention: () => ({ deadline: START - 1 }), acknowledge });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);

    expect(await receiver.receive({ packed, source: PICKUP })).toMatchObject({ outcome: "deferred", wait: "resolution", reason: `${BOB} is not resolved now: HTTP 503` });
    expect(timers.waits.map((wait) => wait.ms)).toEqual([30_000]);

    time.advance(10_000);
    expect(await receiver.receive({ packed, source: PICKUP })).toMatchObject({ outcome: "deferred", wait: "resolution" });
    expect(web.calls).toHaveLength(1);
    expect(receiver.waiting()).toEqual([expect.objectContaining({ attempts: 1, retryAt: START + 30_000, held: true })]);

    time.advance(20_000);
    timers.waits.at(-1)!.fire();
    await vi.waitFor(() => expect(web.calls).toHaveLength(2));
    await vi.waitFor(() => expect(timers.waits.at(-1)!.ms).toBe(60_000));
    time.advance(60_000);
    timers.waits.at(-1)!.fire();
    await vi.waitFor(() => expect(acknowledged).toEqual([PICKUP]));
    expect(web.calls).toHaveLength(3);
    expect(seen).toEqual([]);
    expect(receiver.waiting()).toEqual([]);
    await alice.runtime.close();
  });

  it("only active time counts toward the retention stop: a wait for the vault in between counts nothing, and the stop is terminal when it comes", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    web.state.plan.push(503, 503);
    const time = clock();
    const timers = handTimers();
    const { receipt, seen } = recording();
    const { acknowledge, acknowledged } = acknowledging();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch, now: time.now, timers, retention: () => ({ durationMs: 45_000 }), acknowledge });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);

    expect((await receiver.receive({ packed, source: PICKUP })).outcome).toBe("deferred");
    expect(timers.waits.at(-1)!.ms).toBe(30_000);

    time.advance(10_000);
    vi.spyOn(alice.runtime.vault.events, "scan").mockImplementationOnce(() => {
      throw new Error("the vault is locked");
    });
    expect(await receiver.receive({ packed, source: PICKUP })).toMatchObject({ outcome: "deferred", wait: "local", reason: "the vault is not read: the vault is locked" });
    expect(timers.waits.at(-1)!.cleared).toBe(true);

    time.advance(600_000);
    expect(await receiver.localStateChanged()).toMatchObject([{ outcome: "deferred", wait: "resolution" }]);
    expect(web.calls).toHaveLength(2);
    // ten seconds of the forty-five were spent before the wait for the vault
    expect(timers.waits.at(-1)!.ms).toBe(35_000);

    time.advance(35_000);
    timers.waits.at(-1)!.fire();
    await vi.waitFor(() => expect(acknowledged).toEqual([PICKUP]));
    expect(web.calls).toHaveLength(2);
    expect(seen).toEqual([]);
    await alice.runtime.close();
  });

  it("a sender that resolves definitively, not found or a name with no address, is terminal at once; so is a current document that no longer authorizes the key the envelope was sealed with, whatever was pinned before", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    await bindTo(alice, await webResolution(bob));
    const web = host(bob.document);
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch });
    const sealer = await webSealer(bob);

    web.state.plan.push(404, Object.assign(new Error("no such name"), { code: DEFINITIVE_TRANSPORT_CODES.noAddress }));
    expect(await receiver.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).toMatchObject({ outcome: "terminal", reason: `${BOB} does not resolve: HTTP 404: not found or deactivated` });
    expect(await receiver.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).toMatchObject({ outcome: "terminal", reason: expect.stringContaining(`${BOB} does not resolve: `) });

    const replaced = (await webIdentity(BOB, 78)).document;
    web.state.document = JSON.parse(JSON.stringify(replaced).replaceAll(`${BOB}#agree`, `${BOB}#agree-2`)) as JsonObject;
    expect(await receiver.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).toMatchObject({ outcome: "terminal", reason: expect.stringMatching(/^the envelope does not open: .*Sender kid not found/) });
    expect(seen).toEqual([]);
    expect(web.calls).toHaveLength(3);
    expect(receiver.waiting()).toEqual([]);
    await alice.runtime.close();
  });

  it("one envelope posted twice, however its JSON is spaced, is one delivery: the second post before the call is due calls nothing", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    web.state.plan.push(503);
    const { receipt } = recording();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch, now: clock().now, timers: handTimers() });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);
    const respaced = JSON.stringify(JSON.parse(packed), null, 2);

    expect(deliveryKey({ packed: respaced, source: DIRECT })).toBe(deliveryKey({ packed, source: DIRECT }));
    expect((await receiver.receive({ packed, source: DIRECT })).outcome).toBe("deferred");
    expect((await receiver.receive({ packed: respaced, source: DIRECT })).outcome).toBe("deferred");
    expect(web.calls).toHaveLength(1);
    expect(receiver.waiting()).toEqual([expect.objectContaining({ attempts: 1 })]);
    await alice.runtime.close();
  });
});

describe("waits for evidence", () => {
  it("a delivery waiting for relationship evidence is not opened or resolved again when redelivered or when unrelated evidence changes; evidence changing at its pair retries it with a fresh resolution, and it is received and acknowledged", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    const time = clock();
    const timers = handTimers();
    let answer: ReceiptOutcome = { outcome: "wait", reason: "the pair's membership is pending" };
    const { receipt, seen } = recording(() => answer);
    const { acknowledge, acknowledged } = acknowledging();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch, now: time.now, timers, acknowledge });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);

    expect(await receiver.receive({ packed, source: PICKUP })).toMatchObject({ outcome: "deferred", wait: "relationship", reason: "the pair's membership is pending" });
    for (let redelivery = 0; redelivery < 40; redelivery++) expect((await receiver.receive({ packed, source: PICKUP })).outcome).toBe("deferred");
    await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), OTHER);
    expect(await receiver.evidenceChanged()).toEqual([]);
    expect([web.calls.length, seen.length, acknowledged.length]).toEqual([1, 1, 0]);

    answer = { outcome: "received" };
    web.state.plan.push(503);
    await bindTo(alice, await webResolution(bob));
    expect(await receiver.evidenceChanged()).toMatchObject([{ outcome: "deferred", wait: "resolution" }]);
    expect(receiver.waiting()).toEqual([expect.objectContaining({ attempts: 1 })]);

    time.advance(30_000);
    timers.waits.at(-1)!.fire();
    await vi.waitFor(() => expect(acknowledged).toEqual([PICKUP]));
    expect([web.calls.length, seen.length]).toEqual([3, 2]);
    await alice.runtime.close();
  });

  it("an envelope whose from_prior issuer no evidence holds is held and not opened again when redelivered; once evidence of the issuer arrives it is retried and received", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const carol = await directParty(3, CAROL_ENDPOINT, DID);
    const { minted: first } = await createDid(carol.runtime, carol.keys, await boundRouteOf(carol), OTHER);
    const issuer = await peerResolutionOf(first.longFormDid);
    const sealer = await peerSealer(carol);
    const resolver: DIDResolver = { resolve: async (did) => (did === first.did ? didcommDocumentOf(issuer, first.did) : resolveDIDCommDoc(did)) };
    const [jwt] = await packFromPrior(didcomm, { iss: first.did, sub: carol.longFormDid, iat: 1_757_700_000 }, null, resolver, secretsResolverFor(sealer.secrets));
    const packed = await sealed({ ...sealer, resolver }, alice.longFormDid, { from_prior: jwt });
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt });

    expect(await receiver.receive({ packed, source: DIRECT })).toMatchObject({ outcome: "deferred", wait: "history", reason: `the envelope names ${first.did}, whose document no evidence holds` });
    expect((await receiver.receive({ packed, source: DIRECT })).outcome).toBe("deferred");
    expect(await receiver.evidenceChanged()).toEqual([]);
    expect(seen).toEqual([]);

    await commitResolution(alice.runtime, { resolution: issuer, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: agreementKey(issuer) });
    expect(await receiver.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    expect(seen.map(({ sender, fromPrior }) => [sender?.resolution.presentedDid, fromPrior === null ? null : { iss: fromPrior.iss, sub: fromPrior.sub }])).toEqual([[carol.longFormDid, { iss: first.did, sub: carol.longFormDid }]]);
    await alice.runtime.close();
    await carol.runtime.close();
  });
});

describe("the gate over pickup", () => {
  it("a delivery for no key of this vault and one received are acknowledged in the same round; one whose sender does not resolve now stays queued until its call comes due, then it is received and acknowledged", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await establish(p.link, p.runtime, p.keys, p.mediationId);
    const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
    const { minted } = await createDid(p.runtime, p.keys, routeId, DID);
    await reloaded(p);
    await reconcile(p.link, p.runtime, p.keys, p.mediationId);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    web.state.plan.push("ok", 503);
    const time = clock();
    const timers = handTimers();
    const { receipt, seen } = recording();
    let pickup: Pickup | null = null;
    const receiver = new Receiver(p.runtime, p.keys, p.ring, { didcomm, receipt, fetch: web.fetch, now: time.now, timers, acknowledge: (source) => pickup!.acknowledge([source.deliveryId]) });
    pickup = new Pickup(p.link, receiver.pickupHandle(p.mediationId));
    const sealer = await webSealer(bob);
    const packed = await sealed(sealer, minted.longFormDid);
    const account = p.created.data.me.did;
    mediator.queues.set(account, [
      { id: "q1", packed: addressedTo(packed, `${BOB}#agree`) },
      { id: "q2", packed },
      { id: "q3", packed: await sealed(sealer, minted.longFormDid) },
    ]);

    expect(await pickup.drain()).toEqual({ acked: 2, ended: "left" });
    expect(mediator.queues.get(account)?.map((item) => item.id)).toEqual(["q3"]);
    expect([web.calls.length, seen.length]).toEqual([2, 1]);

    time.advance(30_000);
    timers.waits.at(-1)!.fire();
    await vi.waitFor(() => expect(mediator.queues.get(account)).toEqual([]));
    expect([web.calls.length, seen.length]).toEqual([3, 2]);
    await p.runtime.close();
  });
});
