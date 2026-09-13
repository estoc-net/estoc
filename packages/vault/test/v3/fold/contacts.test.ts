import { describe, expect, it } from "vitest";

import { foldContacts, type ContactId, type Did, type EventReference } from "../../../src/v3/index.js";
import { AUTHOR2, DID_ID, DID_ID2, Scene, expectOrderFree } from "./helpers.js";

const A = "019b2a63-48bf-7214-961d-4c3f97cb95da" as ContactId;
const B = "019b2a66-c794-7b41-bff1-68a4ecdd0b67" as ContactId;
const C = "019b2a67-0000-7b41-bff1-68a4ecdd0b67" as ContactId;
const D = "019b2a68-0000-7b41-bff1-68a4ecdd0b67" as ContactId;
const BOB = "did:web:bob.example" as Did;
const CAROL = "did:web:carol.example" as Did;

describe("the contact fold", () => {
  it("takes the latest petname, each flag's latest value and the latest DID preference by canonical order", () => {
    const scene = new Scene();
    scene.add("contact.created", { contactId: A, because: "automatic" });
    scene.add("contact.created", { contactId: A, because: "user" });
    scene.add("contact.petname", { contactId: A, name: "al" });
    scene.add("contact.petname", { contactId: A, name: "alice" });
    scene.add("contact.petname", { contactId: A, name: "old" }, { at: "2026-09-01T00:00:00.000Z", author: AUTHOR2 });
    scene.add("contact.flag", { contactId: A, flag: "pinned", value: true });
    scene.add("contact.flag", { contactId: A, flag: "muted", value: true });
    scene.add("contact.flag", { contactId: A, flag: "pinned", value: false });
    scene.add("contact.useDid", { contactId: A, didId: DID_ID, because: "manual" });
    scene.add("contact.useDid", { contactId: A, didId: DID_ID2, because: "relationship" });
    const contact = foldContacts(scene.set()).get(A)!;
    expect(contact).toMatchObject({ contactId: A, origin: "automatic", deleted: false, petname: "alice", useDid: { didId: DID_ID2, because: "relationship" }, peerDidSeeds: [], mergedWith: [], faults: [] });
    expect([...contact.flags]).toEqual([
      ["muted", true],
      ["pinned", false],
    ]);
    expectOrderFree(scene.events, foldContacts);
  });

  it("keeps every peer DID added and not removed by an exact reference, whatever the clocks say", () => {
    const scene = new Scene();
    const bob = scene.add("contact.peerDidAdded", { contactId: A, did: BOB, because: "oob" }, { at: "2026-09-13T12:00:00.000Z" });
    const carol = scene.add("contact.peerDidAdded", { contactId: A, did: CAROL, because: "user" }, { at: "2026-09-13T10:00:00.000Z" });
    scene.add("contact.peerDidRemoved", { contactId: A, addEventId: bob.eventId as EventReference<"contact.peerDidAdded"> }, { at: "2026-09-13T09:00:00.000Z" });
    const contact = foldContacts(scene.set()).get(A)!;
    expect(contact.peerDidSeeds).toEqual([{ did: CAROL, because: "user", eventId: carol.eventId }]);
    expect(contact.origin).toBeNull();
    expectOrderFree(scene.events, foldContacts);
  });

  it("faults a removal that names a missing add, another type or another contact's add, and removes nothing for it", () => {
    const scene = new Scene();
    const bob = scene.add("contact.peerDidAdded", { contactId: A, did: BOB, because: "oob" });
    const other = scene.add("contact.peerDidAdded", { contactId: B, did: CAROL, because: "oob" });
    const created = scene.add("contact.created", { contactId: A, because: "user" });
    const missing = scene.add("contact.peerDidRemoved", { contactId: A, addEventId: "019b2a99-0000-7000-8000-000000000001" as EventReference<"contact.peerDidAdded"> });
    const wrongType = scene.add("contact.peerDidRemoved", { contactId: A, addEventId: created.eventId as EventReference<"contact.peerDidAdded"> });
    const wrongContact = scene.add("contact.peerDidRemoved", { contactId: A, addEventId: other.eventId as EventReference<"contact.peerDidAdded"> });
    const contacts = foldContacts(scene.set());
    expect(contacts.get(A)?.peerDidSeeds.map((seed) => seed.eventId)).toEqual([bob.eventId]);
    expect(contacts.get(B)?.peerDidSeeds.map((seed) => seed.eventId)).toEqual([other.eventId]);
    expect(contacts.get(A)?.faults).toEqual([
      `removal ${missing.eventId} names an add that is not here`,
      `removal ${wrongType.eventId} names contact.created ${created.eventId}, not an add`,
      `removal ${wrongContact.eventId} names contact ${B}'s add`,
    ]);
  });

  it("tombstones a contact and groups merged contacts transitively for display without touching their decisions", () => {
    const scene = new Scene();
    scene.add("contact.petname", { contactId: A, name: "alice" });
    scene.add("contact.petname", { contactId: B, name: "bobby" });
    scene.add("contact.merged", { contactId: A, fromContactId: B });
    scene.add("contact.merged", { contactId: C, fromContactId: B });
    scene.add("contact.merged", { contactId: D, fromContactId: "019b2a69-0000-7b41-bff1-68a4ecdd0b67" as ContactId });
    scene.add("contact.deleted", { contactId: B });
    const contacts = foldContacts(scene.set());
    expect(contacts.get(A)).toMatchObject({ petname: "alice", deleted: false, mergedWith: [B, C] });
    expect(contacts.get(B)).toMatchObject({ petname: "bobby", deleted: true, mergedWith: [A, C] });
    expect(contacts.get(C)).toMatchObject({ petname: null, mergedWith: [A, B] });
    expect(contacts.get(D)?.mergedWith).toEqual(["019b2a69-0000-7b41-bff1-68a4ecdd0b67"]);
    expect([...contacts.keys()]).toEqual([A, B, C, D, "019b2a69-0000-7b41-bff1-68a4ecdd0b67"]);
    expectOrderFree(scene.events, foldContacts);
  });
});
