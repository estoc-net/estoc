import { describe, expect, it, vi } from "vitest";

import { encodeLongForm, longToShort, resolveDIDCommDoc, toDIDCommDIDDoc, type DIDDoc } from "@estoc/did-peer";
import type { JsonObject, VaultRuntime } from "@estoc/event-store/v3";
import { didKeyName, inputDocumentOf, scanVault, signFromPrior, splitDidUrl, vaultDraft, type Did, type DidId, type EventReference, type MediationId, type PublicKey, type RouteId } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { PLAIN_TYP, type IMessage, type Unpacked } from "../../src/protocol/didcomm.js";
import { MESSAGES_RECEIVED } from "../../src/protocol/mediation.js";
import {
  AgentTrace,
  Keyring,
  Pickup,
  Receiver,
  ReceiverClosed,
  ReceiverInUse,
  authorizedKeys,
  classifyRecipients,
  commitResolution,
  configureRoute,
  createDid,
  deliveryKey,
  disclose,
  ensureRoute,
  establish,
  reconcile,
  resolve,
  retireDid,
  senderProof,
  type Authenticated,
  type Delivery,
  type ReceiptOutcome,
  type ReceiverOptions,
  type Resolution,
  type Source,
} from "../../src/v3/index.js";
import { didcomm, directParty, freshVault, kidOf, newMediator, party, peerSealer, reloaded, sealed, webIdentity, type DirectParty, type Fresh, type Party, type Sealer } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const QUERIED = "019b0000-0000-7000-8000-0000000000d0" as DidId;
const OTHER = "019b0000-0000-7000-8000-0000000000e0" as DidId;
const MEDIATION = "019b0000-0000-7000-8000-000000000201" as MediationId;
const ALICE_ENDPOINT = "https://alice.example/didcomm";
const BOB_ENDPOINT = "https://bob.example/didcomm";
const CAROL_ENDPOINT = "https://carol.example/didcomm";
const OTHER_ENDPOINT = "https://other.example/didcomm";
const WEB_BOB = "did:web:bob.example";

const PICKUP: Source = { kind: "pickup", mediationId: MEDIATION, deliveryId: "d1" };
const pickup = (deliveryId: string): Source => ({ kind: "pickup", mediationId: MEDIATION, deliveryId });
const DIRECT: Source = { kind: "direct" };
/** what a receipt standing in for the vault's says it recorded */
const RECORDED = "019b0000-0000-7000-8000-0000000000ff" as EventReference<"message.in">;

/** A `did:web` party sealing against its own document and the peers' long forms. */
async function webSealer(did: string): Promise<Sealer> {
  const identity = await webIdentity(did);
  const document = toDIDCommDIDDoc(identity.document) as DIDDoc;
  return { did, secrets: identity.secrets, resolver: { resolve: async (asked) => (asked === did ? document : resolveDIDCommDoc(asked)) } };
}

/** The envelope with every recipient's key ID replaced by `kid`: what arrives addressed elsewhere. */
function addressedTo(packed: string, kid: string): string {
  const envelope = JSON.parse(packed) as { recipients: { header: { kid: string } }[] };
  return JSON.stringify({ ...envelope, recipients: envelope.recipients.map((recipient) => ({ ...recipient, header: { ...recipient.header, kid } })) });
}

function recording(answer: () => ReceiptOutcome = () => ({ outcome: "received", eventId: RECORDED })): { receipt: ReceiverOptions["receipt"]; seen: Authenticated[] } {
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

function acknowledging(): { acknowledge: NonNullable<ReceiverOptions["acknowledge"]>; acknowledged: Source[] } {
  const acknowledged: Source[] = [];
  return {
    acknowledged,
    acknowledge: async (source) => {
      acknowledged.push(source);
    },
  };
}

async function peerResolutionOf(did: string): Promise<Resolution> {
  const outcome = await resolve(did, () => null);
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  return outcome.resolution;
}

function agreementKey(resolution: Resolution): PublicKey {
  const [key] = authorizedKeys(resolution, "keyAgreement").values();
  return key as PublicKey;
}

async function eventsOf(runtime: VaultRuntime, ...types: string[]): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of runtime.vault.events.scan()) if (types.includes(event.type)) events.push(event);
  return events;
}

const terminalReason = (received: { outcome: string; reason?: string }): string => (received.outcome === "terminal" ? (received.reason as string) : received.outcome);

const boundRouteOf = async (p: DirectParty): Promise<RouteId> => (await scanVault(p.runtime.vault, p.keys)).routes.dids.get(p.didId)!.created!.boundRouteId;

/** A copy of `p`'s vault holding only the events named: what a replica restored to before the rest arrived has. */
async function copyOf(p: DirectParty, ...types: string[]): Promise<Fresh> {
  const copy = await freshVault(1, "copy");
  await copy.runtime.ingest(await eventsOf(p.runtime, ...types));
  return copy;
}

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty }> {
  return { alice: await directParty(1, ALICE_ENDPOINT, DID), bob: await directParty(2, BOB_ENDPOINT, BOB) };
}

async function closeAll(...parties: Fresh[]): Promise<void> {
  for (const p of parties) await p.runtime.close();
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
  it("a delivery to the exact key-agreement method of a DID that may receive opens with that key, its peer sender read from its long form and nothing else; the same delivery again is only told again, and a rotation proof rides through unverified", async () => {
    const { alice, bob } = await parties();
    const { receipt, seen } = recording();
    const trace = await AgentTrace.open(alice.runtime.local);
    const receiver = await receiverOver(alice, { receipt, trace });
    const sealer = await peerSealer(bob);
    const packed = await sealed(sealer, alice.longFormDid);
    const delivery: Delivery = { packed, source: DIRECT };

    expect(await receiver.receive(delivery)).toEqual({ outcome: "received", key: deliveryKey(delivery), eventId: RECORDED });
    const resolution = await peerResolutionOf(bob.longFormDid);
    expect(seen.map(({ recipient, sender, plaintext, fromPrior }) => ({ recipient, sender, body: plaintext.body, fromPrior }))).toEqual([
      {
        recipient: { didId: DID, did: alice.did, kid: kidOf(packed), localKeyName: didKeyName(DID, "key-agreement") },
        sender: { resolution, kid: `${bob.longFormDid}#key-2`, peerPublicKey: agreementKey(resolution) },
        body: { content: "hello" },
        fromPrior: null,
      },
    ]);

    expect(await receiver.receive(delivery)).toEqual({ outcome: "received", key: deliveryKey(delivery), eventId: RECORDED });
    expect(seen).toHaveLength(1);
    expect(await trace.read({ type: "envelope.open" })).toHaveLength(1);

    const routeId = (await scanVault(bob.runtime.vault, bob.keys)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, 1_757_700_000);
    const withProof = await sealed(await peerSealer(bob), alice.longFormDid, { from_prior: proof });
    expect((await receiver.receive({ packed: withProof, source: DIRECT })).outcome).toBe("received");
    expect(seen[1]?.fromPrior).toBe(proof);
    expect((await trace.read({ type: "diag.receive" })).map((entry) => entry.data["outcome"])).toEqual(["received", "received"]);
    expect(receiver.discarded()).toEqual([]);
    await closeAll(alice, bob);
  });

  it("an anonymous envelope proves no sender and reaches the receipt with none; one whose plaintext still claims a sender is terminal, since nothing authenticates the claim", async () => {
    const { alice, bob } = await parties();
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt });

    expect((await receiver.receive({ packed: await sealed(null, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    expect(seen.map(({ sender, recipient }) => [sender, recipient.didId])).toEqual([[null, DID]]);

    const claiming = await sealed(null, alice.longFormDid, { from: bob.longFormDid });
    expect(await receiver.receive({ packed: claiming, source: DIRECT })).toMatchObject({ outcome: "terminal", reason: `the envelope is anonymous, but its plaintext claims to be from ${bob.longFormDid}` });
    expect(seen).toHaveLength(1);
    await closeAll(alice, bob);
  });

  it("a DID of another vault, a method this DID does not have, an authentication method and a plaintext are terminal before anything is opened; an envelope naming no key of ours says so without claiming why", async () => {
    const { alice, bob } = await parties();
    const carol = await directParty(3, CAROL_ENDPOINT, CAROL);
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt });
    const packed = await sealed(await peerSealer(bob), alice.longFormDid);
    const [, agreement] = splitDidUrl(kidOf(packed));
    const entity = (await scanVault(alice.runtime.vault, alice.keys)).routes.dids.get(DID)!;
    const [, authentication] = splitDidUrl(entity.methodIds.authentication[0]!);
    const refused = async (text: string): Promise<string> => terminalReason(await receiver.receive({ packed: text, source: DIRECT }));

    expect(await refused(addressedTo(packed, `${carol.longFormDid}${agreement}`))).toBe(`local recipient material is unavailable for ${carol.longFormDid}${agreement}; the delivery was discarded`);
    expect(await refused(addressedTo(packed, `${carol.did}${agreement}`))).toBe(`local recipient material is unavailable for ${carol.did}${agreement}; the delivery was discarded`);
    expect(await refused(addressedTo(packed, `${alice.longFormDid}#nowhere`))).toBe(`${alice.longFormDid}#nowhere names no method of ${alice.longFormDid}`);
    expect(await refused(addressedTo(packed, `${alice.longFormDid}${authentication}`))).toBe(`${alice.longFormDid}${authentication} is an authentication method, not a key-agreement one`);
    expect(await refused(JSON.stringify({ id: "1", typ: PLAIN_TYP, type: BASIC_MESSAGE, body: {} }))).toBe("not an envelope encrypted to its recipients (plain)");
    expect(await refused("not json at all")).toBe("the envelope is not strict JSON");
    expect(seen).toEqual([]);
    expect(receiver.waiting()).toEqual([]);
    expect(receiver.discarded().map(({ source, reason }) => [source.kind, reason.split(" ").slice(0, 3).join(" ")])).toEqual([
      ["direct", "local recipient material"],
      ["direct", "local recipient material"],
      ["direct", `${alice.longFormDid}#nowhere names no`],
      ["direct", `${alice.longFormDid}${authentication} is an`],
      ["direct", "not an envelope"],
      ["direct", "the envelope is"],
    ]);
    await closeAll(alice, bob, carol);
  });

  it("a sender that is not a numalgo-4 peer is terminal without any network; a short form whose long form is not in evidence is terminal and told as material unavailable, not as anyone; once the long form is in evidence the short form authenticates", async () => {
    const { alice, bob } = await parties();
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt });

    const fromWeb = await sealed(await webSealer(WEB_BOB), alice.longFormDid);
    expect(terminalReason(await receiver.receive({ packed: fromWeb, source: DIRECT }))).toBe(`the sender ${WEB_BOB} is not a did:peer:4, the one method a channel endpoint may use`);

    const shortly = await peerSealer(bob, bob.did);
    const fromShort = await sealed(shortly, alice.longFormDid);
    expect(terminalReason(await receiver.receive({ packed: fromShort, source: DIRECT }))).toBe(`sender material is unavailable for ${bob.did}; the delivery was discarded`);
    expect(seen).toEqual([]);

    const resolution = await peerResolutionOf(bob.longFormDid);
    await commitResolution(alice.runtime, { resolution, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: agreementKey(resolution) });
    const again = await sealed(shortly, alice.longFormDid);
    expect((await receiver.receive({ packed: again, source: DIRECT })).outcome).toBe("received");
    expect(seen.map(({ sender }) => [sender?.resolution.presentedDid, sender?.resolution.did, sender?.kid])).toEqual([[bob.did, bob.did, `${bob.did}#key-2`]]);
    await closeAll(alice, bob);
  });

  it("a retired DID still receives while its route stands and is terminal once the route retired; a sender that is the recipient itself is terminal; the host's limits refuse a delivery before the receipt sees it", async () => {
    const { alice, bob } = await parties();
    const routeId = (await scanVault(alice.runtime.vault, alice.keys)).routes.dids.get(DID)!.created!.boundRouteId;
    await retireDid(alice.runtime, alice.keys, DID, "rotated");
    const { receipt, seen } = recording();
    const refusals: string[] = [];
    const receiver = await receiverOver(alice, {
      receipt,
      admit: ({ sender, recipient, bytes }) => {
        refusals.push(`${sender ?? "anonymous"} -> ${recipient} (${bytes} bytes)`);
        return refusals.length === 1 ? null : "the host takes no more from this sender today";
      },
    });
    const sealer = await peerSealer(bob);

    expect((await receiver.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    expect(await receiver.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).toMatchObject({ outcome: "terminal", reason: "the host takes no more from this sender today" });
    expect(refusals).toEqual([expect.stringMatching(new RegExp(`^${bob.did} -> ${alice.did} \\(\\d+ bytes\\)$`)), expect.stringContaining(bob.did)]);
    expect(seen).toHaveLength(1);

    const toSelf = await sealed(await peerSealer(alice), alice.longFormDid);
    expect(terminalReason(await receiver.receive({ packed: toSelf, source: DIRECT }))).toBe(`the sender ${alice.did} is the recipient itself`);

    await alice.runtime.vault.commit([], [vaultDraft("route.retired", { routeId, because: "moved" })]);
    const toRetiredRoute = await sealed(sealer, alice.longFormDid);
    expect(terminalReason(await receiver.receive({ packed: toRetiredRoute, source: DIRECT }))).toBe(`${kidOf(toRetiredRoute)}: its route or mediation is retired or in conflict`);
    expect(seen).toHaveLength(1);
    await closeAll(alice, bob);
  });

  it("a DID whose route is not configured yet holds the delivery without acknowledgement and opens nothing, not on redelivery either; once the route arrives it is received from the held bytes and acknowledged", async () => {
    const { alice, bob } = await parties();
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(await eventsOf(alice.runtime, "did.created"));
    const { receipt, seen } = recording();
    const { acknowledge, acknowledged } = acknowledging();
    const trace = await AgentTrace.open(copy.runtime.local);
    const receiver = await receiverOver(copy, { receipt, acknowledge, trace });
    const packed = await sealed(await peerSealer(bob), alice.longFormDid);

    expect(await receiver.receive({ packed, source: PICKUP })).toMatchObject({ outcome: "deferred", reason: `${kidOf(packed)}: the bound route is not configured` });
    expect(receiver.waiting()).toEqual([expect.objectContaining({ source: PICKUP, held: true })]);
    expect(await receiver.receive({ packed, source: PICKUP })).toMatchObject({ outcome: "deferred" });
    expect(await receiver.localStateChanged()).toEqual([]);
    expect([seen, acknowledged, await trace.read({ type: "envelope.open" })]).toEqual([[], [], []]);

    await copy.runtime.ingest(await eventsOf(alice.runtime, "route.configured"));
    expect(await receiver.localStateChanged()).toMatchObject([{ outcome: "received" }]);
    expect(seen).toHaveLength(1);
    expect(acknowledged).toEqual([PICKUP]);
    expect(receiver.waiting()).toEqual([]);
    await closeAll(alice, bob, copy);
  });

  it("a held delivery whose bytes do not fit waits without them: a redelivery is not opened until the local state changed, and then it is opened from the redelivery", async () => {
    const { alice, bob } = await parties();
    const copy = await freshVault(1, "copy");
    await copy.runtime.ingest(await eventsOf(alice.runtime, "did.created"));
    const { receipt, seen } = recording();
    const receiver = await receiverOver(copy, { receipt, maxHeldBytes: 0 });
    const packed = await sealed(await peerSealer(bob), alice.longFormDid);
    const delivery: Delivery = { packed, source: PICKUP };

    expect((await receiver.receive(delivery)).outcome).toBe("deferred");
    expect(receiver.waiting()).toEqual([expect.objectContaining({ held: false })]);
    await copy.runtime.ingest(await eventsOf(alice.runtime, "route.configured"));
    expect((await receiver.receive(delivery)).outcome).toBe("deferred");
    expect(await receiver.localStateChanged()).toEqual([]);
    expect(seen).toEqual([]);
    expect((await receiver.receive(delivery)).outcome).toBe("received");
    expect(seen).toHaveLength(1);
    expect(receiver.waiting()).toEqual([]);
    await closeAll(alice, bob, copy);
  });

  it("a recipient method named by a query and a fragment is the exact method its document authorizes: the delivery opens with that key, and a query the document does not have names no method", async () => {
    const { alice, bob } = await parties();
    const keys = await alice.keys.didKeys(QUERIED);
    const document = inputDocumentOf(keys, ALICE_ENDPOINT);
    const method = "?version=1#agreement";
    (document["verificationMethod"] as JsonObject[])[1]!["id"] = method;
    document["keyAgreement"] = [method];
    const longFormDid = encodeLongForm(document) as Did;
    const did = longToShort(longFormDid) as Did;
    await alice.runtime.vault.commit([], [vaultDraft("did.created", { didId: QUERIED, did, longFormDid, boundRouteId: await boundRouteOf(alice) })]);
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt });
    const packed = await sealed(await peerSealer(bob), longFormDid);
    expect(kidOf(packed)).toBe(`${longFormDid}${method}`);

    expect((await receiver.receive({ packed, source: DIRECT })).outcome).toBe("received");
    expect(seen.map(({ recipient }) => recipient)).toEqual([{ didId: QUERIED, did, kid: `${longFormDid}${method}`, localKeyName: didKeyName(QUERIED, "key-agreement") }]);
    const elsewhere = `${longFormDid}?version=2#agreement`;
    expect(terminalReason(await receiver.receive({ packed: addressedTo(packed, elsewhere), source: DIRECT }))).toBe(`${elsewhere} names no method of ${longFormDid}`);
    await closeAll(alice, bob);
  });

  it("a local change told of while a delivery reads the vault is not lost: the delivery decides over the vault again before it is held", async () => {
    const { alice, bob } = await parties();
    const copy = await copyOf(alice, "did.created");
    const { receipt, seen } = recording();
    const receiver = await receiverOver(copy, { receipt });
    const delivery: Delivery = { packed: await sealed(await peerSealer(bob), alice.longFormDid), source: PICKUP };
    const events = copy.runtime.vault.events;
    const scan = events.scan.bind(events);
    let read: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const readOld = new Promise<void>((resolve) => {
      read = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(events, "scan").mockImplementationOnce(async function* (...args: Parameters<typeof scan>) {
      yield* scan(...args);
      read();
      await resumed;
    });

    const first = receiver.receive(delivery);
    await readOld;
    await copy.runtime.ingest(await eventsOf(alice.runtime, "route.configured"));
    expect(await receiver.localStateChanged()).toEqual([]);
    resume();
    expect(await first).toEqual({ outcome: "received", key: deliveryKey(delivery), eventId: RECORDED });
    expect(seen).toHaveLength(1);
    expect(receiver.waiting()).toEqual([]);
    await closeAll(alice, bob, copy);
  });

  it("only a change of what a delivery waits for retries it: a receipt's deferral watches something of the fold and a change elsewhere leaves the delivery unopened; a receipt that throws keeps nothing, and the delivery is taken when it comes again", async () => {
    const { alice, bob } = await parties();
    const otherRoute = await configureRoute(alice.runtime, alice.keys, { kind: "direct", endpoint: OTHER_ENDPOINT });
    const other = await createDid(alice.runtime, alice.keys, otherRoute.data.routeId, OTHER);
    const copy = await freshVault(1, "copy");
    const routes = (await eventsOf(alice.runtime, "route.configured")) as { data: { routeId: RouteId } }[];
    await copy.runtime.ingest([...(await eventsOf(alice.runtime, "did.created")), ...routes.filter((event) => event.data.routeId !== otherRoute.data.routeId)]);
    const calls: DidId[] = [];
    let failing = false;
    const trace = await AgentTrace.open(copy.runtime.local);
    const opened = async (): Promise<number> => (await trace.read({ type: "envelope.open" })).length;
    const receiver = await receiverOver(copy, {
      trace,
      receipt: async ({ recipient }) => {
        calls.push(recipient.didId);
        if (failing) throw new Error("the disk is full");
        if (recipient.didId !== DID) return { outcome: "received", eventId: RECORDED };
        return { outcome: "deferred", reason: "the receipt waits for the recipient's disclosure", watch: (fold) => String(fold.routes.dids.get(DID)?.disclosures.length ?? 0) };
      },
    });
    const sealer = await peerSealer(bob);
    const toAlice: Delivery = { packed: await sealed(sealer, alice.longFormDid), source: pickup("a") };
    const toOther: Delivery = { packed: await sealed(sealer, other.minted.longFormDid), source: pickup("o") };

    expect((await receiver.receive(toAlice)).outcome).toBe("deferred");
    expect((await receiver.receive(toOther)).outcome).toBe("deferred");
    expect([calls, await opened()]).toEqual([[DID], 1]);

    await copy.runtime.ingest(routes.filter((event) => event.data.routeId === otherRoute.data.routeId));
    expect((await receiver.localStateChanged()).map(({ key, outcome }) => [key, outcome])).toEqual([[deliveryKey(toOther), "received"]]);
    expect([calls, await opened()]).toEqual([[DID, OTHER], 2]);

    await disclose(null, alice.runtime, alice.keys, DID, { as: "direct", uses: "many" });
    await copy.runtime.ingest(await eventsOf(alice.runtime, "did.disclosed"));
    failing = true;
    expect(await receiver.localStateChanged()).toMatchObject([{ key: deliveryKey(toAlice), outcome: "deferred", reason: "the receipt failed: the disk is full; the delivery is left where it came from" }]);
    expect([calls, await opened(), receiver.waiting()]).toEqual([[DID, OTHER, DID], 3, []]);
    expect(await receiver.localStateChanged()).toEqual([]);

    failing = false;
    expect(await receiver.receive(toAlice)).toMatchObject({ outcome: "deferred", reason: "the receipt waits for the recipient's disclosure" });
    expect([calls, await opened(), receiver.waiting().length]).toEqual([[DID, OTHER, DID, DID], 4, 1]);
    expect(await receiver.localStateChanged()).toEqual([]);
    receiver.close();

    const again = await receiverOver(copy, { trace, receipt: async () => { throw new Error("the disk is full"); } });
    expect(await again.receive(toOther)).toMatchObject({ outcome: "deferred", reason: "the receipt failed: the disk is full; the delivery is left where it came from" });
    expect(again.waiting()).toEqual([]);
    expect(await again.pickupHandle(MEDIATION)({ attachmentId: "o", packed: toOther.packed })).toBe("skip");
    await closeAll(alice, bob, copy);
  });

  it("a change told of while the receipt is deciding sends the delivery through the gate again only when its watch says something else: an unrelated change lets it be held as decided", async () => {
    const { alice, bob } = await parties();
    const copy = await copyOf(alice, "did.created", "route.configured");
    const trace = await AgentTrace.open(copy.runtime.local);
    const opened = async (): Promise<number> => (await trace.read({ type: "envelope.open" })).length;
    let deciding: () => void = () => undefined;
    let decide: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      deciding = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      decide = resolve;
    });
    let calls = 0;
    const receiver = await receiverOver(copy, {
      trace,
      receipt: async () => {
        calls += 1;
        if (calls === 1) {
          deciding();
          await resumed;
        }
        return { outcome: "deferred", reason: "the receipt waits for the recipient's disclosure", watch: (fold) => String(fold.routes.dids.get(DID)?.disclosures.length ?? 0) };
      },
    });
    const delivery: Delivery = { packed: await sealed(await peerSealer(bob), alice.longFormDid), source: PICKUP };

    const first = receiver.receive(delivery);
    await entered;
    await configureRoute(copy.runtime, copy.keys, { kind: "direct", endpoint: OTHER_ENDPOINT });
    expect(await receiver.localStateChanged()).toEqual([]);
    decide();
    expect(await first).toMatchObject({ outcome: "deferred" });
    expect([calls, await opened(), receiver.waiting().length]).toEqual([1, 1, 1]);
    expect(await receiver.localStateChanged()).toEqual([]);

    await disclose(null, alice.runtime, alice.keys, DID, { as: "direct", uses: "many" });
    await copy.runtime.ingest(await eventsOf(alice.runtime, "did.disclosed"));
    expect((await receiver.localStateChanged()).map(({ outcome }) => outcome)).toEqual(["deferred"]);
    expect([calls, await opened()]).toEqual([2, 2]);
    await closeAll(alice, bob, copy);
  });

  it("a waiting delivery whose retry fails — the vault not read, the receipt thrown — is let go with its bytes, and is taken when it comes again without another change", async () => {
    for (const failure of ["read", "write"] as const) {
      const { alice, bob } = await parties();
      const copy = await copyOf(alice, "did.created");
      let failing = false;
      const { acknowledge, acknowledged } = acknowledging();
      const seen: DidId[] = [];
      const receiver = await receiverOver(copy, {
        acknowledge,
        receipt: async ({ recipient }) => {
          seen.push(recipient.didId);
          if (failing && failure === "write") throw new Error("the disk is full");
          return { outcome: "received", eventId: RECORDED };
        },
      });
      const delivery: Delivery = { packed: await sealed(await peerSealer(bob), alice.longFormDid), source: PICKUP };
      expect(await receiver.receive(delivery)).toMatchObject({ outcome: "deferred" });
      expect(receiver.waiting()).toEqual([expect.objectContaining({ held: true })]);

      await copy.runtime.ingest(await eventsOf(alice.runtime, "route.configured"));
      failing = true;
      const events = copy.runtime.vault.events;
      const scan = events.scan.bind(events);
      let scans = 0;
      const spy = vi.spyOn(events, "scan").mockImplementation((...args: Parameters<typeof scan>) => {
        scans += 1;
        if (failure === "read" && scans === 2) throw new Error("the database is locked");
        return scan(...args);
      });
      expect(await receiver.localStateChanged()).toMatchObject([{ outcome: "deferred", reason: expect.stringContaining("left where it came from") }]);
      spy.mockRestore();
      failing = false;
      expect([receiver.waiting(), acknowledged, seen.length]).toEqual([[], [], failure === "write" ? 1 : 0]);

      expect(await receiver.pickupHandle(MEDIATION)({ attachmentId: PICKUP.deliveryId, packed: delivery.packed })).toBe("acked");
      expect(seen.length).toBe(failure === "write" ? 2 : 1);
      await closeAll(alice, bob, copy);
    }
  });

  it("a comparison that cannot read the vault lets the waiting deliveries go rather than opening them: one already held, and one whose receipt is still deciding", async () => {
    const { alice, bob } = await parties();
    const copy = await copyOf(alice, "did.created", "route.configured");
    const trace = await AgentTrace.open(copy.runtime.local);
    const opened = async (): Promise<number> => (await trace.read({ type: "envelope.open" })).length;
    let deciding: () => void = () => undefined;
    let decide: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      deciding = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      decide = resolve;
    });
    let calls = 0;
    const receiver = await receiverOver(copy, {
      trace,
      receipt: async () => {
        calls += 1;
        if (calls === 2) {
          deciding();
          await resumed;
        }
        return { outcome: "deferred", reason: "the receipt waits for the recipient's disclosure", watch: (fold) => String(fold.routes.dids.get(DID)?.disclosures.length ?? 0) };
      },
    });
    const events = copy.runtime.vault.events;
    const failOnce = (): void => {
      vi.spyOn(events, "scan").mockImplementationOnce(() => {
        throw new Error("the database is locked");
      });
    };
    const delivery: Delivery = { packed: await sealed(await peerSealer(bob), alice.longFormDid), source: PICKUP };

    expect(await receiver.receive(delivery)).toMatchObject({ outcome: "deferred", reason: "the receipt waits for the recipient's disclosure" });
    await configureRoute(copy.runtime, copy.keys, { kind: "direct", endpoint: OTHER_ENDPOINT });
    failOnce();
    expect(await receiver.localStateChanged()).toMatchObject([{ outcome: "deferred", reason: "the vault is not read to tell what changed; the delivery is left where it came from" }]);
    expect([receiver.waiting(), calls, await opened()]).toEqual([[], 1, 1]);

    const second = receiver.receive(delivery);
    await entered;
    await configureRoute(copy.runtime, copy.keys, { kind: "direct", endpoint: CAROL_ENDPOINT });
    expect(await receiver.localStateChanged()).toEqual([]);
    failOnce();
    decide();
    expect(await second).toMatchObject({ outcome: "deferred", reason: "the vault is not read to tell what changed; the delivery is left where it came from" });
    expect([receiver.waiting(), calls, await opened()]).toEqual([[], 2, 2]);

    expect(await receiver.receive(delivery)).toMatchObject({ outcome: "deferred", reason: "the receipt waits for the recipient's disclosure" });
    expect([receiver.waiting().length, calls, await opened()]).toEqual([1, 3, 3]);
    await closeAll(alice, bob, copy);
  });

  it("a delivery whose vault could not be read is not kept and is taken when it comes again", async () => {
    const { alice, bob } = await parties();
    const { receipt, seen } = recording();
    const receiver = await receiverOver(alice, { receipt });
    const delivery: Delivery = { packed: await sealed(await peerSealer(bob), alice.longFormDid), source: PICKUP };
    vi.spyOn(alice.runtime.vault.events, "scan").mockImplementationOnce(() => {
      throw new Error("the database is locked");
    });

    expect(await receiver.receive(delivery)).toMatchObject({ outcome: "deferred", reason: "the vault is not read: the database is locked; the delivery is left where it came from" });
    expect([receiver.waiting(), seen]).toEqual([[], []]);
    expect(await receiver.receive(delivery)).toEqual({ outcome: "received", key: deliveryKey(delivery), eventId: RECORDED });
    await closeAll(alice, bob);
  });

  it("a recipient named many times over is one recipient: what the delivery waits on and the reason kept do not grow with the repetition", async () => {
    const { alice, bob } = await parties();
    const copy = await copyOf(alice, "did.created");
    const { receipt, seen } = recording();
    const receiver = await receiverOver(copy, { receipt, maxWaiting: 1, maxHeldBytes: 0 });
    const packed = await sealed(await peerSealer(bob), alice.longFormDid);
    const kid = kidOf(packed);
    const fold = await scanVault(copy.runtime.vault, copy.keys);
    const once = classifyRecipients(fold, [kid]);
    expect(once).toEqual({ verdict: "pending", reason: `${kid}: the bound route is not configured`, waitingOn: [DID] });
    expect(classifyRecipients(fold, Array.from({ length: 2048 }, () => kid))).toEqual(once);

    const envelope = JSON.parse(packed) as { recipients: unknown[] };
    const forged = JSON.stringify({ ...envelope, ciphertext: "not-authenticated", recipients: Array.from({ length: 2048 }, () => envelope.recipients[0]) });
    expect(await receiver.receive({ packed: forged, source: DIRECT })).toMatchObject({ outcome: "deferred", reason: `${kid}: the bound route is not configured` });
    expect([receiver.waiting().length, seen]).toEqual([1, []]);
    await closeAll(alice, bob, copy);
  });

  it("past as many deliveries as may wait, one that would wait is left where it came from with nothing kept and comes back once it can be taken; bytes held are counted as sent, not as characters", async () => {
    const { alice, bob } = await parties();
    const copy = await copyOf(alice, "did.created");
    const { receipt, seen } = recording();
    const receiver = await receiverOver(copy, { receipt, maxWaiting: 2 });
    const sealer = await peerSealer(bob);
    const deliveries: Delivery[] = [];
    for (const deliveryId of ["d1", "d2", "d3"]) deliveries.push({ packed: await sealed(sealer, alice.longFormDid), source: pickup(deliveryId) });
    const [one, two, three] = deliveries as [Delivery, Delivery, Delivery];

    expect((await receiver.receive(one)).outcome).toBe("deferred");
    expect((await receiver.receive(two)).outcome).toBe("deferred");
    expect(await receiver.receive(three)).toMatchObject({ outcome: "deferred", reason: expect.stringContaining("left where it came from") });
    expect(await receiver.pickupHandle(MEDIATION)({ attachmentId: "d3", packed: three.packed })).toBe("skip");
    expect((await receiver.receive(one)).outcome).toBe("deferred");
    expect(receiver.waiting().map(({ source }) => source)).toEqual([one.source, two.source]);

    await copy.runtime.ingest(await eventsOf(alice.runtime, "route.configured"));
    expect((await receiver.localStateChanged()).map(({ outcome }) => outcome)).toEqual(["received", "received"]);
    expect((await receiver.receive(three)).outcome).toBe("received");
    expect(seen).toHaveLength(3);
    receiver.close();

    const padded = JSON.stringify({ ...(JSON.parse(one.packed) as JsonObject), padding: "漢".repeat(64) });
    const bytes = new TextEncoder().encode(padded).length;
    expect(bytes).toBeGreaterThan(padded.length);
    const held = async (maxHeldBytes: number): Promise<boolean> => {
      const other = await freshVault(1, "other");
      await other.runtime.ingest(await eventsOf(alice.runtime, "did.created"));
      const r = await receiverOver(other, { receipt, maxHeldBytes });
      expect((await r.receive({ packed: padded, source: DIRECT })).outcome).toBe("deferred");
      const [wait] = r.waiting();
      await other.runtime.close();
      return wait!.held;
    };
    expect([await held(padded.length), await held(bytes)]).toEqual([false, true]);
    await closeAll(alice, bob, copy);
  });
});

describe("the sender's proof", () => {
  it("refuses a header that names another key than the sealer's, or does not repeat its skid as apu, whatever the plaintext says", async () => {
    const { bob } = await parties();
    const resolution = await peerResolutionOf(bob.longFormDid);
    const kid = `${bob.longFormDid}#key-2`;
    const unpacked = { plaintext: { from: bob.longFormDid } as unknown as IMessage, sender: { did: bob.longFormDid, kid }, fromPrior: null, metadata: {} } as unknown as Unpacked;

    expect(senderProof(unpacked, { skid: kid, apu: kid }, resolution)).toEqual({ sender: { resolution, kid, peerPublicKey: agreementKey(resolution) } });
    expect(senderProof(unpacked, { skid: `${bob.longFormDid}#key-1`, apu: `${bob.longFormDid}#key-1` }, resolution)).toEqual({ refused: `the header names ${bob.longFormDid}#key-1 as the sender's key, but ${kid} sealed the envelope` });
    expect(senderProof(unpacked, { skid: kid, apu: `${bob.did}#key-2` }, resolution)).toEqual({ refused: `the header's apu ${JSON.stringify(`${bob.did}#key-2`)} is not its skid ${kid}` });
    expect(senderProof(unpacked, { skid: kid, apu: kid }, null)).toEqual({ refused: `${bob.longFormDid} was not the sender resolved for this delivery` });
    expect(senderProof({ ...unpacked, sender: { did: bob.longFormDid, kid: `${bob.longFormDid}#key-1` } }, { skid: `${bob.longFormDid}#key-1`, apu: `${bob.longFormDid}#key-1` }, resolution)).toEqual({ refused: `${bob.longFormDid}#key-1 is no key-agreement method of ${bob.longFormDid}'s document` });
    await closeAll(bob);
  });
});

describe("the receiver's lifecycle", () => {
  it("a runtime receives through one receiver: a second is refused while it is open; after close a delivery already handed to the receipt ends as the receipt says, one awaiting its turn is refused and left where it came from, nothing else is taken, and the runtime may have another receiver", async () => {
    const { alice, bob } = await parties();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: Authenticated[] = [];
    const receipt: ReceiverOptions["receipt"] = async (authenticated) => {
      seen.push(authenticated);
      await gate;
      return { outcome: "received", eventId: RECORDED };
    };
    const receiver = await receiverOver(alice, { receipt });
    expect(() => new Receiver(alice.runtime, alice.keys, null as unknown as Keyring, { didcomm, receipt })).toThrow(ReceiverInUse);
    const sealer = await peerSealer(bob);
    const delivery: Delivery = { packed: await sealed(sealer, alice.longFormDid), source: PICKUP };
    const first = receiver.receive(delivery);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const second = receiver.receive(delivery);
    receiver.close();
    await expect(receiver.receive({ packed: "{}", source: DIRECT })).rejects.toThrow(ReceiverClosed);
    await expect(receiver.pickupHandle(MEDIATION)({ attachmentId: "a", packed: "{}" })).rejects.toThrow(ReceiverClosed);
    release();
    expect(await first).toEqual({ outcome: "received", key: deliveryKey(delivery), eventId: RECORDED });
    await expect(second).rejects.toThrow(ReceiverClosed);
    expect(seen).toHaveLength(1);
    expect(receiver.waiting()).toEqual([]);

    const next = await receiverOver(alice, { receipt });
    expect((await next.receive({ packed: await sealed(sealer, alice.longFormDid), source: DIRECT })).outcome).toBe("received");
    expect(seen).toHaveLength(2);
    await closeAll(alice, bob);
  });
});

describe("the gate over pickup", () => {
  it("a delivery for no key of this vault and one received are acknowledged in the same round; one held for a local prerequisite stays queued", async () => {
    const { mediator, p, longFormDid, account } = await mediated();
    const bob = await directParty(2, BOB_ENDPOINT, BOB);
    const { receipt, seen } = recording();
    const receiver = new Receiver(p.runtime, p.keys, p.ring, { didcomm, receipt });
    const pickup = new Pickup(p.link, receiver.pickupHandle(p.mediationId));
    const sealer = await peerSealer(bob);
    const packed = await sealed(sealer, longFormDid);
    const foreign = await sealed(sealer, bob.longFormDid);
    mediator.queues.set(account, [
      { id: "q1", packed: foreign },
      { id: "q2", packed },
    ]);

    expect(await pickup.drain()).toEqual({ acked: 2, ended: "empty" });
    expect(seen).toHaveLength(1);
    expect(receiver.discarded()).toEqual([{ source: { kind: "pickup", mediationId: p.mediationId, deliveryId: "q1" }, reason: `local recipient material is unavailable for ${kidOf(foreign)}; the delivery was discarded` }]);

    const other = await freshVault(1, "copy");
    await other.runtime.ingest(await eventsOf(p.runtime, "did.created"));
    const otherReceiver = await receiverOver(other, { receipt });
    const q3 = await sealed(sealer, longFormDid);
    expect(await otherReceiver.receive({ packed: q3, source: { kind: "pickup", mediationId: p.mediationId, deliveryId: "q3" } })).toMatchObject({ outcome: "deferred" });
    expect(await otherReceiver.pickupHandle(p.mediationId)({ attachmentId: "q3", packed: q3 })).toBe("skip");
    expect(seen).toHaveLength(1);
    await closeAll(p, bob, other);
  });

  it("a delivery that ended is only told again when it comes again before the mediator was told: a lost acknowledgement costs no second opening or receipt, and once the mediator is told it is forgotten", async () => {
    const { mediator, p, longFormDid, account } = await mediated();
    const bob = await directParty(2, BOB_ENDPOINT, BOB);
    const { receipt, seen } = recording();
    const trace = await AgentTrace.open(p.runtime.local);
    const receiver = new Receiver(p.runtime, p.keys, p.ring, { didcomm, receipt, trace });
    const pickup = new Pickup(p.link, receiver.pickupHandle(p.mediationId));
    const packed = await sealed(await peerSealer(bob), longFormDid);
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
    const opened = async (): Promise<number> => (await trace.read({ type: "envelope.open" })).filter((entry) => entry.data["type"] === BASIC_MESSAGE).length;
    expect([seen.length, await opened(), mediator.queues.get(account)]).toEqual([1, 1, []]);

    mediator.queues.set(account, [{ id: "q1", packed }]);
    expect(await pickup.drain()).toEqual({ acked: 1, ended: "empty" });
    expect([seen.length, await opened()]).toEqual([2, 2]);
    await closeAll(p, bob);
  });
});
