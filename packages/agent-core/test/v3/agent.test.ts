import { afterEach, describe, expect, it } from "vitest";

import { PING_RESPONSE_EFFECT, PING_TYPE, PURE_ACK_EFFECT, scanVault, type DidId, type MessageId, type VaultFold } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { MESSAGES_RECEIVED } from "../../src/protocol/mediation.js";
import { FORWARD, PROBLEM_REPORT } from "../../src/protocol/spec.js";
import { Agent, Pickup, Receiver, ReceiverInUse, disclose, receiptOf, reconcile, send, type AgentOptions, type Inbound } from "../../src/v3/index.js";
import type { FakeMediator } from "../fake-mediator.js";
import { didcomm, mediatedParty, newMediator, refuseCommits, type MediatedParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const PING = "019b0000-0000-7000-8000-000000000101" as MessageId;

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
  it("is followed step by step, a step that fails leaving the others done; the same delivery only told again is followed by nothing", async () => {
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
    refuseCommits(alice.runtime, "invitation.consumed", 1);
    let cut = true;
    mediator.intercept = (msg, from) => {
      if (!cut || msg.type !== MESSAGES_RECEIVED) return undefined;
      cut = false;
      return mediator.reply(PROBLEM_REPORT, from as string, { code: "e.p.busy" }, msg.id);
    };

    expect(await agent.connect()).toMatchObject([{ drained: { acked: 0, ended: "left" } }]);
    expect(inbounds).toHaveLength(1);
    expect(inbounds[0]).toMatchObject({ received: { outcome: "received", live: true }, after: null, reacted: { effects: [{ outcome: "created" }, { outcome: "created" }] } });
    expect(log.filter((line) => line.includes("what the vault owes"))).toHaveLength(1);
    expect((await fold(alice)).set.of("invitation.consumed")).toHaveLength(0);

    const sentBefore = forwardsSeen(mediator);
    expect(await agent.connect()).toMatchObject([{ drained: { acked: 1, ended: "empty" } }]);
    expect(inbounds[1]).toEqual({ received: { ...inbounds[0]!.received, live: false }, after: null, reacted: null, address: null });
    const told = await fold(alice);
    expect(told.set.of("message.in")).toHaveLength(1);
    expect(forwardsSeen(mediator)).toBe(sentBefore);

    agent.close();
    expect((await agentOf(alice, "open")).recovered.consumed).toHaveLength(1);
  });
});
