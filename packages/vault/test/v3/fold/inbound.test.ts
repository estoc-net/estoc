import type { Event } from "@estoc/event-store/v3";
import { describe, expect, it } from "vitest";

import {
  ackTargets,
  compareOrdinals,
  EMPTY_DOCUMENT_CID,
  executionId,
  foldInbound,
  foldRelationships,
  inboundMessageId,
  keyOf,
  PROBLEM_REPORT,
  verifyResolutions,
  verifyTransitions,
  VaultEventSet,
  type InboundFold,
  type Keys,
  type ReceiptOrdinal,
  type RelationshipFold,
  type RelationshipId,
  type VaultData,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { AUTHOR, AUTHOR2, HASH, checksOf, cidOf, expectOrderFree, foldChecked, messageIn, type KeyChecks } from "./helpers.js";
import { bound, intent, noObjects, peerRotation, receipt, ref, resolved, vaults } from "./scene.js";

type Folds = { relationships: RelationshipFold; inbound: InboundFold };
type Verdicts = { keyChecks: KeyChecks; resolutionChecks: Awaited<ReturnType<typeof verifyResolutions>>; proofChecks: Awaited<ReturnType<typeof verifyTransitions>> };

const EMPTY = "https://didcomm.org/empty/1.0/empty";
const PING = "https://didcomm.org/trust-ping/2.0/ping";
const PING_RESPONSE = "https://didcomm.org/trust-ping/2.0/ping-response";
const OTHER_HASH = "hmqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAQ" as VaultData["message.in"]["intentHash"];

async function verdicts(events: readonly Event[], keys: Keys): Promise<Verdicts> {
  const set = VaultEventSet.of(events);
  const keyChecks = await checksOf(events, keys);
  const routes = foldChecked(set, keyChecks).routes;
  return { keyChecks, resolutionChecks: await verifyResolutions(set, noObjects), proofChecks: await verifyTransitions(set, routes, noObjects) };
}

function foldWith(set: VaultEventSet, v: Verdicts, proofChecks = v.proofChecks): Folds {
  const routes = foldChecked(set, v.keyChecks).routes;
  const relationships = foldRelationships(set, routes, { proofChecks, resolutionChecks: v.resolutionChecks });
  return { relationships, inbound: foldInbound(set, relationships) };
}

async function fold(events: readonly Event[], keys: Keys): Promise<Folds> {
  return foldWith(VaultEventSet.of(events), await verdicts(events, keys));
}

async function expectFoldOrderFree(events: readonly Event[], keys: Keys, check: (folds: Folds) => void): Promise<void> {
  const v = await verdicts(events, keys);
  check(foldWith(VaultEventSet.of(events), v));
  expectOrderFree(events, (set) => foldWith(set, v).inbound);
}

async function bornAtRoot() {
  const v = await vaults();
  const { scene, a0, b0 } = v;
  const root = resolved(scene, a0.didId, b0);
  const { R, bound: binding } = bound(scene, a0, b0, root);
  return { ...v, R, binding, root };
}

const executionOf = (folds: Folds, R: RelationshipId, wire: WireMessageId) => folds.inbound.executions.get(executionId(R, wire))!;

describe("the execution", () => {
  it("is one wire ID in one relationship: duplicates and, once the rotation is verified, the alias under the peer's new key are one logical message; another relationship's reuse of the wire ID is another execution", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, b2, root, binding } = await bornAtRoot();
    const first = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const wire = first.data.wireMessageId;
    const duplicate = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2, wire, overrides: { receivedVia: { mediationId: null, deliveryId: "again" as VaultData["message.in"]["receivedVia"]["deliveryId"] } } });
    const rotation = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 3);
    const alias = receipt(scene, { local: a0.didId, peer: b1, resolution: rotation.successor, binding, ordinal: 4, wire, transition: ref(rotation.edge) });
    const otherRoot = resolved(scene, a1.didId, b2);
    const other = bound(scene, a1, b2, otherRoot);
    const reuse = receipt(scene, { local: a1.didId, peer: b2, resolution: otherRoot, binding: other.bound, ordinal: 5, wire });
    expect(alias.data.messageId).not.toBe(first.data.messageId);
    await expectFoldOrderFree(scene.events, keys, (folds) => {
      const execution = executionOf(folds, R, wire);
      expect(execution).toMatchObject({ relationshipId: R, wireMessageId: wire, status: "complete", because: null, kind: "application", intentHash: HASH, receiptConflict: false });
      expect(execution.messageIds).toEqual([first.data.messageId, alias.data.messageId].sort());
      expect(execution.eventIds).toEqual([first.eventId, duplicate.eventId, alias.eventId]);
      expect(execution.firstReceiptKey).toEqual({ ordinal: "1", author: AUTHOR });
      expect(execution.sourceKey).toEqual(keyOf(first));
      expect(execution.intent).toEqual({ msgType: first.data.msgType, thid: null, pthid: null, pleaseAck: null, ack: [] });
      const elsewhere = executionOf(folds, other.R, wire);
      expect(elsewhere.eventIds).toEqual([reuse.eventId]);
      expect(elsewhere.executionId).not.toBe(execution.executionId);
      expect(folds.inbound.observations.get(alias.eventId)).toMatchObject({ executionId: execution.executionId, receiptKey: { ordinal: "4", author: AUTHOR } });
      expect(folds.inbound.groupsByWire.get(wire)).toEqual([first.data.messageId, alias.data.messageId, reuse.data.messageId].sort());
      expect(folds.inbound.anonymous.size).toBe(0);
    });
    const unproven = foldWith(VaultEventSet.of(scene.events), await verdicts(scene.events, keys), new Map());
    const waiting = executionOf(unproven, R, wire);
    expect(waiting.status).toBe("complete");
    expect(waiting.eventIds).toEqual([first.eventId, duplicate.eventId]);
    expect(waiting.messageIds).toEqual([first.data.messageId, alias.data.messageId].sort());
    expect(unproven.inbound.observations.get(alias.eventId)!.scope.status).toBe("deferred");
  });

  it("is in conflict when one message ID's observations are scoped in two relationships, and when scoped observations of one wire ID disagree on the intent, whether in one group or across the peer's keys", async () => {
    const { scene, keys, peerKeys, R, a0, a1, b0, b1, root, binding } = await bornAtRoot();
    const twiceRoot = resolved(scene, a1.didId, b0);
    const twice = bound(scene, a1, b0, twiceRoot);
    const atA0 = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const split = atA0.data.wireMessageId;
    const atA1 = receipt(scene, { local: a1.didId, peer: b0, resolution: twiceRoot, binding: twice.bound, ordinal: 2, wire: split });
    expect(atA1.data.messageId).toBe(atA0.data.messageId);
    const said = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 3 });
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 4, wire: said.data.wireMessageId, overrides: { intentHash: OTHER_HASH } });
    const rotation = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 5);
    const before = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 6 });
    const after = receipt(scene, { local: a0.didId, peer: b1, resolution: rotation.successor, binding, ordinal: 7, wire: before.data.wireMessageId, transition: ref(rotation.edge), overrides: { intentHash: OTHER_HASH } });
    await expectFoldOrderFree(scene.events, keys, (folds) => {
      for (const relationshipId of [R, twice.R]) {
        const execution = executionOf(folds, relationshipId, split);
        expect(execution.status).toBe("conflict");
        expect(execution.because).toMatch(/^is in conflict: the observations are scoped in 2 relationships/);
        expect(execution.eventIds).toEqual([]);
        expect(execution.kind).toBeNull();
      }
      const oneGroup = executionOf(folds, R, said.data.wireMessageId);
      expect(oneGroup).toMatchObject({ status: "conflict", because: "is 2 scoped observations that disagree on the intent", intentHash: null, eventIds: [] });
      const acrossKeys = executionOf(folds, R, before.data.wireMessageId);
      expect(acrossKeys).toMatchObject({ status: "conflict", because: "is 2 scoped observations that disagree on the intent", intentHash: null, kind: null, firstReceiptKey: null });
      expect(acrossKeys.eventIds).toEqual([before.eventId, after.eventId]);
      expect(acrossKeys.messageIds).toEqual([before.data.messageId, after.data.messageId].sort());
      expect(folds.relationships.groups.get(before.data.messageId)!.status).toBe("complete");
      expect(folds.relationships.groups.get(after.data.messageId)!.status).toBe("complete");
    });
  });

  it("waits while its only group waits, and is in conflict while its only group contradicts", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    const waiting = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding: null, ordinal: 1, fromPrior: "eyJhbGciOiJFZERTQSJ9.e30.c2ln" });
    const contradicting = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2, fromPrior: "eyJhbGciOiJFZERTQSJ9.e30.c2ln" });
    await expectFoldOrderFree(scene.events, keys, (folds) => {
      expect(folds.inbound.observations.get(waiting.eventId)).toMatchObject({ executionId: null, scope: { status: "deferred", relationshipId: null } });
      expect(folds.inbound.executions.has(executionId(R, waiting.data.wireMessageId))).toBe(false);
      expect(folds.inbound.groupsByWire.get(waiting.data.wireMessageId)).toEqual([waiting.data.messageId]);
      expect(executionOf(folds, R, contradicting.data.wireMessageId)).toMatchObject({ status: "conflict", because: expect.stringMatching(/^is in conflict: observation .* carries a proof that does not parse/), eventIds: [], intentHash: null });
    });
  });
});

describe("the kind of a message", () => {
  it("tells application input from a pure ACK, a notification carrying a validated proof, a response in a thread an outbound opened, a no-response error, and a control type that fails its predicate", async () => {
    const { scene, keys, peerKeys, R, a0, b0, b1, root, binding } = await bornAtRoot();
    const asked = intent(scene, R);
    const ping = intent(scene, R, { msgType: PING });
    const threaded = intent(scene, R, { thid: "thread-1" });
    const empty = { msgType: EMPTY, bodyCid: EMPTY_DOCUMENT_CID } as const;
    const at = (ordinal: number, overrides: Partial<VaultData["message.in"]>) => receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal, overrides });
    const application = at(1, {});
    const pureAck = at(2, { ...empty, thid: asked.data.messageId, ack: [asked.data.messageId] });
    const ackAndRequest = at(3, { ...empty, ack: [asked.data.messageId], pleaseAck: [""] });
    const response = at(4, { ...empty, thid: asked.data.messageId });
    const threadedResponse = at(5, { ...empty, thid: "thread-1" });
    const unthreaded = at(6, { ...empty, thid: "thread-2" });
    const bodied = at(7, { msgType: EMPTY, ack: [asked.data.messageId] });
    const attached = at(8, { ...empty, attachmentCids: [cidOf("attachment")], ack: [asked.data.messageId] });
    const pong = at(9, { msgType: PING_RESPONSE, thid: ping.data.messageId });
    const pongOfNothing = at(10, { msgType: PING_RESPONSE, thid: asked.data.messageId });
    const pingRequest = at(11, { msgType: PING });
    const error = at(12, { msgType: PROBLEM_REPORT, pthid: asked.data.messageId });
    const errorAskingAck = at(13, { msgType: PROBLEM_REPORT, pthid: asked.data.messageId, pleaseAck: [""] });
    const errorWithoutParent = at(14, { msgType: PROBLEM_REPORT });
    const rotation = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 15);
    scene.events.pop();
    scene.events.pop();
    const notification = receipt(scene, { local: a0.didId, peer: b1, resolution: rotation.successor, binding, ordinal: 15, fromPrior: rotation.jwt, overrides: { ...empty, pleaseAck: [""], ack: [asked.data.messageId] } });
    scene.add("relationship.peerTransitioned", { ...rotation.edge.data, messageId: notification.data.messageId });
    const anonymousAck = messageIn(scene, { localDidId: a0.didId, localDid: a0.did, ordinal: 16, resolution: null, overrides: { ...empty, ack: [asked.data.messageId] } });
    const anonymousError = messageIn(scene, { localDidId: a0.didId, localDid: a0.did, ordinal: 17, resolution: null, pthid: asked.data.messageId, overrides: { msgType: PROBLEM_REPORT } });
    expect(threaded.data.thid).toBe("thread-1");
    await expectFoldOrderFree(scene.events, keys, (folds) => {
      const kindOf = (event: { data: { wireMessageId: WireMessageId } }) => executionOf(folds, R, event.data.wireMessageId).kind;
      expect(kindOf(application)).toBe("application");
      expect(kindOf(pureAck)).toBe("pure-ack");
      expect(kindOf(ackAndRequest)).toBe("malformed-control");
      expect(kindOf(response)).toBe("response");
      expect(kindOf(threadedResponse)).toBe("response");
      expect(kindOf(unthreaded)).toBe("malformed-control");
      expect(kindOf(bodied)).toBe("malformed-control");
      expect(kindOf(attached)).toBe("malformed-control");
      expect(kindOf(pong)).toBe("response");
      expect(kindOf(pongOfNothing)).toBe("malformed-control");
      expect(kindOf(pingRequest)).toBe("application");
      expect(kindOf(error)).toBe("error");
      expect(kindOf(errorAskingAck)).toBe("malformed-control");
      expect(kindOf(errorWithoutParent)).toBe("malformed-control");
      expect(kindOf(notification)).toBe("notification");
      expect(folds.inbound.anonymous.get(anonymousAck.data.messageId)).toMatchObject({ kind: "pure-ack", intentHash: HASH, firstReceiptKey: { ordinal: "16", author: AUTHOR }, sourceKey: keyOf(anonymousAck), receiptConflict: false });
      expect(folds.inbound.anonymous.get(anonymousError.data.messageId)!.kind).toBe("malformed-control");
      expect(folds.inbound.observations.get(anonymousAck.eventId)).toMatchObject({ executionId: null, scope: { status: "anonymous" } });
    });
  });

  it("is unknown while the execution is not complete, and null for anonymous observations that disagree on the intent", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    const one = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2, wire: one.data.wireMessageId, overrides: { intentHash: OTHER_HASH } });
    const anonymous = messageIn(scene, { localDidId: a0.didId, localDid: a0.did, ordinal: 3, resolution: null });
    const disagreeing = messageIn(scene, { localDidId: a0.didId, localDid: a0.did, ordinal: 4, resolution: null, wire: anonymous.data.wireMessageId, overrides: { intentHash: OTHER_HASH } });
    await expectFoldOrderFree(scene.events, keys, (folds) => {
      expect(executionOf(folds, R, one.data.wireMessageId)).toMatchObject({ status: "conflict", kind: null, intent: null });
      expect(folds.inbound.anonymous.get(anonymous.data.messageId)).toMatchObject({ kind: null, intent: null, intentHash: null, eventIds: [anonymous.eventId, disagreeing.eventId] });
    });
  });
});

describe("receipt keys", () => {
  it("order acknowledgment targets by the exact integer ordinal and then the author, never by the clock; a duplicate's fresh ordinal moves nothing, an unknown or foreign wire ID is omitted", async () => {
    const { scene, keys, R, a0, a1, b0, b2, root, binding } = await bornAtRoot();
    const otherRoot = resolved(scene, a1.didId, b2);
    const other = bound(scene, a1, b2, otherRoot);
    const ninth = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 9 }, { at: "2026-09-14T10:00:05.000Z" });
    const tenth = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 10 }, { at: "2026-09-14T10:00:01.000Z" });
    const tied = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 10 }, { at: "2026-09-14T10:00:00.000Z", author: AUTHOR2 });
    receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 11, wire: ninth.data.wireMessageId });
    const foreign = receipt(scene, { local: a1.didId, peer: b2, resolution: otherRoot, binding: other.bound, ordinal: 12 });
    const carrier = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 13, overrides: { pleaseAck: ["", tied.data.wireMessageId, tenth.data.wireMessageId, "unknown", foreign.data.wireMessageId, ninth.data.wireMessageId, ""] } });
    expect(compareOrdinals("10" as ReceiptOrdinal, "9" as ReceiptOrdinal)).toBeGreaterThan(0);
    await expectFoldOrderFree(scene.events, keys, (folds) => {
      const x = executionOf(folds, R, carrier.data.wireMessageId);
      expect(ackTargets(folds.inbound, x)).toEqual([ninth.data.wireMessageId, tenth.data.wireMessageId, tied.data.wireMessageId, carrier.data.wireMessageId]);
      expect(executionOf(folds, R, ninth.data.wireMessageId).firstReceiptKey).toEqual({ ordinal: "9", author: AUTHOR });
      expect(executionOf(folds, R, tied.data.wireMessageId).firstReceiptKey).toEqual({ ordinal: "10", author: AUTHOR2 });
      expect(ackTargets(folds.inbound, executionOf(folds, R, ninth.data.wireMessageId))).toEqual([]);
      expect(folds.inbound.receiptConflicts).toEqual([]);
      expect(folds.inbound.nextReceiptOrdinal).toBe("14");
    });
  });

  it("make two events of one author under one ordinal a receipt conflict that keeps their messages from being targets and nothing else; the next ordinal is above every ordinal here, an erased message's and another author's included", async () => {
    const { scene, keys, R, a0, b0, root, binding } = await bornAtRoot();
    const clean = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 1 });
    const first = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2 });
    const second = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 2 });
    const erased = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 30 }, { author: AUTHOR2 });
    scene.add("message.erased", { messageId: erased.data.messageId, dropCids: [erased.data.bodyCid], because: "user" });
    const carrier = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 3, overrides: { pleaseAck: [clean.data.wireMessageId, first.data.wireMessageId, second.data.wireMessageId, erased.data.wireMessageId] } });
    await expectFoldOrderFree(scene.events, keys, (folds) => {
      expect(folds.inbound.receiptConflicts).toEqual([{ author: AUTHOR, ordinal: "2", eventIds: [first.eventId, second.eventId] }]);
      for (const event of [first, second]) {
        expect(folds.inbound.observations.get(event.eventId)!.receiptConflict).toBe(true);
        expect(executionOf(folds, R, event.data.wireMessageId)).toMatchObject({ status: "complete", kind: "application", receiptConflict: true });
      }
      expect(folds.inbound.observations.get(clean.eventId)!.receiptConflict).toBe(false);
      expect(ackTargets(folds.inbound, executionOf(folds, R, carrier.data.wireMessageId))).toEqual([clean.data.wireMessageId, erased.data.wireMessageId]);
      expect(folds.inbound.nextReceiptOrdinal).toBe("31");
    });
    const { inbound } = await fold(scene.events.slice(0, scene.events.length - 6), keys);
    expect(inbound.nextReceiptOrdinal).toBe("1");
    expect(inbound.executions.size).toBe(0);
  });

  it("belong to the execution's complete observations only: an alias still waiting donates no key", async () => {
    const { scene, keys, peerKeys, R, a0, b0, b1, root, binding } = await bornAtRoot();
    const later = receipt(scene, { local: a0.didId, peer: b0, resolution: root, binding, ordinal: 5 });
    const rotation = await peerRotation(scene, peerKeys, R, a0.didId, b0, b1, root, binding, 6);
    const alias = receipt(scene, { local: a0.didId, peer: b1, resolution: rotation.successor, binding, ordinal: 1, wire: later.data.wireMessageId, transition: ref(rotation.edge) });
    const v = await verdicts(scene.events, keys);
    const proven = foldWith(VaultEventSet.of(scene.events), v);
    expect(executionOf(proven, R, later.data.wireMessageId).firstReceiptKey).toEqual({ ordinal: "1", author: AUTHOR });
    const unproven = foldWith(VaultEventSet.of(scene.events), v, new Map());
    expect(executionOf(unproven, R, later.data.wireMessageId).firstReceiptKey).toEqual({ ordinal: "5", author: AUTHOR });
    expect(unproven.inbound.observations.get(alias.eventId)!.receiptKey).toEqual({ ordinal: "1", author: AUTHOR });
    expect(inboundMessageId(b1.publicKey, later.data.wireMessageId)).toBe(alias.data.messageId);
  });
});
