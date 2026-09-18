import { p256 } from "@noble/curves/nist";
import { base64urlnopad } from "@scure/base";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import {
  EMPTY_CONTENT_CID,
  EMPTY_MESSAGE_TYPE,
  PING_RESPONSE_EFFECT,
  PING_RESPONSE_TYPE,
  PING_TYPE,
  PROBLEM_REPORT_TYPE,
  ROTATION_NOTIFICATION_EFFECT,
  canonicalPublicKey,
  didKeyName,
  executionId,
  foldVault,
  foldVaultChecked,
  inboundMessageId,
  type DidId,
  type EventId,
  type Keys,
  type MessageHash,
  type MessageId,
  type MessageOut,
  type Outbound,
  type PackageId,
  VaultEventSet,
  type VaultChecks,
  type VaultEvent,
  type VaultFold,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { AUTHOR2, Scene, cidOf, expectOrderFree } from "./helpers.js";
import { PEER_ID3, PURE_ACK, automatic, blocked, intent, noObjects, packageOf, peerAgreeingOn, peerAgreeingOnBoth, proof, receipt, ref, resolved, rotation, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null) => foldVaultChecked(scene.set(), keys, noObjects);

const OTHER_HASH = "Amqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA" as MessageHash;

const P256_KEY = (() => {
  const point = p256.getPublicKey(new Uint8Array(32).fill(1), false);
  return canonicalPublicKey({ kty: "EC", crv: "P-256", x: base64urlnopad.encode(point.subarray(1, 33)), y: base64urlnopad.encode(point.subarray(33)) });
})();

/** The outbound fold as comparable data: every outbound by its verdicts, with events by ID. */
function picture(vault: VaultFold) {
  const { outbound } = vault;
  return {
    outbounds: [...outbound.outbounds.values()].map((o) => ({
      messageId: o.messageId,
      intents: o.intents.map((event) => event.eventId),
      intent: o.intent.status,
      channel: o.channel,
      packages: o.packages.map((pkg) => [pkg.event.eventId, pkg.status, pkg.erased]),
      package: o.package?.event.eventId ?? null,
      submissions: o.submissions.map((s) => [s.event.eventId, s.status]),
      submitted: o.submitted,
      terminations: o.terminations.map((t) => [t.event.eventId, t.status]),
      terminal: o.terminal?.event.eventId ?? null,
      effect: o.effect,
      ackWitnesses: o.ackWitnesses.map(({ source }) => source.event.eventId),
      acknowledgements: o.acknowledgements.map((a) => [a.event.eventId, a.status]),
      acknowledged: o.acknowledged,
      late: o.late,
      erased: o.erased,
      outcome: o.outcome,
      work: o.work.kind === "dispatch" ? { kind: "dispatch", package: o.work.package.event.eventId } : o.work,
      released: o.released,
    })),
    stray: outbound.stray.map((event) => event.eventId),
    released: outbound.released,
  };
}

const expectSameOverEveryOrder = (scene: Scene, checks: Required<VaultChecks>) => expectOrderFree(scene.events, (set) => picture(foldVault(set, checks)));

const submitted = (scene: Scene, out: VaultEvent<"message.out">, pkg: VaultEvent<"message.prepared">, packageId = pkg.data.packageId) =>
  scene.add("delivery.submitted", { messageId: out.data.messageId, packageId });
const failed = (scene: Scene, out: VaultEvent<"message.out">, code: "expired" | "cancelled") => scene.add("delivery.failed", { messageId: out.data.messageId, code });
const acknowledged = (scene: Scene, out: VaultEvent<"message.out">, carrier: VaultEvent<"message.in">, peer: Peer, local: Local, overrides: Partial<VaultEvent<"delivery.acknowledged">["data"]> = {}) =>
  scene.add("delivery.acknowledged", {
    messageId: out.data.messageId,
    localKeyName: didKeyName(local.didId, "key-agreement"),
    peerPublicKey: peer.publicKey,
    ackMessageId: carrier.data.messageId,
    ackWireMessageId: carrier.data.wireMessageId,
    ...overrides,
  });

/** The input a receipt is, as its execution is named. */
const inputOf = (source: VaultEvent<"message.in">, peer: Peer, local: Local) => executionId(peer.did, local.did, source.data.wireMessageId);

/** A pure ACK of a source received at `received`, in its exact shape: Empty, body `{}`, the carrier's thread and creation time, targets in `ack`. */
const pureAck = (scene: Scene, sender: Local, recipient: Peer, source: VaultEvent<"message.in">, overrides: Partial<MessageOut> = {}, received = sender) =>
  automatic(scene, sender, recipient, source, inputOf(source, recipient, received), PURE_ACK, {
    bodyCid: EMPTY_CONTENT_CID,
    thid: source.data.thid ?? source.data.wireMessageId,
    pthid: source.data.pthid,
    createdTime: source.data.createdTime,
    ack: [source.data.wireMessageId],
    ...overrides,
  });

const outboundOf = (vault: VaultFold, out: VaultEvent<"message.out">): Outbound => vault.outbound.outbounds.get(out.data.messageId)!;

/**
 * The outbound of one variant of a tuple, folded without the other
 * variants: two under one message ID would merely disagree, and each
 * variant is to be checked on its own.
 */
const variant = (scene: Scene, checks: Required<VaultChecks>, out: VaultEvent<"message.out">, others: readonly VaultEvent<"message.out">[]): Outbound =>
  outboundOf(foldVault(VaultEventSet.of(scene.events.filter((event) => event === out || !others.includes(event as VaultEvent<"message.out">))), checks), out);

describe("an outbound message", () => {
  it("is queued, then prepared, then submitted, each fact standing on its own; identical intents count once and delivery events of no intent are stray", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    let vault = await fold(scene, keys);
    expect(outboundOf(vault, out)).toMatchObject({
      intent: { status: "consistent", data: out.data },
      channel: { localDid: a0.did, peerDid: b0.did },
      packages: [],
      package: null,
      submitted: false,
      terminal: null,
      effect: { status: "complete" },
      acknowledged: false,
      late: false,
      erased: false,
      outcome: { status: "queued" },
      work: { kind: "prepare" },
      released: false,
    });

    scene.add("message.out", out.data);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("message.prepared", pkg.data, { author: AUTHOR2 });
    vault = await fold(scene, keys);
    let outbound = outboundOf(vault, out);
    expect(outbound.intents).toHaveLength(2);
    expect(outbound.packages.map((p) => [p.event.eventId, p.status, p.erased])).toEqual([[pkg.eventId, { status: "complete" }, false]]);
    expect(outbound).toMatchObject({ package: { event: { eventId: pkg.eventId } }, outcome: { status: "prepared" }, work: { kind: "dispatch", package: { event: { eventId: pkg.eventId } } }, released: false });
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(true);

    const submission = submitted(scene, out, pkg);
    const cancel = failed(scene, out, "cancelled");
    const stray = scene.add("delivery.submitted", { messageId: uuidv7() as MessageId, packageId: pkg.data.packageId });
    vault = await fold(scene, keys);
    outbound = outboundOf(vault, out);
    expect(outbound.submissions).toEqual([{ event: submission, status: { status: "complete" } }]);
    expect(outbound.terminations).toEqual([{ event: cancel, status: { status: "complete" } }]);
    expect(outbound).toMatchObject({ submitted: true, terminal: { event: cancel }, outcome: { status: "submitted" }, work: { kind: "none", because: "submitted" }, released: true });
    expect(vault.outbound.released).toEqual(new Set([out.data.messageId]));
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(false);
    expect(vault.held.has(out.data.bodyCid)).toBe(true);
    expect(vault.outbound.stray).toEqual([stray]);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("fixes one package: a second distinct preparation is a conflict with no winner, one that contradicts the intent is a conflict, one whose evidence is missing waits, and a submission counts only for a complete package", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    const first = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const second = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    let vault = await fold(scene, keys);
    let outbound = outboundOf(vault, out);
    expect(outbound.packages.map((p) => p.status)).toEqual([{ status: "complete" }, { status: "complete" }]);
    expect(outbound).toMatchObject({ package: null, outcome: { status: "conflict", because: "2 packages are prepared for one message" }, work: { kind: "none" }, released: false });
    expect(vault.held.has(first.data.envelopeCid)).toBe(true);
    expect(vault.held.has(second.data.envelopeCid)).toBe(true);
    expectSameOverEveryOrder(scene, vault.checks);

    const contradictions: [string, Parameters<typeof packageOf>[2]][] = [
      ["the package's sender is not the intent's", { sender: a1.didId, recipient: b0, resolution: resolved(scene, a1.didId, b0) }],
      ["the package's intent hash is not the intent's", { sender: a0.didId, recipient: b0, resolution: root, overrides: { intentHash: OTHER_HASH } }],
      ["the package's recipient is not the intent's", { sender: a0.didId, recipient: b1, resolution: resolved(scene, a0.didId, b1) }],
      ["the resolution it names was not taken at the package's key", { sender: a0.didId, recipient: b0, resolution: resolved(scene, a1.didId, b0) }],
      ["the resolution it names is not of the recipient", { sender: a0.didId, recipient: b0, resolution: resolved(scene, a0.didId, b1) }],
      ["the resolution it names is a message.out", { sender: a0.didId, recipient: b0, resolution: out as never }],
    ];
    for (const [because, input] of contradictions) {
      const own = intent(scene, a0, b0);
      const pkg = packageOf(scene, own, input);
      submitted(scene, own, pkg);
      vault = await fold(scene, keys);
      outbound = outboundOf(vault, own);
      expect(outbound.packages[0]!.status).toEqual({ status: "conflict", because });
      expect(outbound.submissions[0]!.status).toEqual({ status: "conflict", because: `the package it names contradicts the intent: ${because}` });
      expect(outbound).toMatchObject({ submitted: false, outcome: { status: "conflict", because: `the package contradicts the intent: ${because}` }, released: false });
    }

    const waiting = intent(scene, a0, b0);
    const unresolved = packageOf(scene, waiting, { sender: a0.didId, recipient: b0, resolution: root, overrides: { peerResolutionEventId: uuidv7() as EventId as never } });
    submitted(scene, waiting, unresolved);
    const elsewhere = submitted(scene, waiting, unresolved, uuidv7() as PackageId);
    vault = await fold(scene, keys);
    outbound = outboundOf(vault, waiting);
    expect(outbound.packages[0]!.status).toEqual({ status: "pending", because: "the resolution it names is not here" });
    expect(outbound.submissions.map((s) => s.status)).toEqual([
      { status: "pending", because: "the resolution it names is not here" },
      { status: "pending", because: "the package it names is not here" },
    ]);
    expect(outbound).toMatchObject({ submitted: false, outcome: { status: "prepared" }, work: { kind: "none", because: "a submission names a package that is not here" }, released: false });
    expect(vault.held.has(unresolved.data.envelopeCid)).toBe(true);
    expect(elsewhere.data.messageId).toBe(waiting.data.messageId);

    const unseeded = await fold(scene, null);
    expect(outboundOf(unseeded, out).packages.map((p) => p.status)).toEqual([{ status: "complete" }, { status: "complete" }]);
    expect(outboundOf(unseeded, out).work).toEqual({ kind: "none", because: "2 packages are prepared for one message" });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("agrees no keys across curves: a package whose resolution selected a peer key on another curve than the sender's contradicts the intent, and its submission releases nothing", async () => {
    const { scene, keys, peerKeys, a0, b0 } = await vaults();
    const nist = await peerAgreeingOn(peerKeys, PEER_ID3, P256_KEY);
    const out = intent(scene, a0, nist);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: nist, resolution: resolved(scene, a0.didId, nist) });
    submitted(scene, out, pkg);
    const agreed = intent(scene, a0, b0);
    const agreeing = packageOf(scene, agreed, { sender: a0.didId, recipient: b0, resolution: resolved(scene, a0.didId, b0) });
    submitted(scene, agreed, agreeing);
    const because = "the peer key is P-256 and the sender's key-agreement key X25519: no key is agreed across curves";
    for (const vault of [await fold(scene, keys), await fold(scene, null)]) {
      expect(outboundOf(vault, out).packages[0]!.status).toEqual({ status: "conflict", because });
      expect(outboundOf(vault, out)).toMatchObject({ submitted: false, outcome: { status: "conflict", because: `the package contradicts the intent: ${because}` }, work: { kind: "none" }, released: false });
      expect(vault.held.has(pkg.data.envelopeCid)).toBe(true);
      expect(outboundOf(vault, agreed)).toMatchObject({ submitted: true, outcome: { status: "submitted" }, released: true });
      expect(vault.held.has(agreeing.data.envelopeCid)).toBe(false);
    }
    expectSameOverEveryOrder(scene, (await fold(scene, keys)).checks);
  });

  it("keeps a complete submission and its released envelope under a consistent intent whatever competing preparation is imported later; a disagreeing intent stands nothing on", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    submitted(scene, out, pkg);
    const sameId = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root, packageId: pkg.data.packageId, overrides: { peerResolutionEventId: uuidv7() as EventId as never } }, { at: "2020-01-01T00:00:00.000Z" });
    let vault = await fold(scene, keys);
    expect(outboundOf(vault, out).packages.map((p) => [p.event.eventId, p.status])).toEqual([
      [sameId.eventId, { status: "pending", because: "the resolution it names is not here" }],
      [pkg.eventId, { status: "complete" }],
    ]);
    expect(outboundOf(vault, out)).toMatchObject({ submissions: [{ status: { status: "complete" } }], submitted: true, outcome: { status: "conflict", because: "2 packages are prepared for one message" }, work: { kind: "none" }, released: true });
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(false);
    expectSameOverEveryOrder(scene, vault.checks);

    const competing = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("message.out", { ...out.data, intentHash: OTHER_HASH });
    vault = await fold(scene, keys);
    const outbound = outboundOf(vault, out);
    expect(outbound.intent).toEqual({ status: "conflict", because: "the intents recorded under one message ID disagree" });
    expect(outbound.packages.map((p) => p.status)).toEqual(new Array(3).fill({ status: "pending", because: "the intent is not consistent" }));
    expect(outbound).toMatchObject({ submitted: false, outcome: { status: "conflict" }, released: false });
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(true);

    const agreed = new Scene();
    agreed.events.push(...scene.events.filter((event) => event.type !== "message.out" || event.eventId === out.eventId));
    const settled = foldVault(agreed.set(), vault.checks);
    const complete = outboundOf(settled, out);
    expect(complete).toMatchObject({ submitted: true, package: null, outcome: { status: "conflict", because: "3 packages are prepared for one message" }, work: { kind: "none" }, released: true });
    expect(settled.held.has(pkg.data.envelopeCid)).toBe(false);
    expect(settled.held.has(competing.data.envelopeCid)).toBe(false);
    expectOrderFree(agreed.events, (set) => picture(foldVault(set, vault.checks)));
  });

  it("ends unsent work by a valid termination only: expiry needs an expiry, cancellation does not, a package is not needed, and a submission takes precedence", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const never = intent(scene, a0, b0);
    const bogus = failed(scene, never, "expired");
    const expiring = intent(scene, a0, b0, { expiresTime: 1_800_000_000 });
    const expired = failed(scene, expiring, "expired");
    const held = packageOf(scene, expiring, { sender: a0.didId, recipient: b0, resolution: root });
    const cancelled = intent(scene, a0, b0);
    failed(scene, cancelled, "cancelled");
    const sent = intent(scene, a0, b0);
    submitted(scene, sent, packageOf(scene, sent, { sender: a0.didId, recipient: b0, resolution: root }));
    failed(scene, sent, "cancelled");
    const vault = await fold(scene, keys);
    expect(outboundOf(vault, never).terminations).toEqual([{ event: bogus, status: { status: "invalid", because: "the intent has no expiry to reach" } }]);
    expect(outboundOf(vault, never)).toMatchObject({ terminal: null, outcome: { status: "queued" }, work: { kind: "prepare" }, released: false });
    expect(outboundOf(vault, expiring)).toMatchObject({ terminal: { event: expired }, outcome: { status: "terminal", code: "expired" }, work: { kind: "none", because: "terminated: expired" }, released: true });
    expect(vault.held.has(held.data.envelopeCid)).toBe(false);
    expect(vault.held.has(expiring.data.bodyCid)).toBe(true);
    expect(outboundOf(vault, cancelled)).toMatchObject({ outcome: { status: "terminal", code: "cancelled" }, package: null, released: true });
    expect(outboundOf(vault, sent)).toMatchObject({ submitted: true, terminal: { event: { data: { code: "cancelled" } } }, outcome: { status: "submitted" }, released: true });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is acknowledged by a complete witness whose ack names it, in its channel or over a verified role-preserving path, and is late by the earliest such receipt", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const start = Date.UTC(2026, 8, 13) / 1000;
    const out = intent(scene, a0, b0, { expiresTime: start + 1 });
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    const target = out.data.messageId;
    const elsewhere = receipt(scene, { local: a1, peer: b0, resolution: resolved(scene, a1.didId, b0), ordinal: 1, overrides: { ack: [target] } });
    const successorRoot = resolved(scene, a0.didId, b1);
    const bySuccessor = receipt(scene, { local: a0, peer: b1, resolution: successorRoot, ordinal: 2, fromPrior: await proof(peerKeys, b0, b1), overrides: { ack: [target] } });
    const unproven = receipt(scene, { local: a0, peer: b1, resolution: successorRoot, ordinal: 3, fromPrior: "not a JWT", overrides: { ack: [target] } });
    let vault = await fold(scene, keys);
    let outbound = outboundOf(vault, out);
    expect(outbound.ackWitnesses.map(({ source }) => source.event.eventId)).toEqual([bySuccessor.eventId]);
    expect(outbound).toMatchObject({ acknowledged: true, late: false, submitted: false, outcome: { status: "prepared" }, released: false });
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(true);
    expect(vault.continuity.witness(unproven.eventId).status).toBe("invalid");
    expect(vault.continuity.ackPath(outbound.channel!, vault.channels.sources.get(elsewhere.eventId)!.channel!)).toBe(false);
    expectSameOverEveryOrder(scene, vault.checks);

    const direct = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4, overrides: { ack: [target, target] } }, { at: "2026-09-13T00:00:01.000Z" });
    const recorded = acknowledged(scene, out, direct, b0, a0);
    const wrongWire = acknowledged(scene, out, direct, b0, a0, { ackWireMessageId: uuidv7() as WireMessageId });
    const wrongKey = acknowledged(scene, out, direct, b0, a0, { peerPublicKey: b1.publicKey });
    const ofElsewhere = acknowledged(scene, out, elsewhere, b0, a1);
    const ofNowhere = acknowledged(scene, out, direct, b0, a0, { ackMessageId: inboundMessageId(b1.did, a0.did, uuidv7() as WireMessageId) });
    vault = await fold(scene, keys);
    outbound = outboundOf(vault, out);
    expect(outbound.ackWitnesses.map(({ source }) => source.event.eventId)).toEqual([bySuccessor.eventId, direct.eventId]);
    expect(outbound.acknowledgements.map((a) => [a.event.eventId, a.status])).toEqual([
      [recorded.eventId, { status: "complete" }],
      [wrongWire.eventId, { status: "conflict", because: "the wire ID is not the carrier's" }],
      [wrongKey.eventId, { status: "conflict", because: "the peer key is not the carrier's" }],
      [ofElsewhere.eventId, { status: "pending", because: "the carrier it names does not acknowledge this message as a complete witness" }],
      [ofNowhere.eventId, { status: "pending", because: "the carrier it names is not here" }],
    ]);
    expect(outbound.late).toBe(false);
    expectSameOverEveryOrder(scene, vault.checks);

    const lateOut = intent(scene, a0, b0, { expiresTime: start });
    packageOf(scene, lateOut, { sender: a0.didId, recipient: b0, resolution: root });
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 5, overrides: { ack: [lateOut.data.messageId] } });
    const noExpiry = intent(scene, a0, b0);
    packageOf(scene, noExpiry, { sender: a0.didId, recipient: b0, resolution: root });
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 6, overrides: { ack: [noExpiry.data.messageId] } });
    vault = await fold(scene, keys);
    expect(outboundOf(vault, lateOut)).toMatchObject({ acknowledged: true, late: true });
    expect(outboundOf(vault, noExpiry)).toMatchObject({ acknowledged: true, late: false });
  });

  it("attributes a receipt to no outbound whose package is not here: the acknowledgement waits for the package, and conflicts with one that contradicts the intent", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const unpackaged = intent(scene, a0, b0, { expiresTime: 1 });
    const unpackagedCarrier = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { ack: [unpackaged.data.messageId] } });
    const unpackagedRecord = acknowledged(scene, unpackaged, unpackagedCarrier, b0, a0);
    const waiting = intent(scene, a0, b0);
    packageOf(scene, waiting, { sender: a0.didId, recipient: b0, resolution: root, overrides: { peerResolutionEventId: uuidv7() as EventId as never } });
    const waitingCarrier = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { ack: [waiting.data.messageId] } });
    acknowledged(scene, waiting, waitingCarrier, b0, a0);
    const contradicted = intent(scene, a0, b0);
    packageOf(scene, contradicted, { sender: a0.didId, recipient: b0, resolution: root, overrides: { intentHash: OTHER_HASH } });
    const contradictedCarrier = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 3, overrides: { ack: [contradicted.data.messageId] } });
    acknowledged(scene, contradicted, contradictedCarrier, b0, a0);
    let vault = await fold(scene, keys);
    expect(outboundOf(vault, unpackaged)).toMatchObject({ ackWitnesses: [], acknowledged: false, late: false, acknowledgements: [{ status: { status: "pending", because: "no package is prepared here" } }], work: { kind: "prepare" } });
    expect(outboundOf(vault, waiting)).toMatchObject({ acknowledged: false, acknowledgements: [{ status: { status: "pending", because: "the resolution it names is not here" } }] });
    expect(outboundOf(vault, contradicted)).toMatchObject({ acknowledged: false, acknowledgements: [{ status: { status: "conflict", because: "the package contradicts the intent: the package's intent hash is not the intent's" } }] });
    expectSameOverEveryOrder(scene, vault.checks);

    packageOf(scene, unpackaged, { sender: a0.didId, recipient: b0, resolution: root });
    vault = await fold(scene, keys);
    expect(outboundOf(vault, unpackaged)).toMatchObject({ ackWitnesses: [{ source: { event: unpackagedCarrier } }], acknowledged: true, late: true, acknowledgements: [{ event: unpackagedRecord, status: { status: "complete" } }], submitted: false, released: false });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("checks an automatic intent against its source's input and the operation's rules, for good when they contradict it and pending while evidence is missing", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b2 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const source = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { pleaseAck: [""], thid: "thread", createdTime: 1_700_000_000 } });
    const ack = pureAck(scene, a0, b0, source);
    const wrongExecution = automatic(scene, a0, b0, source, executionId(b0.did, a1.did, source.data.wireMessageId), PURE_ACK, { bodyCid: EMPTY_CONTENT_CID, ack: [source.data.wireMessageId], thid: "thread", createdTime: 1_700_000_000 });
    const misshapen = pureAck(scene, a0, b0, source, { pleaseAck: [""] });
    const noTargets = pureAck(scene, a0, b0, source, { ack: [] });
    const rethreaded = pureAck(scene, a0, b0, source, { thid: source.data.wireMessageId });
    const elsewhere = pureAck(scene, a1, b0, source, {}, a0);
    const unknown = automatic(scene, a0, b0, source, inputOf(source, b0, a0), "https://example.com/op#reply");
    const missing = automatic(scene, a0, b0, source, executionId(b0.did, a0.did, uuidv7() as WireMessageId), PURE_ACK, { sourceEventId: uuidv7() as EventId as never, bodyCid: EMPTY_CONTENT_CID, ack: [source.data.wireMessageId] });
    const ping = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { msgType: PING_TYPE, pthid: "parent", expiresTime: 1_900_000_000 } });
    const pong = automatic(scene, a0, b0, ping, inputOf(ping, b0, a0), PING_RESPONSE_EFFECT, { msgType: PING_RESPONSE_TYPE, bodyCid: EMPTY_CONTENT_CID, thid: ping.data.wireMessageId, pthid: "parent", expiresTime: 1_900_000_000 });
    const pongOfNoPing = automatic(scene, a0, b0, source, inputOf(source, b0, a0), PING_RESPONSE_EFFECT, { msgType: PING_RESPONSE_TYPE, bodyCid: EMPTY_CONTENT_CID, thid: source.data.wireMessageId, createdTime: 1_700_000_000 });
    const toOtherPeer = automatic(scene, a0, b1, source, inputOf(source, b0, a0), PURE_ACK, { bodyCid: EMPTY_CONTENT_CID, ack: [source.data.wireMessageId], thid: "thread", createdTime: 1_700_000_000 });
    const variants = [ack, wrongExecution, misshapen, noTargets, rethreaded, elsewhere, toOtherPeer];
    let vault = await fold(scene, keys);
    const effects = (events: VaultEvent<"message.out">[]) => events.map((event) => variant(scene, vault.checks, event, variants).effect);
    expect(effects([ack, pong])).toEqual([{ status: "complete" }, { status: "complete" }]);
    expect(variant(scene, vault.checks, ack, variants).work).toEqual({ kind: "prepare" });
    expect(effects([wrongExecution, misshapen, noTargets, rethreaded, elsewhere, toOtherPeer, pongOfNoPing])).toEqual([
      { status: "conflict", because: `the execution ID is not the one the source's input derives, ${inputOf(source, b0, a0)}` },
      { status: "conflict", because: "a pure ACK requests no ACK and does not expire" },
      { status: "conflict", because: "a pure ACK names at least one target" },
      { status: "conflict", because: "a pure ACK keeps the carrier's thread and creation time" },
      { status: "pending", because: "the output's channel does not continue the source's yet: no verified rotation to the output's sender is here" },
      { status: "conflict", because: "the output's peer is not the source's" },
      { status: "conflict", because: "a Ping reply answers a Ping" },
    ]);
    expect(variant(scene, vault.checks, misshapen, variants)).toMatchObject({ outcome: { status: "conflict", because: "a pure ACK requests no ACK and does not expire" }, work: { kind: "none" } });
    expect(outboundOf(vault, ack)).toMatchObject({ intent: { status: "conflict" }, effect: { status: "complete" }, outcome: { status: "conflict", because: "the intents recorded under one message ID disagree" } });
    expect(effects([unknown, missing])).toEqual([
      { status: "pending", because: "no operation here produces https://example.com/op#reply" },
      { status: "pending", because: "the source it names is not here" },
    ]);
    expect(outboundOf(vault, unknown).work).toEqual({ kind: "none", because: "no operation here produces https://example.com/op#reply" });
    expect(outboundOf(foldVault(scene.set(), vault.checks, { effectTypes: ["https://example.com/op#reply"] }), unknown).effect).toEqual({ status: "complete" });
    expectSameOverEveryOrder(scene, vault.checks);

    const carried = receipt(scene, { local: a0, peer: b1, resolution: resolved(scene, a0.didId, b1), ordinal: 3, fromPrior: await proof(peerKeys, b2, b1), overrides: { pleaseAck: [""] } });
    const ackOfCarried = pureAck(scene, a0, b1, carried);
    vault = await fold(scene, keys);
    expect(outboundOf(vault, ackOfCarried).effect).toEqual({ status: "complete" });
    expect(vault.continuity.witness(carried.eventId).status).toBe("complete");

    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4, wire: source.data.wireMessageId, overrides: { intentHash: OTHER_HASH, pleaseAck: [""], thid: "thread", createdTime: 1_700_000_000 } });
    vault = await fold(scene, keys);
    expect(variant(scene, vault.checks, ack, variants).effect).toEqual({ status: "conflict", because: "the source's input is in conflict: 2 intents are authenticated for one input" });
    expect(outboundOf(vault, pong).effect).toEqual({ status: "complete" });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("checks a pure ACK's frozen targets against the source's request and the inputs they name, waiting for an input not here and never rebuilding the array", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const silent = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const ackOfSilent = pureAck(scene, a0, b0, silent);
    const earlier = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2 });
    const elsewhere = receipt(scene, { local: a1, peer: b0, resolution: resolved(scene, a1.didId, b0), ordinal: 3 });
    const unseen = uuidv7() as WireMessageId;
    const ambiguous = uuidv7() as WireMessageId;
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4, wire: ambiguous });
    const successorRoot = resolved(scene, a0.didId, b1);
    receipt(scene, { local: a0, peer: b1, resolution: successorRoot, ordinal: 5, wire: ambiguous, fromPrior: await proof(peerKeys, b0, b1) });
    const requests = ["", earlier.data.wireMessageId, elsewhere.data.wireMessageId, unseen, ambiguous];
    const source = receipt(scene, { local: a0, peer: b1, resolution: successorRoot, ordinal: 6, fromPrior: await proof(peerKeys, b0, b1), overrides: { pleaseAck: requests } });
    const own = pureAck(scene, a0, b1, source);
    const ofEarlier = pureAck(scene, a0, b1, source, { ack: [earlier.data.wireMessageId, source.data.wireMessageId] });
    const unrequested = pureAck(scene, a0, b1, source, { ack: [source.data.wireMessageId, silent.data.wireMessageId] });
    const ofElsewhere = pureAck(scene, a0, b1, source, { ack: [elsewhere.data.wireMessageId] });
    const ofUnseen = pureAck(scene, a0, b1, source, { ack: [unseen] });
    const ofAmbiguous = pureAck(scene, a0, b1, source, { ack: [ambiguous] });
    const variants = [own, ofEarlier, unrequested, ofElsewhere, ofUnseen, ofAmbiguous];
    let vault = await fold(scene, keys);
    expect(outboundOf(vault, ackOfSilent).effect).toEqual({ status: "conflict", because: "the source requests no ACK" });
    expect(vault.outbound.ackTargets(source.eventId)).toEqual([earlier.data.wireMessageId, source.data.wireMessageId]);
    expect(variants.map((event) => variant(scene, vault.checks, event, variants).effect)).toEqual([
      { status: "complete" },
      { status: "complete" },
      { status: "conflict", because: `the source does not request an ACK of ${silent.data.wireMessageId}` },
      { status: "pending", because: `no input of the channel or a verified predecessor has wire ID ${elsewhere.data.wireMessageId}` },
      { status: "pending", because: `no input of the channel or a verified predecessor has wire ID ${unseen}` },
      { status: "conflict", because: `wire ID ${ambiguous} names 2 inputs` },
    ]);
    expect(variant(scene, vault.checks, ofUnseen, variants).work).toEqual({ kind: "none", because: `no input of the channel or a verified predecessor has wire ID ${unseen}` });
    expectSameOverEveryOrder(scene, vault.checks);

    const unplaced = new Scene();
    unplaced.events.push(...scene.events.filter((event) => event.type !== "did.created" || event.data.didId !== a0.didId));
    const partial = foldVault(unplaced.set(), vault.checks);
    expect(partial.channels.sources.get(source.eventId)!.channel).toBeNull();
    expect(variant(unplaced, vault.checks, own, variants)).toMatchObject({ effect: { status: "pending", because: expect.stringMatching(/^the source is no complete witness yet: /) }, work: { kind: "none", because: "no communication DID here records the sender" } });
    expect(variant(unplaced, vault.checks, unrequested, variants).effect).toEqual({ status: "conflict", because: `the source does not request an ACK of ${silent.data.wireMessageId}` });
    expectOrderFree(unplaced.events, (set) => picture(foldVault(set, vault.checks)));

    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 7, wire: unseen });
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { intentHash: OTHER_HASH } });
    vault = await fold(scene, keys);
    expect(variant(scene, vault.checks, ofUnseen, variants)).toMatchObject({ effect: { status: "complete" }, work: { kind: "prepare" } });
    expect(variant(scene, vault.checks, ofEarlier, variants).effect).toEqual({ status: "conflict", because: `the input with wire ID ${earlier.data.wireMessageId} is under a receipt conflict` });
    expect(vault.outbound.ackTargets(source.eventId)).toEqual([source.data.wireMessageId, unseen]);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("lets an automatic output continue its source's channel at a verified local successor, and a triggered notification follow its decision", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const source = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { pleaseAck: [""] } });
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const ackAtSuccessor = pureAck(scene, a1, b0, source, {}, a0);
    const ping = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 3, overrides: { msgType: PING_TYPE } });
    const pongAtSuccessor = automatic(scene, a1, b0, ping, inputOf(ping, b0, a0), PING_RESPONSE_EFFECT, { msgType: PING_RESPONSE_TYPE, bodyCid: EMPTY_CONTENT_CID, thid: ping.data.wireMessageId });
    const notification = automatic(scene, a1, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    const fromPredecessor = automatic(scene, a0, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    const manualForm = intent(scene, a1, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: ref(decision) });
    const noRequest = automatic(scene, a1, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    const notNotification = automatic(scene, a1, b0, source, inputOf(source, b0, a0), PURE_ACK, { bodyCid: EMPTY_CONTENT_CID, ack: [source.data.wireMessageId], thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    const noRotation = automatic(scene, a1, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: source.data.wireMessageId });
    const variants = [ackAtSuccessor, notification, fromPredecessor, manualForm, noRequest, notNotification, noRotation];
    let vault = await fold(scene, keys);
    expect(vault.continuity.ackPath({ localDid: a0.did, peerDid: b0.did }, { localDid: a1.did, peerDid: b0.did })).toBe(true);
    expect(variant(scene, vault.checks, ackAtSuccessor, variants).effect).toEqual({ status: "complete" });
    expect(outboundOf(vault, pongAtSuccessor).effect).toEqual({ status: "complete" });
    expect(variant(scene, vault.checks, notification, variants)).toMatchObject({ effect: { status: "complete" }, work: { kind: "prepare" } });
    expect([fromPredecessor, manualForm, noRequest, notNotification, noRotation].map((event) => variant(scene, vault.checks, event, variants).effect)).toEqual([
      { status: "conflict", because: "a notification is sent from the decision's successor" },
      { status: "conflict", because: "a notification is triggered exactly as its decision was, by the same source" },
      { status: "conflict", because: "a notification requests its own receipt, carries no ACK and does not expire" },
      { status: "conflict", because: "an intent naming a rotation is a rotation notification" },
      { status: "conflict", because: "a rotation notification names its rotation" },
    ]);
    expect(vault.outbound.notificationFor(decision.eventId)).toEqual({ status: "conflict", messageIds: [manualForm.data.messageId, notification.data.messageId, notNotification.data.messageId].sort() });
    expect(outboundOf(vault, notification)).toMatchObject({ intent: { status: "conflict" }, work: { kind: "none" } });
    expectSameOverEveryOrder(scene, vault.checks);

    const withoutSource = new Scene();
    withoutSource.events.push(...scene.events.filter((event) => event.eventId !== source.eventId && (event === notification || !variants.includes(event as VaultEvent<"message.out">))));
    expect(outboundOf(foldVault(withoutSource.set(), vault.checks), notification)).toMatchObject({ effect: { status: "pending", because: "the source it names is not here" }, work: { kind: "none" } });

    const undecided = new Scene();
    undecided.events.push(...scene.events.filter((event) => event !== decision && (event === ackAtSuccessor || !variants.includes(event as VaultEvent<"message.out">))));
    const waiting = foldVault(undecided.set(), vault.checks);
    const noPath = { status: "pending", because: "the output's channel does not continue the source's yet: no verified rotation to the output's sender is here" };
    expect(outboundOf(waiting, ackAtSuccessor)).toMatchObject({ effect: noPath, outcome: { status: "queued" }, work: { kind: "none", because: noPath.because } });
    expect(outboundOf(waiting, pongAtSuccessor).effect).toEqual(noPath);
    expectOrderFree(undecided.events, (set) => picture(foldVault(set, vault.checks)));

    const sidelong = new Scene();
    sidelong.events.push(...undecided.events);
    const invalid = await rotation(sidelong, keys, { from: a0, peer: b0, to: a1, source, fromPrior: await proof(keys, a0, a2) });
    let beside = await fold(sidelong, keys);
    expect(beside.continuity.status(invalid.eventId).status).toBe("invalid");
    expect(beside.continuity.conflicts).toEqual([]);
    expect(outboundOf(beside, ackAtSuccessor).effect).toEqual(noPath);
    expect(outboundOf(beside, pongAtSuccessor).effect).toEqual(noPath);
    const trigger = receipt(new Scene(), { local: a0, peer: b0, resolution: root, ordinal: 4 });
    await rotation(sidelong, keys, { from: a0, peer: b0, to: a1, source: trigger });
    beside = await fold(sidelong, keys);
    const unsourced = { status: "pending", because: "the output's channel does not continue the source's yet: the source it names is not here" };
    expect(outboundOf(beside, ackAtSuccessor)).toMatchObject({ effect: unsourced, work: { kind: "none", because: unsourced.because } });
    expect(outboundOf(beside, pongAtSuccessor).effect).toEqual(unsourced);
    sidelong.events.push(trigger);
    beside = await fold(sidelong, keys);
    expect(outboundOf(beside, ackAtSuccessor)).toMatchObject({ effect: { status: "complete" }, work: { kind: "prepare" } });
    expect(outboundOf(beside, pongAtSuccessor).effect).toEqual({ status: "complete" });
    expectOrderFree(sidelong.events, (set) => picture(foldVault(set, beside.checks)));

    const forked = new Scene();
    forked.events.push(...scene.events.filter((event) => event === ackAtSuccessor || !variants.includes(event as VaultEvent<"message.out">)));
    receipt(forked, { local: a2, peer: b0, resolution: resolved(forked, a2.didId, b0), ordinal: 5 });
    await rotation(forked, keys, { from: a0, peer: b0, to: a2, source: null });
    const split = await fold(forked, keys);
    expect(split.continuity.conflicted({ localDid: a0.did, peerDid: b0.did })).toBe(true);
    const inConflict = { status: "conflict", because: "the output's channel does not continue the source's: the continuity between them is in conflict" };
    expect(outboundOf(split, ackAtSuccessor)).toMatchObject({ effect: inConflict, outcome: { status: "conflict" }, work: { kind: "none" } });
    expect(outboundOf(split, pongAtSuccessor).effect).toEqual(inConflict);

    receipt(scene, { local: a1, peer: b0, resolution: resolved(scene, a1.didId, b0), ordinal: 2 });
    const manual = await rotation(scene, keys, { from: a1, peer: b0, to: a2, source: null });
    const announced = intent(scene, a2, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: ref(manual) });
    const threaded = intent(scene, a2, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: "thread", rotationEventId: ref(manual) });
    const unknownDecision = intent(scene, a2, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: uuidv7() as EventId as never });
    vault = await fold(scene, keys);
    expect(vault.continuity.status(manual.eventId)).toEqual({ status: "verified" });
    expect(vault.outbound.notificationFor(manual.eventId)).toEqual({ status: "conflict", messageIds: [announced.data.messageId, threaded.data.messageId].sort() });
    expect(outboundOf(vault, announced)).toMatchObject({ effect: { status: "conflict", because: "another notification is selected for the rotation" }, work: { kind: "none", because: "another notification is selected for the rotation" } });
    expect(outboundOf(vault, threaded).effect).toEqual({ status: "conflict", because: "a manual notification has no thread and no creation time" });
    expect(outboundOf(vault, unknownDecision).effect).toEqual({ status: "pending", because: "the rotation it names is not here" });
    expect(vault.outbound.notificationFor(uuidv7() as EventId)).toEqual({ status: "none" });

    const alone = new Scene();
    alone.events.push(...scene.events.filter((event) => event.eventId !== threaded.eventId && event.eventId !== unknownDecision.eventId));
    const settled = foldVault(alone.set(), vault.checks);
    expect(settled.outbound.notificationFor(manual.eventId)).toEqual({ status: "selected", messageId: announced.data.messageId });
    expect(outboundOf(settled, announced)).toMatchObject({ effect: { status: "complete" }, work: { kind: "prepare" } });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("stops the work of two well-formed notifications selected for one rotation, keeps a submitted one submitted, and waits while the rotation's predecessor is unconfirmed", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const source = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { pleaseAck: [""] } });
    const confirmed = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: null });
    const first = intent(scene, a1, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: ref(confirmed) });
    const pkg = packageOf(scene, first, { sender: a1.didId, recipient: b0, resolution: resolved(scene, a1.didId, b0) });
    submitted(scene, first, pkg);
    const second = intent(scene, a1, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: ref(confirmed) });
    const unconfirmed = await rotation(scene, keys, { from: a1, peer: b0, to: a2, source: null });
    const early = intent(scene, a2, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: ref(unconfirmed) });
    const ackFromEarly = pureAck(scene, a2, b0, source, {}, a0);
    const vault = await fold(scene, keys);
    const because = "another notification is selected for the rotation";
    expect(outboundOf(vault, first)).toMatchObject({ effect: { status: "conflict", because }, submitted: true, outcome: { status: "conflict", because }, work: { kind: "none", because }, released: true });
    expect(outboundOf(vault, second)).toMatchObject({ effect: { status: "conflict", because }, outcome: { status: "conflict", because }, work: { kind: "none", because } });
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(false);
    expect(vault.continuity.status(unconfirmed.eventId)).toMatchObject({ status: "pending-history" });
    expect(outboundOf(vault, early)).toMatchObject({
      effect: { status: "pending", because: "the rotation it names is not verified yet: no complete source from the peer or a verified successor is addressed to the predecessor" },
      work: { kind: "none", because: "the rotation it names is not verified yet: no complete source from the peer or a verified successor is addressed to the predecessor" },
    });
    expect(outboundOf(vault, ackFromEarly).effect).toEqual({ status: "pending", because: "the output's channel does not continue the source's yet: no complete source from the peer or a verified successor is addressed to the predecessor" });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("needs no work while the sender is not live, the channel is blocked or in conflicted continuity, the message is erased, a submission names a package not here, or the sender is unknown here", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1, b2, b3 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const retired = intent(scene, a0, b0);
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    const denied = intent(scene, a1, b0);
    blocked(scene, a1, b0);
    const erasedOut = intent(scene, a2, b0);
    const pkg = packageOf(scene, erasedOut, { sender: a2.didId, recipient: b0, resolution: resolved(scene, a2.didId, b0) });
    scene.add("message.erased", { messageId: erasedOut.data.messageId, dropCids: [erasedOut.data.bodyCid], because: "user" });
    const unknownSender = intent(scene, { didId: uuidv7() as DidId, did: a0.did, longFormDid: a0.longFormDid }, b0);
    const toSelf = intent(scene, a2, { did: a2.did } as Peer);
    const restored = intent(scene, a2, b0);
    submitted(scene, restored, packageOf(new Scene(), restored, { sender: a2.didId, recipient: b0, resolution: root }));
    const sidelined = intent(scene, a2, b0);
    const sidelinedRoot = resolved(scene, a2.didId, b0);
    const sidelinedPackage = packageOf(scene, sidelined, { sender: a2.didId, recipient: b0, resolution: sidelinedRoot });
    const elsewhere = packageOf(new Scene(), sidelined, { sender: a2.didId, recipient: b0, resolution: sidelinedRoot });
    submitted(scene, sidelined, elsewhere);
    const forkedRoot = resolved(scene, a2.didId, b1);
    const forked = intent(scene, a2, b1);
    const forkedPackage = packageOf(scene, forked, { sender: a2.didId, recipient: b1, resolution: forkedRoot });
    const unprepared = intent(scene, a2, b1);
    receipt(scene, { local: a2, peer: b2, resolution: resolved(scene, a2.didId, b2), ordinal: 1, fromPrior: await proof(peerKeys, b1, b2) });
    receipt(scene, { local: a2, peer: b3, resolution: resolved(scene, a2.didId, b3), ordinal: 2, fromPrior: await proof(peerKeys, b1, b3) });
    const vault = await fold(scene, keys);
    expect(outboundOf(vault, retired).work).toEqual({ kind: "none", because: "the sender is not live: retired: done" });
    expect(outboundOf(vault, denied).work).toEqual({ kind: "none", because: "the channel is blocked" });
    expect(outboundOf(vault, erasedOut)).toMatchObject({ erased: true, outcome: { status: "prepared" }, work: { kind: "none", because: "erased" } });
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(true);
    expect(outboundOf(vault, unknownSender)).toMatchObject({ sender: null, channel: null, outcome: { status: "queued" }, work: { kind: "none", because: "no communication DID here records the sender" } });
    expect(outboundOf(vault, toSelf)).toMatchObject({ channel: null, outcome: { status: "conflict", because: "the recipient is the sender's own DID" } });
    expect(outboundOf(vault, restored)).toMatchObject({ packages: [], submissions: [{ status: { status: "pending", because: "the package it names is not here" } }], submitted: false, outcome: { status: "queued" }, work: { kind: "none", because: "a submission names a package that is not here" }, released: false });
    expect(outboundOf(vault, sidelined)).toMatchObject({ package: { event: sidelinedPackage, status: { status: "complete" } }, submitted: false, outcome: { status: "prepared" }, work: { kind: "none", because: "a submission names a package that is not here" }, released: false });
    expect(vault.continuity.conflicted({ localDid: a2.did, peerDid: b1.did })).toBe(true);
    expect(outboundOf(vault, forked)).toMatchObject({ package: { event: forkedPackage, status: { status: "complete" } }, outcome: { status: "prepared" }, work: { kind: "none", because: "the channel's continuity is in conflict" } });
    expect(outboundOf(vault, unprepared)).toMatchObject({ outcome: { status: "queued" }, work: { kind: "none", because: "the channel's continuity is in conflict" } });
    expect(root.data.did).toBe(b0.did);

    const unseeded = await fold(scene, null);
    expect(outboundOf(unseeded, denied).work).toMatchObject({ kind: "none", because: expect.stringMatching(/^the sender is not live: /) });
    expectSameOverEveryOrder(scene, vault.checks);

    scene.events.push(elsewhere);
    const arrived = foldVault(scene.set(), vault.checks);
    expect(outboundOf(arrived, sidelined)).toMatchObject({ package: null, submitted: true, outcome: { status: "conflict", because: "2 packages are prepared for one message" }, work: { kind: "none" }, released: true });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("triggers no notification from a control input: an Empty, a ping-response or a problem report may be acknowledged, never answered by a rotation", async () => {
    const { scene, keys, a0, a1, b1, b2, b3 } = await vaults();
    const controls = [
      { peer: b1, msgType: EMPTY_MESSAGE_TYPE, kind: "empty" },
      { peer: b2, msgType: PING_RESPONSE_TYPE, kind: "ping-response" },
      { peer: b3, msgType: PROBLEM_REPORT_TYPE, kind: "error" },
    ];
    const notifications: { notification: VaultEvent<"message.out">; decision: VaultEvent<"did.rotationSelected">; kind: string }[] = [];
    for (const [ordinal, { peer, msgType, kind }] of controls.entries()) {
      const source = receipt(scene, { local: a0, peer, resolution: resolved(scene, a0.didId, peer), ordinal: ordinal + 1, overrides: { msgType, pleaseAck: [""] } });
      const decision = await rotation(scene, keys, { from: a0, peer, to: a1, source });
      const notification = automatic(scene, a1, peer, source, inputOf(source, peer, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: source.data.wireMessageId, rotationEventId: ref(decision) });
      notifications.push({ notification, decision, kind });
    }
    const vault = await fold(scene, keys);
    for (const { notification, decision, kind } of notifications) {
      expect(vault.continuity.status(decision.eventId)).toEqual({ status: "verified" });
      const because = `a control input triggers no notification: the source is ${kind}`;
      expect(outboundOf(vault, notification)).toMatchObject({ effect: { status: "conflict", because }, outcome: { status: "conflict", because }, work: { kind: "none", because } });
    }
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("records an acknowledgement against any one complete carrier under the peer's several authorized keys, lending no field across them", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const peer = await peerAgreeingOnBoth(peerKeys, PEER_ID3, b1.publicKey);
    const root = resolved(scene, a0.didId, peer);
    const out = intent(scene, a0, peer);
    packageOf(scene, out, { sender: a0.didId, recipient: peer, resolution: root });
    const wire = uuidv7();
    const underFirst = receipt(scene, { local: a0, peer, resolution: root, ordinal: 1, wire, overrides: { ack: [out.data.messageId] } });
    const secondRoot = resolved(scene, a0.didId, peer, { peerPublicKey: b1.publicKey });
    const underSecond = receipt(scene, { local: a0, peer, resolution: secondRoot, ordinal: 2, wire, overrides: { ack: [out.data.messageId] } });
    const ofSecond = acknowledged(scene, out, underSecond, peer, a0, { peerPublicKey: b1.publicKey });
    const ofFirst = acknowledged(scene, out, underFirst, peer, a0);
    const ofNeither = acknowledged(scene, out, underFirst, peer, a0, { peerPublicKey: b0.publicKey });
    const ofOtherWire = acknowledged(scene, out, underSecond, peer, a0, { peerPublicKey: b1.publicKey, ackWireMessageId: uuidv7() as WireMessageId });
    const vault = await fold(scene, keys);
    expect(underSecond.data.messageId).toBe(underFirst.data.messageId);
    expect(outboundOf(vault, out)).toMatchObject({ ackWitnesses: [{ source: { event: underFirst } }, { source: { event: underSecond } }], acknowledged: true });
    const none = { status: "conflict", because: "none of the 2 carriers with that message ID has the record's wire ID, local key and peer key" };
    expect(outboundOf(vault, out).acknowledgements.map((a) => [a.event.eventId, a.status])).toEqual([
      [ofSecond.eventId, { status: "complete" }],
      [ofFirst.eventId, { status: "complete" }],
      [ofNeither.eventId, none],
      [ofOtherWire.eventId, none],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    const alone = new Scene();
    alone.events.push(...scene.events.filter((event) => event !== underFirst));
    const second = outboundOf(foldVault(alone.set(), vault.checks), out);
    const otherKey = { status: "conflict", because: "the peer key is not the carrier's" };
    expect(second.acknowledgements.map((a) => a.status)).toEqual([{ status: "complete" }, otherKey, otherKey, { status: "conflict", because: "the wire ID is not the carrier's" }]);

    const unresolved = new Scene();
    unresolved.events.push(...scene.events.filter((event) => event !== secondRoot));
    const short = outboundOf(foldVault(unresolved.set(), vault.checks), out);
    const unproven = { status: "pending", because: "the carrier it names is no complete witness yet: the resolution it names is not here" };
    expect(short).toMatchObject({ ackWitnesses: [{ source: { event: underFirst } }], acknowledged: true, submitted: false, released: false });
    expect(short.acknowledgements.map((a) => a.status)).toEqual([unproven, { status: "complete" }, unproven, { status: "conflict", because: "the wire ID is not the carrier's" }]);
    expectOrderFree(unresolved.events, (set) => picture(foldVault(set, vault.checks)));
  });

  it("names a carrier's ACK targets: the established inputs its request names in its channel or a verified predecessor, unambiguous, not under a receipt conflict, in first-receipt order", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const successorRoot = resolved(scene, a0.didId, b1);
    const earlier = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 3 });
    const earliest = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const elsewhere = receipt(scene, { local: a1, peer: b0, resolution: resolved(scene, a1.didId, b0), ordinal: 2 });
    const ambiguous = uuidv7();
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4, wire: ambiguous });
    receipt(scene, { local: a0, peer: b1, resolution: successorRoot, ordinal: 5, wire: ambiguous, fromPrior: await proof(peerKeys, b0, b1) });
    const disputed = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 6 });
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 6, overrides: { intentHash: OTHER_HASH } });
    const requests = ["", earlier.data.wireMessageId, earliest.data.wireMessageId, elsewhere.data.wireMessageId, ambiguous, disputed.data.wireMessageId, uuidv7(), ""];
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: successorRoot, ordinal: 7, fromPrior: await proof(peerKeys, b0, b1), overrides: { pleaseAck: requests } });
    const unproven = receipt(scene, { local: a0, peer: b1, resolution: successorRoot, ordinal: 8, fromPrior: "not a JWT", overrides: { pleaseAck: [""] } });
    const silent = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 9, overrides: { pleaseAck: [] } });
    const itself = receipt(scene, { local: a0, peer: b1, resolution: successorRoot, ordinal: 10, wire: ambiguous, fromPrior: await proof(peerKeys, b0, b1), overrides: { pleaseAck: [""] } });
    const vault = await fold(scene, keys);
    expect(vault.outbound.ackTargets(carrier.eventId)).toEqual([earliest.data.wireMessageId, earlier.data.wireMessageId, carrier.data.wireMessageId]);
    expect(vault.outbound.ackTargets(itself.eventId)).toEqual([ambiguous]);
    expect(vault.outbound.ackTargets(unproven.eventId)).toEqual([]);
    expect(vault.outbound.ackTargets(silent.eventId)).toEqual([]);
    expect(vault.outbound.ackTargets(earliest.eventId)).toEqual([]);
    expect(vault.outbound.ackTargets(uuidv7() as EventId)).toEqual([]);
    expect(vault.channels.receipts.affected.has(disputed.data.messageId)).toBe(true);
    expectOrderFree(scene.events, (set) => foldVault(set, vault.checks).outbound.ackTargets(carrier.eventId));
  });

  it("correlates a ping-response by its thread and a problem report by its parent thread to an outbound the carrier may answer", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0, { msgType: PING_TYPE });
    const pong = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { msgType: PING_RESPONSE_TYPE, thid: out.data.messageId } });
    const report = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { msgType: PROBLEM_REPORT_TYPE, pthid: out.data.messageId, bodyCid: cidOf("problem") } });
    const elsewhere = receipt(scene, { local: a1, peer: b0, resolution: resolved(scene, a1.didId, b0), ordinal: 3, overrides: { msgType: PING_RESPONSE_TYPE, thid: out.data.messageId } });
    const unthreaded = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4, overrides: { msgType: PING_RESPONSE_TYPE, thid: uuidv7() } });
    const application = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 5, overrides: { thid: out.data.messageId } });
    const vault = await fold(scene, keys);
    expect(vault.outbound.inReplyTo(pong.eventId)?.messageId).toBe(out.data.messageId);
    expect(vault.outbound.inReplyTo(report.eventId)?.messageId).toBe(out.data.messageId);
    for (const other of [elsewhere, unthreaded, application]) expect(vault.outbound.inReplyTo(other.eventId)).toBeNull();
    expect(vault.outbound.inReplyTo(uuidv7() as EventId)).toBeNull();
  });
});
