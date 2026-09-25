import type { Cid, JsonObject } from "@estoc/event-store";
import { SignJWT, importJWK } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_METHOD,
  EMPTY_CONTENT_CID,
  EMPTY_MESSAGE_TYPE,
  PING_RESPONSE_TYPE,
  PROBLEM_REPORT_TYPE,
  anonymousMessageId,
  didKeyName,
  executionId,
  foldVault,
  foldVaultChecked,
  kindOf,
  type DidId,
  type Keys,
  type MessageHash,
  type ReadObject,
  type VaultChecks,
  type VaultFold,
  type VaultData,
  type WireMessageId,
} from "../../src/index.js";
import { AUTHOR, AUTHOR2, HASH, cidOf, expectOrderFree, type Scene, fakeEventCid } from "./helpers.js";
import { IAT, blocked, noObjects, proof, receipt, resolved, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);

const OTHER_HASH = "Amqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA" as MessageHash;

const readerOf = (objects: Map<Cid, Uint8Array>) => async (wanted: Cid) => objects.get(wanted) ?? null;

/** A proof under any header and claims, signed by the authentication key a seed derives for an entity. */
async function resign(keys: Keys, didId: DidId, header: Record<string, unknown>, payload: JsonObject): Promise<string> {
  const key = await keys.signing(didKeyName(didId, "authentication"));
  return new SignJWT(payload)
    .setProtectedHeader(header as never)
    .sign(await importJWK(key.privateJwk(), "EdDSA"));
}

type Observation = { local: Local; peer: Peer; ordinal: number; wire: string; hash?: MessageHash; fromPrior?: string; overrides?: Partial<VaultData["message.in"]>; author?: typeof AUTHOR };

/** An authenticated receipt under its own resolution, of the given wire and intent. */
const observe = (scene: Scene, o: Observation) =>
  receipt(
    scene,
    { local: o.local, peer: o.peer, resolution: resolved(scene, o.local.didId, o.peer), ordinal: o.ordinal, wire: o.wire, fromPrior: o.fromPrior ?? null, overrides: { intentHash: o.hash ?? (HASH as MessageHash), ...o.overrides } },
    { author: o.author ?? AUTHOR }
  );

/** The inbound fold as comparable data: every execution by its verdicts and members, the observations no execution places. */
function picture(vault: VaultFold) {
  const { inbound } = vault;
  return {
    executions: [...inbound.executions.values()].map((execution) => ({
      id: execution.id,
      messageId: execution.messageId,
      channel: execution.channel,
      members: execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness]),
      siblings: execution.siblings.map(({ event, standing }) => [event.cid, standing]),
      intentHash: execution.intentHash,
      kind: execution.kind,
      status: execution.status,
      firstReceiptKey: execution.firstReceiptKey,
      erased: execution.erased,
    })),
    anonymous: inbound.anonymous.map(({ event }) => event.cid),
    unplaced: inbound.unplaced.map(({ event, standing }) => [event.cid, standing]),
  };
}

const expectSameOverEveryOrder = (scene: Scene, checks: Required<VaultChecks>) => expectOrderFree(scene.events, (set) => picture(foldVault(set, checks)));

describe("an inbound input", () => {
  it("has one execution in its channel for every observation of it, in first-receipt order; another channel or wire ID is another input", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const wire = uuidv7();
    const later = observe(scene, { local: a0, peer: b0, ordinal: 2, wire, author: AUTHOR2 });
    const first = observe(scene, { local: a0, peer: b0, ordinal: 1, wire });
    const atA1 = observe(scene, { local: a1, peer: b0, ordinal: 3, wire });
    const fromB1 = observe(scene, { local: a0, peer: b1, ordinal: 4, wire });
    const otherWire = observe(scene, { local: a0, peer: b0, ordinal: 5, wire: uuidv7() });
    const vault = await fold(scene, keys);
    const { inbound } = vault;
    expect(inbound.executions.size).toBe(4);
    const execution = inbound.ofMessage(first.data.messageId)!;
    expect(execution).toMatchObject({
      id: executionId(b0.did, a0.did, wire as WireMessageId),
      messageId: first.data.messageId,
      channel: { localDid: a0.did, peerDid: b0.did },
      wireMessageId: wire,
      siblings: [],
      intentHash: HASH,
      kind: "application",
      status: { status: "complete" },
      firstReceiptKey: { ordinal: 1n, author: AUTHOR },
      erased: false,
    });
    expect(execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness])).toEqual([
      [first.cid, true, { status: "complete" }],
      [later.cid, true, { status: "complete" }],
    ]);
    expect(inbound.executions.get(execution.id)).toBe(execution);
    expect(inbound.ofSource(later.cid)).toBe(execution);
    for (const other of [atA1, fromB1, otherWire]) {
      const own = inbound.ofSource(other.cid)!;
      expect(own).not.toBe(execution);
      expect(own.members.map(({ source }) => source.event.cid)).toEqual([other.cid]);
      expect(own.status).toEqual({ status: "complete" });
    }
    expect(inbound.ofSource(atA1.cid)!.id).toBe(executionId(b0.did, a1.did, wire as WireMessageId));
    expect(inbound.ofSource(fromB1.cid)!.id).toBe(executionId(b1.did, a0.did, wire as WireMessageId));
    expect(inbound.ofMessage(uuidv7() as VaultData["message.in"]["messageId"])).toBeNull();
    expect(inbound.anonymous).toEqual([]);
    expect(inbound.unplaced).toEqual([]);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("orders receipts by exact ordinal, then author, whatever the events' canonical order", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const wire = uuidv7();
    const ten = observe(scene, { local: a0, peer: b0, ordinal: 10, wire, author: AUTHOR });
    const nineByB = observe(scene, { local: a0, peer: b0, ordinal: 9, wire, author: AUTHOR2 });
    const nineByA = observe(scene, { local: a0, peer: b0, ordinal: 9, wire, author: AUTHOR });
    const vault = await fold(scene, keys);
    const execution = vault.inbound.ofMessage(ten.data.messageId)!;
    expect(execution.members.map(({ source }) => source.event.cid)).toEqual([nineByA.cid, nineByB.cid, ten.cid]);
    expect(execution.firstReceiptKey).toEqual({ ordinal: 9n, author: AUTHOR });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is in conflict for good when positive observations carry different intents, whatever later becomes of their witnesses", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2 } = await vaults();
    const wire = uuidv7();
    const plain = observe(scene, { local: a0, peer: b1, ordinal: 1, wire });
    const carried = observe(scene, { local: a0, peer: b1, ordinal: 2, wire, hash: OTHER_HASH, fromPrior: await proof(peerKeys, b0, b1) });
    let vault = await fold(scene, keys);
    const conflict = { status: "conflict", because: "2 intents are authenticated for one input" };
    let execution = vault.inbound.ofMessage(plain.data.messageId)!;
    expect(execution).toMatchObject({ status: conflict, intentHash: null, kind: null, firstReceiptKey: null });
    expect(execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness])).toEqual([
      [plain.cid, true, { status: "complete" }],
      [carried.cid, true, { status: "complete" }],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    observe(scene, { local: a0, peer: b2, ordinal: 3, wire: uuidv7(), fromPrior: await proof(peerKeys, b0, b2) });
    blocked(scene, a0, b1);
    vault = await fold(scene, keys);
    execution = vault.inbound.ofMessage(plain.data.messageId)!;
    expect(vault.continuity.conflicted(execution.channel)).toBe(true);
    expect(execution.members.map(({ positive, witness }) => [positive, witness.status])).toEqual([
      [true, "complete"],
      [true, "conflict"],
    ]);
    expect(execution.status).toEqual(conflict);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("takes no contradiction from, and lends no completion to, an observation whose proof is refused or not yet verified", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const wire = uuidv7();
    const shortIssuer = await resign(peerKeys, b0.didId, { alg: "EdDSA", typ: "JWT", kid: `${b0.did}${AUTHENTICATION_METHOD}` }, { iss: b0.did, sub: b1.longFormDid, iat: IAT });
    const refused = observe(scene, { local: a0, peer: b1, ordinal: 1, wire, hash: OTHER_HASH, fromPrior: "not a JWT" });
    const waiting = observe(scene, { local: a0, peer: b1, ordinal: 2, wire, hash: OTHER_HASH, fromPrior: shortIssuer });
    let vault = await fold(scene, keys);
    let execution = vault.inbound.ofMessage(refused.data.messageId)!;
    expect(execution).toMatchObject({ status: { status: "pending", because: "no observation is a complete witness: the proof is not yet verified" }, intentHash: null, kind: null, firstReceiptKey: null });
    expect(execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness])).toEqual([
      [refused.cid, false, { status: "invalid", because: "not a compact JWT" }],
      [waiting.cid, false, { status: "pending", because: "the proof is not yet verified" }],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    const plain = observe(scene, { local: a0, peer: b1, ordinal: 3, wire });
    vault = await fold(scene, keys);
    execution = vault.inbound.ofMessage(refused.data.messageId)!;
    expect(execution).toMatchObject({ status: { status: "complete" }, intentHash: HASH, kind: "application", firstReceiptKey: { ordinal: 3n, author: AUTHOR } });
    expect(execution.members.map(({ source, positive }) => [source.event.cid, positive])).toEqual([
      [refused.cid, false],
      [waiting.cid, false],
      [plain.cid, true],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    resolved(scene, a1.didId, b0, { short: true });
    vault = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    execution = vault.inbound.ofMessage(refused.data.messageId)!;
    expect(execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness.status])).toEqual([
      [refused.cid, false, "invalid"],
      [waiting.cid, true, "complete"],
      [plain.cid, true, "complete"],
    ]);
    expect(execution).toMatchObject({ status: { status: "conflict", because: "2 intents are authenticated for one input" }, intentHash: null, firstReceiptKey: null });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("lists an observation whose own authentication is incomplete or contradicted as a sibling of its input, or as unplaced, and an anonymous one apart", async () => {
    const { scene, keys, a0, b0, b1 } = await vaults();
    const wire = uuidv7();
    const complete = observe(scene, { local: a0, peer: b0, ordinal: 1, wire });
    const missingResolution = observe(scene, { local: a0, peer: b0, ordinal: 2, wire, overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] } });
    const wrongResolution = receipt(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b1), ordinal: 3, wire, presentedDid: b0.longFormDid });
    const alone = observe(scene, { local: a0, peer: b0, ordinal: 4, wire: uuidv7(), overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] } });
    const anonymousWire = uuidv7() as WireMessageId;
    const anonymous = observe(scene, {
      local: a0,
      peer: b0,
      ordinal: 5,
      wire: anonymousWire,
      overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), anonymousWire), peerResolutionEventCid: null, presentedDid: null, did: null },
    });
    const vault = await fold(scene, keys);
    const { inbound } = vault;
    const execution = inbound.ofMessage(complete.data.messageId)!;
    expect(execution.status).toEqual({ status: "complete" });
    expect(execution.members.map(({ source }) => source.event.cid)).toEqual([complete.cid]);
    expect(execution.siblings.map(({ event, standing }) => [event.cid, standing])).toEqual([
      [missingResolution.cid, { status: "incomplete", because: "the resolution it names is not here" }],
      [wrongResolution.cid, { status: "conflict", because: "the resolution it names is not of this sender at this key" }],
    ]);
    expect(inbound.ofSource(missingResolution.cid)).toBe(execution);
    expect(inbound.ofSource(wrongResolution.cid)).toBe(execution);
    expect(inbound.unplaced.map(({ event }) => event.cid)).toEqual([alone.cid]);
    expect(inbound.ofSource(alone.cid)).toBeNull();
    expect(inbound.anonymous.map(({ event }) => event.cid)).toEqual([anonymous.cid]);
    expect(inbound.ofSource(anonymous.cid)).toBeNull();
    expect(inbound.ofSource(fakeEventCid())).toBeNull();
    expect(inbound.executions.size).toBe(1);
    expectSameOverEveryOrder(scene, vault.checks);

    const unseeded = await fold(scene, null);
    expect(unseeded.inbound.executions.size).toBe(0);
    expect(unseeded.inbound.unplaced.map(({ event, standing }) => [event.cid, standing.status])).toEqual([
      [complete.cid, "incomplete"],
      [missingResolution.cid, "incomplete"],
      [wrongResolution.cid, "conflict"],
      [alone.cid, "incomplete"],
    ]);
    expect(unseeded.inbound.anonymous.map(({ event }) => event.cid)).toEqual([anonymous.cid]);
    expectSameOverEveryOrder(scene, unseeded.checks);
  });

  it("reads the kind of the agreed intent, a pure ACK only in its exact shape, and marks an erased input", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const target = uuidv7();
    const pureAck: Partial<VaultData["message.in"]> = { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, attachmentCids: [], ack: [target], pleaseAck: null };
    const shapes: [string, Partial<VaultData["message.in"]>][] = [
      ["pure-ack", pureAck],
      ["empty", { ...pureAck, ack: [] }],
      ["empty", { ...pureAck, pleaseAck: [""] }],
      ["empty", { ...pureAck, bodyCid: cidOf("not empty") }],
      ["empty", { ...pureAck, attachmentCids: [cidOf("attachment")] }],
      ["empty", { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, ack: [], pleaseAck: [""] }],
      ["ping-response", { msgType: PING_RESPONSE_TYPE, thid: target }],
      ["error", { msgType: PROBLEM_REPORT_TYPE, pthid: target }],
      ["application", { msgType: "https://didcomm.org/trust-ping/2.0/ping" }],
      ["application", {}],
    ];
    const observed = shapes.map(([kind, overrides], i) => [kind, observe(scene, { local: a0, peer: b0, ordinal: i + 1, wire: uuidv7(), overrides })] as const);
    const erased = observed[0]![1];
    scene.add("message.erased", { messageId: erased.data.messageId, dropCids: [erased.data.bodyCid], because: "user" });
    const vault = await fold(scene, keys);
    for (const [kind, event] of observed) {
      expect(kindOf(event.data)).toBe(kind);
      const execution = vault.inbound.ofSource(event.cid)!;
      expect(execution).toMatchObject({ kind, status: { status: "complete" }, erased: event === erased });
    }
    expectSameOverEveryOrder(scene, vault.checks);
  });
});
