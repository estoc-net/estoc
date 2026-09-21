import { describe, expect, it } from "vitest";

import { foldContacts, type ContactId } from "../../src/index.js";
import { AUTHOR2, expectOrderFree, Scene } from "./helpers.js";
import { channel, vaults } from "./scene.js";

const ALICE = "019b2a63-48bf-7214-961d-4c3f97cb95da" as ContactId;
const BOB = "019b2a66-c794-7b41-bff1-68a4ecdd0b67" as ContactId;
const CAROL = "019b2a70-0000-7000-8000-000000000003" as ContactId;

describe("the contacts", () => {
  it("hold each ID's latest decisions, the whole selection replaced or cleared, and hint at grouping from either side", async () => {
    const { scene, a0, a1, b0, b1 } = await vaults();
    scene.add("contact.created", { contactId: ALICE, because: "user" });
    scene.add("contact.channelsSet", { contactId: ALICE, channels: [channel(a0, b0)] });
    scene.add("contact.petname", { contactId: ALICE, name: "alice" });
    scene.add("contact.petname", { contactId: ALICE, name: "Alice" });
    scene.add("contact.flag", { contactId: ALICE, flag: "pinned", value: true });
    scene.add("contact.flag", { contactId: ALICE, flag: "muted", value: true });
    scene.add("contact.flag", { contactId: ALICE, flag: "pinned", value: false });
    scene.add("contact.useDid", { contactId: ALICE, didId: a0.didId, because: "channel" });
    scene.add("contact.useDid", { contactId: ALICE, didId: a1.didId, because: "manual" });
    scene.add("contact.channelsSet", { contactId: ALICE, channels: [channel(a0, b0), channel(a1, b1)].sort((x, y) => (x.localDid < y.localDid ? -1 : 1)) });
    scene.add("contact.created", { contactId: BOB, because: "automatic" });
    scene.add("contact.channelsSet", { contactId: BOB, channels: [channel(a0, b0)] });
    scene.add("contact.channelsSet", { contactId: BOB, channels: [] });
    scene.add("contact.merged", { contactId: ALICE, fromContactId: BOB });
    scene.add("contact.channelsSet", { contactId: CAROL, channels: [channel(a1, b1)] });
    const contacts = foldContacts(scene.set());
    expect(contacts.contacts.get(ALICE)).toMatchObject({
      origin: "user",
      deleted: false,
      petname: "Alice",
      flags: new Map([
        ["pinned", false],
        ["muted", true],
      ]),
      useDid: { didId: a1.didId, because: "manual" },
      mergedWith: [BOB],
    });
    expect(new Set(contacts.contacts.get(ALICE)!.channels.map((c) => `${c.localDid} ${c.peerDid}`))).toEqual(new Set([`${a0.did} ${b0.did}`, `${a1.did} ${b1.did}`]));
    expect(contacts.contacts.get(BOB)).toMatchObject({ origin: "automatic", petname: null, useDid: null, channels: [], mergedWith: [ALICE] });
    expect(contacts.contacts.get(CAROL)).toMatchObject({ origin: null, channels: [channel(a1, b1)], mergedWith: [] });
    expect(contacts.selecting(channel(a0, b0)).map((c) => c.contactId)).toEqual([ALICE]);
    expect(contacts.selecting(channel(a1, b1)).map((c) => c.contactId)).toEqual([ALICE, CAROL]);
    expect(contacts.selecting(channel(a1, b0))).toEqual([]);
    expectOrderFree(scene.events, (set) => foldContacts(set));
  });

  it("keeps a tombstone over anything later, the channels staying available outside the contact", async () => {
    const { scene, a0, b0 } = await vaults();
    scene.add("contact.created", { contactId: ALICE, because: "user" });
    scene.add("contact.deleted", { contactId: ALICE });
    scene.add("contact.channelsSet", { contactId: ALICE, channels: [channel(a0, b0)] }, { author: AUTHOR2 });
    scene.add("contact.petname", { contactId: ALICE, name: "back" });
    const contacts = foldContacts(scene.set());
    expect(contacts.contacts.get(ALICE)).toMatchObject({ deleted: true, petname: "back", channels: [channel(a0, b0)] });
    expect(contacts.selecting(channel(a0, b0))).toEqual([]);
    expectOrderFree(scene.events, (set) => foldContacts(set));
  });

  it("is empty over no contact events", () => {
    const contacts = foldContacts(new Scene().set());
    expect(contacts.contacts.size).toBe(0);
  });
});
