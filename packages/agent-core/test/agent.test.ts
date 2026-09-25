import { afterEach, describe, expect, it } from "vitest";

import { SignJWT, importJWK } from "jose";

import { AUTHENTICATION_METHOD, PING_RESPONSE_EFFECT, PING_TYPE, PURE_ACK_EFFECT, didKeyName, scanVault, vaultDraft, type Did, type DidId, type MessageId, type PublicKey, type VaultFold } from "@estoc/vault";

import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { MESSAGES_RECEIVED } from "../src/protocol/mediation.js";
import { FORWARD, PROBLEM_REPORT } from "../src/protocol/spec.js";
import type { IMessage } from "../src/protocol/didcomm.js";
import { Agent, AgentTrace, UNKNOWN_REGISTRATIONS_KEPT, Pickup, Receiver, ReceiverInUse, authorizedKeys, commitResolution, createDid, createMediation, disclose, receiptOf, reconcile, resolve, selectMediation, send, type AgentOptions, type Inbound } from "../src/index.js";
import type { FakeMediator } from "./fake-mediator.js";
import { didcomm, freshVault, json, mediatedParty, newMediator, peerSealer, refuseCommits, sealed, until, webIdentity, type MediatedParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const PING = "019b0000-0000-7000-8000-000000000101" as MessageId;
const PING_AGAIN = "019b0000-0000-7000-8000-000000000102" as MessageId;
const IAT = 1_757_700_000;

const opened: { agent: Agent | null; party: MediatedParty }[] = [];

function optionsOf(party: MediatedParty, over: Partial<AgentOptions> = {}): AgentOptions {
  return { didcomm, fetch: party.linkOptions.fetch as typeof fetch, WebSocket: party.mediator.WebSocket, trace: party.trace, privateAddresses: false, liveDelivery: false, ...over };
}

async function partyOf(mediator: FakeMediator, fill: number, didId: DidId): Promise<MediatedParty> {
  const party = await mediatedParty(mediator, fill, didId);
  opened.push({ agent: null, party });
  return party;
}

async function agentOf(party: MediatedParty, how: "open" | "start", over: Partial<AgentOptions> = {}): Promise<Agent> {
  const agent = await Agent[how](party, optionsOf(party, over));
  opened.find((each) => each.party === party)!.agent = agent;
  return agent;
}

const fold = (party: MediatedParty): Promise<VaultFold> => scanVault(party.runtime.vault, party.keys);

function forwardsSeen(mediator: FakeMediator): number {
  return mediator.seenTypes.filter((type) => type === FORWARD).length;
}

afterEach(async () => {
  for (const { agent, party } of opened.splice(0)) {
    agent?.close();
    await party.runtime.close();
  }
});

describe("opening an agent", () => {
  it("records what the vault owed over an input a crash left unfollowed, lists the replies it still earns and calls nothing until each is completed by hand", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const bob = await partyOf(mediator, 2, BOB);
    const { invitation } = await disclose(alice.link, alice.runtime, alice.keys, ALICE, { as: "oob", uses: "one" });
    const bobAgent = await agentOf(bob, "start");
    const ping = await bobAgent.send(
      { channel: { localDid: bob.did, peerDid: alice.did }, recipientDid: invitation!.from },
      { type: PING_TYPE, body: { response_requested: true }, pthid: invitation!.id, pleaseAck: [""] },
      { messageId: PING }
    );
    expect(ping.dispatched).toMatchObject({ outcome: "submitted" });

    const receiver = new Receiver(alice.runtime, alice.keys, alice.ring, { didcomm, receipt: receiptOf(alice.runtime, alice.keys) });
    expect(await new Pickup(alice.link, receiver.pickupHandle(alice.mediationId)).drain()).toMatchObject({ acked: 1 });
    receiver.close();
    expect((await fold(alice)).set.of("invitation.consumed")).toHaveLength(0);

    const sentBefore = forwardsSeen(mediator);
    const agent = await agentOf(alice, "start");
    expect(agent.recovered.consumed).toHaveLength(1);
    expect(agent.connections()).toMatchObject([{ unreachable: null, drained: { acked: 0, ended: "empty" }, live: false }]);
    const recovered = await fold(alice);
    expect(recovered.outbound.outbounds.size).toBe(0);
    expect(forwardsSeen(mediator)).toBe(sentBefore);

    const { missingResponses } = await agent.pending();
    expect(missingResponses.map((owed) => [owed.effectType, owed.entries]).sort()).toEqual([
      [PING_RESPONSE_EFFECT, ["completeResponse"]],
      [PURE_ACK_EFFECT, ["completeResponse"]],
    ]);
    for (const owed of missingResponses) {
      expect(await agent.manual.completeResponse(owed.executionId, owed.effectType)).toMatchObject({ outcome: "created", action: { kind: "manual" }, dispatched: { outcome: "submitted" } });
    }
    expect(forwardsSeen(mediator)).toBe(sentBefore + 2);
    expect((await agent.pending()).missingResponses).toEqual([]);
  });

  it("lists an outbound committed and never called, and calls it only on a retry", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const bob = await partyOf(mediator, 2, BOB);
    await reconcile(alice.link, alice.runtime, alice.keys, alice.mediationId);
    const sent = await send(bob.runtime, bob.keys, { channel: { localDid: bob.did, peerDid: alice.did }, recipientDid: alice.longFormDid }, { type: BASIC_MESSAGE, body: { content: "hello" } });

    const agent = await agentOf(bob, "start");
    expect(forwardsSeen(mediator)).toBe(0);
    expect((await agent.outbounds()).map(({ outbound, waiting }) => [outbound.messageId, outbound.outcome.status, waiting])).toEqual([[sent.messageId, "queued", null]]);
    expect((await agent.pending()).pendingOutbounds.map((open) => open.messageId)).toEqual([sent.messageId]);

    expect(await agent.manual.retry(sent.messageId)).toMatchObject({ outcome: "submitted" });
    expect(forwardsSeen(mediator)).toBe(1);
    expect(await agent.outbounds()).toEqual([]);
  });

  it("starts with its mediator out of reach, says why, and connects once it is back", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    alice.offline.reason = "the network is down";
    const agent = await agentOf(alice, "start");
    expect(agent.connections()).toMatchObject([{ mediationId: alice.mediationId, unreachable: expect.stringContaining("the network is down"), drained: null }]);

    alice.offline.reason = null;
    expect(await agent.connect()).toMatchObject([{ unreachable: null, reconciled: { desired: [alice.did], refused: [] }, drained: { ended: "empty" } }]);
  });

  it("shows an arrangement whose mediator does not even resolve, and the same connection once it does", async () => {
    const alice = await freshVault(4);
    const trace = await AgentTrace.open(alice.runtime.local);
    const web = await webIdentity("did:web:mediator.example", 78, "https://mediator.example/didcomm");
    const { mediationId } = (await createMediation(alice.runtime, alice.keys, web.did as Did)).data;
    await alice.runtime.vault.commit([], [vaultDraft("mediation.granted", { mediationId, routingDid: (await newMediator()).did as Did })]);
    await selectMediation(alice.runtime, alice.keys, mediationId);
    let offline = true;
    const fetch: typeof globalThis.fetch = async (input) => {
      if (offline) throw new Error("the network is down");
      return String(input) === "https://mediator.example/.well-known/did.json" ? json(web.document) : new Response(null, { status: 503 });
    };
    const log: string[] = [];
    const agent = await Agent.start(alice, { didcomm, fetch, trace, liveDelivery: false, log: (line) => log.push(line) });
    try {
      expect(agent.connections()).toMatchObject([{ mediationId, unreachable: expect.stringContaining("does not resolve"), reconciled: null, live: false }]);
      expect(log.filter((line) => line.includes(mediationId))).toHaveLength(1);

      offline = false;
      await agent.connect();
      const [connection, ...others] = agent.connections();
      expect(others).toEqual([]);
      expect(connection).toMatchObject({ mediationId, unreachable: expect.not.stringContaining("does not resolve") });
    } finally {
      agent.close();
      await alice.runtime.close();
    }
  });

  it("connects to a mediator that answers under its short form, over HTTP and down the socket", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const bob = await partyOf(mediator, 2, BOB);
    mediator.answerAsShortForm = true;
    const inbounds: Inbound[] = [];
    const agent = await agentOf(alice, "start", { liveDelivery: true, onInbound: (inbound) => inbounds.push(inbound) });
    expect(agent.connections()).toMatchObject([{ unreachable: null, reconciled: { desired: [alice.did] }, drained: { ended: "empty" }, live: true }]);

    const bobAgent = await agentOf(bob, "start");
    const sent = await bobAgent.send({ channel: { localDid: bob.did, peerDid: alice.did }, recipientDid: alice.longFormDid }, { type: BASIC_MESSAGE, body: { content: "hello" } });
    expect(sent.dispatched).toMatchObject({ outcome: "submitted" });
    await until("the frame pushed under the short form is followed", () => inbounds.length === 1, 10_000);
    expect(inbounds[0]!.received).toMatchObject({ outcome: "received", live: true });
  });

  it("picks up what was queued between its pickup and live delivery coming on", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const bob = await partyOf(mediator, 2, BOB);
    await reconcile(alice.link, alice.runtime, alice.keys, alice.mediationId);
    const bobAgent = await agentOf(bob, "start");
    await bobAgent.send({ channel: { localDid: bob.did, peerDid: alice.did }, recipientDid: alice.longFormDid }, { type: BASIC_MESSAGE, body: { content: "hello" } });
    const queue = mediator.queues.get(alice.created.data.me.did)!;
    const [missed] = queue.splice(0);

    const inbounds: Inbound[] = [];
    const agent = await agentOf(alice, "start", { liveDelivery: true, onInbound: (inbound) => inbounds.push(inbound) });
    expect(agent.connections()).toMatchObject([{ drained: { acked: 0, ended: "empty" }, live: true }]);
    let tell = (): void => undefined;
    const told = new Promise<void>((resolve) => (tell = resolve));
    mediator.intercept = async (msg) => {
      if (msg.type === MESSAGES_RECEIVED) await told;
      return undefined;
    };
    queue.push(missed!);
    await until("the message queued before live delivery came on is followed", () => inbounds.length === 1, 10_000);
    expect(agent.connections()).toMatchObject([{ drained: { acked: 0 } }]);

    tell();
    await until("the pickup that followed it has ended", () => agent.connections()[0]!.drained?.acked === 1, 10_000);
    expect(agent.connections()).toMatchObject([{ drained: { acked: 1, ended: "empty" } }]);
    expect(inbounds).toHaveLength(1);
  });

  it("closes the agent a start could not connect at all, leaving the runtime to another", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const events = alice.runtime.vault.events;
    const scan = events.scan;
    let scans = 0;
    let failAt = Infinity;
    events.scan = async function* (this: typeof events, ...args: Parameters<typeof scan>) {
      scans += 1;
      if (scans === failAt) throw new Error("the disk does not read for now");
      yield* scan.apply(this, args);
    } as typeof scan;
    try {
      (await Agent.open(alice, optionsOf(alice))).close();
      failAt = scans * 2 + 1;
      await expect(Agent.start(alice, optionsOf(alice))).rejects.toThrow("the disk does not read for now");
    } finally {
      events.scan = scan;
    }
    expect((await agentOf(alice, "start")).connections()).toMatchObject([{ unreachable: null }]);
  });

  it("keeps what a reconciliation found at the mediator and cannot account for on show after the next one no longer finds it, up to a bound", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    mediator.recipients.set("did:peer:2.Ez6unknown", alice.created.data.me.did);
    const agent = await agentOf(alice, "start");
    expect(agent.connections()).toMatchObject([{ reconciled: { unknown: ["did:peer:2.Ez6unknown"], desired: [alice.did] }, unknownRegistrations: ["did:peer:2.Ez6unknown"] }]);
    expect([...mediator.recipients.keys()]).toEqual([alice.did]);

    for (let i = 0; i < UNKNOWN_REGISTRATIONS_KEPT + 4; i++) mediator.recipients.set(`did:peer:2.Ez6more${i}`, alice.created.data.me.did);
    await agent.connect();
    await agent.connect();
    const [connection] = agent.connections();
    expect(connection!.reconciled!.unknown).toEqual([]);
    expect(connection!.unknownRegistrations).toHaveLength(UNKNOWN_REGISTRATIONS_KEPT);
    expect(connection!.unknownRegistrations[0]).toBe("did:peer:2.Ez6unknown");
    expect((await fold(alice)).routes.dids.size).toBe(1);
  });

  it("keeps what it cannot account for whichever reconciliation found it, a grant's or a disclosure's as much as a connection's, and one the mediator would not take off beside the refusal", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const agent = await agentOf(alice, "open");
    const unknown = (name: string): Did => {
      const did = `did:peer:2.Ez6${name}` as Did;
      mediator.recipients.set(did, alice.created.data.me.did);
      return did;
    };

    const atGrant = unknown("atGrant");
    await agent.establish(alice.mediationId);
    expect(mediator.recipients.has(atGrant)).toBe(false);
    expect(agent.connections()).toMatchObject([{ reconciled: { unknown: [] }, unknownRegistrations: [atGrant] }]);

    const atDisclosure = unknown("atDisclosure");
    await agent.disclose(alice.didId, { as: "oob", uses: "many" });
    expect(mediator.recipients.has(atDisclosure)).toBe(false);
    expect(agent.connections()[0]!.unknownRegistrations).toEqual([atGrant, atDisclosure]);

    const kept = unknown("kept");
    mediator.refuse.add(kept);
    await agent.connect();
    expect(mediator.recipients.has(kept)).toBe(true);
    expect(agent.connections()).toMatchObject([{ reconciled: { unknown: [kept], removed: [], refused: [kept] }, unknownRegistrations: [atGrant, atDisclosure, kept] }]);
  });

  it("is the one agent of its runtime until it is closed", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const first = await agentOf(alice, "open");
    await expect(Agent.open(alice, optionsOf(alice))).rejects.toBeInstanceOf(ReceiverInUse);
    first.close();
    const second = await agentOf(alice, "open");
    await expect(first.send({ channel: { localDid: alice.did, peerDid: alice.did } }, { type: BASIC_MESSAGE, body: {} })).rejects.toThrow("the agent is closed");
    expect(second.connections()).toEqual([]);
  });
});

describe("a live input", () => {
  it("is an input once: recorded by a runtime that never followed it, it comes again from the mediator, under another delivery and posted straight, earning nothing; an input never seen is answered", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const bob = await partyOf(mediator, 2, BOB);
    await reconcile(alice.link, alice.runtime, alice.keys, alice.mediationId);
    const bobAgent = await agentOf(bob, "start");
    const forwards: IMessage[] = [];
    let cut = true;
    mediator.intercept = (msg, from) => {
      if (msg.type === FORWARD) forwards.push(msg);
      if (!cut || msg.type !== MESSAGES_RECEIVED) return undefined;
      cut = false;
      return mediator.reply(PROBLEM_REPORT, from as string, { code: "e.p.busy" }, msg.id);
    };
    const target = { channel: { localDid: bob.did, peerDid: alice.did }, recipientDid: alice.longFormDid };
    await bobAgent.send(target, { type: PING_TYPE, body: { response_requested: true }, pleaseAck: [""] }, { messageId: PING });
    const packed = JSON.stringify((forwards[0]!.attachments as unknown as { data: { json: unknown } }[])[0]!.data.json);

    const receiver = new Receiver(alice.runtime, alice.keys, alice.ring, { didcomm, receipt: receiptOf(alice.runtime, alice.keys) });
    expect(await new Pickup(alice.link, receiver.pickupHandle(alice.mediationId)).drain()).toMatchObject({ acked: 0, ended: "left" });
    receiver.close();

    const inbounds: Inbound[] = [];
    const sentBefore = forwards.length;
    const agent = await agentOf(alice, "start", { onInbound: (inbound) => inbounds.push(inbound) });
    expect(agent.connections()).toMatchObject([{ drained: { acked: 1, ended: "empty" } }]);
    mediator.queues.get(alice.created.data.me.did)!.push({ id: "again", packed });
    await agent.connect();
    await agent.receive(packed);
    await agent.settled();
    expect(inbounds.map(({ received, reacted, address }) => [received.outcome === "received" && received.live, reacted, address])).toEqual([
      [false, null, null],
      [false, null, null],
      [false, null, null],
    ]);
    const told = await fold(alice);
    expect(told.set.of("message.in")).toHaveLength(4);
    expect(told.inbound.executions.size).toBe(1);
    expect(told.outbound.outbounds.size).toBe(0);
    expect(forwards).toHaveLength(sentBefore);
    expect((await agent.pending()).missingResponses.map((owed) => owed.effectType).sort()).toEqual([PING_RESPONSE_EFFECT, PURE_ACK_EFFECT]);

    await bobAgent.send(target, { type: PING_TYPE, body: { response_requested: true } }, { messageId: PING_AGAIN });
    await agent.connect();
    await agent.settled();
    expect(inbounds[3]).toMatchObject({ received: { live: true }, reacted: { effects: [{ effectType: PING_RESPONSE_EFFECT, outcome: "created", dispatched: { outcome: "submitted" } }] } });
    expect(forwards).toHaveLength(sentBefore + 2);
  });

  it("is followed step by step, a step that fails leaving the others done and the pass a reply's preparation runs over the resolution it commits noted where it stops too; a repeated delivery completes local recovery without repeating automatic effects", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const bob = await partyOf(mediator, 2, BOB);
    const { invitation } = await disclose(alice.link, alice.runtime, alice.keys, ALICE, { as: "oob", uses: "one" });
    const bobAgent = await agentOf(bob, "start");
    await bobAgent.send(
      { channel: { localDid: bob.did, peerDid: alice.did }, recipientDid: invitation!.from },
      { type: PING_TYPE, body: { response_requested: true }, pthid: invitation!.id, pleaseAck: [""] },
      { messageId: PING }
    );

    const inbounds: Inbound[] = [];
    const log: string[] = [];
    const agent = await agentOf(alice, "open", { onInbound: (inbound) => inbounds.push(inbound), log: (line) => log.push(line) });
    refuseCommits(alice.runtime, "invitation.consumed", 2);
    let cut = true;
    mediator.intercept = (msg, from) => {
      if (!cut || msg.type !== MESSAGES_RECEIVED) return undefined;
      cut = false;
      return mediator.reply(PROBLEM_REPORT, from as string, { code: "e.p.busy" }, msg.id);
    };

    expect(await agent.connect()).toMatchObject([{ drained: { acked: 0, ended: "left" } }]);
    await agent.settled();
    expect(inbounds).toHaveLength(1);
    expect(inbounds[0]).toMatchObject({ received: { outcome: "received", live: true }, after: null, reacted: { effects: [{ outcome: "created" }, { outcome: "created" }] } });
    expect(log.filter((line) => line.includes("what the vault owes"))).toHaveLength(1);
    expect((await alice.trace.read({ type: "diag.admission" })).map((entry) => entry.data)).toEqual([{ resolutionEventCid: expect.any(String), reason: "the pass over the resolution stopped: the disk is full for now" }]);
    expect((await fold(alice)).set.of("invitation.consumed")).toHaveLength(0);

    const sentBefore = forwardsSeen(mediator);
    expect(await agent.connect()).toMatchObject([{ drained: { acked: 1, ended: "empty" } }]);
    await agent.settled();
    expect(inbounds[1]).toMatchObject({ received: { ...inbounds[0]!.received, live: false }, after: { consumed: [expect.anything()] }, reacted: null, address: null });
    const told = await fold(alice);
    expect(told.set.of("message.in")).toHaveLength(1);
    expect(told.set.of("invitation.consumed")).toHaveLength(1);
    expect(forwardsSeen(mediator)).toBe(sentBefore);
  });

  it("takes the later delivery of a batch while the earlier one's automatic output is still on the wire: each receipt and admission in the order the mail came, the mediator told once the batch is handled, and the calls made in that order after", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const bob = await partyOf(mediator, 2, BOB);
    await reconcile(alice.link, alice.runtime, alice.keys, alice.mediationId);
    const bobAgent = await agentOf(bob, "start");
    const target = { channel: { localDid: bob.did, peerDid: alice.did }, recipientDid: alice.longFormDid };
    for (const messageId of [PING, PING_AGAIN]) expect((await bobAgent.send(target, { type: BASIC_MESSAGE, body: { content: "hello" }, pleaseAck: [""] }, { messageId })).dispatched).toMatchObject({ outcome: "submitted" });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const forwards: string[] = [];
    mediator.intercept = async (msg) => {
      if (msg.type !== FORWARD) return undefined;
      forwards.push(msg.id);
      await held;
      return undefined;
    };

    const inbounds: Inbound[] = [];
    const agent = await agentOf(alice, "start", { onInbound: (inbound) => inbounds.push(inbound) });
    expect(agent.connections()).toMatchObject([{ drained: { acked: 2, ended: "empty" } }]);
    const taken = await fold(alice);
    expect(taken.set.of("message.in").map(({ data }) => data.receiptOrdinal)).toEqual(["1", "2"]);
    expect(taken.set.of("message.admitted").map(({ data }) => data.sourceEventCid)).toEqual(taken.set.of("message.in").map(({ cid }) => cid));
    expect(taken.set.of("message.out")).toHaveLength(2);
    await until("the first receipt is on the wire", () => forwards.length === 1);
    expect(inbounds).toEqual([]);

    release();
    await agent.settled();
    expect(inbounds.map(({ received, reacted }) => [received.outcome === "received" && received.live, reacted!.effects.map((effect) => [effect.effectType, effect.outcome, effect.outcome === "created" && effect.dispatched.outcome])])).toEqual([
      [true, [[PURE_ACK_EFFECT, "created", "submitted"]]],
      [true, [[PURE_ACK_EFFECT, "created", "submitted"]]],
    ]);
    expect(forwards).toHaveLength(2);
  });

  it("is told of evidence the host recovered: the issuer's document a carrier's proof waited for admits the carrier then, dispatching nothing, and the reply it earns is listed for the user", async () => {
    const mediator = await newMediator();
    const alice = await partyOf(mediator, 1, ALICE);
    const bob = await partyOf(mediator, 2, BOB);
    const routeId = (await fold(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const signing = await bob.keys.signing(didKeyName(BOB_PRIOR, "authentication"));
    const proof = await new SignJWT({ iss: prior.did, sub: bob.longFormDid, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: `${prior.did}${AUTHENTICATION_METHOD}` }).sign(await importJWK(signing.privateJwk(), "EdDSA"));
    const receiver = new Receiver(alice.runtime, alice.keys, alice.ring, { didcomm, receipt: receiptOf(alice.runtime, alice.keys) });
    const carried = await receiver.receive({ packed: await sealed(await peerSealer(bob), alice.longFormDid, { type: PING_TYPE, body: { response_requested: true }, from_prior: proof }), source: { kind: "direct" } });
    receiver.close();
    if (carried.outcome !== "received") throw new Error("not received");

    const agent = await agentOf(alice, "open");
    expect([agent.recovered.admitted, (await fold(alice)).dispositions.disposition(carried.cid)]).toEqual([[], { status: "pending-admission", because: "the source's proof is not yet verified" }]);
    const answer = await resolve(prior.longFormDid, () => null);
    if (answer.outcome !== "resolved") throw new Error(answer.reason);
    const [peerPublicKey] = authorizedKeys(answer.resolution, "keyAgreement").values();
    await commitResolution(alice.runtime, { resolution: answer.resolution, localKeyName: didKeyName(ALICE, "key-agreement"), peerPublicKey: peerPublicKey as PublicKey });
    expect((await fold(alice)).dispositions.disposition(carried.cid)).toEqual({ status: "pending-admission", because: "the observation is not yet reconciled" });

    expect(await agent.localStateChanged()).toEqual([]);
    const told = await fold(alice);
    expect([told.continuity.status(carried.cid), told.dispositions.disposition(carried.cid).status, told.inbound.ofSource(carried.cid)!.status, told.set.of("message.out")]).toEqual([{ status: "verified" }, "admitted", { status: "complete" }, []]);
    expect(forwardsSeen(mediator)).toBe(0);
    expect((await agent.pending()).missingResponses.map((owed) => owed.effectType)).toEqual([PING_RESPONSE_EFFECT]);
  });
});
