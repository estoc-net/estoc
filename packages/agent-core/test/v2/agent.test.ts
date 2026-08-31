import { describe, expect, it } from "vitest";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { KEYSTORE_FILE } from "@estoc/event-store";
import type { Contact } from "@estoc/vault/v2";

import { BASIC_MESSAGE, PROFILE } from "../../src/index.js";
import { nameOf, type MessageRecord } from "../../src/v2/index.js";
import {
  contactByDid,
  history,
  keyWearing,
  myDidToward,
  newMediator,
  newParty,
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
});
