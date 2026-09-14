import type { Event } from "@estoc/event-store/v3";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import { foldOutbound, foldProfiles, foldRelationships, inboundMessageId, profileOf, verifyResolutions, verifyTransitions, VaultEventSet, type Keys, type Profile, type RelationshipId, type VaultData, type WireMessageId } from "../../../src/v3/index.js";
import { checksOf, expectOrderFree, foldChecked, type KeyChecks } from "./helpers.js";
import { bound, intent, noObjects, packageOf, peerRotation, receipt, ref, resolved, vaults } from "./scene.js";

type Verdicts = { keyChecks: KeyChecks; resolutionChecks: Awaited<ReturnType<typeof verifyResolutions>>; proofChecks: Awaited<ReturnType<typeof verifyTransitions>> };

async function verdicts(events: readonly Event[], keys: Keys): Promise<Verdicts> {
  const set = VaultEventSet.of(events);
  const keyChecks = await checksOf(events, keys);
  const routes = foldChecked(set, keyChecks).routes;
  return { keyChecks, resolutionChecks: await verifyResolutions(set, noObjects), proofChecks: await verifyTransitions(set, routes, noObjects) };
}

function profilesWith(set: VaultEventSet, v: Verdicts): ReadonlyMap<RelationshipId, Profile> {
  const routes = foldChecked(set, v.keyChecks).routes;
  const relationships = foldRelationships(set, routes, { proofChecks: v.proofChecks, resolutionChecks: v.resolutionChecks });
  return foldProfiles(set, relationships, foldOutbound(set, routes, relationships, { resolutionChecks: v.resolutionChecks }));
}

async function profile(events: readonly Event[], keys: Keys, R: RelationshipId): Promise<Profile> {
  return profileOf(profilesWith(VaultEventSet.of(events), await verdicts(events, keys)), R);
}

async function expectProfilesOrderFree(events: readonly Event[], keys: Keys, check: (profiles: ReadonlyMap<RelationshipId, Profile>) => void): Promise<void> {
  const v = await verdicts(events, keys);
  check(profilesWith(VaultEventSet.of(events), v));
  expectOrderFree(events, (set) => profilesWith(set, v));
}

async function bornAtRoot() {
  const v = await vaults();
  const { scene, a0, b0 } = v;
  const root = resolved(scene, a0.didId, b0);
  const { R, bound: binding } = bound(scene, a0, b0, root);
  return { ...v, R, binding, root };
}

const keyOf = (event: Event) => ({ at: event.at, eventId: event.eventId, author: event.author });

describe("the relationship profile", () => {
  it("is empty without lifts", async () => {
    const { scene, keys, R } = await bornAtRoot();
    expect(await profile(scene.events, keys, R)).toEqual({ relationshipId: R, claimedName: null, nameConflict: false, shared: null, claims: [], shares: [], deferred: [], faults: [] });
  });

  it("claims the name of the latest source by the source's earliest event, whatever the lift order; duplicates and cross-key aliases are one source", async () => {
    const { scene, keys, peerKeys, R, a0, b0, b1, root, binding } = await bornAtRoot();
    const older = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const newer = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2 });
    scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(newer), name: "Bob" });
    scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(older), name: "Robert" });
    const duplicate = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 3, wire: older.data.wireMessageId });
    scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(duplicate), name: "Robert" });
    const rotation = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 4);
    const alias = receipt(scene, { local: a0.didId, peer: b1, resolution: rotation.successor, binding, ordinal: 5, wire: older.data.wireMessageId, transition: ref(rotation.edge) });
    scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(alias), name: "Robert" });
    await expectProfilesOrderFree(scene.events, keys, (profiles) => {
      const p = profileOf(profiles, R);
      expect(p.claimedName).toBe("Bob");
      expect(p.nameConflict).toBe(false);
      expect(p.claims.map((claim) => claim.names)).toEqual([["Robert"], ["Bob"]]);
      expect(p.claims[0]).toMatchObject({ sourceKey: keyOf(older), sourceEventIds: [older.eventId, duplicate.eventId, alias.eventId].sort(), conflict: false });
      expect(p.claims[0]!.liftEventIds).toHaveLength(3);
      expect(p.claims[1]!.sourceKey).toEqual(keyOf(newer));
      expect(p.faults).toEqual([]);
      expect(p.deferred).toEqual([]);
    });
    expect(alias.data.messageId).not.toBe(older.data.messageId);
  });

  it("keeps two names lifted from one source as that source's conflict and names nothing from it, while an older source still names", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    const older = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const newer = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2 });
    scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(older), name: "Robert" });
    scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(newer), name: "Bob" });
    scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(newer), name: "Bobby" });
    scene.add("message.erased", { messageId: newer.data.messageId, dropCids: [newer.data.bodyCid], because: "user" });
    await expectProfilesOrderFree(scene.events, keys, (profiles) => {
      const p = profileOf(profiles, R);
      expect(p.claimedName).toBe("Robert");
      expect(p.nameConflict).toBe(true);
      expect(p.claims[1]).toMatchObject({ names: ["Bob", "Bobby"], conflict: true });
    });
  });

  it("defers a lift whose source is missing or still unscoped, and faults one whose source is anonymous, elsewhere, contradicting or of another type", async () => {
    const { scene, keys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const R2 = bound(scene, a1, b1, resolved(scene, a1.didId, b1)).R;
    const again = resolved(scene, a0.didId, b0);
    const waiting = receipt(scene, { local: a0.didId, peer: b0, resolution: again, binding, ordinal: 1 });
    const wire = uuidv7() as WireMessageId;
    const anonymous = scene.add("message.in", { ...waiting.data, messageId: inboundMessageId({ localKeyName: waiting.data.localKeyName }, wire), wireMessageId: wire, receiptOrdinal: "2" as VaultData["message.in"]["receiptOrdinal"], peerResolutionEventId: null, relationshipBindingEventId: null, presentedDid: null, did: null });
    const elsewhere = receipt(scene, { local: a1.didId, peer: b1, resolution: resolved(scene, a1.didId, b1), binding: ref(scene.events.find((e) => e.type === "relationship.bound" && (e.data as VaultData["relationship.bound"]).relationshipId === R2)! as never), ordinal: 3 });
    const contradicting = receipt(scene, { local: a0.didId, peer: b1, resolution: root, binding, ordinal: 4 });
    const out = intent(scene, R);
    const missing = uuidv7();
    const lifts = [
      scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: missing as never, name: "A" }),
      scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(anonymous), name: "B" }),
      scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(elsewhere), name: "C" }),
      scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(contradicting), name: "D" }),
      scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(out) as never, name: "E" }),
      scene.add("profile.nameClaimed", { relationshipId: R, sourceEventId: ref(waiting), name: "F" }),
    ];
    const p = await profile(
      scene.events.filter((e) => e !== again),
      keys,
      R
    );
    expect(p.claimedName).toBeNull();
    expect(p.deferred).toEqual([`lift ${lifts[0]!.eventId} awaits its source ${missing}`, expect.stringMatching(new RegExp(`^lift ${lifts[5]!.eventId} awaits its source's scope: awaits its resolution`))]);
    expect(p.faults).toEqual([
      `lift ${lifts[1]!.eventId} names an anonymous source`,
      `lift ${lifts[2]!.eventId} names a source scoped in ${R2}`,
      expect.stringMatching(new RegExp(`^lift ${lifts[3]!.eventId} names a source that contradicts: contradicts its resolution`)),
      `lift ${lifts[4]!.eventId} names message.out as its source`,
    ]);
    expect((await profile(scene.events, keys, R)).claimedName).toBe("F");
  });

  it("shares only a submitted, verified source, at the earliest of its intent events, whatever the lift or submission order; repacks, duplicates and erasure change nothing", async () => {
    const { scene, keys, R, a0, a1, b0, b1, root } = await bornAtRoot();
    const older = intent(scene, R, { msgType: "https://didcomm.org/user-profile/1.0/profile" });
    const newer = intent(scene, R, { msgType: "https://didcomm.org/user-profile/1.0/profile" });
    const olderAgain = scene.add("message.out", older.data);
    const newerPackage = packageOf(scene, newer, { sender: a0.didId, recipient: b0, resolution: root });
    const olderPackage = packageOf(scene, older, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("profile.shared", { relationshipId: R, sourceEventId: ref(newer) });
    scene.add("profile.shared", { relationshipId: R, sourceEventId: ref(olderAgain) });
    let p = await profile(scene.events, keys, R);
    expect(p.shared).toBeNull();
    expect(p.deferred).toEqual([expect.stringMatching(/awaits the submission of its source$/), expect.stringMatching(/awaits the submission of its source$/)]);

    scene.add("delivery.submitted", { messageId: newer.data.messageId, packageId: newerPackage.data.packageId });
    p = await profile(scene.events, keys, R);
    expect(p.shared).toEqual(keyOf(newer));
    scene.add("delivery.submitted", { messageId: older.data.messageId, packageId: olderPackage.data.packageId });
    scene.add("profile.shared", { relationshipId: R, sourceEventId: ref(older) });
    scene.add("message.packageRetired", { messageId: older.data.messageId, packageId: olderPackage.data.packageId, because: "done", replacementPackageId: null });
    scene.add("message.erased", { messageId: older.data.messageId, dropCids: [older.data.bodyCid], because: "user" });
    const R2 = bound(scene, a1, b1, resolved(scene, a1.didId, b1)).R;
    const elsewhere = intent(scene, R2);
    const wrong = scene.add("profile.shared", { relationshipId: R, sourceEventId: ref(elsewhere) });
    await expectProfilesOrderFree(scene.events, keys, (profiles) => {
      const profile = profileOf(profiles, R);
      expect(profile.shared).toEqual(keyOf(newer));
      expect(profile.shares.map((share) => share.messageId)).toEqual([older.data.messageId, newer.data.messageId]);
      expect(profile.shares[0]).toMatchObject({ sourceKey: keyOf(older) });
      expect(profile.shares[0]!.liftEventIds).toHaveLength(2);
      expect(profile.faults).toEqual([`lift ${wrong.eventId} names a source of relationship ${R2}`]);
      expect(profile.deferred).toEqual([]);
      expect(profile.claimedName).toBeNull();
    });
  });
});
