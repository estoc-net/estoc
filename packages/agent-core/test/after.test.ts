import { describe, expect, it } from "vitest";

import { SignJWT, importJWK } from "jose";

import { AUTHENTICATION_METHOD, didKeyName, inboundMessageId, scanVault, signFromPrior, type DidId, type MessageId, type VaultEvent, type VaultEventType, type VaultFold, type WireMessageId } from "@estoc/vault";

import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import type { IMessage } from "../src/protocol/didcomm.js";
import { AgentTrace, Keyring, Receiver, acknowledgementDrafts, afterReceipt, createDid, disclose, prepare, receiptOf, recordAcks, recordOwed, recordReceipt, send, type Authenticated, type Content, type ReceiptOutcome, type Source } from "../src/index.js";
import { didcomm, directParty, peerSealer, refuseCommits, sealed, type DirectParty, type Fresh } from "./helpers.js";

const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const IAT = 1_757_700_000;

const DIRECT: Source = { kind: "direct" };
const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty }> {
  return { alice: await directParty(1, "https://alice.example/didcomm", DID), bob: await directParty(2, "https://bob.example/didcomm", BOB) };
}

async function closeAll(...parties: Fresh[]): Promise<void> {
  for (const p of parties) await p.runtime.close();
}

/** A receiver over the vault's own receipt; `seen` keeps what the gate handed it. */
async function receiving(holder: Fresh): Promise<{ receiver: Receiver; seen: Authenticated[] }> {
  const seen: Authenticated[] = [];
  const record = receiptOf(holder.runtime, holder.keys);
  const ring = await Keyring.load(holder.keys, await scanVault(holder.runtime.vault, holder.keys));
  const receiver = new Receiver(holder.runtime, holder.keys, ring, {
    didcomm,
    receipt: (authenticated) => {
      seen.push(authenticated);
      return record(authenticated);
    },
  });
  return { receiver, seen };
}

async function receivedThen(receiver: Receiver, alice: DirectParty, peer: DirectParty, extra: Partial<IMessage>, trace?: AgentTrace) {
  const received = await receiver.receive({ packed: await sealed(await peerSealer(peer), alice.longFormDid, extra), source: DIRECT });
  if (received.outcome !== "received") throw new Error(`not received: ${JSON.stringify(received)}`);
  return { cid: received.cid, after: await afterReceipt(alice.runtime, alice.keys, received.cid, { trace }) };
}

const foldOf = (holder: Fresh): Promise<VaultFold> => scanVault(holder.runtime.vault, holder.keys);

async function eventsOf<T extends VaultEventType>(holder: Fresh, type: T): Promise<readonly VaultEvent<T>[]> {
  return (await foldOf(holder)).set.of(type);
}

describe("after the receipt", () => {
  it("a peer's ack names an outbound: once the outbound has its package, the witness is recorded as one acknowledgement, the same ack delivered again is not recorded twice, another ack from the peer is, and an unrelated peer naming the ID earns nothing", async () => {
    const { alice, bob } = await parties();
    const carol = await directParty(3, "https://carol.example/didcomm", CAROL);
    await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    const { receiver, seen } = await receiving(alice);
    const wire = crypto.randomUUID() as WireMessageId;

    const early = await receivedThen(receiver, alice, bob, { id: wire, ack: [MESSAGE] });
    expect(early.after).toMatchObject({ proof: { status: "not-present" }, disposition: { status: "admitted", admissions: [{ event: { data: { sourceEventCid: early.cid } }, status: { status: "effective" } }] }, admitted: [], consumed: [], acknowledged: [] });
    expect((await prepare(alice.runtime, alice.keys, MESSAGE, { didcomm })).outcome).toBe("prepared");
    expect(acknowledgementDrafts(await foldOf(alice)).map(({ data }) => data)).toEqual([
      { messageId: MESSAGE, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: seen[0]!.sender!.peerPublicKey, ackMessageId: inboundMessageId(bob.did, alice.did, wire), ackWireMessageId: wire },
    ]);
    const recorded = await recordAcks(alice.runtime, alice.keys);
    expect([recorded.map(({ type }) => type), await recordAcks(alice.runtime, alice.keys)]).toEqual([["delivery.acknowledged"], []]);
    const outbound = (await foldOf(alice)).outbound.outbounds.get(MESSAGE)!;
    expect([outbound.acknowledged, outbound.acknowledgements.map(({ status }) => status), outbound.outcome, outbound.work.kind]).toEqual([true, [{ status: "complete" }], { status: "prepared" }, "dispatch"]);

    const second = crypto.randomUUID() as WireMessageId;
    const again = await receivedThen(receiver, alice, bob, { id: wire, ack: [MESSAGE] });
    const other = await receivedThen(receiver, alice, bob, { id: second, ack: [MESSAGE] });
    const stranger = await receivedThen(receiver, alice, carol, { ack: [MESSAGE] });
    expect([again.after.acknowledged, other.after.acknowledged.map(({ data }) => data.ackMessageId), stranger.after.acknowledged]).toEqual([[], [inboundMessageId(bob.did, alice.did, second)], []]);
    const fold = await foldOf(alice);
    expect([fold.outbound.outbounds.get(MESSAGE)!.ackWitnesses.length, (await eventsOf(alice, "delivery.acknowledged")).length, (await eventsOf(alice, "message.in")).length]).toEqual([3, 2, 4]);
    await closeAll(alice, bob, carol);
  });

  it("a one-use invitation is consumed by the first eligible receipt under its ID and by no later one; a receipt under no invitation consumes nothing", async () => {
    const { alice, bob } = await parties();
    const carol = await directParty(3, "https://carol.example/didcomm", CAROL);
    const { disclosed, invitation } = await disclose(null, alice.runtime, alice.keys, DID, { as: "oob", uses: "one" });
    const { receiver } = await receiving(alice);

    const plain = await receivedThen(receiver, alice, bob, {});
    const first = await receivedThen(receiver, alice, bob, { pthid: invitation!.id });
    expect([plain.after.consumed, first.after.consumed.map(({ data }) => data)]).toEqual([[], [{ disclosureEventCid: disclosed.cid, sourceEventCid: first.cid }]]);
    expect((await foldOf(alice)).invitations.invitations.get(disclosed.cid)!.status).toEqual({ status: "consumed", consumer: bob.did });

    const later = await receivedThen(receiver, alice, carol, { pthid: invitation!.id });
    expect([later.after.consumed, (await eventsOf(alice, "invitation.consumed")).length]).toEqual([[], 1]);
    await closeAll(alice, bob, carol);
  });

  it("an observation left unadmitted by a crash is admitted by the next pass, an open's included, and one whose proof waited for the issuer's document is admitted once a later receipt brings it, while the receipt that brought it, from the address the proof leaves, is ignored", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const { receiver } = await receiving(alice);
    refuseCommits(alice.runtime, "message.admitted", 1);
    const crashed = await receiver.receive({ packed: await sealed(await peerSealer(bob), alice.longFormDid), source: DIRECT });
    expect(crashed).toMatchObject({ outcome: "deferred", reason: expect.stringMatching(/^the receipt failed: the disk is full for now/) });
    const [orphan] = await eventsOf(alice, "message.in");
    expect([orphan!.type, await eventsOf(alice, "message.admitted")]).toEqual(["message.in", []]);
    const recovered = await recordOwed(alice.runtime, alice.keys);
    expect([recovered.admitted.map(({ data }) => data.sourceEventCid), recovered.consumed, recovered.acknowledged]).toEqual([[orphan!.cid], [], []]);
    expect(await recordOwed(alice.runtime, alice.keys)).toEqual({ admitted: [], consumed: [], acknowledged: [] });

    const routeId = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const signing = await bob.keys.signing(didKeyName(BOB_PRIOR, "authentication"));
    const shortIssuer = await new SignJWT({ iss: prior.did, sub: bob.longFormDid, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: `${prior.did}${AUTHENTICATION_METHOD}` }).sign(await importJWK(signing.privateJwk(), "EdDSA"));
    receiver.close();
    const seen: Authenticated[] = [];
    const observer = new Receiver(alice.runtime, alice.keys, await Keyring.load(alice.keys, await foldOf(alice)), { didcomm, receipt: async (a) => (seen.push(a), { outcome: "terminal", reason: "kept for the test" }) });
    await observer.receive({ packed: await sealed(await peerSealer(bob), alice.longFormDid), source: DIRECT });
    observer.close();
    const [plain] = seen;
    const carried = await recordReceipt(alice.runtime, alice.keys, { ...plain!, plaintext: { ...plain!.plaintext, from_prior: shortIssuer } as IMessage, fromPrior: shortIssuer });
    const cid = (carried as Extract<ReceiptOutcome, { outcome: "received" }>).cid;
    const waiting = await afterReceipt(alice.runtime, alice.keys, cid, { trace });
    expect([waiting.proof, waiting.disposition, waiting.admitted]).toEqual([{ status: "pending-proof" }, { status: "pending-admission", because: "the source's proof is not yet verified" }, []]);
    expect((await trace.read({ type: "diag.admission" })).map((entry) => entry.data)).toEqual([{ cid, status: "pending-admission", because: "the source's proof is not yet verified" }]);

    const { receiver: again } = await receiving(alice);
    const fromOld = await again.receive({ packed: await sealed(await peerSealer(bob, prior.longFormDid), alice.longFormDid), source: DIRECT });
    if (fromOld.outcome !== "received") throw new Error("not received");
    const after = await afterReceipt(alice.runtime, alice.keys, fromOld.cid);
    expect([after.disposition, after.admitted]).toEqual([{ status: "ignored-superseded" }, []]);
    const fold = await foldOf(alice);
    expect([fold.continuity.status(cid), fold.dispositions.disposition(cid).status]).toEqual([{ status: "verified" }, "admitted"]);
    await closeAll(alice, bob);
  });

  it("the proof the observation carried is judged by the fold: one that verifies is reported as such and traced nowhere, one that does not is reported and left as a diagnostic", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const routeId = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, IAT);
    const { receiver, seen } = await receiving(alice);
    const verified = await receivedThen(receiver, alice, bob, { from_prior: proof }, trace);
    expect(verified.after.proof).toEqual({ status: "verified" });

    const last = seen.at(-1) as Authenticated;
    const bogus = await recordReceipt(alice.runtime, alice.keys, { ...last, plaintext: { ...last.plaintext, from_prior: "not-a-jwt" } as IMessage, fromPrior: "not-a-jwt" });
    const cid = (bogus as Extract<ReceiptOutcome, { outcome: "received" }>).cid;
    const after = await afterReceipt(alice.runtime, alice.keys, cid, { trace });
    expect(after.proof).toMatchObject({ status: "invalid" });
    expect((await trace.read({ type: "diag.proof" })).map((entry) => entry.data)).toEqual([{ cid, ...after.proof }]);
    await closeAll(alice, bob);
  });
});
