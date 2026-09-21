import type { Event } from "@estoc/event-store";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import { foldErasures, foldVault, foldVaultChecked, heldRoots, rawCidOfBytes, readState, retainedRoots, VaultEventSet, type Cid, type EventId, type MessageId } from "../../src/index.js";
import { AUTHOR, expectOrderFree } from "./helpers.js";
import { intent, noObjects, packageOf, receipt, resolved, vaults } from "./scene.js";

const held = (events: readonly Event[]): Set<Cid> => heldRoots(VaultEventSet.of(events));

describe("held roots", () => {
  it("hold every root an event retains, release what an erasure names from that message only, and keep bytes another message shares", async () => {
    const { scene, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const body = rawCidOfBytes(new Uint8Array([1, 2, 3]));
    const attachment = rawCidOfBytes(new Uint8Array([4]));
    const first = intent(scene, a0, b0, { bodyCid: body, attachmentCids: [attachment] });
    const second = intent(scene, a0, b0, { bodyCid: body });
    const inbound = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { bodyCid: attachment } });
    const document = root.data.documentCid;
    expect(held(scene.events)).toEqual(new Set([document, body, attachment]));
    expect(retainedRoots(VaultEventSet.of(scene.events)).filter((edge) => edge.eventId === first.eventId)).toEqual([
      { eventId: first.eventId, root: body },
      { eventId: first.eventId, root: attachment },
    ]);

    scene.add("message.erased", { messageId: first.data.messageId, dropCids: [body, attachment, document], because: "user" });
    expect(held(scene.events)).toEqual(new Set([document, body, attachment]));
    scene.add("message.erased", { messageId: second.data.messageId, dropCids: [body], because: "contact-deleted" });
    const erasures = foldErasures(VaultEventSet.of(scene.events));
    expect(held(scene.events)).toEqual(new Set([document, attachment]));
    expect(readState(erasures, first.data.messageId, body, true)).toBe("erased");
    expect(readState(erasures, inbound.data.messageId, attachment, true)).toBe("available");
    expect(readState(erasures, inbound.data.messageId, attachment, false)).toBe("missing");
    expect(readState(erasures, inbound.data.messageId, attachment, false, true)).toBe("not-yet-fetched");

    scene.add("message.erased", { messageId: inbound.data.messageId, dropCids: [attachment], because: "user" });
    expectOrderFree(scene.events, (set) => heldRoots(set));
    expect(held(scene.events)).toEqual(new Set([document]));
  });

  it("hold the roots of an event of an unknown type and of one whose payload does not read, whatever erasures say", async () => {
    const { scene, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const foreign = rawCidOfBytes(new Uint8Array([9]));
    const broken = rawCidOfBytes(new Uint8Array([10]));
    scene.events.push({ eventId: uuidv7() as EventId, at: "2026-09-13T00:00:00.000Z", author: AUTHOR, type: "message.future", roots: [foreign], data: {} });
    const messageId = uuidv7() as MessageId;
    scene.events.push({ eventId: uuidv7() as EventId, at: "2026-09-13T00:00:01.000Z", author: AUTHOR, type: "message.out", roots: [broken], data: { messageId } });
    scene.add("message.erased", { messageId, dropCids: [broken, foreign], because: "user" });
    expect(held(scene.events)).toEqual(new Set([root.data.documentCid, foreign, broken]));
  });

  it("hold a prepared envelope until its message is submitted, terminated or erased, and hold it under a conflict or a peer's acknowledgement alone", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    const first = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { ack: [out.data.messageId] } });
    const heldOf = async () => (await foldVaultChecked(scene.set(), keys, noObjects)).held;
    expect((await heldOf()).has(first.data.envelopeCid)).toBe(true);

    const second = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    expect([...(await heldOf())].filter((cid) => cid === first.data.envelopeCid || cid === second.data.envelopeCid)).toHaveLength(2);

    scene.add("delivery.submitted", { messageId: out.data.messageId, packageId: first.data.packageId });
    let roots = await heldOf();
    expect(roots.has(first.data.envelopeCid)).toBe(false);
    expect(roots.has(second.data.envelopeCid)).toBe(false);
    expect(roots.has(out.data.bodyCid)).toBe(true);

    const cancelled = intent(scene, a0, b0);
    const unsent = packageOf(scene, cancelled, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("delivery.failed", { messageId: cancelled.data.messageId, code: "cancelled" });
    const never = intent(scene, a0, b0);
    const waiting = packageOf(scene, never, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("delivery.failed", { messageId: never.data.messageId, code: "expired" });
    roots = await heldOf();
    expect(roots.has(unsent.data.envelopeCid)).toBe(false);
    expect(roots.has(waiting.data.envelopeCid)).toBe(true);

    scene.add("message.erased", { messageId: never.data.messageId, dropCids: [waiting.data.envelopeCid], because: "user" });
    roots = await heldOf();
    expect(roots.has(waiting.data.envelopeCid)).toBe(false);
    expect(roots.has(never.data.bodyCid)).toBe(true);
    const checks = (await foldVaultChecked(scene.set(), keys, noObjects)).checks;
    expectOrderFree(scene.events, (set) => foldVault(set, checks).held);
  });
});
