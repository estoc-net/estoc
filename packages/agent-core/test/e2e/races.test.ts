import { afterEach, describe, expect, it } from "vitest";

import { channelKey, type DidId, type MessageId } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { newMediator } from "../helpers.js";
import { LONG, channelOf, foldOf, run, stopAll, until } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const FROM_ALICE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const FROM_BOB = "019b0000-0000-7000-8000-000000000102" as MessageId;
const FROM_CAROL = "019b0000-0000-7000-8000-000000000103" as MessageId;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

describe("first messages that race", () => {
  it("two peers answer one one-use invitation: the first received consumes it, the other is an input all the same, and each peer is given a private successor of its own", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { liveDelivery: false });
    const bob = await run(mediator, 2, BOB);
    const carol = await run(mediator, 3, CAROL);
    const a0 = alice.party.did;
    const { invitation } = await alice.agent.disclose(ALICE, { as: "oob", uses: "one" });

    for (const [peer, messageId] of [
      [bob, FROM_BOB],
      [carol, FROM_CAROL],
    ] as const) {
      const sent = await peer.agent.send({ channel: channelOf(peer.party.did, a0), recipientDid: invitation!.from }, { ...hello("hello"), pthid: invitation!.id, pleaseAck: [""] }, { messageId });
      expect(sent.dispatched).toMatchObject({ outcome: "submitted" });
    }
    // Both wait at the mediator, in the order it took them; the pickup that finds them may also find what the peers answer meanwhile.
    expect(await alice.agent.connect()).toMatchObject([{ unreachable: null, drained: { ended: "empty" } }]);
    await alice.agent.settled();
    expect(alice.inbounds.slice(0, 2).map(({ received, after, address }) => [received.outcome === "received" && received.live, after!.consumed.length, address!.outcome])).toEqual([
      [true, 1, "rotated"],
      [true, 0, "rotated"],
    ]);

    const ofAlice = await foldOf(alice);
    expect((await alice.agent.records()).invitations()).toMatchObject([{ oobId: invitation!.id, uses: "one", state: { status: "consumed" }, consumer: bob.party.did }]);
    expect(ofAlice.set.of("invitation.consumed")).toHaveLength(1);
    expect([...ofAlice.inbound.executions.values()].filter((execution) => execution.kind === "application").map((execution) => [execution.channel.peerDid, execution.status.status])).toEqual([
      [bob.party.did, "complete"],
      [carol.party.did, "complete"],
    ]);
    const decisions = ofAlice.set.of("did.rotationSelected").map((decision) => decision.data);
    expect(decisions.map((decision) => [decision.fromDidId, decision.peerDid])).toEqual([
      [ALICE, bob.party.did],
      [ALICE, carol.party.did],
    ]);
    expect(new Set(decisions.map((decision) => decision.toDidId)).size).toBe(2);

    for (const [peer, decision] of [
      [bob, decisions[0]!],
      [carol, decisions[1]!],
    ] as const) {
      await until("the peer has its acknowledgement and the notification", () => peer.inbounds.length === 2);
      const successor = ofAlice.routes.dids.get(decision.toDidId)!.created!.did;
      const fold = await foldOf(peer);
      expect(fold.outbound.outbounds.get(peer === bob ? FROM_BOB : FROM_CAROL)).toMatchObject({ acknowledged: true });
      expect(fold.continuity.head(channelOf(peer.party.did, a0))).toEqual(channelOf(peer.party.did, successor));
    }
  });

  it("each side writes first to the other at once: both end with the one channel of the pair, each message an established input acknowledged to its sender", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { liveDelivery: false });
    const bob = await run(mediator, 2, BOB, { liveDelivery: false });
    const a0 = alice.party.did;
    const b0 = bob.party.did;

    const sent = await Promise.all([
      alice.agent.send({ channel: channelOf(a0, b0), recipientDid: bob.party.longFormDid }, { ...hello("hello bob"), pleaseAck: [""] }, { messageId: FROM_ALICE }),
      bob.agent.send({ channel: channelOf(b0, a0), recipientDid: alice.party.longFormDid }, { ...hello("hello alice"), pleaseAck: [""] }, { messageId: FROM_BOB }),
    ]);
    expect(sent).toMatchObject([{ dispatched: { outcome: "submitted" } }, { dispatched: { outcome: "submitted" } }]);
    await Promise.all([alice.agent.connect(), bob.agent.connect()]);
    await Promise.all([alice.agent.settled(), bob.agent.settled()]);
    await Promise.all([alice.agent.connect(), bob.agent.connect()]);
    await Promise.all([alice.agent.settled(), bob.agent.settled()]);

    for (const [party, mine, channel] of [
      [alice, FROM_ALICE, channelOf(a0, b0)],
      [bob, FROM_BOB, channelOf(b0, a0)],
    ] as const) {
      expect(party.inbounds.map(({ received }) => received.outcome === "received" && received.live)).toEqual([true, true]);
      const fold = await foldOf(party);
      expect((await party.agent.records()).channels().map(channelKey)).toEqual([channelKey(channel)]);
      expect(fold.continuity.model.history(channel).links).toEqual([]);
      expect(fold.set.of("did.rotationSelected")).toEqual([]);
      const view = fold.views.channel(channel);
      expect(view.inbound.map((execution) => [execution.kind, execution.status.status]).sort()).toEqual([
        ["application", "complete"],
        ["pure-ack", "complete"],
      ]);
      expect(fold.outbound.outbounds.get(mine)).toMatchObject({ outcome: { status: "submitted" }, acknowledged: true });
    }
  });
});
