import type { Event } from "@estoc/event-store/v3";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import {
  executionId,
  foldOutbound,
  foldRelationships,
  inboundMessageId,
  rawCidOfBytes,
  signFromPrior,
  verifyResolutions,
  verifyTransitions,
  VaultEventSet,
  type Keys,
  type MessageId,
  type OutboundFold,
  type PackageId,
  type RelationshipFold,
  type RouteFold,
  type VaultData,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { checksOf, expectOrderFree, foldChecked, type KeyChecks } from "./helpers.js";
import { IAT, automatic, bound, intent, localEdge, noObjects, packageOf, peerRotation, receipt, ref, resolved, vaults } from "./scene.js";

type Folds = { routes: RouteFold; relationships: RelationshipFold; outbound: OutboundFold };
type Verdicts = { keyChecks: KeyChecks; resolutionChecks: Awaited<ReturnType<typeof verifyResolutions>>; proofChecks: Awaited<ReturnType<typeof verifyTransitions>> };

/** Every verdict the folds take from outside the set — the seed's, the documents' — computed once. */
async function verdicts(events: readonly Event[], keys: Keys): Promise<Verdicts> {
  const set = VaultEventSet.of(events);
  const keyChecks = await checksOf(events, keys);
  const routes = foldChecked(set, keyChecks).routes;
  return { keyChecks, resolutionChecks: await verifyResolutions(set, noObjects), proofChecks: await verifyTransitions(set, routes, noObjects) };
}

function foldWith(set: VaultEventSet, v: Verdicts, resolutionChecks = v.resolutionChecks): Folds {
  const routes = foldChecked(set, v.keyChecks).routes;
  const relationships = foldRelationships(set, routes, { proofChecks: v.proofChecks, resolutionChecks });
  return { routes, relationships, outbound: foldOutbound(set, routes, relationships, { resolutionChecks }) };
}

async function fold(events: readonly Event[], keys: Keys): Promise<Folds> {
  return foldWith(VaultEventSet.of(events), await verdicts(events, keys));
}

async function expectFoldOrderFree(events: readonly Event[], keys: Keys, check: (folds: Folds) => void): Promise<void> {
  const v = await verdicts(events, keys);
  check(foldWith(VaultEventSet.of(events), v));
  expectOrderFree(events, (set) => foldWith(set, v).outbound);
}

async function bornAtRoot() {
  const v = await vaults();
  const { scene, a0, b0 } = v;
  const root = resolved(scene, a0.didId, b0);
  const { R, bound: binding } = bound(scene, a0, b0, root);
  return { ...v, R, binding, root };
}

const outboundOf = (folds: Folds, messageId: MessageId) => folds.outbound.outbounds.get(messageId)!;
const packageIds = (event: { data: { packageId: PackageId } }[]) => event.map((e) => e.data.packageId);

describe("the outbound message", () => {
  it("is queued with one intent, prepared with a package, submitted by one accepted package and closed for good", async () => {
    const { scene, keys, R, a0, b0, root } = await bornAtRoot();
    const out = intent(scene, R);
    let folds = await fold(scene.events, keys);
    expect(outboundOf(folds, out.data.messageId)).toMatchObject({ intent: out.data, outcome: "queued", work: { kind: "prepare" }, membership: { status: "verified" }, submitted: false, acknowledged: false, late: false, faults: [], deferred: [] });

    const first = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const second = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    folds = await fold(scene.events, keys);
    let m = outboundOf(folds, out.data.messageId);
    expect(m.outcome).toBe("prepared");
    expect(m.work).toEqual({ kind: "submit", packageIds: packageIds([first, second]) });
    expect(m.packages.get(first.data.packageId)).toMatchObject({ data: first.data, eventIds: [first.eventId], retired: null, failed: null, submitted: false, active: true, membership: { status: "verified" } });

    scene.add("delivery.submitted", { messageId: out.data.messageId, packageId: first.data.packageId });
    scene.add("message.packageRetired", { messageId: out.data.messageId, packageId: first.data.packageId, because: "repacked", replacementPackageId: null });
    scene.add("delivery.failed", { messageId: out.data.messageId, scope: "package", packageId: second.data.packageId, code: "rejected" });
    scene.add("message.erased", { messageId: out.data.messageId, dropCids: [out.data.bodyCid, first.data.envelopeCid], because: "user" });
    await expectFoldOrderFree(scene.events, keys, (f) => {
      const message = outboundOf(f, out.data.messageId);
      expect(message.submitted).toBe(true);
      expect(message.outcome).toBe("submitted");
      expect(message.work).toEqual({ kind: "none", because: "submitted" });
      expect(message.packages.get(first.data.packageId)).toMatchObject({ submitted: true, retired: "repacked", active: false });
      expect(message.packages.get(second.data.packageId)).toMatchObject({ submitted: false, failed: "rejected", active: false });
      expect(message.faults).toEqual([]);
    });
  });

  it("ends unsubmitted work on a message-scoped failure; a package-scoped failure ends only that package", async () => {
    const { scene, keys, R, a0, b0, root } = await bornAtRoot();
    const out = intent(scene, R, { createdTime: 1_800_000_000, expiresTime: 1_800_000_600 });
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const base = scene.events.length;
    scene.add("delivery.failed", { messageId: out.data.messageId, scope: "package", packageId: pkg.data.packageId, code: "rejected" });
    let m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m).toMatchObject({ outcome: "prepared", failed: null, work: { kind: "prepare" } });
    expect(m.packages.get(pkg.data.packageId)!.active).toBe(false);

    scene.events.length = base;
    scene.add("delivery.failed", { messageId: out.data.messageId, scope: "message", packageId: null, code: "expired" });
    m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m).toMatchObject({ outcome: "failed", failed: "expired", work: { kind: "none", because: "terminal failure: expired" } });
    expect(m.packages.get(pkg.data.packageId)!.active).toBe(true);
  });

  it("is one logical message under equal intents and a conflict under different ones, keeping every package and working nothing", async () => {
    const { scene, keys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const carrier = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const exec = executionId(R, carrier.data.wireMessageId);
    const response = automatic(scene, R, { executionId: exec }, { ack: [carrier.data.wireMessageId] });
    scene.add("message.out", response.data);
    const pkg = packageOf(scene, response, { sender: a0.didId, recipient: b0, resolution: root });
    let m = outboundOf(await fold(scene.events, keys), response.data.messageId);
    expect(m.intentEventIds).toHaveLength(2);
    expect(m).toMatchObject({ intent: response.data, outcome: "prepared", conflict: false, work: { kind: "submit", packageIds: [pkg.data.packageId] } });
    expect(await fold(scene.events, keys).then((f) => f.outbound.responses.get(exec))).toEqual([response.data.messageId]);

    const R2 = bound(scene, a1, b1, resolved(scene, a1.didId, b1)).R;
    automatic(scene, R2, { executionId: exec }, { ack: [carrier.data.wireMessageId] });
    await expectFoldOrderFree(scene.events, keys, (f) => {
      const message = outboundOf(f, response.data.messageId);
      expect(message.intent).toBeNull();
      expect(message.faults).toEqual(["2 intents disagree under one message ID"]);
      expect(message.outcome).toBe("conflict");
      expect(message.work).toEqual({ kind: "none", because: "the intent events disagree" });
      expect(message.packages.has(pkg.data.packageId)).toBe(true);
      expect(message.intentEventIds).toHaveLength(3);
    });
  });

  it("selects one ACK-bearing response per execution: a second message ID conflicts both, an effect without ack consumes nothing", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    const carrier = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const exec = executionId(R, carrier.data.wireMessageId);
    const ack = automatic(scene, R, { executionId: exec }, { ack: [carrier.data.wireMessageId] });
    const silent = automatic(scene, R, { executionId: exec, effectKind: "notify" });
    let folds = await fold(scene.events, keys);
    expect(outboundOf(folds, ack.data.messageId).conflict).toBe(false);
    expect(outboundOf(folds, silent.data.messageId).conflict).toBe(false);
    expect(folds.outbound.responses.get(exec)).toEqual([ack.data.messageId]);

    const other = automatic(scene, R, { executionId: exec, handlerId: "https://didcomm.org/trust-ping/2.0", effectKind: "ping-response" }, { ack: [carrier.data.wireMessageId] });
    scene.add("delivery.submitted", { messageId: ack.data.messageId, packageId: packageOf(scene, ack, { sender: a0.didId, recipient: b0, resolution: root }).data.packageId });
    await expectFoldOrderFree(scene.events, keys, (f) => {
      const ids = [ack.data.messageId, other.data.messageId].sort();
      expect(f.outbound.responses.get(exec)).toEqual(ids);
      for (const id of ids) {
        expect(outboundOf(f, id).outcome).toBe("conflict");
        expect(outboundOf(f, id).faults).toEqual([`execution ${exec} selected another ACK-bearing response: ${ids.find((x) => x !== id)}`]);
      }
      expect(outboundOf(f, silent.data.messageId).conflict).toBe(false);
    });
  });

  it("checks an automatic intent's carrier: complete in its relationship; not here or waiting defers; anonymous, scoped elsewhere or conflicted contradicts", async () => {
    const { scene, keys, R, a0, a1, b0, b1, binding } = await bornAtRoot();
    const R2 = bound(scene, a1, b1, resolved(scene, a1.didId, b1)).R;
    const again = resolved(scene, a0.didId, b0);
    const carrier = receipt(scene, { local: a0.didId, peer: b0, resolution: again, binding, ordinal: 1 });
    const exec = executionId(R, carrier.data.wireMessageId);
    const response = automatic(scene, R, { executionId: exec });
    let m = outboundOf(await fold(scene.events, keys), response.data.messageId);
    expect(m).toMatchObject({ membership: { status: "verified" }, deferred: [], faults: [] });

    m = outboundOf(await fold(scene.events.filter((e) => e !== carrier), keys), response.data.messageId);
    expect(m.deferred).toEqual([`the carrier of execution ${exec} is not here`]);
    expect(m.work.kind).toBe("none");
    m = outboundOf(await fold(scene.events.filter((e) => e !== again), keys), response.data.messageId);
    expect(m.deferred).toEqual([`the carrier of execution ${exec} awaits its evidence`]);

    const elsewhere = automatic(scene, R2, { executionId: exec, ordinal: 1 });
    m = outboundOf(await fold(scene.events, keys), elsewhere.data.messageId);
    expect(m.faults).toEqual([`the carrier of execution ${exec} is scoped in ${R}, not ${R2}`]);

    const wire = uuidv7() as WireMessageId;
    scene.add("message.in", { ...carrier.data, messageId: inboundMessageId({ localKeyName: carrier.data.localKeyName }, wire), wireMessageId: wire, receiptOrdinal: "2" as VaultData["message.in"]["receiptOrdinal"], peerResolutionEventId: null, relationshipBindingEventId: null, presentedDid: null, did: null });
    const anonymousExec = executionId(R, wire);
    const ofAnonymous = automatic(scene, R, { executionId: anonymousExec });
    m = outboundOf(await fold(scene.events, keys), ofAnonymous.data.messageId);
    expect(m.faults).toEqual([`the carrier of execution ${anonymousExec} is anonymous`]);

    receipt(scene, { local: a0.didId, peer: b0, resolution: again, binding, ordinal: 3, wire: carrier.data.wireMessageId, overrides: { intentHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as VaultData["message.in"]["intentHash"] } });
    await expectFoldOrderFree(scene.events, keys, (f) => {
      expect(outboundOf(f, response.data.messageId).faults).toEqual([expect.stringMatching(new RegExp(`^the carrier of execution ${exec} is in conflict: .*disagree on the intent`))]);
    });
  });

  it("is acknowledged by a complete scoped observation whose ack names it; the earliest witness is the receipt, late at or after expiry, a duplicate never later", async () => {
    const { scene, keys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const expiresTime = Math.floor(Date.UTC(2026, 8, 13, 0, 1) / 1000);
    const out = intent(scene, R, { createdTime: expiresTime - 60, expiresTime });
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const R2 = bound(scene, a1, b1, resolved(scene, a1.didId, b1)).R;
    const threaded = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { thid: out.data.messageId } });
    const elsewhere = receipt(scene, { local: a1.didId, peer: b1, resolution: resolved(scene, a1.didId, b1), binding: ref(scene.events.find((e) => e.type === "relationship.bound" && (e.data as VaultData["relationship.bound"]).relationshipId === R2)! as never), ordinal: 2, overrides: { ack: [out.data.messageId] } });
    const base = scene.events.length;
    let m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m).toMatchObject({ acknowledged: false, ackWitnesses: [], receiptInstant: null, late: false });
    expect(threaded.data.thid).toBe(out.data.messageId);
    expect(elsewhere.data.ack).toEqual([out.data.messageId]);

    const onTime = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 3, overrides: { ack: [out.data.messageId] } }, { at: new Date(expiresTime * 1000 - 1).toISOString() });
    const duplicate = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 4, wire: onTime.data.wireMessageId, overrides: { ack: [out.data.messageId] } }, { at: new Date(expiresTime * 1000 + 5000).toISOString() });
    await expectFoldOrderFree(scene.events, keys, (f) => {
      const message = outboundOf(f, out.data.messageId);
      expect(message.acknowledged).toBe(true);
      expect(message.ackWitnesses).toEqual([onTime.eventId, duplicate.eventId]);
      expect(message.receiptInstant).toBe(onTime.at);
      expect(message.late).toBe(false);
      expect(message.submitted).toBe(false);
      expect(message.outcome).toBe("prepared");
      expect(message.work).toEqual({ kind: "submit", packageIds: [pkg.data.packageId] });
    });

    scene.events.length = base;
    const atExpiry = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 3, overrides: { ack: [out.data.messageId] } }, { at: new Date(expiresTime * 1000).toISOString() });
    scene.add("delivery.failed", { messageId: out.data.messageId, scope: "message", packageId: null, code: "expired" });
    m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m).toMatchObject({ acknowledged: true, receiptInstant: atExpiry.at, late: true, outcome: "failed" });

    scene.events.length = base;
    scene.add("delivery.acknowledged", { messageId: out.data.messageId, localKeyName: onTime.data.localKeyName, peerPublicKey: b0.publicKey, ackMessageId: onTime.data.messageId, ackWireMessageId: onTime.data.wireMessageId });
    m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m.deferred).toEqual([expect.stringMatching(/^acknowledgment .* awaits the observations of /)]);
    expect(m.acknowledged).toBe(false);
    scene.add("message.in", onTime.data, { at: onTime.at });
    m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m).toMatchObject({ acknowledged: true, late: false, deferred: [], faults: [] });
    scene.add("delivery.acknowledged", { messageId: out.data.messageId, localKeyName: onTime.data.localKeyName, peerPublicKey: b1.publicKey, ackMessageId: onTime.data.messageId, ackWireMessageId: onTime.data.wireMessageId });
    m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m.faults).toEqual([expect.stringMatching(/^acknowledgment .* names no complete witness among the observations of /)]);
  });

  it("applies an acknowledgment only once the message's membership is verified: a waiting package defers it, a witness in an incomplete group is none", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    const out = intent(scene, R);
    const forPackage = resolved(scene, a0.didId, b0);
    packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: forPackage });
    const ack = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1, overrides: { ack: [out.data.messageId] } });
    let m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m).toMatchObject({ acknowledged: true, ackWitnesses: [ack.eventId] });

    m = outboundOf(await fold(scene.events.filter((e) => e !== forPackage), keys), out.data.messageId);
    expect(m.acknowledged).toBe(false);
    expect(m.membership.status).toBe("deferred");
    expect(m.deferred).toEqual([expect.stringMatching(/^package .* awaits its recipient resolution$/), "1 acknowledging observation awaits the message's membership"]);

    const again = resolved(scene, a0.didId, b0);
    receipt(scene, { local: a0.didId, peer: b0, resolution: again, binding, ordinal: 2, wire: ack.data.wireMessageId, overrides: { ack: [out.data.messageId] } });
    m = outboundOf(await fold(scene.events.filter((e) => e !== again), keys), out.data.messageId);
    expect(m.acknowledged).toBe(false);
    expect(m.membership.status).toBe("verified");
  });

  it("derives membership from birth, binding and packages: what disagrees conflicts, what is not here waits, a birth without a binding stands alone", async () => {
    const v = await vaults();
    const { scene, keys, a0, a1, a2, b0, b1 } = v;
    const R = bound(scene, a0, b0, resolved(scene, a0.didId, b0)).R;
    const bornOnly = intent(scene, R, { messageId: uuidv7() as MessageId, birth: { localDidId: a0.didId, peerDid: b0.longFormDid } });
    const unbound = intent(scene, R);
    const otherPair = intent(scene, R, { birth: { localDidId: a0.didId, peerDid: b1.longFormDid } });
    const otherRoot = intent(scene, R, { birth: { localDidId: a1.didId, peerDid: b0.longFormDid } });
    const uncreated = intent(scene, R, { birth: { localDidId: "019b9999-0000-7000-8000-000000000999" as never, peerDid: b0.longFormDid } });
    const withoutBinding = scene.events.filter((e) => e.type !== "relationship.bound");
    let f = await fold(withoutBinding, keys);
    expect(outboundOf(f, bornOnly.data.messageId)).toMatchObject({ membership: { status: "verified" }, work: { kind: "prepare" } });
    expect(outboundOf(f, unbound.data.messageId)).toMatchObject({ membership: { status: "deferred" }, deferred: [`relationship ${R} has no binding`], work: { kind: "none", because: `awaits evidence: relationship ${R} has no binding` } });
    expect(outboundOf(f, otherPair.data.messageId).faults).toEqual([expect.stringMatching(new RegExp(`^the birth addresses derive .*, not ${R}$`))]);
    expect(outboundOf(f, uncreated.data.messageId).deferred).toEqual(["the birth local DID 019b9999-0000-7000-8000-000000000999 is not created"]);

    f = await fold(scene.events, keys);
    expect(outboundOf(f, bornOnly.data.messageId).membership).toEqual({ status: "verified" });
    expect(outboundOf(f, unbound.data.messageId).membership).toEqual({ status: "verified" });
    expect(outboundOf(f, otherRoot.data.messageId).faults).toEqual([expect.stringMatching(/^the birth addresses derive /), `the binding roots ${a0.didId}, not the birth local DID ${a1.didId}`]);

    const root = scene.events.find((e) => e.type === "peer.resolved")! as never;
    const fromOutside = packageOf(scene, unbound, { sender: a2.didId, recipient: b0, resolution: resolved(scene, a2.didId, b0) });
    const toOutside = packageOf(scene, unbound, { sender: a0.didId, recipient: b1, resolution: resolved(scene, a0.didId, b1) });
    const otherDocument = packageOf(scene, unbound, { sender: a0.didId, recipient: b0, resolution: resolved(scene, a0.didId, b0, { documentCid: rawCidOfBytes(new Uint8Array([1])) }) });
    const otherKey = packageOf(scene, unbound, { sender: a0.didId, recipient: b0, resolution: resolved(scene, a1.didId, b0) });
    const otherIntent = packageOf(scene, unbound, { sender: a0.didId, recipient: b0, resolution: root, overrides: { intentHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as never } });
    await expectFoldOrderFree(scene.events, keys, (folds) => {
      const m = outboundOf(folds, unbound.data.messageId);
      expect(m.packages.get(fromOutside.data.packageId)!.membership).toEqual({ status: "conflict", because: `is sent from ${a2.didId}, outside the local history` });
      expect(m.packages.get(toOutside.data.packageId)!.membership).toEqual({ status: "conflict", because: `is addressed to ${b1.did}, outside the peer history` });
      expect(m.packages.get(otherDocument.data.packageId)!.membership).toEqual({ status: "conflict", because: `names a recipient resolution that is not its document's; names a document of ${b0.did} that the peer chain does not pin` });
      expect(m.packages.get(otherKey.data.packageId)!.membership).toEqual({ status: "conflict", because: "names a recipient resolution taken at another key" });
      expect(m.packages.has(otherIntent.data.packageId)).toBe(false);
      expect(m.faults).toContain(`package ${otherIntent.data.packageId} carries another intent`);
      expect(m.outcome).toBe("conflict");
    });
  });

  it("waits for a sender a local transition would add, a recipient a peer transition would add, and an unverified recipient resolution", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const out = intent(scene, R);
    const jwt = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    localEdge(scene, R, a0.didId, a1.didId, jwt);
    const fromSuccessor = packageOf(scene, out, { sender: a1.didId, recipient: b0, resolution: resolved(scene, a1.didId, b0), fromPrior: jwt });
    const rotation = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 1);
    scene.events.splice(scene.events.indexOf(rotation.carrier), 1);
    const toSuccessor = packageOf(scene, out, { sender: a0.didId, recipient: b1, resolution: rotation.successor });
    const plain = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const v = await verdicts(scene.events, keys);
    let m = outboundOf(foldWith(VaultEventSet.of(scene.events), v), out.data.messageId);
    expect(m.packages.get(fromSuccessor.data.packageId)!.membership).toEqual({ status: "deferred", because: `awaits the local transition adding its sender ${a1.didId}` });
    expect(m.packages.get(toSuccessor.data.packageId)!.membership).toEqual({ status: "deferred", because: `awaits the peer transition adding its recipient ${b1.did}` });
    expect(m.packages.get(plain.data.packageId)!.membership).toEqual({ status: "verified" });
    expect(m.membership.status).toBe("deferred");
    expect(m.work.kind).toBe("none");

    m = outboundOf(foldWith(VaultEventSet.of(scene.events), v, new Map()), out.data.messageId);
    expect(m.membership).toEqual({ status: "deferred", because: `relationship ${R} does not stand: no root resolution is yet verified against its document` });
  });

  it("repacks from the current end after a local rotation, and a package from the successor carries exactly the transition's proof; ACKs cross the rotation both ways", async () => {
    const { scene, keys, R, a0, a1, a2, b0, root, binding } = await bornAtRoot();
    const out = intent(scene, R);
    const fromRoot = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const confirmation = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const jwt = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a1.longFormDid, IAT);
    localEdge(scene, R, a0.didId, a1.didId, jwt, ref(confirmation));
    let m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m.work).toEqual({ kind: "repack", packageIds: [fromRoot.data.packageId] });
    expect(m.packages.get(fromRoot.data.packageId)!.membership).toEqual({ status: "verified" });

    scene.add("message.packageRetired", { messageId: out.data.messageId, packageId: fromRoot.data.packageId, because: "repacked", replacementPackageId: null });
    const atA1 = resolved(scene, a1.didId, b0);
    const fromSuccessor = packageOf(scene, out, { sender: a1.didId, recipient: b0, resolution: atA1, fromPrior: jwt });
    const proofless = packageOf(scene, out, { sender: a1.didId, recipient: b0, resolution: atA1 });
    m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m.work).toEqual({ kind: "submit", packageIds: [fromSuccessor.data.packageId, proofless.data.packageId] });

    const ackAtRoot = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2, overrides: { ack: [out.data.messageId] } });
    await expectFoldOrderFree(scene.events, keys, (f) => {
      const message = outboundOf(f, out.data.messageId);
      expect(message.ackWitnesses).toEqual([ackAtRoot.eventId]);
      expect(message.acknowledged).toBe(true);
    });

    const other = await signFromPrior(keys, { didId: a0.didId, longFormDid: a0.longFormDid }, a2.longFormDid, IAT);
    const wrongProof = packageOf(scene, out, { sender: a1.didId, recipient: b0, resolution: atA1, fromPrior: other });
    const rootWithProof = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root, fromPrior: jwt });
    m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m.packages.get(wrongProof.data.packageId)!.membership).toEqual({ status: "conflict", because: "carries a proof that is not the transition's that added its sender" });
    expect(m.packages.get(rootWithProof.data.packageId)!.membership).toEqual({ status: "conflict", because: "carries a proof, though sent from the root" });
    expect(m.acknowledged).toBe(false);
  });

  it("works nothing while the current local end is not live", async () => {
    const { scene, keys, R, a0, b0, root } = await bornAtRoot();
    const out = intent(scene, R);
    packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("did.retired", { didId: a0.didId, because: "rotated away" });
    const m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m.work).toEqual({ kind: "none", because: `the current local DID ${a0.didId} is not live` });
    expect(m.outcome).toBe("prepared");
  });

  it("keeps a package recorded with two contents, or prepared for two messages, out of the packages as a fault; events naming no package or intent wait or are orphans", async () => {
    const { scene, keys, R, a0, b0, root } = await bornAtRoot();
    const out = intent(scene, R);
    const twice = intent(scene, R);
    const shared = uuidv7() as PackageId;
    const disputed = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("message.prepared", { ...disputed.data, envelopeCid: rawCidOfBytes(new Uint8Array([2])) });
    packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root, packageId: shared });
    packageOf(scene, twice, { sender: a0.didId, recipient: b0, resolution: root, packageId: shared });
    scene.add("delivery.submitted", { messageId: out.data.messageId, packageId: disputed.data.packageId });
    const unknown = uuidv7() as PackageId;
    scene.add("delivery.submitted", { messageId: twice.data.messageId, packageId: unknown });
    const orphan = uuidv7() as MessageId;
    const stray = scene.add("delivery.submitted", { messageId: orphan, packageId: unknown });
    await expectFoldOrderFree(scene.events, keys, (f) => {
      const m = outboundOf(f, out.data.messageId);
      expect(m.packages.size).toBe(0);
      expect(m.faults).toEqual([`package ${disputed.data.packageId} is recorded with 2 contents`, `package ${shared} is also prepared for ${twice.data.messageId}`, `a submission names the disputed package ${disputed.data.packageId}`]);
      expect(m.submitted).toBe(false);
      const t = outboundOf(f, twice.data.messageId);
      expect(t.faults).toEqual([`package ${shared} is also prepared for ${out.data.messageId}`]);
      expect(t.deferred).toEqual([`a submission names package ${unknown}, which is not here`]);
      expect(f.outbound.orphans.get(orphan)).toEqual([stray.eventId]);
      expect(f.outbound.outbounds.has(orphan)).toBe(false);
    });
  });

  it("is deferred as a whole while the relationship it names does not stand, and in conflict while the relationship is", async () => {
    const { scene, keys, R, a0, a1, b0, root } = await bornAtRoot();
    const out = intent(scene, R);
    packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    let m = outboundOf(await fold(scene.events.filter((e) => e !== root), keys), out.data.messageId);
    expect(m.membership).toEqual({ status: "deferred", because: `relationship ${R} does not stand: 1 binding names a peer resolution that is not here` });
    expect(m.work.kind).toBe("none");
    scene.add("relationship.bound", { relationshipId: R, localDidId: a1.didId, peerResolutionEventId: ref(resolved(scene, a1.didId, b0)) });
    m = outboundOf(await fold(scene.events, keys), out.data.messageId);
    expect(m.membership.status).toBe("conflict");
    expect(m.faults).toEqual([expect.stringMatching(new RegExp(`^relationship ${R} is in conflict: bindings disagree on the root local DID`))]);
    expect(m.outcome).toBe("conflict");
    expect(R).toBeDefined();
  });
});
