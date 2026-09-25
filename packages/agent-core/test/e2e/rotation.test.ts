import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_MESSAGE_TYPE, ROTATION_NOTIFICATION_EFFECT, channelKey, type Channel, type Did, type DidId, type MessageId, type Outbound, type VaultFold } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { Unusable, type Rotated } from "../../src/index.js";
import { newMediator } from "../helpers.js";
import { LONG, channelOf, foldOf, run, stopAll, until, type Running } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const FIRST = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const THIRD = "019b0000-0000-7000-8000-000000000103" as MessageId;
const FOURTH = "019b0000-0000-7000-8000-000000000105" as MessageId;
const FIFTH = "019b0000-0000-7000-8000-000000000106" as MessageId;
const OLD_ADDRESS = "019b0000-0000-7000-8000-000000000104" as MessageId;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

const didOf = (fold: VaultFold, didId: DidId): Did => fold.routes.dids.get(didId)!.created!.did;

/** Every link of the positive history, from every pair a fact mentions, as comparable rows: from, to, the side replaced, whether it is usable. */
const links = (fold: VaultFold): string[][] => {
  const rows = new Map<string, string[]>();
  for (const fact of fold.continuity.facts) {
    for (const link of fold.continuity.model.history(fact.at).links) {
      const row = [channelKey(link.from as Channel), channelKey(link.to as Channel), link.replaces, String(link.usable)];
      rows.set(`${row[0]} ${row[1]}`, row);
    }
  }
  return [...rows.values()].sort();
};

const packageOf = (output: Outbound) => output.package!.event.data;

const carriesProof = (output: Outbound): boolean => packageOf(output).fromPrior !== null;

describe("rotation between two agents", () => {
  it("the first message to a disclosed address selects a private successor, announced under a proof the peer verifies and answers; once the peer wrote there the proof is dropped, the old address takes only an explicit send, and the peer's own rotation moves the head again", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE);
    const bob = await run(mediator, 2, BOB);
    const a0 = alice.party.did;
    const b0 = bob.party.did;
    const { invitation } = await alice.agent.disclose(ALICE, { as: "oob", uses: "one" });

    const first = await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: invitation!.from }, { ...hello("hello"), pthid: invitation!.id }, { messageId: FIRST });
    expect(first.dispatched).toMatchObject({ outcome: "submitted" });
    await until("alice has followed the first message", () => alice.inbounds.length === 1);
    const address = alice.inbounds[0]!.address!;
    expect(address).toMatchObject({ outcome: "rotated", rotation: { existed: false, notification: { effectType: ROTATION_NOTIFICATION_EFFECT, outcome: "created", action: { kind: "initial" }, dispatched: { outcome: "submitted" } } } });
    if (address.outcome !== "rotated") throw new Error("unreachable");
    const a1 = didOf(await foldOf(alice), address.rotation.successor);
    expect(address.rotation.decision.data).toMatchObject({ fromDidId: ALICE, peerDid: b0, sourceEventCid: alice.inbounds[0]!.received.outcome === "received" ? alice.inbounds[0]!.received.cid : null });

    await until("bob has followed the notification", () => bob.inbounds.length === 1);
    expect(bob.inbounds[0]).toMatchObject({ received: { outcome: "received", live: true }, after: { proof: { status: "verified" } }, reacted: { effects: [{ outcome: "created", dispatched: { outcome: "submitted" } }] }, address: { outcome: "none" } });
    const ofBob = await foldOf(bob);
    expect(links(ofBob)).toEqual([[channelKey(channelOf(b0, a0)), channelKey(channelOf(b0, a1)), "peer", "true"]]);
    expect(ofBob.continuity.head(channelOf(b0, a0))).toEqual(channelOf(b0, a1));

    await until("alice has followed bob's acknowledgement", () => alice.inbounds.length === 2);
    const ofAlice = await foldOf(alice);
    expect(links(ofAlice)).toEqual([[channelKey(channelOf(a0, b0)), channelKey(channelOf(a1, b0)), "local", "true"]]);
    expect(ofAlice.continuity.confirmed(a1, b0)).toBe(true);
    const [notification] = [...ofAlice.outbound.outbounds.values()];
    expect(notification!.intents[0]!.data).toMatchObject({ msgType: EMPTY_MESSAGE_TYPE, senderDidId: address.rotation.successor, recipientDid: b0, pleaseAck: [""], ack: [] });
    expect(notification).toMatchObject({ acknowledged: true });
    expect(packageOf(notification!).fromPrior === address.rotation.decision.data.fromPrior).toBe(true);

    const second = await alice.agent.send({ channel: channelOf(a1, b0) }, hello("from my private address"), { messageId: SECOND });
    expect(second.dispatched).toMatchObject({ outcome: "submitted" });
    expect(packageOf((await foldOf(alice)).outbound.outbounds.get(SECOND)!)).toMatchObject({ fromPrior: null, recipientDid: b0 });
    await until("bob has the message from the private address", () => bob.inbounds.length === 2);
    expect(bob.inbounds[1]).toMatchObject({ received: { live: true }, after: { proof: { status: "not-present" } } });

    await expect(bob.agent.send({ channel: channelOf(b0, a0) }, hello("to the old address"))).rejects.toBeInstanceOf(Unusable);
    const old = await bob.agent.send({ channel: channelOf(b0, a0), preRotation: true }, hello("to the old address"), { messageId: OLD_ADDRESS });
    expect(old.dispatched).toMatchObject({ outcome: "submitted" });
    await until("alice has the message at the old address", () => alice.inbounds.length === 3);
    expect(alice.inbounds[2]).toMatchObject({ received: { outcome: "received", live: true }, address: { outcome: "reused" } });
    const replaced = await foldOf(alice);
    expect(replaced.set.of("did.rotationSelected")).toHaveLength(1);
    expect(replaced.outbound.outbounds.size).toBe(2);

    const rotated = await bob.agent.manual.rotate({ localDidId: BOB, peerDid: a1 });
    expect(rotated).toMatchObject({ existed: false, notification: { outcome: "created", dispatched: { outcome: "submitted" } } });
    const b1 = didOf(await foldOf(bob), rotated.successor);
    await until("alice has followed bob's notification", () => alice.inbounds.length === 4);
    expect(alice.inbounds[3]).toMatchObject({ after: { proof: { status: "verified" } }, reacted: { effects: [{ outcome: "created", dispatched: { outcome: "submitted" } }] } });
    await until("bob has alice's acknowledgement", () => bob.inbounds.length === 3);
    for (const [party, head] of [
      [alice, channelOf(a1, b1)],
      [bob, channelOf(b1, a1)],
    ] as [Running, Channel][]) {
      const fold = await foldOf(party);
      expect(fold.continuity.conflicts).toEqual([]);
      expect(fold.continuity.head({ localDid: head.localDid === a1 ? a0 : b0, peerDid: head.peerDid === a1 ? a0 : b0 })).toEqual(head);
    }

    const third = await alice.agent.send({ channel: channelOf(a1, b1) }, hello("to your new address"), { messageId: THIRD });
    expect(third.dispatched).toMatchObject({ outcome: "submitted" });
    await until("bob has the message at the new address", () => bob.inbounds.length === 4);
    expect((await foldOf(bob)).continuity.confirmed(b1, a1)).toBe(true);
  });

  it("two rotations that cross join: each side decides before it hears of the other's, and both end at the one channel between the two successors", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE);
    const bob = await run(mediator, 2, BOB);
    const a0 = alice.party.did;
    const b0 = bob.party.did;

    await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: FIRST });
    await until("alice has the first message", () => alice.inbounds.length === 1);
    expect(alice.inbounds[0]!.address).toEqual({ outcome: "none", because: "the local DID is not disclosed" });
    await alice.agent.send({ channel: channelOf(a0, b0) }, hello("hello yourself"), { messageId: SECOND });
    await until("bob has the answer", () => bob.inbounds.length === 1);

    // Each decision is committed under its vault's lock before anything is sent, and the other's notification is recorded under that same lock: neither can be heard of first.
    const [ofAlices, ofBobs] = await Promise.all([alice.agent.manual.rotate({ localDidId: ALICE, peerDid: b0 }), bob.agent.manual.rotate({ localDidId: BOB, peerDid: a0 })]);
    expect([ofAlices, ofBobs]).toMatchObject([{ notification: { dispatched: { outcome: "submitted" } } }, { notification: { dispatched: { outcome: "submitted" } } }]);
    const a1 = didOf(await foldOf(alice), ofAlices.successor);
    const b1 = didOf(await foldOf(bob), ofBobs.successor);
    await until("alice has bob's notification and his acknowledgement of hers", () => alice.inbounds.length === 3);
    await until("bob has alice's notification and her acknowledgement of his", () => bob.inbounds.length === 3);

    for (const [party, mine, theirs, decision] of [
      [alice, [a0, a1], [b0, b1], ofAlices],
      [bob, [b0, b1], [a0, a1], ofBobs],
    ] as [Running, Did[], Did[], Rotated][]) {
      const fold = await foldOf(party);
      const heard = fold.set.of("message.in").find((observation) => observation.data.fromPrior !== null)!;
      expect(decision.decision.at < heard.at).toBe(true);
      expect(heard.data.did).toBe(theirs[1]);
      expect(fold.continuity.conflicts).toEqual([]);
      expect(links(fold).every(([, , , verified]) => verified === "true")).toBe(true);
      for (const local of mine) for (const peer of theirs) expect(fold.continuity.head(channelOf(local, peer))).toEqual(channelOf(mine[1]!, theirs[1]!));
      expect([...fold.outbound.outbounds.values()].find((output) => output.intents[0]!.data.rotationEventCid === decision.decision.cid)).toMatchObject({ acknowledged: true });
    }

    // Bob acknowledged alice's notification from the address it reached, so nothing from his successor has reached hers yet: the join's first package still carries her proof.
    const joined = await alice.agent.send({ channel: channelOf(a1, b1) }, hello("at the join"), { messageId: THIRD });
    expect(joined.dispatched).toMatchObject({ outcome: "submitted" });
    expect(carriesProof((await foldOf(alice)).outbound.outbounds.get(THIRD)!)).toBe(true);
    await until("bob has the message at the join", () => bob.inbounds.length === 4);
    expect(bob.inbounds[3]).toMatchObject({ received: { outcome: "received", live: true }, after: { proof: { status: "verified" } } });
    expect((await foldOf(bob)).views.channel(channelOf(b1, a1)).inbound.map((execution) => execution.status.status)).toEqual(["complete"]);

    await bob.agent.send({ channel: channelOf(b1, a1) }, hello("and back"), { messageId: FOURTH });
    await until("alice has the answer at the join", () => alice.inbounds.length === 4);
    await alice.agent.send({ channel: channelOf(a1, b1) }, hello("confirmed"), { messageId: FIFTH });
    expect(carriesProof((await foldOf(alice)).outbound.outbounds.get(FIFTH)!)).toBe(false);
  });
});
