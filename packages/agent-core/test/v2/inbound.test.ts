import { describe, expect, it } from "vitest";
import { FromPrior, Message } from "didcomm-node";

import { resolveDIDCommDoc, type DIDDoc, type Secret, type VerificationMethod } from "@estoc/did-peer";
import { MemoryBackend, compareEvents, type Event } from "@estoc/event-store";
import { createSeedKeystore, deriveIdentity } from "@estoc/keystore";
import { drafts, peerKeyOf, record, recordMessage, type ChannelKey, type VaultDraft, type VaultEvent, type VaultType } from "@estoc/vault/v2";

import { BASIC_MESSAGE, OBJECT_SHARE, PLAIN_TYP, PROFILE, attachmentsOf, closureOf, secretsResolverFor, type IMessage } from "../../src/index.js";
import { TRUST_PING, TRUST_PING_RESPONSE } from "../../src/protocol/spec.js";
import {
  AgentTrace,
  Inbound,
  Keyring,
  MediatorLink,
  createVault,
  didPlaceholder,
  messageRecord,
  mintPeerDid,
  objectShareHandler,
  userProfileHandler,
  type ContactRecord,
  type HandlerContext,
  type InboundOptions,
  type InboundRecord,
  type MessageRecord,
  type MyIdentity,
  type Opened,
  type PeerVault,
  type ProtocolHandler,
  type SendOptions,
} from "../../src/v2/index.js";

const didcomm = { Message, FromPrior };
const resolver = { resolve: resolveDIDCommDoc };
const enc = new TextEncoder();
const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);
const HELLO = "https://example.com/test/1.0/hello";
const NOBODY: DIDDoc = { id: "did:example:nobody", verificationMethod: [], authentication: [], keyAgreement: [], service: [] };

/** every stamp a second after the last: `at` orders what the test appends, whatever the wall clock does */
function ticking(start = "2026-08-31T00:00:00.000Z"): () => Date {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

/** someone out there: a did:peer:4 with no service, their secrets, their document */
interface Peer {
  did: string;
  secrets: Secret[];
  doc: DIDDoc;
}

async function peer(fill: number, service: string | null = null): Promise<Peer> {
  const { seedKey } = await createSeedKeystore("test", { seed: seedOf(fill) });
  const identity = mintPeerDid(await deriveIdentity(seedKey, "did/peer"), service);
  return { ...identity, doc: (await resolveDIDCommDoc(identity.did)) as DIDDoc };
}

/** the document's key `n` as multibase: 1 the Ed25519 signing key, 2 the X25519 agreement key */
function key(doc: DIDDoc, n: 1 | 2): string {
  const method = doc.verificationMethod.find((entry) => entry.id === `${doc.id}#key-${n}`) as VerificationMethod;
  return method.publicKeyMultibase as string;
}

const fingerprint = (who: Peer, n: 1 | 2): string => peerKeyOf(key(who.doc, n));

function plain(type: string, from: string | null, to: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}): IMessage {
  return { id: crypto.randomUUID(), typ: PLAIN_TYP, type, ...(from === null ? {} : { from }), to: [to], created_time: 1, body, ...extra } as IMessage;
}

/** sealed to `to`: authcrypt from `from`, anoncrypt from no one; signed inside by `signBy` when given */
async function sealed(msg: IMessage, to: string, from: Peer | null, signBy: Peer | null = null): Promise<string> {
  const secrets = [...(from?.secrets ?? []), ...(signBy?.secrets ?? [])];
  const [packed] = await new Message(msg).pack_encrypted(to, from?.did ?? null, signBy?.did ?? null, resolver, secretsResolverFor(secrets), { forward: false });
  return packed;
}

/** `old` signs `fresh` over: the header a rotation rides */
async function vouched(old: Peer, fresh: Peer, iat = 1): Promise<string> {
  const [jwt] = await new FromPrior({ iss: old.did, sub: fresh.did, iat }).pack(`${old.did}#key-1`, resolver, secretsResolverFor(old.secrets));
  return jwt;
}

interface Scene {
  v: PeerVault;
  ring: Keyring;
  link: MediatorLink;
  /** the key of ours mail is written to */
  me: MyIdentity;
  /** a second key, published as a one-use invitation by `invite` */
  inv: MyIdentity;
  inbound: Inbound;
  log: string[];
  replies: { to: string; type: string; body: Record<string, unknown>; options?: SendOptions }[];
  /** what the collecting handler was handed: the record's mid and the contact's cid */
  handled: { mid: string; cid: string; type: string }[];
  /** open a packed envelope the way the link does, and handle it */
  take(packed: string): Promise<Awaited<ReturnType<Inbound["handle"]>>>;
  /** `msg` sealed to `to` (our `me` by default) from `from`, opened and handled */
  deliver(msg: IMessage, from: Peer | null, options?: { to?: string; signBy?: Peer }): Promise<Awaited<ReturnType<Inbound["handle"]>>>;
  /** the types of the events appended since the last call */
  fresh(): Promise<Event[]>;
}

async function all(v: PeerVault): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of v.vault.events.scan()) {
    events.push(event);
  }
  return events.sort(compareEvents);
}

let outboundCount = 0;

async function scene(options: Partial<InboundOptions> & { extraHandlers?: ProtocolHandler[] } = {}, fill = 1): Promise<Scene> {
  const clock = ticking();
  const { doc, seedKey } = await createSeedKeystore("test", { seed: seedOf(fill) });
  const v = await createVault(new MemoryBackend(), { keystore: doc, seedKey, label: "Alice", clock });
  const minted = await v.keys.mintDid(v.fold, null);
  const invited = await v.keys.mintDid(v.fold, null);
  const ring = await Keyring.load(v);
  const me = ring.identityOf(minted.key) as MyIdentity["identity"];
  const inv = ring.identityOf(invited.key) as MyIdentity["identity"];
  const trace = await AgentTrace.open(v.vault.local("agent"));
  const resolveDid = options.resolveDid ?? resolveDIDCommDoc;
  const link = new MediatorLink({
    didcomm,
    resolveDid,
    trace,
    secrets: () => ring.secrets(),
    me: () => {
      throw new Error("no mediator in this scene");
    },
    mediatorDid: NOBODY.id,
    mediatorDoc: NOBODY,
  });
  const log: string[] = [];
  const replies: Scene["replies"] = [];
  const handled: Scene["handled"] = [];
  const out = async (contact: ContactRecord, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord> => {
    const pair: ChannelKey = contact.write ?? { myKey: minted.key, peerKey: null };
    const msg = plain(type, me.did, contact.currentDids.at(-1) ?? "", body, { ...options });
    const mid = `0198c000-0000-7000-8000-${(++outboundCount).toString(16).padStart(12, "0")}`;
    await recordMessage(v.vault, v.fold, "out", enc.encode(JSON.stringify(msg)), { ...pair, mid, wireId: msg.id, msgType: type, attachments: [] });
    return (await messageRecord(v.fold, v.vault.blobs, mid)) as MessageRecord;
  };
  const ctx: HandlerContext = {
    fold: v.fold,
    blobs: v.vault.blobs,
    record: async <T extends VaultType>(draft: VaultDraft<T>): Promise<VaultEvent<T>> => (await record(v.vault.events, v.fold, draft)) as VaultEvent<T>,
    send: (cid, type, body, options) => out(v.fold.contact(cid) as unknown as ContactRecord, type, body, options),
    reply: (contact, type, body, options) => {
      replies.push({ to: contact.cid, type, body, ...(options === undefined ? {} : { options }) });
      return out(contact, type, body, options);
    },
    displayName: () => "Alice",
    log: (line) => log.push(line),
  };
  const collect: ProtocolHandler = {
    types: [BASIC_MESSAGE, HELLO],
    async onInbound(found: InboundRecord, contact: ContactRecord): Promise<void> {
      handled.push({ mid: found.mid, cid: contact.cid, type: found.msg.type });
    },
  };
  const inbound = new Inbound(v, ctx, {
    resolveDid,
    keyOfDid: ring.keyOfDid,
    handlers: [userProfileHandler, objectShareHandler, collect, ...(options.extraHandlers ?? [])],
    clock,
    ...options,
  });
  let seen = (await all(v)).length;
  return {
    v,
    ring,
    link,
    me: { key: minted.key, identity: me },
    inv: { key: invited.key, identity: inv },
    inbound,
    log,
    replies,
    handled,
    take: async (packed) => inbound.handle(await link.unpack(packed)),
    deliver: async (msg, from, { to = me.did, signBy = null } = {}) => inbound.handle(await link.unpack(await sealed(msg, to, from, signBy))),
    fresh: async () => {
      const events = await all(v);
      const since = events.slice(seen);
      seen = events.length;
      return since;
    },
  };
}

const types = (events: Event[]): string[] => events.map((event) => event.type);
const contactOf = (s: Scene, cid: string): ContactRecord => s.inbound["contactOf"](cid);
const hello = (from: Peer, to: string, content: string): IMessage => plain(BASIC_MESSAGE, from.did, to, { content });

/** `inv` published as a one-use invitation */
async function invite(s: Scene, oobId = "oob-1", goal: string | null = "Talk to Alice"): Promise<void> {
  await record(s.v.vault.events, s.v.fold, drafts.didPublished({ key: s.inv.key, as: "oob", uses: "one", oobId, ...(goal === null ? {} : { goal }) }));
  await s.fresh();
}

const invitationOf = (s: Scene) => s.v.fold.invitations().find((entry) => entry.key === s.inv.key);

describe("v2 inbound: a message from a stranger", () => {
  it("records it on the channel the envelope proved, adopts them, and hands the handler the record and the contact", async () => {
    const s = await scene();
    const bob = await peer(2);
    const msg = hello(bob, s.me.identity.did, "hi");

    const handled = await s.take(await sealed(msg, s.me.identity.did, bob));

    const pair = { myKey: s.me.key, peerKey: fingerprint(bob, 2) };
    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in"]);
    expect(events[0]?.data).toEqual({ ...pair, kind: "authcrypt", peerPublicKey: key(bob.doc, 2), firstDid: bob.did });
    expect(events[1]?.data).toEqual({ ...pair, did: bob.did, keys: [key(bob.doc, 1), key(bob.doc, 2)], service: null });
    expect(events[4]?.data).toMatchObject({ ...pair, did: bob.did, wireId: msg.id, msgType: BASIC_MESSAGE, attachments: [] });
    expect(events[4]?.data).not.toHaveProperty("signedBy");
    if (handled.outcome !== "recorded") throw new Error(handled.outcome);
    const { record: found, contact } = handled;
    expect(found).toMatchObject({ direction: "in", pair, sender: bob.did, body: "present" });
    expect(found.msg?.body).toEqual({ content: "hi" });
    expect(found.mid).toBe((events[4]?.data as { mid: string }).mid);
    expect(contact).not.toBeNull();
    expect(contact?.name).toBe(didPlaceholder(bob.did));
    expect(contact?.currentDids).toEqual([bob.did]);
    expect(contact?.attached).toMatchObject([{ pair, because: "manual", oobId: null }]);
    expect(events[3]?.data).toEqual({ ...pair, cid: contact?.cid, because: "manual" });
    expect(s.handled).toEqual([{ mid: found.mid, cid: contact?.cid, type: BASIC_MESSAGE }]);
    expect(s.log).toEqual(["a stranger wrote to us; they have a thread now"]);

    // the second message: the channel is known, nothing but the message is written
    const again = await s.deliver(hello(bob, s.me.identity.did, "again"), bob);
    expect(types(await s.fresh())).toEqual(["message.in"]);
    expect(again.outcome === "recorded" && again.contact?.cid).toBe(contact?.cid);
    expect(s.handled).toHaveLength(2);
    expect(s.v.fold.contacts()).toHaveLength(1);
  });

  it("the same wire id from the same key is a duplicate, remembered across a reopen; from another key it is another message", async () => {
    const s = await scene();
    const bob = await peer(2);
    const carol = await peer(3);
    const msg = hello(bob, s.me.identity.did, "once");
    const packed = await sealed(msg, s.me.identity.did, bob);
    expect((await s.take(packed)).outcome).toBe("recorded");
    await s.fresh();

    expect(await s.take(packed)).toEqual({ outcome: "duplicate" });
    expect(await s.fresh()).toEqual([]);
    expect(s.log.at(-1)).toBe(`${BASIC_MESSAGE} ${msg.id} arrived again; recorded already`);
    expect(s.handled).toHaveLength(1);

    // a fresh inbound over the same vault loads what was seen from the fold
    const reopened = new Inbound(s.v, s.inbound["ctx"], { resolveDid: resolveDIDCommDoc, keyOfDid: s.ring.keyOfDid });
    expect(await reopened.handle(await s.link.unpack(packed))).toEqual({ outcome: "duplicate" });
    expect(await s.fresh()).toEqual([]);

    // carol, with bob's wire id: her key, her message
    expect((await s.deliver({ ...msg, from: carol.did }, carol)).outcome).toBe("recorded");
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in"]);
  });

  it("what the envelope proved is what the skeleton says: anonymous, signed inside anoncrypt, signed inside authcrypt", async () => {
    const s = await scene();
    const bob = await peer(2);
    const carol = await peer(3);
    const me = s.me.identity.did;

    // anoncrypt, unsigned: no peer key, no DID, no contact, no handler
    const anonymous = await s.deliver(plain(BASIC_MESSAGE, null, me, { content: "who knows" }), null);
    let events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "message.in"]);
    expect(events[0]?.data).toEqual({ myKey: s.me.key, peerKey: null, kind: "anoncrypt" });
    expect(events[1]?.data).toMatchObject({ myKey: s.me.key, peerKey: null });
    expect(events[1]?.data).not.toHaveProperty("did");
    if (anonymous.outcome !== "recorded") throw new Error(anonymous.outcome);
    expect(anonymous.record.sender).toBeNull();
    expect(anonymous.record.msg?.body).toEqual({ content: "who knows" });
    expect(anonymous.contact).toBeNull();
    expect(s.handled).toEqual([]);
    expect(s.log).toEqual([`recorded an anonymous ${BASIC_MESSAGE}; it is attributed to nobody`]);

    // signed inside anoncrypt: the signing key places it, the signer's DID is the sender
    const signed = await s.deliver(hello(bob, me, "signed"), null, { signBy: bob });
    events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in"]);
    const bobSigning = { myKey: s.me.key, peerKey: fingerprint(bob, 1) };
    expect(events[0]?.data).toEqual({ ...bobSigning, kind: "signed", peerPublicKey: key(bob.doc, 1), firstDid: bob.did });
    expect(events[4]?.data).toMatchObject({ ...bobSigning, did: bob.did });
    expect(events[4]?.data).not.toHaveProperty("signedBy");
    expect(signed.outcome === "recorded" && signed.record.sender).toBe(bob.did);

    // authcrypt with a signature inside: the sealing key places it, the signature is noted
    const both = await s.deliver(hello(carol, me, "both"), carol, { signBy: carol });
    events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in"]);
    const carolSealing = { myKey: s.me.key, peerKey: fingerprint(carol, 2) };
    expect(events[0]?.data).toEqual({ ...carolSealing, kind: "authcrypt", peerPublicKey: key(carol.doc, 2), firstDid: carol.did });
    expect(events[4]?.data).toMatchObject({ ...carolSealing, did: carol.did, signedBy: key(carol.doc, 1) });
    expect(both.outcome === "recorded" && both.contact?.currentDids).toEqual([carol.did]);
    expect(s.v.fold.contacts()).toHaveLength(2);
  });

  it("a plaintext is ignored and leaves nothing; a sender whose document does not resolve now is left for a later pickup", async () => {
    const s = await scene();
    const bob = await peer(2);
    const packed = await new Message(hello(bob, s.me.identity.did, "bare")).pack_plaintext(resolver);
    expect(await s.take(packed)).toEqual({ outcome: "ignored" });
    expect(await s.fresh()).toEqual([]);
    expect(s.log).toEqual([`a plaintext ${BASIC_MESSAGE} reached us as mail; it proves no one and is not kept`]);

    // a document didcomm did not hand over (a hand-built open) and a resolver that has nothing now
    const flaky = new Inbound(s.v, s.inbound["ctx"], { resolveDid: async (did) => (did === bob.did ? null : resolveDIDCommDoc(did)), keyOfDid: s.ring.keyOfDid });
    const opened = await s.link.unpack(await sealed(hello(bob, s.me.identity.did, "later"), s.me.identity.did, bob));
    await expect(flaky.handle({ ...opened, documents: new Map() })).rejects.toThrow(`${bob.did} does not resolve now`);
    expect(await s.fresh()).toEqual([]);
  });

  it("the key of ours that opened it is the one the link found a secret for, whatever kid is named first", async () => {
    const s = await scene();
    await invite(s);
    const bob = await peer(2);
    const msg = hello(bob, s.me.identity.did, "sneaky");
    // crafted by hand: a kid under the invitation's DID that names no key of ours, ahead of the key that opened it
    const opened = {
      msg,
      sender: bob.did,
      recipient: s.me.identity.did,
      fromPrior: null,
      metadata: { encrypted: true, non_repudiation: false, encrypted_from_kid: `${bob.did}#key-2`, encrypted_to_kids: [`${s.inv.identity.did}#key-9`, `${s.me.identity.did}#key-2`], sign_from: null },
      documents: new Map([[bob.did, bob.doc]]),
      open: {},
    } as unknown as Opened;

    const handled = await s.inbound.handle(opened);

    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in"]);
    expect(events[0]?.data).toMatchObject({ myKey: s.me.key, peerKey: fingerprint(bob, 2) });
    expect(handled.outcome === "recorded" && handled.record.pair).toEqual({ myKey: s.me.key, peerKey: fingerprint(bob, 2) });
    expect(invitationOf(s)).toMatchObject({ open: true, takenBy: [] });
  });

  it("the channel is read from the document didcomm opened the envelope with, not from a later resolution", async () => {
    const bob = await peer(2);
    const carol = await peer(3);
    // bob's DID, resolving to carol's agreement key from the second look on: a did:web changing keys under one kid
    const swapped: DIDDoc = {
      ...bob.doc,
      verificationMethod: bob.doc.verificationMethod.map((method) => (method.id === `${bob.did}#key-2` ? { ...method, publicKeyMultibase: key(carol.doc, 2) } : method)),
    };
    let calls = 0;
    const s = await scene({ resolveDid: async (did) => (did === bob.did ? (calls++ === 0 ? bob.doc : swapped) : resolveDIDCommDoc(did)) });
    const opened = await s.link.unpack(await sealed(hello(bob, s.me.identity.did, "then"), s.me.identity.did, bob));
    expect(opened.documents.get(bob.did)).toBe(bob.doc);
    const during = calls;

    const handled = await s.inbound.handle(opened);

    expect(calls).toBe(during);
    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in"]);
    expect(events[0]?.data).toMatchObject({ peerKey: fingerprint(bob, 2), peerPublicKey: key(bob.doc, 2) });
    expect(events[1]?.data).toMatchObject({ did: bob.did, keys: [key(bob.doc, 1), key(bob.doc, 2)] });
    expect(handled.outcome === "recorded" && handled.record.pair.peerKey).toBe(fingerprint(bob, 2));
  });

  it("didcomm asking twice for one DID gets one answer: the document kept is the one the envelope was verified against", async () => {
    const bob = await peer(2);
    const carol = await peer(3);
    // bob's DID, resolving to carol's keys from the second look on: a signature verified against one document and a key looked up in another would not open
    const swapped: DIDDoc = { ...bob.doc, verificationMethod: carol.doc.verificationMethod.map((method) => ({ ...method, id: method.id.replace(carol.did, bob.did), controller: bob.did })) };
    const calls: string[] = [];
    const s = await scene({
      resolveDid: async (did) => {
        calls.push(did);
        return did === bob.did ? (calls.filter((d) => d === bob.did).length === 1 ? bob.doc : swapped) : resolveDIDCommDoc(did);
      },
    });
    const opened = await s.link.unpack(await sealed(hello(bob, s.me.identity.did, "sealed and signed"), s.me.identity.did, bob, bob));
    expect(calls.filter((did) => did === bob.did)).toHaveLength(1);
    expect(opened.documents.get(bob.did)).toBe(bob.doc);

    const handled = await s.inbound.handle(opened);

    expect(calls.filter((did) => did === bob.did)).toHaveLength(1);
    expect(handled.outcome === "recorded" && handled.record.skeleton).toMatchObject({ peerKey: fingerprint(bob, 2), did: bob.did, signedBy: key(bob.doc, 1) });
  });

  it("interrupted before the record, the redelivery finishes: every step before it is done once", async () => {
    const s = await scene();
    const bob = await peer(2);
    const bob2 = await peer(22);
    const dan = await peer(4);
    const me = s.me.identity.did;
    const known = await s.deliver(hello(bob, me, "old me"), bob);
    const cid = known.outcome === "recorded" ? (known.contact as ContactRecord).cid : "";
    await s.fresh();
    const blobs = s.v.vault.blobs;
    const put = blobs.put.bind(blobs);
    let failing = false;
    blobs.put = async (bytes: Uint8Array) => {
      if (failing) {
        failing = false;
        throw new Error("disk full");
      }
      return put(bytes);
    };

    // a rotation, cut off at the body: the rotation is in the log, the record is not
    const moved = await sealed(plain(BASIC_MESSAGE, bob2.did, me, { content: "new me" }, { from_prior: await vouched(bob, bob2) }), me, bob2);
    failing = true;
    await expect(s.take(moved)).rejects.toThrow("disk full");
    const cut = await s.fresh();
    expect(types(cut)).toEqual(["channel.firstSeen", "peer.resolved", "peer.rotated"]);
    const promised = (cut[2]?.data as { mid: string }).mid;
    expect(s.v.fold.message(promised)).toBeNull();
    // meanwhile the same move vouched for by another JWT: its own record, under its own mid, not the one promised
    const aside = await s.deliver(plain(BASIC_MESSAGE, bob2.did, me, { content: "aside" }, { from_prior: await vouched(bob, bob2, 2) }), bob2);
    expect(types(await s.fresh())).toEqual(["message.in"]);
    expect(aside.outcome === "recorded" && aside.record.mid).not.toBe(promised);
    expect(s.v.fold.message(promised)).toBeNull();
    const again = await s.take(moved);
    const landed = await s.fresh();
    expect(types(landed)).toEqual(["message.in"]);
    // the record takes the mid the rotation named: the evidence points at the message
    expect((landed[0]?.data as { mid: string }).mid).toBe(promised);
    expect(again.outcome === "recorded" && again.record.mid).toBe(promised);
    expect(again.outcome === "recorded" && again.contact?.cid).toBe(cid);
    expect(contactOf(s, cid).currentDids).toEqual([bob2.did]);

    // a stranger, cut off the same way: adopted once
    const knock = await sealed(hello(dan, me, "knock"), me, dan);
    failing = true;
    await expect(s.take(knock)).rejects.toThrow("disk full");
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached"]);
    const opened = await s.take(knock);
    expect(types(await s.fresh())).toEqual(["message.in"]);
    expect(opened.outcome === "recorded" && opened.contact?.currentDids).toEqual([dan.did]);
    expect(s.v.fold.contacts()).toHaveLength(2);
    expect((await all(s.v)).filter((event) => event.type === "peer.rotated")).toHaveLength(1);
    expect(s.handled.map((entry) => entry.type)).toEqual([BASIC_MESSAGE, BASIC_MESSAGE, BASIC_MESSAGE, BASIC_MESSAGE]);
    expect(await s.take(knock)).toEqual({ outcome: "duplicate" });
  });

  it("a contact is created and attached as one write: a failure there leaves nothing, and the redelivery adopts once", async () => {
    const s = await scene();
    await invite(s);
    const bob = await peer(2);
    const carol = await peer(3);
    const events = s.v.vault.events;
    const appendAll = events.appendAll.bind(events);
    let failing = false;
    events.appendAll = async (batch) => {
      if (failing) {
        failing = false;
        throw new Error("disk full");
      }
      return appendAll(batch);
    };

    // a stranger adopted by hand, and one taking an invitation: the same write
    const knock = await sealed(hello(bob, s.me.identity.did, "knock"), s.me.identity.did, bob);
    failing = true;
    await expect(s.take(knock)).rejects.toThrow("disk full");
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved"]);
    expect(s.v.fold.contacts()).toEqual([]);
    await s.take(knock);
    expect(types(await s.fresh())).toEqual(["contact.created", "contact.attached", "message.in"]);

    const took = await sealed(hello(carol, s.inv.identity.did, "found you"), s.inv.identity.did, carol);
    failing = true;
    await expect(s.take(took)).rejects.toThrow("disk full");
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved"]);
    expect(invitationOf(s)).toMatchObject({ open: true, takenBy: [] });
    const taken = await s.take(took);
    expect(types(await s.fresh())).toEqual(["contact.created", "contact.attached", "message.in"]);
    expect(taken.outcome === "recorded" && taken.contact?.attached).toMatchObject([{ because: "invitation", oobId: "oob-1" }]);
    expect(s.v.fold.contacts()).toHaveLength(2);
  });
});

describe("v2 inbound: invitations", () => {
  it("open: the first to write takes it — a contact created and attached because of it, with the oobId their replies name", async () => {
    const s = await scene();
    await invite(s);
    const carol = await peer(3);
    expect(invitationOf(s)).toMatchObject({ open: true, takenBy: [], oobId: "oob-1", did: s.inv.identity.did });

    const handled = await s.deliver(hello(carol, s.inv.identity.did, "found you"), carol, { to: s.inv.identity.did });

    const pair = { myKey: s.inv.key, peerKey: fingerprint(carol, 2) };
    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in"]);
    if (handled.outcome !== "recorded") throw new Error(handled.outcome);
    const contact = handled.contact as ContactRecord;
    expect(events[3]?.data).toEqual({ ...pair, cid: contact.cid, because: "invitation", oobId: "oob-1" });
    expect(contact.attached).toMatchObject([{ pair, because: "invitation", oobId: "oob-1" }]);
    expect(contact.currentDids).toEqual([carol.did]);
    expect(invitationOf(s)).toMatchObject({ open: false, takenBy: [contact.cid] });
    // the fold adds the implicit useKey: the invitation's key is ours toward them now
    expect(contact.keys.map((entry) => [entry.key, entry.implicit])).toEqual([[s.inv.key, true]]);
    expect(s.log).toEqual(["someone took an invitation of ours; they have a thread now"]);
    expect(s.handled).toEqual([{ mid: handled.record.mid, cid: contact.cid, type: BASIC_MESSAGE }]);

    // and writes again: theirs already
    const again = await s.deliver(hello(carol, s.inv.identity.did, "still me"), carol, { to: s.inv.identity.did });
    expect(types(await s.fresh())).toEqual(["message.in"]);
    expect(again.outcome === "recorded" && again.contact?.cid).toBe(contact.cid);
  });

  it("taken: someone else writing to it is recorded and turned away, never adopted", async () => {
    const s = await scene();
    await invite(s);
    const carol = await peer(3);
    const dan = await peer(4);
    const took = await s.deliver(hello(carol, s.inv.identity.did, "first"), carol, { to: s.inv.identity.did });
    const carols = took.outcome === "recorded" ? (took.contact as ContactRecord).cid : "";
    await s.fresh();
    s.log.length = 0;

    const turned = await s.deliver(hello(dan, s.inv.identity.did, "me too"), dan, { to: s.inv.identity.did });

    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved", "message.in"]);
    expect(turned.outcome === "recorded" && turned.contact).toBeNull();
    expect(turned.outcome === "recorded" && turned.record.sender).toBe(dan.did);
    expect(s.v.fold.attribution({ myKey: s.inv.key, peerKey: fingerprint(dan, 2) })).toEqual({ kind: "none" });
    expect(invitationOf(s)).toMatchObject({ open: false, takenBy: [carols] });
    expect(s.log).toEqual(["someone else wrote to an invitation already taken; turned away"]);
    expect(s.handled).toHaveLength(1);
    expect(s.v.fold.contacts()).toHaveLength(1);
  });

  it("withdrawn: the key retired, whoever writes is turned away; anonymous mail takes nothing and leaves it open", async () => {
    const s = await scene();
    await invite(s, "oob-2", null);
    const to = s.inv.identity.did;

    const anonymous = await s.deliver(plain(BASIC_MESSAGE, null, to, { content: "psst" }), null, { to });
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "message.in"]);
    expect(anonymous.outcome === "recorded" && anonymous.contact).toBeNull();
    expect(invitationOf(s)).toMatchObject({ open: true, takenBy: [] });
    expect(s.log).toEqual([`recorded an anonymous ${BASIC_MESSAGE}; it is attributed to nobody`]);
    s.log.length = 0;

    await record(s.v.vault.events, s.v.fold, drafts.didRetired({ key: s.inv.key, because: "revoked" }));
    await s.fresh();
    const erin = await peer(5);
    const late = await s.deliver(hello(erin, to, "too late"), erin, { to });
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved", "message.in"]);
    expect(late.outcome === "recorded" && late.contact).toBeNull();
    expect(invitationOf(s)).toMatchObject({ open: false, takenBy: [] });
    expect(s.log).toEqual(["someone wrote to an invitation since withdrawn; turned away"]);
    expect(s.v.fold.contacts()).toEqual([]);
  });

  it("taken by someone we know: attached to their contact, no twin made", async () => {
    const s = await scene();
    await invite(s);
    const bob = await peer(2);
    const known = await s.deliver(hello(bob, s.me.identity.did, "hello"), bob);
    const cid = known.outcome === "recorded" ? (known.contact as ContactRecord).cid : "";
    await s.fresh();
    s.log.length = 0;

    const handled = await s.deliver(hello(bob, s.inv.identity.did, "your link"), bob, { to: s.inv.identity.did });

    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "contact.attached", "message.in"]);
    expect(events[2]?.data).toEqual({ myKey: s.inv.key, peerKey: fingerprint(bob, 2), cid, because: "invitation", oobId: "oob-1" });
    expect(handled.outcome === "recorded" && handled.contact?.cid).toBe(cid);
    expect(contactOf(s, cid).attached.map((entry) => [entry.pair.myKey, entry.because])).toEqual([
      [s.me.key, "manual"],
      [s.inv.key, "invitation"],
    ]);
    expect(invitationOf(s)).toMatchObject({ open: false, takenBy: [cid] });
    expect(s.log).toEqual([`${didPlaceholder(bob.did)} took an invitation of ours; that key is ours toward them now`]);
    expect(s.v.fold.contacts()).toHaveLength(1);
  });

  it("taken by someone we know from a new DID, vouched for by the old: the rotation first, then attached to them, no twin", async () => {
    const s = await scene();
    await invite(s);
    const bob = await peer(2);
    const bob2 = await peer(22);
    const known = await s.deliver(hello(bob, s.me.identity.did, "hello"), bob);
    const cid = known.outcome === "recorded" ? (known.contact as ContactRecord).cid : "";
    await s.fresh();
    s.log.length = 0;
    const jwt = await vouched(bob, bob2);
    const to = s.inv.identity.did;

    const handled = await s.deliver(plain(BASIC_MESSAGE, bob2.did, to, { content: "your link, new me" }, { from_prior: jwt }), bob2, { to });

    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "peer.rotated", "contact.attached", "message.in"]);
    expect(events[2]?.data).toMatchObject({ myKey: s.me.key, peerKey: fingerprint(bob, 2), from: bob.did, to: bob2.did });
    expect(events[3]?.data).toEqual({ myKey: s.inv.key, peerKey: fingerprint(bob2, 2), cid, because: "invitation", oobId: "oob-1" });
    expect(handled.outcome === "recorded" && handled.contact?.cid).toBe(cid);
    expect(s.v.fold.attribution({ myKey: s.inv.key, peerKey: fingerprint(bob2, 2) })).toEqual({ kind: "one", cid });
    expect(contactOf(s, cid).currentDids).toEqual([bob2.did]);
    expect(invitationOf(s)).toMatchObject({ open: false, takenBy: [cid] });
    expect(s.v.fold.contacts()).toHaveLength(1);
    expect(s.log).toEqual([
      `${didPlaceholder(bob.did)} moved to ${didPlaceholder(bob2.did)}, vouched for by the old DID`,
      `${didPlaceholder(bob2.did)} took an invitation of ours; that key is ours toward them now`,
    ]);
  });
});

describe("v2 inbound: rotation by from_prior", () => {
  it("a from_prior signed by a DID we know moves the contact: peer.rotated on the old channel, once", async () => {
    const s = await scene();
    const bob = await peer(2);
    const bob2 = await peer(22);
    const known = await s.deliver(hello(bob, s.me.identity.did, "old me"), bob);
    const cid = known.outcome === "recorded" ? (known.contact as ContactRecord).cid : "";
    await s.fresh();
    s.log.length = 0;
    const jwt = await vouched(bob, bob2);

    const moved = await s.deliver(plain(BASIC_MESSAGE, bob2.did, s.me.identity.did, { content: "new me" }, { from_prior: jwt }), bob2);

    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "peer.rotated", "message.in"]);
    const mid = (events[3]?.data as { mid: string }).mid;
    expect(events[2]?.data).toEqual({ myKey: s.me.key, peerKey: fingerprint(bob, 2), from: bob.did, to: bob2.did, fromPrior: jwt, mid });
    expect(moved.outcome === "recorded" && moved.contact?.cid).toBe(cid);
    const contact = contactOf(s, cid);
    expect(contact.currentDids).toEqual([bob2.did]);
    expect(contact.theirDids.map((entry) => [entry.did, entry.current, entry.rotatedTo])).toEqual([
      [bob.did, false, [bob2.did]],
      [bob2.did, true, []],
    ]);
    expect(contact.channels).toHaveLength(2);
    expect(s.log).toEqual([`${didPlaceholder(bob.did)} moved to ${didPlaceholder(bob2.did)}, vouched for by the old DID`]);
    expect(s.handled.at(-1)).toEqual({ mid, cid, type: BASIC_MESSAGE });

    // still carrying the header: joined already, nothing more to note
    await s.deliver(plain(BASIC_MESSAGE, bob2.did, s.me.identity.did, { content: "and again" }, { from_prior: jwt }), bob2);
    expect(types(await s.fresh())).toEqual(["message.in"]);
    expect(s.v.fold.contacts()).toHaveLength(1);
  });

  it("the same key under a moved DID: joined by resolution alone, the rotation still says which is current", async () => {
    const s = await scene();
    const bob = await peer(2);
    const moved = await peer(2, "http://moved/");
    expect(fingerprint(moved, 2)).toBe(fingerprint(bob, 2));
    const known = await s.deliver(hello(bob, s.me.identity.did, "old address"), bob);
    const cid = known.outcome === "recorded" ? (known.contact as ContactRecord).cid : "";
    await s.fresh();
    const jwt = await vouched(bob, moved);

    const handled = await s.deliver(plain(BASIC_MESSAGE, moved.did, s.me.identity.did, { content: "new address" }, { from_prior: jwt }), moved);

    const events = await s.fresh();
    expect(types(events)).toEqual(["peer.resolved", "peer.rotated", "message.in"]);
    expect(events[1]?.data).toMatchObject({ myKey: s.me.key, peerKey: fingerprint(bob, 2), from: bob.did, to: moved.did, fromPrior: jwt });
    expect(handled.outcome === "recorded" && handled.contact?.cid).toBe(cid);
    const contact = contactOf(s, cid);
    expect(contact.currentDids).toEqual([moved.did]);
    expect(contact.channels).toHaveLength(1);
    expect(contact.writeTo).toEqual([{ myKey: s.me.key, peerKey: fingerprint(bob, 2) }]);

    await s.deliver(plain(BASIC_MESSAGE, moved.did, s.me.identity.did, { content: "and again" }, { from_prior: jwt }), moved);
    expect(types(await s.fresh())).toEqual(["message.in"]);
  });

  it("a stranger vouching with a DID never seen: recorded on their own channel, both DIDs theirs", async () => {
    const s = await scene();
    const elsewhere = await peer(6);
    const fresh = await peer(66);
    const jwt = await vouched(elsewhere, fresh);

    const handled = await s.deliver(plain(BASIC_MESSAGE, fresh.did, s.me.identity.did, { content: "we met elsewhere" }, { from_prior: jwt }), fresh);

    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "peer.rotated", "contact.created", "contact.attached", "message.in"]);
    expect(events[2]?.data).toMatchObject({ myKey: s.me.key, peerKey: fingerprint(fresh, 2), from: elsewhere.did, to: fresh.did, fromPrior: jwt });
    const contact = handled.outcome === "recorded" ? (handled.contact as ContactRecord) : null;
    expect(contact?.currentDids).toEqual([fresh.did]);
    expect(contact?.theirDids.map((entry) => entry.did)).toEqual([elsewhere.did, fresh.did]);
  });

  it("a replayed from_prior moves nobody: anonymously it names no sender, under another key didcomm refuses it", async () => {
    const s = await scene();
    const bob = await peer(2);
    const bob2 = await peer(22);
    const mallory = await peer(7);
    await s.deliver(hello(bob, s.me.identity.did, "old me"), bob);
    await s.fresh();
    s.log.length = 0;
    const jwt = await vouched(bob, bob2);
    const claim = plain(BASIC_MESSAGE, bob2.did, s.me.identity.did, { content: "trust me" }, { from_prior: jwt });

    const anonymous = await s.deliver(claim, null);
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "message.in"]);
    expect(anonymous.outcome === "recorded" && anonymous.record.sender).toBeNull();
    expect(s.v.fold.contacts().map((entry) => entry.currentDids)).toEqual([[bob.did]]);
    expect(s.log).toEqual([`recorded an anonymous ${BASIC_MESSAGE}; it is attributed to nobody`]);

    await expect(sealed(claim, s.me.identity.did, mallory)).rejects.toThrow();
    expect(await s.fresh()).toEqual([]);
  });
});

describe("v2 inbound: object-share", () => {
  const files = {
    "index.json": enc.encode(JSON.stringify({ format: "https://estoc.dev/post/1.0", id: "01900000-0000-7000-8000-000000000000", title: "Sea day" })),
    "files/body.md": enc.encode("# Sea day\n\nWaves.\n"),
    "files/images/dot.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]),
  };

  it("a share that verifies has its blocks kept and its root on the skeleton; one that does not is recorded as it came", async () => {
    const s = await scene();
    const bob = await peer(2);
    const { root, blocks } = await closureOf(files);
    const share = { ...plain(OBJECT_SHARE, bob.did, s.me.identity.did, { root }), attachments: attachmentsOf(blocks) } as IMessage;

    const kept = await s.deliver(share, bob);

    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in"]);
    expect(events[4]?.data).toMatchObject({ msgType: OBJECT_SHARE, attachments: [root] });
    expect(events[4]?.blobs).toEqual([(events[4]?.data as { body: string }).body, root]);
    for (const cid of blocks.keys()) {
      expect(await s.v.vault.blobs.has(cid)).toBe(true);
    }
    expect(kept.outcome === "recorded" && kept.record.skeleton.attachments).toEqual([root]);
    expect(s.log).toEqual(["a stranger wrote to us; they have a thread now", `https://estoc.dev/post/1.0 ${root} (unsigned): 3 files kept`]);
    s.log.length = 0;

    const bad = await s.deliver({ ...plain(OBJECT_SHARE, bob.did, s.me.identity.did, {}), attachments: attachmentsOf(blocks) } as IMessage, bob);
    expect(types(await s.fresh())).toEqual(["message.in"]);
    expect(bad.outcome === "recorded" && bad.record.skeleton.attachments).toEqual([]);
    expect(bad.outcome === "recorded" && bad.record.msg?.type).toBe(OBJECT_SHARE);
    expect(s.log).toEqual(["an object-share does not verify; recorded as it came: object-share message has no root"]);
  });
});

describe("v2 inbound: what is answered", () => {
  it("trust-ping: answered for a contact when asked; ignored from a stranger or anonymously, and pinging makes no contact", async () => {
    const s = await scene();
    const bob = await peer(2);
    const carol = await peer(3);
    const me = s.me.identity.did;
    const known = await s.deliver(hello(bob, me, "hello"), bob);
    const cid = known.outcome === "recorded" ? (known.contact as ContactRecord).cid : "";
    await s.fresh();
    s.log.length = 0;

    const ping = plain(TRUST_PING, bob.did, me, { response_requested: true });
    await s.deliver(ping, bob);
    expect(types(await s.fresh())).toEqual(["message.in", "message.out"]);
    expect(s.replies).toEqual([{ to: cid, type: TRUST_PING_RESPONSE, body: {}, options: { thid: ping.id } }]);
    expect(s.log).toEqual([`${didPlaceholder(bob.did)} pinged us`]);
    s.log.length = 0;

    await s.deliver(plain(TRUST_PING, bob.did, me, { response_requested: false }), bob);
    await s.deliver(plain(TRUST_PING_RESPONSE, bob.did, me, {}, { thid: "whatever" }), bob);
    expect(types(await s.fresh())).toEqual(["message.in", "message.in"]);
    expect(s.replies).toHaveLength(1);
    expect(s.log).toEqual([`${didPlaceholder(bob.did)} pinged us`]);
    s.log.length = 0;

    const stranger = await s.deliver(plain(TRUST_PING, carol.did, me, { response_requested: true }), carol);
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved", "message.in"]);
    expect(stranger.outcome === "recorded" && stranger.contact).toBeNull();
    await s.deliver(plain(TRUST_PING, null, me, { response_requested: true }), null);
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "message.in"]);
    expect(s.replies).toHaveLength(1);
    expect(s.log).toEqual(["pinged by someone we do not know; ignoring", `recorded an anonymous ${TRUST_PING}; it is attributed to nobody`]);
    expect(s.v.fold.contacts()).toHaveLength(1);
    expect(s.handled.map((entry) => entry.type)).toEqual([BASIC_MESSAGE]);
  });

  it("handlers: the type's handler gets the record; a type with none is said; one that throws is logged; the profile handler records the claim", async () => {
    const boom: ProtocolHandler = {
      types: ["https://example.com/test/1.0/boom"],
      async onInbound(): Promise<void> {
        throw new Error("boom");
      },
    };
    const s = await scene({ extraHandlers: [boom] });
    const bob = await peer(2);
    const me = s.me.identity.did;

    const named = await s.deliver(plain(PROFILE, bob.did, me, { profile: { displayName: "Bob" }, send_back_yours: false }), bob);
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved", "contact.created", "contact.attached", "message.in", "profile.nameClaimed"]);
    expect(named.outcome === "recorded" && named.contact?.name).toBe(didPlaceholder(bob.did)); // as handed over: the claim lands after
    const cid = named.outcome === "recorded" ? (named.contact as ContactRecord).cid : "";
    expect(contactOf(s, cid).name).toBe("Bob");
    s.log.length = 0;

    const greeted = await s.deliver(plain(HELLO, bob.did, me, { hi: true }), bob);
    expect(s.handled).toEqual([{ mid: greeted.outcome === "recorded" ? greeted.record.mid : "", cid, type: HELLO }]);

    await s.deliver(plain("https://example.com/test/1.0/unknown", bob.did, me, {}), bob);
    await s.deliver(plain("https://example.com/test/1.0/boom", bob.did, me, {}), bob);
    expect(types(await s.fresh())).toEqual(["message.in", "message.in", "message.in"]);
    expect(s.log).toEqual([
      "a https://example.com/test/1.0/unknown from Bob; recorded, no handler for it",
      "handling a https://example.com/test/1.0/boom from Bob failed: boom",
    ]);
  });

  it("with adoption off, a stranger's message is recorded, attributed to nobody and handed to no handler", async () => {
    const s = await scene({ adoptStrangers: false });
    const bob = await peer(2);
    const handled = await s.deliver(hello(bob, s.me.identity.did, "knock"), bob);
    expect(types(await s.fresh())).toEqual(["channel.firstSeen", "peer.resolved", "message.in"]);
    expect(handled.outcome === "recorded" && handled.contact).toBeNull();
    expect(s.handled).toEqual([]);
    expect(s.log).toEqual([`a ${BASIC_MESSAGE} from a stranger; recorded, attributed to nobody until accepted`]);
    expect(s.v.fold.contacts()).toEqual([]);
  });

  it("attribution: several claiming one channel is shown under the first; a deleted contact's channel is nobody's; a mediation key is no contact's", async () => {
    const s = await scene();
    const bob = await peer(2);
    const me = s.me.identity.did;
    const known = await s.deliver(hello(bob, me, "hello"), bob);
    const cid = known.outcome === "recorded" ? (known.contact as ContactRecord).cid : "";
    const pair = { myKey: s.me.key, peerKey: fingerprint(bob, 2) };
    // another device accepted the same stranger while apart
    const twin = "ffffffff-ffff-7fff-8fff-ffffffffffff";
    await record(s.v.vault.events, s.v.fold, drafts.contactCreated({ cid: twin }));
    await record(s.v.vault.events, s.v.fold, drafts.contactAttached({ ...pair, cid: twin, because: "manual" }));
    await s.fresh();
    s.log.length = 0;

    const shown = await s.deliver(hello(bob, me, "which of me"), bob);
    expect(types(await s.fresh())).toEqual(["message.in"]);
    const attribution = s.v.fold.attribution(pair);
    expect(attribution).toEqual({ kind: "several", cids: [cid, twin] });
    expect(shown.outcome === "recorded" && shown.contact?.cid).toBe(cid);
    // in conflict, the channel is neither's alone: both are shown by their cid until merged
    expect(s.log).toEqual([`2 contacts claim one channel; shown under ${didPlaceholder(cid)} until merged`]);
    s.log.length = 0;

    for (const gone of [cid, twin]) {
      await record(s.v.vault.events, s.v.fold, drafts.contactDeleted({ cid: gone }));
    }
    await s.fresh();
    const hidden = await s.deliver(hello(bob, me, "anyone?"), bob);
    expect(types(await s.fresh())).toEqual(["message.in"]);
    expect(hidden.outcome === "recorded" && hidden.contact).toBeNull();
    expect(s.log).toEqual([`a ${BASIC_MESSAGE} from a contact since deleted; recorded, attributed to nobody`]);
    expect(s.handled).toHaveLength(2);
    s.log.length = 0;

    const { me: mediated } = await s.ring.createMediation("did:example:mediator");
    await s.fresh();
    const toMediation = await s.deliver(hello(bob, mediated.identity.did, "wrong door"), bob, { to: mediated.identity.did });
    const events = await s.fresh();
    expect(types(events)).toEqual(["channel.firstSeen", "peer.resolved", "message.in"]);
    expect(events[0]?.data).toMatchObject({ myKey: mediated.key, peerKey: fingerprint(bob, 2) });
    expect(toMediation.outcome === "recorded" && toMediation.contact).toBeNull();
    expect(s.log).toEqual([`a ${BASIC_MESSAGE} sealed to a mediation key of ours; recorded, attributed to nobody`]);
    expect(s.v.fold.contacts()).toEqual([]);
  });
});
