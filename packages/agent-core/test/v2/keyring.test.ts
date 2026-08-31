import { describe, expect, it } from "vitest";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { MemoryBackend } from "@estoc/event-store";
import { createSeedKeystore, type SeedKey } from "@estoc/keystore";
import { drafts, mediationKeyName, record } from "@estoc/vault/v2";

import { Keyring, createVault, openVault, type PeerVault, type Routed } from "../../src/v2/index.js";

const SEED = new Uint8Array(32).map((_, i) => i);
const OTHER_SEED = new Uint8Array(32).map((_, i) => 31 - i);
const MEDIATOR = "did:web:mediator.example";
const ROUTING = "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE9VVs";
const ROUTING_2 = "did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y";
/** a contact, by a uuidv7 */
const C1 = "0198c000-0000-7000-8000-000000000001";

/** every stamp a second after the last: `at` orders what the test appends, whatever the wall clock does */
function ticking(start = "2026-08-31T00:00:00.000Z"): () => Date {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

interface Scene {
  backend: MemoryBackend;
  seedKey: SeedKey;
  v: PeerVault;
  ring: Keyring;
}

async function fresh(seed = SEED): Promise<Scene> {
  const backend = new MemoryBackend();
  const { doc, seedKey } = await createSeedKeystore("test", { seed });
  const v = await createVault(backend, { keystore: doc, seedKey, label: "Alice", clock: ticking() });
  return { backend, seedKey, v, ring: await Keyring.load(v) };
}

/** the same vault opened again, later: the ring folded from the log */
async function reopen({ backend, seedKey }: Scene): Promise<{ v: PeerVault; ring: Keyring }> {
  const v = await openVault(backend, seedKey, { clock: ticking("2026-09-01T00:00:00.000Z") });
  return { v, ring: await Keyring.load(v) };
}

/** a mediation created and granted: what a mint takes its service from */
async function mediated({ ring, v }: Pick<Scene, "ring" | "v">, routingDid = ROUTING): Promise<Routed> {
  const { id } = await ring.createMediation(MEDIATOR);
  await record(v.vault.events, v.fold, drafts.mediationGranted({ id, routingDid }));
  return { id, routingDid };
}

const secretIds = (ring: Keyring): string[] => ring.secrets().map((secret) => secret.id).sort();

describe("v2 keyring: the keys this device holds", () => {
  it("holds nothing from a fresh vault; a mediation gives it a me, picked up from and never pushed to", async () => {
    const { v, ring } = await fresh();
    expect(ring.current()).toBeNull();
    expect(ring.me).toBeNull();
    expect(ring.pub()).toBeNull();
    expect(ring.secrets()).toEqual([]);
    expect(ring.skipped).toEqual([]);

    const { id, me } = await ring.createMediation(MEDIATOR);
    expect(me.key).toBe(mediationKeyName(id));
    expect(ring.current()?.id).toBe(id);
    expect(ring.me).toEqual(me);
    expect(ring.keyOfDid(me.identity.did)).toBe(me.key);
    expect(ring.identityOf(me.key)).toBe(me.identity);
    expect(secretIds(ring)).toEqual([`${me.identity.did}#key-1`, `${me.identity.did}#key-2`]);
    expect((await resolveDIDCommDoc(me.identity.did))?.service).toEqual([]);
    expect(v.fold.device(v.vault.self)?.mediation?.me).toEqual({ key: me.key, did: me.identity.did });
    expect(v.keys.keystore.keys.map((entry) => entry.name)).toContain(me.key);

    expect(ring.keyOfDid("did:peer:4zQmNobody")).toBeNull();
    expect(ring.identityOf("did/nobody")).toBeNull();
    expect(ring.pub()).toBeNull();
  });

  it("mints the three kinds under a mediation: each in the ring at once, in the fold with its reason, routed through the mediation", async () => {
    const { v, ring } = await fresh();
    const routed = await mediated({ ring, v });
    await record(v.vault.events, v.fold, drafts.contactCreated({ cid: C1 }));
    const toward = await ring.mintToward(C1, routed);
    const invitation = await ring.mintInvitation(routed, "oob-1", "Write to Alice");
    const pub = await ring.mintPublic(routed);

    for (const held of [toward, invitation, pub]) {
      expect(held.key.startsWith("did/")).toBe(true);
      expect(ring.keyOfDid(held.identity.did)).toBe(held.key);
      expect(ring.identityOf(held.key)).toBe(held.identity);
      expect(v.fold.myKey(held.key)?.minted).toMatchObject({ did: held.identity.did, routingDid: ROUTING, mediation: routed.id });
      expect((await resolveDIDCommDoc(held.identity.did))?.service[0]?.serviceEndpoint).toMatchObject({ uri: ROUTING });
      expect(v.keys.keystore.keys.map((entry) => entry.name)).toContain(held.key);
    }
    expect(new Set([toward, invitation, pub].map((held) => held.identity.did)).size).toBe(3);

    expect(v.fold.contact(C1)?.keys).toEqual([expect.objectContaining({ key: toward.key, did: toward.identity.did, because: "minted" })]);
    expect(v.fold.myKey(toward.key)?.usedBy).toEqual([C1]);
    expect(v.fold.invitations()).toEqual([expect.objectContaining({ key: invitation.key, did: invitation.identity.did, oobId: "oob-1", goal: "Write to Alice", open: true })]);
    expect(v.fold.myKey(pub.key)?.published).toEqual([expect.objectContaining({ as: "profile", uses: "many", oobId: null, goal: null })]);
    expect(ring.pub()).toEqual(pub);
    expect(ring.secrets()).toHaveLength(8);

    const bare = await ring.mintInvitation(routed, "oob-2", null);
    expect(v.fold.invitations().at(-1)).toMatchObject({ key: bare.key, oobId: "oob-2", goal: null });
  });

  it("reopened, finds all of it again: the ring is the fold of the log, each name checked against the seed", async () => {
    const scene = await fresh();
    const { v, ring } = scene;
    const routed = await mediated(scene);
    await record(v.vault.events, v.fold, drafts.contactCreated({ cid: C1 }));
    const toward = await ring.mintToward(C1, routed);
    const invitation = await ring.mintInvitation(routed, "oob-1", "Write to Alice");
    const pub = await ring.mintPublic(routed);

    const again = await reopen(scene);
    expect(again.ring.skipped).toEqual([]);
    expect(again.ring.current()?.id).toBe(routed.id);
    expect(again.ring.me).toEqual(ring.me);
    expect(again.ring.pub()).toEqual(pub);
    for (const held of [toward, invitation, pub]) {
      expect(again.ring.keyOfDid(held.identity.did)).toBe(held.key);
      expect(again.ring.identityOf(held.key)).toEqual(held.identity);
    }
    expect(secretIds(again.ring)).toEqual(secretIds(ring));
  });

  it("a retired key stays held — inbound still opens — but is no one's pub", async () => {
    const scene = await fresh();
    const { v, ring } = scene;
    const routed = await mediated(scene);
    const pub = await ring.mintPublic(routed);
    await record(v.vault.events, v.fold, drafts.didRetired({ key: pub.key, because: "mediation-changed" }));
    expect(ring.pub()).toBeNull();
    expect(ring.keyOfDid(pub.identity.did)).toBe(pub.key);

    const again = await reopen(scene);
    expect(again.ring.pub()).toBeNull();
    expect(again.ring.keyOfDid(pub.identity.did)).toBe(pub.key);
    expect(secretIds(again.ring)).toContain(`${pub.identity.did}#key-2`);
  });

  it("pub is the latest profile key under the current mediation; a new mediation starts with none", async () => {
    const scene = await fresh();
    const { v, ring } = scene;
    const first = await mediated(scene);
    const a = await ring.mintPublic(first);
    const b = await ring.mintPublic(first);
    expect(ring.pub()).toEqual(b);

    await record(v.vault.events, v.fold, drafts.mediationRetired({ id: first.id, because: "changed" }));
    expect(ring.current()).toBeNull();
    expect(ring.me).toBeNull();
    expect(ring.pub()).toBeNull();
    const second = await mediated(scene, ROUTING_2);
    expect(ring.me?.key).toBe(mediationKeyName(second.id));
    expect(ring.pub()).toBeNull(); // what the old mediation published is not this one's
    expect(ring.keyOfDid(a.identity.did)).toBe(a.key); // still held: inbound on it still opens
    const c = await ring.mintPublic(second);
    expect(ring.pub()).toEqual(c);
    expect(v.fold.myKey(c.key)?.minted?.routingDid).toBe(ROUTING_2);
  });

  it("a mediation re-granted moves the route: what was published under the old routing DID is no address, and no orphan to reuse", async () => {
    const scene = await fresh();
    const { v, ring } = scene;
    const routed = await mediated(scene);
    const stale = await ring.mintPublic(routed);
    const idle = await v.keys.mintDid(v.fold, routed); // minted under the old route, never published
    await record(v.vault.events, v.fold, drafts.mediationGranted({ id: routed.id, routingDid: ROUTING_2 }));
    expect(ring.current()).toMatchObject({ id: routed.id, routingDid: ROUTING_2 });
    expect(ring.pub()).toBeNull();
    expect(ring.keyOfDid(stale.identity.did)).toBe(stale.key); // still held: inbound on it still opens

    const again = await reopen(scene);
    expect(again.ring.pub()).toBeNull();
    const moved = { id: routed.id, routingDid: ROUTING_2 };
    const pub = await again.ring.mintPublic(moved);
    expect([stale.key, idle.key]).not.toContain(pub.key);
    expect(again.v.fold.myKey(pub.key)?.minted).toMatchObject({ mediation: routed.id, routingDid: ROUTING_2 });
    expect((await resolveDIDCommDoc(pub.identity.did))?.service[0]?.serviceEndpoint).toMatchObject({ uri: ROUTING_2 });
    expect(again.ring.pub()).toEqual(pub);
    // the stale one is still published and not retired: retiring it is the mediation ritual's (T09), not the ring's
    expect(again.v.fold.myKey(stale.key)).toMatchObject({ retired: null, published: [expect.objectContaining({ as: "profile" })] });

    // not granted at all: no address, whatever was published
    await record(v.vault.events, v.fold, drafts.mediationRetired({ id: routed.id, because: "changed" }));
    const { id } = await ring.createMediation(MEDIATOR);
    expect(ring.current()).toMatchObject({ id, routingDid: null });
    expect(ring.pub()).toBeNull();
  });

  it("holds the me of every mediation this device made, running and reopened alike: a retired mediation's mail still opens", async () => {
    const scene = await fresh();
    const { v, ring } = scene;
    const first = await mediated(scene);
    const oldMe = ring.me;
    if (oldMe === null) {
      throw new Error("no me");
    }
    await record(v.vault.events, v.fold, drafts.mediationRetired({ id: first.id, because: "changed" }));
    const second = await mediated(scene, ROUTING_2);
    expect(ring.me?.key).toBe(mediationKeyName(second.id));
    expect(ring.keyOfDid(oldMe.identity.did)).toBe(oldMe.key);
    expect(ring.identityOf(oldMe.key)).toBe(oldMe.identity);

    const again = await reopen(scene);
    expect(again.ring.me?.key).toBe(mediationKeyName(second.id));
    expect(again.ring.keyOfDid(oldMe.identity.did)).toBe(oldMe.key);
    expect(again.ring.identityOf(oldMe.key)).toEqual(oldMe.identity);
    expect(secretIds(again.ring)).toEqual(secretIds(ring));
    expect(secretIds(again.ring)).toContain(`${oldMe.identity.did}#key-2`);
    expect(again.ring.skipped).toEqual([]);
  });

  it("mintPublic heals a mint that stopped before its publish, and passes over a key a contact uses or a retired one", async () => {
    const scene = await fresh();
    const { v, ring } = scene;
    const routed = await mediated(scene);
    // minted, then nothing: `did.minted` is there, the publish never followed
    const orphan = await v.keys.mintDid(v.fold, routed);
    // minted and retired before it was published: not an orphan to reuse
    const dead = await v.keys.mintDid(v.fold, routed);
    await record(v.vault.events, v.fold, drafts.didRetired({ key: dead.key, because: "test" }));
    await record(v.vault.events, v.fold, drafts.contactCreated({ cid: C1 }));
    const toward = await ring.mintToward(C1, routed);

    const again = await reopen(scene);
    expect(again.ring.pub()).toBeNull();
    expect(again.ring.keyOfDid(orphan.identity.did)).toBe(orphan.key);
    const pub = await again.ring.mintPublic(routed);
    expect(pub.key).toBe(orphan.key);
    expect(pub.identity.did).toBe(orphan.identity.did);
    expect(again.ring.pub()).toEqual(pub);
    expect(again.v.fold.myKey(toward.key)?.published).toEqual([]);
    expect(again.v.fold.myKey(dead.key)?.published).toEqual([]);

    const next = await again.ring.mintPublic(routed);
    expect([orphan.key, dead.key, toward.key]).not.toContain(next.key);
    expect(again.ring.pub()).toEqual(next);
  });

  it("a key this seed does not derive as recorded is skipped: named to no one, no secret, said in `skipped`", async () => {
    const other = await fresh(OTHER_SEED);
    const theirs = await mediated(other);
    const theirPub = await other.ring.mintPublic(theirs);
    const theirMinted = other.v.fold.myKey(theirPub.key)?.minted;
    if (theirMinted === undefined || theirMinted === null) {
      throw new Error("not minted");
    }

    const scene = await fresh();
    const { v, ring } = scene;
    const routed = await mediated(scene);
    const mine = await ring.mintPublic(routed);
    // their `did.minted` in our log — an import gone wrong, a device minting another way — published as a profile under our mediation, after ours
    await record(v.vault.events, v.fold, drafts.didMinted({ key: theirPub.key, did: theirMinted.did, routingDid: theirMinted.routingDid, mediation: routed.id }));
    await record(v.vault.events, v.fold, drafts.didPublished({ key: theirPub.key, as: "profile", uses: "many" }));

    const again = await reopen(scene);
    expect(again.ring.skipped).toEqual([{ key: theirPub.key, did: theirMinted.did, derived: expect.stringMatching(/^did:peer:4/) }]);
    expect(again.ring.skipped[0]?.derived).not.toBe(theirMinted.did);
    expect(again.ring.keyOfDid(theirMinted.did)).toBeNull();
    expect(again.ring.identityOf(theirPub.key)).toBeNull();
    expect(secretIds(again.ring)).not.toContain(`${theirMinted.did}#key-2`);
    expect(again.ring.pub()).toEqual(mine); // the latest held profile key, not the latest recorded

    // a mediation whose `me` was recorded under a DID this seed does not derive: no me
    const bad = "0198c000-0000-7000-8000-0000000000ba";
    await record(v.vault.events, v.fold, drafts.mediationRetired({ id: routed.id, because: "changed" }));
    await record(v.vault.events, v.fold, drafts.mediationCreated({ id: bad, mediatorDid: MEDIATOR, me: { key: mediationKeyName(bad), did: theirPub.identity.did } }));
    const later = await reopen(scene);
    expect(later.ring.current()?.id).toBe(bad);
    expect(later.ring.me).toBeNull();
    expect(later.ring.skipped.map((entry) => entry.key)).toEqual([theirPub.key, mediationKeyName(bad)]);
    expect(later.ring.keyOfDid(mine.identity.did)).toBe(mine.key);
  });
});
