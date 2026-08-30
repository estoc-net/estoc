import { beforeAll, describe, expect, it } from "vitest";

import { MemoryBlobStore } from "@estoc/event-store";

import { VaultFold, channelId } from "../../src/v2/index.js";
import { DEV_A, DEV_B, DEV_C, Line, buildScene, peerKey, type Scene } from "./helpers.js";

let scene: Scene;
let fold: VaultFold;
let someRoot: string;

beforeAll(async () => {
  someRoot = await new MemoryBlobStore().put(new TextEncoder().encode("some body"));
  scene = await buildScene();
  fold = new VaultFold(DEV_A);
  for (const event of scene.events) {
    fold.apply(event);
  }
});

describe("v2 fold: the scene", () => {
  it("attributes both of bob's channels to the one contact through the rotation edge", () => {
    expect(fold.attribution(scene.pairs.ch1)).toEqual({ kind: "one", cid: scene.cids.c1 });
    expect(fold.attribution(scene.pairs.ch2)).toEqual({ kind: "one", cid: scene.cids.c1 });
  });

  it("attributes the merged-in manual channel to the representative", () => {
    expect(fold.attribution(scene.pairs.ch3)).toEqual({ kind: "one", cid: scene.cids.c1 });
    expect(fold.contact(scene.cids.c2)?.cid).toBe(scene.cids.c1);
  });

  it("keeps the mediator's channel out of the identity graph", () => {
    expect(fold.attribution(scene.pairs.med)).toEqual({ kind: "none" });
    expect(fold.channel(scene.pairs.med)?.dids).toEqual([]);
  });

  it("folds contact state: petname, flags, claimedName, keys, addressedAs", () => {
    const contact = fold.contact(scene.cids.c1);
    expect(contact).not.toBeNull();
    expect(contact?.members).toEqual([scene.cids.c1, scene.cids.c2].sort());
    expect(contact?.petname).toBe("bob");
    expect(contact?.flags).toEqual({ pinned: true });
    expect(contact?.claimedName).toBe("Bob R.");
    expect(contact?.addressedAs).toBe(scene.keys.k2);
    expect(contact?.keys.map((key) => [key.key, key.implicit])).toEqual([
      [scene.keys.k1, true], // the invitation he took: the fold adds it (§7.4)
      [scene.keys.k2, false],
    ]);
    expect(contact?.keys[1]?.did).toBe("did:peer:4k2");
  });

  it("orders theirDids by rotation and points current at the chain's end", () => {
    const contact = fold.contact(scene.cids.c1);
    expect(contact?.theirDids.map((entry) => [entry.did, entry.current])).toEqual([
      ["did:peer:4bob", false],
      ["did:peer:4bob2", true],
    ]);
    expect(contact?.currentDids).toEqual(["did:peer:4bob2"]);
  });

  it("freezes the pre-rotation channel: writeTo is the current pair alone", () => {
    const contact = fold.contact(scene.cids.c1);
    expect(contact?.writeTo).toEqual([scene.pairs.ch2]);
    expect(contact?.write).toEqual(scene.pairs.ch2);
  });

  it("threads every attributed message in canonical order", () => {
    const contact = fold.contact(scene.cids.c1);
    expect(contact?.thread.map((message) => message.mid)).toEqual([scene.mids.in1, scene.mids.out1, scene.mids.in2, scene.mids.out2]);
    expect(contact?.thread[0]?.erased).toEqual([scene.roots["att1"]]);
  });

  it("folds deliveries: failed retries, sent is final", () => {
    expect(fold.delivery(scene.mids.out1)?.status).toBe("failed");
    expect(fold.delivery(scene.mids.out2)?.status).toBe("sent");
    expect(fold.delivery(scene.mids.in1)).toBeNull();
  });

  it("lists my keys with registration, publication, use and takers", () => {
    const k1 = fold.myKey(scene.keys.k1);
    expect(k1?.minted?.did).toBe("did:peer:4k1");
    expect(k1?.registered).toEqual([DEV_A]);
    expect(k1?.published.map((p) => p.as)).toEqual(["oob"]);
    expect(k1?.usedBy).toEqual([scene.cids.c1]);
    expect(k1?.takenBy).toEqual([scene.cids.c1]);
    expect(k1?.retired).toBeNull();
  });

  it("folds invitations: taken and open", () => {
    const invitations = fold.invitations();
    expect(invitations.map((i) => [i.oobId, i.open, i.takenBy])).toEqual([
      ["oob-1", false, [scene.cids.c1]],
      ["oob-2", true, []],
    ]);
    expect(invitations[1]?.did).toBe("did:peer:4k3");
  });

  it("folds devices: mediation current on its device, labels, a retired stranger", () => {
    const a = fold.device(DEV_A);
    expect(a?.mediation?.id).toBe(scene.mediation);
    expect(a?.mediation?.routingDid).toBe("did:peer:2route");
    expect(a?.mediation?.channels).toEqual([scene.pairs.med]);
    expect(fold.device(DEV_B)?.label).toBe("phone");
    expect(fold.device(DEV_B)?.mediation).toBeNull();
    expect(fold.device(DEV_C)?.retired?.because).toBe("lost");
    expect(fold.device(DEV_C)?.mintedAt).toBeNull();
  });

  it("labels the identity by the latest event, whoever wrote it", () => {
    expect(fold.label()).toBe("Alicia");
  });

  it("folds extensions: removed stays readable, purged is gone everywhere", () => {
    const byName = fold.extensions().map((ext) => [ext.name, ext.removed, ext.purged] as const);
    expect([...byName].sort()).toEqual([
      ["lens", true, true],
      ["onion", true, false],
    ]);
  });

  it("holds every root but the erased one, and a foreign type's forever", () => {
    const held = fold.held();
    for (const name of ["in1", "in2", "out1", "out2", "foreign"]) {
      expect(held).toContain(scene.roots[name]);
    }
    expect(held).not.toContain(scene.roots["att1"]);
    expect(fold.erased(scene.mids.in1, scene.roots["att1"] as string)).toBe(true);
    expect(fold.erased(scene.mids.in1, scene.roots["in1"] as string)).toBe(false);
  });

  it("surfaces the malformed line and holds nothing else against it", () => {
    expect(fold.malformed).toHaveLength(1);
    expect(fold.malformed[0]?.message).toContain("contact.created");
  });

  it("remembers first sightings and resolutions per channel", () => {
    const ch1 = fold.channel(scene.pairs.ch1);
    expect(ch1?.firstSeen?.firstDid).toBe("did:peer:4bob");
    expect(ch1?.seenBy).toEqual([DEV_A]);
    expect(ch1?.resolved).toEqual([{ did: "did:peer:4bob", keys: [scene.bob.multibase], service: "did:peer:2bobroute", at: ch1?.resolved[0]?.at }]);
  });
});

describe("v2 fold: attribution edges", () => {
  const bob = peerKey(21);

  it("shows a channel two contacts attached as a conflict, resolved by a merge", () => {
    const line = new Line();
    const fold = new VaultFold(DEV_A);
    const pair = { myKey: "did/k", peerKey: bob.fingerprint };
    const c1 = "0198aaaa-0000-7000-8000-000000000001";
    const c2 = "0198aaaa-0000-7000-8000-000000000002";
    fold.apply(line.next(DEV_A, "contact.created", { cid: c1 }));
    fold.apply(line.next(DEV_B, "contact.created", { cid: c2 }));
    fold.apply(line.next(DEV_A, "contact.attached", { ...pair, cid: c1, because: "manual" }));
    fold.apply(line.next(DEV_B, "contact.attached", { ...pair, cid: c2, because: "manual" }));
    expect(fold.attribution(pair)).toEqual({ kind: "several", cids: [c1, c2] });
    fold.apply(line.next(DEV_A, "contact.merged", { cid: c1, from: c2 }));
    expect(fold.attribution(pair)).toEqual({ kind: "one", cid: c1 });
  });

  it("detach ends an attribution; a later attach revives it", () => {
    const line = new Line();
    const fold = new VaultFold(DEV_A);
    const pair = { myKey: "did/k", peerKey: bob.fingerprint };
    const c1 = "0198aaaa-0000-7000-8000-000000000001";
    fold.apply(line.next(DEV_A, "contact.created", { cid: c1 }));
    fold.apply(line.next(DEV_A, "contact.attached", { ...pair, cid: c1, because: "manual" }));
    expect(fold.attribution(pair).kind).toBe("one");
    fold.apply(line.next(DEV_A, "contact.detached", { ...pair, cid: c1 }));
    expect(fold.attribution(pair)).toEqual({ kind: "none" });
    fold.apply(line.next(DEV_A, "contact.attached", { ...pair, cid: c1, because: "manual" }));
    expect(fold.attribution(pair).kind).toBe("one");
  });

  it("hides a deleted contact and its channels", () => {
    const line = new Line();
    const fold = new VaultFold(DEV_A);
    const pair = { myKey: "did/k", peerKey: bob.fingerprint };
    const c1 = "0198aaaa-0000-7000-8000-000000000001";
    fold.apply(line.next(DEV_A, "contact.created", { cid: c1 }));
    fold.apply(line.next(DEV_A, "contact.attached", { ...pair, cid: c1, because: "manual" }));
    fold.apply(line.next(DEV_A, "contact.deleted", { cid: c1 }));
    expect(fold.contact(c1)).toBeNull();
    expect(fold.contacts()).toEqual([]);
    expect(fold.attribution(pair)).toEqual({ kind: "deleted", cids: [c1] });
    expect(fold.deletedContacts().map((gone) => [gone.cid, gone.channels])).toEqual([[c1, [pair]]]);
  });

  it("a peerless channel joins nothing and is never attributed", () => {
    const line = new Line();
    const fold = new VaultFold(DEV_A);
    const pair = { myKey: "did/k", peerKey: null };
    fold.apply(line.next(DEV_A, "channel.firstSeen", { ...pair, kind: "anoncrypt" }));
    expect(fold.attribution(pair)).toEqual({ kind: "none" });
    expect(fold.channel(pair)?.dids).toEqual([]);
    expect(channelId(pair)).toBe(channelId({ myKey: "did/k", peerKey: null }));
  });

  it("a deleted member merged in later revives nothing", () => {
    const line = new Line();
    const fold = new VaultFold(DEV_A);
    const pair = { myKey: "did/k", peerKey: bob.fingerprint };
    const c1 = "0198aaaa-0000-7000-8000-000000000001";
    const c2 = "0198aaaa-0000-7000-8000-000000000002";
    fold.apply(line.next(DEV_A, "contact.created", { cid: c1 }));
    fold.apply(line.next(DEV_A, "contact.attached", { ...pair, cid: c1, because: "manual" }));
    fold.apply(line.next(DEV_A, "contact.deleted", { cid: c1 }));
    fold.apply(line.next(DEV_B, "contact.created", { cid: c2 }));
    fold.apply(line.next(DEV_B, "contact.merged", { cid: c2, from: c1 }));
    expect(fold.attribution(pair)).toEqual({ kind: "deleted", cids: [c1] });
    expect(fold.contact(c2)?.channels).toEqual([]);
    expect(fold.contact(c2)?.thread).toEqual([]);
    expect(fold.contact(c2)?.hidden).toEqual([c1]);
    expect(fold.deletedContacts().map((gone) => [gone.cid, gone.channels])).toEqual([[c1, [pair]]]);
  });

  it("the default write follows the latest contact.useKey, not the first-used key", () => {
    const line = new Line();
    const fold = new VaultFold(DEV_A);
    const c = "0198aaaa-0000-7000-8000-000000000001";
    const p1 = { myKey: "did/k1", peerKey: bob.fingerprint };
    const p2 = { myKey: "did/k2", peerKey: bob.fingerprint };
    fold.apply(line.next(DEV_A, "did.minted", { key: "did/k1", did: "did:peer:4k1", routingDid: "did:peer:2r", mediation: null }));
    fold.apply(line.next(DEV_A, "did.minted", { key: "did/k2", did: "did:peer:4k2", routingDid: "did:peer:2r", mediation: null }));
    fold.apply(line.next(DEV_A, "contact.created", { cid: c }));
    fold.apply(line.next(DEV_A, "contact.attached", { ...p1, cid: c, because: "manual" }));
    fold.apply(line.next(DEV_A, "peer.resolved", { ...p1, did: "did:peer:4bob", keys: [bob.multibase], service: null }));
    fold.apply(line.next(DEV_A, "peer.resolved", { ...p2, did: "did:peer:4bob", keys: [bob.multibase], service: null }));
    for (const key of ["did/k1", "did/k2", "did/k1"]) {
      fold.apply(line.next(DEV_A, "contact.useKey", { cid: c, key, because: "minted" }));
    }
    expect(fold.contact(c)?.writeTo).toHaveLength(2);
    expect(fold.contact(c)?.write?.myKey).toBe("did/k1");
  });

  it("breaks a same-instant useKey tie by canonical order, not key name", () => {
    const line = new Line();
    const fold = new VaultFold(DEV_A);
    const c = "0198aaaa-0000-7000-8000-000000000001";
    const p1 = { myKey: "did/k1", peerKey: bob.fingerprint };
    const p2 = { myKey: "did/k2", peerKey: bob.fingerprint };
    fold.apply(line.next(DEV_A, "did.minted", { key: "did/k1", did: "did:peer:4k1", routingDid: "did:peer:2r", mediation: null }));
    fold.apply(line.next(DEV_A, "did.minted", { key: "did/k2", did: "did:peer:4k2", routingDid: "did:peer:2r", mediation: null }));
    fold.apply(line.next(DEV_A, "contact.created", { cid: c }));
    fold.apply(line.next(DEV_A, "contact.attached", { ...p1, cid: c, because: "manual" }));
    fold.apply(line.next(DEV_A, "peer.resolved", { ...p1, did: "did:peer:4bob", keys: [bob.multibase], service: null }));
    fold.apply(line.next(DEV_A, "peer.resolved", { ...p2, did: "did:peer:4bob", keys: [bob.multibase], service: null }));
    const at = "2026-08-30T12:00:00.000Z";
    // same instant: canonical order falls through to the eid, and k1's is the later one
    fold.apply({ eid: "0198aaaa-0000-7000-8000-00000000000a", at, author: DEV_A, type: "contact.useKey", blobs: [], data: { cid: c, key: "did/k2", because: "minted" } });
    fold.apply({ eid: "0198aaaa-0000-7000-8000-00000000000b", at, author: DEV_A, type: "contact.useKey", blobs: [], data: { cid: c, key: "did/k1", because: "minted" } });
    expect(fold.contact(c)?.write?.myKey).toBe("did/k1");
  });

  it("a retired device's mediation is no longer current", () => {
    const line = new Line();
    const fold = new VaultFold(DEV_A);
    const id = "0198aaaa-0000-7000-8000-000000000004";
    fold.apply(line.next(DEV_B, "mediation.created", { id, mediatorDid: "did:web:m", me: { key: `mediation/${id}/me`, did: "did:peer:4me" } }));
    fold.apply(line.next(DEV_B, "mediation.granted", { id, routingDid: "did:peer:2r" }));
    fold.apply(line.next(DEV_A, "device.retired", { dev: DEV_B, because: "lost" }));
    expect(fold.device(DEV_B)?.mediation).toBeNull();
    expect(fold.device(DEV_B)?.mediations.map((m) => m.current)).toEqual([false]);
  });

  it("held is per device: another device's hold does not settle self's status", () => {
    const line = new Line();
    const bobKey = peerKey(22);
    const pair = { myKey: "did/k", peerKey: bobKey.fingerprint };
    const mid = "0198aaaa-0000-7000-8000-000000000003";
    const events = [
      line.next(DEV_B, "message.out", { ...pair, mid, wireId: "w", msgType: "m", bytes: 1, body: someRoot, attachments: [] }),
      line.next(DEV_B, "delivery.held", { ...pair, mid, because: "user" }),
    ];
    const asA = new VaultFold(DEV_A);
    const asB = new VaultFold(DEV_B);
    for (const event of events) {
      asA.apply(event);
      asB.apply(event);
    }
    expect(asA.delivery(mid)?.status).toBe("pending");
    expect(asB.delivery(mid)?.status).toBe("held");
    expect(asA.delivery(mid)?.heldBy).toEqual([{ dev: DEV_B, because: "user", at: events[1]?.at }]);
  });
});
