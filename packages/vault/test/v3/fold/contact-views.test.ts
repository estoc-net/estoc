import type { Event } from "@estoc/event-store/v3";
import { describe, expect, it } from "vitest";

import {
  EMPTY_DOCUMENT_CID,
  executionId,
  foldContactViews,
  foldDiagnostics,
  foldErasures,
  foldInbound,
  foldOutbound,
  foldProfiles,
  foldRelationships,
  inboundMessageId,
  keyOf,
  PROBLEM_REPORT,
  readProblemReports,
  storeMessage,
  verifyResolutions,
  verifyTransitions,
  VaultEventSet,
  type Cid,
  type ContactId,
  type ContactView,
  type ContactViewOptions,
  type EventId,
  type Keys,
  type ProblemReport,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { checksOf, cidOf, expectOrderFree, foldChecked, type KeyChecks } from "./helpers.js";
import { CONTACT, CONTACT2, bound, intent, noObjects, packageOf, peerRotation, receipt, ref, resolved, vaults } from "./scene.js";

type Verdicts = { keyChecks: KeyChecks; resolutionChecks: Awaited<ReturnType<typeof verifyResolutions>>; proofChecks: Awaited<ReturnType<typeof verifyTransitions>> };

const EMPTY = "https://didcomm.org/empty/1.0/empty";

async function verdicts(events: readonly Event[], keys: Keys): Promise<Verdicts> {
  const set = VaultEventSet.of(events);
  const keyChecks = await checksOf(events, keys);
  const routes = foldChecked(set, keyChecks).routes;
  return { keyChecks, resolutionChecks: await verifyResolutions(set, noObjects), proofChecks: await verifyTransitions(set, routes, noObjects) };
}

function viewsWith(set: VaultEventSet, v: Verdicts, options: ContactViewOptions = {}): ReadonlyMap<ContactId, ContactView> {
  const routes = foldChecked(set, v.keyChecks).routes;
  const relationships = foldRelationships(set, routes, { proofChecks: v.proofChecks, resolutionChecks: v.resolutionChecks });
  const inbound = foldInbound(set, relationships);
  const outbound = foldOutbound(set, routes, relationships, inbound, { resolutionChecks: v.resolutionChecks });
  return foldContactViews(set, { routes, relationships, inbound, profiles: foldProfiles(set, relationships, outbound) }, options);
}

async function expectViewsOrderFree(events: readonly Event[], keys: Keys, check: (views: ReadonlyMap<ContactId, ContactView>) => void, options: ContactViewOptions = {}): Promise<void> {
  const v = await verdicts(events, keys);
  check(viewsWith(VaultEventSet.of(events), v, options));
  expectOrderFree(events, (set) => viewsWith(set, v, options));
}

async function threeRelationships() {
  const v = await vaults();
  const { scene, a0, a1, a2, b0, b1, b2 } = v;
  const root = resolved(scene, a0.didId, b0);
  const one = bound(scene, a0, b0, root);
  const root2 = resolved(scene, a1.didId, b1);
  const two = bound(scene, a1, b1, root2);
  const root3 = resolved(scene, a2.didId, b2);
  const three = bound(scene, a2, b2, root3);
  scene.add("relationship.contactAssigned", { relationshipId: one.R, contactId: CONTACT });
  scene.add("relationship.contactAssigned", { relationshipId: two.R, contactId: CONTACT });
  scene.add("relationship.contactAssigned", { relationshipId: two.R, contactId: CONTACT2 });
  return { ...v, root, root2, root3, R1: one.R, R2: two.R, R3: three.R, binding1: one.bound, binding2: two.bound, binding3: three.bound };
}

describe("the contact view", () => {
  it("holds what its uniquely assigned relationships hold and nothing of a contested or unassigned one: the latest name, our shared profile, the addresses, where to write, the thread of complete application messages by earliest observation", async () => {
    const { scene, keys, R1, R2, R3, a0, a1, a2, b0, b1, b2, root, root2, root3, binding1, binding2, binding3 } = await threeRelationships();
    scene.add("contact.created", { contactId: CONTACT, because: "user" });
    scene.add("contact.useDid", { contactId: CONTACT, didId: a0.didId, because: "manual" });
    const later = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 1 }, { at: "2026-09-14T12:00:05.000Z" });
    const earlier = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 2 }, { at: "2026-09-14T12:00:01.000Z" });
    const duplicate = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 3, wire: later.data.wireMessageId }, { at: "2026-09-14T12:00:09.000Z" });
    const out = intent(scene, R1);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("delivery.submitted", { messageId: out.data.messageId, packageId: pkg.data.packageId });
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 4, overrides: { msgType: EMPTY, bodyCid: EMPTY_DOCUMENT_CID, ack: [out.data.messageId] } });
    scene.add("profile.shared", { relationshipId: R1, sourceEventId: ref(out) });
    scene.add("profile.nameClaimed", { relationshipId: R1, sourceEventId: ref(later), name: "Bob" });
    const contested = receipt(scene, { local: a1.didId, peer: b1, resolution: root2, binding: binding2, ordinal: 5 }, { at: "2026-09-14T12:00:20.000Z" });
    scene.add("profile.nameClaimed", { relationshipId: R2, sourceEventId: ref(contested), name: "Robert" });
    const unassigned = receipt(scene, { local: a2.didId, peer: b2, resolution: root3, binding: binding3, ordinal: 6 }, { at: "2026-09-14T12:00:30.000Z" });
    scene.add("profile.nameClaimed", { relationshipId: R3, sourceEventId: ref(unassigned), name: "Carol" });
    await expectViewsOrderFree(scene.events, keys, (views) => {
      expect([...views.keys()]).toEqual([CONTACT, CONTACT2].sort());
      const view = views.get(CONTACT)!;
      expect(view).toMatchObject({ contactId: CONTACT, origin: "user", deleted: false, contested: [R2], claimedName: "Bob", nameConflict: false, localDidIds: [a0.didId], currentLocalDidIds: [a0.didId], peerDids: [b0.did], writeTo: [R1], preferred: [R1], diagnostics: [] });
      expect(view.relationships).toEqual([{ relationshipId: R1, standing: "stands", currentLocalDidId: a0.didId, currentPeerDid: b0.did }]);
      expect(view.profileShared).toEqual([{ relationshipId: R1, sourceKey: keyOf(out) }]);
      expect(view.thread.map((entry) => entry.executionId)).toEqual([executionId(R1, earlier.data.wireMessageId), executionId(R1, later.data.wireMessageId)]);
      expect(view.thread[1]).toEqual({ executionId: executionId(R1, later.data.wireMessageId), relationshipId: R1, wireMessageId: later.data.wireMessageId, msgType: later.data.msgType, thid: null, pthid: null, sourceKey: keyOf(later), eventIds: [later.eventId, duplicate.eventId] });
      const other = views.get(CONTACT2)!;
      expect(other).toMatchObject({ contactId: CONTACT2, origin: null, relationships: [], contested: [R2], claimedName: null, profileShared: [], localDidIds: [], peerDids: [], writeTo: [], preferred: [], thread: [], diagnostics: [] });
    });
  });

  it("writes to no relationship of a deleted contact, or whose current local end is not live, or which is in conflict, and lists a retired local address among the current ends only", async () => {
    const { scene, keys, R1, R2, a0, a1, b0, b1, root, root2, binding1, binding2 } = await threeRelationships();
    scene.events.pop();
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 1 });
    receipt(scene, { local: a1.didId, peer: b1, resolution: root2, binding: binding2, ordinal: 2 });
    const base = scene.events.length;
    const contact = async () => viewsWith(VaultEventSet.of(scene.events), await verdicts(scene.events, keys)).get(CONTACT)!;
    expect((await contact()).writeTo).toEqual([R1, R2].sort());
    expect((await contact()).relationships.map((r) => r.standing)).toEqual(["stands", "stands"]);
    scene.add("did.retired", { didId: a0.didId, because: "rotated" });
    let view = await contact();
    expect(view.writeTo).toEqual([R2]);
    expect(view.localDidIds).toEqual([a1.didId]);
    expect(view.currentLocalDidIds).toEqual([a0.didId, a1.didId].sort());
    scene.events.length = base;
    scene.add("relationship.contactAssigned", { relationshipId: R2, contactId: CONTACT2 });
    view = await contact();
    expect(view.writeTo).toEqual([R1]);
    expect(view.contested).toEqual([R2]);
    scene.events.length = base;
    scene.add("contact.deleted", { contactId: CONTACT });
    view = await contact();
    expect(view).toMatchObject({ deleted: true, writeTo: [], preferred: [] });
    expect(view.thread).toHaveLength(2);
    scene.events.length = base;
    scene.add("relationship.bound", { relationshipId: R1, localDidId: a1.didId, peerResolutionEventId: ref(root) });
    view = await contact();
    expect(view.writeTo).toEqual([R2]);
    expect(view.relationships.find((r) => r.relationshipId === R1)).toMatchObject({ standing: "conflict", currentLocalDidId: null });
  });

  it("shows the same-DID key change at the relationship's contact: an authenticated proof-free observation from the current peer DID under a document the chain does not pin, kept out of the thread and never scoped", async () => {
    const { scene, keys, peerKeys, R1, R3, a0, a2, b0, b1, b2, b3, root, binding1, binding3 } = await threeRelationships();
    const changed = (local: typeof a0, peer: typeof b0, ordinal: number, binding: typeof binding1) => {
      const fresh = resolved(scene, local.didId, peer, { short: true, peerPublicKey: b3.publicKey, documentCid: cidOf(`a fresh document of ${peer.did}`) });
      const wire = `wire-${ordinal}` as WireMessageId;
      return { fresh, observation: receipt(scene, { local: local.didId, peer, resolution: fresh, binding, ordinal, wire, overrides: { messageId: inboundMessageId(b3.publicKey, wire) } }) };
    };
    const known = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 1 });
    const { fresh, observation } = changed(a0, b0, 2, binding1);
    const elsewhere = changed(a2, b2, 3, binding3);
    const rotation = await peerRotation(scene, peerKeys, R1, a0.didId, b0, b1, root, binding1, 4);
    const predecessor = changed(a0, b0, 5, binding1);
    await expectViewsOrderFree(scene.events, keys, (views) => {
      const view = views.get(CONTACT)!;
      expect(view.diagnostics).toEqual([]);
      expect(view.thread.map((entry) => entry.eventIds)).toEqual([[known.eventId], [rotation.carrier.eventId]]);
    });
    scene.events.splice(scene.events.indexOf(rotation.successor), 3);
    scene.events.splice(scene.events.indexOf(predecessor.fresh), 2);
    await expectViewsOrderFree(scene.events, keys, (views) => {
      const view = views.get(CONTACT)!;
      expect(view.diagnostics).toEqual([{ kind: "peer-key-changed", relationshipId: R1, eventId: observation.eventId, resolutionEventId: ref(fresh), did: b0.did }]);
      expect(view.thread.map((entry) => entry.eventIds)).toEqual([[known.eventId]]);
      expect(views.get(CONTACT2)!.diagnostics).toEqual([]);
    });
    const v = await verdicts(scene.events, keys);
    const set = VaultEventSet.of(scene.events);
    const routes = foldChecked(set, v.keyChecks).routes;
    const relationships = foldRelationships(set, routes, { proofChecks: v.proofChecks, resolutionChecks: v.resolutionChecks });
    const inbound = foldInbound(set, relationships);
    expect(inbound.observations.get(observation.eventId)!.scope.status).not.toBe("scoped");
    const diagnostics = foldDiagnostics(set, relationships, inbound, { problemReports: new Map(), erasures: foldErasures(set) });
    expect([...diagnostics.keys()]).toEqual([R1, R3].sort());
    expect(diagnostics.get(R3)![0]).toMatchObject({ kind: "peer-key-changed", eventId: elsewhere.observation.eventId, did: b2.did });
  });

  it("shows a remote error's code beside the one outbound its parent thread names, none for an ambiguous thread, an erased or unread body, and orders reports by their earliest observation", async () => {
    const { scene, keys, R1, a0, b0, root, binding1 } = await threeRelationships();
    const answered = intent(scene, R1);
    const threadedOnce = intent(scene, R1, { thid: "T" });
    const threadedTwice = intent(scene, R1, { thid: "T" });
    const report = (ordinal: number, pthid: string, at?: string) => receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal, overrides: { msgType: PROBLEM_REPORT, pthid } }, at === undefined ? {} : { at });
    const later = report(1, answered.data.messageId, "2026-09-14T13:00:09.000Z");
    const earlier = report(2, answered.data.messageId, "2026-09-14T13:00:01.000Z");
    const ambiguous = report(3, "T");
    const erased = report(4, answered.data.messageId);
    scene.add("message.erased", { messageId: erased.data.messageId, dropCids: [erased.data.bodyCid], because: "user" });
    const unread = report(5, answered.data.messageId);
    const problemReports = new Map<EventId, ProblemReport>([
      [later.eventId, { code: "e.p.xfer.later", comment: "late" }],
      [earlier.eventId, { code: "e.p.xfer.earlier", comment: null }],
      [ambiguous.eventId, { code: "e.p.ambiguous", comment: null }],
      [erased.eventId, { code: "e.p.erased", comment: null }],
    ]);
    expect(threadedOnce.data.thid).toBe(threadedTwice.data.thid);
    expect(unread.data.pthid).toBe(answered.data.messageId);
    await expectViewsOrderFree(
      scene.events,
      keys,
      (views) => {
        const view = views.get(CONTACT)!;
        expect(view.diagnostics).toEqual([
          { kind: "remote-error", relationshipId: R1, executionId: executionId(R1, earlier.data.wireMessageId), messageId: answered.data.messageId, code: "e.p.xfer.earlier", comment: null, sourceKey: keyOf(earlier) },
          { kind: "remote-error", relationshipId: R1, executionId: executionId(R1, later.data.wireMessageId), messageId: answered.data.messageId, code: "e.p.xfer.later", comment: "late", sourceKey: keyOf(later) },
        ]);
        expect(view.thread).toEqual([]);
      },
      { problemReports }
    );
  });

  it("reads each problem report's body from its object: a code and, if there, a comment; an object that is not here, does not read or has no code gives none", async () => {
    const { scene, a0, b0, root, binding1 } = await threeRelationships();
    const full = storeMessage({ code: "e.p.xfer", comment: "nope", args: ["x"] }, []);
    const bare = storeMessage({ code: "e.p.msg" }, []);
    const codeless = storeMessage({ comment: "why" }, []);
    const objects = new Map<Cid, Uint8Array>([
      [full.bodyCid, full.bytes],
      [bare.bodyCid, bare.bytes],
      [codeless.bodyCid, codeless.bytes],
      [cidOf("garbage"), new TextEncoder().encode("{")],
    ]);
    const at = (ordinal: number, bodyCid: Cid) => receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal, overrides: { msgType: PROBLEM_REPORT, pthid: "x", bodyCid } });
    const one = at(1, full.bodyCid);
    const two = at(2, bare.bodyCid);
    at(3, codeless.bodyCid);
    at(4, cidOf("garbage"));
    at(5, cidOf("absent"));
    const ordinary = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: binding1, ordinal: 6, overrides: { bodyCid: full.bodyCid } });
    const reports = await readProblemReports(VaultEventSet.of(scene.events), async (cid) => objects.get(cid) ?? null);
    expect([...reports]).toEqual([
      [one.eventId, { code: "e.p.xfer", comment: "nope" }],
      [two.eventId, { code: "e.p.msg", comment: null }],
    ]);
    expect(reports.has(ordinary.eventId)).toBe(false);
  });
});
