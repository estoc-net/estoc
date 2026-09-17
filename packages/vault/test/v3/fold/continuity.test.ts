import type { Event, EventId } from "@estoc/event-store/v3";
import { SignJWT, importJWK } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_METHOD,
  VaultEventSet,
  anonymousMessageId,
  authorizedMethodIds,
  checkVault,
  compareChannels,
  didKeyName,
  channelOf,
  foldContinuity,
  foldVault,
  foldVaultChecked,
  methodPublicKey,
  sameChannel,
  type Channel,
  type ChannelEvidence,
  type ContinuityLink,
  type Did,
  type DidId,
  type Keys,
  type PeerLink,
  type ReadObject,
  type VaultChecks,
  type VaultFold,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { MEDIATED, ROUTE, createdDid, expectOrderFree, type Scene } from "./helpers.js";
import { IAT, asPeer, blocked, channel, noObjects, peerDid, proof, receipt, resolved, rotation, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);

const proofFreeReceipt = (scene: Scene, local: Local, peer: Peer, ordinal: number) => receipt(scene, { local, peer, resolution: resolved(scene, local.didId, peer), ordinal });

const receiptCarryingProof = async (scene: Scene, peerKeys: Keys, local: Local, predecessor: Peer, successor: Peer, ordinal: number) =>
  receipt(scene, { local, peer: successor, resolution: resolved(scene, local.didId, successor), ordinal, fromPrior: await proof(peerKeys, predecessor, successor) });

const link = (from: Channel, to: Channel, replaces: "local" | "peer", carriers: Event[], decisions: Event[], verified = true): ContinuityLink => ({
  from,
  to,
  replaces,
  carriers: carriers.map((event) => event.eventId).sort(),
  decisions: decisions.map((event) => event.eventId).sort(),
  verified,
});
const sortedLinks = (links: ContinuityLink[]) => [...links].sort((a, b) => compareChannels(a.from, b.from) || compareChannels(a.to, b.to));

/** Everything the continuity says, as comparable data: its queries answered over every channel it names and every probe. */
function picture(vault: VaultFold, probes: readonly Channel[] = []) {
  const { set, continuity } = vault;
  const channels = new Map<string, Channel>();
  for (const { from, to } of continuity.links) for (const c of [from, to]) channels.set(`${c.localDid} ${c.peerDid}`, c);
  for (const c of probes) channels.set(`${c.localDid} ${c.peerDid}`, c);
  const events = [...set.of("message.in"), ...set.of("did.rotationSelected")];
  return {
    links: continuity.links,
    conflicts: continuity.conflicts,
    unconfirmed: continuity.unconfirmed,
    statuses: events.map((event) => [event.eventId, continuity.status(event.eventId)]),
    witnesses: set.of("message.in").map((event) => [event.eventId, continuity.witness(event.eventId)]),
    channels: [...channels.values()].sort(compareChannels).map((c) => ({
      channel: c,
      head: continuity.head(c),
      superseded: continuity.superseded(c),
      conflicted: continuity.conflicted(c),
      blocked: continuity.blocked(c).map((event) => event.eventId),
      decisions: continuity.decisionsIn(c).map((decision) => decision.event.eventId).sort(),
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

/** Evidence handed to the fold rather than derived: peer links and nothing else, when only the shape of the graph is at stake. */
const peerLinksOnly = (peerLinks: readonly PeerLink[]): ChannelEvidence => ({
  sources: new Map(),
  receipts: { nextReceiptOrdinal: 0n, conflicts: [], affected: new Set() },
  carriers: new Map(),
  peerLinks,
  decisions: new Map(),
  localLinks: [],
  positive: () => false,
});

describe("a peer link", () => {
  it("replaces the peer in its own channel — head, supersession, confirmation and ACK path — and leaves the same peer DID's unrelated channel alone", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const old = proofFreeReceipt(scene, a0, b0, 1);
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    proofFreeReceipt(scene, a1, b0, 3);
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.links).toEqual([link(channel(a0, b0), channel(a0, b1), "peer", [carrier], [])]);
    expect(c.conflicts).toEqual([]);
    expect(c.status(old.eventId)).toEqual({ status: "not-present" });
    expect(c.status(carrier.eventId)).toEqual({ status: "verified" });
    expect(c.witness(carrier.eventId)).toEqual({ status: "complete" });
    expect(c.head(channel(a0, b0))).toEqual(channel(a0, b1));
    expect(c.head(channel(a0, b1))).toEqual(channel(a0, b1));
    expect(c.superseded(channel(a0, b0))).toBe(true);
    expect(c.superseded(channel(a0, b1))).toBe(false);
    expect(c.head(channel(a1, b0))).toEqual(channel(a1, b0));
    expect(c.superseded(channel(a1, b0))).toBe(false);
    expect(c.confirmed(a0.did, b1.did)).toBe(true);
    expect(c.confirmed(a0.did, b0.did)).toBe(true);
    expect(c.confirmed(a1.did, b1.did)).toBe(false);
    expect(c.confirmed(a1.did, b0.did)).toBe(true);
    expect(c.ackPath(channel(a0, b0), channel(a0, b1))).toBe(true);
    expect(c.ackPath(channel(a0, b1), channel(a0, b0))).toBe(false);
    expect(c.ackPath(channel(a0, b0), channel(a1, b0))).toBe(false);
    expect(c.ackPath(channel(a1, b0), channel(a1, b0))).toBe(true);
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b0)]);
  });
});

describe("a local decision", () => {
  it("enters the graph only once the peer has written to exactly the predecessor: not to the successor, not from another peer", async () => {
    const { scene, keys, a0, a1, b0, b2 } = await vaults();
    const manual = await rotation(scene, keys, { from: a0, peer: b0, to: a1 });
    proofFreeReceipt(scene, a1, b0, 1);
    proofFreeReceipt(scene, a0, b2, 2);
    let vault = await fold(scene, keys);
    expect(vault.channels.decisions.get(manual.eventId)!.status.status).toBe("candidate");
    expect(vault.continuity.unconfirmed.get(manual.eventId)).toMatchObject({ decision: manual.eventId, from: channel(a0, b0), to: channel(a1, b0) });
    expect(vault.continuity.status(manual.eventId)).toEqual({ status: "pending-history", because: "no complete source from the peer or a verified successor is addressed to the predecessor" });
    expect(vault.continuity.links).toEqual([]);
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a0, b0));
    expect(vault.continuity.decisionsIn(channel(a0, b0)).map((decision) => decision.event)).toEqual([manual]);
    expect(vault.continuity.decisionsIn(channel(a0, b2))).toEqual([]);
    expectSameOverEveryOrder(scene, vault.checks, [channel(a0, b0)]);

    proofFreeReceipt(scene, a0, b0, 3);
    vault = await fold(scene, keys);
    expect(vault.continuity.unconfirmed.size).toBe(0);
    expect(vault.continuity.status(manual.eventId)).toEqual({ status: "verified" });
    expect(vault.continuity.links).toEqual([link(channel(a0, b0), channel(a1, b0), "local", [], [manual])]);
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a1, b0));
    expect(vault.continuity.superseded(channel(a0, b0))).toBe(false);
    expect(vault.continuity.confirmed(a1.did, b0.did)).toBe(true);
    expect(vault.continuity.ackPath(channel(a0, b0), channel(a1, b0))).toBe(true);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is confirmed by its own source, which does not depend on the decision", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const sourced = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const { continuity } = await fold(scene, keys);
    expect(continuity.status(sourced.eventId)).toEqual({ status: "verified" });
    expect(continuity.links).toEqual([link(channel(a0, b0), channel(a1, b0), "local", [], [sourced])]);
  });

  it("passes through what the evidence already refused or is waiting for", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const wire = uuidv7() as WireMessageId;
    const anonymous = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, wire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventId: null, did: null, presentedDid: null } });
    const invalid = await rotation(scene, keys, { from: a0, peer: b0, to: a1, fromPrior: await proof(keys, a0, a2) });
    const conflict = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: anonymous });
    const pending = await rotation(scene, keys, { from: a0, peer: b0, to: { didId: "019b7000-0000-7000-8000-000000000c00" as Local["didId"], did: a1.did, longFormDid: a1.longFormDid } });
    const { continuity } = await fold(scene, keys);
    expect(continuity.status(invalid.eventId)).toEqual({ status: "invalid", because: "the proof's sub is not the successor's long form" });
    expect(continuity.status(conflict.eventId)).toEqual({ status: "conflict", because: "the source is anonymous, in no pair" });
    expect(continuity.status(pending.eventId)).toEqual({ status: "pending-history", because: "the successor entity has no consistent creation here" });
    expect(continuity.status(uuidv7() as EventId)).toEqual({ status: "pending-history", because: "no carrier or decision here has this ID" });
    expect(continuity.links).toEqual([]);
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
    expect(c.links).toEqual(
      sortedLinks([
        link(channel(a0, b0), channel(a0, b1), "peer", [carrier], []),
        link(channel(a0, b0), channel(a1, b0), "local", [], [decision]),
        link(channel(a0, b1), channel(a1, b1), "local", [carrier], [decision]),
        link(channel(a1, b0), channel(a1, b1), "peer", [carrier], [decision]),
        link(channel(a2, b0), channel(a2, b1), "peer", [elsewhere], []),
      ])
    );
    expect(c.conflicts).toEqual([]);
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
    expect(c.confirmed(a1.did, b1.did)).toBe(false);
    expect(c.confirmed(a0.did, b0.did)).toBe(true);
    expectSameOverEveryOrder(scene, vault.checks, [channel(a0, b2)]);
  });

  it("reuses the decision throughout its peer-only context: a second successor from the same predecessor competes, extending the successor needs its own confirmation", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const first = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    const extension = await rotation(scene, keys, { from: a1, peer: b1, to: a2 });
    let vault = await fold(scene, keys);
    expect(vault.continuity.unconfirmed.has(extension.eventId)).toBe(true);
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a1, b1));
    expect(vault.continuity.decisionsIn(channel(a1, b0)).map((d) => d.event)).toEqual([extension]);
    expect(vault.continuity.conflicts).toEqual([]);

    proofFreeReceipt(scene, a1, b1, 3);
    vault = await fold(scene, keys);
    expect(vault.continuity.status(extension.eventId)).toEqual({ status: "verified" });
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a2, b1));
    expect(vault.continuity.links).toHaveLength(5);
    expectSameOverEveryOrder(scene, vault.checks);

    const competing = await rotation(scene, keys, { from: a0, peer: b1, to: a2, source: carrier });
    vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.conflicts).toEqual([
      {
        kind: "competing-local-successors",
        context: [channel(a0, b0), channel(a0, b1)].sort(compareChannels),
        successors: [channel(a1, b0), channel(a1, b1), channel(a2, b1)].sort(compareChannels),
      },
    ]);
    expect(c.decisionsIn(channel(a0, b1)).map((d) => d.event)).toEqual([first, competing]);
    for (const event of [first, carrier, extension]) expect(c.status(event.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-local-successors" });
    expect(c.status(competing.eventId)).toEqual({ status: "conflict", because: "its source is no complete witness: its context is in conflict: competing-local-successors" });
    expect(c.witness(carrier.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-local-successors" });
    expect(c.witness(source.eventId)).toEqual({ status: "complete" });
    for (const start of [channel(a0, b0), channel(a0, b1), channel(a1, b0), channel(a1, b1), channel(a2, b1)]) expect(c.head(start)).toBeNull();
    expect(c.links).toHaveLength(6);
    expect(c.confirmed(a0.did, b0.did)).toBe(false);
    expect(c.ackPath(channel(a0, b0), channel(a1, b1))).toBe(false);
    expectSameOverEveryOrder(scene, vault.checks);
  });
});

describe("conflicts", () => {
  it("competing peer successors in one local-only context, straight from one pair or across a local link, mask every channel involved and choose no winner", async () => {
    const direct = await vaults();
    const one = await receiptCarryingProof(direct.scene, direct.peerKeys, direct.a0, direct.b0, direct.b1, 1);
    const two = await receiptCarryingProof(direct.scene, direct.peerKeys, direct.a0, direct.b0, direct.b2, 2);
    let vault = await fold(direct.scene, direct.keys);
    let c = vault.continuity;
    const { a0, a1, b0, b1, b2 } = direct;
    expect(c.conflicts).toEqual([{ kind: "competing-peer-successors", context: [channel(a0, b0)], successors: [channel(a0, b1), channel(a0, b2)].sort(compareChannels) }]);
    expect(c.links).toHaveLength(2);
    for (const event of [one, two]) {
      expect(c.status(event.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-peer-successors" });
      expect(c.witness(event.eventId)).toMatchObject({ status: "conflict" });
    }
    for (const start of [channel(a0, b0), channel(a0, b1), channel(a0, b2)]) expect(c.head(start)).toBeNull();
    expect(c.superseded(channel(a0, b0))).toBe(true);
    expect(c.confirmed(a0.did, b0.did)).toBe(false);
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
    expect(c.conflicts).toMatchObject([{ kind: "competing-peer-successors", context: [channel(a0, b0), channel(a1, b0)].sort(compareChannels) }]);
    expect(c.conflicted(channel(a1, b2))).toBe(true);
    expect(c.status(late.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-peer-successors" });
    expect(c.head(channel(a0, b0))).toBeNull();
    expect(c.head(channel(a1, b0))).toBeNull();
    expect(c.superseded(channel(a0, b0))).toBe(true);
    expectSameOverEveryOrder(across.scene, vault.checks);
  });

  it("a cycle of replacements grants nothing, and a join that would pair a DID with itself is refused as an identity conflict", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const forth = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
    const back = await receiptCarryingProof(scene, peerKeys, a0, b1, b0, 2);
    let vault = await fold(scene, keys);
    let c = vault.continuity;
    expect(c.conflicts).toEqual([{ kind: "cycle", channels: [channel(a0, b0), channel(a0, b1)].sort(compareChannels) }]);
    for (const event of [forth, back]) expect(c.status(event.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: cycle" });
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
    expect(vault.channels.positive(claimed.eventId)).toBe(true);
    expect(c.conflicts).toEqual([{ kind: "identity", channels: [channel(a0, b0), channel(a1, b0), channel(a0, a1)] }]);
    expect(c.links).toHaveLength(2);
    expect(c.head(channel(a0, b0))).toBeNull();
    expect(c.status(claimed.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: identity" });
    expectSameOverEveryOrder(identity.scene, vault.checks);
  });

  it("ahead of a channel leave it no default head: a fork or a cycle beyond a replacement never hands the default back to the channel the replacement left", async () => {
    const forked = await vaults();
    {
      const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = forked;
      const first = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
      await receiptCarryingProof(scene, peerKeys, a0, b1, b2, 2);
      expect((await fold(scene, keys)).continuity.head(channel(a0, b0))).toEqual(channel(a0, b2));
      await receiptCarryingProof(scene, peerKeys, a0, b1, b3, 3);
      const vault = await fold(scene, keys);
      const c = vault.continuity;
      expect(c.conflicts).toEqual([{ kind: "competing-peer-successors", context: [channel(a0, b1)], successors: [channel(a0, b2), channel(a0, b3)].sort(compareChannels) }]);
      expect(c.conflicted(channel(a0, b0))).toBe(false);
      expect(c.superseded(channel(a0, b0))).toBe(true);
      expect(c.status(first.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-peer-successors" });
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
      expect(c.conflicts).toEqual([{ kind: "cycle", channels: [channel(a0, b2), channel(a0, b3)].sort(compareChannels) }]);
      expect(c.status(first.eventId)).toEqual({ status: "verified" });
      expect(c.links.find((l) => sameChannel(l.to, channel(a0, b1)))!.verified).toBe(true);
      expect(c.ackPath(channel(a0, b0), channel(a0, b1))).toBe(true);
      expect(c.head(channel(a0, b0))).toBeNull();
      expect(c.head(channel(a0, b1))).toBeNull();
      expectSameOverEveryOrder(scene, vault.checks);
    }
  });
});

describe("authority behind a conflict", () => {
  it("lets a carrier a conflict masks confirm no decision: the decision waits for a witness the conflict does not reach", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b2, b3 } = await vaults();
    const one = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
    const two = await receiptCarryingProof(scene, peerKeys, a0, b0, b2, 2);
    const beyond = await receiptCarryingProof(scene, peerKeys, a0, b1, b3, 3);
    const manual = await rotation(scene, keys, { from: a0, peer: b3, to: a1 });
    let vault = await fold(scene, keys);
    let c = vault.continuity;
    expect(c.conflicts).toEqual([{ kind: "competing-peer-successors", context: [channel(a0, b0)], successors: [channel(a0, b1), channel(a0, b2)].sort(compareChannels) }]);
    expect(c.status(beyond.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-peer-successors" });
    expect(c.witness(beyond.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-peer-successors" });
    expect(c.confirmed(a0.did, b3.did)).toBe(false);
    expect(c.unconfirmed.size).toBe(0);
    expect(c.status(manual.eventId)).toEqual({ status: "conflict", because: "the predecessor is confirmed only through conflicted continuity" });
    expect(c.links).toEqual(
      sortedLinks([
        link(channel(a0, b0), channel(a0, b1), "peer", [one], [], false),
        link(channel(a0, b0), channel(a0, b2), "peer", [two], [], false),
        link(channel(a0, b1), channel(a0, b3), "peer", [beyond], [], false),
        link(channel(a0, b3), channel(a1, b3), "local", [], [manual], false),
      ])
    );
    expect(c.conflicted(channel(a0, b3))).toBe(false);
    expect(c.ackPath(channel(a0, b3), channel(a1, b3))).toBe(false);
    expect(c.head(channel(a0, b3))).toBeNull();
    expect(c.head(channel(a0, b1))).toBeNull();
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b3)]);

    proofFreeReceipt(scene, a0, b3, 4);
    vault = await fold(scene, keys);
    c = vault.continuity;
    expect(c.confirmed(a0.did, b3.did)).toBe(true);
    expect(c.status(manual.eventId)).toEqual({ status: "verified" });
    expect(c.links.find((l) => l.replaces === "local")).toEqual(link(channel(a0, b3), channel(a1, b3), "local", [], [manual]));
    expect(c.ackPath(channel(a0, b3), channel(a1, b3))).toBe(true);
    expect(c.head(channel(a0, b3))).toEqual(channel(a1, b3));
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b3)]);
  });

  it("keeps a sourced decision to its masked source whatever else confirms the predecessor, and transports nothing of it through a join until an unmasked decision joins", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b2, b3 } = await vaults();
    const b4 = await peerDid(peerKeys, "019b7000-0000-7000-8000-000000000b04" as DidId);
    const one = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 1);
    const two = await receiptCarryingProof(scene, peerKeys, a0, b0, b2, 2);
    const beyond = await receiptCarryingProof(scene, peerKeys, a0, b1, b3, 3);
    proofFreeReceipt(scene, a0, b3, 4);
    const sourced = await rotation(scene, keys, { from: a0, peer: b3, to: a1, source: beyond });
    const onward = await receiptCarryingProof(scene, peerKeys, a0, b3, b4, 5);
    let vault = await fold(scene, keys);
    let c = vault.continuity;
    expect(c.conflicts).toHaveLength(1);
    expect(c.confirmed(a0.did, b3.did)).toBe(true);
    expect(c.status(sourced.eventId)).toEqual({ status: "conflict", because: "its source is no complete witness: its context is in conflict: competing-peer-successors" });
    expect(c.status(onward.eventId)).toEqual({ status: "verified" });
    expect(c.links).toEqual(
      sortedLinks([
        link(channel(a0, b0), channel(a0, b1), "peer", [one], [], false),
        link(channel(a0, b0), channel(a0, b2), "peer", [two], [], false),
        link(channel(a0, b1), channel(a0, b3), "peer", [beyond], [], false),
        link(channel(a0, b3), channel(a1, b3), "local", [], [sourced], false),
        link(channel(a0, b3), channel(a0, b4), "peer", [onward], []),
        link(channel(a0, b4), channel(a1, b4), "local", [onward], [sourced], false),
        link(channel(a1, b3), channel(a1, b4), "peer", [onward], [sourced], false),
      ])
    );
    expect(c.ackPath(channel(a0, b3), channel(a1, b4))).toBe(false);
    expect(c.ackPath(channel(a0, b3), channel(a0, b4))).toBe(true);
    expect(c.head(channel(a0, b3))).toBeNull();
    expect(c.head(channel(a0, b4))).toBeNull();
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b3), channel(a1, b4)]);

    const manual = await rotation(scene, keys, { from: a0, peer: b3, to: a1 });
    vault = await fold(scene, keys);
    c = vault.continuity;
    expect(c.conflicts).toHaveLength(1);
    expect(c.status(manual.eventId)).toEqual({ status: "verified" });
    expect(c.status(sourced.eventId)).toEqual({ status: "conflict", because: "its source is no complete witness: its context is in conflict: competing-peer-successors" });
    expect(c.decisionsIn(channel(a0, b3)).map((d) => d.event)).toEqual([sourced, manual]);
    expect(c.links.filter((l) => !l.verified).map((l) => l.to).sort(compareChannels)).toEqual([channel(a0, b1), channel(a0, b2), channel(a0, b3)].sort(compareChannels));
    expect(c.ackPath(channel(a0, b3), channel(a1, b4))).toBe(true);
    expect(c.head(channel(a0, b3))).toEqual(channel(a1, b4));
    expectSameOverEveryOrder(scene, vault.checks, [channel(a1, b3), channel(a1, b4)]);
  });

  it("derives no join through a conflicted channel: what a masked intermediate would transport reaches no descendant, while an independent decision still supports the same descendant", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b2, b3 } = await vaults();
    const a3 = await createdDid(scene, keys, "019b6a10-12c0-7410-89ab-38e54b097c22" as DidId, ROUTE, MEDIATED);
    const b4 = await peerDid(peerKeys, "019b7000-0000-7000-8000-000000000b04" as DidId);
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
    expect(c.conflicts).toEqual([{ kind: "competing-local-successors", context: [channel(a3, b3)], successors: [channel(a0, b3), channel(a1, b3)].sort(compareChannels) }]);
    for (const event of [good, first, next]) expect(c.status(event.eventId)).toEqual({ status: "verified" });
    for (const event of [forkOne, forkTwo]) expect(c.status(event.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-local-successors" });
    expect(c.links).toEqual(
      sortedLinks([
        link(channel(a3, b3), channel(a1, b3), "local", [], [forkOne], false),
        link(channel(a3, b3), channel(a0, b3), "local", [], [forkTwo], false),
        link(channel(a2, b2), channel(a1, b2), "local", [], [good]),
        link(channel(a2, b2), channel(a2, b3), "peer", [first], []),
        link(channel(a2, b3), channel(a2, b4), "peer", [next], []),
        link(channel(a2, b3), channel(a1, b3), "local", [first], [good], false),
        link(channel(a1, b2), channel(a1, b3), "peer", [first], [good], false),
        link(channel(a2, b4), channel(a1, b4), "local", [first, next], [good], false),
        link(channel(a1, b3), channel(a1, b4), "peer", [first, next], [good], false),
      ])
    );
    expect(c.conflicted(channel(a2, b4)) || c.conflicted(channel(a1, b4))).toBe(false);
    expect(c.ackPath(channel(a2, b3), channel(a1, b3))).toBe(false);
    expect(c.ackPath(channel(a2, b4), channel(a1, b4))).toBe(false);
    expect(c.head(channel(a2, b4))).toBeNull();
    expect(c.head(channel(a2, b2))).toBeNull();
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
    expect(c.status(independent.eventId)).toEqual({ status: "verified" });
    expect(c.ackPath(channel(a2, b4), channel(a1, b4))).toBe(true);
    expect(c.head(channel(a2, b3))).toEqual(channel(a1, b4));
    expect(c.head(channel(a2, b4))).toEqual(channel(a1, b4));
    expectSameOverEveryOrder(control.scene, vault.checks);
  });
});

describe("a long history", () => {
  it("closes a replacement history tens of thousands deep and finds the cycle that closes it, on a stack of its own", () => {
    const depth = 20_000;
    const a0 = "did:peer:4zQmLocal" as Did;
    const peerAt = (i: number) => `did:peer:4zQmPeer${String(i).padStart(5, "0")}` as Did;
    const peerLinks: PeerLink[] = [];
    for (let i = 1; i <= depth; i++) peerLinks.push({ from: channelOf(a0, peerAt(i - 1)), to: channelOf(a0, peerAt(i)), carrier: uuidv7() as EventId });
    let c = foldContinuity(VaultEventSet.of([]), peerLinksOnly(peerLinks));
    expect(c.links).toHaveLength(depth);
    expect(c.conflicts).toEqual([]);
    expect(c.superseded(channelOf(a0, peerAt(0)))).toBe(true);
    expect(c.superseded(channelOf(a0, peerAt(depth)))).toBe(false);

    peerLinks.push({ from: channelOf(a0, peerAt(depth)), to: channelOf(a0, peerAt(0)), carrier: uuidv7() as EventId });
    c = foldContinuity(VaultEventSet.of([]), peerLinksOnly(peerLinks));
    expect(c.conflicts).toEqual([{ kind: "cycle", channels: Array.from({ length: depth + 1 }, (_, i) => channelOf(a0, peerAt(i))).sort(compareChannels) }]);
    expect(c.conflicted(channelOf(a0, peerAt(depth / 2)))).toBe(true);
    expect(c.head(channelOf(a0, peerAt(0)))).toBeNull();
  });
});

describe("denial", () => {
  it("follows the evidence through a conflicted branch: a fork lets no successor escape a denial", async () => {
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

  it("covers the pair itself, and its verified successors through links and joins only when the denial says so", async () => {
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

describe("status and witness", () => {
  it("give each carrier one of the six states and each source what it witnesses, a contradiction over an absence", async () => {
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
    const anonymous = receipt(scene, { local: a0, peer: b0, resolution: root1, ordinal: 7, wire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventId: null, did: null, presentedDid: null } });
    const vault = await fold(scene, keys);
    const c = vault.continuity;
    expect(c.status(proofFree.eventId)).toEqual({ status: "not-present" });
    expect(c.status(pendingProof.eventId)).toEqual({ status: "pending-proof" });
    expect(c.status(pendingHistory.eventId)).toEqual({ status: "pending-history", because: "the carrier's own authentication is incomplete: the resolution's document is not here" });
    expect(c.status(invalid.eventId)).toEqual({ status: "invalid", because: "not a compact JWT" });
    expect(c.status(contradicted.eventId)).toEqual({ status: "invalid", because: `the carrier's own authentication is contradicted: ${signingKey.data.peerPublicKey} is a Ed25519 key, which agrees no keys` });
    expect(c.status(verified.eventId)).toEqual({ status: "verified" });
    expect(c.status(anonymous.eventId)).toEqual({ status: "not-present" });
    expect(c.witness(proofFree.eventId)).toEqual({ status: "complete" });
    expect(c.witness(pendingProof.eventId)).toEqual({ status: "pending", because: "the proof is not yet verified" });
    expect(c.witness(pendingHistory.eventId)).toEqual({ status: "pending", because: "the resolution's document is not here" });
    expect(c.witness(invalid.eventId)).toEqual({ status: "invalid", because: "not a compact JWT" });
    expect(c.witness(contradicted.eventId)).toEqual({ status: "conflict", because: `${signingKey.data.peerPublicKey} is a Ed25519 key, which agrees no keys` });
    expect(c.witness(verified.eventId)).toEqual({ status: "complete" });
    expect(c.witness(anonymous.eventId)).toEqual({ status: "invalid", because: "the source is anonymous, in no pair" });
    expect(c.witness(uuidv7() as EventId)).toEqual({ status: "pending", because: "the source is not here" });
    expect(c.links).toEqual([link(channel(a0, b0), channel(a0, b1), "peer", [verified], [])]);
    expectSameOverEveryOrder(scene, vault.checks);

    const restored = await fold(scene, keys, async (cid) => (cid === b1.resolution.cid ? b1.resolution.bytes : null));
    expect(restored.continuity.status(pendingHistory.eventId)).toEqual({ status: "verified" });
    expect(restored.continuity.links[0]!.carriers).toEqual([pendingHistory.eventId, verified.eventId].sort());
  });

  it("without the checks beside the fold, every link waits and no channel is replaced", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0, 1);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await receiptCarryingProof(scene, peerKeys, a0, b0, b1, 2);
    const set = VaultEventSet.of(scene.events);
    const unchecked = foldVault(set).continuity;
    expect(unchecked.links).toEqual([]);
    expect(unchecked.status(carrier.eventId)).toEqual({ status: "pending-proof" });
    expect(unchecked.status(decision.eventId)).toEqual({ status: "pending-history", because: "the predecessor entity's keys are not yet checked against the seed" });
    expect(unchecked.witness(source.eventId)).toEqual({ status: "pending", because: "the local entity's keys are not yet checked against the seed" });
    expect(unchecked.head(channel(a0, b0))).toEqual(channel(a0, b0));
    const checked = foldVault(set, await checkVault(set, keys, noObjects)).continuity;
    expect(checked.head(channel(a0, b0))).toEqual(channel(a1, b1));
  });
});
