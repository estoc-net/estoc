import { afterEach, describe, expect, it } from "vitest";

import { PURE_ACK_EFFECT, type Did, type DidId, type MessageId, type VaultFold } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { FORWARD } from "../../src/protocol/spec.js";
import type { ChannelRecord, MessageRecord } from "../../src/index.js";
import type { FakeMediator } from "../fake-mediator.js";
import { newMediator, peerSealer, sealed, type DirectParty, type Sealer } from "../helpers.js";
import { LONG, channelOf, foldOf, forwarded, imported, restart, restoredFrom, run, snapshotOf, stop, stopAll, until, type Running } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const FIRST = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const THIRD = "019b0000-0000-7000-8000-000000000103" as MessageId;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

const forwardsSeen = (mediator: FakeMediator): number => mediator.seenTypes.filter((type) => type === FORWARD).length;

const queuedFor = (mediator: FakeMediator, party: Running): number => mediator.queues.get(party.party.created.data.me.did)?.length ?? 0;

const didOf = (fold: VaultFold, didId: DidId): Did => fold.routes.dids.get(didId)!.created!.did;

const eventIds = (fold: VaultFold): string[] => [...fold.set.all()].map((event) => event.cid);

const sealerOf = (running: Running, as?: Did): Promise<Sealer> => peerSealer(running.party as unknown as DirectParty, as);

const contentsOf = (record: ChannelRecord): unknown[] => record.messages.filter((message) => message.direction === "in").map((message: MessageRecord) => [message.input?.status, message.body.state === "available" ? message.body.body : message.body.state]);

/** Every record of the vault, as the JSON a host is handed. */
async function recordsOf(running: Running): Promise<unknown> {
  const records = await running.agent.records();
  const channels: ChannelRecord[] = [];
  for (const channel of records.channels()) channels.push(await records.channel(channel));
  return JSON.parse(JSON.stringify({ channels, unplaced: await records.unplaced(), pending: records.pending() }));
}

/** Alice and Bob, each having written to the other once; then Alice offline, a snapshot of her vault taken as she went. */
async function acquainted(): Promise<{ mediator: FakeMediator; alice: Running; bob: Running; a0: Did; b0: Did; snapshot: string }> {
  const mediator = await newMediator();
  const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
  const bob = await run(mediator, 2, BOB, { privateAddresses: false });
  const a0 = alice.party.did;
  const b0 = bob.party.did;
  await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: FIRST });
  await until("alice has the first message", () => alice.inbounds.length === 1);
  await alice.agent.send({ channel: channelOf(a0, b0) }, hello("hello yourself"), { messageId: SECOND });
  await until("bob has the answer", () => bob.inbounds.length === 1);
  const snapshot = await snapshotOf(alice);
  await stop(alice);
  return { mediator, alice, bob, a0, b0, snapshot };
}

/**
 * The vault opened again over the same file, and its history merged
 * into a replica restored from before the batch: neither open records
 * an admission that was missing, tells the host of a delivery or calls
 * the transport, and both replicas read the same records.
 */
async function converging(alice: Running, snapshot: string, mediator: FakeMediator): Promise<void> {
  const forwards = forwardsSeen(mediator);
  const inbounds = alice.inbounds.length;
  const before = await recordsOf(alice);

  await restart(alice, { privateAddresses: false });
  expect(alice.agent.recovered.admitted).toEqual([]);
  expect([alice.inbounds.length, forwardsSeen(mediator)]).toEqual([inbounds, forwards]);
  expect(await recordsOf(alice)).toEqual(before);

  const other = await restoredFrom(alice, snapshot, { privateAddresses: false, liveDelivery: false });
  expect(other.agent.recovered.admitted).toEqual([]);
  expect(await imported(other, await snapshotOf(alice))).toMatchObject({ added: expect.any(Number) });
  expect(await other.agent.localStateChanged()).toEqual([]);
  expect([other.inbounds, forwardsSeen(mediator)]).toEqual([[], forwards]);
  expect(eventIds(await foldOf(other))).toEqual(eventIds(await foldOf(alice)));
  expect(await recordsOf(other)).toEqual(before);
}

describe("one pickup batch holding a message from the address the peer then rotated away from", () => {
  it("with the message ahead of the rotation: the message is admitted and shown with its content, acknowledged to the address it came from by the call made before the rotation was folded, and the rotation moves the head after it; opened again or merged into another replica, the vault sends nothing again", { timeout: LONG }, async () => {
    const { mediator, alice, bob, a0, b0, snapshot } = await acquainted();
    await bob.agent.send({ channel: channelOf(b0, a0) }, { ...hello("before I move"), pleaseAck: [""] }, { messageId: THIRD });
    const rotated = await bob.agent.manual.rotate({ localDidId: BOB, peerDid: a0 });
    const b1 = didOf(await foldOf(bob), rotated.successor);
    expect(queuedFor(mediator, alice)).toBe(2);

    const forwards = forwardsSeen(mediator);
    await restart(alice, { privateAddresses: false });
    await until("alice has taken the batch", () => alice.inbounds.length === 3);
    await alice.agent.settled();
    expect(alice.inbounds.slice(1)).toMatchObject([
      { received: { outcome: "received", live: true }, after: { proof: { status: "not-present" }, disposition: { status: "admitted" } }, reacted: { effects: [{ effectType: PURE_ACK_EFFECT, outcome: "created", dispatched: { outcome: "submitted" } }] } },
      { received: { outcome: "received", live: true }, after: { proof: { status: "verified" }, disposition: { status: "admitted" } } },
    ]);
    expect((await foldOf(alice)).continuity.head(channelOf(a0, b0))).toEqual(channelOf(a0, b1));

    const records = await alice.agent.records();
    const old = await records.channel(channelOf(a0, b0));
    expect(old.superseded).toBe(true);
    expect(contentsOf(old)).toEqual([
      ["complete", { content: "hello" }],
      ["complete", { content: "before I move" }],
    ]);
    expect(old.observations.map(({ disposition }) => disposition)).toEqual([{ status: "admitted" }, { status: "admitted" }]);
    expect((await records.channel(channelOf(a0, b1))).observations).toMatchObject([{ disposition: { status: "admitted" }, verification: { status: "verified" } }]);
    expect(records.pending()).toEqual({ pendingOutbounds: [], missingResponses: [], missingNotifications: [], notificationConflicts: [], pendingProofs: [] });
    const acks = [...(await foldOf(alice)).outbound.outbounds.values()].filter((outbound) => outbound.intent.status === "consistent" && outbound.intent.data.effectType === PURE_ACK_EFFECT);
    const acknowledgedIn = (peer: Did): string[] => acks.filter(({ channel }) => channel !== null && channel.peerDid === peer).map(({ outcome }) => outcome.status);
    expect([acks.length, acknowledgedIn(b0), acknowledgedIn(b1)]).toEqual([2, ["submitted"], ["submitted"]]);
    expect(forwardsSeen(mediator)).toBe(forwards + 2);

    await converging(alice, snapshot, mediator);
  });

  it("with the rotation ahead of a message sealed by hand from the old address: the message is recorded and ignored, listed so apart from the conversation with nothing it carries, and answered with nothing; opened again or merged into another replica, the vault sends nothing", { timeout: LONG }, async () => {
    const { mediator, alice, bob, a0, b0, snapshot } = await acquainted();
    const rotated = await bob.agent.manual.rotate({ localDidId: BOB, peerDid: a0 });
    const b1 = didOf(await foldOf(bob), rotated.successor);
    await forwarded(mediator, a0, await sealed(await sealerOf(bob, b0), a0, { ...hello("after I moved"), please_ack: [""] }));
    expect(queuedFor(mediator, alice)).toBe(2);

    const forwards = forwardsSeen(mediator);
    await restart(alice, { privateAddresses: false });
    await until("alice has taken the batch", () => alice.inbounds.length === 3);
    await alice.agent.settled();
    expect(alice.inbounds.slice(1)).toMatchObject([
      { received: { outcome: "received", live: true }, after: { proof: { status: "verified" }, disposition: { status: "admitted" } } },
      { received: { outcome: "received", live: false }, after: { proof: { status: "not-present" }, disposition: { status: "ignored-superseded" } }, reacted: null, address: null },
    ]);
    expect(forwardsSeen(mediator)).toBe(forwards + 1);
    expect((await foldOf(alice)).continuity.head(channelOf(a0, b0))).toEqual(channelOf(a0, b1));

    const records = await alice.agent.records();
    const old = await records.channel(channelOf(a0, b0));
    expect(old.superseded).toBe(true);
    expect(contentsOf(old)).toEqual([["complete", { content: "hello" }]]);
    expect(old.observations.map(({ standing, disposition, contradicting }) => [standing, disposition, contradicting])).toEqual([
      [{ status: "complete" }, { status: "admitted" }, false],
      [{ status: "complete" }, { status: "ignored-superseded" }, false],
    ]);
    expect(records.pending().missingResponses).toEqual([]);

    await converging(alice, snapshot, mediator);
  });
});
