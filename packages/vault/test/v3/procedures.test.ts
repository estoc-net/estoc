import { MemoryVault, type Event } from "@estoc/event-store/v3";
import { importSeed } from "@estoc/keystore";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import {
  Keys,
  UnknownContact,
  automaticMessageId,
  checkVault,
  closeErasures,
  collectGarbage,
  contactIdOf,
  deleteContact,
  deletionOf,
  effectKey,
  eraseMessage,
  executionId,
  foldVault,
  rawCidOfBytes,
  relationshipId,
  scanVault,
  senderGate,
  signFromPrior,
  sweepDeleted,
  unfinishedWork,
  vaultHeldRoots,
  VaultEventSet,
  type Cid,
  type ContactId,
  type MessageId,
  type UnfinishedWork,
  type VaultChecks,
  type WorkOptions,
} from "../../src/v3/index.js";
import { DID_ID, DID_ID2, DID_ID3, ROUTE, SEED, Scene, cidOf, expectOrderFree } from "./fold/helpers.js";
import { CONTACT, CONTACT2, IAT, automatic, bound, intent, localEdge, noObjects, packageOf, peerRotation, receipt, ref, resolved, vaults } from "./fold/scene.js";

const encoder = new TextEncoder();
const PING = "https://didcomm.org/trust-ping/2.0/ping";
const PROFILE = "https://didcomm.org/user-profile/1.0/profile";

/** A vault in memory holding the scene's events and the bytes of every text named. */
async function vaultOf(scene: Scene, texts: readonly string[] = []): Promise<MemoryVault> {
  const vault = new MemoryVault({ metadata: { version: 3, anchor: await Keys.anchorOf(await importSeed(SEED)) } });
  for (const text of texts) await vault.stores.objects.putObject(cidOf(text), encoder.encode(text));
  await vault.ingest(scene.events);
  return vault;
}

const has = (vault: MemoryVault, cid: Cid) => vault.vault.objects.has(cid);

async function bornAtRoot() {
  const v = await vaults();
  const { scene, a0, b0 } = v;
  const root = resolved(scene, a0.didId, b0);
  const { R, bound: binding } = bound(scene, a0, b0, root);
  return { ...v, R, binding, root };
}

describe("erasing a message", () => {
  it("releases every root the message's events and packages still name in one erase, collects what nothing else holds, and erases nothing twice", async () => {
    const { scene, keys, R, a0, b0, root } = await bornAtRoot();
    const attachment = cidOf("attachment");
    const out = intent(scene, R, { attachmentCids: [attachment] });
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const other = intent(scene, R, { bodyCid: out.data.bodyCid });
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, "attachment", `envelope ${pkg.data.packageId}`]);
    expect(await has(vault, attachment)).toBe(true);

    const { events, collected } = await eraseMessage(vault, keys, out.data.messageId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ messageId: out.data.messageId, dropCids: [attachment, out.data.bodyCid, pkg.data.envelopeCid].sort(), because: "user" });
    expect(events[0]!.roots).toEqual([]);
    expect(collected.removed.sort()).toEqual([attachment, pkg.data.envelopeCid].sort());
    expect(await has(vault, out.data.bodyCid)).toBe(true);
    expect(await has(vault, attachment)).toBe(false);
    const fold = await scanVault(vault.vault, keys);
    expect(fold.held.has(out.data.bodyCid)).toBe(true);
    expect(fold.outbound.outbounds.get(other.data.messageId)!.outcome).toBe("queued");

    const again = await eraseMessage(vault, keys, out.data.messageId);
    expect(again.events).toEqual([]);
    expect(again.collected.removed).toEqual([]);
    expect((await eraseMessage(vault, keys, uuidv7() as MessageId)).events).toEqual([]);
  });

  it("erases the logical message, every observation ID of its execution, and the closure erases what an alias learned later names under the first erasure's reason", async () => {
    const { scene, keys, peerKeys, R, a0, b0, b1, root, binding } = await bornAtRoot();
    const first = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const wire = first.data.wireMessageId;
    const rotation = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 2);
    const before = scene.events.length;
    const aliasAttachment = cidOf("alias attachment");
    const alias = receipt(scene, { local: a0.didId, peer: b1, resolution: rotation.successor, binding, ordinal: 3, wire, transition: ref(rotation.edge), overrides: { attachmentCids: [aliasAttachment] } });
    const late = scene.events.splice(before);
    const vault = await vaultOf(scene, [`body ${wire}`]);

    const erased = await eraseMessage(vault, keys, first.data.messageId, "contact-deleted");
    expect(erased.events.map((event) => event.data)).toEqual([{ messageId: first.data.messageId, dropCids: [first.data.bodyCid], because: "contact-deleted" }]);
    expect(erased.collected.removed).toEqual([first.data.bodyCid]);

    await vault.stores.objects.putObject(aliasAttachment, encoder.encode("alias attachment"));
    await vault.ingest(late);
    const fold = await scanVault(vault.vault, keys);
    expect(fold.inbound.executions.get(executionId(R, wire))!.messageIds).toEqual([first.data.messageId, alias.data.messageId].sort());
    expect(fold.held.has(aliasAttachment)).toBe(true);
    const owed = unfinishedWork(fold).erasures;
    expect(owed.map((draft) => draft.data)).toEqual([{ messageId: alias.data.messageId, dropCids: [aliasAttachment, alias.data.bodyCid].sort(), because: "contact-deleted" }]);
    const closed = await closeErasures(vault, keys);
    expect(closed.events.map((event) => event.data)).toEqual(owed.map((draft) => draft.data));
    expect(closed.collected.removed).toEqual([aliasAttachment]);
    expect(unfinishedWork(await scanVault(vault.vault, keys)).erasures).toEqual([]);
    expect((await closeErasures(vault, keys)).events).toEqual([]);
  });

  it("hands the event store the same retention for collection, export and validation", async () => {
    const { scene, keys, R, a0, b0, root } = await bornAtRoot();
    const out = intent(scene, R);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("delivery.submitted", { messageId: out.data.messageId, packageId: pkg.data.packageId });
    const stray = rawCidOfBytes(encoder.encode("stray"));
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, `envelope ${pkg.data.packageId}`, "stray"]);
    expect(new Set(await vaultHeldRoots(keys)(vault.vault))).toEqual(new Set([root.data.documentCid, out.data.bodyCid]));
    const collected = await collectGarbage(vault, keys);
    expect(collected.removed.sort()).toEqual([pkg.data.envelopeCid, stray].sort());
    expect(await has(vault, out.data.bodyCid)).toBe(true);
  });
});

async function twoContacts() {
  const v = await vaults();
  const { scene, a0, a1, a2, b0, b1, b2 } = v;
  const root = resolved(scene, a0.didId, b0);
  const one = bound(scene, a0, b0, root);
  const root2 = resolved(scene, a1.didId, b1);
  const two = bound(scene, a1, b1, root2);
  const root3 = resolved(scene, a2.didId, b2);
  const three = bound(scene, a2, b2, root3);
  scene.add("contact.created", { contactId: CONTACT, because: "user" });
  scene.add("contact.created", { contactId: CONTACT2, because: "user" });
  scene.add("relationship.contactAssigned", { relationshipId: one.R, contactId: CONTACT });
  scene.add("relationship.contactAssigned", { relationshipId: two.R, contactId: CONTACT2 });
  scene.add("relationship.contactAssigned", { relationshipId: three.R, contactId: CONTACT });
  return { ...v, root, root2, root3, R1: one.R, R2: two.R, R3: three.R, binding1: one.bound, binding2: two.bound, binding3: three.bound };
}

describe("deleting a contact", () => {
  it("tombstones it, erases the messages attributed to it alone, retires the addresses no other relationship, birth or open disclosure needs and keeps the route another live address binds; a second call and a late message finish the same cleanup", async () => {
    const { scene, keys, a0, a2, b0, b2, root, root3, R1, R2, R3, binding1 } = await twoContacts();
    scene.add("did.disclosed", { didId: a2.didId, as: "profile", uses: "many", oobId: null, goal: null });
    const out = intent(scene, R1);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const inbound = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 1 });
    const elsewhere = intent(scene, R2);
    const shared = intent(scene, R3, { bodyCid: out.data.bodyCid });
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, `envelope ${pkg.data.packageId}`, `body ${inbound.data.wireMessageId}`, `body ${elsewhere.data.messageId}`]);

    const deleted = await deleteContact(vault, keys, CONTACT);
    expect(deleted.deletion).toMatchObject({ contactId: CONTACT, retiredDids: [a0.didId], retiredRoutes: [] });
    expect(deleted.deletion.tombstone!.data).toEqual({ contactId: CONTACT });
    expect(deleted.events.map((event) => [event.type, event.data])).toEqual([
      ["contact.deleted", { contactId: CONTACT }],
      ...[out, inbound, shared].sort((a, b) => (a.data.messageId < b.data.messageId ? -1 : 1)).map((message) => ["message.erased", { messageId: message.data.messageId, dropCids: message === out ? [out.data.bodyCid, pkg.data.envelopeCid].sort() : [message.data.bodyCid], because: "contact-deleted" }]),
      ["did.retired", { didId: a0.didId, because: "contact-deleted" }],
    ]);
    expect(deleted.collected.removed.sort()).toEqual([out.data.bodyCid, pkg.data.envelopeCid, inbound.data.bodyCid].sort());
    expect(await has(vault, elsewhere.data.bodyCid)).toBe(true);
    let fold = await scanVault(vault.vault, keys);
    expect(fold.contacts.get(CONTACT)!.deleted).toBe(true);
    expect(fold.routes.dids.get(a0.didId)!.retired).toBe("contact-deleted");
    expect(fold.routes.dids.get(a2.didId)!.retired).toBeNull();
    expect(fold.routes.routes.get(ROUTE)!.retired).toBeNull();
    expect(unfinishedWork(fold).deletions).toEqual([]);

    const again = await deleteContact(vault, keys, CONTACT);
    expect(again.events).toEqual([]);
    expect(again.deletion.tombstone).toBeNull();

    const lateScene = new Scene();
    const late = receipt(lateScene, { local: a2.didId, peer: b2, resolution: root3, binding: (await twoContacts()).binding3, ordinal: 2 });
    await vault.ingest([{ ...late, data: { ...late.data, relationshipBindingEventId: fold.relationships.relationships.get(R3)!.bindingEventIds[0]! } }]);
    fold = await scanVault(vault.vault, keys);
    expect(unfinishedWork(fold).deletions).toEqual([CONTACT]);
    const swept = await sweepDeleted(vault, keys);
    expect(swept.events.map((event) => event.data)).toEqual([{ messageId: late.data.messageId, dropCids: [late.data.bodyCid], because: "contact-deleted" }]);
    expect(unfinishedWork(await scanVault(vault.vault, keys)).deletions).toEqual([]);
    await expect(deleteContact(vault, keys, uuidv7() as ContactId)).rejects.toThrow(UnknownContact);
  });

  it("retires the route once every address binding it is retired, one of them for a deleted contact, and keeps an address disclosed by an invitation no relationship of the contact consumed", async () => {
    const { scene, keys, a0, a1, a2, b0, b1, b2, root, root2, root3, R1, R2, R3, binding1 } = await twoContacts();
    scene.add("relationship.contactAssigned", { relationshipId: R2, contactId: CONTACT });
    scene.events.splice(scene.events.findIndex((event) => event.type === "relationship.contactAssigned" && (event.data as { contactId: ContactId }).contactId === CONTACT2), 1);
    scene.add("did.disclosed", { didId: a0.didId, as: "oob", uses: "one", oobId: "oob-a0", goal: null });
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 1, overrides: { pthid: "oob-a0" } });
    scene.add("did.disclosed", { didId: a1.didId, as: "oob", uses: "one", oobId: "oob-a1", goal: null });
    const checks = await checkVault(VaultEventSet.of(scene.events), keys, noObjects);
    let deletion = deletionOf(foldVault(VaultEventSet.of(scene.events), checks), CONTACT);
    expect(deletion.retiredDids).toEqual([a0.didId, a2.didId].sort());
    expect(deletion.retiredRoutes).toEqual([]);
    expect(deletion.drafts.map((draft) => draft.type)).toEqual(["contact.deleted", "message.erased", "did.retired", "did.retired"]);

    scene.add("did.retired", { didId: a1.didId, because: "user" });
    deletion = deletionOf(foldVault(VaultEventSet.of(scene.events), await checkVault(VaultEventSet.of(scene.events), keys, noObjects)), CONTACT);
    expect(deletion.retiredRoutes).toEqual([ROUTE]);
    expect([R1, R2, R3, b1, b2, root2, root3, DID_ID, DID_ID2, DID_ID3].length).toBe(10);
  });
});

describe("unfinished work", () => {
  type Checked = { events: Event[]; checks: VaultChecks };
  const workOf = (c: Checked, options: WorkOptions = {}) => unfinishedWork(foldVault(VaultEventSet.of(c.events), c.checks), options);
  const checked = async (events: Event[], keys: Keys): Promise<Checked> => ({ events, checks: await checkVault(VaultEventSet.of(events), keys, noObjects) });
  const expectWorkOrderFree = (c: Checked, options: WorkOptions, check: (work: UnfinishedWork) => void) => {
    check(workOf(c, options));
    expectOrderFree(c.events, (set) => unfinishedWork(foldVault(set, c.checks), options));
  };

  it("lists the births awaiting a binding, the outbounds with work, the relationships with application input and no contact, the transitions and claims still waiting", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const birthR = relationshipId(a1.did, b1.did);
    const birth = intent(scene, birthR, { birth: { localDidId: a1.didId, peerDid: b1.did } });
    const out = intent(scene, R);
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const rotation = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 2);
    const c = await checked(scene.events, keys);
    expectWorkOrderFree({ events: c.events, checks: { ...c.checks, proofChecks: new Map() } }, {}, (work) => {
      expect(work.births).toEqual([{ messageId: birth.data.messageId, relationshipId: birthR, birth: birth.data.birth }]);
      expect(work.outbound).toEqual(
        [
          { messageId: birth.data.messageId, relationshipId: birthR, work: { kind: "prepare" } },
          { messageId: out.data.messageId, relationshipId: R, work: { kind: "prepare" } },
        ].sort((a, b) => (a.messageId < b.messageId ? -1 : 1))
      );
      expect(work.unassigned).toEqual([{ relationshipId: R, contactId: contactIdOf(R), tombstoned: false }]);
      expect(work.transitions).toEqual([{ eventId: rotation.edge.eventId, because: expect.stringContaining("proof") }]);
      expect(work.pendingClaims.map((claim) => claim.eventIds)).toEqual([[rotation.carrier.eventId], [rotation.edge.eventId]]);
      expect(work.responses).toEqual([]);
      expect(work.rotations).toEqual([]);
    });
    scene.add("contact.deleted", { contactId: contactIdOf(R) });
    const proven = await checked(scene.events, keys);
    const work = workOf(proven);
    expect(work.unassigned).toEqual([{ relationshipId: R, contactId: contactIdOf(R), tombstoned: true }]);
    expect(work.transitions).toEqual([]);
    expect(work.pendingClaims).toEqual([]);
  });

  it("lists the replies owed — acknowledgments requested, a natural response — with the sender gate's verdict, and the application inputs the early-privacy policy may take as a trigger", async () => {
    const { scene, keys, R, a0, a1, b0, root, binding } = await bornAtRoot();
    scene.add("relationship.contactAssigned", { relationshipId: R, contactId: CONTACT });
    scene.add("did.disclosed", { didId: a0.didId, as: "oob", uses: "many", oobId: "oob-many", goal: null });
    const asked = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { pleaseAck: [""] } });
    const ping = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2, overrides: { msgType: PING } });
    const plain = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 3 });
    const answered = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 4, overrides: { pleaseAck: [""] } });
    const answeredId = executionId(R, answered.data.wireMessageId);
    automatic(scene, R, { executionId: answeredId }, { ack: [answered.data.wireMessageId] });
    const askedId = executionId(R, asked.data.wireMessageId);
    const pingId = executionId(R, ping.data.wireMessageId);
    const plainId = executionId(R, plain.data.wireMessageId);
    const c = await checked(scene.events, keys);
    expectWorkOrderFree(c, {}, (work) => {
      expect(work.responses).toEqual(
        [
          { executionId: askedId, relationshipId: R, wireMessageId: asked.data.wireMessageId, kind: "ack", ackTargets: [asked.data.wireMessageId], blocked: null },
          { executionId: pingId, relationshipId: R, wireMessageId: ping.data.wireMessageId, kind: "natural", ackTargets: [], blocked: null },
        ].sort((a, b) => (a.executionId < b.executionId ? -1 : 1))
      );
      expect(work.rotations).toEqual([askedId, pingId, plainId].sort().map((id) => ({ relationshipId: R, executionId: id })));
      expect(work.unassigned).toEqual([]);
    });
    expect(senderGate(foldVault(VaultEventSet.of(scene.events), c.checks), R)).toBeNull();

    const base = scene.events.length;
    scene.add("contact.deleted", { contactId: CONTACT });
    let work = workOf(await checked(scene.events, keys));
    expect(work.responses.map((response) => response.blocked)).toEqual([`the contact ${CONTACT} is deleted`, `the contact ${CONTACT} is deleted`]);

    scene.events.length = base;
    scene.add("did.retired", { didId: a0.didId, because: "user" });
    work = workOf(await checked(scene.events, keys));
    expect(work.responses.map((response) => response.blocked)).toEqual([`the local end ${a0.didId} is not live`, `the local end ${a0.didId} is not live`]);

    scene.events.length = base;
    const edge = localEdge(scene, R, a0.didId, a1.didId, await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT));
    const unproven = await checked(scene.events, keys);
    work = workOf({ events: unproven.events, checks: { ...unproven.checks, proofChecks: new Map() } });
    expect(work.rotations).toEqual([]);
    expect(work.transitions).toEqual([{ eventId: edge.eventId, because: expect.stringContaining("proof") }]);
    expect(work.responses.map((response) => response.blocked)).toEqual([expect.stringMatching(/^awaits the local transition/), expect.stringMatching(/^awaits the local transition/)]);
    expect(work.outbound).toEqual([]);
  });

  it("lists the profile disclosures without a lift: readable inbound ones and submitted outbound ones, none once lifted, erased or the contact deleted", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    scene.add("relationship.contactAssigned", { relationshipId: R, contactId: CONTACT });
    const profile = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { msgType: PROFILE } });
    const profileId = executionId(R, profile.data.wireMessageId);
    const ours = intent(scene, R, { msgType: PROFILE });
    const pkg = packageOf(scene, ours, { sender: a0.didId, recipient: b0, resolution: root });
    const queued = intent(scene, R, { msgType: PROFILE });
    const options = { profileTypes: new Set([PROFILE]) };
    let work = workOf(await checked(scene.events, keys), options);
    expect(work.lifts).toEqual({ inbound: [{ executionId: profileId, relationshipId: R }], outbound: [] });

    scene.add("delivery.submitted", { messageId: ours.data.messageId, packageId: pkg.data.packageId });
    const c = await checked(scene.events, keys);
    expectWorkOrderFree(c, options, (w) => expect(w.lifts).toEqual({ inbound: [{ executionId: profileId, relationshipId: R }], outbound: [{ messageId: ours.data.messageId, relationshipId: R }] }));
    expect(workOf(c).lifts).toEqual({ inbound: [], outbound: [] });

    const base = scene.events.length;
    scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(profile), name: "Bob" });
    scene.add("profile.shared", { relationshipId: R, sourceEventId: ref(ours) });
    work = workOf(await checked(scene.events, keys), options);
    expect(work.lifts).toEqual({ inbound: [], outbound: [] });

    scene.events.length = base;
    scene.add("message.erased", { messageId: profile.data.messageId, dropCids: [profile.data.bodyCid], because: "user" });
    scene.add("message.erased", { messageId: ours.data.messageId, dropCids: [ours.data.bodyCid], because: "user" });
    work = workOf(await checked(scene.events, keys), options);
    expect(work.lifts).toEqual({ inbound: [], outbound: [] });

    scene.events.length = base;
    scene.add("contact.deleted", { contactId: CONTACT });
    work = workOf(await checked(scene.events, keys), options);
    expect(work.lifts).toEqual({ inbound: [], outbound: [] });
    expect(work.deletions).toEqual([CONTACT]);
    expect([queued, automaticMessageId, effectKey].length).toBe(3);
  });
});
