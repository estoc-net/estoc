import { describe, expect, it } from "vitest";
import { FromPrior, Message } from "didcomm-node";

import { resolveDIDCommDoc, type DIDDoc } from "@estoc/did-peer";
import { MemoryBackend } from "@estoc/event-store";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";
import { drafts, record } from "@estoc/vault/v2";

import { MEDIATE_REQUEST, RECIPIENT_UPDATE, type IMessage } from "../../src/index.js";
import {
  AgentTrace,
  Keyring,
  MediatorLink,
  createVault,
  current,
  establish,
  leave,
  register,
  registerPending,
  rotateStale,
  routedOf,
  type LinkOptions,
  type PeerVault,
  type Routed,
} from "../../src/v2/index.js";
import { FakeMediator } from "../fake-mediator.js";

const didcomm = { Message, FromPrior };
const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);
/** a route no mediator here answers to: where keys minted before a move point */
const OLD_ROUTE = "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE9VVs";
const C1 = "0198c000-0000-7000-8000-000000000001";
const C2 = "0198c000-0000-7000-8000-000000000002";
const C3 = "0198c000-0000-7000-8000-000000000003";

async function newMediator(fill = 200): Promise<FakeMediator> {
  return new FakeMediator(await deriveIdentity(await importSeed(seedOf(fill)), "anchor"));
}

/** every stamp a second after the last: `at` orders what the test appends, whatever the wall clock does */
function ticking(start = "2026-08-31T00:00:00.000Z"): () => Date {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

interface Party {
  v: PeerVault;
  /** reloadable: a test that plays a crash loads the ring again, and the link follows */
  ring: Keyring;
  link: MediatorLink;
  /** what `link` was made of: for a second link over the same vault */
  options: LinkOptions;
  self: string;
  mediator: FakeMediator;
  /** the fetch fails with this while set: the mediator out of reach */
  offline: { reason: string | null };
}

/** A vault with no mediation yet, and a link to `mediator` whose `me` is whatever the ring says at the time. */
async function party(mediator: FakeMediator, fill: number, over: Partial<LinkOptions> = {}): Promise<Party> {
  const { doc, seedKey } = await createSeedKeystore("test", { seed: seedOf(fill) });
  const v = await createVault(new MemoryBackend(), { keystore: doc, seedKey, label: `party ${fill}`, clock: ticking() });
  const p = { v, ring: await Keyring.load(v), self: v.vault.self, mediator, offline: { reason: null } } as Party;
  const options: LinkOptions = {
    didcomm,
    resolveDid: resolveDIDCommDoc,
    fetch: (input, init) => {
      if (p.offline.reason !== null) {
        throw new TypeError(p.offline.reason);
      }
      return mediator.fetch(input, init);
    },
    WebSocket: mediator.WebSocket,
    trace: await AgentTrace.open(v.vault.local("agent")),
    secrets: () => p.ring.secrets(),
    me: () => {
      const me = p.ring.me;
      if (me === null) {
        throw new Error("no mediation yet");
      }
      return me.identity;
    },
    mediatorDid: mediator.did,
    mediatorDoc: (await resolveDIDCommDoc(mediator.did)) as DIDDoc,
    ...over,
  };
  p.options = options;
  p.link = new MediatorLink(options);
  return p;
}

/** A mediation created toward the party's mediator and, unless `routingDid` is null, granted by hand — the log as a crash left it. */
async function mediation({ ring, v, mediator }: Party, routingDid: string | null = mediator.did): Promise<Routed> {
  const { id } = await ring.createMediation(mediator.did);
  if (routingDid !== null) {
    await record(v.vault.events, v.fold, drafts.mediationGranted({ id, routingDid }));
  }
  return { id, routingDid: routingDid ?? "" };
}

async function contact({ v }: Party, cid: string): Promise<void> {
  await record(v.vault.events, v.fold, drafts.contactCreated({ cid }));
}

/** Another device's events folded into this one's: what a merge (§10) leaves in the fold. */
async function merged(into: Party, from: Party): Promise<void> {
  for await (const event of from.v.vault.events.scan()) {
    into.v.fold.apply(event);
  }
  into.ring = await Keyring.load(into.v); // the same seed derives the other device's keys too: held, inbound opens
}

/** a contact's keys, as the fold lists them: the live ones */
const keysOf = ({ v }: Party, cid: string) => v.fold.contact(cid)?.keys ?? [];
const count = (mediator: FakeMediator, type: string) => mediator.seenTypes.filter((seen) => seen === type).length;

describe("v2 mediation: the rituals with the mediator", () => {
  it("establishes from nothing: grant, publish, register, each recorded; asked again, nothing to do", async () => {
    const alice = await party(await newMediator(), 1);
    const { v, ring, link, self, mediator } = alice;
    expect(current(v.fold, self)).toBeNull();
    await expect(establish(link, ring, v)).rejects.toThrow("no mediation");

    const { id, me } = await ring.createMediation(mediator.did);
    expect(routedOf(current(v.fold, self))).toBeNull();
    const done = await establish(link, ring, v);
    expect(done.steps).toEqual(["granted", "published", "registered"]);
    expect(done.mediation).toEqual({ id, routingDid: mediator.did });
    expect(current(v.fold, self)).toMatchObject({ id, routingDid: mediator.did });
    expect(routedOf(current(v.fold, self))).toEqual(done.mediation);
    expect(ring.pub()).toEqual(done.pub);
    expect(v.fold.myKey(done.pub.key)).toMatchObject({
      minted: { did: done.pub.identity.did, routingDid: mediator.did, mediation: id },
      published: [expect.objectContaining({ as: "profile", uses: "many" })],
      registered: [self],
      retired: null,
    });
    expect((await resolveDIDCommDoc(done.pub.identity.did))?.service[0]?.serviceEndpoint).toMatchObject({ uri: mediator.did });
    expect(mediator.recipients.get(done.pub.identity.did)).toBe(me.identity.did);
    expect(mediator.seenTypes).toEqual([MEDIATE_REQUEST, RECIPIENT_UPDATE]);

    const again = await establish(link, ring, v);
    expect(again).toEqual({ ...done, steps: [] });
    expect(mediator.seenTypes).toEqual([MEDIATE_REQUEST, RECIPIENT_UPDATE]);
    expect(registerPending(v.fold, self)).toEqual([]);

    // reopened: the fold says the same
    const later = await Keyring.load(v);
    expect(later.pub()).toEqual(done.pub);
  });

  it("heals a grant recorded without its mint: no mediate-request, the public DID minted and registered", async () => {
    const alice = await party(await newMediator(), 2);
    const { v, ring, link, mediator } = alice;
    const routed = await mediation(alice);
    const done = await establish(link, ring, v);
    expect(done.steps).toEqual(["published", "registered"]);
    expect(done.mediation).toEqual(routed);
    expect(mediator.seenTypes).toEqual([RECIPIENT_UPDATE]);
    expect(mediator.recipients.has(done.pub.identity.did)).toBe(true);
  });

  it("heals a mint without its publish: the orphan is the public DID, not a second one", async () => {
    const alice = await party(await newMediator(), 3);
    const { v, link, mediator } = alice;
    const routed = await mediation(alice);
    const orphan = await v.keys.mintDid(v.fold, routed);
    alice.ring = await Keyring.load(v); // the next process: the orphan is held, unpublished
    const done = await establish(link, alice.ring, v);
    expect(done.steps).toEqual(["published", "registered"]);
    expect(done.pub.key).toBe(orphan.key);
    expect(v.fold.myKeys().filter((key) => key.minted !== null && key.key.startsWith("did/"))).toHaveLength(1);
    expect(mediator.seenTypes).toEqual([RECIPIENT_UPDATE]);
  });

  it("heals a publish without its register: the same public DID, told to the mediator now", async () => {
    const alice = await party(await newMediator(), 4);
    const { v, ring, link, self, mediator } = alice;
    const routed = await mediation(alice);
    const pub = await ring.mintPublic(routed);
    expect(registerPending(v.fold, self)).toEqual([pub.key]);
    const done = await establish(link, ring, v);
    expect(done.steps).toEqual(["registered"]);
    expect(done.pub).toEqual(pub);
    expect(v.fold.myKey(pub.key)?.registered).toEqual([self]);
    expect(mediator.seenTypes).toEqual([RECIPIENT_UPDATE]);
    expect(registerPending(v.fold, self)).toEqual([]);
  });

  it("registers a batch in one round trip, records each accepted key, and does not ask twice; a refusal fails after the accepted are recorded", async () => {
    const alice = await party(await newMediator(), 5);
    const { v, ring, link, self, mediator } = alice;
    const routed = await mediation(alice);
    await contact(alice, C1);
    const toward = await ring.mintToward(C1, routed);
    const invitation = await ring.mintInvitation(routed, "oob-1", null);
    await expect(register(link, v, ["did/nope"])).rejects.toThrow("never minted");
    expect(mediator.seenTypes).toEqual([]);

    expect(await register(link, v, [toward.key, invitation.key, toward.key])).toEqual([toward.key, invitation.key]);
    expect(mediator.seenTypes).toEqual([RECIPIENT_UPDATE]);
    expect(mediator.recipients.get(toward.identity.did)).toBe(ring.me?.identity.did);
    expect(mediator.recipients.get(invitation.identity.did)).toBe(ring.me?.identity.did);
    expect(v.fold.myKey(toward.key)?.registered).toEqual([self]);
    expect(v.fold.myKey(invitation.key)?.registered).toEqual([self]);
    expect(await register(link, v, [toward.key, invitation.key])).toEqual([]);
    expect(mediator.seenTypes).toEqual([RECIPIENT_UPDATE]);

    // the mediator refuses one of two: the other is recorded, the call fails, the next run asks about the refused alone
    const a = await ring.mintToward(C1, routed);
    const b = await ring.mintToward(C1, routed);
    class Picky extends MediatorLink {
      override async roundTrip(type: string, body: Record<string, unknown>): Promise<IMessage> {
        const answer = await super.roundTrip(type, body);
        if (type === RECIPIENT_UPDATE) {
          const updated = answer.body["updated"] as { recipient_did: string; result: string }[];
          answer.body["updated"] = updated.map((entry) => (entry.recipient_did === b.identity.did ? { ...entry, result: "client_error" } : entry));
        }
        return answer;
      }
    }
    const picky = new Picky(alice.options);
    await expect(register(picky, v, [a.key, b.key])).rejects.toThrow("did not accept 1 of 2");
    expect(v.fold.myKey(a.key)?.registered).toEqual([self]);
    expect(v.fold.myKey(b.key)?.registered).toEqual([]);
    expect(registerPending(v.fold, self)).toEqual([b.key]);
    expect(await register(link, v, [a.key, b.key])).toEqual([b.key]);
    expect(count(mediator, RECIPIENT_UPDATE)).toBe(3);

    // a link to another mediator is refused before anything is asked
    const other = await party(await newMediator(201), 6);
    await expect(register(other.link, v, [a.key])).rejects.toThrow("another mediator");
    await expect(establish(other.link, ring, v)).rejects.toThrow("another mediator");
  });

  it("registerPending: the keys on the current route the mediator was not told of — the public DID, live keys toward contacts, open invitations", async () => {
    const alice = await party(await newMediator(), 7);
    const { v, ring, link, self } = alice;
    expect(registerPending(v.fold, self)).toEqual([]);
    const created = await mediation(alice, null);
    expect(registerPending(v.fold, self)).toEqual([]); // not granted: no route to be on
    await record(v.vault.events, v.fold, drafts.mediationGranted({ id: created.id, routingDid: alice.mediator.did }));
    const routed = { id: created.id, routingDid: alice.mediator.did };

    await contact(alice, C1);
    await contact(alice, C2);
    const pub = await ring.mintPublic(routed);
    const toward1 = await ring.mintToward(C1, routed);
    const toward2 = await ring.mintToward(C2, routed);
    await register(link, v, [toward2.key]);
    const dead = await ring.mintToward(C1, routed);
    await record(v.vault.events, v.fold, drafts.didRetired({ key: dead.key, because: "test" }));
    const stale = await v.keys.mintDid(v.fold, { id: created.id, routingDid: OLD_ROUTE });
    await record(v.vault.events, v.fold, drafts.contactUseKey({ cid: C1, key: stale.key, because: "minted" }));
    const invitation = await ring.mintInvitation(routed, "oob-1", "Write to Alice");
    const revoked = await ring.mintInvitation(routed, "oob-2", null);
    await record(v.vault.events, v.fold, drafts.didRetired({ key: revoked.key, because: "revoked" }));

    expect(registerPending(v.fold, self)).toEqual([pub.key, toward1.key, invitation.key]);
    expect(await register(link, v, registerPending(v.fold, self))).toEqual([pub.key, toward1.key, invitation.key]);
    expect(registerPending(v.fold, self)).toEqual([]);
  });

  it("leaves: the public DID and open invitations retired, the mediator asked to drop every DID it knew, the mediation retired; nothing to leave twice", async () => {
    const alice = await party(await newMediator(), 8);
    const { v, ring, link, self, mediator } = alice;
    await ring.createMediation(mediator.did);
    const { pub, mediation: routed } = await establish(link, ring, v);
    await contact(alice, C1);
    const toward = await ring.mintToward(C1, routed);
    const told = await ring.mintInvitation(routed, "oob-1", null);
    const untold = await ring.mintInvitation(routed, "oob-2", null);
    await register(link, v, [toward.key, told.key]);
    expect(mediator.recipients.size).toBe(3);

    const left = await leave(link, v);
    expect(left).toEqual({ id: routed.id, retired: [pub.key, told.key, untold.key], dropped: [pub.identity.did, toward.identity.did, told.identity.did], failed: null });
    expect(mediator.recipients.size).toBe(0);
    for (const key of [pub.key, told.key, untold.key]) {
      expect(v.fold.myKey(key)?.retired).toMatchObject({ because: "mediation-changed" });
    }
    expect(v.fold.myKey(toward.key)?.retired).toBeNull(); // rotateStale's, once the next mediation is granted
    expect(v.fold.invitations().filter((invitation) => invitation.open)).toEqual([]);
    expect(current(v.fold, self)).toBeNull();
    expect(ring.current()).toBeNull();
    expect(ring.pub()).toBeNull();
    expect(v.fold.device(self)?.mediations[0]?.retired).toMatchObject({ because: "changed" });
    expect(ring.keyOfDid(pub.identity.did)).toBe(pub.key); // still held: inbound on it still opens

    expect(await leave(link, v)).toBeNull();
    expect(count(mediator, RECIPIENT_UPDATE)).toBe(3);
  });

  it("leaves when the mediator is out of reach: the keys retired and the mediation closed all the same, the failure reported", async () => {
    const alice = await party(await newMediator(), 9);
    const { v, ring, link, self, mediator, offline } = alice;
    await ring.createMediation(mediator.did);
    const { pub, mediation: routed } = await establish(link, ring, v);
    offline.reason = "no route to host";
    const left = await leave(link, v);
    expect(left).toEqual({ id: routed.id, retired: [pub.key], dropped: [pub.identity.did], failed: "no route to host" });
    expect(mediator.recipients.has(pub.identity.did)).toBe(true);
    expect(v.fold.myKey(pub.key)?.retired).toMatchObject({ because: "mediation-changed" });
    expect(current(v.fold, self)).toBeNull();

    // nothing was ever registered: the mediator is not asked at all
    const bob = await party(await newMediator(), 10);
    const created = await mediation(bob, null);
    expect(await leave(bob.link, bob.v)).toEqual({ id: created.id, retired: [], dropped: [], failed: null });
    expect(bob.mediator.seenTypes).toEqual([]);
  });

  it("rotateStale: each contact with a live key on another route gets a fresh one and the stale retired; the mediation's own stale public DID and invitation retired; nothing twice", async () => {
    const alice = await party(await newMediator(), 11);
    const { v, ring, link, self, mediator } = alice;
    expect(await rotateStale(v, ring)).toEqual({ moved: [], retired: [] }); // no mediation
    const created = await mediation(alice, null);
    expect(await rotateStale(v, ring)).toEqual({ moved: [], retired: [] }); // not granted
    await record(v.vault.events, v.fold, drafts.mediationGranted({ id: created.id, routingDid: OLD_ROUTE }));
    const old = { id: created.id, routingDid: OLD_ROUTE };

    await contact(alice, C1);
    await contact(alice, C2);
    await contact(alice, C3);
    const c1 = await ring.mintToward(C1, old);
    const c2a = await ring.mintToward(C2, old);
    const c2b = await ring.mintToward(C2, old);
    const c3 = await ring.mintToward(C3, old);
    await record(v.vault.events, v.fold, drafts.didRetired({ key: c3.key, because: "test" }));
    const stalePub = await ring.mintPublic(old);
    const staleInvitation = await ring.mintInvitation(old, "oob-1", null);
    const taken = await ring.mintInvitation(old, "oob-2", null); // once retired for another reason, not open: not this ritual's
    await record(v.vault.events, v.fold, drafts.didRetired({ key: taken.key, because: "revoked" }));
    expect(await rotateStale(v, ring)).toEqual({ moved: [], retired: [] }); // all on the route there is

    // the mediator moved its route (a grant again, as `establish` would record one): the start sequence, establish first
    await record(v.vault.events, v.fold, drafts.mediationGranted({ id: created.id, routingDid: mediator.did }));
    const routed = { id: created.id, routingDid: mediator.did };
    const done = await establish(link, ring, v);
    expect(done.steps).toEqual(["published", "registered"]);
    expect(done.pub.key).not.toBe(stalePub.key);

    const rotated = await rotateStale(v, ring);
    expect(rotated).toEqual({ moved: [C1, C2], retired: [c1.key, c2a.key, c2b.key, stalePub.key, staleInvitation.key] });
    for (const key of rotated.retired) {
      expect(v.fold.myKey(key)?.retired).toMatchObject({ because: "mediation-changed" });
    }
    for (const cid of [C1, C2]) {
      const fresh = keysOf(alice, cid);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]).toMatchObject({ routingDid: mediator.did, because: "minted" });
      expect(v.fold.myKey(fresh[0]?.key ?? "")?.minted).toMatchObject({ mediation: created.id, routingDid: mediator.did });
    }
    expect(v.fold.myKey(c2a.key)?.usedBy).toEqual([]); // a retired key is no one's any more
    expect(keysOf(alice, C3)).toEqual([]); // nothing live: nothing to move
    expect(v.fold.myKey(taken.key)?.retired).toMatchObject({ because: "revoked" });
    expect(ring.pub()).toEqual(done.pub);
    expect(ring.keyOfDid(c1.identity.did)).toBe(c1.key); // still held: inbound on the old route, if any came, still opens

    // then registerPending: the fresh keys, told now
    const pending = registerPending(v.fold, self);
    expect(pending).toEqual([C1, C2].map((cid) => keysOf(alice, cid)[0]?.key));
    await register(link, v, pending);
    expect(registerPending(v.fold, self)).toEqual([]);
    expect(await rotateStale(v, ring)).toEqual({ moved: [], retired: [] });

    // a run that stopped between the mint and the retire: the fresh key is there, only the stale one is retired
    const c1Stale = await v.keys.mintDid(v.fold, old);
    await record(v.vault.events, v.fold, drafts.contactUseKey({ cid: C1, key: c1Stale.key, because: "minted" }));
    expect(await rotateStale(v, ring)).toEqual({ moved: [C1], retired: [c1Stale.key] });
    expect(keysOf(alice, C1)).toHaveLength(1);
    expect(v.fold.myKey(keysOf(alice, C1)[0]?.key ?? "")?.minted).toMatchObject({ mediation: routed.id, routingDid: routed.routingDid });
  });

  it("another device on the same mediator: its keys are seen in the fold, not registered under this device's me, not counted as ours", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 12);
    const bob = await party(mediator, 12); // the same seed, another device
    expect(bob.self).not.toBe(alice.self);
    await alice.ring.createMediation(mediator.did);
    const mine = await establish(alice.link, alice.ring, alice.v);
    await bob.ring.createMediation(mediator.did);
    const theirs = await establish(bob.link, bob.ring, bob.v);
    await contact(bob, C1);
    const bobRouted = theirs.mediation;
    const bobToward = await bob.ring.mintToward(C1, bobRouted);
    const bobInvitation = await bob.ring.mintInvitation(bobRouted, "oob-b", null);
    await register(bob.link, bob.v, [bobToward.key, bobInvitation.key]);
    expect(mediator.recipients.get(bobToward.identity.did)).toBe(bob.ring.me?.identity.did);
    const asked = mediator.seenTypes.length;

    await merged(alice, bob);
    const { v, ring, link, self } = alice;
    expect(v.fold.contact(C1)?.keys.map((use) => use.key)).toEqual([bobToward.key]);
    expect(v.fold.invitations().filter((invitation) => invitation.open).map((invitation) => invitation.key)).toEqual([bobInvitation.key]);
    expect(ring.keyOfDid(bobToward.identity.did)).toBe(bobToward.key); // held: the seed is the same
    expect(v.fold.myKey(theirs.pub.key)?.minted?.routingDid).toBe(mediator.did); // the same route as ours

    expect(registerPending(v.fold, self)).toEqual([]);
    for (const key of [theirs.pub.key, bobToward.key, bobInvitation.key]) {
      await expect(register(link, v, [key])).rejects.toThrow("another device");
    }
    expect(await establish(link, ring, v)).toEqual({ ...mine, steps: [] });
    expect(await rotateStale(v, ring)).toEqual({ moved: [], retired: [] });
    expect(mediator.seenTypes).toHaveLength(asked);
    expect(mediator.recipients.get(bobToward.identity.did)).toBe(bob.ring.me?.identity.did);
    expect(mediator.recipients.get(theirs.pub.identity.did)).toBe(bob.ring.me?.identity.did);

    // our own key toward the contact is ours to register, beside theirs
    const toward = await ring.mintToward(C1, mine.mediation);
    expect(registerPending(v.fold, self)).toEqual([toward.key]);
    expect(await register(link, v, registerPending(v.fold, self))).toEqual([toward.key]);
    expect(v.fold.contact(C1)?.keys.map((use) => use.key)).toEqual([bobToward.key, toward.key]);

    // leaving drops what we told the mediator, not what they did
    const left = await leave(link, v);
    expect(left).toMatchObject({ retired: [mine.pub.key], dropped: [mine.pub.identity.did, toward.identity.did] });
    expect(mediator.recipients.get(bobToward.identity.did)).toBe(bob.ring.me?.identity.did);
    expect(v.fold.myKey(theirs.pub.key)?.retired).toBeNull();
    expect(v.fold.myKey(bobInvitation.key)?.retired).toBeNull();
  });

  it("another device on another mediator: its keys toward a contact are neither counted as ours nor retired when our route moves", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 13);
    const bob = await party(await newMediator(203), 13);
    const created = await mediation(alice, OLD_ROUTE);
    await contact(alice, C1);
    const stale = await alice.ring.mintToward(C1, created);
    await bob.ring.createMediation(bob.mediator.did);
    const theirs = await establish(bob.link, bob.ring, bob.v);
    await contact(bob, C1);
    await contact(bob, C2);
    const bobC1 = await bob.ring.mintToward(C1, theirs.mediation);
    const bobC2 = await bob.ring.mintToward(C2, theirs.mediation);
    await merged(alice, bob);
    const { v, ring, link, self } = alice;
    expect(v.fold.contact(C1)?.keys.map((use) => use.key)).toEqual([stale.key, bobC1.key]);

    // our route moves: our stale key toward C1 is replaced, theirs is left as it is; C2, theirs alone, is not ours to move
    await record(v.vault.events, v.fold, drafts.mediationGranted({ id: created.id, routingDid: mediator.did }));
    await establish(link, ring, v);
    const rotated = await rotateStale(v, ring);
    expect(rotated).toEqual({ moved: [C1], retired: [stale.key] });
    expect(v.fold.myKey(bobC1.key)?.retired).toBeNull();
    expect(v.fold.myKey(bobC2.key)?.retired).toBeNull();
    expect(v.fold.myKey(theirs.pub.key)?.retired).toBeNull();
    const fresh = keysOf(alice, C1).filter((use) => use.key !== bobC1.key);
    expect(fresh).toHaveLength(1);
    expect(v.fold.myKey(fresh[0]?.key ?? "")?.minted).toMatchObject({ by: self, routingDid: mediator.did });
    expect(keysOf(alice, C2).map((use) => use.key)).toEqual([bobC2.key]);
    expect(registerPending(v.fold, self)).toEqual([fresh[0]?.key]);
    expect(await rotateStale(v, ring)).toEqual({ moved: [], retired: [] });

    // and theirs, riding their route, is not "one of ours on the route" that would spare a mint
    expect(bobC1.identity.did).not.toBe(fresh[0]?.did);
  });
});
