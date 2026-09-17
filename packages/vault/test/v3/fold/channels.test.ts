import type { Event, EventId, JsonObject } from "@estoc/event-store/v3";
import { SignJWT, importJWK } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_METHOD,
  VaultEventSet,
  anonymousMessageId,
  authorizedMethodIds,
  didKeyName,
  foldChannelEvidence,
  foldReceipts,
  foldVault,
  methodPublicKey,
  peerResolution,
  receiptOrderKey,
  type ChannelChecks,
  type ChannelEvidence,
  type Cid,
  type DidId,
  type EventReference,
  type Keys,
  type ReadObject,
  type VaultData,
  type VaultEvent,
  type WireMessageId,
} from "../../../src/v3/index.js";
import { AUTHOR2, checksOf, expectOrderFree, foldChecked, snapshot, type KeyChecks, type Scene } from "./helpers.js";
import { IAT, channel, evidenceChecks, noObjects, proof, receipt, resolved, rotation, vaults, type Local, type Peer } from "./scene.js";

const UNCREATED = "019b7000-0000-7000-8000-000000000c00" as DidId;
const readerOf = (objects: Map<Cid, Uint8Array>) => async (wanted: Cid) => objects.get(wanted) ?? null;
const segments = (jwt: string) => jwt.split(".") as [string, string, string];

/** A proof under any header and claims, signed by the authentication key a seed derives for an entity. */
async function resign(keys: Keys, didId: DidId, header: Record<string, unknown>, payload: JsonObject): Promise<string> {
  const key = await keys.signing(didKeyName(didId, "authentication"));
  return new SignJWT(payload)
    .setProtectedHeader(header as never)
    .sign(await importJWK(key.privateJwk(), "EdDSA"));
}

/** Our own DID as a peer would present it: what a message claiming to come from ourselves names. */
function asPeer(local: Local): Peer {
  const resolution = peerResolution(local.longFormDid);
  const [keyAgreement] = authorizedMethodIds(resolution.document, "keyAgreement");
  return { didId: local.didId, did: local.did, longFormDid: local.longFormDid, resolution, publicKey: methodPublicKey(resolution.document, keyAgreement!) };
}

type Folded = { evidence: ChannelEvidence; checks: KeyChecks; proofs: Required<ChannelChecks> };

async function fold(scene: Scene, keys: Keys, readObject: ReadObject = noObjects, proofs?: Required<ChannelChecks>): Promise<Folded> {
  const checks = await checksOf(scene.events, keys);
  const evidence = proofs ?? (await evidenceChecks(scene.events, readObject));
  const set = scene.set();
  return { evidence: foldChannelEvidence(set, foldChecked(set, checks).routes, evidence), checks, proofs: evidence };
}

/** The evidence as comparable JSON, the positive sources listed since `positive` is a function. */
const readable = (evidence: ChannelEvidence) => ({ ...evidence, positives: [...evidence.sources.keys()].filter(evidence.positive).sort() });

function expectSameOverEveryOrder(events: readonly Event[], checks: KeyChecks, proofs: Required<ChannelChecks>): void {
  expectOrderFree(events, (set) => readable(foldChannelEvidence(set, foldChecked(set, checks).routes, proofs)));
}

describe("foldSources", () => {
  it("gives an authenticated receipt its entity, channel and complete standing, and an anonymous one no channel", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const authenticated = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const wire = uuidv7() as WireMessageId;
    const anonymous = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, wire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventId: null, did: null, presentedDid: null } });
    const { evidence } = await fold(scene, keys);
    expect(evidence.sources.get(authenticated.eventId)).toMatchObject({ localDidId: a0.didId, resolution: root, channel: channel(a0, b0), standing: { status: "complete" } });
    expect(evidence.sources.get(anonymous.eventId)).toMatchObject({ localDidId: a0.didId, resolution: null, channel: null, standing: { status: "complete" } });
    expect(evidence.positive(authenticated.eventId)).toBe(true);
    expect(evidence.positive(anonymous.eventId)).toBe(false);
    expect(evidence.positive(uuidv7() as EventId)).toBe(false);
    expect(evidence.carriers.size).toBe(0);
  });

  it("is incomplete while the local entity, the resolution or its document is missing, and a retired entity still receives", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const short = resolved(scene, a0.didId, b0, { short: true });
    const noEntity = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { localKeyName: didKeyName(UNCREATED, "key-agreement") } });
    const noResolution = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { peerResolutionEventId: uuidv7() as EventReference<"peer.resolved"> } });
    const noDocument = receipt(scene, { local: a0, peer: b0, resolution: short, ordinal: 3, presentedDid: b0.did });
    const retired = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4 });
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    const { evidence } = await fold(scene, keys);
    expect(evidence.sources.get(noEntity.eventId)).toMatchObject({ localDidId: null, channel: null, standing: { status: "incomplete", because: "no consistent communication DID derives the local key" } });
    expect(evidence.sources.get(noResolution.eventId)).toMatchObject({ channel: null, standing: { status: "incomplete", because: "the resolution it names is not here" } });
    expect(evidence.sources.get(noDocument.eventId)).toMatchObject({ resolution: short, channel: channel(a0, b0), standing: { status: "incomplete", because: "the resolution's document is not here" } });
    expect(evidence.sources.get(retired.eventId)).toMatchObject({ channel: channel(a0, b0), standing: { status: "complete" } });
    expect(evidence.positive(noDocument.eventId)).toBe(false);
    const withDocument = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    expect(withDocument.evidence.sources.get(noDocument.eventId)).toMatchObject({ standing: { status: "complete" } });
    expect(withDocument.evidence.positive(noDocument.eventId)).toBe(true);
  });

  it("is in conflict when the key, the resolution or the message ID contradicts the observation, or the sender is the recipient", async () => {
    const { scene, keys, a0, a1, b0, b2 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const otherKey = resolved(scene, a1.didId, b0);
    const forged = resolved(scene, a0.didId, b0, { documentCid: b2.resolution.cid, keyAgreementMethodIds: authorizedMethodIds(b2.resolution.document, "keyAgreement") });
    const self = resolved(scene, a0.didId, asPeer(a0));
    const authenticationKey = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { localKeyName: didKeyName(a0.didId, "authentication") } });
    const wrongType = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { peerResolutionEventId: scene.events[0]!.eventId as EventReference<"peer.resolved"> } });
    const notItsOwn = receipt(scene, { local: a0, peer: b0, resolution: otherKey, ordinal: 3 });
    const invalidSnapshot = receipt(scene, { local: a0, peer: b0, resolution: forged, ordinal: 4 });
    const wrongId = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 5, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), "x" as WireMessageId) } });
    const fromSelf = receipt(scene, { local: a0, peer: asPeer(a0), resolution: self, ordinal: 6 });
    const { evidence } = await fold(scene, keys);
    const because = (event: VaultEvent<"message.in">) => evidence.sources.get(event.eventId)!.standing;
    expect(because(authenticationKey)).toEqual({ status: "conflict", because: "the local key is not the entity's key-agreement key" });
    expect(because(wrongType)).toEqual({ status: "conflict", because: "the resolution it names is a mediation.created" });
    expect(because(notItsOwn)).toEqual({ status: "conflict", because: "the resolution it names is not of this sender at this key" });
    expect(because(invalidSnapshot)).toEqual({ status: "conflict", because: "the resolution's snapshot is not its document's" });
    expect(because(wrongId)).toMatchObject({ status: "conflict", because: expect.stringMatching(/^the message ID is not the one the endpoints and wire ID derive, /) });
    expect(because(fromSelf)).toEqual({ status: "conflict", because: "the sender is the recipient" });
    for (const event of [authenticationKey, wrongType, notItsOwn, invalidSnapshot, wrongId, fromSelf]) expect(evidence.sources.get(event.eventId)!.channel).toBeNull();
    expect(evidence.sources.get(invalidSnapshot.eventId)!.resolution).toBe(forged);
  });
});

describe("foldReceipts", () => {
  it("finds the next ordinal past every author's, and one author's reuse of an ordinal as a conflict over the messages it observed", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    expect(foldReceipts(scene.set())).toEqual({ nextReceiptOrdinal: 1n, conflicts: [], affected: new Set() });
    const first = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const twice = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2 });
    const again = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2 });
    const otherAuthor = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2 }, { author: AUTHOR2 });
    const far = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 5, overrides: { receiptOrdinal: "90071992547409920" as VaultData["message.in"]["receiptOrdinal"] } });
    scene.add("message.erased", { messageId: far.data.messageId, dropCids: [far.data.bodyCid], because: "user" });
    const { evidence } = await fold(scene, keys);
    expect(evidence.receipts).toEqual({ nextReceiptOrdinal: 90071992547409921n, conflicts: [[twice, again]], affected: new Set([twice.data.messageId, again.data.messageId]) });
    expect(evidence.receipts.affected.has(first.data.messageId)).toBe(false);
    expect(receiptOrderKey(otherAuthor)).toEqual({ ordinal: 2n, author: AUTHOR2 });
    expect(receiptOrderKey(far).ordinal).toBe(90071992547409920n);
  });
});

describe("foldCarriers", () => {
  it("derives a peer link from a verified long-form proof on a complete carrier, with no earlier message in the predecessor's channel", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const jwt = await proof(peerKeys, b0, b1);
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: jwt });
    const { evidence, checks, proofs } = await fold(scene, keys);
    expect(proofs.proofChecks.get(carrier.eventId)).toBe("verified");
    const link = { from: channel(a0, b0), to: channel(a0, b1), carrier: carrier.eventId };
    expect(evidence.carriers.get(carrier.eventId)).toMatchObject({ proof: { status: "verified", claims: { iss: b0.longFormDid, sub: b1.longFormDid, iat: IAT, predecessorDid: b0.did, successorDid: b1.did } }, link });
    expect(evidence.peerLinks).toEqual([link]);
    expect(evidence.positive(carrier.eventId)).toBe(true);
    expectSameOverEveryOrder(scene.events, checks, proofs);
  });

  it("a short-form issuer waits for a verified retained resolution of that DID, under either presented spelling, and needs its document", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const jwt = await resign(peerKeys, b0.didId, { alg: "EdDSA", typ: "JWT", kid: `${b0.did}${AUTHENTICATION_METHOD}` }, { iss: b0.did, sub: b1.longFormDid, iat: IAT });
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: jwt });
    const pending = await fold(scene, keys);
    expect(pending.proofs.proofChecks.has(carrier.eventId)).toBe(false);
    expect(pending.evidence.carriers.get(carrier.eventId)).toMatchObject({ proof: { status: "pending-proof" }, link: null, source: { standing: { status: "complete" } } });
    expect(pending.evidence.positive(carrier.eventId)).toBe(false);
    expect(pending.evidence.peerLinks).toEqual([]);

    const short = resolved(scene, a1.didId, b0, { short: true });
    const stillPending = await fold(scene, keys);
    expect(stillPending.evidence.carriers.get(carrier.eventId)!.proof).toEqual({ status: "pending-proof" });
    const withDocument = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    expect(withDocument.proofs.resolutionChecks.get(short.eventId)).toBe("verified");
    expect(withDocument.evidence.carriers.get(carrier.eventId)).toMatchObject({ proof: { status: "verified" }, link: { from: channel(a0, b0), to: channel(a0, b1) } });
    expect(withDocument.evidence.positive(carrier.eventId)).toBe(true);

    resolved(scene, a1.didId, b0);
    const withLongForm = await fold(scene, keys);
    expect(withLongForm.evidence.carriers.get(carrier.eventId)!.proof).toMatchObject({ status: "verified" });
    expectSameOverEveryOrder(scene.events, withLongForm.checks, withLongForm.proofs);
  });

  it("finds a proof invalid on the carrier's own evidence — wrong sub, wrong kid, no JWT at all — before any issuer material is asked for", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2 } = await vaults();
    const root1 = resolved(scene, a0.didId, b1);
    const root2 = resolved(scene, a0.didId, b2);
    const jwt = await proof(peerKeys, b0, b1);
    const wrongSub = receipt(scene, { local: a0, peer: b2, resolution: root2, ordinal: 1, fromPrior: jwt });
    const wrongKid = receipt(scene, { local: a0, peer: b1, resolution: root1, ordinal: 2, fromPrior: await resign(peerKeys, b0.didId, { alg: "EdDSA", kid: `${b1.longFormDid}${AUTHENTICATION_METHOD}` }, { iss: b0.longFormDid, sub: b1.longFormDid, iat: IAT }) });
    const notJwt = receipt(scene, { local: a0, peer: b1, resolution: root1, ordinal: 3, fromPrior: "hello" });
    const sameDid = receipt(scene, { local: a0, peer: b1, resolution: root1, ordinal: 4, fromPrior: await resign(peerKeys, b1.didId, { alg: "EdDSA", kid: `${b1.did}${AUTHENTICATION_METHOD}` }, { iss: b1.did, sub: b1.longFormDid, iat: IAT }) });
    const { evidence, proofs } = await fold(scene, keys);
    expect(proofs.proofChecks.get(wrongSub.eventId)).toBe("invalid");
    expect(evidence.carriers.get(wrongSub.eventId)!.proof).toEqual({ status: "invalid", because: "sub is the DID the message came from" });
    expect(evidence.carriers.get(wrongKid.eventId)!.proof).toEqual({ status: "invalid", because: "the kid DID portion is the iss DID" });
    expect(evidence.carriers.get(notJwt.eventId)!.proof).toEqual({ status: "invalid", because: "not a compact JWT" });
    expect(evidence.carriers.get(sameDid.eventId)!.proof).toEqual({ status: "invalid", because: "sub is another DID than iss" });
    for (const event of [wrongSub, wrongKid, notJwt, sameDid]) {
      expect(evidence.sources.get(event.eventId)!.standing).toEqual({ status: "complete" });
      expect(evidence.carriers.get(event.eventId)!.link).toBeNull();
      expect(evidence.positive(event.eventId)).toBe(false);
    }
    expect(evidence.peerLinks).toEqual([]);
  });

  it("finds a proof invalid whose signature the issuer's document refuses, or whose predecessor is our own DID", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const [header, payload] = segments(await proof(peerKeys, b0, b1));
    const badSignature = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: `${header}.${payload}.${segments(await proof(peerKeys, b0, b1, IAT + 1))[2]}` });
    const ourPredecessor = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, fromPrior: await proof(keys, a0, b1) });
    const { evidence, proofs } = await fold(scene, keys);
    expect(proofs.proofChecks.get(badSignature.eventId)).toBe("invalid");
    expect(evidence.carriers.get(badSignature.eventId)!.proof).toEqual({ status: "invalid", because: "the proof does not verify under the issuer's document" });
    expect(proofs.proofChecks.get(ourPredecessor.eventId)).toBe("verified");
    expect(evidence.carriers.get(ourPredecessor.eventId)!.proof).toEqual({ status: "invalid", because: "the predecessor is the local DID" });
    expect(evidence.peerLinks).toEqual([]);
    expect(evidence.positive(ourPredecessor.eventId)).toBe(false);
  });

  it("a link stands on one complete verified carrier while a sibling of the same message is incomplete or invalid, and lends that sibling nothing", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const jwt = await proof(peerKeys, b0, b1);
    const wire = uuidv7();
    const complete = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: jwt, wire });
    const unauthenticated = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, fromPrior: jwt, wire, overrides: { peerResolutionEventId: uuidv7() as EventReference<"peer.resolved"> } });
    const [header, payload] = segments(jwt);
    const broken = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 3, fromPrior: `${header}.${payload}.${segments(await proof(peerKeys, b0, b1, IAT + 1))[2]}`, wire });
    expect(new Set([complete, unauthenticated, broken].map((event) => event.data.messageId)).size).toBe(1);
    const { evidence, checks, proofs } = await fold(scene, keys);
    expect(evidence.peerLinks).toEqual([{ from: channel(a0, b0), to: channel(a0, b1), carrier: complete.eventId }]);
    expect(evidence.carriers.get(unauthenticated.eventId)).toMatchObject({ proof: { status: "verified" }, link: null, source: { standing: { status: "incomplete" } } });
    expect(evidence.carriers.get(broken.eventId)).toMatchObject({ proof: { status: "invalid" }, link: null, source: { standing: { status: "complete" } } });
    expect([complete, unauthenticated, broken].map((event) => evidence.positive(event.eventId))).toEqual([true, false, false]);
    expectSameOverEveryOrder(scene.events, checks, proofs);
  });

  it("keeps a verified proof through erasure of the message's content, the proof being event metadata", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: await proof(peerKeys, b0, b1) });
    scene.add("message.erased", { messageId: carrier.data.messageId, dropCids: [carrier.data.bodyCid], because: "user" });
    const { evidence } = await fold(scene, keys);
    expect(evidence.peerLinks).toHaveLength(1);
    expect(evidence.positive(carrier.eventId)).toBe(true);
  });
});

describe("foldDecisions", () => {
  it("makes a local-link candidate of a decision whose entities, proof and positive source in the old pair all check, and of a manual one", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const source = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const sourced = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const manual = await rotation(scene, keys, { from: a2, peer: b0, to: a1 });
    const { evidence, checks, proofs } = await fold(scene, keys);
    expect(proofs.proofChecks.get(sourced.eventId)).toBe("verified");
    const first = { from: channel(a0, b0), to: channel(a1, b0), decision: sourced.eventId, source: source.eventId };
    const second = { from: channel(a2, b0), to: channel(a1, b0), decision: manual.eventId, source: null };
    expect(evidence.decisions.get(sourced.eventId)).toEqual({ event: sourced, channel: channel(a0, b0), status: { status: "candidate", link: first } });
    expect(evidence.decisions.get(manual.eventId)).toEqual({ event: manual, channel: channel(a2, b0), status: { status: "candidate", link: second } });
    expect(evidence.localLinks).toEqual([first, second]);
    expectSameOverEveryOrder(scene.events, checks, proofs);
  });

  it("is pending while an entity's creation, the proof's verdict or the source is missing, or the source is not yet positive", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const short = resolved(scene, a0.didId, b0, { short: true });
    const unverified = receipt(scene, { local: a0, peer: b0, resolution: short, ordinal: 1, presentedDid: b0.did });
    const noSuccessor = await rotation(scene, keys, { from: a0, peer: b0, to: { didId: UNCREATED, did: a1.did, longFormDid: a1.longFormDid } });
    const noPredecessor = await rotation(scene, keys, { from: a0, peer: b0, to: a1, overrides: { fromDidId: UNCREATED } });
    const noSource = await rotation(scene, keys, { from: a0, peer: b0, to: a1, overrides: { sourceEventId: uuidv7() as EventReference<"message.in"> } });
    const unverifiedSource = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: unverified });
    const { evidence, checks, proofs } = await fold(scene, keys);
    const status = (event: VaultEvent<"did.rotationSelected">) => evidence.decisions.get(event.eventId)!.status;
    expect(status(noSuccessor)).toEqual({ status: "pending", because: "the successor entity has no consistent creation here" });
    expect(status(noPredecessor)).toEqual({ status: "pending", because: "the predecessor entity has no consistent creation here" });
    expect(evidence.decisions.get(noPredecessor.eventId)!.channel).toBeNull();
    expect(status(noSource)).toEqual({ status: "pending", because: "the source it names is not here" });
    expect(status(unverifiedSource)).toEqual({ status: "pending", because: "the source is not yet positive" });
    expect(evidence.localLinks).toEqual([]);
    const unchecked = foldChannelEvidence(scene.set(), foldChecked(scene.set(), checks).routes, { resolutionChecks: proofs.resolutionChecks });
    expect(unchecked.decisions.get(unverifiedSource.eventId)!.status).toEqual({ status: "pending", because: "the proof is not yet checked" });
    const withDocument = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    expect(withDocument.evidence.decisions.get(unverifiedSource.eventId)!.status).toMatchObject({ status: "candidate", link: { source: unverified.eventId } });
  });

  it("is invalid when the proof is not the two entities' exact long forms or does not verify, or the successor or peer is an old endpoint", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const wrongSub = await rotation(scene, keys, { from: a0, peer: b0, to: a1, fromPrior: await proof(keys, a0, a2) });
    const shortIss = await rotation(scene, keys, { from: a0, peer: b0, to: a1, fromPrior: await resign(keys, a0.didId, { alg: "EdDSA", kid: `${a0.did}${AUTHENTICATION_METHOD}` }, { iss: a0.did, sub: a1.longFormDid, iat: IAT }) });
    const [header, payload] = segments(await proof(keys, a0, a1));
    const badSignature = await rotation(scene, keys, { from: a0, peer: b0, to: a1, fromPrior: `${header}.${payload}.${segments(await proof(keys, a0, a1, IAT + 1))[2]}` });
    const otherKey = await rotation(scene, keys, { from: a0, peer: b0, to: a1, fromPrior: await resign(keys, a2.didId, { alg: "EdDSA", kid: `${a0.longFormDid}${AUTHENTICATION_METHOD}` }, { iss: a0.longFormDid, sub: a1.longFormDid, iat: IAT }) });
    const peerIsSelf = await rotation(scene, keys, { from: a0, peer: { did: a0.did } as Peer, to: a1 });
    const { evidence, proofs } = await fold(scene, keys);
    const status = (event: VaultEvent<"did.rotationSelected">) => evidence.decisions.get(event.eventId)!.status;
    expect(status(wrongSub)).toEqual({ status: "invalid", because: "the proof's sub is not the successor's long form" });
    expect(status(shortIss)).toEqual({ status: "invalid", because: "the proof's iss is not the predecessor's long form" });
    expect(proofs.proofChecks.get(shortIss.eventId)).toBe("invalid");
    expect(status(badSignature)).toEqual({ status: "invalid", because: "the proof does not verify under the predecessor's document" });
    expect(status(otherKey)).toEqual({ status: "invalid", because: "the proof does not verify under the predecessor's document" });
    expect(status(peerIsSelf)).toEqual({ status: "invalid", because: "the peer is the predecessor's own DID" });
    expect(evidence.decisions.get(peerIsSelf.eventId)!.channel).toBeNull();
    expect(evidence.localLinks).toEqual([]);
  });

  it("is in conflict when an entity is, or the source is of another type, in another pair or itself in conflict", async () => {
    const { scene, keys, a0, a1, b0, b2 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const forged = resolved(scene, a0.didId, b0, { documentCid: b2.resolution.cid, keyAgreementMethodIds: authorizedMethodIds(b2.resolution.document, "keyAgreement") });
    const elsewhere = resolved(scene, a1.didId, b0);
    const otherPair = receipt(scene, { local: a1, peer: b0, resolution: elsewhere, ordinal: 1 });
    const conflicted = receipt(scene, { local: a0, peer: b0, resolution: forged, ordinal: 2 });
    const wrongType = await rotation(scene, keys, { from: a0, peer: b0, to: a1, overrides: { sourceEventId: root.eventId as EventId as EventReference<"message.in"> } });
    const wrongPair = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: otherPair });
    const conflictedSource = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: conflicted });
    const { evidence, checks, proofs } = await fold(scene, keys);
    const status = (event: VaultEvent<"did.rotationSelected">) => evidence.decisions.get(event.eventId)!.status;
    expect(status(wrongType)).toEqual({ status: "conflict", because: "the source it names is a peer.resolved" });
    expect(status(wrongPair)).toEqual({ status: "conflict", because: "the source is not in the pair the decision rotates away from" });
    expect(status(conflictedSource)).toEqual({ status: "conflict", because: "the source's authentication is in conflict: the resolution's snapshot is not its document's" });
    expect(evidence.localLinks).toEqual([]);
    expectSameOverEveryOrder(scene.events, checks, proofs);

    scene.add("did.created", { ...a0, boundRouteId: uuidv7() as typeof a0.boundRouteId });
    const entityConflict = await fold(scene, keys);
    expect(entityConflict.evidence.decisions.get(wrongPair.eventId)).toMatchObject({ channel: null, status: { status: "conflict", because: "the predecessor entity is in conflict" } });
    expect(entityConflict.evidence.sources.get(conflicted.eventId)!.standing).toMatchObject({ status: "incomplete" });
  });
});

describe("the channel evidence in the whole fold", () => {
  it("is fed the resolution and proof checks of the vault, or none", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: await proof(peerKeys, b0, b1) });
    const set = VaultEventSet.of(scene.events);
    const keyChecks = await checksOf(scene.events, keys);
    const checked = foldVault(set, { mediationKeys: keyChecks.mediations, didKeys: keyChecks.dids, ...(await evidenceChecks(scene.events)) });
    expect(checked.channels.peerLinks).toHaveLength(1);
    expect(checked.checks.proofChecks.get(carrier.eventId)).toBe("verified");
    const unchecked = foldVault(set);
    expect(unchecked.channels.carriers.get(carrier.eventId)!.proof).toEqual({ status: "pending-proof" });
    expect(unchecked.channels.sources.get(carrier.eventId)!.standing).toEqual({ status: "incomplete", because: "the resolution's document is not here" });
    expect(snapshot(unchecked.channels.receipts)).toBe(snapshot(checked.channels.receipts));
  });
});
