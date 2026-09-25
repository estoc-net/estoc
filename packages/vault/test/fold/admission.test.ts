import { SignJWT, importJWK } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import { AUTHENTICATION_METHOD, anonymousMessageId, didKeyName, foldVault, foldVaultChecked, type DidId, type EventReference, type Keys, type MessageHash, type ReadObject, type VaultChecks, type VaultData, type VaultFold, type WireMessageId } from "../../src/index.js";
import { AUTHOR, AUTHOR2, HASH, expectOrderFree, fakeEventCid, type Scene } from "./helpers.js";
import { IAT, admitted, blocked, invitation, noObjects, observation, peerDid, proof, receipt, resolved, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);

const OTHER_HASH = "Amqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA" as MessageHash;

/** A peer no resolution of the scene retains a document for: a proof it issues under its short form waits for one. */
const undocumentedPeer = (keys: Keys) => peerDid(keys, "019b7000-0000-7000-8000-000000000b04" as DidId);

/** A proof under any header and claims, signed by the authentication key a seed derives for an entity. */
async function resign(keys: Keys, local: { didId: Local["didId"] }, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  const key = await keys.signing(didKeyName(local.didId, "authentication"));
  return new SignJWT(payload)
    .setProtectedHeader(header as never)
    .sign(await importJWK(key.privateJwk(), "EdDSA"));
}

type Observed = { local: Local; peer: Peer; ordinal: number; wire?: string; hash?: MessageHash; fromPrior?: string; short?: boolean; overrides?: Partial<VaultData["message.in"]>; author?: typeof AUTHOR; admitted?: boolean };

/** A receipt under its own resolution, admitted only when asked. */
const observe = (scene: Scene, o: Observed) =>
  receipt(
    scene,
    { local: o.local, peer: o.peer, resolution: resolved(scene, o.local.didId, o.peer, { short: o.short }), ordinal: o.ordinal, wire: o.wire ?? uuidv7(), fromPrior: o.fromPrior ?? null, overrides: { intentHash: o.hash ?? (HASH as MessageHash), ...o.overrides }, admitted: o.admitted ?? false },
    { author: o.author ?? AUTHOR }
  );

/** The admission fold and the dispositions as comparable data. */
function picture(vault: VaultFold) {
  return {
    admissions: [...vault.admissions.admissions.values()].map(({ event, status }) => [event.data.sourceEventCid, status]),
    candidates: vault.dispositions.candidates.map(({ source, eligibility }) => [source.event.cid, eligibility]),
    dispositions: [...vault.channels.sources.keys()].sort().map((cid) => [cid, vault.dispositions.disposition(cid)]),
  };
}

const expectSameOverEveryOrder = (scene: Scene, checks: Required<VaultChecks>) => expectOrderFree(scene.events, (set) => picture(foldVault(set, checks)));

describe("an admission", () => {
  it("is effective when its source is positive evidence on its own, pending while the source or its evidence is still to arrive, and invalid for good when the source can never be positive or the record names no observation", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2 } = await vaults();
    const wire = uuidv7();
    const plain = observe(scene, { local: a0, peer: b0, ordinal: 1, wire });
    const effective = admitted(scene, plain);
    const carried = observe(scene, { local: a0, peer: b1, ordinal: 2, fromPrior: await proof(peerKeys, b0, b1) });
    const ofCarried = admitted(scene, carried);
    const unresolved = observe(scene, { local: a0, peer: b2, ordinal: 3, overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] } });
    const waitingForResolution = admitted(scene, unresolved);
    const b4 = await undocumentedPeer(peerKeys);
    const undocumented = observe(scene, { local: a0, peer: b2, ordinal: 4, fromPrior: await resign(peerKeys, b4, { alg: "EdDSA", typ: "JWT", kid: `${b4.did}${AUTHENTICATION_METHOD}` }, { iss: b4.did, sub: b2.longFormDid, iat: IAT }) });
    const waitingForProof = admitted(scene, undocumented);
    const absent = scene.add("message.admitted", { sourceEventCid: fakeEventCid() as EventReference<"message.in"> });
    const anonymousWire = uuidv7() as WireMessageId;
    const anonymous = observe(scene, { local: a0, peer: b0, ordinal: 5, wire: anonymousWire, overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), anonymousWire), peerResolutionEventCid: null, presentedDid: null, did: null } });
    const ofAnonymous = admitted(scene, anonymous);
    const contradicted = observation(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b1), ordinal: 6, presentedDid: b0.longFormDid });
    const ofContradicted = admitted(scene, contradicted);
    const refusedProof = observe(scene, { local: a0, peer: b1, ordinal: 7, fromPrior: "not a JWT" });
    const ofRefusedProof = admitted(scene, refusedProof);
    const disclosure = invitation(scene, a0);
    const misnamed = scene.add("message.admitted", { sourceEventCid: disclosure.cid as unknown as EventReference<"message.in"> });
    const repeated = observe(scene, { local: a0, peer: b0, ordinal: 8, wire });
    observe(scene, { local: a0, peer: b1, ordinal: 9 });
    const clashing = observe(scene, { local: a0, peer: b1, ordinal: 9 });
    const ofClashing = admitted(scene, clashing);

    const vault = await fold(scene, keys);
    const { admissions } = vault;
    expect([...admissions.admissions.values()].map(({ event, status }) => [event.cid, status])).toEqual([
      [effective.cid, { status: "effective" }],
      [ofCarried.cid, { status: "effective" }],
      [waitingForResolution.cid, { status: "pending", because: "the source's authentication is incomplete: the resolution it names is not here" }],
      [waitingForProof.cid, { status: "pending", because: "the source's proof is not yet verified" }],
      [absent.cid, { status: "pending", because: "the source it names is not here" }],
      [ofAnonymous.cid, { status: "invalid", because: "the source is anonymous, in no channel" }],
      [ofContradicted.cid, { status: "invalid", because: "the source's authentication is contradicted: the resolution it names is not of this sender at this key" }],
      [ofRefusedProof.cid, { status: "invalid", because: expect.stringMatching(/^the source's proof is invalid: not a compact JWT/) }],
      [misnamed.cid, { status: "invalid", because: "the source it names is a did.disclosed" }],
      [ofClashing.cid, { status: "invalid", because: "one author gave the source's ordinal to another observation" }],
    ]);
    expect([admissions.of(plain.cid), admissions.of(carried.cid).length, admissions.of(repeated.cid), admissions.of(fakeEventCid())]).toEqual([[admissions.admissions.get(effective.cid)], 1, [], []]);
    expect([plain, carried, unresolved, undocumented, anonymous, contradicted, refusedProof, repeated, clashing].map((event) => admissions.admitted(event.cid))).toEqual([true, true, false, false, false, false, false, false, false]);
    expect(vault.inbound.ofSource(plain.cid)!.members.map(({ admitted: isAdmitted, witness }) => [isAdmitted, witness.status])).toEqual([
      [true, "complete"],
      [false, "complete"],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    const unseeded = await fold(scene, null);
    expect(unseeded.admissions.admissions.get(effective.cid)!.status).toEqual({ status: "pending", because: "the source's authentication is incomplete: the local entity's keys are not yet checked against the seed" });
    expect(unseeded.admissions.admitted(plain.cid)).toBe(false);
    expectSameOverEveryOrder(scene, unseeded.checks);
  });
});

describe("a disposition", () => {
  it("is admitted by an effective admission whatever policy says now, refused for good by what refuses the source, ignored once the peer moved on without one, and pending otherwise with what stands in the way", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = await vaults();
    const wire = uuidv7();
    const first = observe(scene, { local: a0, peer: b0, ordinal: 1, wire });
    const ofFirst = admitted(scene, first);
    const consistent = observe(scene, { local: a0, peer: b0, ordinal: 2, wire });
    const contradicting = observe(scene, { local: a0, peer: b0, ordinal: 3, wire, hash: OTHER_HASH });
    const refusedProof = observe(scene, { local: a0, peer: b1, ordinal: 4, fromPrior: "not a JWT" });
    const carrier = observe(scene, { local: a0, peer: b3, ordinal: 5, fromPrior: await proof(peerKeys, b2, b3) });
    const late = observe(scene, { local: a0, peer: b2, ordinal: 6 });
    const lateAdmitted = observe(scene, { local: a0, peer: b2, ordinal: 7, admitted: true });
    blocked(scene, a0, b1);
    const denied = observe(scene, { local: a0, peer: b1, ordinal: 8 });
    const unresolved = observe(scene, { local: a0, peer: b1, ordinal: 9, overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] } });
    const recorded = observe(scene, { local: a0, peer: b1, ordinal: 10, overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] }, admitted: true });
    const clashing = observe(scene, { local: a0, peer: b1, ordinal: 11 });
    const clashingToo = observe(scene, { local: a0, peer: b1, ordinal: 11, admitted: true });

    const vault = await fold(scene, keys);
    const { dispositions } = vault;
    expect(dispositions.disposition(first.cid)).toEqual({ status: "admitted", admissions: [vault.admissions.admissions.get(ofFirst.cid)] });
    expect(dispositions.disposition(consistent.cid)).toEqual({ status: "pending-admission", because: "the observation is not yet reconciled" });
    expect(dispositions.disposition(contradicting.cid)).toEqual({ status: "pending-admission", because: "the observation contradicts the intent its input has admitted" });
    expect(dispositions.disposition(refusedProof.cid)).toEqual({ status: "refused", because: expect.stringMatching(/^the source's proof is invalid: not a compact JWT/) });
    expect(dispositions.disposition(carrier.cid)).toEqual({ status: "pending-admission", because: "the observation is not yet reconciled" });
    expect(dispositions.disposition(late.cid)).toEqual({ status: "ignored-superseded" });
    expect(dispositions.disposition(lateAdmitted.cid).status).toBe("admitted");
    expect(dispositions.disposition(denied.cid)).toEqual({ status: "pending-admission", because: "the channel is denied" });
    expect(dispositions.disposition(unresolved.cid)).toEqual({ status: "pending-admission", because: "the source's authentication is incomplete: the resolution it names is not here" });
    expect(dispositions.disposition(recorded.cid)).toEqual({ status: "pending-admission", because: "an admission is recorded and waits: the source's authentication is incomplete: the resolution it names is not here" });
    for (const event of [clashing, clashingToo]) expect(dispositions.disposition(event.cid)).toEqual({ status: "refused", because: "one author gave the source's ordinal to another observation" });
    expect(dispositions.disposition(fakeEventCid())).toEqual({ status: "pending-admission", because: "the source is not here" });
    expect(vault.inbound.ofSource(first.cid)).toMatchObject({ status: { status: "complete" }, intentHash: HASH, contradicting: [{ source: { event: { cid: contradicting.cid } } }] });
    expectSameOverEveryOrder(scene, vault.checks);
  });
});

describe("the candidates", () => {
  it("are every observation no effective or pending admission names, in first-receipt order, each judged for good, then by its receipt's integrity, then by what it lacks, then by current policy", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = await vaults();
    const wire = uuidv7();
    const first = observe(scene, { local: a0, peer: b3, ordinal: 1, wire, admitted: true });
    const consistent = observe(scene, { local: a0, peer: b3, ordinal: 2, wire });
    const contradicting = observe(scene, { local: a0, peer: b3, ordinal: 3, wire, hash: OTHER_HASH });
    const refusedProof = observe(scene, { local: a0, peer: b1, ordinal: 4, fromPrior: "not a JWT" });
    const unresolved = observe(scene, { local: a0, peer: b2, ordinal: 5, overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] } });
    const b4 = await undocumentedPeer(peerKeys);
    const undocumented = observe(scene, { local: a0, peer: b2, ordinal: 6, fromPrior: await resign(peerKeys, b4, { alg: "EdDSA", typ: "JWT", kid: `${b4.did}${AUTHENTICATION_METHOD}` }, { iss: b4.did, sub: b2.longFormDid, iat: IAT }) });
    const carrier = observe(scene, { local: a0, peer: b1, ordinal: 7, fromPrior: await proof(peerKeys, b0, b1) });
    const superseded = observe(scene, { local: a0, peer: b0, ordinal: 8 });
    blocked(scene, a0, b2);
    const denied = observe(scene, { local: a0, peer: b2, ordinal: 9 });
    const recorded = observe(scene, { local: a0, peer: b2, ordinal: 10, overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] }, admitted: true });
    const clashing = observe(scene, { local: a0, peer: b3, ordinal: 1, author: AUTHOR2 });
    const clashingToo = observe(scene, { local: a0, peer: b1, ordinal: 1, author: AUTHOR2 });

    const vault = await fold(scene, keys);
    expect(vault.dispositions.candidates.map(({ source, eligibility }) => [source.event.cid, eligibility])).toEqual([
      [clashing.cid, { status: "integrity-conflict" }],
      [clashingToo.cid, { status: "integrity-conflict" }],
      [consistent.cid, { status: "eligible" }],
      [contradicting.cid, { status: "refused", because: "the observation contradicts the intent its input has admitted" }],
      [refusedProof.cid, { status: "invalid", because: expect.stringMatching(/^the source's proof is invalid: not a compact JWT/) }],
      [unresolved.cid, { status: "deferred", because: "the source's authentication is incomplete: the resolution it names is not here" }],
      [undocumented.cid, { status: "deferred", because: "the source's proof is not yet verified" }],
      [carrier.cid, { status: "eligible" }],
      [superseded.cid, { status: "refused", because: "the peer has replaced its DID" }],
      [denied.cid, { status: "refused", because: "the channel is denied" }],
    ]);
    expect([first, recorded].map((event) => vault.dispositions.candidate(event.cid))).toEqual([null, null]);
    expect(vault.dispositions.candidate(consistent.cid)).toBe(vault.dispositions.candidates[2]);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("hold a proof-free receipt eligible in a conflicted context, since it witnesses on its own authentication, and refuse the carrier whose proof the conflict is about", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2 } = await vaults();
    const toB1 = observe(scene, { local: a0, peer: b1, ordinal: 1, fromPrior: await proof(peerKeys, b0, b1), admitted: true });
    const toB2 = observe(scene, { local: a0, peer: b2, ordinal: 2, fromPrior: await proof(peerKeys, b0, b2) });
    const plain = observe(scene, { local: a0, peer: b1, ordinal: 3 });
    const vault = await fold(scene, keys);
    expect(vault.continuity.conflicted({ localDid: a0.did, peerDid: b0.did })).toBe(true);
    expect(vault.continuity.witness(toB1.cid).status).toBe("conflict");
    expect(vault.dispositions.candidates.map(({ source, eligibility }) => [source.event.cid, eligibility])).toEqual([
      [toB2.cid, { status: "refused", because: expect.stringMatching(/^the continuity its proof establishes is in conflict: /) }],
      [plain.cid, { status: "eligible" }],
    ]);
    expect(vault.dispositions.disposition(toB1.cid).status).toBe("admitted");
    expect(vault.inbound.ofSource(toB1.cid)!.status).toEqual({ status: "pending", because: expect.stringMatching(/^no admitted observation is a complete witness: /) });
    expectSameOverEveryOrder(scene, vault.checks);
  });
});
