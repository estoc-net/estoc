import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { MemoryBackend, MemoryBlobStore } from "@estoc/event-store";
import { createSeedKeystore } from "@estoc/keystore";
import { drafts, eraseMessage, peerKeyOf, record, recordMessage, type ChannelKey } from "@estoc/vault/v2";

import { createVault, type PeerVault } from "../../src/v2/index.js";
import { contactRecord, didPlaceholder, invitationRecord, messageRecord, nameOf, type PlainMessage } from "../../src/v2/records.js";

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
const PAIR: ChannelKey = { myKey: "did/a", peerKey: bob.fingerprint };

async function fresh(): Promise<PeerVault> {
  const { doc, seedKey } = await createSeedKeystore("test", { seed: SEED });
  return createVault(new MemoryBackend(), { keystore: doc, seedKey, label: "Alice", clock: ticking() });
}

const plain = (id: string, from: string, to: string, content: string): PlainMessage => ({ id, type: BASIC, from, to: [to], body: { content } });

async function message(v: PeerVault, direction: "in" | "out", pair: ChannelKey, mid: string, msg: PlainMessage): Promise<void> {
  await recordMessage({ events: v.vault.events, blobs: v.vault.blobs }, v.fold, direction, enc.encode(JSON.stringify(msg)), { ...pair, mid, wireId: msg.id, msgType: msg.type, attachments: [] });
}

describe("v2 records: messages", () => {
  it("reads the plaintext back, and names the sender by the DID resolved at the time of the message", async () => {
    const v = await fresh();
    await record(v.vault.events, v.fold, drafts.channelFirstSeen({ ...PAIR, peerPublicKey: bob.multibase, kind: "authcrypt", firstDid: BOB1 }));
    await record(v.vault.events, v.fold, drafts.peerResolved({ ...PAIR, did: BOB1, keys: [bob.multibase], service: null }));
    const hi = plain("w1", BOB1, ALICE, "hi");
    await message(v, "in", PAIR, uuid(1), hi);
    // bob rotates: the same key wears a new DID from here on
    await record(v.vault.events, v.fold, drafts.peerResolved({ ...PAIR, did: BOB2, keys: [bob.multibase], service: null }));
    await message(v, "in", PAIR, uuid(2), plain("w2", BOB2, ALICE, "hi again"));
    await message(v, "out", PAIR, uuid(3), plain("w3", ALICE, BOB2, "hello"));

    const first = await messageRecord(v.fold, v.vault.blobs, uuid(1));
    expect(first).not.toBeNull();
    expect(first?.direction).toBe("in");
    expect(first?.pair).toEqual(PAIR);
    expect(first?.sender).toBe(BOB1); // not BOB2: that resolution came after
    expect(first?.msg).toEqual(hi);
    expect(first?.body).toBe("present");
    expect(first?.skeleton.mid).toBe(uuid(1));
    expect(first?.skeleton.wireId).toBe("w1");
    expect(first?.skeleton.bytes).toBe(JSON.stringify(hi).length);
    expect(first?.at).toBe(v.fold.message(uuid(1))?.at);

    const second = await messageRecord(v.fold, v.vault.blobs, uuid(2));
    expect(second?.sender).toBe(BOB2);

    // both DIDs resolved again later, a service found: the messages keep the DIDs they were sent under
    await record(v.vault.events, v.fold, drafts.peerResolved({ ...PAIR, did: BOB1, keys: [bob.multibase], service: "did:peer:2.bobroute" }));
    await record(v.vault.events, v.fold, drafts.peerResolved({ ...PAIR, did: BOB2, keys: [bob.multibase], service: "did:peer:2.bobroute" }));
    expect((await messageRecord(v.fold, v.vault.blobs, uuid(1)))?.sender).toBe(BOB1);
    expect((await messageRecord(v.fold, v.vault.blobs, uuid(2)))?.sender).toBe(BOB2);

    const out = await messageRecord(v.fold, v.vault.blobs, uuid(3));
    expect(out?.direction).toBe("out");
    expect(out?.sender).toBeNull();
    expect(out?.msg?.to).toEqual([BOB2]);

    expect(await messageRecord(v.fold, v.vault.blobs, uuid(4))).toBeNull();
  });

  it("falls back to the DID the key was first seen with, then to nobody", async () => {
    const v = await fresh();
    const seen: ChannelKey = { myKey: "did/a", peerKey: peerKey(8).fingerprint };
    await record(v.vault.events, v.fold, drafts.channelFirstSeen({ ...seen, peerPublicKey: peerKey(8).multibase, kind: "authcrypt", firstDid: BOB1 }));
    await message(v, "in", seen, uuid(1), plain("w1", BOB1, ALICE, "hi"));
    expect((await messageRecord(v.fold, v.vault.blobs, uuid(1)))?.sender).toBe(BOB1);

    const anonymous: ChannelKey = { myKey: "did/a", peerKey: null };
    await record(v.vault.events, v.fold, drafts.channelFirstSeen({ ...anonymous, kind: "anoncrypt" }));
    await message(v, "in", anonymous, uuid(2), plain("w2", "did:example:claimed", ALICE, "psst"));
    const anon = await messageRecord(v.fold, v.vault.blobs, uuid(2));
    expect(anon?.sender).toBeNull(); // the plaintext's `from` is a claim, not the sender
    expect(anon?.msg?.from).toBe("did:example:claimed");

    // a skeleton with no `channel.firstSeen` at all (another device's, say)
    const unseen: ChannelKey = { myKey: "did/a", peerKey: peerKey(9).fingerprint };
    await message(v, "in", unseen, uuid(3), plain("w3", BOB2, ALICE, "hi"));
    expect((await messageRecord(v.fold, v.vault.blobs, uuid(3)))?.sender).toBeNull();
  });

  it("shows an erased body as erased, and a body it cannot read as missing", async () => {
    const v = await fresh();
    await message(v, "in", PAIR, uuid(1), plain("w1", BOB1, ALICE, "gone soon"));
    await eraseMessage(v.vault.events, v.fold, uuid(1), "user");
    const erased = await messageRecord(v.fold, v.vault.blobs, uuid(1));
    expect(erased?.body).toBe("erased");
    expect(erased?.msg).toBeNull();
    expect(erased?.skeleton.msgType).toBe(BASIC); // the skeleton stays

    // a root put in some other store: named, never here
    const elsewhere = await new MemoryBlobStore().put(enc.encode("elsewhere"));
    await record(v.vault.events, v.fold, drafts.messageIn({ ...PAIR, mid: uuid(2), wireId: "w2", msgType: BASIC, bytes: 9, body: elsewhere, attachments: [] }));
    const missing = await messageRecord(v.fold, v.vault.blobs, uuid(2));
    expect(missing?.body).toBe("missing");
    expect(missing?.msg).toBeNull();

    // bytes that are here but are not a plaintext message: not the body the skeleton named
    const junk = await v.vault.blobs.put(enc.encode("not a message"));
    await record(v.vault.events, v.fold, drafts.messageIn({ ...PAIR, mid: uuid(3), wireId: "w3", msgType: BASIC, bytes: 13, body: junk, attachments: [] }));
    const unreadable = await messageRecord(v.fold, v.vault.blobs, uuid(3));
    expect(unreadable?.body).toBe("missing");
    expect(unreadable?.msg).toBeNull();

    // JSON with the required fields but an optional one of the wrong type: not a `PlainMessage` either
    const bent = await v.vault.blobs.put(enc.encode(JSON.stringify({ id: "w4", type: BASIC, body: {}, to: 17, attachments: {}, created_time: "yesterday" })));
    await record(v.vault.events, v.fold, drafts.messageIn({ ...PAIR, mid: uuid(4), wireId: "w4", msgType: BASIC, bytes: 1, body: bent, attachments: [] }));
    const wrong = await messageRecord(v.fold, v.vault.blobs, uuid(4));
    expect(wrong?.body).toBe("missing");
    expect(wrong?.msg).toBeNull();

    // the optional fields as the type says: read
    const full = { id: "w5", typ: "application/didcomm-plain+json", type: BASIC, from: BOB1, to: [ALICE], thid: "t", pthid: "p", created_time: 1, expires_time: 2, body: {}, attachments: [], from_prior: "jwt", extra: null };
    const ok = await v.vault.blobs.put(enc.encode(JSON.stringify(full)));
    await record(v.vault.events, v.fold, drafts.messageIn({ ...PAIR, mid: uuid(5), wireId: "w5", msgType: BASIC, bytes: 1, body: ok, attachments: [] }));
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
    await message(v, "in", PAIR, uuid(1), plain("w1", BOB1, ALICE, "hi"));

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
