import { afterEach, describe, expect, it } from "vitest";

import { PROBLEM_REPORT_TYPE, collectGarbage, inboundMessageId, type Cid, type ContactId, type Did, type DidId, type EpochSeconds, type MessageId, type VaultFold, type WireMessageId, vaultDraft } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { FORWARD } from "../../src/protocol/spec.js";
import { MAX_ENVELOPE_BYTES, Unusable } from "../../src/index.js";
import type { FakeMediator } from "../fake-mediator.js";
import { newMediator } from "../helpers.js";
import { LONG, channelOf, foldOf, forwarded, restart, run, snapshotOf, stopAll, until, type Running } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const CONTACT = "019b0000-0000-7000-8000-0000000000c1" as ContactId;
const FIRST = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const THIRD = "019b0000-0000-7000-8000-000000000103" as MessageId;
const REPORT = "019b0000-0000-7000-8000-000000000104" as MessageId;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

const forwardsSeen = (mediator: FakeMediator): number => mediator.seenTypes.filter((type) => type === FORWARD).length;

const didOf = (fold: VaultFold, didId: DidId): Did => fold.routes.dids.get(didId)!.created!.did;

const held = (fold: VaultFold): Set<Cid> => new Set(fold.retained.map(({ root }) => root));

async function pair(options: { bob?: Parameters<typeof run>[3] } = {}): Promise<{ mediator: FakeMediator; alice: Running; bob: Running; toAlice: { channel: ReturnType<typeof channelOf>; recipientDid: Did }; received: (wire: MessageId) => MessageId }> {
  const mediator = await newMediator();
  const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
  const bob = await run(mediator, 2, BOB, { privateAddresses: false, ...options.bob });
  const toAlice = { channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid };
  return { mediator, alice, bob, toAlice, received: (wire) => inboundMessageId(bob.party.did, alice.party.did, wire as string as WireMessageId) };
}

describe("a message erased", () => {
  it("gives up its content on each side and keeps its record: the same envelope coming again is one more observation of a message that still reads erased, across a restart, its bytes held by nothing and gone with the next collection, and the vault still exports whole", { timeout: LONG }, async () => {
    const { mediator, alice, bob, toAlice, received } = await pair();
    await bob.agent.send(toAlice, { ...hello("for your eyes only"), pleaseAck: [""] }, { messageId: FIRST });
    await until("alice has the message", () => alice.inbounds.length === 1);
    await until("bob has the acknowledgement", () => bob.inbounds.length === 1);
    const sent = (await foldOf(bob)).outbound.outbounds.get(FIRST)!;
    const { envelopeCid } = sent.package!.event.data;
    const envelope = new TextDecoder().decode((await bob.runtime.vault.objects.read(envelopeCid, MAX_ENVELOPE_BYTES))!);
    const { bodyCid } = (await foldOf(alice)).set.of("message.in")[0]!.data;

    expect((await bob.agent.manual.eraseMessage(FIRST)).events).toHaveLength(1);
    expect(await bob.runtime.vault.objects.has(envelopeCid)).toBe(false);
    const ofBob = await (await bob.agent.records()).channel(toAlice.channel);
    expect(ofBob.messages.filter((message) => message.direction === "out")).toMatchObject([{ messageId: FIRST, body: { state: "erased" }, outcome: { status: "submitted" }, acknowledged: true, manualAction: "none" }]);

    expect((await alice.agent.manual.eraseMessage(received(FIRST), "asked to forget")).events).toMatchObject([{ data: { dropCids: [bodyCid], because: "asked to forget" } }]);
    expect(await alice.runtime.vault.objects.has(bodyCid)).toBe(false);

    const forwards = forwardsSeen(mediator);
    await forwarded(mediator, alice.party.did, envelope);
    await until("alice has the envelope again", () => alice.inbounds.length === 2);
    expect(alice.inbounds[1]).toMatchObject({ received: { outcome: "received", live: false }, reacted: null });
    expect(forwardsSeen(mediator)).toBe(forwards + 1);
    await restart(alice);
    const ofAlice = await foldOf(alice);
    expect(ofAlice.set.of("message.in")).toHaveLength(2);
    expect(held(ofAlice).has(bodyCid)).toBe(false);
    await collectGarbage(alice.runtime, alice.keys);
    expect(await alice.runtime.vault.objects.has(bodyCid)).toBe(false);
    const shown = await (await alice.agent.records()).channel(channelOf(alice.party.did, bob.party.did));
    expect(shown.messages.filter((message) => message.direction === "in")).toMatchObject([{ messageId: received(FIRST), body: { state: "erased" }, input: { status: "complete" } }]);
    await expect(snapshotOf(alice)).resolves.toEqual(expect.any(String));
  });
});

describe("a contact deleted with its channels denied, successors included", () => {
  it("takes the peer's later messages and its rotation as records and answers none of them: no acknowledgement leaves, the successor channel is denied as the old one is, and what the channels held is erased", { timeout: LONG }, async () => {
    const { mediator, alice, bob, toAlice } = await pair();
    const a0 = alice.party.did;
    const b0 = bob.party.did;
    await bob.agent.send(toAlice, hello("hello"), { messageId: FIRST });
    await until("alice has the first message", () => alice.inbounds.length === 1);
    await alice.agent.send({ channel: channelOf(a0, b0) }, hello("hello yourself"), { messageId: SECOND });
    await until("bob has the answer", () => bob.inbounds.length === 1);
    await alice.runtime.vault.commit([], [vaultDraft("contact.created", { contactId: CONTACT, because: "user" }), vaultDraft("contact.channelsSet", { contactId: CONTACT, channels: [channelOf(a0, b0)] })]);
    expect((await alice.agent.records()).contactIds()).toEqual([CONTACT]);

    const deleted = await alice.agent.manual.deleteContact(CONTACT, { block: { includeSuccessors: true }, erase: "contact deleted" });
    expect(deleted.events.map((event) => event.type).sort()).toEqual(["channel.blocked", "contact.deleted", "message.erased", "message.erased"]);
    const records = await alice.agent.records();
    expect(records.contactIds()).toEqual([]);
    expect((await records.channel(channelOf(a0, b0))).messages.map((message) => message.body.state)).toEqual(["erased", "erased"]);
    await expect(alice.agent.send({ channel: channelOf(a0, b0) }, hello("one more thing"))).rejects.toBeInstanceOf(Unusable);

    const forwards = forwardsSeen(mediator);
    await bob.agent.send({ channel: channelOf(b0, a0) }, { ...hello("are you there"), pleaseAck: [""] }, { messageId: THIRD });
    await until("alice has recorded the message", () => alice.inbounds.length === 2);
    expect(alice.inbounds[1]).toMatchObject({ received: { outcome: "received", live: true }, reacted: { effects: [{ outcome: "none", because: "the channel is denied" }] } });
    const rotated = await bob.agent.manual.rotate({ localDidId: BOB, peerDid: a0 });
    const b1 = didOf(await foldOf(bob), rotated.successor);
    await until("alice has recorded the notification", () => alice.inbounds.length === 3);
    expect(alice.inbounds[2]).toMatchObject({ received: { outcome: "received", live: true }, after: { proof: { status: "verified" } }, reacted: { effects: [{ outcome: "none", because: "the channel is denied" }] } });
    expect(forwardsSeen(mediator)).toBe(forwards + 2);

    const ofAlice = await foldOf(alice);
    expect(ofAlice.outbound.outbounds.size).toBe(1);
    expect([channelOf(a0, b0), channelOf(a0, b1)].map((channel) => ofAlice.continuity.blocked(channel).map((denial) => denial.data.peerDid))).toEqual([[b0], [b0]]);
    await expect(alice.agent.send({ channel: channelOf(a0, b1) }, hello("to your new address"))).rejects.toBeInstanceOf(Unusable);
    const ofBob = await foldOf(bob);
    const unanswered = [...ofBob.outbound.outbounds.values()].filter((output) => output.messageId === THIRD || output.intents[0]!.data.rotationEventId !== null);
    expect(unanswered.map((output) => [output.outcome.status, output.acknowledged])).toEqual([
      ["submitted", false],
      ["submitted", false],
    ]);
  });
});

describe("a message that was not accepted", () => {
  it("and whose expiry passed is terminated by the retry that finds it so, with no call made; nothing reopens it", { timeout: LONG }, async () => {
    let clock = Date.now();
    const { mediator, bob, toAlice } = await pair({ bob: { now: () => clock } });
    bob.refuseForward.armed = true;
    const sent = await bob.agent.send(toAlice, { ...hello("before noon"), expiresTime: (Math.floor(clock / 1000) + 60) as EpochSeconds }, { messageId: FIRST });
    expect(sent.dispatched).toMatchObject({ outcome: "failed" });

    clock += 61_000;
    const forwards = forwardsSeen(mediator);
    expect(await bob.agent.manual.retry(FIRST)).toMatchObject({ outcome: "expired", failed: { data: { code: "expired" } } });
    expect(await bob.agent.manual.retry(FIRST)).toMatchObject({ outcome: "none" });
    expect(await bob.agent.manual.cancel(FIRST)).toMatchObject({ outcome: "none" });
    expect(forwardsSeen(mediator)).toBe(forwards);
    expect(await bob.agent.outbounds()).toEqual([]);
    expect((await (await bob.agent.records()).channel(toAlice.channel)).messages).toMatchObject([{ messageId: FIRST, outcome: { status: "terminal" }, body: { state: "available" }, manualAction: "none" }]);
  });

  it("and is cancelled keeps its content and gives up its envelope: no retry sends it, while a message the mediator took is not cancelled", { timeout: LONG }, async () => {
    const { mediator, alice, bob, toAlice } = await pair();
    bob.refuseForward.armed = true;
    await bob.agent.send(toAlice, hello("on second thought"), { messageId: FIRST });
    const { envelopeCid } = (await foldOf(bob)).outbound.outbounds.get(FIRST)!.package!.event.data;

    expect(await bob.agent.manual.cancel(FIRST)).toMatchObject({ outcome: "cancelled", failed: { data: { code: "cancelled" } } });
    expect(held(await foldOf(bob)).has(envelopeCid)).toBe(false);
    await collectGarbage(bob.runtime, bob.keys);
    expect(await bob.runtime.vault.objects.has(envelopeCid)).toBe(false);
    const forwards = forwardsSeen(mediator);
    expect(await bob.agent.manual.retry(FIRST)).toMatchObject({ outcome: "none" });
    expect(forwardsSeen(mediator)).toBe(forwards);
    expect((await (await bob.agent.records()).channel(toAlice.channel)).messages).toMatchObject([{ messageId: FIRST, outcome: { status: "terminal" }, body: { state: "available", body: { content: "on second thought" } } }]);

    expect((await bob.agent.send(toAlice, hello("hello"), { messageId: SECOND })).dispatched).toMatchObject({ outcome: "submitted" });
    expect(await bob.agent.manual.cancel(SECOND)).toMatchObject({ outcome: "none" });
    await until("alice has the one message that was sent", () => alice.inbounds.length === 1);
    expect((await foldOf(alice)).set.of("message.in").map((event) => event.data.wireMessageId)).toEqual([SECOND]);
  });
});

describe("a problem the peer reports", () => {
  it("is shown beside the message its parent thread names, and answered with nothing", { timeout: LONG }, async () => {
    const { mediator, alice, bob, toAlice } = await pair();
    await bob.agent.send(toAlice, hello("hello"), { messageId: FIRST });
    await until("alice has the message", () => alice.inbounds.length === 1);
    await alice.agent.send({ channel: channelOf(alice.party.did, bob.party.did) }, { type: PROBLEM_REPORT_TYPE, pthid: FIRST, body: { code: "e.m.not-understood", comment: "no handler for {1}", args: ["basicmessage"] } }, { messageId: REPORT });
    await until("bob has the report", () => bob.inbounds.length === 1);
    const forwards = forwardsSeen(mediator);

    expect(bob.inbounds[0]).toMatchObject({ received: { outcome: "received", live: true }, reacted: { effects: [] } });
    const shown = await (await bob.agent.records()).channel(toAlice.channel);
    const report = shown.messages.find((message) => message.direction === "in")!;
    expect(report).toMatchObject({ kind: "error", manualAction: "none" });
    expect(shown.messages.find((message) => message.messageId === FIRST)!.diagnostics).toEqual([{ kind: "remote-error", because: "e.m.not-understood: no handler for basicmessage", report: report.messageId }]);
    expect(forwardsSeen(mediator)).toBe(forwards);
  });
});
