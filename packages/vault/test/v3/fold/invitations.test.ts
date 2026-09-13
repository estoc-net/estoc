import { beforeAll, describe, expect, it } from "vitest";

import { Keys, VaultEventSet, foldInvitations, foldMediations, foldRoutes, mintMediationDid, relationshipId, type Did, type EventReference, type VaultData } from "../../../src/v3/index.js";
import { DID_ID, DID_ID2, MEDIATED, MEDIATION, PEER_DID, ROUTE, Scene, bind, createdDid, expectOrderFree, mediatedRoute, messageIn, openKeys } from "./helpers.js";

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

const fold = (set: VaultEventSet) => foldInvitations(set, foldRoutes(set, foldMediations(set)));

async function disclosed(): Promise<{ scene: Scene; a: VaultData["did.created"]; b: VaultData["did.created"] }> {
  const scene = new Scene();
  mediatedRoute(scene, { me });
  const a = await createdDid(scene, keys, DID_ID, ROUTE, MEDIATED);
  const b = await createdDid(scene, keys, DID_ID2, ROUTE, MEDIATED);
  scene.add("did.disclosed", { didId: DID_ID, as: "oob", uses: "one", oobId: OOB, goal: "Write to Alice" });
  return { scene, a, b };
}

describe("the invitation fold", () => {
  it("offers a one-use invitation while its DID is live and nothing consumed it", async () => {
    const { scene } = await disclosed();
    scene.add("did.disclosed", { didId: DID_ID, as: "profile", uses: "many", oobId: null, goal: null });
    const invitations = fold(scene.set());
    expect(invitations.invitations.get(OOB)).toMatchObject({ oobId: OOB, didId: DID_ID, uses: "one", goal: "Write to Alice", consumers: [], pending: [], conflict: false, available: true });
    expect(invitations.invitations.size).toBe(1);
    expect(invitations.consumable(OOB, relationshipId("did:web:a.example" as Did, "did:web:b.example" as Did))).toBe(true);
    expect(invitations.consumable(OOB2, relationshipId("did:web:a.example" as Did, "did:web:b.example" as Did))).toBe(false);
    scene.add("did.retired", { didId: DID_ID, because: "done" });
    expect(fold(scene.set()).invitations.get(OOB)).toMatchObject({ available: false, consumers: [] });
  });

  it("is consumed by a matching root-address receipt, once, and stays consumed for that relationship only", async () => {
    const { scene, a } = await disclosed();
    const { R, resolved, bound } = bind(scene, { didId: DID_ID, did: a.did });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 1 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 2 });
    const invitations = fold(scene.set());
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [R], conflict: false, available: false });
    expect(invitations.consumable(OOB, R)).toBe(true);
    expect(invitations.consumable(OOB, relationshipId(a.did, OTHER_PEER))).toBe(false);
    scene.add("did.retired", { didId: DID_ID, because: "done" });
    scene.add("message.erased", { messageId: scene.set().of("message.in")[0]!.data.messageId, dropCids: scene.set().of("message.in")[0]!.data.bodyCid ? [scene.set().of("message.in")[0]!.data.bodyCid] : [], because: "user" });
    expect(fold(scene.set()).invitations.get(OOB)).toMatchObject({ consumers: [R], available: false });
    expectOrderFree(scene.events, fold);
  });

  it("marks two distinct consumers as a conflict that closes the invitation to both", async () => {
    const { scene, a } = await disclosed();
    const first = bind(scene, { didId: DID_ID, did: a.did });
    const second = bind(scene, { didId: DID_ID, did: a.did }, OTHER_PEER);
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: first.bound, resolution: first.resolved, ordinal: 1 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, peerDid: OTHER_PEER, pthid: OOB, binding: second.bound, resolution: second.resolved, ordinal: 2 });
    const invitations = fold(scene.set());
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [first.R, second.R].sort(), conflict: true, available: false });
    expect(invitations.consumable(OOB, first.R)).toBe(false);
    expect(invitations.consumable(OOB, second.R)).toBe(false);
    expectOrderFree(scene.events, fold);
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
    const invitations = fold(scene.set());
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [], pending: [], conflict: false, available: true });
    expectOrderFree(scene.events, fold);
  });

  it("holds a receipt whose binding or resolution is not here as pending, consuming nothing yet", async () => {
    const { scene, a } = await disclosed();
    const { resolved, bound } = bind(scene, { didId: DID_ID, did: a.did });
    const orphan = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: "019b2a99-0000-7000-8000-000000000001" as EventReference<"relationship.bound">, resolution: resolved, ordinal: 1 });
    const withoutBinding = VaultEventSet.of(scene.events.filter((event) => event.eventId !== bound));
    expect(fold(withoutBinding).invitations.get(OOB)).toMatchObject({ consumers: [], pending: [orphan.eventId], available: true });
    const bindingHeld = messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 2 });
    const withoutResolution = VaultEventSet.of(scene.events.filter((event) => event.eventId !== resolved));
    expect([...fold(withoutResolution).invitations.get(OOB)!.pending].sort()).toEqual([orphan.eventId, bindingHeld.eventId].sort());
    expect(fold(withoutResolution).invitations.get(OOB)?.consumers).toEqual([]);
    const R = relationshipId(a.did, PEER_DID);
    expect(fold(scene.set()).invitations.get(OOB)).toMatchObject({ consumers: [R], pending: [orphan.eventId], available: false });
  });

  it("lets one relationship's root-address receipt consume a second invitation of the same DID", async () => {
    const { scene, a } = await disclosed();
    scene.add("did.disclosed", { didId: DID_ID, as: "oob", uses: "one", oobId: OOB2, goal: null });
    const { R, resolved, bound } = bind(scene, { didId: DID_ID, did: a.did });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB, binding: bound, resolution: resolved, ordinal: 1 });
    messageIn(scene, { localDidId: DID_ID, localDid: a.did, pthid: OOB2, binding: bound, resolution: resolved, ordinal: 2 });
    const invitations = fold(scene.set());
    expect(invitations.invitations.get(OOB)).toMatchObject({ consumers: [R], available: false });
    expect(invitations.invitations.get(OOB2)).toMatchObject({ consumers: [R], available: false });
    expect(invitations.consumable(OOB2, R)).toBe(true);
  });

  it("keeps a reusable disclosure available while its DID is live, whoever followed it", async () => {
    const { scene, a } = await disclosed();
    scene.add("did.disclosed", { didId: DID_ID2, as: "oob", uses: "many", oobId: OOB2, goal: null });
    const b = scene.set().of("did.created")[1]!.data;
    const first = bind(scene, { didId: DID_ID2, did: b.did });
    const second = bind(scene, { didId: DID_ID2, did: b.did }, OTHER_PEER);
    messageIn(scene, { localDidId: DID_ID2, localDid: b.did, pthid: OOB2, binding: first.bound, resolution: first.resolved, ordinal: 1 });
    messageIn(scene, { localDidId: DID_ID2, localDid: b.did, peerDid: OTHER_PEER, pthid: OOB2, binding: second.bound, resolution: second.resolved, ordinal: 2 });
    const invitations = fold(scene.set());
    expect(invitations.invitations.get(OOB2)).toMatchObject({ uses: "many", consumers: [first.R, second.R].sort(), conflict: false, available: true });
    expect(invitations.consumable(OOB2, relationshipId(a.did, OTHER_PEER))).toBe(true);
    scene.add("did.retired", { didId: DID_ID2, because: "done" });
    expect(fold(scene.set()).consumable(OOB2, first.R)).toBe(false);
  });
});
