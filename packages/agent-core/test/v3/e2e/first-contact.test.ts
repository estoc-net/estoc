import { afterEach, describe, expect, it } from "vitest";

import { PING_RESPONSE_EFFECT, PING_TYPE, PURE_ACK_EFFECT, kindOf, scanVault, type DidId, type MessageId, type VaultFold } from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../../src/protocol/basicmessage.js";
import type { IMessage } from "../../../src/protocol/didcomm.js";
import { FORWARD } from "../../../src/protocol/spec.js";
import { Agent, type AgentOptions, type Inbound } from "../../../src/v3/index.js";
import type { FakeMediator } from "../../fake-mediator.js";
import { didcomm, mediatedParty, newMediator, until as untilWithin, type MediatedParty } from "../helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const PING = "019b0000-0000-7000-8000-000000000101" as MessageId;
const HELLO = "019b0000-0000-7000-8000-000000000102" as MessageId;

interface Running {
  party: MediatedParty;
  agent: Agent;
  inbounds: Inbound[];
  /** the next call to the mediator is answered 503 instead of reaching it */
  refuseNext: { armed: boolean };
}

/** What is waited for here is a whole receipt with everything that follows it, several commits and transport calls on a machine that may be busy with other suites. */
const until = (what: string, condition: () => boolean): Promise<void> => untilWithin(what, condition, 10_000);

const running: Running[] = [];

async function run(mediator: FakeMediator, fill: number, didId: DidId, over: Partial<AgentOptions> = {}): Promise<Running> {
  const party = await mediatedParty(mediator, fill, didId);
  const inbounds: Inbound[] = [];
  const refuseNext = { armed: false };
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (!refuseNext.armed) return mediator.fetch(input, init);
    refuseNext.armed = false;
    return Promise.resolve(new Response(null, { status: 503 }));
  };
  const agent = await Agent.start(party, { didcomm, fetch, WebSocket: mediator.WebSocket, trace: party.trace, privateAddresses: false, onInbound: (inbound) => inbounds.push(inbound), ...over });
  const started = { party, agent, inbounds, refuseNext };
  running.push(started);
  return started;
}

const fold = ({ party }: Running): Promise<VaultFold> => scanVault(party.runtime.vault, party.keys);

afterEach(async () => {
  for (const { agent, party } of running.splice(0)) {
    agent.close();
    await party.runtime.close();
  }
});

describe("first contact over a mediator", () => {
  it("a Ping to a one-use invitation is consumed, answered and acknowledged once, however often it is delivered; a refused call is made again only by a retry, with the same package", async () => {
    const mediator = await newMediator();
    const forwards: IMessage[] = [];
    mediator.intercept = (msg) => {
      if (msg.type === FORWARD) forwards.push(msg);
      return undefined;
    };
    const alice = await run(mediator, 1, ALICE);
    const bob = await run(mediator, 2, BOB);
    expect(alice.agent.connections()).toMatchObject([{ unreachable: null, drained: { ended: "empty" }, live: true }]);

    const { invitation } = await alice.agent.disclose(ALICE, { as: "oob", uses: "one" });
    const ping = await bob.agent.send(
      { channel: { localDid: bob.party.did, peerDid: alice.party.did }, recipientDid: invitation!.from },
      { type: PING_TYPE, body: { response_requested: true }, pthid: invitation!.id, pleaseAck: [""] },
      { messageId: PING }
    );
    expect(ping.dispatched).toMatchObject({ outcome: "submitted" });

    await until("alice has followed the Ping", () => alice.inbounds.length === 1);
    const [first] = alice.inbounds;
    expect(first!.received).toMatchObject({ outcome: "received", live: true });
    expect(first!.after!.consumed).toHaveLength(1);
    const effects = first!.reacted!.effects;
    expect(effects.map((effect) => [effect.effectType, effect.outcome])).toEqual([
      [PURE_ACK_EFFECT, "created"],
      [PING_RESPONSE_EFFECT, "created"],
    ]);
    for (const effect of effects) expect(effect).toMatchObject({ action: { kind: "initial", spent: true }, dispatched: { outcome: "submitted" } });

    const ofAlice = await fold(alice);
    expect([...ofAlice.invitations.invitations.values()].map((each) => each.status.status)).toEqual(["consumed"]);
    const outputs = [...ofAlice.outbound.outbounds.values()];
    expect(outputs.map((output) => [output.intent.status, output.outcome.status])).toEqual([
      ["consistent", "submitted"],
      ["consistent", "submitted"],
    ]);
    const reply = outputs.find((output) => output.intents[0]!.data.effectType === PING_RESPONSE_EFFECT)!;
    expect(reply.intents[0]!.data).toMatchObject({ thid: PING, ack: [], pleaseAck: null });
    const receipt = outputs.find((output) => output.intents[0]!.data.effectType === PURE_ACK_EFFECT)!;
    expect(receipt.intents[0]!.data.ack).toEqual([PING]);

    await until("bob has followed both of alice's outputs", () => bob.inbounds.length === 2);
    const ofBob = await fold(bob);
    expect([...ofBob.inbound.executions.values()].map((execution) => execution.kind).sort()).toEqual(["ping-response", "pure-ack"]);
    const pinged = ofBob.outbound.outbounds.get(PING)!;
    expect(pinged).toMatchObject({ outcome: { status: "submitted" }, acknowledged: true });
    expect(pinged.acknowledgements.map(({ event }) => event.data.ackMessageId)).toEqual([[...ofBob.inbound.executions.values()].find((execution) => execution.kind === "pure-ack")!.messageId]);
    expect(bob.inbounds.flatMap((inbound) => inbound.reacted!.effects.filter((effect) => effect.outcome === "created"))).toEqual([]);

    const envelope = (forwards[0]!.attachments as unknown as { data: { json: unknown } }[])[0]!.data.json;
    const sentBefore = forwards.length;
    mediator.queues.get(alice.party.created.data.me.did)!.push({ id: "again", packed: JSON.stringify(envelope) });
    expect(await alice.agent.connect()).toMatchObject([{ drained: { acked: 1, ended: "empty" } }]);
    expect(alice.inbounds).toHaveLength(2);
    expect(alice.inbounds[1]).toMatchObject({ received: { outcome: "received", live: false }, reacted: null, address: null });
    const again = await fold(alice);
    expect(again.set.of("message.in")).toHaveLength(2);
    expect(again.inbound.executions.size).toBe(1);
    expect(again.outbound.outbounds.size).toBe(2);
    expect(forwards).toHaveLength(sentBefore);

    bob.refuseNext.armed = true;
    const hello = await bob.agent.send({ channel: ping.channel }, { type: BASIC_MESSAGE, body: { content: "hello" } }, { messageId: HELLO });
    expect(hello.dispatched).toMatchObject({ outcome: "failed" });
    expect(hello.action.spent).toBe(true);
    expect(forwards).toHaveLength(sentBefore);
    const waiting = await bob.agent.outbounds();
    expect(waiting.map(({ outbound, waiting }) => [outbound.messageId, outbound.outcome.status, waiting])).toEqual([[HELLO, "prepared", null]]);
    const packageId = waiting[0]!.outbound.package!.event.data.packageId;

    const retried = await bob.agent.manual.retry(HELLO);
    expect(retried).toMatchObject({ outcome: "submitted", packageId });
    expect(forwards.at(-1)!.id).toBe(packageId);
    await until("alice has the message", () => alice.inbounds.length === 3);
    const last = await fold(alice);
    expect([...last.inbound.executions.values()].map((execution) => kindOf(execution.members[0]!.source.event.data)).sort()).toEqual(["application", "application"]);
    expect(await bob.agent.outbounds()).toEqual([]);
  });
});
