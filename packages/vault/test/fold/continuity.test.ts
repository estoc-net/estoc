import type { Event } from "@estoc/event-store";
import { base64urlnopad } from "@scure/base";
import { SignJWT, importJWK } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it, test } from "vitest";

import {
  AUTHENTICATION_METHOD,
  VaultEventSet,
  anonymousMessageId,
  authorizedMethodIds,
  checkVault,
  compareChannels,
  didKeyName,
  foldVault,
  foldVaultChecked,
  methodPublicKey,
  type Channel,
  type Keys,
  type MessageHash,
  type ReadObject,
  type VaultChecks,
  type VaultFold,
  type WireMessageId,
} from "../../src/index.js";
import { MEDIATED, ROUTE, createdDid, expectOrderFree, fakeEventCid, type Scene } from "./helpers.js";
import { IAT, asPeer, blocked, channel, factsOf, noObjects, peerDid, proof, receipt, resolved, rotation, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);

const proofFreeReceipt = (scene: Scene, local: Local, peer: Peer, ordinal: number) => receipt(scene, { local, peer, resolution: resolved(scene, local.didId, peer), ordinal });

const receiptCarryingProof = async (scene: Scene, peerKeys: Keys, local: Local, predecessor: Peer, successor: Peer, ordinal: number) =>
  receipt(scene, { local, peer: successor, resolution: resolved(scene, local.didId, successor), ordinal, fromPrior: await proof(peerKeys, predecessor, successor) });

const observation = (source: Event, local: { did: Channel["localDid"] }, peer: { did: Channel["peerDid"] }) => ({ kind: "address-observed", id: `receipt:${source.cid}:observation`, at: channel(local, peer), carriedTransition: null, receipt: source.cid });

const byId = <T extends { id: string }>(facts: readonly T[]): T[] => [...facts].sort((a, b) => (a.id < b.id ? -1 : 1));

const sortedLinks = <T extends { from: Channel; to: Channel }>(links: readonly T[]): T[] => [...links].sort((a, b) => compareChannels(a.from, b.from) || compareChannels(a.to, b.to));

/** Everything the continuity says, as comparable data: its queries answered over every channel it names and every probe. */
function picture(vault: VaultFold, probes: readonly Channel[] = []) {
  const { set, continuity } = vault;
  const channels = new Map<string, Channel>();
  const note = (c: { localDid: string; peerDid: string }) => channels.set(`${c.localDid} ${c.peerDid}`, c as Channel);
  for (const fact of continuity.facts) {
    note(fact.at);
    if (fact.kind === "peer-transition" && fact.change.kind === "rotate") note({ localDid: fact.at.localDid, peerDid: fact.change.successor });
    if (fact.kind === "local-decision" && fact.change.kind === "rotate") note({ localDid: fact.change.successor, peerDid: fact.at.peerDid });
  }
  for (const c of probes) note(c);
  const events = [...set.of("message.in"), ...set.of("did.rotationSelected")];
  return {
    facts: continuity.facts,
    conflicts: continuity.conflicts,
    statuses: events.map((event) => [event.cid, continuity.status(event.cid)]),
    witnesses: set.of("message.in").map((event) => [event.cid, continuity.witness(event.cid)]),
    channels: [...channels.values()].sort(compareChannels).map((c) => ({
      channel: c,
      head: continuity.head(c),
      modelHead: continuity.model.head(c),
      superseded: continuity.superseded(c),
      conflicted: continuity.conflicted(c),
      confirmedBy: continuity.confirmedBy(c.localDid, c.peerDid)?.event.cid ?? null,
      blocked: continuity.blocked(c).map((event) => event.cid),
      decisions: continuity.decisionsIn(c).map((decision) => decision.event.cid).sort(),
    })),
  };
}

const expectSameOverEveryOrder = (scene: Scene, checks: Required<VaultChecks>, probes: readonly Channel[] = []) => expectOrderFree(scene.events, (set) => picture(foldVault(set, checks), probes));

async function resign(keys: Keys, local: Local, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  const key = await keys.signing(didKeyName(local.didId, "authentication"));
  return new SignJWT(payload)
    .setProtectedHeader(header as never)
    .sign(await importJWK(key.privateJwk(), "EdDSA"));
}

const encode = (value: unknown) => base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)));

/** A token of the right shape under any header and claims, with a signature that verifies nothing: for what the profile refuses before a signature is looked at. */
const unsigned = (header: Record<string, unknown>, payload: Record<string, unknown>) => `${encode(header)}.${encode(payload)}.${base64urlnopad.encode(new Uint8Array(64))}`;

describe("the projection", () => {
  it("names each fact by the CID of the event it derives from, references evidence by that CID, and is the same over every order of the events", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const old = proofFreeReceipt(scene, a0, b0, 1);
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    const other = proofFreeReceipt(scene, a1, b0, 3);
    const decision = await rotation(scene, keys, { from: a0, peer: b1, to: a1, source: carrier });
    const vault = await fold(scene, keys);
    expect(vault.continuity.facts).toEqual(
      byId([
        observation(old, a0, b0),
        ...factsOf(carrier, a0, b0, b1),
        observation(other, a1, b0),
        { kind: "local-decision", id: `decision:${decision.cid}`, at: channel(a0, b1), change: { kind: "rotate", successor: a1.did }, source: `receipt:${carrier.cid}:observation`, decision: decision.cid },
      ])
    );
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("binds a proof to its own receipt alone: two receipts of one token are two transitions and two observations, and a receipt whose proof waits gains nothing from a verified twin", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const jwt = await proof(peerKeys, b0, b1);
    const root = resolved(scene, a0.didId, b1);
    const first = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: jwt });
    const second = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, fromPrior: jwt });
    const shortIssuer = await resign(peerKeys, b0, { alg: "EdDSA", typ: "JWT", kid: `${b0.did}${AUTHENTICATION_METHOD}` }, { iss: b0.did, sub: b1.longFormDid, iat: IAT });
    const waiting = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 3, fromPrior: shortIssuer });
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.facts).toEqual(byId([...factsOf(first, a0, b0, b1), ...factsOf(second, a0, b0, b1)]));
    for (const event of [first, second]) {
      expect(c.status(event.cid)).toEqual({ status: "verified" });
      expect(c.witness(event.cid)).toEqual({ status: "complete" });
    }
    expect(c.status(waiting.cid)).toEqual({ status: "pending-proof" });
    expect(c.witness(waiting.cid)).toEqual({ status: "pending", because: "the proof is not yet verified" });
    expect(vault.channels.positive(waiting.cid)).toBe(false);
    expect(c.model.history(channel(a0, b0)).links).toEqual([{ from: channel(a0, b0), to: channel(a0, b1), replaces: "peer", support: [`receipt:${first.cid}:transition`, `receipt:${second.cid}:transition`].sort(), derived: false, usable: true }]);
  });
});

describe("a peer link", () => {
  it("replaces the peer in its own channel — head, supersession, confirmation and ACK path — and leaves the same peer DID's unrelated channel alone", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const old = proofFreeReceipt(scene, a0, b0, 1);
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    proofFreeReceipt(scene, a1, b0, 3);
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.conflicts).toEqual([]);
    expect(c.status(old.cid)).toEqual({ status: "not-present" });
    expect(c.status(carrier.cid)).toEqual({ status: "verified" });
    expect(c.witness(carrier.cid)).toEqual({ status: "complete" });
    expect(c.head(channel(a0, b0))).toEqual(channel(a0, b1));
    expect(c.head(channel(a0, b1))).toEqual(channel(a0, b1));
    expect(c.superseded(channel(a0, b0))).toBe(true);
    expect(c.superseded(channel(a0, b1))).toBe(false);
    expect(c.head(channel(a1, b0))).toEqual(channel(a1, b0));
    expect(c.superseded(channel(a1, b0))).toBe(false);
    expect(c.confirmedBy(a0.did, b1.did)).not.toBeNull();
    expect(c.confirmedBy(a0.did, b0.did)).not.toBeNull();
    expect(c.confirmedBy(a1.did, b1.did)).toBeNull();
    expect(c.confirmedBy(a1.did, b0.did)).not.toBeNull();
    expect(c.ackPath(channel(a0, b0), channel(a0, b1))).toBe(true);
    expect(c.ackPath(channel(a0, b1), channel(a0, b0))).toBe(false);
    expect(c.ackPath(channel(a0, b0), channel(a1, b0))).toBe(false);
    expect(c.ackPath(channel(a1, b0), channel(a1, b0))).toBe(true);
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b0)]);
  });
});

describe("a channel", () => {
  it("no fact mentions is its own head; one a saved rotation leaves has no head until the peer confirms the predecessor, and never falls back to the old pair", async () => {
    const { scene, keys, a0, a1, b0, b2 } = await vaults();
    const manual = await rotation(scene, keys, { from: a0, peer: b0, to: a1 });
    proofFreeReceipt(scene, a1, b0, 1);
    proofFreeReceipt(scene, a0, b2, 2);
    let vault = await fold(scene, keys);
    let c = vault.continuity;
    expect(vault.channels.decisions.get(manual.cid)!.status.status).toBe("candidate");
    expect(c.status(manual.cid)).toEqual({ status: "pending-history", because: "no observation addressed to the predecessor by its peer or a successor of that peer" });
    expect(c.model.head(channel(a0, b0))).toEqual({ status: "unresolved", waiting: [`decision:${manual.cid}`], missing: [] });
    expect(c.head(channel(a0, b0))).toBeNull();
    expect(c.head(channel(a1, b0))).toEqual(channel(a1, b0));
    expect(c.conflicted(channel(a0, b0))).toBe(false);
    expect(c.model.head(channel(a0, b2))).toMatchObject({ status: "head", channel: channel(a0, b2) });
    expect(c.head(channel(a0, b2))).toEqual(channel(a0, b2));
    expect(c.model.head(channel(a1, b2))).toEqual({ status: "no-evidence" });
    expect(c.head(channel(a1, b2))).toEqual(channel(a1, b2));
    expect(c.confirmedBy(a1.did, b2.did)).toBeNull();
    expect(c.decisionsIn(channel(a0, b0)).map((decision) => decision.event)).toEqual([manual]);
    expect(c.decisionsIn(channel(a0, b2))).toEqual([]);
    expectSameOverEveryOrder(scene, vault.checks, [channel(a0, b0), channel(a1, b2)]);

    proofFreeReceipt(scene, a0, b0, 3);
    vault = await fold(scene, keys);
    c = vault.continuity;
    expect(c.status(manual.cid)).toEqual({ status: "verified" });
    expect(c.head(channel(a0, b0))).toEqual(channel(a1, b0));
    expect(c.superseded(channel(a0, b0))).toBe(false);
    expect(c.confirmedBy(a1.did, b0.did)).not.toBeNull();
    expect(c.ackPath(channel(a0, b0), channel(a1, b0))).toBe(true);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  test("an address is confirmed for new work by an admitted observation alone: the model confirms by every usable one, a saved decision rests on those, and confirmedBy names the first admitted", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const unadmitted = receipt(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b0), ordinal: 1, admitted: false });
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1 });
    let vault = await fold(scene, keys);
    expect(vault.continuity.model.confirmation(a0.did, b0.did)).toMatchObject({ status: "confirmed", observations: [{ id: `receipt:${unadmitted.cid}:observation` }] });
    expect(vault.continuity.confirmedBy(a0.did, b0.did)).toBeNull();
    expect(vault.continuity.status(decision.cid)).toEqual({ status: "verified" });
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a1, b0));
    expectSameOverEveryOrder(scene, vault.checks);

    const later = receipt(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b0), ordinal: 2 });
    vault = await fold(scene, keys);
    expect(vault.continuity.confirmedBy(a0.did, b0.did)?.event.cid).toBe(later.cid);
    expect(vault.continuity.confirmedBy(a0.did, a0.did)).toBeNull();
    expect(vault.continuity.confirmedBy(a1.did, b0.did)).toBeNull();
    expectSameOverEveryOrder(scene, vault.checks);

    const contradicting = receipt(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b0), ordinal: 3, wire: later.data.wireMessageId, overrides: { intentHash: "Amqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA" as MessageHash } });
    vault = await fold(scene, keys);
    expect(vault.inbound.ofSource(later.cid)!.status).toEqual({ status: "conflict", because: "2 intents are admitted for one input" });
    const admitted = [later, contradicting].map((source) => observation(source, a0, b0).id);
    const confirmation = vault.continuity.model.confirmation(a0.did, b0.did);
    const firstAdmitted = confirmation.status === "confirmed" ? confirmation.observations.map(({ id }) => id).find((id) => admitted.includes(id)) : undefined;
    expect(firstAdmitted).toBeDefined();
    expect(observation(vault.continuity.confirmedBy(a0.did, b0.did)!.event, a0, b0).id).toBe(firstAdmitted);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  test("a decision is confirmed by its own source, which does not depend on the decision", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const sourced = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const { continuity } = await fold(scene, keys);
    expect(continuity.status(sourced.cid)).toEqual({ status: "verified" });
    expect(continuity.model.status(`decision:${sourced.cid}`)).toEqual({ status: "usable", support: [`decision:${sourced.cid}`, `receipt:${source.cid}:observation`].sort() });
    expect(continuity.head(channel(a0, b0))).toEqual(channel(a1, b0));
  });

  it("passes through what the evidence already refused or is waiting for, and lists an unprojected decision in its context all the same", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const wire = uuidv7() as WireMessageId;
    const anonymous = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, wire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventCid: null, did: null, presentedDid: null } });
    const invalid = await rotation(scene, keys, { from: a0, peer: b0, to: a1, fromPrior: await proof(keys, a0, a2) });
    const conflict = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: anonymous });
    const pending = await rotation(scene, keys, { from: a0, peer: b0, to: { didId: "019b7000-0000-7000-8000-000000000c00" as Local["didId"], did: a1.did, longFormDid: a1.longFormDid } });
    const { continuity } = await fold(scene, keys);
    expect(continuity.status(invalid.cid)).toEqual({ status: "invalid", because: "the proof's sub is not the successor's long form" });
    expect(continuity.status(conflict.cid)).toEqual({ status: "conflict", because: "the source is anonymous, in no pair" });
    expect(continuity.status(pending.cid)).toEqual({ status: "pending-history", because: "the successor entity has no consistent creation here" });
    expect(continuity.status(fakeEventCid())).toEqual({ status: "pending-history", because: "no carrier or decision here has this ID" });
    expect(continuity.facts).toEqual([]);
    expect(continuity.model.localDecisions(channel(a0, b0))).toEqual([]);
    expect(continuity.decisionsIn(channel(a0, b0)).map((decision) => decision.event)).toEqual([invalid, conflict, pending]);
    expect(continuity.head(channel(a0, b0))).toEqual(channel(a0, b0));
  });
});

describe("a join", () => {
  it("pairs both successors when a local and a peer replacement leave the same pair, in any order, and transports each replacement to the other's successor", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1, b2 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    const elsewhere = await receiptCarryingProof(scene, peerKeys, a2, b0, b1, 3);
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.conflicts).toEqual([]);
    const local = `decision:${decision.cid}`;
    const peer = `receipt:${carrier.cid}:transition`;
    const confirmed = `receipt:${source.cid}:observation`;
    expect(c.model.history(channel(a0, b0)).links).toEqual(
      sortedLinks([
        { from: channel(a0, b0), to: channel(a0, b1), replaces: "peer", support: [peer], derived: false, usable: true },
        { from: channel(a0, b0), to: channel(a1, b0), replaces: "local", support: [local, confirmed].sort(), derived: false, usable: true },
        { from: channel(a0, b1), to: channel(a1, b1), replaces: "local", support: [local, peer, confirmed].sort(), derived: true, usable: true },
        { from: channel(a1, b0), to: channel(a1, b1), replaces: "peer", support: [local, peer, confirmed].sort(), derived: true, usable: true },
      ])
    );
    expect(c.model.history(channel(a2, b0)).links).toEqual([{ from: channel(a2, b0), to: channel(a2, b1), replaces: "peer", support: [`receipt:${elsewhere.cid}:transition`], derived: false, usable: true }]);
    for (const start of [channel(a0, b0), channel(a0, b1), channel(a1, b0), channel(a1, b1)]) expect(c.head(start)).toEqual(channel(a1, b1));
    expect(c.head(channel(a2, b0))).toEqual(channel(a2, b1));
    expect(c.superseded(channel(a0, b0))).toBe(true);
    expect(c.superseded(channel(a1, b0))).toBe(true);
    expect(c.superseded(channel(a0, b1))).toBe(false);
    expect(c.superseded(channel(a1, b1))).toBe(false);
    expect(c.decisionsIn(channel(a0, b1)).map((d) => d.event)).toEqual([decision]);
    expect(c.decisionsIn(channel(a0, b2))).toEqual([]);
    expect(c.decisionsIn(channel(a1, b1))).toEqual([]);
    expect(c.decisionsIn(channel(a2, b0))).toEqual([]);
    expect(c.ackPath(channel(a0, b0), channel(a1, b1))).toBe(true);
    expect(c.ackPath(channel(a1, b0), channel(a0, b1))).toBe(false);
    expect(c.ackPath(channel(a0, b0), channel(a2, b1))).toBe(false);
    expect(c.confirmedBy(a1.did, b1.did)).toBeNull();
    expect(c.confirmedBy(a0.did, b0.did)).not.toBeNull();
    expectSameOverEveryOrder(scene, vault.checks, [channel(a0, b2)]);
  });

  it("reuses the decision throughout its peer-only context: a second successor from the same predecessor competes, extending the successor needs its own confirmation", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const first = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    const extension = await rotation(scene, keys, { from: a1, peer: b1, to: a2 });
    let vault = await fold(scene, keys);
    expect(vault.continuity.status(extension.cid)).toMatchObject({ status: "pending-history" });
    expect(vault.continuity.model.head(channel(a0, b0))).toEqual({ status: "unresolved", waiting: [`decision:${extension.cid}`], missing: [] });
    expect(vault.continuity.head(channel(a0, b0))).toBeNull();
    expect(vault.continuity.decisionsIn(channel(a1, b0)).map((d) => d.event)).toEqual([extension]);
    expect(vault.continuity.conflicts).toEqual([]);

    proofFreeReceipt(scene, a1, b1, 3);
    vault = await fold(scene, keys);
    expect(vault.continuity.status(extension.cid)).toEqual({ status: "verified" });
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a2, b1));
    expectSameOverEveryOrder(scene, vault.checks);

    const competing = await rotation(scene, keys, { from: a0, peer: b1, to: a2, source: carrier });
    vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.conflicts).toEqual([
      {
        conflict: {
          kind: "competing-changes",
          side: "local",
          context: [channel(a0, b0), channel(a0, b1)].sort(compareChannels),
          changes: [
            { change: { kind: "rotate", successor: a1.did }, facts: [`decision:${first.cid}`] },
            { change: { kind: "rotate", successor: a2.did }, facts: [`decision:${competing.cid}`] },
          ].sort((x, y) => (x.change.successor < y.change.successor ? -1 : 1)),
        },
        channels: [channel(a0, b0), channel(a0, b1), channel(a1, b0), channel(a2, b1)].sort(compareChannels),
      },
    ]);
    expect(c.decisionsIn(channel(a0, b1)).map((d) => d.event)).toEqual([first, competing]);
    for (const event of [first, carrier, extension, competing]) expect(c.status(event.cid)).toMatchObject({ status: "conflict" });
    expect(c.witness(carrier.cid)).toMatchObject({ status: "conflict" });
    expect(c.witness(source.cid)).toEqual({ status: "complete" });
    for (const start of [channel(a0, b0), channel(a0, b1), channel(a1, b0), channel(a1, b1), channel(a2, b1)]) {
      expect(c.head(start)).toBeNull();
      expect(c.conflicted(start)).toBe(true);
    }
    expect(c.confirmedBy(a0.did, b0.did)).toBeNull();
    expect(c.ackPath(channel(a0, b0), channel(a1, b1))).toBe(false);
    expectSameOverEveryOrder(scene, vault.checks);
  });
});

describe("conflicts", () => {
  test("competing peer successors in one local-only context, straight from one pair or across a local link, mask every channel involved and choose no winner", async () => {
    const direct = await vaults();
    const one = await receiptCarryingProof(direct.scene, direct.peerKeys, direct.a0, direct.b0, direct.b1, 1);
    const two = await receiptCarryingProof(direct.scene, direct.peerKeys, direct.a0, direct.b0, direct.b2, 2);
    let vault = await fold(direct.scene, direct.keys);
    let c = vault.continuity;
    const { a0, a1, b0, b1, b2 } = direct;
    expect(c.conflicts).toMatchObject([{ conflict: { kind: "competing-changes", side: "peer", context: [channel(a0, b0)] }, channels: [channel(a0, b0), channel(a0, b1), channel(a0, b2)].sort(compareChannels) }]);
    for (const event of [one, two]) {
      expect(c.status(event.cid)).toMatchObject({ status: "conflict" });
      expect(c.witness(event.cid)).toMatchObject({ status: "conflict" });
    }
    for (const start of [channel(a0, b0), channel(a0, b1), channel(a0, b2)]) expect(c.head(start)).toBeNull();
    expect(c.superseded(channel(a0, b0))).toBe(true);
    expect(c.confirmedBy(a0.did, b0.did)).toBeNull();
    expect(c.ackPath(channel(a0, b0), channel(a0, b1))).toBe(false);
    expect(c.ackPath(channel(a0, b1), channel(a0, b1))).toBe(true);
    expectSameOverEveryOrder(direct.scene, vault.checks);

    const across = await vaults();
    const source = proofFreeReceipt(across.scene, across.a0, across.b0, 1);
    await rotation(across.scene, across.keys, { from: across.a0, peer: across.b0, to: across.a1, source });
    await receiptCarryingProof(across.scene, across.peerKeys, across.a0, across.b0, across.b1, 2);
    const late = await receiptCarryingProof(across.scene, across.peerKeys, across.a1, across.b0, across.b2, 3);
    vault = await fold(across.scene, across.keys);
    c = vault.continuity;
    expect(c.conflicts).toMatchObject([{ conflict: { kind: "competing-changes", side: "peer", context: [channel(a0, b0), channel(a1, b0)].sort(compareChannels) } }]);
    expect(c.conflicted(channel(a1, b2))).toBe(true);
    expect(c.status(late.cid)).toMatchObject({ status: "conflict" });
    expect(c.head(channel(a0, b0))).toBeNull();
    expect(c.head(channel(a1, b0))).toBeNull();
    expect(c.superseded(channel(a0, b0))).toBe(true);
    expectSameOverEveryOrder(across.scene, vault.checks);
  });

  test("a cycle of replacements grants nothing, and a join that would pair a DID with itself is refused as an identity collision", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const forth = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
    const back = await receiptCarryingProof(scene, peerKeys, a0, b1, b0, 2);
    let vault = await fold(scene, keys);
    let c = vault.continuity;
    expect(c.conflicts).toEqual([{ conflict: { kind: "cycle", channels: [channel(a0, b0), channel(a0, b1)].sort(compareChannels), facts: [`receipt:${forth.cid}:transition`, `receipt:${back.cid}:transition`].sort() }, channels: [channel(a0, b0), channel(a0, b1)].sort(compareChannels) }]);
    for (const event of [forth, back]) expect(c.status(event.cid)).toMatchObject({ status: "conflict" });
    expect(c.head(channel(a0, b0))).toBeNull();
    expect(c.head(channel(a0, b1))).toBeNull();
    expect(c.superseded(channel(a0, b0))).toBe(true);
    expect(c.superseded(channel(a0, b1))).toBe(true);
    expectSameOverEveryOrder(scene, vault.checks);

    const identity = await vaults();
    const source = proofFreeReceipt(identity.scene, identity.a0, identity.b0, 1);
    await rotation(identity.scene, identity.keys, { from: identity.a0, peer: identity.b0, to: identity.a1, source });
    const ours = asPeer(identity.a1);
    const claimed = receipt(identity.scene, { local: identity.a0, peer: ours, resolution: resolved(identity.scene, identity.a0.didId, ours), ordinal: 2, fromPrior: await proof(identity.peerKeys, identity.b0, ours) });
    vault = await fold(identity.scene, identity.keys);
    c = vault.continuity;
    expect(vault.channels.positive(claimed.cid)).toBe(true);
    expect(c.conflicts).toMatchObject([{ conflict: { kind: "identity-collision", channels: [channel(a0, b0), channel(a1, b0), channel(a0, a1)] }, channels: [channel(a0, b0), channel(a1, b0), channel(a0, a1)].sort(compareChannels) }]);
    expect(c.head(channel(a0, b0))).toBeNull();
    expect(c.status(claimed.cid)).toMatchObject({ status: "conflict" });
    expectSameOverEveryOrder(identity.scene, vault.checks);
  });

  it("ahead of a channel leave it no default head and no new work: a fork or a cycle beyond a replacement never hands the default back to the channel the replacement left", async () => {
    const forked = await vaults();
    {
      const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = forked;
      const first = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
      await receiptCarryingProof(scene, peerKeys, a0, b1, b2, 2);
      expect((await fold(scene, keys)).continuity.head(channel(a0, b0))).toEqual(channel(a0, b2));
      await receiptCarryingProof(scene, peerKeys, a0, b1, b3, 3);
      const vault = await fold(scene, keys);
      const c = vault.continuity;
      expect(c.conflicts).toMatchObject([{ conflict: { kind: "competing-changes", side: "peer", context: [channel(a0, b1)] }, channels: [channel(a0, b1), channel(a0, b2), channel(a0, b3)].sort(compareChannels) }]);
      expect(c.conflicted(channel(a0, b0))).toBe(true);
      expect(c.superseded(channel(a0, b0))).toBe(true);
      expect(c.status(first.cid)).toMatchObject({ status: "conflict" });
      expect(c.head(channel(a0, b0))).toBeNull();
      expect(c.ackPath(channel(a0, b0), channel(a0, b2))).toBe(false);
      expectSameOverEveryOrder(scene, vault.checks);
    }
    const cyclic = await vaults();
    {
      const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = cyclic;
      const first = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
      await receiptCarryingProof(scene, peerKeys, a0, b1, b2, 2);
      await receiptCarryingProof(scene, peerKeys, a0, b2, b3, 3);
      expect((await fold(scene, keys)).continuity.head(channel(a0, b0))).toEqual(channel(a0, b3));
      await receiptCarryingProof(scene, peerKeys, a0, b3, b2, 4);
      const vault = await fold(scene, keys);
      const c = vault.continuity;
      expect(c.conflicts).toMatchObject([{ conflict: { kind: "cycle", channels: [channel(a0, b2), channel(a0, b3)].sort(compareChannels) } }]);
      expect(c.status(first.cid)).toEqual({ status: "verified" });
      expect(c.model.path(channel(a0, b0), channel(a0, b1))).toMatchObject({ status: "path" });
      expect(c.ackPath(channel(a0, b0), channel(a0, b1))).toBe(true);
      expect(c.head(channel(a0, b0))).toBeNull();
      expect(c.head(channel(a0, b1))).toBeNull();
      expect(c.conflicted(channel(a0, b0))).toBe(true);
      expectSameOverEveryOrder(scene, vault.checks);
    }
  });
});

describe("authority behind a conflict", () => {
  it("lets a carrier a conflict masks confirm no decision: the decision waits for a witness the conflict does not reach", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b2, b3 } = await vaults();
    await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
    await receiptCarryingProof(scene, peerKeys, a0, b0, b2, 2);
    const beyond = await receiptCarryingProof(scene, peerKeys, a0, b1, b3, 3);
    const manual = await rotation(scene, keys, { from: a0, peer: b3, to: a1 });
    let vault = await fold(scene, keys);
    let c = vault.continuity;
    expect(c.conflicts).toMatchObject([{ conflict: { kind: "competing-changes", side: "peer", context: [channel(a0, b0)] } }]);
    expect(c.status(beyond.cid)).toMatchObject({ status: "conflict" });
    expect(c.witness(beyond.cid)).toMatchObject({ status: "conflict" });
    expect(c.confirmedBy(a0.did, b3.did)).toBeNull();
    expect(c.status(manual.cid)).toEqual({ status: "pending-history", because: "the predecessor is confirmed only through continuity that is not usable" });
    expect(c.model.head(channel(a0, b3))).toMatchObject({ status: "conflict" });
    expect(c.conflicted(channel(a0, b3))).toBe(true);
    expect(c.ackPath(channel(a0, b3), channel(a1, b3))).toBe(false);
    expect(c.head(channel(a0, b3))).toBeNull();
    expect(c.head(channel(a0, b1))).toBeNull();
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b3)]);

    proofFreeReceipt(scene, a0, b3, 4);
    vault = await fold(scene, keys);
    c = vault.continuity;
    expect(c.confirmedBy(a0.did, b3.did)).not.toBeNull();
    expect(c.status(manual.cid)).toEqual({ status: "verified" });
    expect(c.ackPath(channel(a0, b3), channel(a1, b3))).toBe(true);
    expect(c.head(channel(a0, b3))).toEqual(channel(a1, b3));
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b3)]);
  });

  it("keeps a sourced decision to its masked source whatever else confirms the predecessor, and transports nothing of it through a join until an unmasked decision joins", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b2, b3 } = await vaults();
    const b4 = await peerDid(peerKeys, "019b7000-0000-7000-8000-000000000b04" as Peer["didId"]);
    await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
    await receiptCarryingProof(scene, peerKeys, a0, b0, b2, 2);
    const beyond = await receiptCarryingProof(scene, peerKeys, a0, b1, b3, 3);
    proofFreeReceipt(scene, a0, b3, 4);
    const sourced = await rotation(scene, keys, { from: a0, peer: b3, to: a1, source: beyond });
    const onward = await receiptCarryingProof(scene, peerKeys, a0, b3, b4, 5);
    let vault = await fold(scene, keys);
    let c = vault.continuity;
    expect(c.conflicts).toHaveLength(1);
    expect(c.confirmedBy(a0.did, b3.did)).not.toBeNull();
    expect(c.status(sourced.cid)).toMatchObject({ status: "conflict" });
    expect(c.status(onward.cid)).toEqual({ status: "verified" });
    expect(c.ackPath(channel(a0, b3), channel(a1, b4))).toBe(false);
    expect(c.ackPath(channel(a0, b3), channel(a0, b4))).toBe(true);
    expect(c.head(channel(a0, b3))).toBeNull();
    expect(c.head(channel(a0, b4))).toBeNull();
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b3), channel(a1, b4)]);

    const manual = await rotation(scene, keys, { from: a0, peer: b3, to: a1 });
    vault = await fold(scene, keys);
    c = vault.continuity;
    expect(c.conflicts).toHaveLength(1);
    expect(c.status(manual.cid)).toEqual({ status: "verified" });
    expect(c.status(sourced.cid)).toMatchObject({ status: "conflict" });
    expect(c.decisionsIn(channel(a0, b3)).map((d) => d.event)).toEqual([sourced, manual]);
    expect(c.ackPath(channel(a0, b3), channel(a1, b4))).toBe(true);
    expect(c.head(channel(a0, b3))).toEqual(channel(a1, b4));
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b3), channel(a1, b4)]);
  });

  it("derives no join through a conflicted channel: what a masked intermediate would transport reaches no descendant, while an independent decision still supports the same descendant", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b2, b3 } = await vaults();
    const a3 = await createdDid(scene, keys, "019b6a10-12c0-7410-89ab-38e54b097c22" as Local["didId"], ROUTE, MEDIATED);
    const b4 = await peerDid(peerKeys, "019b7000-0000-7000-8000-000000000b04" as Peer["didId"]);
    const localSource = proofFreeReceipt(scene, a2, b2, 1);
    const forkSource = proofFreeReceipt(scene, a3, b3, 2);
    const good = await rotation(scene, keys, { from: a2, peer: b2, to: a1, source: localSource });
    const forkOne = await rotation(scene, keys, { from: a3, peer: b3, to: a1, source: forkSource });
    const first = await receiptCarryingProof(scene, peerKeys, a2, b2, b3, 3);
    const next = await receiptCarryingProof(scene, peerKeys, a2, b3, b4, 4);
    let vault = await fold(scene, keys);
    let c = vault.continuity;
    expect(c.conflicts).toEqual([]);
    expect(c.head(channel(a2, b2))).toEqual(channel(a1, b4));
    expect(c.head(channel(a2, b4))).toEqual(channel(a1, b4));

    const forkTwo = await rotation(scene, keys, { from: a3, peer: b3, to: a0, source: forkSource });
    vault = await fold(scene, keys);
    c = vault.continuity;
    expect(c.conflicts).toMatchObject([{ conflict: { kind: "competing-changes", side: "local", context: [channel(a3, b3)] }, channels: [channel(a3, b3), channel(a0, b3), channel(a1, b3)].sort(compareChannels) }]);
    for (const event of [good, first, next]) expect(c.status(event.cid)).toEqual({ status: "verified" });
    for (const event of [forkOne, forkTwo]) expect(c.status(event.cid)).toMatchObject({ status: "conflict" });
    expect(sortedLinks(c.model.history(channel(a2, b2)).links.filter((link) => link.usable) as unknown as { from: Channel; to: Channel }[]).map((link) => [link.from, link.to])).toEqual(
      sortedLinks([
        { from: channel(a2, b2), to: channel(a1, b2) },
        { from: channel(a2, b2), to: channel(a2, b3) },
        { from: channel(a2, b3), to: channel(a2, b4) },
      ]).map((link) => [link.from, link.to])
    );
    expect(c.model.path(channel(a2, b2), channel(a2, b4))).toMatchObject({ status: "path" });
    expect(c.ackPath(channel(a2, b3), channel(a1, b3))).toBe(false);
    expect(c.ackPath(channel(a2, b4), channel(a1, b4))).toBe(false);
    for (const start of [channel(a2, b2), channel(a2, b4), channel(a1, b4)]) {
      expect(c.model.head(start)).toMatchObject({ status: "conflict" });
      expect(c.conflicted(start)).toBe(true);
      expect(c.head(start)).toBeNull();
    }
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b4)]);

    const control = await vaults();
    const a3Again = await createdDid(control.scene, control.keys, a3.didId, ROUTE, MEDIATED);
    const controlSource = proofFreeReceipt(control.scene, a3Again, b3, 1);
    await rotation(control.scene, control.keys, { from: a3Again, peer: b3, to: a1, source: controlSource });
    await rotation(control.scene, control.keys, { from: a3Again, peer: b3, to: a0, source: controlSource });
    const onward = await receiptCarryingProof(control.scene, control.peerKeys, a2, b3, b4, 2);
    const independent = await rotation(control.scene, control.keys, { from: a2, peer: b4, to: a1, source: onward });
    vault = await fold(control.scene, control.keys);
    c = vault.continuity;
    expect(c.conflicts).toHaveLength(1);
    expect(c.status(independent.cid)).toEqual({ status: "verified" });
    expect(c.ackPath(channel(a2, b4), channel(a1, b4))).toBe(true);
    expect(c.head(channel(a2, b3))).toEqual(channel(a1, b4));
    expect(c.head(channel(a2, b4))).toEqual(channel(a1, b4));
    expectSameOverEveryOrder(control.scene, vault.checks);
  });
});

describe("denial", () => {
  it("follows the history through a conflicted branch: a fork lets no successor escape a denial", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = await vaults();
    await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
    await receiptCarryingProof(scene, peerKeys, a0, b0, b2, 2);
    await receiptCarryingProof(scene, peerKeys, a0, b1, b3, 3);
    const denial = blocked(scene, a0, b0, true);
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.conflicted(channel(a0, b3))).toBe(false);
    expect(c.ackPath(channel(a0, b0), channel(a0, b3))).toBe(false);
    for (const successor of [channel(a0, b1), channel(a0, b2), channel(a0, b3)]) expect(c.blocked(successor)).toEqual([denial]);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("covers the pair itself, and its successors through links and joins only when the denial says so", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    await receiptCarryingProof(scene, peerKeys, a2, b0, b1, 3);
    const pair = blocked(scene, a0, b0);
    const successors = blocked(scene, a0, b0, true);
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.blocked(channel(a0, b0))).toEqual([pair, successors]);
    for (const successor of [channel(a0, b1), channel(a1, b0), channel(a1, b1)]) expect(c.blocked(successor)).toEqual([successors]);
    expect(c.blocked(channel(a2, b0))).toEqual([]);
    expect(c.blocked(channel(a2, b1))).toEqual([]);
    expect(c.head(channel(a0, b0))).toEqual(channel(a1, b1));
    expectSameOverEveryOrder(scene, vault.checks, [channel(a2, b0), channel(a2, b1)]);
  });
});

describe("the proof boundary", () => {
  it("refuses what the profile decides without issuer material — the algorithm, the media type, a kid of another DID, a subject that is the issuer or not the sender, a validity window — and leaves a well-formed short-form issuer pending", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const kid = `${b0.longFormDid}${AUTHENTICATION_METHOD}`;
    const claims = { iss: b0.longFormDid, sub: b1.longFormDid, iat: IAT };
    const wrongAlg = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: unsigned({ alg: "ES256", kid }, claims) });
    const wrongTyp = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, fromPrior: unsigned({ alg: "EdDSA", typ: "text/plain", kid }, claims) });
    const foreignKid = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 3, fromPrior: unsigned({ alg: "EdDSA", kid: `${b1.did}${AUTHENTICATION_METHOD}` }, claims) });
    const selfSubject = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 4, fromPrior: unsigned({ alg: "EdDSA", kid }, { ...claims, sub: b0.did }) });
    const notTheSender = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 5, fromPrior: unsigned({ alg: "EdDSA", kid }, { ...claims, sub: b0.did.replace(/.$/, "1") }) });
    const window = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 6, fromPrior: unsigned({ alg: "EdDSA", kid }, { ...claims, exp: IAT + 60 }) });
    const shortIssuer = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 7, fromPrior: await resign(peerKeys, b0, { alg: "EdDSA", kid: `${b0.did}${AUTHENTICATION_METHOD}` }, { ...claims, iss: b0.did }) });
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.status(wrongAlg.cid)).toEqual({ status: "invalid", because: "alg is EdDSA" });
    expect(c.status(wrongTyp.cid)).toEqual({ status: "invalid", because: "typ, when present, is JWT or application/jwt" });
    expect(c.status(foreignKid.cid)).toEqual({ status: "invalid", because: "the kid names a key of iss" });
    expect(c.status(selfSubject.cid)).toEqual({ status: "invalid", because: "sub is another DID than iss" });
    expect(c.status(notTheSender.cid)).toMatchObject({ status: "invalid", because: expect.stringMatching(/^sub is .* but the sender is /) });
    expect(c.status(window.cid)).toMatchObject({ status: "invalid", because: expect.stringMatching(/no exp or nbf/) });
    expect(c.status(shortIssuer.cid)).toEqual({ status: "pending-proof" });
    for (const event of [wrongAlg, wrongTyp, foreignKid, selfSubject, notTheSender, window]) expect(c.witness(event.cid)).toMatchObject({ status: "invalid" });
    expect(c.witness(shortIssuer.cid)).toEqual({ status: "pending", because: "the proof is not yet verified" });
    expect(c.facts).toEqual([]);
    expect(c.head(channel(a0, b1))).toEqual(channel(a0, b1));
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("accepts the spellings the profile equates — a long-form issuer under a short-form kid, a short-form subject for a long-form sender, typ absent or in either case — and binds each to its own receipt", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const claims = { iss: b0.longFormDid, sub: b1.longFormDid, iat: IAT };
    const shortKid = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: await resign(peerKeys, b0, { alg: "EdDSA", kid: `${b0.did}${AUTHENTICATION_METHOD}` }, claims) });
    const shortSubject = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, fromPrior: await resign(peerKeys, b0, { alg: "EdDSA", typ: "application/jwt", kid: `${b0.longFormDid}${AUTHENTICATION_METHOD}` }, { ...claims, sub: b1.did }) });
    const lowerTyp = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 3, fromPrior: await resign(peerKeys, b0, { alg: "EdDSA", typ: "jwt", kid: `${b0.longFormDid}${AUTHENTICATION_METHOD}` }, claims) });
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    for (const event of [shortKid, shortSubject, lowerTyp]) {
      expect(c.status(event.cid)).toEqual({ status: "verified" });
      expect(c.witness(event.cid)).toEqual({ status: "complete" });
    }
    expect(c.facts).toEqual(byId([...factsOf(shortKid, a0, b0, b1), ...factsOf(shortSubject, a0, b0, b1), ...factsOf(lowerTyp, a0, b0, b1)]));
    expect(vault.channels.carriers.get(shortSubject.cid)!.proof).toMatchObject({ status: "verified", proof: { token: shortSubject.data.fromPrior, change: { successor: { presented: b1.did, canonical: b1.did } } } });
    expect(c.head(channel(a0, b0))).toEqual(channel(a0, b1));
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("retains an ending as an unsupported proof: no fact, no witness, no channel ended, whether or not it names the recipient", async () => {
    const { scene, keys, peerKeys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const kid = `${b0.longFormDid}${AUTHENTICATION_METHOD}`;
    const addressed = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, fromPrior: await resign(peerKeys, b0, { alg: "EdDSA", kid }, { iss: b0.longFormDid, aud: a0.did, iat: IAT }) });
    const bare = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, fromPrior: await resign(peerKeys, b0, { alg: "EdDSA", kid }, { iss: b0.longFormDid, iat: IAT }) });
    const plain = proofFreeReceipt(scene, a0, b0, 3);
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    for (const event of [addressed, bare]) {
      expect(c.status(event.cid)).toEqual({ status: "unsupported", because: "an ending is not applied: this vault retains it and ends no relationship by it" });
      expect(c.witness(event.cid)).toMatchObject({ status: "invalid" });
      expect(vault.channels.positive(event.cid)).toBe(false);
      expect(vault.checks.proofChecks.has(event.cid)).toBe(false);
    }
    expect(c.facts).toEqual([observation(plain, a0, b0)]);
    expect(c.model.head(channel(a0, b0))).toMatchObject({ status: "head", channel: channel(a0, b0) });
    expect(c.superseded(channel(a0, b0))).toBe(false);
    expect(c.confirmedBy(a0.did, b0.did)).not.toBeNull();
    expectSameOverEveryOrder(scene, vault.checks);
  });
});

describe("status and witness", () => {
  it("give each carrier one of its states and each source what it witnesses, a contradiction over an absence", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = await vaults();
    const root1 = resolved(scene, a0.didId, b1);
    const proofFree = proofFreeReceipt(scene, a0, b0, 1);
    const shortIss = await resign(peerKeys, b2, { alg: "EdDSA", typ: "JWT", kid: `${b2.did}${AUTHENTICATION_METHOD}` }, { iss: b2.did, sub: b3.longFormDid, iat: IAT });
    const pendingProof = receipt(scene, { local: a0, peer: b3, resolution: resolved(scene, a0.didId, b3), ordinal: 2, fromPrior: shortIss });
    const toShortForm = await resign(peerKeys, b0, { alg: "EdDSA", typ: "JWT", kid: `${b0.longFormDid}${AUTHENTICATION_METHOD}` }, { iss: b0.longFormDid, sub: b1.did, iat: IAT });
    const pendingHistory = receipt(scene, { local: a0, peer: b1, resolution: resolved(scene, a0.didId, b1, { short: true }), ordinal: 3, presentedDid: b1.did, fromPrior: toShortForm });
    const invalid = receipt(scene, { local: a0, peer: b1, resolution: root1, ordinal: 4, fromPrior: "not-a-jwt" });
    const [authentication] = authorizedMethodIds(b1.resolution.document, "authentication");
    const signingKey = resolved(scene, a0.didId, b1, { peerPublicKey: methodPublicKey(b1.resolution.document, authentication!) });
    const contradicted = receipt(scene, { local: a0, peer: b1, resolution: signingKey, ordinal: 5, fromPrior: await proof(peerKeys, b0, b1) });
    const verified = receipt(scene, { local: a0, peer: b1, resolution: root1, ordinal: 6, fromPrior: await proof(peerKeys, b0, b1) });
    const wire = uuidv7() as WireMessageId;
    const anonymous = receipt(scene, { local: a0, peer: b0, resolution: root1, ordinal: 7, wire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventCid: null, did: null, presentedDid: null } });
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.status(proofFree.cid)).toEqual({ status: "not-present" });
    expect(c.status(pendingProof.cid)).toEqual({ status: "pending-proof" });
    expect(c.status(pendingHistory.cid)).toEqual({ status: "pending-history", because: "the carrier's own authentication is incomplete: the resolution's document is not here" });
    expect(c.status(invalid.cid)).toMatchObject({ status: "invalid", because: expect.stringMatching(/^not a compact JWT/) });
    expect(c.status(contradicted.cid)).toEqual({ status: "invalid", because: `the carrier's own authentication is contradicted: ${signingKey.data.peerPublicKey} is a Ed25519 key, which agrees no keys` });
    expect(c.status(verified.cid)).toEqual({ status: "verified" });
    expect(c.status(anonymous.cid)).toEqual({ status: "not-present" });
    expect(c.witness(proofFree.cid)).toEqual({ status: "complete" });
    expect(c.witness(pendingProof.cid)).toEqual({ status: "pending", because: "the proof is not yet verified" });
    expect(c.witness(pendingHistory.cid)).toEqual({ status: "pending", because: "the resolution's document is not here" });
    expect(c.witness(invalid.cid)).toMatchObject({ status: "invalid", because: expect.stringMatching(/^not a compact JWT/) });
    expect(c.witness(contradicted.cid)).toEqual({ status: "conflict", because: `${signingKey.data.peerPublicKey} is a Ed25519 key, which agrees no keys` });
    expect(c.witness(verified.cid)).toEqual({ status: "complete" });
    expect(c.witness(anonymous.cid)).toEqual({ status: "invalid", because: "the source is anonymous, in no pair" });
    expect(c.witness(fakeEventCid())).toEqual({ status: "pending", because: "the source is not here" });
    expect(c.facts).toEqual(byId([observation(proofFree, a0, b0), ...factsOf(verified, a0, b0, b1)]));
    expectSameOverEveryOrder(scene, vault.checks);

    const restored = await fold(scene, keys, async (cid) => (cid === b1.resolution.cid ? b1.resolution.bytes : null));
    expect(restored.continuity.status(pendingHistory.cid)).toEqual({ status: "verified" });
    expect(restored.continuity.facts).toEqual(byId([observation(proofFree, a0, b0), ...factsOf(pendingHistory, a0, b0, b1), ...factsOf(verified, a0, b0, b1)]));
  });

  test("without the checks beside the fold, every link waits and no channel is replaced", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    const set = VaultEventSet.of(scene.events);
    const unchecked = foldVault(set).continuity;
    expect(unchecked.facts).toEqual([]);
    expect(unchecked.status(carrier.cid)).toEqual({ status: "pending-proof" });
    expect(unchecked.status(decision.cid)).toEqual({ status: "pending-history", because: "the predecessor entity's keys are not yet checked against the seed" });
    expect(unchecked.witness(source.cid)).toEqual({ status: "pending", because: "the local entity's keys are not yet checked against the seed" });
    expect(unchecked.head(channel(a0, b0))).toEqual(channel(a0, b0));
    const checked = foldVault(set, await checkVault(set, keys, noObjects)).continuity;
    expect(checked.head(channel(a0, b0))).toEqual(channel(a1, b1));
  });
});
