import { beforeAll, describe, expect, it } from "vitest";

import {
  Keys,
  VaultEventSet,
  foldInvitations,
  mintMediationDid,
  relationshipId,
  type Did,
  type EventReference,
  type KeyName,
  type RelationshipId,
  type VaultData,
} from "../../../src/v3/index.js";
import { DID_ID, DID_ID2, MEDIATED, MEDIATION, PEER_DID, PEER_KEY, ROUTE, Scene, bind, checksOf, cidOf, createdDid, expectOrderFree, foldChecked, mediatedRoute, messageIn, openKeys, type KeyChecks } from "./helpers.js";

const OOB = "019b2a57-a947-7502-8fee-4d80d949dbcb";
const OOB2 = "019b2a58-1111-7502-8fee-4d80d949dbcb";
const OTHER_PEER = "did:web:carol.example" as Did;
const JWT = "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6ZXhhbXBsZTphIn0.c2ln";

let keys: Keys;
let me: Did;

beforeAll(async () => {
  keys = await openKeys();
  me = (await mintMediationDid(keys, MEDIATION)).longFormDid;
});

const fold = (checks: KeyChecks) => (set: VaultEventSet) => foldInvitations(set, foldChecked(set, checks).routes);
/** The invitation fold over the scene with the seed's verdicts on its DIDs. */
async function folded(scene: Scene, events = scene.events) {
  const checks = await checksOf(scene.events, keys);
  return { fold: fold(checks), invitations: fold(checks)(VaultEventSet.of(events)) };
}

async function disclosed(): Promise<{ scene: Scene; a: VaultData["did.created"]; b: VaultData["did.created"] }> {
  const scene = new Scene();
  mediatedRoute(scene, { me });
  const a = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
  const b = await createdDid(scene, keys, DID_ID2, ROUTE, MEDIATED);
  scene.add("did.disclosed", { didId: DID_ID, as: "oob", uses: "one", oobId: OOB, goal: "Write to Alice" });
  return { scene, a, b };
}

describe("the invitation fold", () => {
  it("offers a one-use invitation while its DID is live and nothing consumed it, and not while the seed has not confirmed the DID", async () => {
    const { scene } = await disclosed();
    scene.add("did.disclosed", { didId: DID_ID, as: "profile", uses: "many", oobId: null, goal: null });
    const { invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB)).toMatchObject({ oobId: OOB, didId: DID_ID, uses: "one", goal: "Write to Alice", consumers: [], pending: [], inconsistent: [], faults: [], conflict: false, available: true });
    expect(invitations.invitations.size).toBe(1);
    const R = relationshipId("did:web:a.example" as Did, "did:web:b.example" as Did);
    expect(invitations.consumable(OOB, R)).toBe("consumable");
    expect(invitations.consumable(OOB2, R)).toBe("unavailable");
    const unchecked = fold({ mediations: new Map(), dids: new Map() })(scene.set());
    expect(unchecked.invitations.get(OOB)).toMatchObject({ available: false, consumers: [] });
    expect(unchecked.consumable(OOB, R)).toBe("pending");
    scene.add("did.retired", { didId: DID_ID, because: "done" });
    const retired = (await folded(scene)).invitations;
    expect(retired.invitations.get(OOB)).toMatchObject({ available: false, consumers: [] });
    expect(retired.consumable(OOB, R)).toBe("unavailable");
  });

  it("is consumed by a matching root-address receipt, once, and stays consumed for that relationship only", async () => {
    const { scene, a } = await disclosed();
    const { R, resolved, bound } = bind(scene, { didId: DID_ID, did: a.did });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 1 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 2 });
    const { fold, invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [R], conflict: false, available: false });
    expect(invitations.consumable(OOB, R)).toBe("consumable");
    expect(invitations.consumable(OOB, relationshipId(a.did, OTHER_PEER))).toBe("unavailable");
    scene.add("did.retired", { didId: DID_ID, because: "done" });
    const first = scene.set().of("message.in")[0]!.data;
    scene.add("message.erased", { messageId: first.messageId, dropCids: [first.bodyCid], because: "user" });
    expect(fold(scene.set()).invitations.get(OOB)).toMatchObject({ consumers: [R], available: false });
    expectOrderFree(scene.events, fold);
  });

  it("marks two distinct consumers as a conflict that closes the invitation to both", async () => {
    const { scene, a } = await disclosed();
    const first = bind(scene, { didId: DID_ID, did: a.did });
    const second = bind(scene, { didId: DID_ID, did: a.did }, OTHER_PEER);
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: first.bound, resolution: first.resolved, ordinal: 1 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, peerDid: OTHER_PEER, pthid: OOB, binding: second.bound, resolution: second.resolved, ordinal: 2 });
    const { fold, invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [first.R, second.R].sort(), faults: ["consumed by 2 relationships"], conflict: true, available: false });
    expect(invitations.consumable(OOB, first.R)).toBe("unavailable");
    expect(invitations.consumable(OOB, second.R)).toBe("unavailable");
    expectOrderFree(scene.events, fold);
  });

  it("keeps a consumed or conflicted one-use invitation closed when a later disclosure of the same ID says many, and marks the disagreement", async () => {
    const { scene, a } = await disclosed();
    const first = bind(scene, { didId: DID_ID, did: a.did });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: first.bound, resolution: first.resolved, ordinal: 1 });
    scene.add("did.disclosed", { didId: DID_ID, as: "oob", uses: "many", oobId: OOB, goal: null });
    const { fold, invitations } = await folded(scene);
    const other = relationshipId(a.did, OTHER_PEER);
    expect(invitations.invitations.get(OOB)).toMatchObject({ uses: "one", consumers: [first.R], faults: ["disclosures disagree on the use"], conflict: true, available: false });
    expect(invitations.consumable(OOB, other)).toBe("unavailable");
    expect(invitations.consumable(OOB, first.R)).toBe("unavailable");
    const second = bind(scene, { didId: DID_ID, did: a.did }, OTHER_PEER);
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, peerDid: OTHER_PEER, pthid: OOB, binding: second.bound, resolution: second.resolved, ordinal: 2 });
    expect(fold(scene.set()).invitations.get(OOB)).toMatchObject({ consumers: [first.R, second.R].sort(), faults: ["disclosures disagree on the use", "consumed by 2 relationships"], conflict: true, available: false });
    expectOrderFree(scene.events, fold);
  });

  it("marks disclosures of one ID on two DIDs as a conflict", async () => {
    const { scene } = await disclosed();
    scene.add("did.disclosed", { didId: DID_ID2, as: "oob", uses: "one", oobId: OOB, goal: null });
    const { invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB)).toMatchObject({ didId: DID_ID, faults: ["disclosures disagree on the DID"], conflict: true, available: false });
  });

  it("is not consumed by a continuation, another local recipient, a sender other than the root peer or a bare pthid match", async () => {
    const { scene, a, b } = await disclosed();
    const { resolved, bound } = bind(scene, { didId: DID_ID, did: a.did });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, fromPrior: JWT, ordinal: 1 });
    const atB = bind(scene, { didId: DID_ID2, did: b.did });
    messageIn(scene, { localDidId: DID_ID2, localDid: b.did, pthid: OOB, binding: atB.bound, resolution: atB.resolved, ordinal: 2 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, peerDid: OTHER_PEER, pthid: OOB, binding: bound, resolution: resolved, ordinal: 3 });
    messageIn(scene, { localDidId: DID_ID2, localDid: b.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 4 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: null, resolution: null, ordinal: 5 });
    const { fold, invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [], pending: [], inconsistent: [], conflict: false, available: true });
    expectOrderFree(scene.events, fold);
  });

  it("holds a receipt whose binding, root resolution or own resolution is not here as pending, consuming nothing yet but admitting nobody else", async () => {
    const { scene, a } = await disclosed();
    const { R, resolved, bound } = bind(scene, { didId: DID_ID, did: a.did });
    const stranger = relationshipId(a.did, OTHER_PEER);
    const orphan = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: "019b2a99-0000-7000-8000-000000000001" as EventReference<"relationship.bound">, resolution: resolved, ordinal: 1 });
    const { fold } = await folded(scene);
    const withoutBinding = fold(VaultEventSet.of(scene.events.filter((event) => event.eventId !== bound)));
    expect(withoutBinding.invitations.get(OOB)).toMatchObject({ consumers: [], pending: [orphan.eventId], available: false });
    expect(withoutBinding.consumable(OOB, R)).toBe("pending");
    expect(withoutBinding.consumable(OOB, stranger)).toBe("pending");
    const held = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 2 });
    const withoutResolution = fold(VaultEventSet.of(scene.events.filter((event) => event.eventId !== resolved)));
    expect([...withoutResolution.invitations.get(OOB)!.pending].sort()).toEqual([orphan.eventId, held.eventId].sort());
    expect(withoutResolution.invitations.get(OOB)).toMatchObject({ consumers: [], available: false });
    expect(withoutResolution.consumable(OOB, stranger)).toBe("pending");
    const ownMissing = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: "019b2a99-0000-7000-8000-000000000002" as EventReference<"peer.resolved">, ordinal: 3 });
    const complete = fold(scene.set());
    expect(complete.invitations.get(OOB)).toMatchObject({ consumers: [R], pending: [orphan.eventId, ownMissing.eventId], available: false });
    expect(complete.consumable(OOB, R)).toBe("consumable");
    expect(complete.consumable(OOB, stranger)).toBe("unavailable");
    expectOrderFree(scene.events, fold);
  });

  it("admits the relationship a pending receipt's binding claims, and only that one, until the receipt's own resolution arrives", async () => {
    const { scene, a, b } = await disclosed();
    scene.add("did.disclosed", { didId: DID_ID2, as: "oob", uses: "many", oobId: OOB2, goal: null });
    const { R, resolved, bound } = bind(scene, { didId: DID_ID, did: a.did });
    const stranger = relationshipId(a.did, OTHER_PEER);
    const own = scene.add("peer.resolved", scene.events.find((event) => event.eventId === resolved)!.data as VaultData["peer.resolved"]);
    const receipt = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: own.eventId as EventReference<"peer.resolved">, ordinal: 1 });
    const atB = bind(scene, { didId: DID_ID2, did: b.did });
    const reusable = messageIn(scene, { localDidId: DID_ID2, localDid: b.did, pthid: OOB2, binding: atB.bound, resolution: "019b2a99-0000-7000-8000-000000000003" as EventReference<"peer.resolved">, ordinal: 2 });
    const { fold } = await folded(scene);
    const waiting = fold(VaultEventSet.of(scene.events.filter((event) => event.eventId !== own.eventId)));
    expect(waiting.invitations.get(OOB)).toMatchObject({ consumers: [], pending: [receipt.eventId], inconsistent: [], conflict: false, available: false });
    expect(waiting.consumable(OOB, stranger)).toBe("pending");
    expect(waiting.consumable(OOB, R)).toBe("consumable");
    expect(waiting.invitations.get(OOB2)).toMatchObject({ consumers: [], pending: [reusable.eventId], available: true });
    expect(waiting.consumable(OOB2, relationshipId(b.did, OTHER_PEER))).toBe("consumable");
    const arrived = fold(scene.set());
    expect(arrived.invitations.get(OOB)).toMatchObject({ consumers: [R], pending: [], conflict: false, available: false });
    expect(arrived.consumable(OOB, R)).toBe("consumable");
    expect(arrived.consumable(OOB, stranger)).toBe("unavailable");
    expectOrderFree(scene.events, fold);
  });

  it("counts no consumer for a binding the events it names contradict, and lists the receipt as inconsistent", async () => {
    const { scene, a, b } = await disclosed();
    const resolvedAtA = scene.add("peer.resolved", {
      localKeyName: `did/${DID_ID}/key-agreement` as KeyName,
      peerPublicKey: PEER_KEY,
      presentedDid: PEER_DID,
      did: PEER_DID,
      documentCid: cidOf("bob"),
      authenticationMethodIds: [],
      keyAgreementMethodIds: [],
      service: null,
    });
    const foreignR = relationshipId("did:web:x.example" as Did, "did:web:y.example" as Did);
    const wrongR = scene.add("relationship.bound", { relationshipId: foreignR, localDidId: DID_ID, peerResolutionEventId: resolvedAtA.eventId as EventReference<"peer.resolved"> });
    const atB = bind(scene, { didId: DID_ID2, did: b.did });
    const keyOfB = scene.add("relationship.bound", { relationshipId: relationshipId(a.did, PEER_DID), localDidId: DID_ID, peerResolutionEventId: atB.resolved });
    const resolvedAsSelf = scene.add("peer.resolved", {
      localKeyName: `did/${DID_ID}/key-agreement` as KeyName,
      peerPublicKey: PEER_KEY,
      presentedDid: a.did,
      did: a.did,
      documentCid: cidOf("self"),
      authenticationMethodIds: [],
      keyAgreementMethodIds: [],
      service: null,
    });
    const selfBound = scene.add("relationship.bound", { relationshipId: foreignR, localDidId: DID_ID, peerResolutionEventId: resolvedAsSelf.eventId as EventReference<"peer.resolved"> });
    const r1 = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: wrongR.eventId as EventReference<"relationship.bound">, resolution: resolvedAtA.eventId as EventReference<"peer.resolved">, ordinal: 1 });
    const r2 = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: keyOfB.eventId as EventReference<"relationship.bound">, resolution: resolvedAtA.eventId as EventReference<"peer.resolved">, ordinal: 2 });
    const r3 = messageIn(scene, { localDidId: DID_ID, localDid: a.did, peerDid: a.did, pthid: OOB, binding: selfBound.eventId as EventReference<"relationship.bound">, resolution: resolvedAsSelf.eventId as EventReference<"peer.resolved">, ordinal: 3 });
    const r4 = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: resolvedAtA.eventId as unknown as EventReference<"relationship.bound">, resolution: resolvedAtA.eventId as EventReference<"peer.resolved">, ordinal: 4 });
    const { fold, invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [], pending: [], inconsistent: [r1.eventId, r2.eventId, r3.eventId, r4.eventId], conflict: false, available: true });
    expect(invitations.consumable(OOB, relationshipId(a.did, OTHER_PEER))).toBe("consumable");
    const good = bind(scene, { didId: DID_ID, did: a.did });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: good.bound, resolution: good.resolved, ordinal: 5 });
    expect(fold(scene.set()).invitations.get(OOB)).toMatchObject({ consumers: [good.R], conflict: false, available: false });
    expectOrderFree(scene.events, fold);
  });

  it("does not hold the invitation for a receipt the evidence already here contradicts, whatever is still missing", async () => {
    const { scene, a } = await disclosed();
    const stranger = relationshipId(a.did, OTHER_PEER);
    const resolvedAtA = scene.add("peer.resolved", {
      localKeyName: `did/${DID_ID}/key-agreement` as KeyName,
      peerPublicKey: PEER_KEY,
      presentedDid: PEER_DID,
      did: PEER_DID,
      documentCid: cidOf("bob"),
      authenticationMethodIds: [],
      keyAgreementMethodIds: [],
      service: null,
    });
    const missing = "019b2a99-0000-7000-8000-000000000004" as EventReference<"peer.resolved">;
    const wrongR = scene.add("relationship.bound", { relationshipId: relationshipId("did:web:x.example" as Did, "did:web:y.example" as Did), localDidId: DID_ID, peerResolutionEventId: resolvedAtA.eventId as EventReference<"peer.resolved"> });
    const wrongRootKey = scene.add("relationship.bound", { relationshipId: relationshipId(a.did, PEER_DID), localDidId: DID_ID, peerResolutionEventId: scene.add("peer.resolved", { ...resolvedAtA.data, localKeyName: `did/${DID_ID2}/key-agreement` as KeyName, documentCid: cidOf("at b") }).eventId as EventReference<"peer.resolved"> });
    const rootMissing = scene.add("relationship.bound", { relationshipId: relationshipId(a.did, PEER_DID), localDidId: DID_ID, peerResolutionEventId: missing });
    const rootIsNoResolution = scene.add("relationship.bound", { relationshipId: relationshipId(a.did, PEER_DID), localDidId: DID_ID, peerResolutionEventId: wrongR.eventId as unknown as EventReference<"peer.resolved"> });
    const ownAtB = scene.add("peer.resolved", { ...resolvedAtA.data, localKeyName: `did/${DID_ID2}/key-agreement` as KeyName, documentCid: cidOf("own at b") });
    const ownOfCarol = scene.add("peer.resolved", { ...resolvedAtA.data, presentedDid: OTHER_PEER, did: OTHER_PEER, documentCid: cidOf("carol") });
    const bound = (event: { eventId: string }) => event.eventId as EventReference<"relationship.bound">;
    const r1 = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound(wrongR), resolution: missing, ordinal: 1 });
    const r2 = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound(wrongRootKey), resolution: missing, ordinal: 2 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound(rootMissing), resolution: ownAtB.eventId as EventReference<"peer.resolved">, ordinal: 3 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound(rootMissing), resolution: ownOfCarol.eventId as EventReference<"peer.resolved">, ordinal: 4 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound(rootIsNoResolution), resolution: missing, ordinal: 5 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound(rootMissing), resolution: bound(wrongR) as unknown as EventReference<"peer.resolved">, ordinal: 6 });
    const { fold, invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [], pending: [], inconsistent: [r1.eventId, r2.eventId], conflict: false, available: true });
    expect(invitations.consumable(OOB, stranger)).toBe("consumable");
    const waiting = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound(rootMissing), resolution: resolvedAtA.eventId as EventReference<"peer.resolved">, ordinal: 7 });
    const held = fold(scene.set());
    expect(held.invitations.get(OOB)).toMatchObject({ consumers: [], pending: [waiting.eventId], available: false });
    expect(held.consumable(OOB, stranger)).toBe("pending");
    expectOrderFree(scene.events, fold);
  });

  it("lets one relationship's root-address receipt consume a second invitation of the same DID", async () => {
    const { scene, a } = await disclosed();
    scene.add("did.disclosed", { didId: DID_ID, as: "oob", uses: "one", oobId: OOB2, goal: null });
    const { R, resolved, bound } = bind(scene, { didId: DID_ID, did: a.did });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 1 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB2, binding: bound, resolution: resolved, ordinal: 2 });
    const { invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [R], available: false });
    expect(invitations.invitations.get(OOB2)).toMatchObject({ consumers: [R], available: false });
    expect(invitations.consumable(OOB2, R)).toBe("consumable");
  });

  it("keeps a reusable disclosure available while its DID is live, whoever followed it", async () => {
    const { scene, a, b } = await disclosed();
    scene.add("did.disclosed", { didId: DID_ID2, as: "oob", uses: "many", oobId: OOB2, goal: null });
    const first = bind(scene, { didId: DID_ID2, did: b.did });
    const second = bind(scene, { didId: DID_ID2, did: b.did }, OTHER_PEER);
    messageIn(scene, { localDidId: DID_ID2, localDid: b.did, pthid: OOB2, binding: first.bound, resolution: first.resolved, ordinal: 1 });
    messageIn(scene, { localDidId: DID_ID2, localDid: b.did, peerDid: OTHER_PEER, pthid: OOB2, binding: second.bound, resolution: second.resolved, ordinal: 2 });
    const { fold, invitations } = await folded(scene);
    expect(invitations.invitations.get(OOB2)).toMatchObject({ uses: "many", consumers: [first.R, second.R].sort(), conflict: false, available: true });
    expect(invitations.consumable(OOB2, relationshipId(a.did, OTHER_PEER) as RelationshipId)).toBe("consumable");
    scene.add("did.retired", { didId: DID_ID2, because: "done" });
    expect(fold(scene.set()).consumable(OOB2, relationshipId(a.did, OTHER_PEER))).toBe("unavailable");
    expect(fold(scene.set()).consumable(OOB2, first.R)).toBe("consumable");
  });
});
