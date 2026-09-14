import type { Event } from "@estoc/event-store/v3";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import { foldErasures, foldOutbound, foldRelationships, heldRoots, rawCidOfBytes, readState, retainEnvelope, verifyResolutions, VaultEventSet, type Cid, type EventId, type Keys, type MessageId, type PackageId } from "../../../src/v3/index.js";
import { AUTHOR, checksOf, expectOrderFree, foldChecked, type KeyChecks } from "./helpers.js";
import { bound, intent, noObjects, packageOf, receipt, resolved, vaults } from "./scene.js";

type Verdicts = { keyChecks: KeyChecks; resolutionChecks: Awaited<ReturnType<typeof verifyResolutions>> };

async function verdicts(events: readonly Event[], keys: Keys): Promise<Verdicts> {
  return { keyChecks: await checksOf(events, keys), resolutionChecks: await verifyResolutions(VaultEventSet.of(events), noObjects) };
}

function heldWith(set: VaultEventSet, v: Verdicts) {
  const routes = foldChecked(set, v.keyChecks).routes;
  const relationships = foldRelationships(set, routes, { resolutionChecks: v.resolutionChecks });
  const outbound = foldOutbound(set, routes, relationships, { resolutionChecks: v.resolutionChecks });
  return { outbound, erasures: foldErasures(set), held: heldRoots(set, outbound) };
}

async function held(events: readonly Event[], keys: Keys): Promise<Set<Cid>> {
  return heldWith(VaultEventSet.of(events), await verdicts(events, keys)).held;
}

async function bornAtRoot() {
  const v = await vaults();
  const { scene, a0, b0 } = v;
  const root = resolved(scene, a0.didId, b0);
  const { R, bound: binding } = bound(scene, a0, b0, root);
  return { ...v, R, binding, root };
}

describe("held roots", () => {
  it("hold every root an event retains, release what an erasure names from that message only, and keep bytes another message shares", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    const body = rawCidOfBytes(new Uint8Array([1, 2, 3]));
    const attachment = rawCidOfBytes(new Uint8Array([4]));
    const first = intent(scene, R, { bodyCid: body, attachmentCids: [attachment] });
    const second = intent(scene, R, { bodyCid: body });
    const inbound = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { bodyCid: attachment } });
    const document = root.data.documentCid;
    let roots = await held(scene.events, keys);
    expect(roots).toEqual(new Set([document, body, attachment]));

    scene.add("message.erased", { messageId: first.data.messageId, dropCids: [body, attachment, document], because: "user" });
    roots = await held(scene.events, keys);
    expect(roots).toEqual(new Set([document, body, attachment]));
    scene.add("message.erased", { messageId: second.data.messageId, dropCids: [body], because: "contact-deleted" });
    const v = await verdicts(scene.events, keys);
    const { erasures } = heldWith(VaultEventSet.of(scene.events), v);
    expect(heldWith(VaultEventSet.of(scene.events), v).held).toEqual(new Set([document, attachment]));
    expect(readState(erasures, first.data.messageId, body, true)).toBe("erased");
    expect(readState(erasures, inbound.data.messageId, attachment, true)).toBe("available");
    expect(readState(erasures, inbound.data.messageId, attachment, false)).toBe("missing");
    expect(readState(erasures, inbound.data.messageId, attachment, false, true)).toBe("not-yet-fetched");

    scene.add("message.erased", { messageId: inbound.data.messageId, dropCids: [attachment], because: "user" });
    await expectOrderFree(scene.events, (set) => heldWith(set, v).held);
    expect(await held(scene.events, keys)).toEqual(new Set([document]));
  });

  it("hold the roots of an event of an unknown type and of one whose payload does not read, whatever erasures say", async () => {
    const { scene, keys, R, root } = await bornAtRoot();
    const foreign = rawCidOfBytes(new Uint8Array([9]));
    const broken = rawCidOfBytes(new Uint8Array([10]));
    scene.events.push({ eventId: uuidv7() as EventId, at: "2026-09-13T00:00:00.000Z", author: AUTHOR, type: "message.future", roots: [foreign], data: {} });
    const messageId = uuidv7() as MessageId;
    scene.events.push({ eventId: uuidv7() as EventId, at: "2026-09-13T00:00:01.000Z", author: AUTHOR, type: "message.out", roots: [broken], data: { messageId } });
    scene.add("message.erased", { messageId, dropCids: [broken, foreign], because: "user" });
    expect(await held(scene.events, keys)).toEqual(new Set([root.data.documentCid, foreign, broken]));
    expect(R).toBeDefined();
  });

  it("releases an envelope only by a submission of a verified message: a package outside the history, one awaiting its resolution, or an intent in conflict keeps it held", async () => {
    const { scene, keys, R, a0, a2, b0, root } = await bornAtRoot();
    const outside = intent(scene, R);
    const fromOutside = packageOf(scene, outside, { sender: a2.didId, recipient: b0, resolution: resolved(scene, a2.didId, b0) });
    scene.add("delivery.submitted", { messageId: outside.data.messageId, packageId: fromOutside.data.packageId });
    const waiting = intent(scene, R);
    const forWaiting = resolved(scene, a0.didId, b0);
    const awaitingResolution = packageOf(scene, waiting, { sender: a0.didId, recipient: b0, resolution: forWaiting });
    scene.add("delivery.submitted", { messageId: waiting.data.messageId, packageId: awaitingResolution.data.packageId });
    const disputed = intent(scene, R);
    const ofDisputed = packageOf(scene, disputed, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("delivery.submitted", { messageId: disputed.data.messageId, packageId: ofDisputed.data.packageId });
    intent(scene, R, { messageId: disputed.data.messageId, bodyCid: rawCidOfBytes(new Uint8Array([3])) });
    const events = scene.events.filter((event) => event !== forWaiting);
    const v = await verdicts(events, keys);
    const check = (folds: ReturnType<typeof heldWith>) => {
      const cases = [
        [outside, fromOutside, "conflict", "conflict"],
        [waiting, awaitingResolution, "deferred", "prepared"],
        [disputed, ofDisputed, "conflict", "conflict"],
      ] as const;
      for (const [out, pkg, membership, outcome] of cases) {
        const message = folds.outbound.outbounds.get(out.data.messageId)!;
        expect(message.packages.get(pkg.data.packageId)!.submitted).toBe(true);
        expect(message).toMatchObject({ submitted: false, outcome, membership: { status: membership }, work: { kind: "none" } });
        expect(folds.held.has(pkg.data.envelopeCid)).toBe(true);
      }
    };
    check(heldWith(VaultEventSet.of(events), v));
    await expectOrderFree(events, (set) => {
      const folds = heldWith(set, v);
      check(folds);
      return folds.held;
    });

    const completed = await verdicts(scene.events, keys);
    const folds = heldWith(VaultEventSet.of(scene.events), completed);
    expect(folds.outbound.outbounds.get(waiting.data.messageId)).toMatchObject({ submitted: true, outcome: "submitted" });
    expect(folds.held.has(awaitingResolution.data.envelopeCid)).toBe(false);
    expect(folds.held.has(fromOutside.data.envelopeCid)).toBe(true);
    expect(folds.held.has(ofDisputed.data.envelopeCid)).toBe(true);
  });

  it("retain a prepared envelope until submission, retirement, terminal failure or erasure; an acknowledgment releases nothing", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    const out = intent(scene, R);
    const first = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const second = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const envelopes = [first.data.envelopeCid, second.data.envelopeCid];
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { ack: [out.data.messageId] } });
    const base = scene.events.length;
    const v = await verdicts(scene.events, keys);
    let folds = heldWith(VaultEventSet.of(scene.events), v);
    const message = folds.outbound.outbounds.get(out.data.messageId)!;
    expect(message.acknowledged).toBe(true);
    expect(retainEnvelope(message, message.packages.get(first.data.packageId)!, folds.erasures)).toBe(true);
    expect([...folds.held].filter((cid) => envelopes.includes(cid))).toEqual(envelopes);

    scene.add("message.packageRetired", { messageId: out.data.messageId, packageId: first.data.packageId, because: "repacked", replacementPackageId: second.data.packageId });
    folds = heldWith(VaultEventSet.of(scene.events), v);
    expect(folds.held.has(first.data.envelopeCid)).toBe(false);
    expect(folds.held.has(second.data.envelopeCid)).toBe(true);
    expect(folds.outbound.outbounds.get(out.data.messageId)!.submitted).toBe(false);

    scene.events.length = base;
    scene.add("delivery.failed", { messageId: out.data.messageId, scope: "package", packageId: second.data.packageId, code: "rejected" });
    folds = heldWith(VaultEventSet.of(scene.events), v);
    expect(folds.held.has(first.data.envelopeCid)).toBe(true);
    expect(folds.held.has(second.data.envelopeCid)).toBe(false);

    scene.events.length = base;
    scene.add("delivery.failed", { messageId: out.data.messageId, scope: "message", packageId: null, code: "expired" });
    folds = heldWith(VaultEventSet.of(scene.events), v);
    expect([...folds.held].filter((cid) => envelopes.includes(cid))).toEqual([]);
    expect(folds.held.has(out.data.bodyCid)).toBe(true);

    scene.events.length = base;
    scene.add("message.erased", { messageId: out.data.messageId, dropCids: [first.data.envelopeCid], because: "user" });
    folds = heldWith(VaultEventSet.of(scene.events), v);
    expect(folds.held.has(first.data.envelopeCid)).toBe(false);
    expect(folds.held.has(second.data.envelopeCid)).toBe(true);

    scene.events.length = base;
    scene.add("delivery.submitted", { messageId: out.data.messageId, packageId: first.data.packageId });
    scene.add("message.packageRetired", { messageId: out.data.messageId, packageId: first.data.packageId, because: "done", replacementPackageId: null });
    await expectOrderFree(scene.events, (set) => heldWith(set, v).held);
    folds = heldWith(VaultEventSet.of(scene.events), v);
    expect([...folds.held].filter((cid) => envelopes.includes(cid))).toEqual([]);
    expect(folds.held.has(out.data.bodyCid)).toBe(true);
    expect(folds.outbound.outbounds.get(out.data.messageId)!.submitted).toBe(true);
  });

  it("hold a disputed package's envelopes and an orphan's, submitted or not, until erased", async () => {
    const { scene, keys, R, a0, b0, root } = await bornAtRoot();
    const out = intent(scene, R);
    const disputed = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const otherEnvelope = rawCidOfBytes(new Uint8Array([7]));
    scene.add("message.prepared", { ...disputed.data, envelopeCid: otherEnvelope });
    scene.add("delivery.submitted", { messageId: out.data.messageId, packageId: disputed.data.packageId });
    const orphanId = uuidv7() as MessageId;
    const orphan = scene.add("message.prepared", { ...disputed.data, messageId: orphanId, packageId: uuidv7() as PackageId, envelopeCid: rawCidOfBytes(new Uint8Array([8])) });
    scene.add("delivery.submitted", { messageId: orphanId, packageId: orphan.data.packageId });
    let roots = await held(scene.events, keys);
    expect(roots.has(disputed.data.envelopeCid)).toBe(true);
    expect(roots.has(otherEnvelope)).toBe(true);
    expect(roots.has(orphan.data.envelopeCid)).toBe(true);

    scene.add("message.erased", { messageId: orphanId, dropCids: [orphan.data.envelopeCid], because: "user" });
    scene.add("message.erased", { messageId: out.data.messageId, dropCids: [otherEnvelope], because: "user" });
    roots = await held(scene.events, keys);
    expect(roots.has(disputed.data.envelopeCid)).toBe(true);
    expect(roots.has(otherEnvelope)).toBe(false);
    expect(roots.has(orphan.data.envelopeCid)).toBe(false);
  });
});
