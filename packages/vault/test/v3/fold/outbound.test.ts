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
  didKeyName,
  executionId,
  foldVault,
  foldVaultChecked,
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
import { PURE_ACK, automatic, blocked, intent, noObjects, packageOf, proof, receipt, ref, resolved, rotation, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null) => foldVaultChecked(scene.set(), keys, noObjects);

const OTHER_HASH = "Amqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA" as MessageHash;

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
    expect(outbound).toMatchObject({ submitted: false, outcome: { status: "prepared" }, work: { kind: "none", because: "the resolution it names is not here" }, released: false });
    expect(vault.held.has(unresolved.data.envelopeCid)).toBe(true);
    expect(elsewhere.data.messageId).toBe(waiting.data.messageId);

    const unseeded = await fold(scene, null);
    expect(outboundOf(unseeded, out).packages.map((p) => p.status)).toEqual([{ status: "complete" }, { status: "complete" }]);
    expect(outboundOf(unseeded, out).work).toEqual({ kind: "none", because: "2 packages are prepared for one message" });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("keeps a complete submission whatever is imported later, and keeps the envelopes released", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    const pkg = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    submitted(scene, out, pkg);
    const competing = packageOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root });
    scene.add("message.out", { ...out.data, intentHash: OTHER_HASH });
    const vault = await fold(scene, keys);
    const outbound = outboundOf(vault, out);
    expect(outbound.intent).toEqual({ status: "conflict", because: "the intents recorded under one message ID disagree" });
    expect(outbound.packages.map((p) => p.status)).toEqual([
      { status: "pending", because: "the intent is not consistent" },
      { status: "pending", because: "the intent is not consistent" },
    ]);
    expect(outbound).toMatchObject({ submitted: false, outcome: { status: "conflict" }, released: false });
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(true);

    const agreed = new Scene();
    agreed.events.push(...scene.events.filter((event) => event.type !== "message.out" || event.eventId === out.eventId));
    const settled = foldVault(agreed.set(), vault.checks);
    const complete = outboundOf(settled, out);
    expect(complete).toMatchObject({ submitted: true, package: null, outcome: { status: "conflict", because: "2 packages are prepared for one message" }, work: { kind: "none" }, released: true });
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
    const ofNowhere = acknowledged(scene, out, direct, b0, a0, { ackMessageId: bySuccessor.data.messageId.replace(/^./, "f") as MessageId });
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
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 5, overrides: { ack: [lateOut.data.messageId] } });
    const noExpiry = intent(scene, a0, b0);
    receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 6, overrides: { ack: [noExpiry.data.messageId] } });
    vault = await fold(scene, keys);
    expect(outboundOf(vault, lateOut)).toMatchObject({ acknowledged: true, late: true });
    expect(outboundOf(vault, noExpiry)).toMatchObject({ acknowledged: true, late: false });
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
    const variants = [ack, wrongExecution, misshapen, noTargets, rethreaded, elsewhere];
    let vault = await fold(scene, keys);
    const effects = (events: VaultEvent<"message.out">[]) => events.map((event) => variant(scene, vault.checks, event, variants).effect);
    expect(effects([ack, pong])).toEqual([{ status: "complete" }, { status: "complete" }]);
    expect(variant(scene, vault.checks, ack, variants).work).toEqual({ kind: "prepare" });
    expect(effects([wrongExecution, misshapen, noTargets, rethreaded, elsewhere, pongOfNoPing])).toEqual([
      { status: "conflict", because: `the execution ID is not the one the source's input derives, ${inputOf(source, b0, a0)}` },
      { status: "conflict", because: "a pure ACK requests no ACK and does not expire" },
      { status: "conflict", because: "a pure ACK names at least one target" },
      { status: "conflict", because: "a pure ACK keeps the carrier's thread and creation time" },
      { status: "conflict", because: "the output's channel does not continue the source's" },
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

  it("lets an automatic output continue its source's channel at a verified local successor, and a triggered notification follow its decision", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const source = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { pleaseAck: [""] } });
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const ackAtSuccessor = pureAck(scene, a1, b0, source, {}, a0);
    const notification = automatic(scene, a1, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    const fromPredecessor = automatic(scene, a0, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    const manualForm = intent(scene, a1, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: ref(decision) });
    const noRequest = automatic(scene, a1, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    const notNotification = automatic(scene, a1, b0, source, inputOf(source, b0, a0), PURE_ACK, { bodyCid: EMPTY_CONTENT_CID, ack: [source.data.wireMessageId], thid: source.data.wireMessageId, rotationEventId: ref(decision) });
    const variants = [ackAtSuccessor, notification, fromPredecessor, noRequest, notNotification];
    let vault = await fold(scene, keys);
    expect(vault.continuity.ackPath({ localDid: a0.did, peerDid: b0.did }, { localDid: a1.did, peerDid: b0.did })).toBe(true);
    expect(variant(scene, vault.checks, ackAtSuccessor, variants).effect).toEqual({ status: "complete" });
    expect(variant(scene, vault.checks, notification, variants)).toMatchObject({ effect: { status: "complete" }, work: { kind: "prepare" } });
    expect([fromPredecessor, manualForm, noRequest, notNotification].map((event) => variant(scene, vault.checks, event, variants).effect)).toEqual([
      { status: "conflict", because: "a notification is sent from the decision's successor" },
      { status: "conflict", because: "a notification is triggered exactly as its decision was, by the same source" },
      { status: "conflict", because: "a notification requests its own receipt, carries no ACK and does not expire" },
      { status: "conflict", because: "an intent naming a rotation is a rotation notification" },
    ]);
    expect(vault.outbound.notificationFor(decision.eventId)).toEqual({ status: "conflict", messageIds: [manualForm.data.messageId, notification.data.messageId, notNotification.data.messageId].sort() });
    expectSameOverEveryOrder(scene, vault.checks);

    const manual = await rotation(scene, keys, { from: a1, peer: b0, to: a2, source: null });
    const announced = intent(scene, a2, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: ref(manual) });
    const threaded = intent(scene, a2, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: "thread", rotationEventId: ref(manual) });
    const unknownDecision = intent(scene, a2, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventId: uuidv7() as EventId as never });
    vault = await fold(scene, keys);
    expect(vault.outbound.notificationFor(manual.eventId)).toEqual({ status: "conflict", messageIds: [announced.data.messageId, threaded.data.messageId].sort() });
    expect(outboundOf(vault, announced).effect).toEqual({ status: "complete" });
    expect(outboundOf(vault, threaded).effect).toEqual({ status: "conflict", because: "a manual notification has no thread and no creation time" });
    expect(outboundOf(vault, unknownDecision).effect).toEqual({ status: "pending", because: "the rotation it names is not here" });
    expect(vault.outbound.notificationFor(uuidv7() as EventId)).toEqual({ status: "none" });

    const alone = new Scene();
    alone.events.push(...scene.events.filter((event) => event.eventId !== threaded.eventId && event.eventId !== unknownDecision.eventId));
    expect(foldVault(alone.set(), vault.checks).outbound.notificationFor(manual.eventId)).toEqual({ status: "selected", messageId: announced.data.messageId });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("needs no work while the sender is not live, the channel is blocked, the message is erased or the sender is unknown here", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
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
    const vault = await fold(scene, keys);
    expect(outboundOf(vault, retired).work).toEqual({ kind: "none", because: "the sender is not live: retired: done" });
    expect(outboundOf(vault, denied).work).toEqual({ kind: "none", because: "the channel is blocked" });
    expect(outboundOf(vault, erasedOut)).toMatchObject({ erased: true, outcome: { status: "prepared" }, work: { kind: "none", because: "erased" } });
    expect(vault.held.has(pkg.data.envelopeCid)).toBe(true);
    expect(outboundOf(vault, unknownSender)).toMatchObject({ sender: null, channel: null, outcome: { status: "queued" }, work: { kind: "none", because: "no communication DID here records the sender" } });
    expect(outboundOf(vault, toSelf)).toMatchObject({ channel: null, outcome: { status: "conflict", because: "the recipient is the sender's own DID" } });
    expect(root.data.did).toBe(b0.did);

    const unseeded = await fold(scene, null);
    expect(outboundOf(unseeded, denied).work).toMatchObject({ kind: "none", because: expect.stringMatching(/^the sender is not live: /) });
    expectSameOverEveryOrder(scene, vault.checks);
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
    const vault = await fold(scene, keys);
    expect(vault.outbound.ackTargets(carrier.eventId)).toEqual([earliest.data.wireMessageId, earlier.data.wireMessageId, carrier.data.wireMessageId]);
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
