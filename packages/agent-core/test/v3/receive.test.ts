import { describe, expect, it, vi } from "vitest";

import { resolveDIDCommDoc, toDIDCommDIDDoc, type DIDDoc, type Secret } from "@estoc/did-peer";
import type { VaultRuntime } from "@estoc/event-store/v3";
import { didKeyName, scanVault, signFromPrior, splitDidUrl, vaultDraft, type DidId, type MediationId, type PublicKey } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { PLAIN_TYP, packEncrypted, secretsResolverFor, type DIDResolver, type IMessage, type Unpacked } from "../../src/protocol/didcomm.js";
import { MESSAGES_RECEIVED } from "../../src/protocol/mediation.js";
import {
  AgentTrace,
  Keyring,
  Pickup,
  Receiver,
  ReceiverClosed,
  ReceiverInUse,
  authorizedKeys,
  commitResolution,
  createDid,
  deliveryKey,
  ensureRoute,
  establish,
  pinnedResolver,
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
import { didcomm, directParty, freshVault, newMediator, party, reloaded, webIdentity, type DirectParty, type Fresh, type Party } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const MEDIATION = "019b0000-0000-7000-8000-000000000201" as MediationId;
const ALICE_ENDPOINT = "https://alice.example/didcomm";
const BOB_ENDPOINT = "https://bob.example/didcomm";
const CAROL_ENDPOINT = "https://carol.example/didcomm";
const WEB_BOB = "did:web:bob.example";

const PICKUP: Source = { kind: "pickup", mediationId: MEDIATION, deliveryId: "d1" };
const DIRECT: Source = { kind: "direct" };

/** Someone who seals: the DID they write as, their secrets, and how the documents they seal against resolve. */
interface Sealer {
  did: string;
  secrets: Secret[];
  resolver: DIDResolver;
}

/** A peer party sealing as `as` — its long form unless told otherwise — against the documents its own vault answers, which include every numalgo-4 long form. */
async function peerSealer(holder: DirectParty, as: string = holder.longFormDid): Promise<Sealer> {
  const fold = await scanVault(holder.runtime.vault, holder.keys);
  const ring = await Keyring.load(holder.keys, fold);
  return { did: as, secrets: ring.secrets(), resolver: pinnedResolver(fold) };
}

/** A `did:web` party sealing against its own document and the peers' long forms. */
async function webSealer(did: string): Promise<Sealer> {
  const identity = await webIdentity(did);
  const document = toDIDCommDIDDoc(identity.document) as DIDDoc;
  return { did, secrets: identity.secrets, resolver: { resolve: async (asked) => (asked === did ? document : resolveDIDCommDoc(asked)) } };
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

    expect(await receiver.receive(delivery)).toEqual({ outcome: "received", key: deliveryKey(delivery) });
    const resolution = await peerResolutionOf(bob.longFormDid);
    expect(seen.map(({ recipient, sender, plaintext, fromPrior }) => ({ recipient, sender, body: plaintext.body, fromPrior }))).toEqual([
      {
        recipient: { didId: DID, did: alice.did, kid: kidOf(packed), localKeyName: didKeyName(DID, "key-agreement") },
        sender: { resolution, kid: `${bob.longFormDid}#key-2`, peerPublicKey: agreementKey(resolution) },
        body: { content: "hello" },
        fromPrior: null,
      },
    ]);

    expect(await receiver.receive(delivery)).toEqual({ outcome: "received", key: deliveryKey(delivery) });
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
    expect(await receiver.localStateChanged()).toMatchObject([{ outcome: "deferred" }]);
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
      return { outcome: "received" };
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
    expect(await first).toEqual({ outcome: "received", key: deliveryKey(delivery) });
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
