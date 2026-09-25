import type { LocalDecision } from "@estoc/continuity";
import { encodeLongForm, longToShort } from "@estoc/did-peer";
import type { Event, EventCid, JsonObject } from "@estoc/event-store";
import { p256, p384, p521 } from "@noble/curves/nist";
import { base64urlnopad } from "@scure/base";
import { SignJWT, importJWK } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it, test } from "vitest";

import {
  AUTHENTICATION_METHOD,
  InvalidDidDocument,
  VaultEventSet,
  anonymousMessageId,
  authorizedMethodIds,
  canonicalPublicKey,
  didKeyName,
  foldChannelEvidence,
  foldReceipts,
  foldVault,
  foldVaultChecked,
  canonicalDidOf,
  inputDocumentOf,
  methodPublicKey,
  receiptOrderKey,
  type ChannelChecks,
  type ChannelEvidence,
  type Cid,
  type Did,
  type DidId,
  type EventReference,
  type Keys,
  type PublicKey,
  type ReadObject,
  type VaultData,
  type VaultEvent,
  type WireMessageId,
} from "../../src/index.js";
import { AUTHOR2, ENDPOINT, MEDIATED, ROUTE, checksOf, createdDid, expectOrderFree, foldChecked, snapshot, type KeyChecks, type Scene, fakeEventCid } from "./helpers.js";
import { IAT, PEER_ID3, asPeer, channel, evidenceChecks, factsOf, noObjects, peerAgreeingOn, proof, receipt, resolved, rotation, vaults, type Peer } from "./scene.js";

const UNCREATED = "019b7000-0000-7000-8000-000000000c00" as DidId;
const FOREIGN = "019b7000-0000-7000-8000-000000000c01" as DidId;
const readerOf = (objects: Map<Cid, Uint8Array>) => async (wanted: Cid) => objects.get(wanted) ?? null;
const segments = (jwt: string) => jwt.split(".") as [string, string, string];

function nistKey(curve: typeof p256, crv: "P-256" | "P-384" | "P-521", size: number): PublicKey {
  const point = curve.getPublicKey(new Uint8Array(size).fill(1), false);
  return canonicalPublicKey({ kty: "EC", crv, x: base64urlnopad.encode(point.subarray(1, 1 + size)), y: base64urlnopad.encode(point.subarray(1 + size)) });
}
const NIST_KEYS: [typeof p256, "P-256" | "P-384" | "P-521", number][] = [[p256, "P-256", 32], [p384, "P-384", 48], [p521, "P-521", 66]];
const x25519Key = (u: number) => canonicalPublicKey({ kty: "OKP", crv: "X25519", x: base64urlnopad.encode(Uint8Array.from([u, ...new Array<number>(31).fill(0)])) });
const agreesNoKeys = (key: PublicKey, what: string) => `${key} is ${what}, which agrees no keys`;
const without = (events: readonly Event[], dropped: Event) => events.filter((event) => event !== dropped);

/** A proof under any header and claims, signed by the authentication key a seed derives for an entity. */
async function resign(keys: Keys, didId: DidId, header: Record<string, unknown>, payload: JsonObject): Promise<string> {
  const key = await keys.signing(didKeyName(didId, "authentication"));
  return new SignJWT(payload)
    .setProtectedHeader(header as never)
    .sign(await importJWK(key.privateJwk(), "EdDSA"));
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
    const anonymous = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, wire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventCid: null, did: null, presentedDid: null } });
    const { evidence } = await fold(scene, keys);
    expect(evidence.sources.get(authenticated.cid)).toMatchObject({ localDidId: a0.didId, resolution: root, channel: channel(a0, b0), standing: { status: "complete" } });
    expect(evidence.sources.get(anonymous.cid)).toMatchObject({ localDidId: a0.didId, resolution: null, channel: null, standing: { status: "complete" } });
    expect(evidence.positive(authenticated.cid)).toBe(true);
    expect(evidence.positive(anonymous.cid)).toBe(false);
    expect(evidence.positive(fakeEventCid())).toBe(false);
    expect(evidence.carriers.size).toBe(0);
  });

  it("is incomplete while the local entity, the resolution or its document is missing, and a retired entity still receives", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const short = resolved(scene, a0.didId, b0, { short: true });
    const atUncreated = resolved(scene, UNCREATED, b0);
    const noEntity = receipt(scene, { local: a0, peer: b0, resolution: atUncreated, ordinal: 1, overrides: { localKeyName: didKeyName(UNCREATED, "key-agreement") } });
    const noResolution = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { peerResolutionEventCid: fakeEventCid() as EventReference<"peer.resolved"> } });
    const noDocument = receipt(scene, { local: a0, peer: b0, resolution: short, ordinal: 3, presentedDid: b0.did });
    const retired = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 4 });
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    const { evidence } = await fold(scene, keys);
    expect(evidence.sources.get(noEntity.cid)).toMatchObject({ localDidId: null, channel: null, standing: { status: "incomplete", because: "no communication DID here derives the local key" } });
    expect(evidence.sources.get(noResolution.cid)).toMatchObject({ channel: channel(a0, b0), standing: { status: "incomplete", because: "the resolution it names is not here" } });
    expect(evidence.sources.get(noDocument.cid)).toMatchObject({ resolution: short, channel: channel(a0, b0), standing: { status: "incomplete", because: "the resolution's document is not here" } });
    expect(evidence.sources.get(retired.cid)).toMatchObject({ channel: channel(a0, b0), standing: { status: "complete" } });
    expect(evidence.positive(noDocument.cid)).toBe(false);
    const withDocument = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    expect(withDocument.evidence.sources.get(noDocument.cid)).toMatchObject({ standing: { status: "complete" } });
    expect(withDocument.evidence.positive(noDocument.cid)).toBe(true);
  });

  it("is in conflict when the key, the resolution or the message ID contradicts the observation, or the sender is the recipient", async () => {
    const { scene, keys, a0, a1, b0, b2 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const otherKey = resolved(scene, a1.didId, b0);
    const forged = resolved(scene, a0.didId, b0, { documentCid: b2.resolution.cid, keyAgreementMethodIds: authorizedMethodIds(b2.resolution.document, "keyAgreement") });
    const [authentication] = authorizedMethodIds(b0.resolution.document, "authentication");
    const signingKey = resolved(scene, a0.didId, b0, { peerPublicKey: methodPublicKey(b0.resolution.document, authentication!) });
    const self = resolved(scene, a0.didId, asPeer(a0));
    const authenticationKey = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, overrides: { localKeyName: didKeyName(a0.didId, "authentication") } });
    const wrongType = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, overrides: { peerResolutionEventCid: scene.events[0]!.cid as EventReference<"peer.resolved"> } });
    const notItsOwn = receipt(scene, { local: a0, peer: b0, resolution: otherKey, ordinal: 3 });
    const invalidSnapshot = receipt(scene, { local: a0, peer: b0, resolution: forged, ordinal: 4 });
    const signingKeyOnly = receipt(scene, { local: a0, peer: b0, resolution: signingKey, ordinal: 5 });
    const wrongId = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 6, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), "x" as WireMessageId) } });
    const fromSelf = receipt(scene, { local: a0, peer: asPeer(a0), resolution: self, ordinal: 7 });
    const { evidence } = await fold(scene, keys);
    const because = (event: VaultEvent<"message.in">) => evidence.sources.get(event.cid)!.standing;
    expect(because(authenticationKey)).toEqual({ status: "conflict", because: "the local key is not the entity's key-agreement key" });
    expect(because(wrongType)).toEqual({ status: "conflict", because: "the resolution it names is a mediation.created" });
    expect(because(notItsOwn)).toEqual({ status: "conflict", because: "the resolution it names is not of this sender at this key" });
    expect(because(invalidSnapshot)).toEqual({ status: "conflict", because: "the resolution's snapshot is not its document's" });
    expect(because(signingKeyOnly)).toEqual({ status: "conflict", because: agreesNoKeys(signingKey.data.peerPublicKey, "a Ed25519 key") });
    expect(because(wrongId)).toMatchObject({ status: "conflict", because: expect.stringMatching(/^the message ID is not the one the endpoints and wire ID derive, /) });
    expect(because(fromSelf)).toEqual({ status: "conflict", because: "the sender is the recipient" });
    for (const event of [authenticationKey, wrongType, notItsOwn, invalidSnapshot, signingKeyOnly, wrongId, fromSelf]) {
      expect(evidence.sources.get(event.cid)!.channel).toBeNull();
      expect(evidence.positive(event.cid)).toBe(false);
    }
    expect(evidence.sources.get(invalidSnapshot.cid)!.resolution).toBe(forged);
  });

  it("is in conflict when the local entity is, for disagreeing creations or keys the seed does not derive, and incomplete while the entity has no creation or the seed has not been asked", async () => {
    const { scene, keys, peerKeys, a0, a1, b0 } = await vaults();
    const foreign = await createdDid(scene, peerKeys, FOREIGN, ROUTE, MEDIATED);
    const root = resolved(scene, a0.didId, b0);
    const atForeign = resolved(scene, FOREIGN, b0);
    const atRetiredOnly = resolved(scene, UNCREATED, b0);
    const ours = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const theirs = receipt(scene, { local: foreign, peer: b0, resolution: atForeign, ordinal: 2 });
    const noCreation = receipt(scene, { local: a1, peer: b0, resolution: atRetiredOnly, ordinal: 3, overrides: { localKeyName: didKeyName(UNCREATED, "key-agreement") } });
    scene.add("did.retired", { didId: UNCREATED, because: "never created here" });
    const withSeed = await fold(scene, keys);
    expect(withSeed.checks.dids.get(FOREIGN)).toBe("mismatch");
    expect(withSeed.evidence.sources.get(ours.cid)).toMatchObject({ localDidId: a0.didId, channel: channel(a0, b0), standing: { status: "complete" } });
    expect(withSeed.evidence.sources.get(theirs.cid)).toMatchObject({ localDidId: FOREIGN, channel: null, standing: { status: "conflict", because: "the local entity is in conflict: the seed does not derive the entity's keys" } });
    expect(withSeed.evidence.sources.get(noCreation.cid)).toMatchObject({ localDidId: UNCREATED, channel: null, standing: { status: "incomplete", because: "the local entity has no creation here" } });
    expect([ours, theirs, noCreation].map((event) => withSeed.evidence.positive(event.cid))).toEqual([true, false, false]);

    const withoutSeed = (await foldVaultChecked(scene.set(), null, noObjects)).channels;
    for (const event of [ours, theirs]) {
      expect(withoutSeed.sources.get(event.cid)).toMatchObject({ channel: channel({ did: event.data.localKeyName === ours.data.localKeyName ? a0.did : foreign.did }, b0), standing: { status: "incomplete", because: "the local entity's keys are not yet checked against the seed" } });
      expect(withoutSeed.positive(event.cid)).toBe(false);
    }
    const partly = foldChannelEvidence(scene.set(), foldChecked(scene.set(), { ...withSeed.checks, dids: new Map([[a1.didId, "verified"]]) }).routes, withSeed.proofs);
    expect(partly.sources.get(ours.cid)!.standing).toEqual({ status: "incomplete", because: "the local entity's keys are not yet checked against the seed" });
    expect(partly.positive(ours.cid)).toBe(false);
  });

  it("is in conflict when the peer key the resolution selected is on another curve than the entity's key-agreement key, with or without the seed, and lends its carrier no link", async () => {
    for (const [curve, crv, size] of NIST_KEYS) {
      const { scene, keys, peerKeys, a0, a1, b0 } = await vaults();
      const peer = await peerAgreeingOn(peerKeys, PEER_ID3, nistKey(curve, crv, size));
      const root = resolved(scene, a0.didId, peer);
      const carrier = receipt(scene, { local: a0, peer, resolution: root, ordinal: 1, fromPrior: await proof(peerKeys, b0, peer) });
      const decision = await rotation(scene, keys, { from: a0, peer, to: a1, source: carrier });
      const because = `the peer key is ${crv} and the entity's key-agreement key X25519: no key is agreed across curves`;
      const { evidence, checks, proofs } = await fold(scene, keys);
      expect(proofs.resolutionChecks.get(root.cid)).toBe("verified");
      expect(proofs.proofChecks.get(carrier.cid)).toMatchObject({ status: "verified" });
      expect(evidence.sources.get(carrier.cid)).toMatchObject({ resolution: root, channel: null, standing: { status: "conflict", because } });
      expect(evidence.carriers.get(carrier.cid)).toMatchObject({ proof: { status: "verified" }, facts: [] });
      expect(evidence.positive(carrier.cid)).toBe(false);
      expect(evidence.decisions.get(decision.cid)!.status).toEqual({ status: "conflict", because: `the source's authentication is in conflict: ${because}` });
      const withoutSeed = (await foldVaultChecked(scene.set(), null, noObjects)).channels;
      expect(withoutSeed.sources.get(carrier.cid)!.standing).toEqual({ status: "conflict", because });
      expectSameOverEveryOrder(scene.events, checks, proofs);
    }
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
  it("binds a verified long-form proof on a complete carrier into the peer transition and the observation of its successor, with no earlier message in the predecessor's channel", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const jwt = await proof(peerKeys, b0, b1);
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: jwt });
    const { evidence, checks, proofs } = await fold(scene, keys);
    expect(proofs.proofChecks.get(carrier.cid)).toMatchObject({ status: "verified" });
    const verified = { token: jwt, issuer: { presented: b0.longFormDid, canonical: b0.did }, change: { kind: "rotate", successor: { presented: b1.longFormDid, canonical: b1.did } }, iat: IAT };
    expect(evidence.carriers.get(carrier.cid)).toMatchObject({ proof: { status: "verified", proof: verified }, facts: factsOf(carrier, a0, b0, b1) });
    expect(evidence.positive(carrier.cid)).toBe(true);
    expectSameOverEveryOrder(scene.events, checks, proofs);
  });

  test("a short-form issuer waits for a verified retained resolution of that DID, under either presented spelling, and needs its document", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const jwt = await resign(peerKeys, b0.didId, { alg: "EdDSA", typ: "JWT", kid: `${b0.did}${AUTHENTICATION_METHOD}` }, { iss: b0.did, sub: b1.longFormDid, iat: IAT });
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: jwt });
    const pending = await fold(scene, keys);
    expect(pending.proofs.proofChecks.has(carrier.cid)).toBe(false);
    expect(pending.evidence.carriers.get(carrier.cid)).toMatchObject({ proof: { status: "pending-proof" }, facts: [], source: { standing: { status: "complete" } } });
    expect(pending.evidence.positive(carrier.cid)).toBe(false);

    const short = resolved(scene, a1.didId, b0, { short: true });
    const stillPending = await fold(scene, keys);
    expect(stillPending.evidence.carriers.get(carrier.cid)!.proof).toEqual({ status: "pending-proof" });
    const withDocument = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    expect(withDocument.proofs.resolutionChecks.get(short.cid)).toBe("verified");
    expect(withDocument.evidence.carriers.get(carrier.cid)).toMatchObject({ proof: { status: "verified", proof: { issuer: { presented: b0.did, canonical: b0.did } } }, facts: factsOf(carrier, a0, b0, b1) });
    expect(withDocument.evidence.positive(carrier.cid)).toBe(true);

    resolved(scene, a1.didId, b0);
    const withLongForm = await fold(scene, keys);
    expect(withLongForm.evidence.carriers.get(carrier.cid)!.proof).toMatchObject({ status: "verified" });
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
    expect(evidence.carriers.get(wrongSub.cid)!.proof).toEqual({ status: "invalid", because: `sub is ${b1.longFormDid} but the sender is ${b2.longFormDid}` });
    expect(evidence.carriers.get(wrongKid.cid)!.proof).toEqual({ status: "invalid", because: "the kid names a key of iss" });
    expect(evidence.carriers.get(notJwt.cid)!.proof).toMatchObject({ status: "invalid", because: expect.stringMatching(/^not a compact JWT/) });
    expect(evidence.carriers.get(sameDid.cid)!.proof).toEqual({ status: "invalid", because: "sub is another DID than iss" });
    for (const event of [wrongSub, wrongKid, notJwt, sameDid]) {
      expect(proofs.proofChecks.has(event.cid)).toBe(false);
      expect(evidence.sources.get(event.cid)!.standing).toEqual({ status: "complete" });
      expect(evidence.carriers.get(event.cid)!.facts).toEqual([]);
      expect(evidence.positive(event.cid)).toBe(false);
    }
  });

  it("finds a proof invalid whose signature the issuer's document refuses, or whose predecessor is the carrier's own local DID under either spelling, with or without that DID's document", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const [header, payload] = segments(await proof(peerKeys, b0, b1));
    const badSignature = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: `${header}.${payload}.${segments(await proof(peerKeys, b0, b1, IAT + 1))[2]}` });
    const ourPredecessor = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, fromPrior: await proof(keys, a0, b1) });
    const shortJwt = await resign(keys, a0.didId, { alg: "EdDSA", typ: "JWT", kid: `${a0.did}${AUTHENTICATION_METHOD}` }, { iss: a0.did, sub: b1.longFormDid, iat: IAT });
    const ourShortPredecessor = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 3, fromPrior: shortJwt });
    const { evidence, proofs } = await fold(scene, keys);
    expect(proofs.proofChecks.get(badSignature.cid)).toMatchObject({ status: "invalid" });
    expect(evidence.carriers.get(badSignature.cid)!.proof).toMatchObject({ status: "invalid", because: expect.stringMatching(/^the signature does not verify under /) });
    expect(proofs.proofChecks.get(ourPredecessor.cid)).toMatchObject({ status: "verified" });
    expect(evidence.carriers.get(ourPredecessor.cid)!.proof).toEqual({ status: "invalid", because: "the predecessor is the local DID" });
    expect(proofs.proofChecks.has(ourShortPredecessor.cid)).toBe(false);
    expect(evidence.carriers.get(ourShortPredecessor.cid)!.proof).toEqual({ status: "invalid", because: "the predecessor is the local DID" });
    for (const event of [badSignature, ourPredecessor, ourShortPredecessor]) expect(evidence.carriers.get(event.cid)!.facts).toEqual([]);
    expect(evidence.positive(ourPredecessor.cid)).toBe(false);
    expect(evidence.positive(ourShortPredecessor.cid)).toBe(false);
  });

  test("an issuer the vault would refuse to retain a document for is that proof's business alone: the profile's verdict stands, verified or not, and the fold goes on", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const input = inputDocumentOf(await peerKeys.didKeys(b0.didId), ENDPOINT);
    const service = (serviceEndpoint: string) => ({ id: "#same", type: "DIDCommMessaging", serviceEndpoint });
    const twoServices = encodeLongForm({ ...input, service: [service("https://one.example"), service("https://two.example")] });
    const { x } = (await peerKeys.signing(didKeyName(b0.didId, "authentication"))).privateJwk();
    const untyped = encodeLongForm({ verificationMethod: [{ id: "#key-1", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x } }], authentication: ["#key-1"] });
    for (const iss of [twoServices, untyped]) expect(() => canonicalDidOf(iss)).toThrow(InvalidDidDocument);
    const carried = async (iss: string) => resign(peerKeys, b0.didId, { alg: "EdDSA", kid: `${iss}${AUTHENTICATION_METHOD}` }, { iss, sub: b1.longFormDid, iat: IAT });
    const verified = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: await carried(twoServices) });
    const [header, payload] = segments(await carried(untyped));
    const unsigned = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, fromPrior: `${header}.${payload}.${base64urlnopad.encode(new Uint8Array(64))}` });
    const { evidence, proofs, checks } = await fold(scene, keys);
    expect(proofs.proofChecks.get(verified.cid)).toMatchObject({ status: "verified" });
    expect(evidence.carriers.get(verified.cid)!.facts).toEqual(factsOf(verified, a0, { did: longToShort(twoServices) as Did }, b1));
    expect(proofs.proofChecks.get(unsigned.cid)).toMatchObject({ status: "invalid" });
    expect(evidence.carriers.get(unsigned.cid)).toMatchObject({ proof: { status: "invalid" }, facts: [] });
    expect([evidence.positive(verified.cid), evidence.positive(unsigned.cid)]).toEqual([true, false]);
    expectSameOverEveryOrder(scene.events, checks, proofs);
  });

  test("a link stands on one complete verified carrier while a sibling of the same message is incomplete or invalid, and lends that sibling nothing", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const jwt = await proof(peerKeys, b0, b1);
    const wire = uuidv7();
    const complete = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: jwt, wire });
    const unauthenticated = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, fromPrior: jwt, wire, overrides: { peerResolutionEventCid: fakeEventCid() as EventReference<"peer.resolved"> } });
    const [header, payload] = segments(jwt);
    const broken = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 3, fromPrior: `${header}.${payload}.${segments(await proof(peerKeys, b0, b1, IAT + 1))[2]}`, wire });
    expect(new Set([complete, unauthenticated, broken].map((event) => event.data.messageId)).size).toBe(1);
    const { evidence, checks, proofs } = await fold(scene, keys);
    expect(evidence.carriers.get(complete.cid)!.facts).toEqual(factsOf(complete, a0, b0, b1));
    expect(evidence.carriers.get(unauthenticated.cid)).toMatchObject({ proof: { status: "verified" }, facts: [], source: { standing: { status: "incomplete" } } });
    expect(evidence.carriers.get(broken.cid)).toMatchObject({ proof: { status: "invalid" }, facts: [], source: { standing: { status: "complete" } } });
    expect([complete, unauthenticated, broken].map((event) => evidence.positive(event.cid))).toEqual([true, false, false]);
    expectSameOverEveryOrder(scene.events, checks, proofs);
  });

  it("lends no link to a verified proof whose carrier's resolution names the peer's signing key as the key that received it", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const [authentication] = authorizedMethodIds(b1.resolution.document, "authentication");
    const signingKey = resolved(scene, a0.didId, b1, { peerPublicKey: methodPublicKey(b1.resolution.document, authentication!) });
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: signingKey, ordinal: 1, fromPrior: await proof(peerKeys, b0, b1) });
    const { evidence, proofs } = await fold(scene, keys);
    expect(proofs.resolutionChecks.get(signingKey.cid)).toBe("invalid");
    expect(proofs.proofChecks.get(carrier.cid)).toMatchObject({ status: "verified" });
    expect(evidence.carriers.get(carrier.cid)).toMatchObject({ proof: { status: "verified" }, facts: [], source: { standing: { status: "conflict", because: agreesNoKeys(signingKey.data.peerPublicKey, "a Ed25519 key") } } });
    expect(evidence.positive(carrier.cid)).toBe(false);
  });

  it("lends no link to a verified proof whose carrier's resolution selected a low-order X25519 point, with or without the seed, the point being refused before any document is asked for", async () => {
    for (const u of [0, 1]) {
      const { scene, keys, peerKeys, a0, a1, b0 } = await vaults();
      const lowOrder = x25519Key(u);
      const peer = await peerAgreeingOn(peerKeys, PEER_ID3, lowOrder);
      const root = resolved(scene, a0.didId, peer);
      const carrier = receipt(scene, { local: a0, peer, resolution: root, ordinal: 1, fromPrior: await proof(peerKeys, b0, peer) });
      const decision = await rotation(scene, keys, { from: a0, peer, to: a1, source: carrier });
      const because = agreesNoKeys(lowOrder, "a low-order X25519 point");
      const { evidence, checks, proofs } = await fold(scene, keys);
      expect(proofs.resolutionChecks.get(root.cid)).toBe("invalid");
      expect(proofs.proofChecks.get(carrier.cid)).toMatchObject({ status: "verified" });
      expect(evidence.sources.get(carrier.cid)).toMatchObject({ resolution: root, channel: null, standing: { status: "conflict", because } });
      expect(evidence.carriers.get(carrier.cid)).toMatchObject({ proof: { status: "verified" }, facts: [] });
      expect(evidence.positive(carrier.cid)).toBe(false);
      expect(evidence.decisions.get(decision.cid)!.status).toEqual({ status: "conflict", because: `the source's authentication is in conflict: ${because}` });
      const withoutSeed = (await foldVaultChecked(scene.set(), null, noObjects)).channels;
      expect(withoutSeed.sources.get(carrier.cid)!.standing).toEqual({ status: "conflict", because });
      const unchecked = foldChannelEvidence(scene.set(), foldChecked(scene.set(), checks).routes, { resolutionChecks: new Map(), proofChecks: proofs.proofChecks });
      expect(unchecked.sources.get(carrier.cid)!.standing).toEqual({ status: "conflict", because });
      expectSameOverEveryOrder(scene.events, checks, proofs);
    }
  });

  it("keeps a verified proof through erasure of the message's content, the proof being event metadata", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b1);
    const carrier = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 1, fromPrior: await proof(peerKeys, b0, b1) });
    scene.add("message.erased", { messageId: carrier.data.messageId, dropCids: [carrier.data.bodyCid], because: "user" });
    const { evidence } = await fold(scene, keys);
    expect(evidence.carriers.get(carrier.cid)!.facts).toHaveLength(2);
    expect(evidence.positive(carrier.cid)).toBe(true);
  });
});

describe("foldDecisions", () => {
  it("makes a local-decision candidate of a decision whose entities, proof and positive source in the old pair all check, and of a manual one", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const source = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const sourced = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const manual = await rotation(scene, keys, { from: a2, peer: b0, to: a1 });
    const { evidence, checks, proofs } = await fold(scene, keys);
    expect(proofs.proofChecks.get(sourced.cid)).toMatchObject({ status: "verified", proof: { issuer: { presented: a0.longFormDid }, change: { kind: "rotate", successor: { presented: a1.longFormDid } } } });
    const first: LocalDecision = { kind: "local-decision", id: `decision:${sourced.cid}`, at: channel(a0, b0), change: { kind: "rotate", successor: a1.did }, source: `receipt:${source.cid}:observation`, decision: sourced.cid };
    const second: LocalDecision = { kind: "local-decision", id: `decision:${manual.cid}`, at: channel(a2, b0), change: { kind: "rotate", successor: a1.did }, source: null, decision: manual.cid };
    expect(evidence.decisions.get(sourced.cid)).toEqual({ event: sourced, channel: channel(a0, b0), status: { status: "candidate", fact: first } });
    expect(evidence.decisions.get(manual.cid)).toEqual({ event: manual, channel: channel(a2, b0), status: { status: "candidate", fact: second } });
    expectSameOverEveryOrder(scene.events, checks, proofs);
  });

  it("is pending while an entity's creation, the proof's verdict or the source is missing, or the source is not yet positive", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const short = resolved(scene, a0.didId, b0, { short: true });
    const unverified = receipt(scene, { local: a0, peer: b0, resolution: short, ordinal: 1, presentedDid: b0.did });
    const noSuccessor = await rotation(scene, keys, { from: a0, peer: b0, to: { didId: UNCREATED, did: a1.did, longFormDid: a1.longFormDid } });
    const noPredecessor = await rotation(scene, keys, { from: a0, peer: b0, to: a1, overrides: { fromDidId: UNCREATED } });
    const noSource = await rotation(scene, keys, { from: a0, peer: b0, to: a1, overrides: { sourceEventCid: fakeEventCid() as EventReference<"message.in"> } });
    const unverifiedSource = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: unverified });
    const { evidence, checks, proofs } = await fold(scene, keys);
    const status = (event: VaultEvent<"did.rotationSelected">) => evidence.decisions.get(event.cid)!.status;
    expect(status(noSuccessor)).toEqual({ status: "pending", because: "the successor entity has no consistent creation here" });
    expect(status(noPredecessor)).toEqual({ status: "pending", because: "the predecessor entity has no consistent creation here" });
    expect(evidence.decisions.get(noPredecessor.cid)!.channel).toBeNull();
    expect(status(noSource)).toEqual({ status: "pending", because: "the source it names is not here" });
    expect(status(unverifiedSource)).toEqual({ status: "pending", because: "the source's authentication is incomplete: the resolution's document is not here" });
    const unchecked = foldChannelEvidence(scene.set(), foldChecked(scene.set(), checks).routes, { resolutionChecks: proofs.resolutionChecks });
    expect(unchecked.decisions.get(unverifiedSource.cid)!.status).toEqual({ status: "pending", because: "the proof is not yet checked" });
    const withDocument = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    expect(withDocument.evidence.decisions.get(unverifiedSource.cid)!.status).toMatchObject({ status: "candidate", fact: { source: `receipt:${unverified.cid}:observation` } });
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
    const status = (event: VaultEvent<"did.rotationSelected">) => evidence.decisions.get(event.cid)!.status;
    expect(status(wrongSub)).toEqual({ status: "invalid", because: "the proof's sub is not the successor's long form" });
    expect(status(shortIss)).toEqual({ status: "invalid", because: "the proof's iss is not the predecessor's long form" });
    expect(proofs.proofChecks.get(shortIss.cid)).toEqual({ status: "invalid", because: "a decision's issuer is its own long form" });
    expect(status(badSignature)).toMatchObject({ status: "invalid", because: expect.stringMatching(/^the signature does not verify under /) });
    expect(status(otherKey)).toMatchObject({ status: "invalid", because: expect.stringMatching(/^the signature does not verify under /) });
    expect(status(peerIsSelf)).toEqual({ status: "invalid", because: "the peer is the predecessor's own DID" });
    expect(evidence.decisions.get(peerIsSelf.cid)!.channel).toBeNull();
  });

  it("is pending while the seed has not confirmed either entity, and a candidate once it has", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const source = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const sourced = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const manual = await rotation(scene, keys, { from: a2, peer: b0, to: a1 });
    const withoutSeed = (await foldVaultChecked(scene.set(), null, noObjects)).channels;
    expect(withoutSeed.decisions.get(sourced.cid)!.status).toEqual({ status: "pending", because: "the predecessor entity's keys are not yet checked against the seed" });
    expect(withoutSeed.decisions.get(manual.cid)!.status).toEqual({ status: "pending", because: "the predecessor entity's keys are not yet checked against the seed" });
    const { checks, proofs } = await fold(scene, keys);
    const successorUnchecked = foldChannelEvidence(scene.set(), foldChecked(scene.set(), { ...checks, dids: new Map([[a0.didId, "verified"], [a2.didId, "verified"]]) }).routes, proofs);
    expect(successorUnchecked.decisions.get(sourced.cid)!.status).toEqual({ status: "pending", because: "the successor entity's keys are not yet checked against the seed" });
    expect(successorUnchecked.decisions.get(manual.cid)!.status).toEqual({ status: "pending", because: "the successor entity's keys are not yet checked against the seed" });
    const withSeed = await fold(scene, keys);
    expect([sourced, manual].map((event) => withSeed.evidence.decisions.get(event.cid)!.status.status)).toEqual(["candidate", "candidate"]);
  });

  it("is in conflict when the seed finds an entity is not ours, whichever seed signed the frozen proof, sourced or manual", async () => {
    const { scene, keys, peerKeys, a1, b0 } = await vaults();
    const foreign = await createdDid(scene, peerKeys, FOREIGN, ROUTE, MEDIATED);
    const root = resolved(scene, FOREIGN, b0);
    const source = receipt(scene, { local: foreign, peer: b0, resolution: root, ordinal: 1 });
    const sourced = await rotation(scene, peerKeys, { from: foreign, peer: b0, to: a1, source });
    const manual = await rotation(scene, peerKeys, { from: foreign, peer: b0, to: a1 });
    const withoutSeed = (await foldVaultChecked(scene.set(), null, noObjects)).channels;
    expect(withoutSeed.decisions.get(sourced.cid)!.status).toEqual({ status: "pending", because: "the predecessor entity's keys are not yet checked against the seed" });
    const { evidence, proofs } = await fold(scene, keys);
    expect(proofs.proofChecks.get(sourced.cid)).toMatchObject({ status: "verified" });
    const because = "the predecessor entity is in conflict: the seed does not derive the entity's keys";
    expect(evidence.decisions.get(sourced.cid)).toMatchObject({ channel: null, status: { status: "conflict", because } });
    expect(evidence.decisions.get(manual.cid)).toMatchObject({ channel: null, status: { status: "conflict", because } });
  });

  it("is in conflict when its source can never be positive — anonymous, or carrying a proof already refused — and pending while the source's own proof waits for its issuer's document", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b2, b3 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const wire = uuidv7() as WireMessageId;
    const anonymous = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1, wire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventCid: null, did: null, presentedDid: null } });
    const refused = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 2, fromPrior: "not-a-jwt" });
    const fromB3 = resolved(scene, a0.didId, b3);
    const shortJwt = await resign(peerKeys, b2.didId, { alg: "EdDSA", typ: "JWT", kid: `${b2.did}${AUTHENTICATION_METHOD}` }, { iss: b2.did, sub: b3.longFormDid, iat: IAT });
    const waiting = receipt(scene, { local: a0, peer: b3, resolution: fromB3, ordinal: 3, fromPrior: shortJwt });
    const fromAnonymous = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: anonymous });
    const fromRefused = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: refused });
    const fromWaiting = await rotation(scene, keys, { from: a0, peer: b3, to: a1, source: waiting });
    const { evidence, checks, proofs } = await fold(scene, keys);
    const status = (event: VaultEvent<"did.rotationSelected">) => evidence.decisions.get(event.cid)!.status;
    expect(evidence.sources.get(anonymous.cid)!.standing).toEqual({ status: "complete" });
    expect(status(fromAnonymous)).toEqual({ status: "conflict", because: "the source is anonymous, in no pair" });
    expect(evidence.carriers.get(refused.cid)!.proof).toMatchObject({ status: "invalid", because: expect.stringMatching(/^not a compact JWT/) });
    expect(status(fromRefused)).toMatchObject({ status: "conflict", because: expect.stringMatching(/^the source's proof is invalid: not a compact JWT/) });
    expect(evidence.carriers.get(waiting.cid)!.proof).toEqual({ status: "pending-proof" });
    expect(status(fromWaiting)).toEqual({ status: "pending", because: "the source's proof is not yet verified" });
    expectSameOverEveryOrder(scene.events, checks, proofs);

    resolved(scene, a1.didId, b2, { short: true });
    const withDocument = await fold(scene, keys, readerOf(new Map([[b2.resolution.cid, b2.resolution.bytes]])));
    expect(withDocument.evidence.carriers.get(waiting.cid)!.proof).toMatchObject({ status: "verified" });
    expect(withDocument.evidence.decisions.get(fromWaiting.cid)!.status).toMatchObject({ status: "candidate", fact: { source: `receipt:${waiting.cid}:observation` } });
    expect(withDocument.evidence.decisions.get(fromRefused.cid)!.status).toMatchObject({ status: "conflict" });
  });

  it("reports a contradiction that already stands over whatever is still missing: a refused proof beside an absent document, a refused resolution or an anonymous source beside an unconsulted seed", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const short = resolved(scene, a0.didId, b0, { short: true });
    const refused = receipt(scene, { local: a0, peer: b0, resolution: short, ordinal: 1, presentedDid: b0.did, fromPrior: "not-a-jwt" });
    const sound = receipt(scene, { local: a0, peer: b0, resolution: short, ordinal: 2, presentedDid: b0.did });
    const [authentication] = authorizedMethodIds(b0.resolution.document, "authentication");
    const signingKey = resolved(scene, a0.didId, b0, { peerPublicKey: methodPublicKey(b0.resolution.document, authentication!) });
    const atSigningKey = receipt(scene, { local: a0, peer: b0, resolution: signingKey, ordinal: 3 });
    const wire = uuidv7() as WireMessageId;
    const anonymous = receipt(scene, { local: a0, peer: b0, resolution: short, ordinal: 4, wire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventCid: null, did: null, presentedDid: null } });
    const fromRefused = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: refused });
    const fromSound = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: sound });
    const fromSigningKey = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: atSigningKey });
    const fromAnonymous = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: anonymous });

    const missingDocument = await fold(scene, keys);
    const status = (folded: Folded, event: VaultEvent<"did.rotationSelected">) => folded.evidence.decisions.get(event.cid)!.status;
    expect(missingDocument.evidence.sources.get(refused.cid)!.standing).toEqual({ status: "incomplete", because: "the resolution's document is not here" });
    expect(missingDocument.evidence.carriers.get(refused.cid)!.proof).toMatchObject({ status: "invalid", because: expect.stringMatching(/^not a compact JWT/) });
    expect(status(missingDocument, fromRefused)).toMatchObject({ status: "conflict", because: expect.stringMatching(/^the source's proof is invalid: not a compact JWT/) });
    expect(status(missingDocument, fromSound)).toEqual({ status: "pending", because: "the source's authentication is incomplete: the resolution's document is not here" });
    expectSameOverEveryOrder(scene.events, missingDocument.checks, missingDocument.proofs);

    const withoutSeed = (await foldVaultChecked(scene.set(), null, noObjects)).channels;
    const signingKeyAgreesNone = agreesNoKeys(signingKey.data.peerPublicKey, "a Ed25519 key");
    expect(withoutSeed.sources.get(atSigningKey.cid)!.standing).toEqual({ status: "conflict", because: signingKeyAgreesNone });
    expect(withoutSeed.decisions.get(fromSigningKey.cid)!.status).toEqual({ status: "conflict", because: `the source's authentication is in conflict: ${signingKeyAgreesNone}` });
    expect(withoutSeed.decisions.get(fromAnonymous.cid)!.status).toEqual({ status: "conflict", because: "the source is anonymous, in no pair" });
    expect(withoutSeed.decisions.get(fromRefused.cid)!.status).toMatchObject({ status: "conflict", because: expect.stringMatching(/^the source's proof is invalid: not a compact JWT/) });
    expect(withoutSeed.decisions.get(fromSound.cid)!.status).toEqual({ status: "pending", because: "the predecessor entity's keys are not yet checked against the seed" });

    const restored = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    expect(status(restored, fromRefused)).toMatchObject({ status: "conflict", because: expect.stringMatching(/^the source's proof is invalid: not a compact JWT/) });
    expect(status(restored, fromSound)).toMatchObject({ status: "candidate", fact: { source: `receipt:${sound.cid}:observation` } });
  });

  it("is in conflict when an entity is, or the source is of another type, in another pair or itself in conflict", async () => {
    const { scene, keys, a0, a1, b0, b2 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const forged = resolved(scene, a0.didId, b0, { documentCid: b2.resolution.cid, keyAgreementMethodIds: authorizedMethodIds(b2.resolution.document, "keyAgreement") });
    const elsewhere = resolved(scene, a1.didId, b0);
    const otherPair = receipt(scene, { local: a1, peer: b0, resolution: elsewhere, ordinal: 1 });
    const conflicted = receipt(scene, { local: a0, peer: b0, resolution: forged, ordinal: 2 });
    const wrongType = await rotation(scene, keys, { from: a0, peer: b0, to: a1, overrides: { sourceEventCid: root.cid as EventCid as EventReference<"message.in"> } });
    const wrongPair = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: otherPair });
    const conflictedSource = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: conflicted });
    const { evidence, checks, proofs } = await fold(scene, keys);
    const status = (event: VaultEvent<"did.rotationSelected">) => evidence.decisions.get(event.cid)!.status;
    expect(status(wrongType)).toEqual({ status: "conflict", because: "the source it names is a peer.resolved" });
    expect(status(wrongPair)).toEqual({ status: "conflict", because: "the source is not at the predecessor's key-agreement key" });
    expect(status(conflictedSource)).toEqual({ status: "conflict", because: "the source's authentication is in conflict: the resolution's snapshot is not its document's" });
    expectSameOverEveryOrder(scene.events, checks, proofs);

    scene.add("did.created", { ...a0, boundRouteId: uuidv7() as typeof a0.boundRouteId });
    const entityConflict = await fold(scene, keys);
    expect(entityConflict.evidence.decisions.get(wrongPair.cid)).toMatchObject({ channel: null, status: { status: "conflict", because: "the predecessor entity is in conflict: creations disagree" } });
    expect(entityConflict.evidence.sources.get(conflicted.cid)).toMatchObject({ localDidId: a0.didId, channel: null, standing: { status: "conflict", because: "the local entity is in conflict: creations disagree" } });
  });

  it("refuses on what is here while the predecessor's creation is not: a successor that is the peer, a source from another peer, a source at the entity's signing key; only a decision nothing contradicts waits for the creation", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const created = scene.events.find((event) => event.type === "did.created" && (event.data as VaultData["did.created"]).didId === a0.didId)!;
    const root = resolved(scene, a0.didId, b0);
    const fromB0 = receipt(scene, { local: a0, peer: b0, resolution: root, ordinal: 1 });
    const signingName = didKeyName(a0.didId, "authentication");
    const atSigning = resolved(scene, a0.didId, b0, { localKeyName: signingName });
    const atSigningKey = receipt(scene, { local: a0, peer: b0, resolution: atSigning, ordinal: 2, overrides: { localKeyName: signingName } });
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    const successorIsPeer = await rotation(scene, keys, { from: a0, peer: { did: a1.did } as Peer, to: a1 });
    const otherPeer = await rotation(scene, keys, { from: a0, peer: b1, to: a1, source: fromB0 });
    const atSigningSource = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: atSigningKey });
    const sound = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: fromB0 });

    const partial = await foldVaultChecked(VaultEventSet.of(without(scene.events, created)), keys, noObjects);
    expect(partial.routes.dids.get(a0.didId)).toMatchObject({ created: null, conflict: false });
    expect(partial.checks.didKeys.get(a1.didId)).toBe("verified");
    expect(partial.checks.proofChecks.get(sound.cid)).toMatchObject({ status: "verified" });
    const status = (folded: typeof partial, event: VaultEvent<"did.rotationSelected">) => folded.channels.decisions.get(event.cid)!.status;
    expect(status(partial, successorIsPeer)).toEqual({ status: "invalid", because: "the successor is the peer's DID" });
    expect(status(partial, otherPeer)).toEqual({ status: "conflict", because: "the source is not from the peer the decision rotates away from" });
    expect(partial.channels.sources.get(atSigningKey.cid)).toMatchObject({ localDidId: a0.didId, channel: null, standing: { status: "conflict", because: "the local key is not the entity's key-agreement key" } });
    expect(status(partial, atSigningSource)).toEqual({ status: "conflict", because: "the source is not at the predecessor's key-agreement key" });
    expect(partial.channels.sources.get(fromB0.cid)!.standing).toEqual({ status: "incomplete", because: "the local entity has no creation here" });
    expect(status(partial, sound)).toEqual({ status: "pending", because: "the predecessor entity has no consistent creation here" });
    expectOrderFree(without(scene.events, created), (set) => readable(foldVault(set, partial.checks).channels));

    const restored = await foldVaultChecked(scene.set(), keys, noObjects);
    expect(status(restored, successorIsPeer)).toEqual({ status: "invalid", because: "the successor is the peer's DID" });
    expect(status(restored, otherPeer)).toEqual({ status: "conflict", because: "the source is not from the peer the decision rotates away from" });
    expect(status(restored, atSigningSource)).toEqual({ status: "conflict", because: "the source is not at the predecessor's key-agreement key" });
    expect(status(restored, sound)).toMatchObject({ status: "candidate", fact: { at: channel(a0, b0), change: { kind: "rotate", successor: a1.did }, source: `receipt:${fromB0.cid}:observation` } });
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
    expect(checked.channels.carriers.get(carrier.cid)!.facts).toHaveLength(2);
    expect(checked.checks.proofChecks.get(carrier.cid)).toMatchObject({ status: "verified" });
    const unchecked = foldVault(set);
    expect(unchecked.channels.carriers.get(carrier.cid)!.proof).toEqual({ status: "pending-proof" });
    expect(unchecked.channels.sources.get(carrier.cid)!.standing).toEqual({ status: "incomplete", because: "the local entity's keys are not yet checked against the seed" });
    expect(snapshot(unchecked.channels.receipts)).toBe(snapshot(checked.channels.receipts));
  });
});
