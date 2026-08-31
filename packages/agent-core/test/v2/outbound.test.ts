import { describe, expect, it } from "vitest";
import { FromPrior, Message } from "didcomm-node";

import { resolveDIDCommDoc, type DIDDoc, type Secret, type VerificationMethod } from "@estoc/did-peer";
import { MemoryBackend, compareEvents, type Event } from "@estoc/event-store";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";
import { drafts, eraseMessage, peerKeyOf, record, recordMessage, type VaultDraft, type VaultEvent, type VaultType } from "@estoc/vault/v2";

import { BASIC_MESSAGE, FORWARD, PLAIN_TYP, RECIPIENT_UPDATE, secretsResolverFor, type IMessage } from "../../src/index.js";
import {
  AgentTrace,
  Inbound,
  Keyring,
  MediatorLink,
  Outbound,
  Outbox,
  createVault,
  didPlaceholder,
  establish,
  mintPeerDid,
  resolvedOf,
  type Composed,
  type HandlerContext,
  type MessageRecord,
  type MyIdentity,
  type PeerVault,
  type Routed,
} from "../../src/v2/index.js";
import { FakeMediator } from "../fake-mediator.js";

const didcomm = { Message, FromPrior };
const resolver = { resolve: resolveDIDCommDoc };
const enc = new TextEncoder();
const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);
const BOB_HTTP = "http://bob/";
const CAROL_HTTP = "http://carol/";
/** a route no mediator here answers to: where a key minted before a move points */
const OLD_ROUTE = "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE9VVs";

/** every stamp a second after the last: `at` orders what the test appends, whatever the wall clock does */
function ticking(start = "2026-08-31T00:00:00.000Z"): () => Date {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

/** what an envelope opened by a peer says of itself: the fields these tests read */
interface OpenedMeta {
  encrypted_from_kid?: string | null;
  from_prior?: { iss: string; sub: string } | null;
}

/** someone out there: a did:peer:4 with the service given, their secrets, their document */
interface Peer {
  did: string;
  secrets: Secret[];
  doc: DIDDoc;
  /** open an envelope sealed to them */
  open(packed: string): Promise<{ msg: IMessage; meta: OpenedMeta }>;
}

async function peer(fill: number, service: string | null): Promise<Peer> {
  const { seedKey } = await createSeedKeystore("test", { seed: seedOf(fill) });
  const identity = mintPeerDid(await deriveIdentity(seedKey, "did/peer"), service);
  return {
    ...identity,
    doc: (await resolveDIDCommDoc(identity.did)) as DIDDoc,
    open: async (packed) => {
      const [msg, meta] = await Message.unpack(packed, resolver, secretsResolverFor(identity.secrets), {});
      return { msg: msg.as_value(), meta: meta as OpenedMeta };
    },
  };
}

/** the document's key `n` as multibase: 1 the Ed25519 signing key, 2 the X25519 agreement key */
function key(doc: DIDDoc, n: 1 | 2): string {
  const method = doc.verificationMethod.find((entry) => entry.id === `${doc.id}#key-${n}`) as VerificationMethod;
  return method.publicKeyMultibase as string;
}

const fingerprint = (who: Peer, n: 1 | 2): string => peerKeyOf(key(who.doc, n));

/** what `from_prior` says, once its signature checks out against `iss`'s document */
async function vouchedBy(jwt: string): Promise<{ iss: string; sub: string }> {
  const [prior] = await FromPrior.unpack(jwt, resolver);
  const value = prior.as_value() as { iss: string; sub: string };
  return { iss: value.iss, sub: value.sub };
}

interface Scene {
  v: PeerVault;
  ring: Keyring;
  link: MediatorLink;
  trace: AgentTrace;
  mediator: FakeMediator;
  routed: Routed;
  pub: MyIdentity;
  outbound: Outbound;
  outbox: Outbox;
  inbound: Inbound;
  log: string[];
  /** every POST to an endpoint that is not the mediator's, in order */
  posts: { url: string; body: string }[];
  /** what a POST to `url` answers; 202 for one not listed here */
  endpoints: Map<string, (body: string, init?: RequestInit) => Response | Promise<Response>>;
  /** the fetch fails with this while set: everything out of reach */
  offline: { reason: string | null };
  /** DIDs that do not resolve, for the scene's resolver */
  dead: Set<string>;
  /** how many times each DID was resolved, by anyone in the scene */
  resolutions: Map<string, number>;
  clock: () => Date;
  /** the events appended since the last call, in canonical order */
  fresh(): Promise<Event[]>;
  /** `who` writes `content` to `to`, a DID of ours: the envelope opened and handled the inbound way — the contact it makes, or finds */
  wrote(who: Peer, to: string, content: string, extra?: Record<string, unknown>): Promise<string>;
  /** compose and record one basic message to `cid` */
  write(cid: string, content: string): Promise<{ composed: Composed; record: MessageRecord }>;
}

async function all(v: PeerVault): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of v.vault.events.scan()) {
    events.push(event);
  }
  return events.sort(compareEvents);
}

async function scene(options: { mediated?: boolean; deliveryTimeoutMs?: number } = {}, fill = 1): Promise<Scene> {
  const clock = ticking();
  const mediator = new FakeMediator(await deriveIdentity(await importSeed(seedOf(200)), "anchor"));
  const { doc, seedKey } = await createSeedKeystore("test", { seed: seedOf(fill) });
  const v = await createVault(new MemoryBackend(), { keystore: doc, seedKey, label: "Alice", clock });
  const ring = await Keyring.load(v);
  const trace = await AgentTrace.open(v.vault.local("agent"));
  const log: string[] = [];
  const posts: Scene["posts"] = [];
  const endpoints: Scene["endpoints"] = new Map();
  const offline = { reason: null as string | null };
  const dead = new Set<string>();
  const resolutions = new Map<string, number>();
  const resolveDid = async (did: string): Promise<DIDDoc | null> => {
    resolutions.set(did, (resolutions.get(did) ?? 0) + 1);
    return dead.has(did) ? null : resolveDIDCommDoc(did);
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (offline.reason !== null) {
      throw new TypeError(offline.reason);
    }
    if (url === mediator.http) {
      return mediator.fetch(input, init);
    }
    posts.push({ url, body: String(init?.body) });
    const answer = endpoints.get(url);
    return answer === undefined ? new Response(null, { status: 202 }) : answer(String(init?.body), init);
  }) as typeof fetch;
  const link = new MediatorLink({
    didcomm,
    resolveDid,
    fetch: fetchFn,
    WebSocket: mediator.WebSocket,
    trace,
    secrets: () => ring.secrets(),
    me: () => {
      const me = ring.me;
      if (me === null) {
        throw new Error("no mediation yet");
      }
      return me.identity;
    },
    mediatorDid: mediator.did,
    mediatorDoc: (await resolveDIDCommDoc(mediator.did)) as DIDDoc,
    log: (line) => log.push(line),
  });
  let routed: Routed = { id: "", routingDid: "" };
  let pub: MyIdentity = { key: "", identity: { did: "", secrets: [] } };
  if (options.mediated !== false) {
    await ring.createMediation(mediator.did);
    const done = await establish(link, ring, v);
    routed = done.mediation;
    pub = done.pub;
  }
  const outbound = new Outbound(v, ring, link, { didcomm, resolveDid, clock, log: (line) => log.push(line), ...(options.deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs: options.deliveryTimeoutMs }) });
  const outbox = new Outbox(v, link, outbound, { log: (line) => log.push(line) });
  const ctx: HandlerContext = {
    fold: v.fold,
    blobs: v.vault.blobs,
    record: async <T extends VaultType>(draft: VaultDraft<T>): Promise<VaultEvent<T>> => (await record(v.vault.events, v.fold, draft)) as VaultEvent<T>,
    send: () => {
      throw new Error("no sends in this scene");
    },
    reply: () => {
      throw new Error("no replies in this scene");
    },
    displayName: () => "Alice",
    log: (line) => log.push(line),
  };
  const inbound = new Inbound(v, ctx, { resolveDid, keyOfDid: ring.keyOfDid, handlers: [], clock });
  let seen = (await all(v)).length;
  return {
    v,
    ring,
    link,
    trace,
    mediator,
    routed,
    pub,
    outbound,
    outbox,
    inbound,
    log,
    posts,
    endpoints,
    offline,
    dead,
    resolutions,
    clock,
    fresh: async () => {
      const events = await all(v);
      const since = events.slice(seen);
      seen = events.length;
      return since;
    },
    wrote: async (who, to, content, extra = {}) => {
      const plain = { id: crypto.randomUUID(), typ: PLAIN_TYP, type: BASIC_MESSAGE, from: who.did, to: [to], created_time: 1, body: { content }, ...extra } as IMessage;
      const [packed] = await new Message(plain).pack_encrypted(to, who.did, null, resolver, secretsResolverFor(who.secrets), { forward: false });
      const handled = await inbound.handle(await link.unpack(packed));
      if (handled.outcome !== "recorded" || handled.contact === null) {
        throw new Error(`not homed: ${handled.outcome}`);
      }
      return handled.contact.cid;
    },
    write: async (cid, content) => {
      const composed = await outbound.compose(cid, BASIC_MESSAGE, { content });
      return { composed, record: await outbound.record(composed) };
    },
  };
}

const types = (events: Event[]): string[] => events.map((event) => event.type);
let contactCount = 0;

/** A contact made by hand, the way `addContact` will: created, their DID resolved on a channel from no key of ours, attached there. */
async function known(s: Scene, who: Peer, because: "manual" | "accepted" = "manual", oobId?: string): Promise<string> {
  const cid = `0198c000-0000-7000-8000-${(++contactCount).toString(16).padStart(12, "0")}`;
  const pair = { myKey: null, peerKey: fingerprint(who, 2) };
  await record(s.v.vault.events, s.v.fold, drafts.contactCreated({ cid }));
  await record(s.v.vault.events, s.v.fold, drafts.peerResolved(resolvedOf(pair, who.did, who.doc)));
  await record(s.v.vault.events, s.v.fold, drafts.contactAttached({ ...pair, cid, because, ...(oobId === undefined ? {} : { oobId }) }));
  await s.fresh();
  return cid;
}

/** Bob behind the scene's mediator: his DID's service is the mediator, which knows him by his own DID. */
async function mediated(s: Scene, fill: number): Promise<Peer> {
  const who = await peer(fill, s.mediator.did);
  s.mediator.recipients.set(who.did, who.did);
  return who;
}

const queuedFor = (s: Scene, who: Peer): string[] => (s.mediator.queues.get(who.did) ?? []).map((item) => item.packed);
const attempts = (s: Scene, mid: string) => s.v.fold.delivery(mid)?.attempts.map((attempt) => attempt.outcome) ?? [];
const status = (s: Scene, mid: string) => s.v.fold.delivery(mid)?.status;

describe("v2 outbound: composing", () => {
  it("writes from a key minted toward them, to their DID, vouched for by the public DID they took our address from", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);

    const composed = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "hi" });

    const events = await s.fresh();
    expect(types(events)).toEqual(["did.minted", "contact.useKey", "peer.resolved"]);
    const minted = events[0]?.data as { key: string; did: string; routingDid: string };
    expect(minted.routingDid).toBe(s.mediator.did);
    expect(events[1]?.data).toEqual({ cid, key: minted.key, because: "minted" });
    const pair = { myKey: minted.key, peerKey: fingerprint(bob, 2) };
    expect(events[2]?.data).toEqual({ ...pair, did: bob.did, keys: [key(bob.doc, 1), key(bob.doc, 2)], service: BOB_HTTP });
    expect(composed.pair).toEqual(pair);
    expect(composed.to).toBe(bob.did);
    expect(composed.plain).toMatchObject({ typ: PLAIN_TYP, type: BASIC_MESSAGE, from: minted.did, to: [bob.did], body: { content: "hi" } });
    expect(composed.plain.pthid).toBeUndefined();
    expect(await vouchedBy(composed.plain.from_prior as string)).toEqual({ iss: s.pub.identity.did, sub: minted.did });
    expect(s.log).toContain(`minted a DID of our own toward ${didPlaceholder(bob.did)}`);
    // the outbound channel is theirs now: the resolution joined it to their DID
    expect(s.v.fold.contact(cid)?.channels).toContainEqual(pair);
    expect(s.v.fold.contact(cid)?.keys).toMatchObject([{ key: minted.key, did: minted.did, because: "minted", implicit: false }]);

    const found = await s.outbound.record(composed);
    expect(types(await s.fresh())).toEqual(["message.out"]);
    expect(found).toMatchObject({ direction: "out", pair, sender: null, body: "present", skeleton: { wireId: composed.plain.id, msgType: BASIC_MESSAGE, attachments: [] } });
    expect(found.msg).toEqual(composed.plain);
    expect(found.skeleton).not.toHaveProperty("thid");
    expect(s.v.fold.contact(cid)?.thread.map((message) => message.mid)).toEqual([found.mid]);
    expect(status(s, found.mid)).toBe("pending");

    // the next one goes from the same key, and still vouches: they have not written back
    const again = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "again" });
    expect(types(await s.fresh())).toEqual([]);
    expect(again.plain.from).toBe(minted.did);
    expect(await vouchedBy(again.plain.from_prior as string)).toEqual({ iss: s.pub.identity.did, sub: minted.did });
  });

  it("passes over a key of ours on another route: that address is not ours any more", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);
    const stale = await s.ring.mintToward(cid, { id: s.routed.id, routingDid: OLD_ROUTE });
    await s.fresh();

    const composed = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "hi" });

    expect(types(await s.fresh())).toEqual(["did.minted", "contact.useKey", "peer.resolved"]);
    expect(composed.plain.from).not.toBe(stale.identity.did);
    expect(composed.pair.myKey).not.toBe(stale.key);
    expect(s.v.fold.contact(cid)?.keys.map((use) => use.key)).toEqual([stale.key, composed.pair.myKey]);

    // a key under another device's mediation at the same mediator, derived here after a merge: its mail is that device's
    const theirs = await s.ring.mintToward(cid, { id: "0198c000-0000-7000-8000-00000000aaaa", routingDid: s.mediator.did });
    await s.fresh();
    const own = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "hi" });
    expect(types(await s.fresh())).toEqual([]);
    expect(own.pair.myKey).toBe(composed.pair.myKey);
    expect(own.pair.myKey).not.toBe(theirs.key);
  });

  it("mints one key for two first messages composed at once", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);

    const [one, two] = await Promise.all([s.outbound.compose(cid, BASIC_MESSAGE, { content: "one" }), s.outbound.compose(cid, BASIC_MESSAGE, { content: "two" })]);

    expect(types(await s.fresh()).filter((type) => type === "did.minted")).toHaveLength(1);
    expect(two.plain.from).toBe(one.plain.from);
    expect(two.pair).toEqual(one.pair);
    expect(s.v.fold.contact(cid)?.keys).toHaveLength(1);
    expect(await vouchedBy(two.plain.from_prior as string)).toEqual({ iss: s.pub.identity.did, sub: one.plain.from as string });
  });

  it("writes under the one contact a merged member names, whichever cid the caller holds", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const first = await known(s, bob);
    const other = "0198cfff-0000-7000-8000-000000000001";
    await record(s.v.vault.events, s.v.fold, drafts.contactCreated({ cid: other }));
    await record(s.v.vault.events, s.v.fold, drafts.contactMerged({ cid: first, from: other }));
    const rep = s.v.fold.contact(other)?.cid as string;
    expect(s.v.fold.contact(first)?.cid).toBe(rep);
    await s.fresh();

    // two members of one contact composed at once: one lock, one key, the useKey under the representative
    const [one, two] = await Promise.all([s.outbound.compose(other, BASIC_MESSAGE, { content: "one" }), s.outbound.compose(first, BASIC_MESSAGE, { content: "two" })]);
    const events = await s.fresh();
    expect(types(events).filter((type) => type === "did.minted")).toHaveLength(1);
    expect(events.find((event) => event.type === "contact.useKey")?.data).toMatchObject({ cid: rep });
    expect(two.plain.from).toBe(one.plain.from);
    expect(s.v.fold.contact(rep)?.keys).toHaveLength(1);

    // a member since tombstoned still names the contact: the key of record is used, nothing minted at nobody
    const gone = "0198cfff-0000-7000-8000-000000000002";
    await record(s.v.vault.events, s.v.fold, drafts.contactCreated({ cid: gone }));
    await record(s.v.vault.events, s.v.fold, drafts.contactMerged({ cid: rep, from: gone }));
    await record(s.v.vault.events, s.v.fold, drafts.contactDeleted({ cid: gone }));
    await s.fresh();
    const third = await s.outbound.compose(gone, BASIC_MESSAGE, { content: "three" });
    expect(types(await s.fresh())).toEqual([]);
    expect(third.plain.from).toBe(one.plain.from);
  });

  it("answers their invitation: pthid names it until a profile of ours has gone out, and there is no prior to vouch with", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob, "accepted", "oob-9");

    const first = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "hi" });
    expect(first.plain.pthid).toBe("oob-9");
    expect(first.plain.from_prior).toBeUndefined();
    const found = await s.outbound.record(first);
    expect(found.skeleton.pthid).toBe("oob-9");

    await record(s.v.vault.events, s.v.fold, drafts.profileShared({ ...first.pair, mid: found.mid }));
    const later = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "more" });
    expect(later.plain.pthid).toBeUndefined();
    expect(later.plain.from_prior).toBeUndefined();

    const named = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "more" }, { pthid: "mine", thid: found.mid, attachments: [{ id: "a", data: { json: 1 } }] });
    expect(named.plain).toMatchObject({ pthid: "mine", thid: found.mid, attachments: [{ id: "a", data: { json: 1 } }] });
    expect((await s.outbound.record(named)).skeleton).toMatchObject({ pthid: "mine", thid: found.mid });
  });

  it("vouches with the key they last wrote to, and stops once they write to the new one", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await s.wrote(bob, s.pub.identity.did, "hello there");
    await s.fresh();

    const composed = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "hi" });
    expect(types(await s.fresh())).toEqual(["did.minted", "contact.useKey", "peer.resolved"]);
    expect(await vouchedBy(composed.plain.from_prior as string)).toEqual({ iss: s.pub.identity.did, sub: composed.plain.from as string });

    await s.wrote(bob, composed.plain.from as string, "got you");
    const answered = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "good" });
    expect(answered.plain.from).toBe(composed.plain.from);
    expect(answered.plain.from_prior).toBeUndefined();
  });

  it("writes back from the invitation they took, with nothing to vouch for", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const inv = await s.ring.mintInvitation(s.routed, "oob-1", "Talk to Alice");
    const cid = await s.wrote(bob, inv.identity.did, "taking you up on it", { pthid: "oob-1" });
    await s.fresh();

    const composed = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "welcome" });

    expect(types(await s.fresh())).toEqual([]); // the channel they wrote by is the one written back on: resolved already
    expect(composed.pair.myKey).toBe(inv.key);
    expect(composed.plain.from).toBe(inv.identity.did);
    expect(composed.plain.from_prior).toBeUndefined();
    expect(composed.plain.pthid).toBeUndefined();
  });

  it("vouches with the key we last wrote from when they never wrote, and goes without when that key is not this seed's", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);
    const { composed: first } = await s.write(cid, "one");
    await record(s.v.vault.events, s.v.fold, drafts.didRetired({ key: first.pair.myKey as string, because: "test" }));
    await s.fresh();

    const second = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "two" });
    expect(types(await s.fresh())).toEqual(["did.minted", "contact.useKey", "peer.resolved"]);
    expect(second.plain.from).not.toBe(first.plain.from);
    expect(await vouchedBy(second.plain.from_prior as string)).toEqual({ iss: first.plain.from as string, sub: second.plain.from as string });

    // a key the log records that this seed does not derive: what a merge from a device minted another way leaves
    const foreign = "did/0198c000-0000-7000-8000-00000000ffff";
    await record(s.v.vault.events, s.v.fold, drafts.didMinted({ key: foreign, did: "did:peer:4zQmForeign", routingDid: s.mediator.did, mediation: s.routed.id }));
    await record(s.v.vault.events, s.v.fold, drafts.contactUseKey({ cid, key: foreign, because: "minted" }));
    const foreignPair = { myKey: foreign, peerKey: fingerprint(bob, 2) };
    await record(s.v.vault.events, s.v.fold, drafts.peerResolved(resolvedOf(foreignPair, bob.did, bob.doc)));
    await recordMessage(s.v.vault, s.v.fold, "out", enc.encode("{}"), { ...foreignPair, mid: "0198c000-0000-7000-8000-00000000fff0", wireId: "w", msgType: BASIC_MESSAGE, attachments: [] });
    await record(s.v.vault.events, s.v.fold, drafts.didRetired({ key: foreign, because: "test" }));
    await s.fresh();

    const third = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "three" });
    expect(third.plain.from).toBe(second.plain.from);
    expect(third.plain.from_prior).toBeUndefined();
    expect(s.log).toContain(`${didPlaceholder(bob.did)} knows us by a DID this seed does not hold; sending without from_prior`);
  });

  it("writes to the latest of several current DIDs, and says so", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const bob2 = await peer(3, BOB_HTTP);
    const cid = await known(s, bob);
    const pair = { myKey: null, peerKey: fingerprint(bob2, 2) };
    await record(s.v.vault.events, s.v.fold, drafts.peerResolved(resolvedOf(pair, bob2.did, bob2.doc)));
    await record(s.v.vault.events, s.v.fold, drafts.contactAttached({ ...pair, cid, because: "manual" }));
    expect(s.v.fold.contact(cid)?.currentDids).toEqual([bob.did, bob2.did]);

    const composed = await s.outbound.compose(cid, BASIC_MESSAGE, { content: "hi" });

    expect(composed.to).toBe(bob2.did);
    expect(composed.pair.peerKey).toBe(fingerprint(bob2, 2));
    expect(s.log).toContain(`${didPlaceholder(bob2.did)} has 2 current DIDs; writing to ${didPlaceholder(bob2.did)}`);
  });

  it("refuses what it cannot address, leaving nothing behind", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);
    s.dead.add(bob.did);
    await expect(s.outbound.compose(cid, BASIC_MESSAGE, { content: "hi" })).rejects.toThrow("does not resolve");
    expect(await s.fresh()).toEqual([]);
    await expect(s.outbound.compose("0198c000-0000-7000-8000-0000000000ee", BASIC_MESSAGE, {})).rejects.toThrow("no contact");

    const unmediated = await scene({ mediated: false }, 4);
    const carol = await peer(5, CAROL_HTTP);
    const other = await known(unmediated, carol);
    await expect(unmediated.outbound.compose(other, BASIC_MESSAGE, { content: "hi" })).rejects.toThrow("no mediation granted yet");
    expect(await unmediated.fresh()).toEqual([]);
    expect(await unmediated.outbox.flush()).toEqual([]);
  });
});

describe("v2 outbound: delivering", () => {
  it("straight to their endpoint: registered first, sealed from our key, traced frame then envelope, recorded sent", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);
    const { composed, record: found } = await s.write(cid, "hi");
    await s.fresh();
    const before = s.mediator.seenTypes.length;

    const tried = await s.outbox.drain();

    expect(tried.map((event) => event.data)).toEqual([{ ...composed.pair, mid: found.mid, attempt: 1, outcome: "sent" }]);
    expect(types(await s.fresh())).toEqual(["did.registered", "delivery.attempted"]);
    expect(s.mediator.seenTypes.slice(before)).toEqual([RECIPIENT_UPDATE]);
    expect(s.mediator.recipients.get(composed.plain.from as string)).toBe(s.ring.me?.identity.did);
    expect(status(s, found.mid)).toBe("sent");
    expect(s.outbox.waiting()).toEqual([]);
    expect(s.posts.map((post) => post.url)).toEqual([BOB_HTTP]);
    const opened = await bob.open(s.posts[0]?.body as string);
    expect(opened.msg).toEqual(composed.plain);
    expect(opened.meta.encrypted_from_kid).toBe(`${composed.plain.from}#key-2`);
    expect(opened.meta.from_prior).toMatchObject({ iss: s.pub.identity.did, sub: composed.plain.from });

    const wire = (await s.trace.read("wire")).filter((event) => event.data["endpoint"] === BOB_HTTP || event.data["status"] === 202);
    expect(wire).toMatchObject([
      { type: "wire.out", data: { via: "http", endpoint: BOB_HTTP, type: BASIC_MESSAGE, bytes: expect.any(Number) } },
      { type: "wire.in", data: { via: "http", status: 202, ms: expect.any(Number) } },
    ]);
    expect(wire[1]?.data["parent"]).toBe(wire[0]?.eid);
    const seals = (await s.trace.read("envelope")).filter((event) => event.data["parent"] === wire[0]?.eid);
    expect(seals).toMatchObject([{ type: "envelope.seal", data: { kind: "authcrypt", type: BASIC_MESSAGE, mid: found.mid, skid: `${composed.plain.from}#key-2` } }]);
    expect((await s.trace.traceOf(found.mid)).map((event) => event.type)).toContain("envelope.seal");

    // the next message from the same key: nothing to register, one POST
    const { record: next } = await s.write(cid, "again");
    await s.outbox.drain();
    expect(s.mediator.seenTypes.slice(before)).toEqual([RECIPIENT_UPDATE]);
    expect(status(s, next.mid)).toBe("sent");
    expect(s.posts).toHaveLength(2);
  });

  it("through their mediator: a forward sealed to no one, our envelope inside it, both traced", async () => {
    const s = await scene();
    const bob = await mediated(s, 2);
    const cid = await known(s, bob);
    const { composed, record: found } = await s.write(cid, "hi");
    const before = s.mediator.seenTypes.length;

    const [tried] = await s.outbox.drain();

    expect(tried?.data).toMatchObject({ mid: found.mid, attempt: 1, outcome: "sent" });
    expect(s.mediator.seenTypes.slice(before)).toEqual([RECIPIENT_UPDATE, FORWARD]);
    expect(s.posts).toEqual([]);
    const [packed] = queuedFor(s, bob);
    const opened = await bob.open(packed as string);
    expect(opened.msg).toEqual(composed.plain);
    expect(opened.meta.encrypted_from_kid).toBe(`${composed.plain.from}#key-2`);

    const out = (await s.trace.read("wire")).filter((event) => event.type === "wire.out" && event.data["type"] === BASIC_MESSAGE);
    expect(out).toMatchObject([{ data: { endpoint: s.mediator.http } }]);
    const envelope = await s.trace.read("envelope");
    const forward = envelope.find((event) => event.data["parent"] === out[0]?.eid);
    expect(forward).toMatchObject({ type: "envelope.seal", data: { kind: "anoncrypt", type: FORWARD } });
    const inner = envelope.find((event) => event.data["parent"] === forward?.eid);
    expect(inner).toMatchObject({ type: "envelope.seal", data: { kind: "authcrypt", type: BASIC_MESSAGE, mid: found.mid } });
    const ritual = (await s.trace.read("mediation")).find((event) => event.data["parent"] === forward?.eid);
    expect(ritual).toMatchObject({ type: "mediation.out", data: { msg: { type: FORWARD, to: [s.mediator.did], body: { next: bob.did }, attachments: [{ data: { bytes: expect.any(Number) } }] } } });
    expect((ritual?.data["msg"] as { from?: unknown }).from).toBeUndefined();

    // one resolution per document per delivery: the service is read off the same document the key is sealed to
    await s.write(cid, "again");
    const counted = (did: string) => s.resolutions.get(did) ?? 0;
    const [bobBefore, mediatorBefore] = [counted(bob.did), counted(s.mediator.did)];
    await s.outbox.drain();
    expect(queuedFor(s, bob)).toHaveLength(2);
    expect([counted(bob.did) - bobBefore, counted(s.mediator.did) - mediatorBefore]).toEqual([1, 1]);
  });

  it("fails, and says why: an endpoint that answers badly, a service that cannot be reached, a body since erased", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);
    s.endpoints.set(BOB_HTTP, () => new Response("go away", { status: 503 }));
    const { record: refused } = await s.write(cid, "hi");
    const [tried] = await s.outbox.drain();
    expect(tried?.data).toMatchObject({ mid: refused.mid, attempt: 1, outcome: "failed", error: "endpoint answered 503" });
    expect(status(s, refused.mid)).toBe("failed");
    expect(s.log).toContain("could not deliver basicmessage/2.0/message (try 1): endpoint answered 503");
    expect((await s.trace.read("wire")).at(-1)).toMatchObject({ type: "wire.in", data: { status: 503 } });

    const odd = await peer(3, "mailto:odd@example.com");
    const oddCid = await known(s, odd);
    const { record: unroutable } = await s.write(oddCid, "hi");
    const tries = await s.outbox.drain({ cid: oddCid });
    expect(tries.map((event) => event.data)).toMatchObject([{ mid: unroutable.mid, outcome: "failed", error: "unroutable service endpoint: mailto:odd@example.com" }]);

    await eraseMessage(s.v.vault.events, s.v.fold, unroutable.mid, "user");
    const [gone] = await s.outbox.drain({ mid: unroutable.mid });
    expect(gone?.data).toMatchObject({ mid: unroutable.mid, attempt: 2, outcome: "failed", error: "its plaintext is erased" });
  });

  it("waits only so long for an endpoint", async () => {
    const s = await scene({ deliveryTimeoutMs: 50 });
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);
    s.endpoints.set(BOB_HTTP, (_body, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))));
    const { record: found } = await s.write(cid, "hi");
    const [tried] = await s.outbox.drain();
    expect(tried?.data).toMatchObject({ mid: found.mid, outcome: "failed", error: expect.stringMatching(/timeout|abort/i) });
    expect((await s.trace.read("wire")).at(-1)).toMatchObject({ type: "wire.error", data: { via: "http", error: expect.stringMatching(/timeout|abort/i) } });
  });
});

describe("v2 outbox", () => {
  it("offline, fails in order and stops that contact while others go on; online, sends everything in order", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const carol = await peer(3, CAROL_HTTP);
    const bobCid = await known(s, bob);
    const carolCid = await known(s, carol);
    const { record: b1 } = await s.write(bobCid, "one");
    const { record: b2 } = await s.write(bobCid, "two");
    const { record: c1 } = await s.write(carolCid, "hey");
    expect(s.outbox.waiting().map((message) => message.mid)).toEqual([b1.mid, b2.mid, c1.mid]);

    s.offline.reason = "fetch failed";
    const failed = await s.outbox.drain();
    expect(failed.map((event) => event.data)).toMatchObject([
      { mid: b1.mid, attempt: 1, outcome: "failed", error: "fetch failed" },
      { mid: c1.mid, attempt: 1, outcome: "failed", error: "fetch failed" },
    ]);
    expect([status(s, b1.mid), status(s, b2.mid), status(s, c1.mid)]).toEqual(["failed", "pending", "failed"]);
    expect(s.posts).toEqual([]);

    s.offline.reason = null;
    const sent = await s.outbox.flush();
    expect(sent.map((event) => event.data)).toMatchObject([
      { mid: b1.mid, attempt: 2, outcome: "sent" },
      { mid: b2.mid, attempt: 1, outcome: "sent" },
      { mid: c1.mid, attempt: 2, outcome: "sent" },
    ]);
    expect(s.posts.map((post) => post.url)).toEqual([BOB_HTTP, BOB_HTTP, CAROL_HTTP]);
    expect((await bob.open(s.posts[0]?.body as string)).msg.body).toEqual({ content: "one" });
    expect((await bob.open(s.posts[1]?.body as string)).msg.body).toEqual({ content: "two" });
    expect(attempts(s, b1.mid)).toEqual(["failed", "sent"]);
    expect(s.outbox.waiting()).toEqual([]);
    expect(await s.outbox.flush()).toEqual([]);
    expect(await s.outbox.drain()).toEqual([]);
  });

  it("leaves a held message alone until it is named", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);
    const { composed, record: found } = await s.write(cid, "hi");
    await record(s.v.vault.events, s.v.fold, drafts.deliveryHeld({ ...composed.pair, mid: found.mid, because: "user" }));
    expect(status(s, found.mid)).toBe("held");

    expect(await s.outbox.drain()).toEqual([]);
    expect(await s.outbox.flush()).toEqual([]);
    expect(s.posts).toEqual([]);
    expect(s.outbox.waiting().map((message) => message.mid)).toEqual([found.mid]);

    const tried = await s.outbox.retry(found.mid);
    expect(tried.data).toMatchObject({ mid: found.mid, attempt: 1, outcome: "sent" });
    expect(status(s, found.mid)).toBe("sent");
    expect(s.posts).toHaveLength(1);
    await expect(s.outbox.retry(found.mid)).rejects.toThrow("not waiting to be sent");
    await expect(s.outbox.retry("0198c000-0000-7000-8000-0000000000ee")).rejects.toThrow("not waiting to be sent");
  });

  it("tries one message once, however many passes run at the same time", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await known(s, bob);
    const { record: one } = await s.write(cid, "one");
    const { record: two } = await s.write(cid, "two");

    const [first, second] = await Promise.all([s.outbox.drain(), s.outbox.drain()]);

    expect(first?.map((event) => event.data.mid)).toEqual([one.mid, two.mid]);
    expect(second).toEqual([]);
    expect(s.posts).toHaveLength(2);
    expect(attempts(s, one.mid)).toEqual(["sent"]);
    expect(attempts(s, two.mid)).toEqual(["sent"]);
  });

  it("sends nothing to a contact since deleted, and nothing at all without a mediation", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const carol = await peer(3, CAROL_HTTP);
    const bobCid = await known(s, bob);
    const carolCid = await known(s, carol);
    const { record: toBob } = await s.write(bobCid, "hi");
    const { record: toCarol } = await s.write(carolCid, "hi");
    await record(s.v.vault.events, s.v.fold, drafts.contactDeleted({ cid: bobCid }));
    expect(s.v.fold.attribution(toBob.pair)).toMatchObject({ kind: "deleted" });

    const tried = await s.outbox.drain();
    expect(tried.map((event) => event.data.mid)).toEqual([toCarol.mid]);
    await expect(s.outbox.retry(toBob.mid)).rejects.toThrow("not waiting to be sent");

    const { record: later } = await s.write(carolCid, "later");
    await record(s.v.vault.events, s.v.fold, drafts.mediationRetired({ id: s.routed.id, because: "test" }));
    expect(await s.outbox.flush()).toEqual([]);
    await expect(s.outbox.retry(later.mid)).rejects.toThrow("no mediation granted yet");
    const [forced] = await s.outbox.drain();
    expect(forced?.data).toMatchObject({ mid: later.mid, outcome: "failed", error: "no mediation granted yet: nothing to write from" });
    expect(s.posts).toHaveLength(1);
  });

  it("sends nothing on a channel since frozen, and says why", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    const cid = await s.wrote(bob, s.pub.identity.did, "hello");
    const { composed, record: retired } = await s.write(cid, "one");
    await record(s.v.vault.events, s.v.fold, drafts.didRetired({ key: composed.pair.myKey as string, because: "mediation-changed" }));
    const [tried] = await s.outbox.drain();
    expect(tried?.data).toMatchObject({ mid: retired.mid, outcome: "failed", error: "written from a key since retired (mediation-changed)" });

    // written from a key under another device's mediation: derived here, but its mail is that device's
    const theirs = await s.ring.mintToward(cid, { id: "0198c000-0000-7000-8000-00000000aaaa", routingDid: s.mediator.did });
    const theirPair = { myKey: theirs.key, peerKey: fingerprint(bob, 2) };
    await record(s.v.vault.events, s.v.fold, drafts.peerResolved(resolvedOf(theirPair, bob.did, bob.doc)));
    await recordMessage(s.v.vault, s.v.fold, "out", enc.encode(JSON.stringify({ ...composed.plain, from: theirs.identity.did })), { ...theirPair, mid: "0198c000-0000-7000-8000-00000000fff1", wireId: "w", msgType: BASIC_MESSAGE, attachments: [] });
    const [other] = await s.outbox.drain({ mid: "0198c000-0000-7000-8000-00000000fff1" });
    expect(other?.data).toMatchObject({ outcome: "failed", error: "written from a key that is not under this device's mediation" });

    // written to a key of theirs they have since rotated away from
    const { composed: fresh, record: toOld } = await s.write(cid, "two");
    const bobRekeyed = await peer(3, CAROL_HTTP);
    const [jwt] = await new FromPrior({ iss: bob.did, sub: bobRekeyed.did, iat: 1 }).pack(`${bob.did}#key-1`, resolver, secretsResolverFor(bob.secrets));
    expect(await s.wrote(bobRekeyed, fresh.plain.from as string, "new key", { from_prior: jwt })).toBe(cid);
    expect(s.v.fold.contact(cid)?.currentDids).toEqual([bobRekeyed.did]);
    const [stale] = await s.outbox.drain({ mid: toOld.mid });
    expect(stale?.data).toMatchObject({ mid: toOld.mid, outcome: "failed", error: "written to a key that is not in their document any more" });
    // and what is written now goes to the new key
    const { record: toNew } = await s.write(cid, "three");
    const [sent] = await s.outbox.drain({ mid: toNew.mid });
    expect(sent?.data).toMatchObject({ mid: toNew.mid, outcome: "sent" });
    expect(s.posts.map((post) => post.url)).toEqual([CAROL_HTTP]);

    // a channel two contacts claim is no one's to write from until merged
    const carol = await peer(4, CAROL_HTTP);
    const carolCid = await known(s, carol);
    const { composed: contested, record: toCarol } = await s.write(carolCid, "hi");
    await record(s.v.vault.events, s.v.fold, drafts.contactAttached({ myKey: null, peerKey: fingerprint(carol, 2), cid, because: "manual" }));
    expect(s.v.fold.attribution(contested.pair)).toMatchObject({ kind: "several" });
    const [claimed] = await s.outbox.drain({ mid: toCarol.mid });
    expect(claimed?.data).toMatchObject({ mid: toCarol.mid, outcome: "failed", error: "written on a channel that is not this contact's alone" });
    expect(s.log.filter((line) => line.startsWith("could not deliver"))).toHaveLength(4);
  });

  it("carries the mail to where they are now, not where it was written to", async () => {
    const s = await scene();
    const bob = await peer(2, BOB_HTTP);
    // the same keys under a DID whose service moved: what a change of mediator leaves
    const bobMoved = await peer(2, CAROL_HTTP);
    expect(fingerprint(bobMoved, 2)).toBe(fingerprint(bob, 2));
    const cid = await s.wrote(bob, s.pub.identity.did, "hello");
    const { composed, record: found } = await s.write(cid, "hi");
    // they move before we deliver: a message vouched for by the old DID, from the new one, to the key we wrote from
    const [jwt] = await new FromPrior({ iss: bob.did, sub: bobMoved.did, iat: 1 }).pack(`${bob.did}#key-1`, resolver, secretsResolverFor(bob.secrets));
    expect(await s.wrote(bobMoved, composed.plain.from as string, "moved", { from_prior: jwt })).toBe(cid);
    expect(s.v.fold.contact(cid)?.currentDids).toEqual([bobMoved.did]);
    expect(s.v.fold.contact(cid)?.writeTo).toContainEqual(composed.pair);

    const [tried] = await s.outbox.drain();

    expect(tried?.data).toMatchObject({ ...composed.pair, mid: found.mid, outcome: "sent" });
    expect(s.posts.map((post) => post.url)).toEqual([CAROL_HTTP]);
    const opened = await bobMoved.open(s.posts[0]?.body as string);
    // the wire copy names where it went; the record keeps the address it was written to
    expect(opened.msg).toEqual({ ...composed.plain, to: [bobMoved.did] });
    expect(opened.meta.encrypted_from_kid).toBe(`${composed.plain.from}#key-2`);
    expect(s.v.fold.contact(cid)?.thread.map((message) => message.mid)).toContain(found.mid);
    expect(found.msg?.to).toEqual([bob.did]);
  });
});
