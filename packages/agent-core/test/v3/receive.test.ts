import { describe, expect, it, vi } from "vitest";

import { resolveDIDCommDoc, type Secret } from "@estoc/did-peer";
import type { JsonObject, VaultRuntime } from "@estoc/event-store/v3";
import { didKeyName, relationshipId, scanVault, splitDidUrl, vaultDraft, type Did, type DidId, type EventReference, type MediationId, type PublicKey, type RouteId } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { PLAIN_TYP, packEncrypted, packFromPrior, secretsResolverFor, type DIDResolver, type IMessage } from "../../src/protocol/didcomm.js";
import { MESSAGES_RECEIVED } from "../../src/protocol/mediation.js";
import {
  AgentTrace,
  DEFINITIVE_TRANSPORT_CODES,
  Keyring,
  Pickup,
  Receiver,
  ReceiverClosed,
  ReceiverInUse,
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
import { didcomm, directParty, freshVault, handTimers, json, newMediator, party, reloaded, webIdentity, type DirectParty, type Fresh, type Party, type WebIdentity } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const OTHER = "019b0000-0000-7000-8000-00000000000c" as DidId;
const MEDIATION = "019b0000-0000-7000-8000-000000000201" as MediationId;
const ALICE_ENDPOINT = "https://alice.example/didcomm";
const CAROL_ENDPOINT = "https://carol.example/didcomm";
const BOB = "did:web:bob.example";
const BOB_URL = "https://bob.example/.well-known/did.json";
const PRIOR = "did:web:prior.example";
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

/** `sealer` able to seal against `prior`'s document, and the `from_prior` that `prior` signs over it. */
async function rotatedFrom(prior: WebIdentity, sealer: Sealer): Promise<{ sealer: Sealer; fromPrior: string }> {
  const document = didcommDocumentOf(await webResolution(prior));
  const resolver: DIDResolver = { resolve: async (did) => (did === prior.did ? document : sealer.resolver.resolve(did)) };
  const [fromPrior] = await packFromPrior(didcomm, { iss: prior.did, sub: sealer.did, iat: 1_757_700_000 }, null, resolver, secretsResolverFor(prior.secrets));
  return { sealer: { ...sealer, resolver }, fromPrior };
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

/** A relationship bound at `local` with the peer's document as its root, as a receipt binds it. */
async function bindTo(holder: DirectParty, resolution: Resolution, local: { didId: DidId; did: Did } = holder): Promise<void> {
  const root = await commitResolution(holder.runtime, { resolution, localKeyName: didKeyName(local.didId, "key-agreement"), peerPublicKey: agreementKey(resolution) });
  await holder.runtime.vault.commit([], [vaultDraft("relationship.bound", { relationshipId: relationshipId(local.did, resolution.did), localDidId: local.didId, peerResolutionEventId: root.eventId as EventReference<"peer.resolved"> })]);
}

async function eventsOf(runtime: VaultRuntime, ...types: string[]): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of runtime.vault.events.scan()) if (types.includes(event.type)) events.push(event);
  return events;
}

/** A party whose DID `DID` is registered with a fake mediator, and the account the mediator queues its mail under. */
async function mediated(): Promise<{ mediator: Awaited<ReturnType<typeof newMediator>>; p: Party; longFormDid: string; account: string }> {
  const mediator = await newMediator();
  const p = await party(mediator);
  await establish(p.link, p.runtime, p.keys, p.mediationId);
  const routeId = await ensureRoute(p.runtime, p.keys, p.mediationId);
  const { minted } = await createDid(p.runtime, p.keys, routeId, DID);
  await reloaded(p);
  await reconcile(p.link, p.runtime, p.keys, p.mediationId);
  return { mediator, p, longFormDid: minted.longFormDid, account: p.created.data.me.did };
}

describe("the gate before the vault", () => {
  it("a delivery to the exact key-agreement method of a DID that may receive opens with that key, its did:web sender resolved for this delivery: another envelope is resolved again, the same one again is only told again", async () => {
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

    await receiver.receive({ ...delivery, packed: await sealed(await webSealer(bob), alice.longFormDid) });
    expect(await receiver.receive(delivery)).toEqual({ outcome: "received", key: deliveryKey(delivery) });
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

describe("the receiver's lifecycle", () => {
  it("a runtime receives through one receiver: a second is refused while it is open; two handles taking the same attachment at once make one call and share its wait, and while it waits for relationship evidence a redelivery through either opens nothing", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    web.state.plan.push(503);
    const time = clock();
    const timers = handTimers();
    const { receipt, seen } = recording(() => ({ outcome: "wait", reason: "the pair's membership is pending" }));
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch, now: time.now, timers });
    await expect(receiverOver(alice, { receipt })).rejects.toThrow(ReceiverInUse);
    const [socket, drain] = [receiver.pickupHandle(MEDIATION), receiver.pickupHandle(MEDIATION)];
    const delivered = { attachmentId: PICKUP.deliveryId, packed: await sealed(await webSealer(bob), alice.longFormDid) };

    expect(await Promise.all([socket(delivered), drain(delivered)])).toEqual(["skip", "skip"]);
    expect(web.calls).toHaveLength(1);
    expect(receiver.waiting()).toEqual([expect.objectContaining({ wait: "resolution", attempts: 1 })]);

    time.advance(30_000);
    timers.waits.at(-1)!.fire();
    await vi.waitFor(() => expect(receiver.waiting()).toEqual([expect.objectContaining({ wait: "relationship" })]));
    expect(await Promise.all([socket(delivered), drain(delivered)])).toEqual(["skip", "skip"]);
    expect([web.calls.length, seen.length]).toEqual([2, 1]);

    receiver.close();
    (await receiverOver(alice, { receipt })).close();
    await alice.runtime.close();
  });

  it("after close nothing is opened or handed to the receipt, not even a delivery already waiting its turn: each is refused, a pickup handle refuses too, and what was held is let go", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    let calls = 0;
    let serve!: () => void;
    const served = new Promise<void>((resolve) => {
      serve = resolve;
    });
    const fetch: typeof globalThis.fetch = async () => (++calls === 1 ? new Response("not now", { status: 503 }) : served.then(() => json(bob.document)));
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt, fetch, now: clock().now, timers: handTimers() });
    const sealer = await webSealer(bob);
    expect((await receiver.receive({ packed: await sealed(sealer, alice.longFormDid), source: PICKUP })).outcome).toBe("deferred");
    const packed = await sealed(sealer, alice.longFormDid);

    const outcomes = Promise.allSettled([receiver.receive({ packed, source: DIRECT }), receiver.receive({ packed, source: DIRECT })]);
    await vi.waitFor(() => expect(calls).toBe(2));
    receiver.close();
    serve();
    expect((await outcomes).map((outcome) => (outcome.status === "rejected" ? outcome.reason : outcome.value))).toEqual([new ReceiverClosed(), new ReceiverClosed()]);
    await expect(receiver.pickupHandle(MEDIATION)({ attachmentId: "d2", packed })).rejects.toThrow(ReceiverClosed);
    await expect(receiver.receive({ packed, source: DIRECT })).rejects.toThrow(ReceiverClosed);
    expect([seen, receiver.waiting(), calls]).toEqual([[], [], 2]);
    await alice.runtime.close();
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

  it("the retention stop bounds the call in progress: a call still waiting at the stop is cut, and a document that arrives after the stop is not taken", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const packed = await sealed(await webSealer(bob), alice.longFormDid);
    const { receipt, seen } = recording();

    const cutTime = clock();
    let signal: AbortSignal | undefined;
    const cutting = await receiverOver(alice, {
      receipt,
      now: cutTime.now,
      timers: handTimers(),
      retention: () => ({ durationMs: 30 }),
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => {
            cutTime.advance(30);
            reject(signal?.reason);
          });
        }),
    });
    expect(await cutting.receive({ packed, source: DIRECT })).toMatchObject({ outcome: "terminal", reason: expect.stringContaining("no definitive answer within the 30 ms the mediator keeps the delivery") });
    expect(signal?.aborted).toBe(true);
    cutting.close();

    const lateTime = clock();
    const late = await receiverOver(alice, {
      receipt,
      now: lateTime.now,
      timers: handTimers(),
      retention: () => ({ durationMs: 1_000 }),
      fetch: async () => {
        lateTime.advance(5_000);
        return json(bob.document);
      },
    });
    expect(await late.receive({ packed, source: DIRECT })).toMatchObject({ outcome: "terminal", reason: expect.stringContaining("resolved only after the retention stop") });
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

  it("an envelope posted again after its sender ran out of calls is told terminal again, with no call", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    web.state.plan.push(503);
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch, policy: { attempts: 1 }, timers: handTimers() });
    const packed = await sealed(await webSealer(bob), alice.longFormDid);

    const terminal = await receiver.receive({ packed, source: DIRECT });
    expect(terminal).toMatchObject({ outcome: "terminal", reason: expect.stringContaining("no definitive answer after 1 resolutions") });
    expect(await receiver.receive({ packed, source: DIRECT })).toEqual(terminal);
    expect([web.calls.length, seen.length]).toEqual([1, 0]);
    await alice.runtime.close();
  });

  it("the bytes of a delivery waiting for its sender's next resolution are held before any other's: one waiting for evidence gives its bytes up, one that still does not fit is terminal at once, and the held one is retried on time", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    web.state.plan.push("ok", 503, 503);
    const time = clock();
    const timers = handTimers();
    let receipts = 0;
    const { receipt } = recording(() => (++receipts === 1 ? { outcome: "wait", reason: "the pair's membership is pending" } : { outcome: "received" }));
    const { acknowledge, acknowledged } = acknowledging();
    const sealer = await webSealer(bob);
    const letters = [await sealed(sealer, alice.longFormDid), await sealed(sealer, alice.longFormDid), await sealed(sealer, alice.longFormDid)];
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch, now: time.now, timers, acknowledge, maxHeldBytes: Math.max(...letters.map((letter) => letter.length)) });
    const at = (n: number): Source => ({ kind: "pickup", mediationId: MEDIATION, deliveryId: `d${n}` });

    expect(await receiver.receive({ packed: letters[0]!, source: at(1) })).toMatchObject({ outcome: "deferred", wait: "relationship" });
    expect(await receiver.receive({ packed: letters[1]!, source: at(2) })).toMatchObject({ outcome: "deferred", wait: "resolution" });
    expect(receiver.waiting().map(({ source, held }) => [source, held])).toEqual([
      [at(1), false],
      [at(2), true],
    ]);
    expect(await receiver.receive({ packed: letters[2]!, source: at(3) })).toMatchObject({ outcome: "terminal", reason: expect.stringContaining("no room to hold its") });

    time.advance(30_000);
    timers.waits.find((wait) => !wait.cleared)!.fire();
    await vi.waitFor(() => expect(acknowledged).toEqual([at(2)]));
    expect([web.calls.length, receipts]).toEqual([4, 2]);
    expect(receiver.waiting().map(({ source }) => source)).toEqual([at(1)]);
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

  it("a Web from_prior issuer is verified against the snapshot pinned by the relationship at the receiving address, and no other's: received where its document is pinned, not opened where another document of it is; pinned without its document, it waits until the document is back", async () => {
    const alice = await directParty(1, ALICE_ENDPOINT, DID);
    const { minted: other } = await createDid(alice.runtime, alice.keys, await boundRouteOf(alice), OTHER);
    const prior = await webIdentity(PRIOR, 78);
    const priorResolution = await webResolution(prior);
    await bindTo(alice, priorResolution);
    await bindTo(alice, await webResolution(await webIdentity(PRIOR, 79)), { didId: OTHER, did: other.did });
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    const { sealer, fromPrior } = await rotatedFrom(prior, await webSealer(bob));
    const carrier = await sealed(sealer, alice.longFormDid, { from_prior: fromPrior });
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt, fetch: web.fetch });

    expect((await receiver.receive({ packed: carrier, source: DIRECT })).outcome).toBe("received");
    expect(seen.map(({ recipient, fromPrior }) => [recipient.didId, fromPrior?.iss])).toEqual([[DID, PRIOR]]);
    expect(await receiver.receive({ packed: await sealed(sealer, other.longFormDid, { from_prior: fromPrior }), source: DIRECT })).toMatchObject({ outcome: "terminal", reason: expect.stringMatching(/^the envelope does not open: /) });
    expect(seen).toHaveLength(1);
    receiver.close();

    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(await eventsOf(alice.runtime, "did.created", "route.configured", "peer.resolved", "relationship.bound"));
    const copied = await receiverOver(copy, { receipt, fetch: web.fetch });
    expect(await copied.receive({ packed: carrier, source: DIRECT })).toMatchObject({ outcome: "deferred", wait: "history", reason: `the envelope names ${PRIOR}, whose document no evidence holds` });
    expect(await copied.evidenceChanged()).toEqual([]);

    await commitResolution(copy.runtime, { resolution: priorResolution, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: agreementKey(priorResolution) });
    expect(await copied.evidenceChanged()).toMatchObject([{ outcome: "received" }]);
    expect(seen).toHaveLength(2);
    await alice.runtime.close();
    await copy.runtime.close();
  });
});

describe("the gate over pickup", () => {
  it("a delivery for no key of this vault and one received are acknowledged in the same round; one whose sender does not resolve now stays queued until its call comes due, then it is received and acknowledged", async () => {
    const { mediator, p, longFormDid, account } = await mediated();
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
    const packed = await sealed(sealer, longFormDid);
    mediator.queues.set(account, [
      { id: "q1", packed: addressedTo(packed, `${BOB}#agree`) },
      { id: "q2", packed },
      { id: "q3", packed: await sealed(sealer, longFormDid) },
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

  it("a delivery that ended is only told again when it comes again before the mediator was told: a lost acknowledgement costs no second resolution or receipt, and once the mediator is told it is forgotten", async () => {
    const { mediator, p, longFormDid, account } = await mediated();
    const bob = await webIdentity(BOB);
    const web = host(bob.document);
    web.state.plan.push(503);
    const { receipt, seen } = recording();
    const receiver = new Receiver(p.runtime, p.keys, p.ring, { didcomm, receipt, fetch: web.fetch, policy: { attempts: 1 }, timers: handTimers() });
    const pickup = new Pickup(p.link, receiver.pickupHandle(p.mediationId));
    const packed = await sealed(await webSealer(bob), longFormDid);
    const roundTrip = p.link.roundTrip.bind(p.link);
    let cut = true;
    vi.spyOn(p.link, "roundTrip").mockImplementation(async (...args: Parameters<typeof roundTrip>) => {
      if (cut && args[0] === MESSAGES_RECEIVED) {
        cut = false;
        throw new Error("the line dropped");
      }
      return roundTrip(...args);
    });
    mediator.queues.set(account, [{ id: "q1", packed }]);

    expect(await pickup.drain()).toEqual({ acked: 0, ended: "left" });
    expect(mediator.queues.get(account)).toHaveLength(1);
    expect(await pickup.drain()).toEqual({ acked: 1, ended: "empty" });
    expect([web.calls.length, seen.length, mediator.queues.get(account)]).toEqual([1, 0, []]);

    mediator.queues.set(account, [{ id: "q1", packed }]);
    expect(await pickup.drain()).toEqual({ acked: 1, ended: "empty" });
    expect([web.calls.length, seen.length]).toEqual([2, 1]);
    await p.runtime.close();
  });
});
