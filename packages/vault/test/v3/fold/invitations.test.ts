import type { Event, EventId } from "@estoc/event-store/v3";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import { VaultEventSet, anonymousMessageId, didKeyName, foldVault, foldVaultChecked, inboundMessageId, type EventReference, type Keys, type MessageHash, type ReadObject, type VaultChecks, type VaultData, type VaultFold, type WireMessageId } from "../../../src/v3/index.js";
import { ENDPOINT, MEDIATION, ROUTE, expectOrderFree, type Scene } from "./helpers.js";
import { blocked, consumed, invitation, noObjects, proof, receipt, resolved, rotation, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);

/** A proof-free receipt from the peer at one of our DIDs, following the invitation. */
const follower = (scene: Scene, local: Local, peer: Peer, oobId: string, ordinal: number, extra: Partial<Parameters<typeof receipt>[1]> = {}) =>
  receipt(scene, { local, peer, resolution: resolved(scene, local.didId, peer), ordinal, ...extra, overrides: { pthid: oobId, ...extra.overrides } });

/** The invitations as comparable data: every invitation and record by its verdicts, the candidates by their eligibility. */
function picture(vault: VaultFold) {
  const { invitations } = vault;
  return {
    invitations: [...invitations.invitations.values()].map((invitation) => ({
      oobId: invitation.oobId,
      localDid: invitation.localDid,
      consumer: invitation.consumer,
      status: invitation.status,
      consumptions: invitation.consumptions.map(({ event, status }) => [event.eventId, status]),
      candidates: invitation.candidates.map(({ source, eligibility }) => [source.event.eventId, eligibility]),
    })),
    consumptions: [...invitations.consumptions.values()].map(({ event, status }) => [event.eventId, status]),
  };
}

const expectSameOverEveryOrder = (scene: Scene, checks: Required<VaultChecks>) => expectOrderFree(scene.events, (set) => picture(foldVault(set, checks)));

const vaultSet = (events: readonly Event[]) => VaultEventSet.of(events);

const OTHER_HASH = "Amqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA" as MessageHash;

const eligibilities = (vault: VaultFold, disclosure: { eventId: EventId }) => vault.invitations.invitations.get(disclosure.eventId)!.candidates.map(({ source, eligibility }) => [source.event.eventId, eligibility.status]);

describe("an invitation", () => {
  it("is available with its followers as candidates in first-receipt order, and consumed by the one the record names", async () => {
    const { scene, keys, a0, a1, b0, b1, b2 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    const second = follower(scene, a0, b1, oobId, 2);
    const first = follower(scene, a0, b0, oobId, 1);
    follower(scene, a0, b2, oobId, 3, { fromPrior: await proof(keys, a1, a0) });
    follower(scene, a0, b2, oobId, 4, { overrides: { pthid: uuidv7() } });
    follower(scene, a1, b2, oobId, 5);
    const erased = follower(scene, a0, b2, oobId, 6);
    scene.add("message.erased", { messageId: erased.data.messageId, dropCids: [erased.data.bodyCid], because: "user" });
    let vault = await fold(scene, keys);
    let inv = vault.invitations.invitations.get(disclosure.eventId)!;
    expect(inv).toMatchObject({ oobId, didId: a0.didId, localDid: a0.did, consumer: null, status: { status: "available" }, consumptions: [] });
    expect(eligibilities(vault, disclosure)).toEqual([
      [first.eventId, "eligible"],
      [second.eventId, "eligible"],
    ]);
    expect(vault.invitations.under(oobId)).toEqual([inv]);
    expect(vault.invitations.under("nobody's")).toEqual([]);
    expectSameOverEveryOrder(scene, vault.checks);

    const record = consumed(scene, disclosure, first);
    const again = consumed(scene, disclosure, follower(scene, a0, b0, oobId, 7));
    vault = await fold(scene, keys);
    inv = vault.invitations.invitations.get(disclosure.eventId)!;
    expect(inv.status).toEqual({ status: "consumed", consumer: b0.did });
    expect(inv.consumer).toBe(b0.did);
    expect(inv.consumptions.map(({ event, status }) => [event.eventId, status])).toEqual([
      [record.eventId, { status: "complete", consumer: b0.did }],
      [again.eventId, { status: "complete", consumer: b0.did }],
    ]);
    expect(eligibilities(vault, disclosure).map(([, status]) => status)).toEqual(["eligible", "eligible", "eligible"]);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("stays consumed through retirement, denial, supersession and erasure of its source, and takes no other consumer", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    const source = follower(scene, a0, b0, oobId, 1);
    consumed(scene, disclosure, source);
    const other = follower(scene, a0, b1, oobId, 2);
    const late = consumed(scene, disclosure, other);
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    blocked(scene, a0, b0, true);
    receipt(scene, { local: a0, peer: b1, resolution: resolved(scene, a0.didId, b1), ordinal: 3, fromPrior: await proof(peerKeys, b0, b1) });
    scene.add("message.erased", { messageId: source.data.messageId, dropCids: [source.data.bodyCid], because: "user" });
    const vault = await fold(scene, keys);
    const inv = vault.invitations.invitations.get(disclosure.eventId)!;
    expect(inv.status).toEqual({ status: "conflict", because: "the complete records name different consumers" });
    expect(inv.consumer).toBeNull();
    expect(inv.consumptions.map(({ status }) => status)).toEqual([
      { status: "complete", consumer: b0.did },
      { status: "complete", consumer: b1.did },
    ]);
    expect(eligibilities(vault, disclosure)).toEqual([[other.eventId, "refused"]]);
    expectSameOverEveryOrder(scene, vault.checks);

    const events = scene.events.filter((event) => event !== late);
    const settled = foldVault(vaultSet(events), vault.checks);
    const one = settled.invitations.invitations.get(disclosure.eventId)!;
    expect(one.status).toEqual({ status: "consumed", consumer: b0.did });
    expect(one.consumer).toBe(b0.did);
  });

  it("cannot acquire a consumer on a retired or unknown DID, its candidates refused, while a record that waits keeps it pending", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const retired = invitation(scene, a0);
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    const candidate = follower(scene, a0, b0, retired.data.oobId!, 1);
    const unknown = invitation(scene, { didId: "019b7000-0000-7000-8000-00000000ffff" as Local["didId"], did: a1.did, longFormDid: a1.longFormDid });
    let vault = await fold(scene, keys);
    expect(vault.invitations.invitations.get(retired.eventId)!.status).toEqual({ status: "unavailable", because: "the disclosed DID is retired" });
    expect(vault.invitations.invitations.get(retired.eventId)!.candidates.map(({ eligibility }) => eligibility)).toEqual([{ status: "refused", because: "the disclosed DID is retired" }]);
    expect(eligibilities(vault, retired)).toEqual([[candidate.eventId, "refused"]]);
    expect(vault.invitations.invitations.get(unknown.eventId)).toMatchObject({ localDid: null, status: { status: "unavailable", because: "the disclosed DID has no consistent creation here" } });
    expectSameOverEveryOrder(scene, vault.checks);

    scene.add("invitation.consumed", { disclosureEventId: retired.eventId as EventReference<"did.disclosed">, sourceEventId: uuidv7() as EventReference<"message.in"> });
    vault = await fold(scene, keys);
    expect(vault.invitations.invitations.get(retired.eventId)!.status).toEqual({ status: "pending", because: "the source it names is not here" });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("cannot acquire a consumer once its DID's route is retired, misconfigured or on a retired mediation, and waits while the mediation's grant is missing", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    const source = follower(scene, a0, b0, oobId, 1);
    const vault = await fold(scene, keys);
    const over = (events: readonly Event[]) => foldVault(vaultSet(events), vault.checks).invitations.invitations.get(disclosure.eventId)!;
    const ended = (because: string) => ({ status: { status: "unavailable", because }, candidates: [{ eligibility: { status: "refused", because } }] });

    const retired = scene.add("route.retired", { routeId: ROUTE, because: "moved" });
    expect(over(scene.events)).toMatchObject(ended("the bound route is retired"));
    expect(over([...scene.events, consumed(scene, disclosure, source)])).toMatchObject({ status: { status: "consumed", consumer: b0.did } });
    const settled = scene.events.filter((event) => event !== retired && event.type !== "invitation.consumed");

    expect(over([...settled, scene.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT })])).toMatchObject(ended("the bound route's configurations disagree"));
    expect(over([...settled, scene.add("mediation.retired", { mediationId: MEDIATION, because: "gone" })])).toMatchObject(ended("the bound route's mediation is terminal"));

    const ungranted = settled.filter((event) => event.type !== "mediation.granted");
    expect(over(ungranted)).toMatchObject({ status: { status: "pending", because: `mediation ${MEDIATION} is pending` }, candidates: [{ eligibility: { status: "deferred", because: `mediation ${MEDIATION} is pending` } }] });
    expect(over(settled)).toMatchObject({ status: { status: "available" }, candidates: [{ eligibility: { status: "eligible" } }] });
    expectOrderFree(ungranted, (set) => picture(foldVault(set, vault.checks)));
  });

  it("is in conflict when its ID is disclosed twice, by one-use or many-use disclosures at any DID, whatever else the records say", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const twice = uuidv7();
    const one = invitation(scene, a0, twice);
    const two = invitation(scene, a1, twice);
    consumed(scene, one, follower(scene, a0, b0, twice, 1));
    const shadowed = invitation(scene, a0);
    const shadow = invitation(scene, a0, shadowed.data.oobId!, { uses: "many" });
    const elsewhere = invitation(scene, a0);
    invitation(scene, a1, elsewhere.data.oobId!, { uses: "many" });
    const candidate = follower(scene, a0, b1, elsewhere.data.oobId!, 2);
    const vault = await fold(scene, keys);
    for (const disclosure of [one, two, shadowed, elsewhere]) {
      expect(vault.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "conflict", because: "the invitation's ID is disclosed more than once" });
    }
    expect(vault.invitations.invitations.get(one.eventId)!.consumer).toBe(b0.did);
    expect(vault.invitations.invitations.has(shadow.eventId)).toBe(false);
    expect(eligibilities(vault, elsewhere)).toEqual([[candidate.eventId, "eligible"]]);
    expect(vault.invitations.under(twice).map((invitation) => invitation.disclosure)).toEqual([one, two]);
    expect(vault.invitations.under(shadowed.data.oobId!).map((invitation) => invitation.disclosure)).toEqual([shadowed]);
    expectSameOverEveryOrder(scene, vault.checks);
  });
});

describe("a consumption record", () => {
  it("is read on its own: pending on what may still arrive, invalid on what contradicts it, complete only as a proof-free complete witness of the invitation at its DID", async () => {
    const { scene, keys, a0, a1, b0, b1, b2 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    const many = invitation(scene, a0, uuidv7(), { uses: "many" });
    const direct = scene.add("did.disclosed", { didId: a0.didId, as: "direct", uses: "many", oobId: null, goal: null });
    const good = follower(scene, a0, b0, oobId, 1);
    const wire = uuidv7() as WireMessageId;
    const root = resolved(scene, a0.didId, b1);
    const anonymous = receipt(scene, { local: a0, peer: b1, resolution: root, ordinal: 2, wire, overrides: { pthid: oobId, messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), wire), peerResolutionEventId: null, did: null, presentedDid: null } });
    const carrying = follower(scene, a0, b1, oobId, 3, { fromPrior: await proof(keys, a1, a0) });
    const elsewhere = follower(scene, a1, b1, oobId, 4);
    const unrelated = follower(scene, a0, b1, uuidv7(), 5);
    const contradicted = follower(scene, a0, b2, oobId, 6, { overrides: { messageId: inboundMessageId(b2.did, a1.did, "other" as WireMessageId) } });
    const undocumented = receipt(scene, { local: a0, peer: b2, resolution: resolved(scene, a0.didId, b2, { short: true }), ordinal: 7, presentedDid: b2.did, overrides: { pthid: oobId } });

    const records = {
      complete: consumed(scene, disclosure, good),
      noDisclosure: scene.add("invitation.consumed", { disclosureEventId: uuidv7() as EventReference<"did.disclosed">, sourceEventId: good.eventId as EventReference<"message.in"> }),
      noSource: scene.add("invitation.consumed", { disclosureEventId: disclosure.eventId as EventReference<"did.disclosed">, sourceEventId: uuidv7() as EventReference<"message.in"> }),
      notADisclosure: scene.add("invitation.consumed", { disclosureEventId: good.eventId as never, sourceEventId: good.eventId as EventReference<"message.in"> }),
      notASource: scene.add("invitation.consumed", { disclosureEventId: disclosure.eventId as EventReference<"did.disclosed">, sourceEventId: disclosure.eventId as never }),
      manyUse: consumed(scene, many, good),
      direct: consumed(scene, direct, good),
      anonymous: consumed(scene, disclosure, anonymous),
      carrying: consumed(scene, disclosure, carrying),
      elsewhere: consumed(scene, disclosure, elsewhere),
      unrelated: consumed(scene, disclosure, unrelated),
      contradicted: consumed(scene, disclosure, contradicted),
      undocumented: consumed(scene, disclosure, undocumented),
    };
    const vault = await fold(scene, keys);
    const status = (record: { eventId: EventId }) => vault.invitations.consumptions.get(record.eventId)!.status;
    expect(status(records.complete)).toEqual({ status: "complete", consumer: b0.did });
    expect(status(records.noDisclosure)).toEqual({ status: "pending", because: "the disclosure it names is not here" });
    expect(status(records.noSource)).toEqual({ status: "pending", because: "the source it names is not here" });
    expect(status(records.notADisclosure)).toEqual({ status: "invalid", because: "the disclosure it names is a message.in" });
    expect(status(records.notASource)).toEqual({ status: "invalid", because: "the source it names is a did.disclosed" });
    expect(status(records.manyUse)).toEqual({ status: "invalid", because: "the disclosure it names is not a one-use invitation" });
    expect(status(records.direct)).toEqual({ status: "invalid", because: "the disclosure it names is not a one-use invitation" });
    expect(status(records.anonymous)).toEqual({ status: "invalid", because: "the source is anonymous, in no pair" });
    expect(status(records.carrying)).toEqual({ status: "invalid", because: "the source carries a proof" });
    expect(status(records.elsewhere)).toEqual({ status: "invalid", because: "the source is not at the disclosed DID's key-agreement key" });
    expect(status(records.unrelated)).toEqual({ status: "invalid", because: "the source's pthid is not the invitation's ID" });
    expect(status(records.contradicted)).toMatchObject({ status: "conflict" });
    expect(status(records.undocumented)).toEqual({ status: "pending", because: "the source is no complete witness: the resolution's document is not here" });
    expect(vault.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "conflict", because: (status(records.contradicted) as { because: string }).because });
    expect(eligibilities(vault, disclosure)).toEqual([
      [good.eventId, "eligible"],
      [anonymous.eventId, "invalid"],
      [contradicted.eventId, "invalid"],
      [undocumented.eventId, "deferred"],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    const events = scene.events.filter((event) => event !== records.contradicted);
    const settled = foldVault(vaultSet(events), vault.checks);
    expect(settled.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "consumed", consumer: b0.did });
  });

  it("leaves the invitation pending while it waits, and lets no candidate be selected past it", async () => {
    const { scene, keys, a0, b0, b1 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    follower(scene, a0, b1, oobId, 1);
    const waiting = scene.add("invitation.consumed", { disclosureEventId: disclosure.eventId as EventReference<"did.disclosed">, sourceEventId: uuidv7() as EventReference<"message.in"> });
    const vault = await fold(scene, keys);
    const inv = vault.invitations.invitations.get(disclosure.eventId)!;
    expect(inv.status).toEqual({ status: "pending", because: "the source it names is not here" });
    expect(inv.candidates.map(({ eligibility }) => eligibility)).toEqual([{ status: "eligible" }]);

    const arrived = follower(scene, a0, b0, oobId, 2);
    const events = scene.events.map((event) => (event === waiting ? { ...waiting, data: { ...waiting.data, sourceEventId: arrived.eventId } } : event));
    const settled = await foldVaultChecked(vaultSet(events), keys, noObjects);
    expect(settled.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "consumed", consumer: b0.did });
    expectSameOverEveryOrder(scene, vault.checks);
  });
});

describe("the candidates", () => {
  it("are walked in first-receipt order: refused and invalid skipped, a deferred one stopping the walk, the first eligible one selecting", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    const undocumented = (peer: Peer, ordinal: number) => receipt(scene, { local: a0, peer, resolution: resolved(scene, a0.didId, peer, { short: true }), ordinal, presentedDid: peer.did, overrides: { pthid: oobId } });
    blocked(scene, a0, b0);
    const deniedEarly = undocumented(b0, 10);
    const supersededEarly = undocumented(b1, 20);
    const denied = follower(scene, a0, b0, oobId, 30);
    receipt(scene, { local: a0, peer: b2, resolution: resolved(scene, a0.didId, b2), ordinal: 40, fromPrior: await proof(peerKeys, b1, b2) });
    const superseded = follower(scene, a0, b1, oobId, 50);
    const eligible = follower(scene, a0, b3, oobId, 60);
    let vault = await fold(scene, keys);
    expect(vault.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "available" });
    expect(vault.invitations.invitations.get(disclosure.eventId)!.candidates.map(({ eligibility }) => eligibility)).toEqual([
      { status: "refused", because: "the channel is denied" },
      { status: "refused", because: "the peer has replaced its DID" },
      { status: "refused", because: "the channel is denied" },
      { status: "refused", because: "the peer has replaced its DID" },
      { status: "eligible" },
    ]);
    expect(eligibilities(vault, disclosure).map(([id]) => id)).toEqual([deniedEarly.eventId, supersededEarly.eventId, denied.eventId, superseded.eventId, eligible.eventId]);
    expectSameOverEveryOrder(scene, vault.checks);

    const unknown = undocumented(b2, 55);
    vault = await fold(scene, keys);
    expect(vault.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "pending", because: "the resolution's document is not here" });
    expect(eligibilities(vault, disclosure)[4]).toEqual([unknown.eventId, "deferred"]);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("are invalid on an input whose authenticated intents disagree, under whichever thread or proof the disagreement came, and eligible beside siblings that cannot raise one", async () => {
    const { scene, keys, a0, b0, b1, b2, b3 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    const contradicted = uuidv7();
    const agreed = follower(scene, a0, b0, oobId, 20, { wire: contradicted });
    const disagreeing = follower(scene, a0, b0, oobId, 21, { wire: contradicted, overrides: { intentHash: OTHER_HASH } });
    const elsewhere = uuidv7();
    const followed = follower(scene, a0, b2, oobId, 30, { wire: elsewhere });
    receipt(scene, { local: a0, peer: b2, resolution: resolved(scene, a0.didId, b2), ordinal: 31, wire: elsewhere, overrides: { intentHash: OTHER_HASH, pthid: uuidv7() } });
    const independent = follower(scene, a0, b1, oobId, 40);
    const beside = uuidv7();
    const besideSiblings = follower(scene, a0, b3, oobId, 50, { wire: beside });
    receipt(scene, { local: a0, peer: b3, resolution: resolved(scene, a0.didId, b3), ordinal: 51, wire: beside, overrides: { intentHash: OTHER_HASH, pthid: uuidv7(), peerResolutionEventId: uuidv7() as VaultData["message.in"]["peerResolutionEventId"] } });
    receipt(scene, { local: a0, peer: b3, resolution: resolved(scene, a0.didId, b3), ordinal: 52, wire: beside, fromPrior: "not a JWT", overrides: { intentHash: OTHER_HASH, pthid: oobId } });
    const vault = await fold(scene, keys);
    expect(vault.inbound.ofSource(agreed.eventId)!.status.status).toBe("conflict");
    expect(vault.inbound.ofSource(followed.eventId)!.status.status).toBe("conflict");
    expect(vault.inbound.ofSource(besideSiblings.eventId)!.status.status).toBe("complete");
    expect(vault.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "available" });
    expect(vault.invitations.invitations.get(disclosure.eventId)!.candidates.map(({ eligibility }) => eligibility)).toEqual([
      { status: "invalid", because: "the input is in an intent conflict: 2 intents are authenticated for one input" },
      { status: "invalid", because: "the input is in an intent conflict: 2 intents are authenticated for one input" },
      { status: "invalid", because: "the input is in an intent conflict: 2 intents are authenticated for one input" },
      { status: "eligible" },
      { status: "eligible" },
    ]);
    expect(eligibilities(vault, disclosure).map(([id]) => id)).toEqual([agreed.eventId, disagreeing.eventId, followed.eventId, independent.eventId, besideSiblings.eventId]);
    expectSameOverEveryOrder(scene, vault.checks);

    const record = consumed(scene, disclosure, agreed);
    const recorded = foldVault(vaultSet(scene.events), vault.checks).invitations.invitations.get(disclosure.eventId)!;
    expect(recorded.consumptions.map(({ event, status }) => [event, status])).toEqual([[record, { status: "complete", consumer: b0.did }]]);
    expect(recorded.status).toEqual({ status: "consumed", consumer: b0.did });
  });

  it("are refused on a channel in a continuity conflict, whether our end or the peer's forked, and untouched on a channel outside it", async () => {
    const { scene, keys, peerKeys, a0, a1, a2, b0, b1, b2, b3 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    const other = invitation(scene, a1);
    await rotation(scene, keys, { from: a0, peer: b0, to: a1 });
    await rotation(scene, keys, { from: a0, peer: b0, to: a2 });
    const localFork = follower(scene, a0, b0, oobId, 1);
    receipt(scene, { local: a0, peer: b2, resolution: resolved(scene, a0.didId, b2), ordinal: 2, fromPrior: await proof(peerKeys, b1, b2) });
    receipt(scene, { local: a0, peer: b3, resolution: resolved(scene, a0.didId, b3), ordinal: 3, fromPrior: await proof(peerKeys, b1, b3) });
    const peerFork = follower(scene, a0, b1, oobId, 4);
    const outside = follower(scene, a1, b1, other.data.oobId!, 5);
    const vault = await fold(scene, keys);
    expect(vault.continuity.conflicts.map(({ kind }) => kind).sort()).toEqual(["competing-local-successors", "competing-peer-successors"]);
    expect(vault.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "available" });
    expect(vault.invitations.invitations.get(disclosure.eventId)!.candidates).toMatchObject([
      { source: { event: localFork }, eligibility: { status: "refused", because: "the channel is in a continuity conflict" } },
      { source: { event: peerFork }, eligibility: { status: "refused", because: "the channel is in a continuity conflict" } },
    ]);
    expect(eligibilities(vault, other)).toEqual([[outside.eventId, "eligible"]]);
    expectSameOverEveryOrder(scene, vault.checks);

    const record = consumed(scene, disclosure, localFork);
    const recorded = foldVault(vaultSet(scene.events), vault.checks).invitations.invitations.get(disclosure.eventId)!;
    expect(recorded.consumptions.map(({ event, status }) => [event, status])).toEqual([[record, { status: "complete", consumer: b0.did }]]);
    expect(recorded.status).toEqual({ status: "consumed", consumer: b0.did });
  });

  it("wait for the seed's word on the disclosed DID, and a receipt-integrity conflict among them leaves the invitation in conflict", async () => {
    const { scene, keys, a0, b0, b1 } = await vaults();
    const disclosure = invitation(scene, a0);
    const oobId = disclosure.data.oobId!;
    follower(scene, a0, b0, oobId, 1);
    const unseeded = await fold(scene, null);
    expect(unseeded.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "pending", because: "the local entity's keys are not yet checked against the seed" });
    expect(eligibilities(unseeded, disclosure).map(([, status]) => status)).toEqual(["deferred"]);

    follower(scene, a0, b1, oobId, 1);
    const vault = await fold(scene, keys);
    expect(vault.invitations.invitations.get(disclosure.eventId)!.status).toEqual({ status: "conflict", because: "a candidate receipt is caught in a receipt-integrity conflict" });
    expect(eligibilities(vault, disclosure).map(([, status]) => status)).toEqual(["integrity-conflict", "integrity-conflict"]);
    expectSameOverEveryOrder(scene, vault.checks);
  });
});
