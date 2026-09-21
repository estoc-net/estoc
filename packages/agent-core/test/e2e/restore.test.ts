import { afterEach, describe, expect, it } from "vitest";

import type { Did, DidId, MessageId, VaultFold } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { MESSAGES_RECEIVED } from "../../src/protocol/mediation.js";
import { FORWARD, PROBLEM_REPORT } from "../../src/protocol/spec.js";
import { Unusable, createDid, ensureRoute } from "../../src/index.js";
import type { FakeMediator } from "../fake-mediator.js";
import { newMediator } from "../helpers.js";
import { LONG, channelOf, foldOf, imported, restoredFrom, run, snapshotOf, stop, stopAll, until, type Running } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const ALICE_LATER = "019b0000-0000-7000-8000-00000000000c" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const FIRST = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const THIRD = "019b0000-0000-7000-8000-000000000103" as MessageId;
const FOURTH = "019b0000-0000-7000-8000-000000000104" as MessageId;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

const forwardsSeen = (mediator: FakeMediator): number => mediator.seenTypes.filter((type) => type === FORWARD).length;

const queuedFor = (mediator: FakeMediator, party: Running): number => mediator.queues.get(party.party.created.data.me.did)?.length ?? 0;

const didOf = (fold: VaultFold, didId: DidId): Did => fold.routes.dids.get(didId)!.created!.did;

const eventIds = (fold: VaultFold): string[] => [...fold.set.all()].map((event) => event.eventId);

const outcomes = (fold: VaultFold): [MessageId, string][] => [...fold.outbound.outbounds.values()].map((output) => [output.messageId, output.outcome.status]);

const authorsOf = (fold: VaultFold): Set<string> => new Set([...fold.set.all()].map((event) => event.author));

async function pair(): Promise<{ mediator: FakeMediator; alice: Running; bob: Running }> {
  const mediator = await newMediator();
  const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
  const bob = await run(mediator, 2, BOB, { privateAddresses: false });
  return { mediator, alice, bob };
}

describe("a vault restored from a snapshot", () => {
  it("runs as another replica, sends nothing as it opens and lists what the snapshot left unfinished: what was submitted stays so, and a retry sends the package the snapshot carried", { timeout: LONG }, async () => {
    const { mediator, alice, bob } = await pair();
    const toAlice = { channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid };
    await bob.agent.send(toAlice, hello("hello"), { messageId: FIRST });
    bob.refuseForward.armed = true;
    expect((await bob.agent.send(toAlice, hello("are you there"), { messageId: SECOND })).dispatched).toMatchObject({ outcome: "failed" });
    await until("alice has the first message", () => alice.inbounds.length === 1);
    const before = await foldOf(bob);
    const snapshot = await snapshotOf(bob);
    await stop(bob);

    const sent = forwardsSeen(mediator);
    const restored = await restoredFrom(bob, snapshot, { privateAddresses: false });
    expect(restored.runtime.author).not.toBe(bob.runtime.author);
    expect(restored.agent.connections()).toMatchObject([{ unreachable: null, reconciled: { added: [], removed: [] } }]);
    expect(forwardsSeen(mediator)).toBe(sent);
    expect(outcomes(await foldOf(restored))).toEqual([
      [FIRST, "submitted"],
      [SECOND, "prepared"],
    ]);
    expect((await restored.agent.outbounds()).map(({ outbound, waiting }) => [outbound.messageId, waiting])).toEqual([[SECOND, null]]);
    expect((await restored.agent.pending()).pendingOutbounds).toMatchObject([{ messageId: SECOND, outcome: "prepared", entries: expect.arrayContaining(["retry", "cancel"]) }]);

    const retried = await restored.agent.manual.retry(SECOND);
    expect(retried).toMatchObject({ outcome: "submitted", packageId: before.outbound.outbounds.get(SECOND)!.package!.event.data.packageId });
    if (retried.outcome !== "submitted") throw new Error("unreachable");
    expect(retried.submitted.author).toBe(restored.runtime.author);
    await until("alice has the second message", () => alice.inbounds.length === 2);
    expect(authorsOf(await foldOf(restored))).toEqual(new Set([bob.runtime.author, restored.runtime.author]));
  });

  it("knows no local DID made after it and no successor its peer took after it: a delivery for the one and a delivery from the other are each taken off the mediator, recorded as nothing and shown as discarded, and the lost DID is no longer registered", { timeout: LONG }, async () => {
    const { mediator, alice, bob } = await pair();
    const carol = await run(mediator, 3, CAROL, { privateAddresses: false });
    const a0 = alice.party.did;
    const b0 = bob.party.did;
    await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: FIRST });
    await until("alice has the first message", () => alice.inbounds.length === 1);
    await alice.agent.send({ channel: channelOf(a0, b0) }, hello("hello yourself"), { messageId: SECOND });
    await until("bob has the answer", () => bob.inbounds.length === 1);
    const snapshot = await snapshotOf(alice);

    const later = await createDid(alice.runtime, alice.keys, await ensureRoute(alice.runtime, alice.keys, alice.party.mediationId), ALICE_LATER);
    const { invitation } = await alice.agent.disclose(ALICE_LATER, { as: "oob", uses: "many" });
    const rotated = await bob.agent.manual.rotate({ localDidId: BOB, peerDid: a0 });
    const b1 = didOf(await foldOf(bob), rotated.successor);
    await until("alice has bob's notification", () => alice.inbounds.length === 2);
    await until("bob has alice's acknowledgement", () => bob.inbounds.length === 2);
    expect((await foldOf(bob)).continuity.confirmed(b1, a0)).toBe(true);
    await stop(alice);

    const toLater = await carol.agent.send({ channel: channelOf(carol.party.did, later.minted.did), recipientDid: invitation!.from as Did }, hello("to the address made later"), { messageId: THIRD });
    expect(toLater.dispatched).toMatchObject({ outcome: "submitted" });
    const fromSuccessor = await bob.agent.send({ channel: channelOf(b1, a0) }, hello("from my successor"), { messageId: FOURTH });
    expect(fromSuccessor.dispatched).toMatchObject({ outcome: "submitted" });
    expect((await foldOf(bob)).outbound.outbounds.get(FOURTH)!.package!.event.data.fromPrior).toBeNull();
    expect(queuedFor(mediator, alice)).toBe(2);

    const restored = await restoredFrom(alice, snapshot, { privateAddresses: false });
    expect(restored.agent.connections()).toMatchObject([{ unreachable: null, reconciled: { desired: [a0], removed: [later.minted.did] } }]);
    expect(mediator.recipients.has(later.minted.did)).toBe(false);
    await until("both deliveries ended", () => restored.inbounds.length === 2);
    expect(queuedFor(mediator, alice)).toBe(0);
    expect(restored.inbounds.map(({ received, after }) => [received.outcome, after])).toEqual([
      ["terminal", null],
      ["terminal", null],
    ]);
    expect(
      restored.agent
        .discardedDeliveries()
        .map(({ reason }) => reason)
        .sort()
    ).toEqual([expect.stringContaining("local recipient material is unavailable"), expect.stringContaining(`sender material is unavailable for ${b1}`)]);
    const fold = await foldOf(restored);
    expect(fold.set.of("message.in")).toHaveLength(1);
    expect(fold.routes.dids.has(ALICE_LATER)).toBe(false);
    expect(fold.continuity.links).toEqual([]);
  });

  it("predating a rotation the peer has verified selects another successor when the message that prompted the first is still with the mediator: the peer keeps both proofs and shows the fork, with no head there and nothing sent on its authority, while what it recorded before stands", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE);
    const bob = await run(mediator, 2, BOB);
    const a0 = alice.party.did;
    const b0 = bob.party.did;
    const { invitation } = await alice.agent.disclose(ALICE, { as: "oob", uses: "many" });
    const snapshot = await snapshotOf(alice);
    let unheard = true;
    mediator.intercept = (msg, from) => (unheard && msg.type === MESSAGES_RECEIVED && from === alice.party.created.data.me.did ? mediator.reply(PROBLEM_REPORT, from, { code: "e.p.busy" }, msg.id) : undefined);

    await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: invitation!.from as Did }, { ...hello("hello"), pthid: invitation!.id }, { messageId: FIRST });
    await until("alice has selected a private address", () => alice.inbounds.length === 1);
    const first = alice.inbounds[0]!.address!;
    if (first.outcome !== "rotated") throw new Error(`alice did not rotate: ${JSON.stringify(first)}`);
    const a1 = didOf(await foldOf(alice), first.rotation.successor);
    await until("alice has bob's acknowledgement", () => alice.inbounds.length === 2);
    expect((await foldOf(bob)).continuity.head(channelOf(b0, a0))).toEqual(channelOf(b0, a1));
    expect(queuedFor(mediator, alice)).toBe(2);
    await stop(alice);
    unheard = false;

    const restored = await restoredFrom(alice, snapshot);
    await until("the restored alice has taken both deliveries off the mediator", () => restored.inbounds.length === 2);
    expect(queuedFor(mediator, alice)).toBe(0);
    expect(restored.inbounds.map(({ received }) => received.outcome)).toEqual(["received", "terminal"]);
    const second = restored.inbounds[0]!.address!;
    if (second.outcome !== "rotated") throw new Error(`the restored alice did not rotate: ${JSON.stringify(second)}`);
    const other = didOf(await foldOf(restored), second.rotation.successor);
    expect(other).not.toBe(a1);
    expect(second.rotation.notification).toMatchObject({ outcome: "created", dispatched: { outcome: "submitted" } });

    await until("bob has the second notification", () => bob.inbounds.length === 2);
    expect(bob.inbounds[1]).toMatchObject({ received: { outcome: "received", live: true }, after: { proof: { status: "conflict" } }, reacted: { effects: [] } });
    expect(queuedFor(mediator, bob)).toBe(0);
    const ofBob = await foldOf(bob);
    expect(ofBob.continuity.conflicts).toMatchObject([{ kind: "competing-peer-successors" }]);
    expect(ofBob.continuity.links.map((link) => [link.to.peerDid, link.verified]).sort()).toEqual([[a1, false], [other, false]].sort());
    expect(ofBob.continuity.head(channelOf(b0, a0))).toBeNull();
    for (const successor of [a1, other]) await expect(bob.agent.send({ channel: channelOf(b0, successor) }, hello("which of you"))).rejects.toBeInstanceOf(Unusable);
    expect(ofBob.outbound.outbounds.get(FIRST)).toMatchObject({ outcome: { status: "submitted" } });
    expect(ofBob.set.of("message.in")).toHaveLength(2);
  });
});

describe("two machines of one vault", () => {
  it("merge by import: a message one of them cancelled and the other got accepted is submitted on both, the cancellation still on record, and no retry sends it again", { timeout: LONG }, async () => {
    const { mediator, alice, bob } = await pair();
    bob.refuseForward.armed = true;
    const sent = await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: FIRST });
    expect(sent.dispatched).toMatchObject({ outcome: "failed" });
    const other = await restoredFrom(bob, await snapshotOf(bob), { privateAddresses: false, liveDelivery: false });

    expect(await other.agent.manual.retry(FIRST)).toMatchObject({ outcome: "submitted" });
    expect(await bob.agent.manual.cancel(FIRST)).toMatchObject({ outcome: "cancelled" });
    expect(outcomes(await foldOf(bob))).toEqual([[FIRST, "terminal"]]);
    await until("alice has the message", () => alice.inbounds.length === 1);

    expect(await imported(bob, await snapshotOf(other))).toMatchObject({ added: 1, conflicts: [] });
    expect(await imported(other, await snapshotOf(bob))).toMatchObject({ added: 1, conflicts: [] });
    const forwards = forwardsSeen(mediator);
    for (const machine of [bob, other]) {
      const fold = await foldOf(machine);
      expect(fold.outbound.outbounds.get(FIRST)).toMatchObject({ submitted: true, outcome: { status: "submitted" }, terminations: [{ event: { data: { code: "cancelled" } } }], work: { kind: "none", because: "submitted" } });
      expect(authorsOf(fold)).toEqual(new Set([bob.runtime.author, other.runtime.author]));
      expect(await machine.agent.outbounds()).toEqual([]);
      expect(await machine.agent.manual.retry(FIRST)).toMatchObject({ outcome: "none" });
    }
    expect(forwardsSeen(mediator)).toBe(forwards);
    expect(eventIds(await foldOf(bob))).toEqual(eventIds(await foldOf(other)));
  });
});
