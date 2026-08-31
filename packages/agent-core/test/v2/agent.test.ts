import { describe, expect, it } from "vitest";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { KEYSTORE_FILE } from "@estoc/event-store";
import { drafts, record as recordEvent, type ChannelKey, type Contact } from "@estoc/vault/v2";

import { BASIC_MESSAGE, FORWARD, OOB_INVITATION, PLAIN_TYP, PROFILE } from "../../src/index.js";
import { invitationUrl, nameOf, openVault, parseInvitation, type InvitationRecord, type MessageRecord } from "../../src/v2/index.js";
import { network, type FakeMediator, type FakeSocket } from "../fake-mediator.js";
import {
  attach,
  contactByDid,
  history,
  keyWearing,
  myDidToward,
  newMediator,
  newParty,
  newVault,
  recordsOf,
  reopen,
  undelivered,
  until,
  withTimeout,
} from "./fixture.js";

describe("v2 agent through a mediator", () => {
  it("mediates, exchanges basic messages and profiles", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 1, mediator);
    const bob = await newParty("Bob", 2, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]), 8000, "both live");

    // Mediation minted a public DID on the mediator's routing DID and
    // registered it; the fold and the keystore cache agree.
    expect(alice.agent.did).toMatch(/^did:peer:4/);
    const mediation = alice.v.fold.device(alice.v.vault.self)?.mediation;
    expect(mediation?.routingDid).toBe(mediator.did);
    expect(mediation?.me.key).toMatch(/^mediation\/.*\/me$/);
    expect(alice.v.keys.keystore.keys.map((k) => k.name)).toContain(mediation?.me.key);
    expect(alice.v.keys.keystore.keys.map((k) => k.name)).toContain(keyWearing(alice, alice.agent.did as string));
    expect(mediator.recipients.get(alice.agent.did as string)).toBe(mediation?.me.did);
    const aliceDoc = await resolveDIDCommDoc(alice.agent.did as string);
    expect(aliceDoc?.service[0]?.serviceEndpoint).toMatchObject({ uri: mediator.did });

    // Alice names Bob and writes; the intro (user-profile) rides ahead.
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    const sent = await alice.agent.sendBasicMessage(bob.agent.did as string, "hello bob");
    expect(sent.msg?.type).toBe(BASIC_MESSAGE);
    expect(sent.direction).toBe("out");

    // Bob receives it live — from a DID Alice minted for him alone, not
    // her public one, which she keeps for strangers.
    const got = await withTimeout(bob.next((v) => v.kind === "chat" && v.content === "hello bob"), 8000, "bob's chat");
    expect(got.direction).toBe("received");
    const aliceToBob = myDidToward(alice, bob.agent.did as string);
    expect(aliceToBob).toMatch(/^did:peer:4/);
    expect(aliceToBob).not.toBe(alice.agent.did);
    expect(got.contactDid).toBe(aliceToBob);
    // that DID is registered with the mediator under Alice's account, and
    // resolves to a service on the mediator like her public one
    expect(mediator.recipients.get(aliceToBob)).toBe(mediation?.me.did);
    expect((await resolveDIDCommDoc(aliceToBob))?.service[0]?.serviceEndpoint).toMatchObject({ uri: mediator.did });
    const alicesBob = contactByDid(alice, bob.agent.did as string) as Contact;
    expect(alicesBob.keys).toHaveLength(1);
    expect(alicesBob.keys[0]).toMatchObject({ key: expect.stringMatching(/^did\//), because: "minted", implicit: false });
    expect(alice.v.fold.myKey(alicesBob.keys[0]?.key as string)?.registered).toContain(alice.v.vault.self);
    // Bob's copy of the thread is homed to his contact for Alice
    expect(got.contactCid).toBeDefined();

    // The stranger contact was created and then took Alice's claimed name;
    // send_back_yours made Bob introduce himself in return. Alice's first
    // message vouched for its fresh DID with her public one (from_prior),
    // so Bob's record for her opens with the public DID, rotated away —
    // pasting her business card later finds this contact, not a twin.
    const bobsAlice = contactByDid(bob, aliceToBob) as Contact;
    expect(bobsAlice.cid).toBe(got.contactCid);
    expect(bobsAlice.theirDids.map((u) => u.did)).toEqual([alice.agent.did, aliceToBob]);
    expect(bobsAlice.theirDids[0]?.rotatedTo).toEqual([aliceToBob]);
    expect(bobsAlice.currentDids).toEqual([aliceToBob]);
    const vouched = bob.v.fold.channels().flatMap((channel) => channel.rotated).find((r) => r.from === alice.agent.did);
    expect(vouched?.to).toBe(aliceToBob);
    expect(vouched?.fromPrior).toMatch(/^eyJ/);
    expect(contactByDid(bob, alice.agent.did as string)?.cid).toBe(bobsAlice.cid);
    expect(bobsAlice.petname).toBeNull();
    expect(bobsAlice.claimedName).toBe("Alice");
    expect(nameOf(bobsAlice)).toBe("Alice");
    expect(bobsAlice.profileSharedAt).not.toBeNull();
    // Alice wrote to Bob's public DID, and the fold says so
    expect(bob.v.fold.myKey(bobsAlice.addressedAs as string)?.minted?.did).toBe(bob.agent.did);
    const bobsIntro = await withTimeout(alice.next((v) => v.kind === "profile" && v.direction === "received"), 8000, "bob's intro");
    expect(bobsIntro.content).toBe("Bob");

    // Bob's introduction came from a DID of his own toward Alice, with a
    // from_prior signed by the public DID she wrote to — so on Alice's
    // side Bob rotated: the public DID closed, the pairwise one current,
    // the JWT kept as evidence.
    const bobToAlice = myDidToward(bob, aliceToBob);
    expect(bobToAlice).not.toBe(bob.agent.did);
    expect((contactByDid(bob, aliceToBob) as Contact).keys.map((u) => u.key)).toEqual([expect.stringMatching(/^did\//)]);
    const alicesBobNow = contactByDid(alice, bob.agent.did as string) as Contact;
    expect(alicesBobNow.theirDids.map((u) => u.did)).toEqual([bob.agent.did, bobToAlice]);
    expect(alicesBobNow.currentDids).toEqual([bobToAlice]);
    expect(bobsIntro.contactDid).toBe(bobToAlice);
    expect(bobsIntro.contactCid).toBe(alicesBobNow.cid);
    // Alice typed "Bob" herself, so the claim is remembered but does not rename.
    expect(alicesBobNow.petname).toBe("Bob");
    expect(alicesBobNow.claimedName).toBe("Bob");
    expect(nameOf(alicesBobNow)).toBe("Bob");
    const bobsFirstOut = (await recordsOf(bob)).find((r) => r.direction === "out") as MessageRecord;
    expect(bobsFirstOut.msg?.from).toBe(bobToAlice);
    const aliceSawRotation = alice.v.fold.channels().flatMap((channel) => channel.rotated).find((r) => r.from === bob.agent.did);
    expect(bobsFirstOut.msg?.from_prior).toBe(aliceSawRotation?.fromPrior);

    // Bob replies; Alice receives. Alice has not written to Bob's new DID
    // yet, so the reply still carries from_prior.
    await bob.agent.sendBasicMessage(aliceToBob, "hi alice");
    const reply = await withTimeout(alice.next((v) => v.content === "hi alice"), 8000, "alice's reply");
    expect(reply.direction).toBe("received");
    expect(reply.contactCid).toBe(alicesBobNow.cid);
    const bobsChatOut = (await recordsOf(bob)).find((r) => r.direction === "out" && r.msg?.type === BASIC_MESSAGE);
    expect(bobsChatOut?.msg?.from_prior).toBeDefined();

    // Alice's next message goes to Bob's new DID; once Bob has seen that,
    // his messages stop carrying from_prior.
    await alice.agent.sendBasicMessage(bobToAlice, "seen you move");
    await withTimeout(bob.next((v) => v.content === "seen you move"));
    expect(bob.v.fold.myKey((contactByDid(bob, aliceToBob) as Contact).addressedAs as string)?.minted?.did).toBe(bobToAlice);
    await bob.agent.sendBasicMessage(aliceToBob, "good");
    await withTimeout(alice.next((v) => v.content === "good"));
    const bobsLastOut = (await recordsOf(bob)).filter((r) => r.direction === "out").at(-1);
    expect(bobsLastOut?.msg?.from_prior).toBeUndefined();
    // and Alice's thread with Bob is one thread, across his two DIDs
    const aliceHistory = await history(alice);
    expect(aliceHistory.every((v) => v.contactCid === alicesBobNow.cid)).toBe(true);
    expect(aliceHistory.filter((v) => v.kind === "chat").map((v) => v.content)).toEqual(["hello bob", "hi alice", "seen you move", "good"]);

    // The log holds the facts: Alice sent profile+chat, got profile+chat, and so on.
    const aliceLog = await recordsOf(alice);
    expect(aliceLog.map((r) => `${r.direction}:${r.msg?.type === PROFILE ? "profile" : "chat"}`)).toEqual([
      "out:profile",
      "out:chat",
      "in:profile",
      "in:chat",
      "out:chat",
      "in:chat",
    ]);
    // inbound records carry the envelope-proven sender: Bob's pairwise DID throughout
    expect(aliceLog.filter((r) => r.direction === "in").every((r) => r.sender === bobToAlice)).toBe(true);
    // and everything Alice sent went out from her DID toward Bob — the first
    // two vouched for by the public DID, the last not (Bob had written to it)
    expect(aliceLog.filter((r) => r.direction === "out").every((r) => r.msg?.from === aliceToBob)).toBe(true);
    expect(aliceLog.filter((r) => r.direction === "out").map((r) => r.msg?.from_prior !== undefined)).toEqual([true, true, false]);
    // Every message went out with the wire fields the spec wants.
    expect(aliceLog[1]?.msg).toMatchObject({ type: BASIC_MESSAGE, typ: "application/didcomm-plain+json" });
    expect(typeof aliceLog[1]?.msg?.created_time).toBe("number");

    // Everything gets acked (the ack rides after the event), so the
    // mediator ends up holding nothing.
    await withTimeout(until(() => [...mediator.queues.values()].every((q) => q.length === 0)), 8000, "acks");

    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("survives a reload: history comes back, nothing is redelivered twice", async () => {
    const mediator = await newMediator();
    let alice = await newParty("Alice", 3, mediator);
    let bob = await newParty("Bob", 4, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "one");
    await withTimeout(bob.next((v) => v.content === "one"));

    // Bob goes away; Alice keeps writing; the mediator queues it.
    const bobDid = bob.agent.did as string;
    const bobsAccount = bob.v.fold.device(bob.v.vault.self)?.mediation?.me.did as string;
    bob.agent.destroy();
    await alice.agent.sendBasicMessage(bobDid, "two");
    expect(mediator.queues.get(bobsAccount)).toHaveLength(1);

    // Bob comes back from bytes alone: same DID, old history, and the
    // queued message drains on start.
    bob = await reopen(bob, mediator);
    await bob.agent.start();
    await withTimeout(bob.live);
    expect(bob.agent.did).toBe(bobDid);
    const replayed = await history(bob);
    expect(replayed.filter((v) => v.kind === "chat").map((v) => v.content)).toEqual(["one", "two"]);
    expect(replayed.filter((v) => v.content === "one")).toHaveLength(1);
    // the reopened agent did not re-request mediation
    expect(mediator.seenTypes.filter((t) => t.endsWith("mediate-request"))).toHaveLength(2);

    alice.agent.destroy();
    bob.agent.destroy();
    alice = await reopen(alice, mediator);
    await alice.agent.start();
    await withTimeout(alice.live);
    expect((await history(alice)).map((v) => v.content)).toEqual(["Alice", "one", "Bob", "two"]);
    alice.agent.destroy();
  });

  it("heals a keystore cache that lost a key: the name is the derivation path, nothing is lost", async () => {
    const mediator = await newMediator();
    let carol = await newParty("Carol", 5, mediator);
    await carol.agent.start();
    await withTimeout(carol.live);
    const pub = carol.agent.did as string;
    const pubKey = keyWearing(carol, pub);
    expect(pubKey).toMatch(/^did\//);
    expect(carol.v.keys.keystore.keys.map((k) => k.name)).toContain(pubKey);
    carol.agent.destroy();

    // The crash: the log names the key, the keystore's cache never heard
    // of it. The name is the derivation path, so nothing is lost.
    const bytes = (await carol.v.vault.files.read(KEYSTORE_FILE)) as Uint8Array;
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as { keys: { name: string }[] };
    doc.keys = doc.keys.filter((k) => k.name !== pubKey);
    await carol.v.vault.files.write(KEYSTORE_FILE, new TextEncoder().encode(JSON.stringify(doc)));

    carol = await reopen(carol, mediator);
    await carol.agent.start();
    await withTimeout(carol.live);
    expect(carol.agent.did).toBe(pub);
    // and the mediator did not have to be asked again
    expect(mediator.seenTypes.filter((t) => t.endsWith("mediate-request"))).toHaveLength(1);
    carol.agent.destroy();
  });

  it("starts unmediated without a mediator, and goes live once one is chosen", async () => {
    const mediator = await newMediator();
    const carol = await newParty("Carol", 7, mediator, { mediated: false });
    const bob = await newParty("Bob", 2, mediator);
    await Promise.all([carol.agent.start(), bob.agent.start()]);
    await withTimeout(bob.live, 8000, "bob live");

    // an identity, not yet reachable: no public DID, nothing sent
    expect(carol.agent.status).toEqual({ state: "unmediated" });
    expect(carol.agent.did).toBeNull();
    await carol.agent.addContact(bob.agent.did as string, "Bob");
    await expect(carol.agent.sendBasicMessage(bob.agent.did as string, "hi")).rejects.toThrow(/no mediation granted yet/);

    // the mediator is chosen after the fact; mediation runs to live
    await carol.agent.setMediator(mediator.did);
    await withTimeout(carol.live, 8000, "carol live");
    expect(carol.agent.did).toMatch(/^did:peer:4/);
    expect(carol.v.fold.device(carol.v.vault.self)?.mediation?.mediatorDid).toBe(mediator.did);
    await carol.agent.sendBasicMessage(bob.agent.did as string, "hi from carol");
    const got = await withTimeout(bob.next((v) => v.content === "hi from carol"), 8000, "bob's chat");
    expect(got.contactDid).toBe(myDidToward(carol, bob.agent.did as string));

    // and it stays that way across a reload
    const again = await reopen(carol, mediator);
    await again.agent.start();
    await withTimeout(again.live, 8000, "carol live again");
    expect(again.agent.did).toBe(carol.agent.did);
    again.agent.destroy();
    bob.agent.destroy();
  });

  it("registers a DID minted while the mediator was unreachable as soon as it can", async () => {
    const mediator = await newMediator();
    const bob = await newParty("Bob", 8, mediator);
    // Carol's line to the mediator can be cut and restored.
    const line = { cut: false };
    const flaky: typeof fetch = (input, init) => {
      if (line.cut) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return mediator.fetch(input, init);
    };
    const carol = await newParty("Carol", 9, mediator, { fetch: flaky });
    await Promise.all([carol.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([carol.live, bob.live]));

    line.cut = true;
    await carol.agent.addContact(bob.agent.did as string, "Bob");
    const voided = await undelivered(carol, carol.agent.sendBasicMessage(bob.agent.did as string, "into the void"), /fetch failed/);
    // the key was minted and recorded, but the mediator never heard of it
    const record = contactByDid(carol, bob.agent.did as string) as Contact;
    expect(record.keys).toHaveLength(1);
    const use = record.keys[0];
    expect(use?.key).toMatch(/^did\//);
    const key = carol.v.fold.myKey(use?.key as string);
    expect(key?.registered).toEqual([]);
    expect(mediator.recipients.has(key?.minted?.did as string)).toBe(false);
    // the message is a fact in the log — written, not delivered: the
    // introduction and the message itself both wait in the outbox
    const outbound = (await recordsOf(carol)).filter((r) => r.direction === "out");
    expect(outbound.map((r) => r.msg?.type)).toEqual([PROFILE, BASIC_MESSAGE]);
    // the introduction failed first — tried again ahead of the message, and
    // failed again — and the message was not even tried behind it
    expect(carol.deliveries.filter((e) => e.mid === outbound[0]?.mid).map((e) => e.status)).toEqual(["failed", "failed"]);
    expect(carol.v.fold.delivery(voided.mid)?.status).toBe("pending");
    expect(carol.v.fold.delivery(voided.mid)?.attempts).toEqual([]);

    // the line comes back: the next send registers the same key first, then
    // sends what waited, in order, then the new message
    line.cut = false;
    await carol.agent.sendBasicMessage(bob.agent.did as string, "hello from carol");
    await withTimeout(bob.next((v) => v.content === "hello from carol"));
    expect(bob.messages.filter((m) => m.view.kind === "chat").map((m) => m.view.content)).toEqual(["into the void", "hello from carol"]);
    expect(carol.v.fold.delivery(voided.mid)?.status).toBe("sent");
    const after = contactByDid(carol, bob.agent.did as string) as Contact;
    expect(after.keys).toHaveLength(1);
    expect(after.keys[0]?.key).toBe(use?.key);
    expect(carol.v.fold.myKey(use?.key as string)?.registered).toContain(carol.v.vault.self);
    const carolsAccount = carol.v.fold.device(carol.v.vault.self)?.mediation?.me.did;
    expect(mediator.recipients.get(key?.minted?.did as string)).toBe(carolsAccount);
    // and Bob can answer to it
    await bob.agent.sendBasicMessage(key?.minted?.did as string, "hi carol");
    await withTimeout(carol.next((v) => v.content === "hi carol"));

    // a start with unregistered keys on record registers them before
    // pickup, and sends what waited in the outbox
    const dan = await newParty("Dan", 10, mediator);
    await dan.agent.start();
    await withTimeout(dan.live);
    line.cut = true;
    await carol.agent.addContact(dan.agent.did as string, "Dan");
    const parked = await undelivered(carol, carol.agent.sendBasicMessage(dan.agent.did as string, "x"));
    const carolToDan = myDidToward(carol, dan.agent.did as string);
    expect(mediator.recipients.has(carolToDan)).toBe(false);
    line.cut = false;
    const again = await reopen(carol, mediator);
    await again.agent.start();
    await withTimeout(again.live);
    expect(again.log).toContain("registering 1 DID(s) with the mediator");
    expect(mediator.recipients.get(carolToDan)).toBe(carolsAccount);
    expect(again.v.fold.myKey(keyWearing(again, carolToDan))?.registered).toContain(again.v.vault.self);
    await withTimeout(dan.next((v) => v.content === "x"));
    expect(again.v.fold.delivery(parked.mid)?.status).toBe("sent");
    // the reload changed nothing about the record itself: same id on the wire
    expect(dan.messages.find((m) => m.view.content === "x")?.record.msg?.id).toBe(parked.msg?.id);

    again.agent.destroy();
    bob.agent.destroy();
    dan.agent.destroy();
  });

  it("forgets a contact together with the DIDs minted toward them", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 21, mediator);
    const bob = await newParty("Bob", 22, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "hello");
    await withTimeout(bob.next((v) => v.content === "hello"));
    const aliceToBob = myDidToward(alice, bob.agent.did as string);
    expect(mediator.recipients.has(aliceToBob)).toBe(true);
    const keyName = keyWearing(alice, aliceToBob);

    const record = contactByDid(alice, bob.agent.did as string) as Contact;
    await alice.agent.removeContact(record.cid);
    expect(alice.v.fold.contact(record.cid)).toBeNull();
    expect(alice.v.fold.deletedContacts().some((entry) => entry.cid === record.cid)).toBe(true);
    // the mediator no longer accepts mail for that DID; the key stays on
    // record and in the keystore cache, retired — a name is never reused
    expect(mediator.recipients.has(aliceToBob)).toBe(false);
    expect(alice.v.fold.myKey(keyName)?.retired).toMatchObject({ because: "contact-deleted" });
    expect(alice.v.keys.keystore.keys.some((k) => k.name === keyName)).toBe(true);
    // Bob writing to it now bounces at the mediator
    await undelivered(bob, bob.agent.sendBasicMessage(aliceToBob, "anyone there?"));
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("meets through a single-use invitation: both minted, nothing public exchanged, second taker turned away", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 31, mediator);
    const bob = await newParty("Bob", 32, mediator);
    const carol = await newParty("Carol", 33, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start(), carol.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live, carol.live]));

    // Alice issues an invitation: a DID minted for nobody yet, registered
    // with her mediator, and a URL any Estoc client can read `_oob` from
    const issued = await alice.agent.createInvitation();
    expect(issued.key).toMatch(/^did\//);
    expect(issued.did).toMatch(/^did:peer:4/);
    expect(issued.did).not.toBe(alice.agent.did);
    expect(issued.registered).toBe(true);
    expect(issued.open).toBe(true);
    expect(issued.takenBy).toEqual([]);
    expect(issued.goal).toBe("Write to Alice");
    const account = alice.v.fold.device(alice.v.vault.self)?.mediation?.me.did;
    expect(mediator.recipients.get(issued.did as string)).toBe(account);
    expect(alice.invitations.map((i) => i.id)).toEqual([issued.id]);
    const url = invitationUrl("https://app.example/", alice.agent.invitationMessage(issued));
    expect(new URL(url).origin).toBe("https://app.example");
    const message = parseInvitation(url);
    expect(message).toMatchObject({ id: issued.id, from: issued.did, body: { goal_code: "connect", goal: "Write to Alice" } });
    // the bare parameter and the plaintext read the same
    expect(parseInvitation(new URL(url).searchParams.get("_oob") as string)).toEqual(message);
    expect(parseInvitation(JSON.stringify(message))).toEqual(message);
    // her own invitation is refused on her side
    await expect(alice.agent.acceptInvitation(url, "me?")).rejects.toThrow(/of your own/);

    // Bob accepts it under a petname: Alice's record for him appears on
    // her side at once, because his introduction goes out with the acceptance
    const bobsAlice = await bob.agent.acceptInvitation(url, "Alice");
    expect(bobsAlice.name).toBe("Alice");
    expect(bobsAlice.attached.find((a) => a.because === "accepted")?.oobId).toBe(issued.id);
    expect(bobsAlice.currentDids).toEqual([issued.did]);
    expect(bobsAlice.profileSharedAt).not.toBeNull();
    const bobToAlice = myDidToward(bob, issued.did as string);
    expect(bobToAlice).toMatch(/^did:peer:4/);
    expect(bobToAlice).not.toBe(bob.agent.did);

    const intro = await withTimeout(alice.next((v) => v.kind === "profile" && v.direction === "received"), 8000, "bob's intro");
    expect(intro.contactDid).toBe(bobToAlice);
    // the introduction answered the invitation the out-of-band way — pthid —
    // and vouched for nothing: neither side ever named a public DID
    const introRecord = alice.messages.find((m) => m.view.id === intro.id)?.record;
    expect(introRecord?.msg?.pthid).toBe(issued.id);
    expect(introRecord?.msg?.from_prior).toBeUndefined();

    // Alice's side: the invitation is taken by Bob's new contact record,
    // whose DID of hers is the invitation's — on the key it was published on
    await until(() => alice.agent.invitations().some((i) => i.id === issued.id && !i.open));
    const taken = alice.agent.invitations().find((i) => i.id === issued.id) as InvitationRecord;
    const alicesBob = contactByDid(alice, bobToAlice) as Contact;
    expect(taken.takenBy).toEqual([alicesBob.cid]);
    expect(alicesBob.theirDids.map((u) => u.did)).toEqual([bobToAlice]);
    expect(alicesBob.keys).toHaveLength(1);
    expect(alicesBob.keys[0]).toMatchObject({ key: issued.key, because: "invitation", implicit: true });
    expect(alice.v.fold.myKey(issued.key)?.minted?.did).toBe(issued.did);
    expect(alice.v.fold.myKey(issued.key)?.registered).toContain(alice.v.vault.self);
    expect(alicesBob.addressedAs).toBe(issued.key); // the key they last wrote to is the invitation's
    expect(nameOf(alicesBob)).toBe("Bob"); // his claimed name, the record was a placeholder

    // A conversation follows, from those two DIDs, with no from_prior anywhere
    await alice.agent.sendBasicMessage(bobToAlice, "you found me");
    const gotByBob = await withTimeout(bob.next((v) => v.content === "you found me"));
    expect(gotByBob.contactDid).toBe(issued.did);
    expect(gotByBob.contactCid).toBe(bobsAlice.cid);
    await bob.agent.sendBasicMessage(issued.did as string, "and you me");
    const gotByAlice = await withTimeout(alice.next((v) => v.content === "and you me"));
    expect(gotByAlice.contactCid).toBe(alicesBob.cid);
    for (const party of [alice, bob]) {
      for (const { record } of party.messages) {
        expect(record.msg?.from_prior).toBeUndefined();
      }
    }
    expect((contactByDid(alice, bobToAlice) as Contact).keys).toHaveLength(1);
    expect(alice.messages.filter((m) => m.view.contactCid === alicesBob.cid).length).toBeGreaterThanOrEqual(3);

    // Carol got hold of the same URL: single-use, she is turned away — her
    // message recorded as any fact is, homed to no contact, none made for her
    await carol.agent.acceptInvitation(url, "Alice?");
    const turnedAway = await withTimeout(alice.next((v) => v.direction === "received" && v.contactCid === undefined), 8000, "carol turned away");
    expect(turnedAway.kind).toBe("profile");
    expect(alice.log.some((l) => l.includes("already taken"))).toBe(true);
    expect(alice.v.fold.contacts()).toHaveLength(1);

    // A restart re-derives the invitation's DID from the contact record
    const alice2 = await reopen(alice, mediator);
    await alice2.agent.start();
    await withTimeout(alice2.live);
    await bob.agent.sendBasicMessage(issued.did as string, "still there?");
    await withTimeout(alice2.next((v) => v.content === "still there?"));

    // Revoking: only open ones; a second invitation, withdrawn, is gone from
    // the mediator — and stays on record, retired: no event is ever removed
    await expect(alice2.agent.revokeInvitation(issued.id)).rejects.toThrow(/taken/);
    const second = await alice2.agent.createInvitation("Come talk");
    expect(second.goal).toBe("Come talk");
    expect(mediator.recipients.has(second.did as string)).toBe(true);
    await alice2.agent.revokeInvitation(second.id);
    expect(mediator.recipients.has(second.did as string)).toBe(false);
    const revoked = alice2.agent.invitations().find((i) => i.id === second.id) as InvitationRecord;
    expect(revoked.retired).toBe(true);
    expect(revoked.open).toBe(false);
    expect(alice2.agent.invitations().map((i) => i.id)).toEqual([issued.id, second.id]);
    expect(alice2.agent.invitations().filter((i) => i.open)).toEqual([]);
    await expect(carol.agent.acceptInvitation(
      invitationUrl("https://app.example/", alice2.agent.invitationMessage(second)), "Alice"
    )).resolves.toBeDefined();
    // Carol's answer to the revoked one bounces at the mediator; her side keeps the contact, the answer waits in her outbox
    expect(carol.log.some((l) => l.startsWith("could not deliver user-profile/1.0/profile"))).toBe(true);

    // a mediator's own invitation is not a person's
    const mediatorOob = { type: OOB_INVITATION, id: "m", typ: PLAIN_TYP, from: mediator.did, body: { goal_code: "request-mediate" } };
    await expect(bob.agent.acceptInvitation(JSON.stringify(mediatorOob), "Med")).rejects.toThrow(/mediator's invitation/);

    alice2.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
  });

  it("registers an invitation issued while the mediator was unreachable at the next start", async () => {
    const mediator = await newMediator();
    const line = { cut: false };
    const flaky: typeof fetch = (input, init) => {
      if (line.cut) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return mediator.fetch(input, init);
    };
    const dana = await newParty("Dana", 34, mediator, { fetch: flaky });
    await dana.agent.start();
    await withTimeout(dana.live);
    line.cut = true;
    await expect(dana.agent.createInvitation()).rejects.toThrow();
    // the record is there, unregistered — the URL is not usable yet
    const [pending] = dana.agent.invitations();
    expect(pending?.did).toMatch(/^did:peer:4/);
    expect(pending?.registered).toBe(false);
    expect(mediator.recipients.has(pending?.did as string)).toBe(false);
    line.cut = false;
    const dana2 = await reopen(dana, { fetch: flaky, WebSocket: mediator.WebSocket });
    await dana2.agent.start();
    await withTimeout(dana2.live);
    expect(dana2.log).toContain("registering 1 DID(s) with the mediator");
    expect(dana2.agent.invitations().find((i) => i.id === pending?.id)?.registered).toBe(true);
    expect(mediator.recipients.get(pending?.did as string)).toBe(dana2.v.fold.device(dana2.v.vault.self)?.mediation?.me.did);
    dana2.agent.destroy();
  });

  it("reports an error status when the mediator does not resolve", async () => {
    const mediator = await newMediator();
    const { backend, v, seedKey, clock } = await newVault("Dan", 6, "did:web:nowhere.invalid");
    const dan = attach("Dan", backend, v, seedKey, clock, mediator);
    await dan.agent.start();
    expect(dan.agent.status).toEqual({ state: "error", detail: "mediator DID does not resolve" });
    await expect(dan.agent.sendBasicMessage("did:peer:4x", "x")).rejects.toThrow(/nothing to write from/);
    dan.agent.destroy();
  });

  it("comes up by itself once a mediator it could not reach at start is back", async () => {
    const mediator = await newMediator();
    const line = { down: true };
    const flaky: typeof fetch = (input, init) =>
      line.down ? Promise.reject(new TypeError("fetch failed")) : mediator.fetch(input, init);
    const eve = await newParty("Eve", 35, mediator, { fetch: flaky });
    await eve.agent.start();
    expect(eve.agent.status.state).toBe("error");
    // the retries keep failing while it is down: back to error every time, never live…
    await new Promise((r) => setTimeout(r, 60));
    await until(() => eve.agent.status.state === "error");
    expect(eve.statuses.every((status) => status.state !== "live")).toBe(true);
    // …and the next one after it is back brings the agent up, no start() from outside
    line.down = false;
    await withTimeout(eve.live);
    expect(eve.agent.did?.startsWith("did:peer:4")).toBe(true);
    eve.agent.destroy();
  });
});

/** A WebSocket that keeps every socket it opened, for counting and closing checks. */
function watching(sockets: FakeSocket[], over: Pick<FakeMediator, "WebSocket">): typeof WebSocket {
  return class extends over.WebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this as unknown as FakeSocket);
    }
  } as typeof WebSocket;
}

describe("v2 agent hardened", () => {
  it("runs one start at a time: mediation is asked for once, and a later start replaces the socket instead of leaking it", async () => {
    const mediator = await newMediator();
    const sockets: FakeSocket[] = [];
    const alice = await newParty("Alice", 11, mediator, { webSocket: watching(sockets, mediator) });

    await Promise.all([alice.agent.start(), alice.agent.start()]);
    await withTimeout(alice.live);

    expect(mediator.seenTypes.filter((t) => t.endsWith("mediate-request"))).toHaveLength(1);
    expect(alice.v.fold.myKeys().filter((key) => key.published.some((p) => p.as === "profile"))).toHaveLength(1);
    expect(sockets).toHaveLength(1);

    // a later start brings the loop up again: the standing socket is closed, not orphaned
    await alice.agent.start();
    await withTimeout(until(() => sockets.length === 2 && alice.agent.status.state === "live"), 8000, "second start live");
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.closed).toBe(false);
    expect(mediator.seenTypes.filter((t) => t.endsWith("mediate-request"))).toHaveLength(1);
    alice.agent.destroy();
    expect(sockets[1]?.closed).toBe(true);
  });

  it("a destroy in the middle of a start stops it: no socket opens for a dead agent", async () => {
    const mediator = await newMediator();
    const sockets: FakeSocket[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const slow: typeof fetch = async (input, init) => {
      if (first) {
        first = false;
        await held;
      }
      return mediator.fetch(input, init);
    };
    const carol = await newParty("Carol", 12, mediator, { fetch: slow, webSocket: watching(sockets, mediator) });

    const starting = carol.agent.start();
    await until(() => !first); // the start is inside its first round trip with the mediator
    carol.agent.destroy();
    release();
    await starting; // resolves: the continuation stops at its next checkpoint

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets).toHaveLength(0);
    expect(carol.statuses.every((status) => status.state !== "live")).toBe(true);
  });

  it("refuses to issue an invitation while the mediator cannot be reached", async () => {
    const mediator = await newMediator();
    const erin = await newParty("Erin", 13, mediator);
    await erin.agent.start();
    await withTimeout(erin.live);
    erin.agent.destroy();

    // reopened where the mediator's DID does not resolve: the ring stands, the link never comes up
    const v = await openVault(erin.backend, erin.seedKey, { clock: erin.clock });
    const blind = attach("Erin", erin.backend, v, erin.seedKey, erin.clock, mediator, [], {
      resolveDid: async (did) => (did === mediator.did ? null : resolveDIDCommDoc(did)),
    });
    await blind.agent.start();
    expect(blind.statuses.some((status) => status.state === "error" && status.detail === "mediator DID does not resolve")).toBe(true);

    await expect(blind.agent.createInvitation()).rejects.toThrow(/not reachable yet/);
    expect(blind.v.fold.invitations()).toEqual([]);
    blind.agent.destroy();
  });

  it("accepts an invitation for a known contact from the fold alone, and answers it under its pthid", async () => {
    const mediator = await newMediator();
    const dead = new Set<string>();
    const alice = await newParty("Alice", 14, mediator, {
      resolveDid: async (did) => (dead.has(did) ? null : resolveDIDCommDoc(did)),
    });
    const bob = await newParty("Bob", 15, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    const before = contactByDid(alice, bob.agent.did as string) as Contact;

    // the resolver goes dark for Bob's DID; the fold already knows the channel it is on
    dead.add(bob.agent.did as string);
    const accepted = await alice.agent.acceptInvitation(
      { type: OOB_INVITATION, id: "oob-7", typ: PLAIN_TYP, from: bob.agent.did as string, body: { goal_code: "connect" } },
      "Bobby"
    );
    expect(accepted.cid).toBe(before.cid);
    const contact = contactByDid(alice, bob.agent.did as string) as Contact;
    expect(contact.petname).toBe("Bobby");
    const taken = contact.attached.find((attach) => attach.because === "accepted");
    expect(taken?.oobId).toBe("oob-7");
    expect(taken?.pair).toEqual(before.channels[0]);
    // the introduction could not go out while the resolver was dark; the first message makes it
    expect(alice.log.some((line) => line.startsWith("could not answer the invitation yet"))).toBe(true);

    dead.delete(bob.agent.did as string);
    await alice.agent.sendBasicMessage(bob.agent.did as string, "hi bob");
    const profile = (await recordsOf(alice)).find((r) => r.direction === "out" && r.msg?.type === PROFILE);
    expect(profile?.skeleton.pthid).toBe("oob-7");
    expect(profile?.msg?.from_prior).toBeUndefined();
    await withTimeout(bob.next((v) => v.content === "hi bob"), 8000, "bob's chat");
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("introduces once when a merge lands in the middle of the introduction", async () => {
    const mediator = await newMediator();
    const stalls = new Map<string, Promise<void>>();
    let resolutions = 0;
    const alice = await newParty("Alice", 16, mediator, {
      resolveDid: async (did) => {
        resolutions += 1;
        await stalls.get(did);
        return resolveDIDCommDoc(did);
      },
    });
    const bob = await newParty("Bob", 17, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    const elder = await alice.agent.addContact(bob.agent.did as string, "Bob");
    // a second contact whose cid sorts first: the merge will hand it the representative's seat
    const younger = "0198a000-0000-7000-8000-000000000021";
    await recordEvent(alice.v.vault.events, alice.v.fold, drafts.contactCreated({ cid: younger }));

    // the first send stalls inside the introduction's compose; the merge lands while it waits
    let release = (): void => undefined;
    stalls.set(bob.agent.did as string, new Promise<void>((resolve) => (release = resolve)));
    const before = resolutions;
    const first = alice.agent.sendBasicMessage(bob.agent.did as string, "one");
    await until(() => resolutions > before);
    await recordEvent(alice.v.vault.events, alice.v.fold, drafts.contactMerged({ cid: elder.cid, from: younger }));
    expect(alice.v.fold.contact(elder.cid)?.cid).toBe(younger);
    const second = alice.agent.sendBasicMessage(bob.agent.did as string, "two");
    release();
    stalls.delete(bob.agent.did as string);
    await Promise.all([first, second]);

    const profiles = (await recordsOf(alice)).filter((r) => r.direction === "out" && r.msg?.type === PROFILE);
    expect(profiles).toHaveLength(1);
    await withTimeout(bob.next((v) => v.content === "two"), 8000, "bob's second chat");
    expect(bob.messages.filter((m) => m.view.kind === "profile" && m.view.direction === "received")).toHaveLength(1);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("changes mediator while a start is midway: the move waits its turn, and nothing of ours stays behind", async () => {
    const one = await newMediator();
    const two = await newMediator({ fill: 201, http: "http://mediator-two/", ws: "ws://mediator-two/ws" });
    const net = network(one, two);
    const sockets: FakeSocket[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let stallNext = false;
    const slow: typeof fetch = async (input, init) => {
      if (stallNext) {
        stallNext = false;
        await held;
      }
      return net.fetch(input, init);
    };
    const alice = await newParty("Alice", 18, one, { fetch: slow, webSocket: watching(sockets, net) });

    // the start stalls inside its mediate-request to the first mediator; the move is asked for meanwhile
    stallNext = true;
    const starting = alice.agent.start();
    await until(() => !stallNext);
    const moving = alice.agent.setMediator(two.did);
    release();
    await Promise.all([starting, moving]);
    await withTimeout(alice.live, 8000, "live at the new mediator");

    // the stalled start finished its round trip and stopped; the leaving ran after it, so what
    // it had registered at the old mediator was on the drop list, not left behind
    const device = alice.v.fold.device(alice.v.vault.self);
    expect(device?.mediations.map((m) => m.retired !== null)).toEqual([true, false]);
    expect(device?.mediation?.mediatorDid).toBe(two.did);
    expect(one.recipients.size).toBe(0);
    expect(two.recipients.size).toBeGreaterThan(0);
    // no socket ever opened toward the old mediator
    expect(sockets.map((s) => s.url)).toEqual([two.wsUrl]);
    expect(alice.agent.did).toMatch(/^did:peer:4/);
    alice.agent.destroy();
  });

  it("runs one delivery pass at a time across a restart: a stalled send is not sent twice by the fresh outbox", async () => {
    const mediator = await newMediator();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = { arm: false };
    const slow: typeof fetch = async (input, init) => {
      if (gate.arm) {
        gate.arm = false;
        await held;
      }
      return mediator.fetch(input, init);
    };
    const alice = await newParty("Alice", 19, mediator, { fetch: slow });
    const bob = await newParty("Bob", 20, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "warm");
    await withTimeout(bob.next((v) => v.content === "warm"));
    await withTimeout(until(() => [...mediator.queues.values()].every((q) => q.length === 0)), 8000, "quiet");
    const forwardsBefore = mediator.seenTypes.filter((t) => t === FORWARD).length;

    // the pass stalls on the wire; a restart assembles a fresh outbox meanwhile
    gate.arm = true;
    const sending = alice.agent.sendBasicMessage(bob.agent.did as string, "slow one");
    await until(() => !gate.arm);
    const restarting = alice.agent.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [record] = await Promise.all([sending, restarting]);
    await withTimeout(until(() => alice.agent.status.state === "live"), 8000, "live again");

    // one try, one forward: the fresh outbox took its turn after the stalled pass, and found nothing waiting
    expect(alice.v.fold.delivery(record.mid)?.attempts.map((attempt) => attempt.outcome)).toEqual(["sent"]);
    expect(mediator.seenTypes.filter((t) => t === FORWARD).length - forwardsBefore).toBe(1);
    await withTimeout(bob.next((v) => v.content === "slow one"));
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("mints one key toward a contact even when two composes straddle a restart", async () => {
    const mediator = await newMediator();
    const stalls = new Map<string, Promise<void>>();
    let resolutions = 0;
    const alice = await newParty("Alice", 21, mediator, {
      resolveDid: async (did) => {
        resolutions += 1;
        await stalls.get(did);
        return resolveDIDCommDoc(did);
      },
    });
    const bob = await newParty("Bob", 22, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    const contact = contactByDid(alice, bob.agent.did as string) as Contact;
    // introduced by decree: sends compose directly, and the first key is minted by whoever sends first
    await recordEvent(alice.v.vault.events, alice.v.fold, drafts.profileShared({ ...(contact.channels[0] as ChannelKey), mid: "0198a000-0000-7000-8000-000000000031" }));

    // the first compose stalls at the resolver on the first assembly; a restart swaps the composer; the second composes on the fresh one
    let release = (): void => undefined;
    stalls.set(bob.agent.did as string, new Promise<void>((resolve) => (release = resolve)));
    const before = resolutions;
    const first = alice.agent.sendBasicMessage(bob.agent.did as string, "one");
    await until(() => resolutions > before);
    await alice.agent.start();
    const second = alice.agent.sendBasicMessage(bob.agent.did as string, "two");
    await until(() => resolutions > before + 1);
    release();
    stalls.delete(bob.agent.did as string);
    await Promise.all([first, second]);

    // one mint: the two composers share one mint lock, and the second found the first's key in the fold
    const after = contactByDid(alice, bob.agent.did as string) as Contact;
    expect(after.keys).toHaveLength(1);
    const outs = (await recordsOf(alice)).filter((r) => r.direction === "out");
    expect(outs).toHaveLength(2);
    expect(new Set(outs.map((r) => r.msg?.from)).size).toBe(1);
    // and the fresh assembly's ring holds the straddling key: both delivered, nothing stuck sealing
    expect(outs.map((r) => alice.v.fold.delivery(r.mid)?.status)).toEqual(["sent", "sent"]);
    await withTimeout(bob.next((v) => v.content === "two"), 8000, "bob's second chat");
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("hands out an invitation while the mediator changes: registered, then retired and dropped, not left behind", async () => {
    const one = await newMediator();
    const two = await newMediator({ fill: 230, http: "http://mediator-two/", ws: "ws://mediator-two/ws" });
    const net = network(one, two);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = { arm: false };
    const slow: typeof fetch = async (input, init) => {
      if (gate.arm) {
        gate.arm = false;
        await held;
      }
      return net.fetch(input, init);
    };
    const alice = await newParty("Alice", 23, one, { fetch: slow, webSocket: net.WebSocket });
    await alice.agent.start();
    await withTimeout(alice.live);

    // the handout stalls inside its registration round trip; the move is asked for meanwhile
    gate.arm = true;
    const inviting = alice.agent.createInvitation("come in");
    await until(() => !gate.arm);
    const moving = alice.agent.setMediator(two.did);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [invitation] = await Promise.all([inviting, moving]);
    await withTimeout(until(() => alice.agent.status.state === "live"), 8000, "live at the new mediator");

    // the leaving waited for the handout's turn: the add landed in time for the drop list, and the invitation was withdrawn
    expect(invitation.registered).toBe(true);
    expect(one.recipients.size).toBe(0);
    expect(two.recipients.size).toBeGreaterThan(0);
    expect(alice.agent.invitations().find((entry) => entry.id === invitation.id)?.open).toBe(false);
    alice.agent.destroy();
  });

  it("opens mail to a key minted while a restart was reloading the ring", async () => {
    const mediator = await newMediator();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = { arm: false };
    const alice = await newParty("Alice", 24, mediator, {
      // one-shot: only the restart's own mediator resolution stalls; sealing resolves it too, and must pass
      resolveDid: async (did) => {
        if (gate.arm && did === mediator.did) {
          gate.arm = false;
          await held;
        }
        return resolveDIDCommDoc(did);
      },
    });
    const bob = await newParty("Bob", 25, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    const contact = contactByDid(alice, bob.agent.did as string) as Contact;
    // introduced by decree: the send below composes directly and mints the first key toward Bob
    await recordEvent(alice.v.vault.events, alice.v.fold, drafts.profileShared({ ...(contact.channels[0] as ChannelKey), mid: "0198a000-0000-7000-8000-000000000051" }));

    // the restart stalls at the mediator resolver: the ring reloaded, the standing assembly not yet replaced
    gate.arm = true;
    const restarting = alice.agent.start();
    await until(() => !gate.arm);
    // the mint lands after the reload's pass over the fold, through the standing assembly's composer
    const sent = await alice.agent.sendBasicMessage(bob.agent.did as string, "one");
    expect(alice.v.fold.delivery(sent.mid)?.status).toBe("sent");
    await withTimeout(bob.next((view) => view.content === "one"), 8000, "bob's chat");

    // the reply comes to that key: the ring is the identity's, one instance, so the restart holds it too
    const replying = bob.agent.sendBasicMessage(myDidToward(alice, bob.agent.did as string), "two");
    release();
    await Promise.all([restarting, replying]);
    await withTimeout(alice.next((view) => view.content === "two"), 8000, "alice hears the reply");
    expect((contactByDid(alice, bob.agent.did as string) as Contact).keys).toHaveLength(1);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("drops a DID whose add was applied but never answered: the move cleans what might have been told", async () => {
    const one = await newMediator();
    const two = await newMediator({ fill: 232, http: "http://mediator-two/", ws: "ws://mediator-two/ws" });
    const net = network(one, two);
    const gate = { arm: false };
    // the mediator gets the request and applies it; the answer is lost on the way back
    const flaky: typeof fetch = async (input, init) => {
      const response = await net.fetch(input, init);
      if (gate.arm) {
        gate.arm = false;
        throw new Error("connection lost");
      }
      return response;
    };
    const alice = await newParty("Alice", 26, one, { fetch: flaky, webSocket: net.WebSocket });
    const bob = await newParty("Bob", 27, one);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    const contact = contactByDid(alice, bob.agent.did as string) as Contact;
    // introduced by decree: the send below composes directly and mints the first key toward Bob
    await recordEvent(alice.v.vault.events, alice.v.fold, drafts.profileShared({ ...(contact.channels[0] as ChannelKey), mid: "0198a000-0000-7000-8000-000000000061" }));

    // the attempt's add reached the mediator, its answer did not come back: no did.registered, the delivery failed
    gate.arm = true;
    const sent = await alice.agent.sendBasicMessage(bob.agent.did as string, "one");
    expect(alice.v.fold.delivery(sent.mid)?.attempts.map((attempt) => attempt.outcome)).toEqual(["failed"]);
    const minted = myDidToward(alice, bob.agent.did as string);
    expect(one.recipients.has(minted)).toBe(true);
    expect(alice.v.fold.myKey(keyWearing(alice, minted) as string)?.registered ?? []).not.toContain(alice.v.vault.self);

    // the move drops every DID this device minted under the old arrangement, answered or not
    const oldPublic = alice.agent.did as string;
    await alice.agent.setMediator(two.did);
    await withTimeout(until(() => alice.agent.status.state === "live"), 8000, "live at the new mediator");
    expect(one.recipients.has(minted)).toBe(false);
    expect(one.recipients.has(oldPublic)).toBe(false);
    expect(two.recipients.size).toBeGreaterThan(0);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("a resolver that never settles fails the send at the budget instead of parking the mint lock", async () => {
    const mediator = await newMediator();
    const dead = new Set<string>();
    const alice = await newParty("Alice", 28, mediator, {
      deliveryTimeoutMs: 300,
      resolveDid: async (did) => {
        if (dead.has(did)) {
          await new Promise<void>(() => undefined);
        }
        return resolveDIDCommDoc(did);
      },
    });
    const bob = await newParty("Bob", 29, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    const contact = contactByDid(alice, bob.agent.did as string) as Contact;
    await recordEvent(alice.v.vault.events, alice.v.fold, drafts.profileShared({ ...(contact.channels[0] as ChannelKey), mid: "0198a000-0000-7000-8000-000000000071" }));

    // the compose's resolution parks: the send fails at the budget rather than hanging
    dead.add(bob.agent.did as string);
    await expect(withTimeout(alice.agent.sendBasicMessage(bob.agent.did as string, "one"), 8000, "the send should fail, not hang")).rejects.toThrow(/timeout|abort/i);

    // the mint lock is free again: a restart's reload rides it and completes
    dead.delete(bob.agent.did as string);
    await withTimeout(alice.agent.start(), 8000, "a start after the stuck resolution");
    await withTimeout(until(() => alice.agent.status.state === "live"), 8000, "live again");
    alice.agent.destroy();
    bob.agent.destroy();
  });
});
