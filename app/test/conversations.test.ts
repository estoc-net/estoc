import { describe, expect, it } from "vitest";

import { conversationsOf } from "../src/core/conversations.js";
import type { JsonObject } from "@estoc/event-store";

import type { Channel, ChannelRecord, ContactId, Did, MessageId, MessageRecord, ObservationRecord, Snapshot } from "../src/core/types.js";

const A0 = "did:peer:4zA0" as Did;
const A1 = "did:peer:4zA1" as Did;
const B0 = "did:peer:4zB0" as Did;
const B1 = "did:peer:4zB1" as Did;
const CONTACT = "019b0000-0000-7000-8000-0000000000f0" as ContactId;

const at = (hour: number): string => `2026-09-26T${String(hour).padStart(2, "0")}:00:00.000Z`;

const inbound = (channel: Channel, messageId: string, body: JsonObject, hour: number, type = "https://didcomm.org/basicmessage/2.0/message"): MessageRecord => ({
  messageId: messageId as MessageId,
  direction: "in",
  channel,
  contactIds: [],
  at: at(hour),
  msg: { type, thid: null, pthid: null, createdTime: null, expiresTime: null },
  body: { state: "available", body, attachments: [] },
  kind: "application",
  effectType: null,
  input: { status: "complete" },
  outcome: null,
  acknowledged: false,
  late: false,
  verification: { status: "not-present" },
  manualAction: "none",
  completes: [],
  diagnostics: [],
});

const observation = (channel: Channel, cid: string, hour: number, disposition: ObservationRecord["disposition"]): ObservationRecord => ({
  sourceEventCid: cid as ObservationRecord["sourceEventCid"],
  messageId: `input-of-${cid}` as MessageId,
  channel,
  at: at(hour),
  standing: { status: "complete" },
  verification: { status: "not-present" },
  disposition,
  contradicting: false,
});

const channelRecord = (channel: Channel, head: Channel, messages: MessageRecord[], observations: ObservationRecord[], peerName: ChannelRecord["peerName"] = null): ChannelRecord => ({
  channel,
  head,
  superseded: channel.peerDid !== head.peerDid,
  blocked: false,
  conflicted: false,
  send: channel.peerDid === head.peerDid ? { status: "open" } : { status: "closed", because: "the peer moved on" },
  peerName,
  profileSubmitted: null,
  messages,
  observations,
});

const snapshotOf = (channels: ChannelRecord[], contacts: Snapshot["contacts"]): Snapshot => ({
  anchor: "did:key:z6MkAnchor" as Did,
  label: "Alice",
  restoreUnexplained: false,
  mediations: [],
  dids: [],
  contacts,
  channels,
  unplaced: { inputs: [], outputs: [] },
  invitations: [],
  pending: { pendingOutbounds: [], missingResponses: [], missingNotifications: [], notificationConflicts: [], pendingProofs: [] },
});

describe("a conversation", () => {
  const old: Channel = { localDid: A0, peerDid: B0 };
  const current: Channel = { localDid: A1, peerDid: B1 };
  const profile = inbound(current, "claim", { profile: { displayName: "Bob" } }, 12, "https://didcomm.org/user-profile/1.0/profile");
  const channels = [
    channelRecord(
      old,
      current,
      [inbound(old, "hello", { content: "hello" }, 10)],
      [observation(old, "cid-hello", 10, { status: "admitted" }), observation(old, "cid-left", 14, { status: "ignored-superseded" }), observation(old, "cid-early", 8, { status: "pending-admission", because: "the source's authentication is incomplete" })]
    ),
    channelRecord(current, current, [profile, inbound(current, "later", { content: "later" }, 13)], [observation(current, "cid-claim", 12, { status: "admitted" }), observation(current, "cid-later", 13, { status: "admitted" }), observation(current, "cid-forged", 11, { status: "refused", because: "the source's proof is invalid" })], { name: "Bob", messageId: profile.messageId }),
  ];

  it("reads its thread and the peer's claimed name from the admitted messages alone, and lists what was not admitted apart, by the time it was recorded, with nothing it carries", () => {
    const [conversation] = conversationsOf(snapshotOf(channels, [{ contacts: [{ contactId: CONTACT, origin: null, deleted: false, petname: "Bobby" }], petname: "Bobby", flags: {}, channels: [{ channel: current, selected: true }, { channel: old, selected: false }], writeTo: [current], defaultWriteTo: current, preference: null, diagnostics: [] }]));
    expect(conversation).toMatchObject({ contactId: CONTACT, claimedName: "Bob" });
    expect(conversation!.messages.map(({ messageId, at }) => [messageId, at])).toEqual([
      ["hello", at(10)],
      ["claim", at(12)],
      ["later", at(13)],
    ]);
    expect(conversation!.unadmitted.map(({ sourceEventCid, at, disposition }) => [sourceEventCid, at, disposition.status])).toEqual([
      ["cid-early", at(8), "pending-admission"],
      ["cid-forged", at(11), "refused"],
      ["cid-left", at(14), "ignored-superseded"],
    ]);
    for (const listed of conversation!.unadmitted) expect(Object.keys(listed).sort()).toEqual(["at", "channel", "contradicting", "disposition", "messageId", "sourceEventCid", "standing", "verification"]);
  });

  it("shows an observation admitted once the evidence it waited for came in as the message it carries, in the thread by its time, and no longer apart", () => {
    const waiting = observation(current, "cid-waited", 11, { status: "pending-admission", because: "the source's proof is not yet verified" });
    const before = channelRecord(current, current, [profile], [observation(current, "cid-claim", 12, { status: "admitted" }), waiting]);
    const after = channelRecord(current, current, [profile, inbound(current, waiting.messageId, { content: "as I was saying" }, 11)], [before.observations[0]!, { ...waiting, verification: { status: "verified" }, disposition: { status: "admitted" } }]);
    const [shownBefore] = conversationsOf(snapshotOf([before], []));
    const [shownAfter] = conversationsOf(snapshotOf([after], []));
    expect(shownBefore!.messages.map(({ messageId }) => messageId)).toEqual(["claim"]);
    expect(shownBefore!.unadmitted.map(({ sourceEventCid, disposition }) => [sourceEventCid, disposition.status])).toEqual([["cid-waited", "pending-admission"]]);
    expect(shownAfter!.messages.map(({ messageId, at }) => [messageId, at])).toEqual([
      [waiting.messageId, at(11)],
      ["claim", at(12)],
    ]);
    expect(shownAfter!.unadmitted).toEqual([]);
  });

  it("shown by no contact lists the same apart under the head its channels lead to", () => {
    const [conversation] = conversationsOf(snapshotOf(channels, []));
    expect(conversation).toMatchObject({ contactId: null, claimedName: "Bob", writeTo: [current] });
    expect(conversation!.messages.map(({ messageId }) => messageId)).toEqual(["hello", "claim", "later"]);
    expect(conversation!.unadmitted.map(({ sourceEventCid }) => sourceEventCid)).toEqual(["cid-early", "cid-forged", "cid-left"]);
  });
});
