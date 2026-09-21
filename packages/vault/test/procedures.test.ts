import { MemoryVault } from "@estoc/event-store";
import { importSeed } from "@estoc/keystore";
import { SignJWT, importJWK } from "jose";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import {
  AUTHENTICATION_METHOD,
  EMPTY_CONTENT_CID,
  EMPTY_MESSAGE_TYPE,
  Keys,
  PING_RESPONSE_EFFECT,
  PING_RESPONSE_TYPE,
  PING_TYPE,
  PROBLEM_REPORT_TYPE,
  PURE_ACK_EFFECT,
  ROTATION_NOTIFICATION_EFFECT,
  automaticIntent,
  blockChannels,
  blockDrafts,
  closeErasures,
  collectGarbage,
  compareChannels,
  consumeInvitations,
  consumptionDrafts,
  decisionFor,
  deleteContact,
  deleteContactDrafts,
  didKeyName,
  eraseMessage,
  erasureClosure,
  executionId,
  foldVault,
  foldVaultChecked,
  kindOf,
  rawCidOfBytes,
  responseChannel,
  scanVault,
  unfinishedWork,
  vaultHeldRoots,
  type Cid,
  type ContactId,
  type DidId,
  type Keys as VaultKeys,
  type MessageId,
  type PendingWork,
} from "../src/index.js";
import { AUTHOR2, SEED, Scene, cidOf, expectOrderFree } from "./fold/helpers.js";
import { IAT, PURE_ACK, automatic, blocked, channel, intent, invitation, noObjects, packageOf, proof, receipt, ref, resolved, rotation, vaults, type Local, type Peer } from "./fold/scene.js";

const encoder = new TextEncoder();

/** A vault in memory holding the scene's events and the bytes of every text named. */
async function vaultOf(scene: Scene, texts: readonly string[] = []): Promise<MemoryVault> {
  const vault = new MemoryVault({ metadata: { version: 3, anchor: await Keys.anchorOf(await importSeed(SEED)) } });
  for (const text of texts) await vault.stores.objects.putObject(cidOf(text), encoder.encode(text));
  await vault.ingest(scene.events);
  return vault;
}

const has = (vault: MemoryVault, cid: Cid) => vault.vault.objects.has(cid);

describe("erasing a message", () => {
  it("releases every root the message's events and packages still name in one erase, collects what nothing else holds, and erases nothing twice", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const attachment = cidOf("attachment");
    const out = intent(scene, a0, b0, { attachmentCids: [attachment] });
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const other = intent(scene, a0, b0, { bodyCid: out.data.bodyCid });
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
    expect(fold.retained.filter((edge) => edge.eventId === other.eventId)).toEqual([{ eventId: other.eventId, root: out.data.bodyCid }]);

    const again = await eraseMessage(vault, keys, out.data.messageId);
    expect(again.events).toEqual([]);
    expect(again.collected.removed).toEqual([]);
    expect((await eraseMessage(vault, keys, uuidv7() as MessageId)).events).toEqual([]);
  });

  it("the closure erases what an event learned later names under the same message, with the first erasure's reason", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const first = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const before = scene.events.length;
    const attachment = cidOf("late attachment");
    const duplicate = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, wire: first.data.wireMessageId, overrides: { attachmentCids: [attachment] } });
    expect(duplicate.data.messageId).toBe(first.data.messageId);
    const late = scene.events.splice(before);
    const vault = await vaultOf(scene, [`body ${first.data.wireMessageId}`]);

    const erased = await eraseMessage(vault, keys, first.data.messageId, "contact-deleted");
    expect(erased.events.map((event) => event.data)).toEqual([{ messageId: first.data.messageId, dropCids: [first.data.bodyCid], because: "contact-deleted" }]);
    expect(erased.collected.removed).toEqual([first.data.bodyCid]);
    scene.add("message.erased", { messageId: first.data.messageId, dropCids: [first.data.bodyCid], because: "user" });

    await vault.stores.objects.putObject(attachment, encoder.encode("late attachment"));
    await vault.ingest(late);
    let fold = await scanVault(vault.vault, keys);
    expect(fold.held.has(attachment)).toBe(true);
    const owed = erasureClosure(fold);
    expect(owed.map((draft) => draft.data)).toEqual([{ messageId: first.data.messageId, dropCids: [attachment], because: "contact-deleted" }]);
    const closed = await closeErasures(vault, keys);
    expect(closed.events.map((event) => event.data)).toEqual(owed.map((draft) => draft.data));
    expect(closed.collected.removed).toEqual([attachment]);
    fold = await scanVault(vault.vault, keys);
    expect(erasureClosure(fold)).toEqual([]);
    expect((await closeErasures(vault, keys)).events).toEqual([]);
  });

  it("hands the event store the same retention for collection, export and validation", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("message.erased", { messageId: out.data.messageId, dropCids: [pkg.data.envelopeCid], because: "user" });
    const stray = rawCidOfBytes(encoder.encode("stray"));
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, `envelope ${pkg.data.packageId}`, "stray"]);
    expect(new Set(await vaultHeldRoots(keys)(vault.vault))).toEqual(new Set([root.data.documentCid, out.data.bodyCid]));
    const collected = await collectGarbage(vault, keys);
    expect(collected.removed.sort()).toEqual([pkg.data.envelopeCid, stray].sort());
    expect(await has(vault, out.data.bodyCid)).toBe(true);
  });
});

const fold = (scene: Scene, keys: VaultKeys | null) => foldVaultChecked(scene.set(), keys, noObjects);

const proofFreeReceipt = (scene: Scene, local: Local, peer: Peer, ordinal: number, overrides: Parameters<typeof receipt>[1]["overrides"] = {}) =>
  receipt(scene, { local, peer, resolution: resolved(scene, local.didId, peer), ordinal, overrides });

const receiptCarryingProof = async (scene: Scene, peerKeys: VaultKeys, local: Local, predecessor: Peer, successor: Peer, ordinal: number) =>
  receipt(scene, { local, peer: successor, resolution: resolved(scene, local.didId, successor), ordinal, fromPrior: await proof(peerKeys, predecessor, successor) });

/** A proof whose issuer is spelled in short form: verified only once a retained resolution of the predecessor brings its document. */
async function shortIssuerProof(peerKeys: VaultKeys, predecessor: Peer, successor: Peer): Promise<string> {
  const key = await peerKeys.signing(didKeyName(predecessor.didId as DidId, "authentication"));
  return new SignJWT({ iss: predecessor.did, sub: successor.longFormDid, iat: IAT })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: `${predecessor.did}${AUTHENTICATION_METHOD}` })
    .sign(await importJWK(key.privateJwk(), "EdDSA"));
}

const inputOf = (source: { data: { wireMessageId: string } }, peer: Peer, local: Local) => executionId(peer.did, local.did, source.data.wireMessageId as never);

const CONTACT = "019b7100-0000-7000-8000-000000000c01" as ContactId;

const workSnapshot = (work: PendingWork) => ({
  outbounds: work.outbounds.map((o) => [o.messageId, o.work.kind]),
  responses: work.responses.map((r) => [r.execution.messageId, r.effectType, r.channel]),
  notifications: work.notifications.map((n) => [n.decision.event.eventId, n.channel, n.source?.event.eventId ?? null]),
  notificationConflicts: work.notificationConflicts.map((c) => [c.decision.event.eventId, c.notification.messageIds]),
  proofs: work.proofs.map((c) => c.source.event.eventId),
  consumptions: work.consumptions.map((d) => d.data),
});

describe("consuming invitations", () => {
  it("records the first eligible receipt of each available invitation, passes over refused ones, stops at one that waits, and never reopens a consumer", async () => {
    const { scene, keys, a0, a1, b0, b1, b2 } = await vaults();
    const disclosure = invitation(scene, a0);
    const other = invitation(scene, a1);
    const denied = proofFreeReceipt(scene, a0, b2, 1, { pthid: disclosure.data.oobId });
    blocked(scene, a0, b2);
    const first = proofFreeReceipt(scene, a0, b0, 2, { pthid: disclosure.data.oobId });
    const second = proofFreeReceipt(scene, a0, b1, 3, { pthid: disclosure.data.oobId });
    proofFreeReceipt(scene, a1, b0, 4, { pthid: other.data.oobId });
    const vault = await fold(scene, keys);
    expect(vault.invitations.invitations.get(disclosure.eventId)!.candidates.map((c) => [c.source.event.eventId, c.eligibility.status])).toEqual([
      [denied.eventId, "refused"],
      [first.eventId, "eligible"],
      [second.eventId, "eligible"],
    ]);
    const drafts = consumptionDrafts(vault);
    expect(drafts.map((draft) => draft.data)).toEqual([
      { disclosureEventId: disclosure.eventId, sourceEventId: first.eventId },
      { disclosureEventId: other.eventId, sourceEventId: scene.events.at(-1)!.eventId },
    ]);
    expectOrderFree(scene.events, (set) => consumptionDrafts(foldVault(set, vault.checks)).map((draft) => draft.data));

    const memory = await vaultOf(scene);
    const events = await consumeInvitations(memory, keys);
    expect(events.map((event) => event.data)).toEqual(drafts.map((draft) => draft.data));
    expect(await consumeInvitations(memory, keys)).toEqual([]);
    const after = await scanVault(memory.vault, keys);
    expect(after.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "consumed", consumer: b0.did });

    const earlier = receipt(scene, { local: a0, peer: b1, resolution: resolved(scene, a0.didId, b1), ordinal: 1, overrides: { pthid: disclosure.data.oobId } }, { author: AUTHOR2 });
    await memory.ingest(scene.events.slice(-2));
    expect((await scanVault(memory.vault, keys)).invitations.invitations.get(disclosure.eventId)!.candidates[1]!.source.event.eventId).toBe(earlier.eventId);
    expect(consumptionDrafts(await scanVault(memory.vault, keys))).toEqual([]);
  });

  it("waits with the invitation when a candidate ahead waits for evidence, and takes nothing behind an integrity conflict", async () => {
    const { scene, a0, b0, b1 } = await vaults();
    const disclosure = invitation(scene, a0);
    proofFreeReceipt(scene, a0, b0, 1, { pthid: disclosure.data.oobId });
    proofFreeReceipt(scene, a0, b1, 2, { pthid: disclosure.data.oobId });
    const unseeded = await fold(scene, null);
    expect(unseeded.invitations.invitations.get(disclosure.eventId)!.status.status).toBe("pending");
    expect(consumptionDrafts(unseeded)).toEqual([]);

    const { scene: other, keys: otherKeys, a0: c0, b0: d0, b1: d1 } = await vaults();
    const twice = invitation(other, c0);
    const root = resolved(other, c0.didId, d0);
    receipt(other, { local: c0, peer: d0, resolution: root, ordinal: 1, overrides: { pthid: twice.data.oobId } });
    receipt(other, { local: c0, peer: d0, resolution: root, ordinal: 1, overrides: { pthid: twice.data.oobId } });
    proofFreeReceipt(other, c0, d1, 2, { pthid: twice.data.oobId });
    const conflicted = await fold(other, otherKeys);
    expect(conflicted.invitations.invitations.get(twice.eventId)!.status.status).toBe("conflict");
    expect(consumptionDrafts(conflicted)).toEqual([]);
  });
});

describe("unfinished work", () => {
  it("lists the outbounds still to prepare or dispatch, the reply candidates of established inputs under the built-in address rule, and the proofs waiting for issuer material", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b2, b3 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const queued = intent(scene, a0, b0);
    const prepared = intent(scene, a0, b0);
    const pkg = packageOf(scene, prepared, { sender: a0.didId, recipient: b0, resolution: root });
    const sent = intent(scene, a0, b0);
    scene.add("delivery.submitted", { messageId: sent.data.messageId, packageId: packageOf(scene, sent, { sender: a0.didId, recipient: b0, resolution: root }).data.packageId });
    const asking = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { pleaseAck: [""] } });
    const ping = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { msgType: PING_TYPE, pleaseAck: [""] } });
    const answered = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 3, overrides: { pleaseAck: [""] } });
    automatic(scene, a0, b0, answered, inputOf(answered, b0, a0), PURE_ACK, { bodyCid: EMPTY_CONTENT_CID, thid: answered.data.wireMessageId, ack: [answered.data.wireMessageId] });
    const ackOfAnswered = scene.events.at(-1)!.data as { messageId: MessageId };
    const silent = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4 });
    const erasedPing = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 5, overrides: { msgType: PING_TYPE, pleaseAck: [""] } });
    scene.add("message.erased", { messageId: erasedPing.data.messageId, dropCids: [erasedPing.data.bodyCid], because: "user" });
    const waiting = receipt(scene, { local: a1, peer: b3, resolution: resolved(scene, a1.didId, b3), ordinal: 6, fromPrior: await shortIssuerProof(peerKeys, b2, b3) });
    const vault = await fold(scene, keys);
    expect(vault.channels.carriers.get(waiting.eventId)!.proof).toEqual({ status: "pending-proof" });
    const work = unfinishedWork(vault);
    expect(workSnapshot(work)).toEqual({
      outbounds: [
        [prepared.data.messageId, "dispatch"],
        [queued.data.messageId, "prepare"],
        [ackOfAnswered.messageId, "prepare"],
      ].sort(([a], [b]) => (a! < b! ? -1 : 1)),
      responses: [asking, ping, erasedPing]
        .map((event) => event.data.messageId)
        .sort()
        .flatMap((messageId) => (messageId === ping.data.messageId ? [PURE_ACK_EFFECT, PING_RESPONSE_EFFECT] : [PURE_ACK_EFFECT]).map((effectType) => [messageId, effectType, channel(a0, b0)])),
      notifications: [],
      notificationConflicts: [],
      proofs: [waiting.eventId],
      consumptions: [],
    });
    expect(work.outbounds.find((o) => o.messageId === prepared.data.messageId)!.work).toMatchObject({ kind: "dispatch", package: { event: pkg } });
    expect(vault.inbound.ofMessage(silent.data.messageId)).not.toBeNull();
    const draft = automaticIntent(vault, vault.inbound.ofMessage(asking.data.messageId)!, PURE_ACK_EFFECT);
    expect(draft).toMatchObject({ executionId: inputOf(asking, b0, a0), effectType: PURE_ACK_EFFECT, existing: null });
    expect(automaticIntent(vault, vault.inbound.ofMessage(answered.data.messageId)!, PURE_ACK_EFFECT).existing).not.toBeNull();
    expectOrderFree(scene.events, (set) => workSnapshot(unfinishedWork(foldVault(set, vault.checks))));
  });

  it("lists a pure ACK for an input whose request names an earlier input, none for one naming nothing here, none once the tuple has an intent, and one from the peer's successor naming the predecessor's input", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const first = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const namingFirst = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { pleaseAck: [first.data.wireMessageId] } });
    const namingNothing = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 3, overrides: { pleaseAck: [uuidv7()] } });
    let vault = await fold(scene, keys);
    expect(vault.outbound.ackTargets(namingFirst.eventId)).toEqual([first.data.wireMessageId]);
    expect(vault.outbound.ackTargets(namingNothing.eventId)).toEqual([]);
    expect(workSnapshot(unfinishedWork(vault)).responses).toEqual([[namingFirst.data.messageId, PURE_ACK_EFFECT, channel(a0, b0)]]);

    automatic(scene, a0, b0, namingFirst, inputOf(namingFirst, b0, a0), PURE_ACK, { bodyCid: EMPTY_CONTENT_CID, thid: namingFirst.data.wireMessageId, ack: [first.data.wireMessageId] });
    const ack = scene.events.at(-1)!.data as { messageId: MessageId };
    vault = await fold(scene, keys);
    expect(workSnapshot(unfinishedWork(vault))).toMatchObject({ outbounds: [[ack.messageId, "prepare"]], responses: [] });

    const fromSuccessor = receipt(scene, { local: a0, peer: b1, resolution: resolved(scene, a0.didId, b1), ordinal: 4, fromPrior: await proof(peerKeys, b0, b1), overrides: { pleaseAck: [first.data.wireMessageId] } });
    vault = await fold(scene, keys);
    expect(vault.outbound.ackTargets(fromSuccessor.eventId)).toEqual([first.data.wireMessageId]);
    expect(workSnapshot(unfinishedWork(vault)).responses).toEqual([[fromSuccessor.data.messageId, PURE_ACK_EFFECT, channel(a0, b1)]]);
    expectOrderFree(scene.events, (set) => workSnapshot(unfinishedWork(foldVault(set, vault.checks))));
  });

  it("selects the reply address as the carrier channel while its local DID sends, else the unique verified local successor keeping the peer, and none through denial, conflict or a peer that moved on", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const asking = proofFreeReceipt(scene, a0, b0, 1, { pleaseAck: [""] });
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: asking });
    let vault = await fold(scene, keys);
    const execution = () => vault.inbound.ofMessage(asking.data.messageId)!;
    expect(vault.continuity.status(decision.eventId)).toEqual({ status: "verified" });
    expect(responseChannel(vault, execution())).toEqual({ status: "selected", channel: channel(a0, b0) });

    scene.add("did.retired", { didId: a0.didId, because: "rotated" });
    vault = await fold(scene, keys);
    expect(responseChannel(vault, execution())).toEqual({ status: "selected", channel: channel(a1, b0) });
    expect(unfinishedWork(vault).responses.map((r) => [r.execution.messageId, r.channel])).toEqual([[asking.data.messageId, channel(a1, b0)]]);

    const fork = await rotation(scene, keys, { from: a0, peer: b0, to: a2, source: asking });
    vault = await fold(scene, keys);
    expect(vault.continuity.status(fork.eventId).status).toBe("conflict");
    expect(responseChannel(vault, execution())).toEqual({ status: "none", because: "the channel's continuity is in conflict" });

    const { scene: other, keys: otherKeys, peerKeys: otherPeerKeys, a0: c0, b0: d0, b1: d1 } = await vaults();
    const old = proofFreeReceipt(other, c0, d0, 1, { pleaseAck: [""] });
    await receiptCarryingProof(other, otherPeerKeys, c0, d0, d1, 2);
    vault = await fold(other, otherKeys);
    expect(responseChannel(vault, vault.inbound.ofMessage(old.data.messageId)!)).toEqual({ status: "none", because: "the peer has replaced its DID" });
    expect(unfinishedWork(vault).responses).toEqual([]);

    const { scene: third, keys: thirdKeys, a0: e0, a1: e1, b0: f0 } = await vaults();
    const asked = proofFreeReceipt(third, e0, f0, 1, { pleaseAck: [""] });
    await rotation(third, thirdKeys, { from: e0, peer: f0, to: e1, source: asked });
    third.add("did.retired", { didId: e0.didId, because: "rotated" });
    blocked(third, e1, f0);
    vault = await fold(third, thirdKeys);
    expect(responseChannel(vault, vault.inbound.ofMessage(asked.data.messageId)!)).toEqual({ status: "none", because: "the local DID cannot send: retired: rotated, and its successor cannot reply: the channel is denied" });
    blocked(third, e0, f0);
    vault = await fold(third, thirdKeys);
    expect(responseChannel(vault, vault.inbound.ofMessage(asked.data.messageId)!)).toEqual({ status: "none", because: "the channel is denied" });
  });

  it("lists the notification a verified decision permits while its source stays eligible, reuses one already recorded, and reports several as a conflict", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const manual = await rotation(scene, keys, { from: a1, peer: b1, to: a0 });
    proofFreeReceipt(scene, a1, b1, 2);
    let vault = await fold(scene, keys);
    expect(vault.continuity.status(decision.eventId)).toEqual({ status: "verified" });
    expect(vault.continuity.status(manual.eventId)).toEqual({ status: "verified" });
    expect(workSnapshot(unfinishedWork(vault)).notifications).toEqual([
      [decision.eventId, channel(a1, b0), source.eventId],
      [manual.eventId, channel(a0, b1), null],
    ]);

    const notification = automatic(scene, a1, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    vault = await fold(scene, keys);
    expect(workSnapshot(unfinishedWork(vault)).notifications).toEqual([[manual.eventId, channel(a0, b1), null]]);
    expect(unfinishedWork(vault).outbounds.map((o) => o.messageId)).toEqual([notification.data.messageId]);

    await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 3);
    const manualForm = intent(scene, a1, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: ref(decision) });
    vault = await fold(scene, keys);
    const work = workSnapshot(unfinishedWork(vault));
    expect(work.notifications).toEqual([]);
    expect(work.notificationConflicts).toEqual([[decision.eventId, [notification.data.messageId, manualForm.data.messageId].sort()]]);
  });

  it("lists no notification for a verified decision a control input triggered: a pure ACK, another Empty, a ping response or a problem report", async () => {
    const { scene, keys, a0, a1, b0, b1, b2, b3 } = await vaults();
    const controls = [
      proofFreeReceipt(scene, a0, b0, 1, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, ack: [uuidv7()] }),
      proofFreeReceipt(scene, a0, b1, 2, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID }),
      proofFreeReceipt(scene, a0, b2, 3, { msgType: PING_RESPONSE_TYPE }),
      proofFreeReceipt(scene, a0, b3, 4, { msgType: PROBLEM_REPORT_TYPE }),
    ];
    const decisions = [];
    for (const [index, peer] of [b0, b1, b2, b3].entries()) decisions.push(await rotation(scene, keys, { from: a0, peer, to: a1, source: controls[index] }));
    const vault = await fold(scene, keys);
    expect(controls.map((source) => kindOf(source.data))).toEqual(["pure-ack", "empty", "ping-response", "error"]);
    for (const decision of decisions) expect(vault.continuity.status(decision.eventId)).toEqual({ status: "verified" });
    expect(workSnapshot(unfinishedWork(vault))).toMatchObject({ notifications: [], notificationConflicts: [] });
  });
});

describe("the decision a rotation reuses", () => {
  it("is the one recorded from the local DID in its verified peer-only context: none, one to reuse, one to wait for, or several in conflict", async () => {
    const { scene, keys, a0, a1, a2, b0, b1 } = await vaults();
    let vault = await fold(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toEqual({ status: "none" });

    const source = proofFreeReceipt(scene, a0, b0, 1);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const elsewhere = await rotation(scene, keys, { from: a0, peer: b1, to: a2 });
    vault = await fold(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toEqual({ status: "reuse", decision: vault.channels.decisions.get(decision.eventId) });
    expect(decisionFor(vault, a0.did, b1.did)).toEqual({ status: "reuse", decision: vault.channels.decisions.get(elsewhere.eventId) });
    expect(decisionFor(vault, a1.did, b0.did)).toEqual({ status: "none" });

    vault = await fold(scene, null);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "defer", decision: { event: decision } });

    const fork = await rotation(scene, keys, { from: a0, peer: b0, to: a2, source });
    vault = await fold(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "conflict", decisions: [{ event: decision }, { event: fork }] });
  });
});

describe("denying channels and deleting a contact", () => {
  it("denies each pair once, to no lesser extent than it already is, and the tombstone takes the denials and erasures the product chose with it", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const inbound = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const out = intent(scene, a0, b0);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const elsewhere = intent(scene, a1, b1);
    blocked(scene, a1, b1);
    scene.add("contact.created", { contactId: CONTACT, because: "user" });
    scene.add("contact.channelsSet", { contactId: CONTACT, channels: [channel(a0, b0), channel(a1, b1)].sort(compareChannels) });
    const vault = await fold(scene, keys);
    expect(blockDrafts(vault, [channel(a1, b1), channel(a0, b0), channel(a0, b0)], false).map((d) => d.data)).toEqual([{ localDid: a0.did, peerDid: b0.did, includeSuccessors: false }]);
    expect(blockDrafts(vault, [channel(a1, b1)], true).map((d) => d.data)).toEqual([{ localDid: a1.did, peerDid: b1.did, includeSuccessors: true }]);
    expect(deleteContactDrafts(vault, CONTACT).map((d) => d.data)).toEqual([{ contactId: CONTACT }]);
    expect(deleteContactDrafts(vault, "019b7100-0000-7000-8000-0000000000ff" as ContactId)).toEqual([]);
    const drafts = deleteContactDrafts(vault, CONTACT, { block: { includeSuccessors: true }, erase: "contact-deleted" });
    expect(drafts.map((d) => [d.type, d.data])).toEqual([
      ["contact.deleted", { contactId: CONTACT }],
      ...[channel(a0, b0), channel(a1, b1)].sort(compareChannels).map((c) => ["channel.blocked", { ...c, includeSuccessors: true }]),
      ...[
        ["message.erased", { messageId: inbound.data.messageId, dropCids: [inbound.data.bodyCid], because: "contact-deleted" }],
        ["message.erased", { messageId: out.data.messageId, dropCids: [out.data.bodyCid, pkg.data.envelopeCid].sort(), because: "contact-deleted" }],
        ["message.erased", { messageId: elsewhere.data.messageId, dropCids: [elsewhere.data.bodyCid], because: "contact-deleted" }],
      ].sort(([, a], [, b]) => ((a as { messageId: string }).messageId < (b as { messageId: string }).messageId ? -1 : 1)),
    ]);

    const memory = await vaultOf(scene, [`body ${out.data.messageId}`, `envelope ${pkg.data.packageId}`]);
    const events = await blockChannels(memory, keys, [channel(a0, b0)], false);
    expect(events.map((e) => e.data)).toEqual([{ localDid: a0.did, peerDid: b0.did, includeSuccessors: false }]);
    expect(await blockChannels(memory, keys, [channel(a0, b0)], false)).toEqual([]);
    const deleted = await deleteContact(memory, keys, CONTACT, { block: { includeSuccessors: true }, erase: "contact-deleted" });
    expect(deleted.events.map((e) => e.type)).toEqual(["contact.deleted", "channel.blocked", "channel.blocked", "message.erased", "message.erased", "message.erased"]);
    expect(deleted.collected.removed.sort()).toEqual([out.data.bodyCid, pkg.data.envelopeCid].sort());
    const after = await scanVault(memory.vault, keys);
    expect(after.contacts.contacts.get(CONTACT)!.deleted).toBe(true);
    expect(after.continuity.blocked(channel(a0, b0)).map((d) => d.data.includeSuccessors)).toEqual([false, true]);
    expect((await deleteContact(memory, keys, CONTACT, { block: { includeSuccessors: true }, erase: "contact-deleted" })).events).toEqual([]);
  });
});
