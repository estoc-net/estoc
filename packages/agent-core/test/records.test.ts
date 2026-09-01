import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { MemoryBackend, MemoryBlobStore } from "@estoc/event-store";
import { createSeedKeystore } from "@estoc/keystore";
import { drafts, eraseMessage, peerKeyOf, record, recordMessage, type ChannelKey, type InboundSkeleton } from "@estoc/vault/v2";

import { createVault, type PeerVault } from "../src/index.js";
import { contactRecord, didPlaceholder, invitationRecord, messageRecord, nameOf, type PlainMessage } from "../src/records.js";

const enc = new TextEncoder();
const SEED = new Uint8Array(32).map((_, i) => i);
const BASIC = "https://didcomm.org/basicmessage/2.0/message";
const ALICE = "did:peer:4zQmAlice000000000000000000000000000000000";
const BOB1 = "did:peer:4zQmBob1000000000000000000000000000000000000";
const BOB2 = "did:peer:4zQmBob2000000000000000000000000000000000000";

/** every stamp a second after the last: `at` orders what the test appends, whatever the wall clock does */
function ticking(start = "2026-08-31T00:00:00.000Z"): () => Date {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

/** a uuidv7-shaped id from a small number */
const uuid = (n: number): string => `0198c000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** a peer's X25519 public key as a document lists it, and its fingerprint */
function peerKey(seedByte: number): { multibase: string; fingerprint: string } {
  const bytes = new Uint8Array(34).fill(seedByte);
  bytes[0] = 0xec;
  bytes[1] = 0x01;
  const multibase = `z${bs58.encode(bytes)}`;
  return { multibase, fingerprint: peerKeyOf(multibase) };
}

const bob = peerKey(7);
const PAIR = { myKey: "did/a", peerKey: bob.fingerprint };

async function fresh(): Promise<PeerVault> {
  const { doc, seedKey } = await createSeedKeystore("test", { seed: SEED });
  return createVault(new MemoryBackend(), { keystore: doc, seedKey, label: "Alice", clock: ticking() });
}

const plain = (id: string, from: string, to: string, content: string): PlainMessage => ({ id, type: BASIC, from, to: [to], body: { content } });

const side = (v: PeerVault) => ({ events: v.vault.events, blobs: v.vault.blobs });

/** `did` is what the envelope proved (§3.1), the inbound flow's to set: with a peer key, its DID; anonymous, none */
async function inbound(v: PeerVault, pair: ChannelKey, mid: string, msg: PlainMessage, did?: string): Promise<void> {
  const base = { myKey: pair.myKey, mid, wireId: msg.id, msgType: msg.type, attachments: [] };
  const skeleton: InboundSkeleton = pair.peerKey === null ? { ...base, peerKey: null } : { ...base, peerKey: pair.peerKey, did: did as string };
  await recordMessage(side(v), v.fold, "in", enc.encode(JSON.stringify(msg)), skeleton);
}

async function outbound(v: PeerVault, pair: ChannelKey, mid: string, msg: PlainMessage): Promise<void> {
  await recordMessage(side(v), v.fold, "out", enc.encode(JSON.stringify(msg)), { ...pair, mid, wireId: msg.id, msgType: msg.type, attachments: [] });
}

describe("v2 records: messages", () => {
  it("reads the plaintext back, and names the sender by the DID the envelope proved", async () => {
    const v = await fresh();
    await record(v.vault.events, v.fold, drafts.channelFirstSeen({ ...PAIR, peerPublicKey: bob.multibase, kind: "authcrypt", firstDid: BOB1 }));
    await record(v.vault.events, v.fold, drafts.peerResolved({ ...PAIR, did: BOB1, keys: [bob.multibase], service: null }));
    const hi = plain("w1", BOB1, ALICE, "hi");
    await inbound(v, PAIR, uuid(1), hi, BOB1);
    // the same key under a second DID, then under the first again: each message says which
    await record(v.vault.events, v.fold, drafts.peerResolved({ ...PAIR, did: BOB2, keys: [bob.multibase], service: null }));
    await inbound(v, PAIR, uuid(2), plain("w2", BOB2, ALICE, "hi again"), BOB2);
    await inbound(v, PAIR, uuid(3), plain("w3", BOB1, ALICE, "and back"), BOB1); // no new resolution: BOB1's document is as it was
    await outbound(v, PAIR, uuid(4), plain("w4", ALICE, BOB2, "hello"));

    const first = await messageRecord(v.fold, v.vault.blobs, uuid(1));
    expect(first).not.toBeNull();
    expect(first?.direction).toBe("in");
    expect(first?.pair).toEqual(PAIR);
    expect(first?.sender).toBe(BOB1);
    expect(first?.msg).toEqual(hi);
    expect(first?.body).toBe("present");
    expect(first?.skeleton.mid).toBe(uuid(1));
    expect(first?.skeleton.wireId).toBe("w1");
    expect(first?.skeleton.bytes).toBe(JSON.stringify(hi).length);
    expect(first?.at).toBe(v.fold.message(uuid(1))?.at);

    expect((await messageRecord(v.fold, v.vault.blobs, uuid(2)))?.sender).toBe(BOB2);
    expect((await messageRecord(v.fold, v.vault.blobs, uuid(3)))?.sender).toBe(BOB1);

    const out = await messageRecord(v.fold, v.vault.blobs, uuid(4));
    expect(out?.direction).toBe("out");
    expect(out?.sender).toBeNull();
    expect(out?.msg?.to).toEqual([BOB2]);

    expect(await messageRecord(v.fold, v.vault.blobs, uuid(5))).toBeNull();
  });

  it("has no sender for an anonymous envelope, whatever the plaintext claims", async () => {
    const v = await fresh();
    const anonymous: ChannelKey = { myKey: "did/a", peerKey: null };
    await record(v.vault.events, v.fold, drafts.channelFirstSeen({ ...anonymous, kind: "anoncrypt" }));
    await inbound(v, anonymous, uuid(1), plain("w1", "did:example:claimed", ALICE, "psst"));
    const anon = await messageRecord(v.fold, v.vault.blobs, uuid(1));
    expect(anon?.sender).toBeNull(); // the plaintext's `from` is a claim, not the sender
    expect(anon?.msg?.from).toBe("did:example:claimed");

    // a line that pairs the two the wrong way — a key without its DID, or a DID without a key — is malformed: held, not read (§1)
    const skeleton = { mid: uuid(2), wireId: "w2", msgType: BASIC, bytes: 1, attachments: [] as string[], body: await v.vault.blobs.put(enc.encode("{}")) };
    await record(v.vault.events, v.fold, { type: "message.in", blobs: [skeleton.body], data: { ...PAIR, ...skeleton } });
    await record(v.vault.events, v.fold, { type: "message.in", blobs: [skeleton.body], data: { ...anonymous, ...skeleton, mid: uuid(3), did: "did:example:mallory" } });
    expect(v.fold.malformed.map((m) => m.why)).toEqual(["did is present exactly when peerKey is", "did is present exactly when peerKey is"]);
    expect(await messageRecord(v.fold, v.vault.blobs, uuid(2))).toBeNull();
    expect(await messageRecord(v.fold, v.vault.blobs, uuid(3))).toBeNull();
  });

  it("shows an erased body as erased, and a body it cannot read as missing", async () => {
    const v = await fresh();
    await inbound(v, PAIR, uuid(1), plain("w1", BOB1, ALICE, "gone soon"), BOB1);
    await eraseMessage(v.vault.events, v.fold, uuid(1), "user");
    const erased = await messageRecord(v.fold, v.vault.blobs, uuid(1));
    expect(erased?.body).toBe("erased");
    expect(erased?.msg).toBeNull();
    expect(erased?.skeleton.msgType).toBe(BASIC); // the skeleton stays

    // a root put in some other store: named, never here
    const elsewhere = await new MemoryBlobStore().put(enc.encode("elsewhere"));
    await record(v.vault.events, v.fold, drafts.messageIn({ ...PAIR, mid: uuid(2), wireId: "w2", msgType: BASIC, did: BOB1, bytes: 9, body: elsewhere, attachments: [] }));
    const missing = await messageRecord(v.fold, v.vault.blobs, uuid(2));
    expect(missing?.body).toBe("missing");
    expect(missing?.msg).toBeNull();

    // bytes that are here but are not a plaintext message: not the body the skeleton named
    const junk = await v.vault.blobs.put(enc.encode("not a message"));
    await record(v.vault.events, v.fold, drafts.messageIn({ ...PAIR, mid: uuid(3), wireId: "w3", msgType: BASIC, did: BOB1, bytes: 13, body: junk, attachments: [] }));
    const unreadable = await messageRecord(v.fold, v.vault.blobs, uuid(3));
    expect(unreadable?.body).toBe("missing");
    expect(unreadable?.msg).toBeNull();

    // JSON with the required fields but an optional one of the wrong type: not a `PlainMessage` either
    const bent = await v.vault.blobs.put(enc.encode(JSON.stringify({ id: "w4", type: BASIC, body: {}, to: 17, attachments: {}, created_time: "yesterday" })));
    await record(v.vault.events, v.fold, drafts.messageIn({ ...PAIR, mid: uuid(4), wireId: "w4", msgType: BASIC, did: BOB1, bytes: 1, body: bent, attachments: [] }));
    const wrong = await messageRecord(v.fold, v.vault.blobs, uuid(4));
    expect(wrong?.body).toBe("missing");
    expect(wrong?.msg).toBeNull();

    // the optional fields as the type says: read
    const full = { id: "w5", typ: "application/didcomm-plain+json", type: BASIC, from: BOB1, to: [ALICE], thid: "t", pthid: "p", created_time: 1, expires_time: 2, body: {}, attachments: [], from_prior: "jwt", extra: null };
    const ok = await v.vault.blobs.put(enc.encode(JSON.stringify(full)));
    await record(v.vault.events, v.fold, drafts.messageIn({ ...PAIR, mid: uuid(5), wireId: "w5", msgType: BASIC, did: BOB1, bytes: 1, body: ok, attachments: [] }));
    expect((await messageRecord(v.fold, v.vault.blobs, uuid(5)))?.msg).toEqual(full);
  });
});

describe("v2 records: contacts", () => {
  it("is named by the petname, else the claim, else a stand-in for the current DID, else for the cid", async () => {
    const v = await fresh();
    const cid = uuid(10);
    await record(v.vault.events, v.fold, drafts.didMinted({ key: "did/a", did: ALICE, routingDid: null, mediation: null }));
    await record(v.vault.events, v.fold, drafts.contactCreated({ cid }));
    await record(v.vault.events, v.fold, drafts.channelFirstSeen({ ...PAIR, peerPublicKey: bob.multibase, kind: "authcrypt", firstDid: BOB1 }));
    await record(v.vault.events, v.fold, drafts.peerResolved({ ...PAIR, did: BOB1, keys: [bob.multibase], service: null }));
    await record(v.vault.events, v.fold, drafts.contactAttached({ ...PAIR, cid, because: "manual" }));
    await inbound(v, PAIR, uuid(1), plain("w1", BOB1, ALICE, "hi"), BOB1);

    const bare = v.fold.contact(cid);
    expect(bare?.currentDids).toEqual([BOB1]);
    expect(nameOf(bare as NonNullable<typeof bare>)).toBe(didPlaceholder(BOB1));
    expect(didPlaceholder(BOB1)).toBe(`${BOB1.slice(0, 20)}…${BOB1.slice(-6)}`);
    expect(didPlaceholder("did:example:short")).toBe("did:example:short");

    await record(v.vault.events, v.fold, drafts.profileNameClaimed({ ...PAIR, mid: uuid(1), name: "Bob" }));
    expect(nameOf(v.fold.contact(cid) as NonNullable<typeof bare>)).toBe("Bob");

    await record(v.vault.events, v.fold, drafts.contactPetname({ cid, name: "Bobby" }));
    const contact = v.fold.contact(cid) as NonNullable<typeof bare>;
    const rec = contactRecord(contact);
    expect(rec.name).toBe("Bobby");
    expect(rec.claimedName).toBe("Bob");
    expect(rec.cid).toBe(cid);
    expect(rec.channels).toEqual([PAIR]);
    expect(rec.attached.map((a) => a.because)).toEqual(["manual"]);
    expect(rec).not.toHaveProperty("thread");
    expect(contact.thread.map((m) => m.mid)).toEqual([uuid(1)]); // still on the fold's contact

    // a contact nothing has reached yet: the cid stands in
    const lonely = uuid(11);
    await record(v.vault.events, v.fold, drafts.contactCreated({ cid: lonely }));
    expect(contactRecord(v.fold.contact(lonely) as NonNullable<typeof bare>).name).toBe(didPlaceholder(lonely));
  });
});

describe("v2 records: invitations", () => {
  it("carries the oob id, this device's registration, and retirement", async () => {
    const v = await fresh();
    await record(v.vault.events, v.fold, drafts.didMinted({ key: "did/inv", did: BOB2, routingDid: "did:peer:2.route", mediation: uuid(99) }));
    await record(v.vault.events, v.fold, drafts.didPublished({ key: "did/inv", as: "oob", uses: "one", oobId: "oob-1", goal: "to chat" }));

    const pending = invitationRecord(v.fold, v.fold.invitations()[0] as NonNullable<ReturnType<typeof v.fold.invitations>[0]>);
    expect(pending).toMatchObject({ id: "oob-1", key: "did/inv", did: BOB2, goal: "to chat", open: true, takenBy: [], registered: false, retired: false });

    await record(v.vault.events, v.fold, drafts.didRegistered({ key: "did/inv" }));
    expect(invitationRecord(v.fold, v.fold.invitations()[0] as typeof pending).registered).toBe(true);

    await record(v.vault.events, v.fold, drafts.didRetired({ key: "did/inv", because: "expired" }));
    const retired = invitationRecord(v.fold, v.fold.invitations()[0] as typeof pending);
    expect(retired.retired).toBe(true);
    expect(retired.open).toBe(false);

    // a one-use publish with no oob id: the key's name is the id
    await record(v.vault.events, v.fold, drafts.didPublished({ key: "did/other", as: "oob", uses: "one" }));
    expect(invitationRecord(v.fold, v.fold.invitations()[1] as typeof pending).id).toBe("did/other");
  });
});
