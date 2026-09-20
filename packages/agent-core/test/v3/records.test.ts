import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import {
  EMPTY_MESSAGE_TYPE,
  PING_RESPONSE_EFFECT,
  PING_TYPE,
  PROBLEM_REPORT_TYPE,
  PURE_ACK_EFFECT,
  scanVault,
  vaultDraft,
  type Channel,
  type ContactId,
  type DidId,
  type EventReference,
  type MessageId,
} from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import type { IMessage } from "../../src/protocol/didcomm.js";
import { PROFILE } from "../../src/protocol/user-profile.js";
import {
  Dispatcher,
  Keyring,
  Receiver,
  afterReceipt,
  createDid,
  disclose,
  manualNotificationDraft,
  manualProcedures,
  readRecords,
  receiptOf,
  reportedProblem,
  send,
  type ChannelRecord,
  type MessageRecord,
  type Source,
} from "../../src/v3/index.js";
import { didcomm, directParty, peerSealer, posting, received, sealed, type DirectParty, type Fresh, type Post } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const ALICE_OTHER = "019b0000-0000-7000-8000-00000000000c" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const CHARLIE = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const CONTACT = "019b0000-0000-7000-8000-0000000000f0" as ContactId;
const CREATED = 1_757_700_000;
const DIRECT: Source = { kind: "direct" };

const accepted = (): Response => new Response(null, { status: 202 });
const refused = (): Response => new Response("no", { status: 500 });

type Holder = Pick<Fresh, "runtime" | "keys">;

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty }> {
  return { alice: await directParty(1, "https://alice.example/didcomm", ALICE), bob: await directParty(2, "https://bob.example/didcomm", BOB) };
}

async function closeAll(...holders: Holder[]): Promise<void> {
  for (const holder of holders) await holder.runtime.close();
}

/** Alice as a host runs her: a receiver, a dispatcher over a wire the test answers, and the manual procedures over both. */
async function hosting(alice: DirectParty, answer: (post: Post) => Response = accepted) {
  const ring = await Keyring.load(alice.keys, await scanVault(alice.runtime.vault, alice.keys));
  const receiver = new Receiver(alice.runtime, alice.keys, ring, { didcomm, receipt: receiptOf(alice.runtime, alice.keys) });
  const wire = posting((post) => answer(post));
  const dispatcher = new Dispatcher(alice.runtime, alice.keys, { didcomm, fetch: wire.fetch });
  const manual = manualProcedures(alice.runtime, alice.keys, dispatcher, { now: () => CREATED * 1000 });
  const receive = async (peer: DirectParty, extra: Partial<IMessage>, to: string = alice.longFormDid): Promise<EventReference<"message.in">> => {
    const outcome = await receiver.receive({ packed: await sealed(await peerSealer(peer), to, extra), source: DIRECT });
    if (outcome.outcome !== "received") throw new Error(`not received: ${JSON.stringify(outcome)}`);
    return outcome.eventId;
  };
  const channel = async (pair: Channel): Promise<ChannelRecord> => (await readRecords(alice.runtime, alice.keys)).channel(pair);
  return { wire, dispatcher, manual, receive, channel };
}

const only = (record: ChannelRecord, direction: "in" | "out"): MessageRecord => {
  const found = record.messages.filter((message) => message.direction === direction);
  if (found.length !== 1) throw new Error(`${found.length} ${direction} messages`);
  return found[0]!;
};

describe("records", () => {
  it("shows an input in its exact channel with its content, names the reply it still earns, and the completion gives it once", async () => {
    const { alice, bob } = await parties();
    const { wire, manual, receive, channel } = await hosting(alice);
    const pair = { localDid: alice.did, peerDid: bob.did };
    await alice.runtime.vault.commit([], [vaultDraft("contact.created", { contactId: CONTACT, because: "user" }), vaultDraft("contact.channelsSet", { contactId: CONTACT, channels: [pair] })]);
    const wireId = crypto.randomUUID();
    await receive(bob, { id: wireId, body: { content: "hi alice" }, please_ack: [""], created_time: CREATED });

    const records = await readRecords(alice.runtime, alice.keys);
    expect([records.channels(), records.contactIds()]).toEqual([[pair], [CONTACT]]);
    const record = await records.channel(pair);
    const input = only(record, "in");
    expect(input).toMatchObject({
      direction: "in",
      channel: pair,
      contactIds: [CONTACT],
      msg: { type: BASIC_MESSAGE, thid: null, createdTime: CREATED },
      body: { state: "available", body: { content: "hi alice" }, attachments: [] },
      kind: "application",
      input: { status: "complete" },
      outcome: null,
      verification: { status: "not-present" },
      manualAction: "complete",
      completes: [PURE_ACK_EFFECT],
      diagnostics: [],
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);

    const pending = records.pending();
    expect(pending.missingResponses).toMatchObject([{ messageId: input.messageId, effectType: PURE_ACK_EFFECT, channel: pair, entries: ["completeResponse"] }]);
    const completed = await manual.completeResponse(pending.missingResponses[0]!.executionId, PURE_ACK_EFFECT);
    expect(completed).toMatchObject({ outcome: "created", action: { kind: "manual" }, dispatched: { outcome: "submitted" } });
    expect(wire.posts).toHaveLength(1);

    const after = await channel(pair);
    expect(only(after, "in")).toMatchObject({ manualAction: "none", completes: [] });
    expect(only(after, "out")).toMatchObject({ msg: { type: EMPTY_MESSAGE_TYPE }, effectType: PURE_ACK_EFFECT, outcome: { status: "submitted" }, manualAction: "none", contactIds: [CONTACT] });
    expect((await readRecords(alice.runtime, alice.keys)).pending()).toEqual({ pendingOutbounds: [], missingResponses: [], missingNotifications: [], notificationConflicts: [], pendingProofs: [] });
    await closeAll(alice, bob);
  });

  it("an output a transport refused is shown prepared with a retry, which carries it; a cancelled one is terminal with nothing left to do", async () => {
    const { alice, bob } = await parties();
    let answer = refused;
    const { wire, dispatcher, manual, channel } = await hosting(alice, () => answer());
    const pair = { localDid: alice.did, peerDid: bob.did };
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, { type: BASIC_MESSAGE, body: { content: "hello" } });
    expect(await dispatcher.run(sent.action)).toMatchObject({ outcome: "failed" });

    expect(only(await channel(pair), "out")).toMatchObject({ messageId: sent.messageId, body: { state: "available", body: { content: "hello" } }, outcome: { status: "prepared" }, acknowledged: false, manualAction: "retry", effectType: null });
    expect((await readRecords(alice.runtime, alice.keys)).pending().pendingOutbounds).toEqual([{ messageId: sent.messageId, channel: pair, outcome: "prepared", because: null, entries: ["retry", "cancel"] }]);

    answer = accepted;
    expect(await manual.retry(sent.messageId)).toMatchObject({ outcome: "submitted" });
    expect(wire.posts.map((post) => post.body)).toEqual([wire.posts[0]!.body, wire.posts[0]!.body]);
    expect(only(await channel(pair), "out")).toMatchObject({ outcome: { status: "submitted" }, manualAction: "none" });

    const second = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, { type: BASIC_MESSAGE, body: { content: "never mind" } });
    expect(await manual.cancel(second.messageId)).toMatchObject({ outcome: "cancelled" });
    const cancelled = (await channel(pair)).messages.find((message) => message.messageId === second.messageId)!;
    expect(cancelled).toMatchObject({ outcome: { status: "terminal", code: "cancelled" }, manualAction: "none" });
    expect((await readRecords(alice.runtime, alice.keys)).pending().pendingOutbounds).toEqual([]);
    await closeAll(alice, bob);
  });

  it("a claimed name stays beside the exact channel it came by and goes with its body; a profile counts as shared only once a transport accepted it there", async () => {
    const { alice, bob } = await parties();
    let answer = refused;
    const { manual, receive, channel } = await hosting(alice, () => answer());
    const routeId = (await scanVault(alice.runtime.vault, alice.keys)).routes.dids.get(ALICE)!.created!.boundRouteId;
    const { minted: other } = await createDid(alice.runtime, alice.keys, routeId, ALICE_OTHER);
    const pair = { localDid: alice.did, peerDid: bob.did };
    const elsewhere = { localDid: other.did, peerDid: bob.did };

    await receive(bob, { id: crypto.randomUUID(), type: PROFILE, body: { profile: { displayName: "Bob" } } });
    await receive(bob, { id: crypto.randomUUID(), body: { content: "at your other address" } }, other.longFormDid);
    const named = await channel(pair);
    expect(named.peerName).toEqual({ name: "Bob", messageId: only(named, "in").messageId });
    expect((await channel(elsewhere)).peerName).toBeNull();
    const fold = await scanVault(alice.runtime.vault, alice.keys);
    expect([fold.contacts.contacts.size, (await readRecords(alice.runtime, alice.keys)).contactIds()]).toEqual([0, []]);

    const profile = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, { type: PROFILE, body: { profile: { displayName: "Alice" } } });
    expect(await manual.retry(profile.messageId)).toMatchObject({ outcome: "failed" });
    expect((await channel(pair)).profileSubmitted).toBeNull();
    answer = accepted;
    expect(await manual.retry(profile.messageId)).toMatchObject({ outcome: "submitted" });
    expect([(await channel(pair)).profileSubmitted, (await channel(elsewhere)).profileSubmitted]).toEqual([profile.messageId, null]);

    await manual.eraseMessage(named.peerName!.messageId);
    const erased = await channel(pair);
    expect([erased.peerName, only(erased, "in").body, only(erased, "in").msg?.type]).toEqual([null, { state: "erased" }, PROFILE]);
    await closeAll(alice, bob);
  });

  it("a problem report is a diagnostic of the output its thread names only from that output's peer, and goes with the report's body", async () => {
    const { alice, bob } = await parties();
    const charlie = await directParty(3, "https://charlie.example/didcomm", CHARLIE);
    const { dispatcher, manual, receive, channel } = await hosting(alice);
    const pair = { localDid: alice.did, peerDid: bob.did };
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: bob.longFormDid } }, { type: BASIC_MESSAGE, body: { content: "hello" } });
    await dispatcher.run(sent.action);

    const report = { type: PROBLEM_REPORT_TYPE, pthid: sent.messageId, body: { code: "e.p.msg.unsupported", comment: "no handler for {1}", args: ["basicmessage"] } };
    await receive(charlie, { id: crypto.randomUUID(), ...report });
    expect(only(await channel(pair), "out").diagnostics).toEqual([]);

    await receive(bob, { id: crypto.randomUUID(), ...report });
    const reported = await channel(pair);
    const reportId = only(reported, "in").messageId;
    expect(only(reported, "out")).toMatchObject({ outcome: { status: "submitted" }, manualAction: "none", diagnostics: [{ kind: "remote-error", because: "e.p.msg.unsupported: no handler for basicmessage", report: reportId }] });
    expect(only(reported, "in")).toMatchObject({ kind: "error", manualAction: "none" });

    await manual.eraseMessage(reportId);
    expect(only(await channel(pair), "out").diagnostics).toEqual([]);
    await closeAll(alice, bob, charlie);
  });

  it("reads a report's comment with its arguments, and a body that says nothing as unknown", () => {
    expect(reportedProblem({ code: "e.p.xfer", comment: "{1} of {2} failed, {3}", args: ["one", 2] })).toBe("e.p.xfer: one of ? failed, ?");
    expect(reportedProblem({ code: "w.m.late" })).toBe("w.m.late");
    expect(reportedProblem({ comment: 7 })).toBe("unknown");
  });

  it("a receipt-integrity conflict is a diagnostic of the inputs it touches and leaves them no manual action, though a reply is still owed by the fold", async () => {
    const { alice, bob } = await parties();
    const pair = { localDid: alice.did, peerDid: bob.did };
    await received(alice, bob, crypto.randomUUID(), { type: PING_TYPE, body: { response_requested: true }, created_time: CREATED });
    await received(alice, bob, crypto.randomUUID(), { type: BASIC_MESSAGE, body: { content: "same ordinal" } });

    const records = await readRecords(alice.runtime, alice.keys);
    const record = await records.channel(pair);
    expect(record.messages).toHaveLength(2);
    for (const message of record.messages) expect(message).toMatchObject({ input: { status: "complete" }, manualAction: "none", completes: [], diagnostics: [{ kind: "receipt-integrity" }] });
    expect(records.pending().missingResponses).toMatchObject([{ effectType: PING_RESPONSE_EFFECT, entries: [] }]);
    await closeAll(alice, bob);
  });

  it("a manual rotation is notified under its decision; a second notification of it is a conflict no entry resolves", async () => {
    const { alice, bob } = await parties();
    const { wire, manual, receive, channel } = await hosting(alice);
    await receive(bob, { id: crypto.randomUUID(), body: { content: "hi" } });

    const rotated = await manual.rotate({ localDidId: ALICE, peerDid: bob.did });
    expect(rotated).toMatchObject({ existed: false, decision: { data: { sourceEventId: null } }, notification: { outcome: "created", dispatched: { outcome: "submitted" } } });
    expect(wire.posts).toHaveLength(1);
    const fold = await scanVault(alice.runtime.vault, alice.keys);
    const successor = { localDid: fold.routes.dids.get(rotated.successor)!.created!.did, peerDid: bob.did };
    const rotationEventId = rotated.decision.eventId as EventReference<"did.rotationSelected">;
    const notified = only(await channel(successor), "out");
    expect(notified).toMatchObject({ msg: { type: EMPTY_MESSAGE_TYPE }, outcome: { status: "submitted" }, verification: fold.continuity.status(rotationEventId), manualAction: "none", diagnostics: [] });

    const other = manualNotificationDraft(fold, uuidv7() as MessageId, successor, { type: EMPTY_MESSAGE_TYPE, body: {}, pleaseAck: [""], ack: [] }, rotationEventId);
    await alice.runtime.vault.commit(other.objects, [other.draft]);
    const records = await readRecords(alice.runtime, alice.keys);
    for (const message of (await records.channel(successor)).messages) expect(message).toMatchObject({ outcome: { status: "conflict" }, manualAction: "none", diagnostics: [{ kind: "outcome", because: "another notification is selected for the rotation" }] });
    const pending = records.pending();
    expect(pending.notificationConflicts).toEqual([{ rotationEventId, messageIds: [notified.messageId, other.draft.data.messageId].sort(), entries: [] }]);
    expect(pending.pendingOutbounds).toEqual([]);
    await closeAll(alice, bob);
  });

  it("a contact shows its selected channels, then the history verified continuity reaches, with where a send goes; deleting and blocking through the manual entries changes what is shown and nothing a message says", async () => {
    const { alice, bob } = await parties();
    const { manual, receive } = await hosting(alice);
    const pair = { localDid: alice.did, peerDid: bob.did };
    await alice.runtime.vault.commit(
      [],
      [vaultDraft("contact.created", { contactId: CONTACT, because: "user" }), vaultDraft("contact.petname", { contactId: CONTACT, name: "Bobby" }), vaultDraft("contact.flag", { contactId: CONTACT, flag: "pinned", value: true }), vaultDraft("contact.channelsSet", { contactId: CONTACT, channels: [pair] })]
    );
    await receive(bob, { id: crypto.randomUUID(), type: PROFILE, body: { profile: { displayName: "Robert" } } });

    let contact = await (await readRecords(alice.runtime, alice.keys)).contact(CONTACT);
    expect(contact).toMatchObject({ contacts: [{ contactId: CONTACT, origin: "user", deleted: false, petname: "Bobby" }], petname: "Bobby", flags: { pinned: true }, writeTo: [pair], defaultWriteTo: pair, preference: null, diagnostics: [] });
    expect(contact.channels).toMatchObject([{ channel: pair, selected: true, peerName: { name: "Robert" }, send: { status: "open" } }]);
    expect(JSON.parse(JSON.stringify(contact))).toEqual(contact);

    const rotated = await manual.rotate({ localDidId: ALICE, peerDid: bob.did });
    const { did: successorDid, longFormDid } = (await scanVault(alice.runtime.vault, alice.keys)).routes.dids.get(rotated.successor)!.created!;
    await receive(bob, { id: crypto.randomUUID(), body: { content: "got your new address" } }, longFormDid);
    contact = await (await readRecords(alice.runtime, alice.keys)).contact(CONTACT);
    const successor = { localDid: successorDid, peerDid: bob.did };
    expect(contact.channels.map(({ channel, selected }) => ({ channel, selected }))).toEqual([
      { channel: pair, selected: true },
      { channel: successor, selected: false },
    ]);
    expect([contact.writeTo, contact.defaultWriteTo, contact.channels[1]!.peerName]).toEqual([[successor], successor, null]);

    await manual.blockChannels([pair], true);
    contact = await (await readRecords(alice.runtime, alice.keys)).contact(CONTACT);
    expect([contact.writeTo, contact.channels.map((record) => record.blocked)]).toEqual([[], [true, true]]);

    await manual.deleteContact(CONTACT);
    const records = await readRecords(alice.runtime, alice.keys);
    contact = await records.contact(CONTACT);
    expect([records.contactIds(), contact.channels, contact.diagnostics]).toEqual([[], [], [`the contact ${CONTACT} is deleted`]]);
    expect((await records.channel(pair)).messages).toHaveLength(1);
    await closeAll(alice, bob);
  });

  it("lists a one-use invitation as available, then consumed by the peer whose first message took it", async () => {
    const { alice, bob } = await parties();
    const { receive } = await hosting(alice);
    const disclosed = await disclose(null, alice.runtime, alice.keys, ALICE, { as: "oob", uses: "one" });
    const before = (await readRecords(alice.runtime, alice.keys)).invitations();
    expect(before).toMatchObject([{ disclosureEventId: disclosed.disclosed.eventId, didId: ALICE, localDid: alice.did, uses: "one", state: { status: "available" }, consumer: null }]);

    await afterReceipt(alice.runtime, alice.keys, await receive(bob, { id: crypto.randomUUID(), pthid: before[0]!.oobId, body: { content: "hello" } }));
    expect((await readRecords(alice.runtime, alice.keys)).invitations()).toMatchObject([{ state: { status: "consumed", consumer: bob.did }, consumer: bob.did }]);
    await closeAll(alice, bob);
  });
});
