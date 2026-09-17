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
  foldVault,
  foldVaultChecked,
  methodPublicKey,
  type Channel,
  type ContinuityLink,
  type Keys,
  type ReadObject,
  type VaultChecks,
  type VaultFold,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { expectOrderFree, type Scene } from "./helpers.js";
import { IAT, asPeer, blocked, channel, noObjects, proof, receipt, resolved, rotation, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);

/** An authenticated proof-free receipt from the peer at one of our DIDs, its resolution recorded alongside. */
const plain = (scene: Scene, local: Local, peer: Peer, ordinal: number) => receipt(scene, { local, peer, resolution: resolved(scene, local.didId, peer), ordinal });

/** A receipt from `successor` at one of our DIDs carrying the peer's proof that it continues `predecessor`. */
const carrying = async (scene: Scene, peerKeys: Keys, local: Local, predecessor: Peer, successor: Peer, ordinal: number) =>
  receipt(scene, { local, peer: successor, resolution: resolved(scene, local.didId, successor), ordinal, fromPrior: await proof(peerKeys, predecessor, successor) });

const link = (from: Channel, to: Channel, replaces: "local" | "peer", carriers: Event[], decisions: Event[]): ContinuityLink => ({
  from,
  to,
  replaces,
  carriers: carriers.map((event) => event.eventId).sort(),
  decisions: decisions.map((event) => event.eventId).sort(),
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

describe("a peer link", () => {
  it("replaces the peer in its own channel — head, supersession, confirmation and ACK path — and leaves the same peer DID's unrelated channel alone", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const old = plain(scene, a0, b0, 1);
    const carrier = await carrying(scene, peerKeys, a0, b0, b1, 2);
    plain(scene, a1, b0, 3);
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
    plain(scene, a1, b0, 1);
    plain(scene, a0, b2, 2);
    let vault = await fold(scene, keys);
    expect(vault.channels.decisions.get(manual.eventId)!.status.status).toBe("candidate");
    expect(vault.continuity.unconfirmed.get(manual.eventId)).toMatchObject({ decision: manual.eventId, from: channel(a0, b0), to: channel(a1, b0) });
    expect(vault.continuity.status(manual.eventId)).toEqual({ status: "pending-history", because: "no complete source from the peer or a verified successor is addressed to the predecessor" });
    expect(vault.continuity.links).toEqual([]);
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a0, b0));
    expect(vault.continuity.decisionsIn(channel(a0, b0)).map((decision) => decision.event)).toEqual([manual]);
    expect(vault.continuity.decisionsIn(channel(a0, b2))).toEqual([]);
    expectSameOverEveryOrder(scene, vault.checks, [channel(a0, b0)]);

    plain(scene, a0, b0, 3);
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
    const source = plain(scene, a0, b0, 1);
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
    const source = plain(scene, a0, b0, 1);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await carrying(scene, peerKeys, a0, b0, b1, 2);
    const elsewhere = await carrying(scene, peerKeys, a2, b0, b1, 3);
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
    const source = plain(scene, a0, b0, 1);
    const first = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await carrying(scene, peerKeys, a0, b0, b1, 2);
    const extension = await rotation(scene, keys, { from: a1, peer: b1, to: a2 });
    let vault = await fold(scene, keys);
    expect(vault.continuity.unconfirmed.has(extension.eventId)).toBe(true);
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a1, b1));
    expect(vault.continuity.decisionsIn(channel(a1, b0)).map((d) => d.event)).toEqual([extension]);
    expect(vault.continuity.conflicts).toEqual([]);

    plain(scene, a1, b1, 3);
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
    for (const event of [first, competing, carrier, extension]) expect(c.status(event.eventId)).toEqual({ status: "conflict", because: "its context is in conflict: competing-local-successors" });
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
    const one = await carrying(direct.scene, direct.peerKeys, direct.a0, direct.b0, direct.b1, 1);
    const two = await carrying(direct.scene, direct.peerKeys, direct.a0, direct.b0, direct.b2, 2);
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
    const source = plain(across.scene, across.a0, across.b0, 1);
    await rotation(across.scene, across.keys, { from: across.a0, peer: across.b0, to: across.a1, source });
    await carrying(across.scene, across.peerKeys, across.a0, across.b0, across.b1, 2);
    const late = await carrying(across.scene, across.peerKeys, across.a1, across.b0, across.b2, 3);
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
    const forth = await carrying(scene, peerKeys, a0, b0, b1, 1);
    const back = await carrying(scene, peerKeys, a0, b1, b0, 2);
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
    const source = plain(identity.scene, identity.a0, identity.b0, 1);
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
});

describe("denial", () => {
  it("covers the pair itself, and its verified successors through links and joins only when the denial says so", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1 } = await vaults();
    const source = plain(scene, a0, b0, 1);
    await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    await carrying(scene, peerKeys, a0, b0, b1, 2);
    await carrying(scene, peerKeys, a2, b0, b1, 3);
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
    const proofFree = plain(scene, a0, b0, 1);
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
    const source = plain(scene, a0, b0, 1);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const carrier = await carrying(scene, peerKeys, a0, b0, b1, 2);
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
