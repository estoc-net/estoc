import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import { PROBLEM_REPORT_TYPE, compareChannels, foldVault, foldVaultChecked, type ContactId, type ContactView, type Keys } from "../../src/index.js";
import { expectOrderFree, type Scene } from "./helpers.js";
import { blocked, channel, intent, noObjects, proof, receipt, resolved, rotation, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null) => foldVaultChecked(scene.set(), keys, noObjects);

const proofFreeReceipt = (scene: Scene, local: Local, peer: Peer, ordinal: number) => receipt(scene, { local, peer, resolution: resolved(scene, local.didId, peer), ordinal });

const receiptCarryingProof = async (scene: Scene, peerKeys: Keys, local: Local, predecessor: Peer, successor: Peer, ordinal: number) =>
  receipt(scene, { local, peer: successor, resolution: resolved(scene, local.didId, successor), ordinal, fromPrior: await proof(peerKeys, predecessor, successor) });

const CONTACT = "019b7100-0000-7000-8000-000000000c01" as ContactId;
const CONTACT2 = "019b7100-0000-7000-8000-000000000c02" as ContactId;
const UNRESOLVED = "019b7100-0000-7000-8000-000000000c03" as ContactId;

const contact = (scene: Scene, contactId: ContactId, channels: readonly { local: Local; peer: Peer }[]) => {
  scene.add("contact.created", { contactId, because: "user" });
  scene.add("contact.channelsSet", { contactId, channels: channels.map(({ local, peer }) => channel(local, peer)).sort(compareChannels) });
};

const viewSnapshot = (view: ContactView) => ({
  channels: view.channels.map((c) => ({ channel: c.channel, selected: c.selected, head: c.head, send: c.send, inbound: c.inbound.map((e) => e.messageId), outbound: c.outbound.map((o) => o.messageId) })),
  writeTo: view.writeTo,
  preference: view.preference,
  defaultWriteTo: view.defaultWriteTo,
});

describe("a channel view", () => {
  it("lists the inputs in first-receipt order and the outbounds fixed to the channel, and puts a problem report beside the outbound its thread names when the carrier may answer it", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const later = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2 });
    const earlier = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const out = intent(scene, a0, b0);
    const elsewhere = intent(scene, a1, b0);
    const report = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 3, overrides: { msgType: PROBLEM_REPORT_TYPE, pthid: out.data.messageId } });
    const reportOfElsewhere = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4, overrides: { msgType: PROBLEM_REPORT_TYPE, pthid: elsewhere.data.messageId } });
    scene.add("message.erased", { messageId: reportOfElsewhere.data.messageId, dropCids: [reportOfElsewhere.data.bodyCid], because: "user" });
    const vault = await fold(scene, keys);
    const view = vault.views.channel(channel(a0, b0));
    expect(view.inbound.map((execution) => execution.messageId)).toEqual([earlier, later, report, reportOfElsewhere].map((event) => event.data.messageId));
    expect(view.outbound.map((outbound) => outbound.messageId)).toEqual([out.data.messageId]);
    expect(view.errors.map(({ execution, outbound }) => [execution.messageId, outbound?.messageId ?? null, execution.erased])).toEqual([
      [report.data.messageId, out.data.messageId, false],
      [reportOfElsewhere.data.messageId, null, true],
    ]);
    expect(view).toMatchObject({ head: channel(a0, b0), superseded: false, blocked: false, conflicted: false, send: { status: "open" } });
    expect(vault.views.channel(channel(a1, b0)).outbound.map((outbound) => outbound.messageId)).toEqual([elsewhere.data.messageId]);
    expect(vault.views.channel(channel(a0, b0))).toBe(view);
  });

  it("closes the gate for a local DID that cannot send, a denied pair or conflicted continuity, and only for automatic work once the peer has moved on", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    proofFreeReceipt(scene, a0, b0, 1);
    await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    proofFreeReceipt(scene, a1, b0, 3);
    blocked(scene, a1, b0);
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    let vault = await fold(scene, keys);
    expect(vault.views.channel(channel(a0, b0)).send).toEqual({ status: "closed", because: "the local DID cannot send: retired: done" });
    expect(vault.views.channel(channel(a1, b0)).send).toEqual({ status: "closed", because: "the channel is denied" });
    expect(vault.views.channel(channel(a0, b1)).send).toEqual({ status: "closed", because: "the local DID cannot send: retired: done" });
    vault = await fold(scene, null);
    expect(vault.views.channel(channel(a1, b0)).send.status).toBe("closed");

    const { scene: fresh, keys: freshKeys, peerKeys: freshPeerKeys, a0: c0, b0: d0, b1: d1 } = await vaults();
    proofFreeReceipt(fresh, c0, d0, 1);
    await receiptCarryingProof(fresh, freshPeerKeys, c0, d0, d1, 2);
    vault = await fold(fresh, freshKeys);
    const old = vault.views.channel(channel(c0, d0));
    expect(old).toMatchObject({ superseded: true, send: { status: "open" }, head: channel(c0, d1) });
    expect(vault.views.channel(channel(c0, d1))).toMatchObject({ superseded: false, send: { status: "open" }, head: channel(c0, d1) });
  });
});

describe("a contact view", () => {
  it("derives related history from the selected channel over verified continuity, writes to the joined head, and keeps a preference for the predecessor pointing at the head", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    const atHead = intent(scene, a1, b1);
    const unrelated = proofFreeReceipt(scene, a2, b0, 3);
    contact(scene, CONTACT, [{ local: a0, peer: b0 }]);
    scene.add("contact.useDid", { contactId: CONTACT, didId: a0.didId, because: "user" });
    const vault = await fold(scene, keys);
    expect(vault.continuity.status(decision.cid)).toEqual({ status: "verified" });
    const view = vault.views.contact(CONTACT);
    expect(view.contacts.map((c) => c.contactId)).toEqual([CONTACT]);
    expect(view.channels.map((c) => [c.channel, c.selected])).toEqual([
      [channel(a0, b0), true],
      ...[channel(a0, b1), channel(a1, b0), channel(a1, b1)].sort(compareChannels).map((c) => [c, false]),
    ]);
    expect(view.channels.flatMap((c) => c.inbound.map((e) => e.messageId))).toEqual([source.data.messageId, carrier.data.messageId]);
    expect(view.channels.flatMap((c) => c.outbound.map((o) => o.messageId))).toEqual([atHead.data.messageId]);
    expect(vault.views.channel(channel(a2, b0)).inbound.map((e) => e.messageId)).toEqual([unrelated.data.messageId]);
    expect(view.writeTo).toEqual([channel(a1, b1)]);
    expect(view.preference).toEqual({ didId: a0.didId, matches: [channel(a1, b1)] });
    expect(view.defaultWriteTo).toEqual(channel(a1, b1));
    expectOrderFree(scene.events, (set) => viewSnapshot(foldVault(set, vault.checks).views.contact(CONTACT)));
  });

  it("offers every distinct eligible head, defaults only when one is left after the preference, and follows the preference to no unrelated channel", async () => {
    const { scene, keys, a0, a1, a2, b0, b1 } = await vaults();
    proofFreeReceipt(scene, a0, b0, 1);
    proofFreeReceipt(scene, a1, b1, 2);
    proofFreeReceipt(scene, a2, b0, 3);
    contact(scene, CONTACT, [
      { local: a0, peer: b0 },
      { local: a1, peer: b1 },
    ]);
    let vault = await fold(scene, keys);
    let view = vault.views.contact(CONTACT);
    expect(view.writeTo).toEqual([channel(a0, b0), channel(a1, b1)].sort(compareChannels));
    expect(view).toMatchObject({ preference: null, defaultWriteTo: null });

    scene.add("contact.useDid", { contactId: CONTACT, didId: a1.didId, because: "user" });
    vault = await fold(scene, keys);
    view = vault.views.contact(CONTACT);
    expect(view.preference).toEqual({ didId: a1.didId, matches: [channel(a1, b1)] });
    expect(view.defaultWriteTo).toEqual(channel(a1, b1));

    scene.add("contact.useDid", { contactId: CONTACT, didId: a2.didId, because: "user" });
    vault = await fold(scene, keys);
    view = vault.views.contact(CONTACT);
    expect(view.preference).toEqual({ didId: a2.didId, matches: [] });
    expect(view.defaultWriteTo).toBeNull();
    expect(view.channels.map((c) => c.channel)).not.toContainEqual(channel(a2, b0));
  });

  it("drops a head that cannot send without falling back to the channel it replaced, and a channel a merged view already shows is shown once", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    blocked(scene, a0, b1);
    contact(scene, CONTACT, [{ local: a0, peer: b0 }]);
    contact(scene, CONTACT2, [{ local: a0, peer: b0 }]);
    scene.add("contact.merged", { contactId: CONTACT, fromContactId: CONTACT2 });
    const vault = await fold(scene, keys);
    const view = vault.views.contact(CONTACT, CONTACT2, CONTACT);
    expect(view.contacts.map((c) => c.contactId)).toEqual([CONTACT, CONTACT2]);
    expect(view.channels.map((c) => [c.channel, c.selected])).toEqual([
      [channel(a0, b0), true],
      [channel(a0, b1), false],
    ]);
    expect(view.channels[0]!.inbound.map((e) => e.messageId)).toEqual([source.data.messageId]);
    expect(view.writeTo).toEqual([]);
    expect(view.defaultWriteTo).toBeNull();
    expect(vault.views.channel(channel(a0, b0)).send).toEqual({ status: "open" });
  });

  it("selects nothing for a deleted contact or one no event names, shows a selection no creation resolves with its origin missing, and applies the preferences of several contacts only when they agree", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    proofFreeReceipt(scene, a0, b0, 1);
    proofFreeReceipt(scene, a1, b1, 2);
    contact(scene, CONTACT, [{ local: a0, peer: b0 }]);
    contact(scene, CONTACT2, [{ local: a1, peer: b1 }]);
    scene.add("contact.useDid", { contactId: CONTACT, didId: a0.didId, because: "user" });
    scene.add("contact.useDid", { contactId: CONTACT2, didId: a1.didId, because: "user" });
    scene.add("contact.channelsSet", { contactId: UNRESOLVED, channels: [channel(a1, b1)] });
    let vault = await fold(scene, keys);
    expect(vault.views.contact(CONTACT, CONTACT2)).toMatchObject({ preference: null, defaultWriteTo: null });
    expect(vault.views.contact(CONTACT, CONTACT2).writeTo).toHaveLength(2);
    expect(vault.views.contact(uuidv7() as ContactId)).toMatchObject({ contacts: [{ origin: null, channels: [] }], channels: [], writeTo: [], preference: null, defaultWriteTo: null });
    expect(vault.views.contact(UNRESOLVED)).toMatchObject({ contacts: [{ origin: null, channels: [channel(a1, b1)] }], writeTo: [channel(a1, b1)], defaultWriteTo: channel(a1, b1) });

    scene.add("contact.deleted", { contactId: CONTACT2 });
    vault = await fold(scene, keys);
    const view = vault.views.contact(CONTACT, CONTACT2);
    expect(view.channels.map((c) => c.channel)).toEqual([channel(a0, b0)]);
    expect(view).toMatchObject({ preference: { didId: a0.didId, matches: [channel(a0, b0)] }, defaultWriteTo: channel(a0, b0) });
  });
});
