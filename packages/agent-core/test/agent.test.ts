import { describe, expect, it } from "vitest";
import { FromPrior, Message } from "didcomm-node";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";
import { resolveDIDCommDoc } from "@estoc/did-peer";

import {
  Agent,
  BASIC_MESSAGE,
  ENCRYPTED_MIME,
  FORWARD,
  KEY_PAIRWISE_PREFIX,
  KEY_PUBLIC,
  MemoryBackend,
  PLAIN_TYP,
  PROFILE,
  REQUEST_PROFILE,
  Vault,
  currentDid,
  currentMyDid,
  mintPeerDid,
  secretsResolverFor,
  type AgentStatus,
  type ChatMessage,
  type ContactRecord,
  type IMessage,
  type MessageRecord,
} from "../src/index.js";
import { FakeMediator, MEDIATOR_HTTP } from "./fake-mediator.js";

const didcomm = { Message, FromPrior };
const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);

async function newMediator(): Promise<FakeMediator> {
  return new FakeMediator(await deriveIdentity(await importSeed(seedOf(200)), 0));
}

interface Party {
  name: string;
  backend: MemoryBackend;
  vault: Vault;
  agent: Agent;
  seedKey: CryptoKey;
  statuses: AgentStatus[];
  messages: { record: MessageRecord; view: ChatMessage }[];
  contacts: ContactRecord[];
  log: string[];
  /** resolves when the agent reaches "live" */
  live: Promise<void>;
  /** waits for the next chat-visible message that satisfies `pred` */
  next(pred: (view: ChatMessage) => boolean): Promise<ChatMessage>;
}

async function newVault(name: string, fill: number, mediatorDid: string) {
  const backend = new MemoryBackend();
  const { doc, seedKey } = await createSeedKeystore("", { seed: seedOf(fill) });
  const vault = await Vault.create(backend, { label: name, keystore: doc, seedKey, mediatorDid });
  return { backend, vault, seedKey };
}

function attach(
  name: string,
  backend: MemoryBackend,
  vault: Vault,
  seedKey: CryptoKey,
  mediator: FakeMediator
): Party {
  const party = {
    name,
    backend,
    vault,
    seedKey,
    statuses: [],
    messages: [],
    contacts: [],
    log: [],
  } as unknown as Party;
  let resolveLive!: () => void;
  party.live = new Promise<void>((r) => (resolveLive = r));
  const waiters: { pred: (v: ChatMessage) => boolean; resolve: (v: ChatMessage) => void }[] = [];
  party.next = (pred) => {
    const hit = party.messages.find((m) => pred(m.view));
    if (hit !== undefined) return Promise.resolve(hit.view);
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  party.agent = new Agent({
    vault,
    seedKey,
    didcomm,
    resolveDid: resolveDIDCommDoc,
    fetch: mediator.fetch,
    WebSocket: mediator.WebSocket,
    reconnectDelayMs: 10,
    events: {
      onStatus(status) {
        party.statuses.push(status);
        if (status.state === "live") resolveLive();
      },
      onMessage(record, view) {
        party.messages.push({ record, view });
        for (const w of [...waiters]) {
          if (w.pred(view)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(view);
          }
        }
      },
      onContact(contact) {
        party.contacts.push(structuredClone(contact));
      },
      onLog(line) {
        party.log.push(line);
      },
    },
  });
  return party;
}

async function newParty(name: string, fill: number, mediator: FakeMediator): Promise<Party> {
  const { backend, vault, seedKey } = await newVault(name, fill, mediator.did);
  return attach(name, backend, vault, seedKey, mediator);
}

/** The same vault, opened fresh from its bytes — a page reload. */
async function reopen(party: Party, mediator: FakeMediator): Promise<Party> {
  party.agent.destroy();
  const vault = await Vault.open(party.backend);
  return attach(party.name, party.backend, vault, party.seedKey, mediator);
}

const withTimeout = <T>(p: Promise<T>, ms = 8000, what = "event"): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)),
  ]);

async function until(cond: () => boolean): Promise<void> {
  while (!cond()) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The DID `party` currently writes to `contactDid`'s owner from — pairwise, minted on first use. */
async function myDidToward(party: Party, contactDid: string): Promise<string> {
  const contact = await party.vault.contacts.byDid(contactDid);
  const use = contact === null ? null : currentMyDid(contact);
  if (use === null) throw new Error(`${party.name} has no DID toward ${contactDid.slice(0, 24)}`);
  return use.did;
}

describe("Agent through a mediator", () => {
  it("mediates, exchanges basic messages and profiles", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 1, mediator);
    const bob = await newParty("Bob", 2, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]), 8000, "both live");

    // Mediation minted a public DID on the mediator's routing DID and
    // registered it; the config snapshot and the keystore agree.
    expect(alice.agent.did).toMatch(/^did:peer:4/);
    expect(alice.vault.config.mediation?.routingDid).toBe(mediator.did);
    expect(alice.vault.config.mediation?.public?.key).toBe(KEY_PUBLIC);
    expect(mediator.recipients.get(alice.agent.did as string)).toBe(alice.vault.config.mediation?.me.did);
    const aliceDoc = await resolveDIDCommDoc(alice.agent.did as string);
    expect(aliceDoc?.service[0]?.serviceEndpoint).toMatchObject({ uri: mediator.did });

    // Alice names Bob and writes; the intro (user-profile) rides ahead.
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    const sent = await alice.agent.sendBasicMessage(bob.agent.did as string, "hello bob");
    expect(sent.kind).toBe("chat");
    expect(sent.direction).toBe("sent");

    // Bob receives it live — from a DID Alice minted for him alone, not
    // her public one, which she keeps for strangers.
    const got = await withTimeout(bob.next((v) => v.kind === "chat" && v.content === "hello bob"), 8000, "bob's chat");
    expect(got.direction).toBe("received");
    const aliceToBob = await myDidToward(alice, bob.agent.did as string);
    expect(aliceToBob).toMatch(/^did:peer:4/);
    expect(aliceToBob).not.toBe(alice.agent.did);
    expect(got.contactDid).toBe(aliceToBob);
    // that DID is registered with the mediator under Alice's account, and
    // resolves to a service on the mediator like her public one
    expect(mediator.recipients.get(aliceToBob)).toBe(alice.vault.config.mediation?.me.did);
    expect((await resolveDIDCommDoc(aliceToBob))?.service[0]?.serviceEndpoint).toMatchObject({ uri: mediator.did });
    const alicesBobRecord = (await alice.vault.contacts.byDid(bob.agent.did as string)) as ContactRecord;
    expect(alicesBobRecord.myDids).toHaveLength(1);
    expect(alicesBobRecord.myDids?.[0]).toMatchObject({ did: aliceToBob, key: `${KEY_PAIRWISE_PREFIX}${alicesBobRecord.cid}/1` });
    expect(alicesBobRecord.myDids?.[0]?.registeredAt).toBeDefined();
    // Bob's copy of the thread is homed to his contact for Alice
    expect(got.contactCid).toBeDefined();

    // The stranger contact was created and then took Alice's claimed name;
    // send_back_yours made Bob introduce himself in return.
    const bobsAlice = await bob.vault.contacts.byDid(aliceToBob);
    expect(bobsAlice?.cid).toBe(got.contactCid);
    expect(bobsAlice?.name).toBe("Alice");
    expect(bobsAlice?.claimedName).toBe("Alice");
    expect(bobsAlice?.profileSharedAt).toBeDefined();
    // Alice wrote to Bob's public DID, and the record says so
    expect(bobsAlice?.addressedAs).toBe(bob.agent.did);
    const bobsIntro = await withTimeout(alice.next((v) => v.kind === "profile" && v.direction === "received"), 8000, "bob's intro");
    expect(bobsIntro.content).toBe("Bob");

    // Bob's introduction came from a DID of his own toward Alice, with a
    // from_prior signed by the public DID she wrote to — so on Alice's side
    // Bob rotated: the public DID closed, the pairwise one current, the
    // JWT kept as evidence.
    const bobToAlice = await myDidToward(bob, aliceToBob);
    expect(bobToAlice).not.toBe(bob.agent.did);
    const bobsAliceRecord = (await bob.vault.contacts.byDid(aliceToBob)) as ContactRecord;
    expect(bobsAliceRecord.myDids?.map((u) => u.key)).toEqual([KEY_PUBLIC, `${KEY_PAIRWISE_PREFIX}${bobsAliceRecord.cid}/1`]);
    expect(bobsAliceRecord.myDids?.[0]?.until).toBeDefined();
    const alicesBob = (await alice.vault.contacts.byDid(bob.agent.did as string)) as ContactRecord;
    expect(alicesBob.dids.map((u) => u.did)).toEqual([bob.agent.did, bobToAlice]);
    expect(alicesBob.dids[0]?.until).toBeDefined();
    expect(alicesBob.dids[1]?.fromPrior).toMatch(/^eyJ/);
    expect(currentDid(alicesBob)).toBe(bobToAlice);
    expect(bobsIntro.contactDid).toBe(bobToAlice);
    expect(bobsIntro.contactCid).toBe(alicesBob.cid);
    // Alice typed "Bob" herself, so the claim is remembered but does not rename.
    expect(alicesBob.name).toBe("Bob");
    expect(alicesBob.claimedName).toBe("Bob");
    const bobsFirstOut = (await bob.vault.messages.read()).find((r) => r.direction === "out");
    expect(bobsFirstOut?.msg.from).toBe(bobToAlice);
    expect(bobsFirstOut?.msg.from_prior).toBe(alicesBob.dids[1]?.fromPrior);

    // Bob replies; Alice receives. Alice has not written to Bob's new DID
    // yet, so the reply still carries from_prior.
    await bob.agent.sendBasicMessage(aliceToBob, "hi alice");
    const reply = await withTimeout(alice.next((v) => v.content === "hi alice"), 8000, "alice's reply");
    expect(reply.direction).toBe("received");
    expect(reply.contactCid).toBe(alicesBob.cid);
    const bobsChatOut = (await bob.vault.messages.read()).find((r) => r.direction === "out" && r.msg.type === BASIC_MESSAGE);
    expect(bobsChatOut?.msg.from_prior).toBeDefined();

    // Alice's next message goes to Bob's new DID; once Bob has seen that,
    // his messages stop carrying from_prior.
    await alice.agent.sendBasicMessage(bobToAlice, "seen you move");
    await withTimeout(bob.next((v) => v.content === "seen you move"));
    expect((await bob.vault.contacts.byDid(aliceToBob))?.addressedAs).toBe(bobToAlice);
    await bob.agent.sendBasicMessage(aliceToBob, "good");
    await withTimeout(alice.next((v) => v.content === "good"));
    const bobsLastOut = (await bob.vault.messages.read()).filter((r) => r.direction === "out").at(-1);
    expect(bobsLastOut?.msg.from_prior).toBeUndefined();
    // and Alice's thread with Bob is one thread, across his two DIDs
    const aliceHistory = await alice.agent.history();
    expect(aliceHistory.every((v) => v.contactCid === alicesBob.cid)).toBe(true);
    expect(aliceHistory.filter((v) => v.kind === "chat").map((v) => v.content)).toEqual(["hello bob", "hi alice", "seen you move", "good"]);

    // The logs hold the facts: Alice sent profile+chat, got profile+chat, and so on.
    const aliceLog = await alice.vault.messages.read();
    expect(aliceLog.map((r) => `${r.direction}:${r.msg.type === PROFILE ? "profile" : "chat"}`)).toEqual([
      "out:profile",
      "out:chat",
      "in:profile",
      "in:chat",
      "out:chat",
      "in:chat",
    ]);
    // inbound records carry the envelope-proven sender: Bob's pairwise DID throughout
    expect(aliceLog.filter((r) => r.direction === "in").every((r) => r.sender === bobToAlice)).toBe(true);
    // and everything Alice sent went out from her DID toward Bob
    expect(aliceLog.filter((r) => r.direction === "out").every((r) => r.msg.from === aliceToBob)).toBe(true);
    // Every message went out with the wire fields the spec wants.
    expect(aliceLog[1]?.msg).toMatchObject({ type: BASIC_MESSAGE, typ: "application/didcomm-plain+json" });
    expect(typeof aliceLog[1]?.msg.created_time).toBe("number");

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
    bob.agent.destroy();
    await alice.agent.sendBasicMessage(bob.agent.did as string, "two");
    expect(mediator.queues.get(bob.vault.config.mediation!.me.did)).toHaveLength(1);

    // Bob comes back from bytes alone: same DIDs, old history, and the
    // queued message drains on start.
    bob = await reopen(bob, mediator);
    const publicBefore = bob.vault.config.mediation?.public?.did;
    await bob.agent.start();
    await withTimeout(bob.live);
    expect(bob.agent.did).toBe(publicBefore);
    const history = await bob.agent.history();
    expect(history.filter((v) => v.kind === "chat").map((v) => v.content)).toEqual(["one", "two"]);
    expect(history.filter((v) => v.content === "one")).toHaveLength(1);
    // the reopened agent did not re-request mediation
    expect(mediator.seenTypes.filter((t) => t.endsWith("mediate-request"))).toHaveLength(2);

    alice.agent.destroy();
    bob.agent.destroy();
    alice = await reopen(alice, mediator);
    await alice.agent.start();
    await withTimeout(alice.live);
    expect((await alice.agent.history()).map((v) => v.content)).toEqual(["Alice", "one", "Bob", "two"]);
    alice.agent.destroy();
  });

  it("heals a mediation interrupted after the public key was minted", async () => {
    const mediator = await newMediator();
    const { backend, vault, seedKey } = await newVault("Carol", 5, mediator.did);
    // The crash: the key exists in the keystore, config knows nothing yet.
    await vault.mintKey(seedKey, KEY_PUBLIC);
    const carol = attach("Carol", backend, vault, seedKey, mediator);
    await carol.agent.start();
    await withTimeout(carol.live);
    expect(carol.vault.config.mediation?.public?.key).toBe(KEY_PUBLIC);
    // and the recorded DID is the one the existing key derives
    const again = await Vault.open(backend);
    await expect(again.peerIdentity(seedKey, again.config.mediation!.public!, mediator.did)).resolves.toBeDefined();
    expect(again.keystore.keys.filter((k) => k.name === KEY_PUBLIC)).toHaveLength(1);
    carol.agent.destroy();
  });

  it("starts unmediated without a mediator, and goes live once one is chosen", async () => {
    const mediator = await newMediator();
    const backend = new MemoryBackend();
    const { doc, seedKey } = await createSeedKeystore("", { seed: seedOf(7) });
    const vault = await Vault.create(backend, { label: "Carol", keystore: doc, seedKey });
    const carol = attach("Carol", backend, vault, seedKey, mediator);
    const bob = await newParty("Bob", 2, mediator);
    await Promise.all([carol.agent.start(), bob.agent.start()]);
    await withTimeout(bob.live, 8000, "bob live");

    // an identity, not yet reachable: no public DID, nothing sent
    expect(carol.agent.status).toEqual({ state: "unmediated" });
    expect(carol.agent.did).toBeNull();
    await carol.agent.addContact(bob.agent.did as string, "Bob");
    await expect(carol.agent.sendBasicMessage(bob.agent.did as string, "hi")).rejects.toThrow(/no mediator yet/);

    // the mediator is chosen after the fact; mediation runs to live
    await carol.agent.setMediator(mediator.did);
    await withTimeout(carol.live, 8000, "carol live");
    expect(carol.agent.did).toMatch(/^did:peer:4/);
    expect(carol.vault.config.mediation?.mediatorDid).toBe(mediator.did);
    await carol.agent.sendBasicMessage(bob.agent.did as string, "hi from carol");
    const got = await withTimeout(bob.next((v) => v.content === "hi from carol"), 8000, "bob's chat");
    expect(got.contactDid).toBe(await myDidToward(carol, bob.agent.did as string));

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
    const { backend, vault, seedKey } = await newVault("Carol", 9, mediator.did);
    // Carol's line to the mediator can be cut and restored.
    let cut = false;
    const flaky: typeof fetch = (input, init) => {
      if (cut) return Promise.reject(new TypeError("fetch failed"));
      return mediator.fetch(input, init);
    };
    const carol = attach("Carol", backend, vault, seedKey, { ...mediator, fetch: flaky, WebSocket: mediator.WebSocket } as FakeMediator);
    await Promise.all([carol.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([carol.live, bob.live]));

    cut = true;
    await carol.agent.addContact(bob.agent.did as string, "Bob");
    await expect(carol.agent.sendBasicMessage(bob.agent.did as string, "into the void")).rejects.toThrow(/fetch failed/);
    // the DID was minted and recorded, but the mediator never heard of it
    const record = (await carol.vault.contacts.byDid(bob.agent.did as string)) as ContactRecord;
    const use = currentMyDid(record);
    expect(use?.key).toBe(`${KEY_PAIRWISE_PREFIX}${record.cid}/1`);
    expect(use?.registeredAt).toBeUndefined();
    expect(mediator.recipients.has(use?.did as string)).toBe(false);
    // nothing was logged as sent
    expect((await carol.vault.messages.read()).filter((r) => r.direction === "out")).toHaveLength(0);

    // the line comes back: the next send registers the same DID first, then goes
    cut = false;
    await carol.agent.sendBasicMessage(bob.agent.did as string, "hello from carol");
    await withTimeout(bob.next((v) => v.content === "hello from carol"));
    const after = (await carol.vault.contacts.byDid(bob.agent.did as string)) as ContactRecord;
    expect(after.myDids).toHaveLength(1);
    expect(currentMyDid(after)?.did).toBe(use?.did);
    expect(currentMyDid(after)?.registeredAt).toBeDefined();
    expect(mediator.recipients.get(use?.did as string)).toBe(carol.vault.config.mediation?.me.did);
    // and Bob can answer to it
    await bob.agent.sendBasicMessage(use?.did as string, "hi carol");
    await withTimeout(carol.next((v) => v.content === "hi carol"));

    // a start with unregistered DIDs on record registers them before pickup
    const dan = await newParty("Dan", 10, mediator);
    await dan.agent.start();
    await withTimeout(dan.live);
    cut = true;
    await carol.agent.addContact(dan.agent.did as string, "Dan");
    await expect(carol.agent.sendBasicMessage(dan.agent.did as string, "x")).rejects.toThrow();
    const carolToDan = await myDidToward(carol, dan.agent.did as string);
    expect(mediator.recipients.has(carolToDan)).toBe(false);
    cut = false;
    const again = await reopen(carol, mediator);
    await again.agent.start();
    await withTimeout(again.live);
    expect(again.log).toContain("registering 1 pairwise DID(s) with the mediator");
    expect(mediator.recipients.get(carolToDan)).toBe(carol.vault.config.mediation?.me.did);
    expect(currentMyDid((await again.vault.contacts.byDid(dan.agent.did as string)) as ContactRecord)?.registeredAt).toBeDefined();

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
    const aliceToBob = await myDidToward(alice, bob.agent.did as string);
    expect(mediator.recipients.has(aliceToBob)).toBe(true);

    const record = (await alice.vault.contacts.byDid(bob.agent.did as string)) as ContactRecord;
    await alice.agent.removeContact(record.cid);
    expect(await alice.vault.contacts.byCid(record.cid)).toBeNull();
    // the mediator no longer accepts mail for that DID; the key stays burned
    expect(mediator.recipients.has(aliceToBob)).toBe(false);
    expect(alice.vault.keystore.keys.some((k) => k.name === `${KEY_PAIRWISE_PREFIX}${record.cid}/1`)).toBe(true);
    // Bob writing to it now bounces at the mediator
    await expect(bob.agent.sendBasicMessage(aliceToBob, "anyone there?")).rejects.toThrow();
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("reports an error status when the mediator does not resolve", async () => {
    const mediator = await newMediator();
    const { backend, vault, seedKey } = await newVault("Dan", 6, "did:web:nowhere.invalid");
    const dan = attach("Dan", backend, vault, seedKey, mediator);
    await dan.agent.start();
    expect(dan.agent.status).toEqual({ state: "error", detail: "mediator DID does not resolve" });
    await expect(dan.agent.sendBasicMessage("did:peer:4x", "x")).rejects.toThrow(/no public DID/);
  });
});

/**
 * Deliver an already-packed inner envelope to `recipientDid` the way any
 * sender would: a routing/2.0 forward, sealed anonymously to the mediator,
 * POSTed to its endpoint. `innerPacked` may be anything — that is the point.
 */
async function forwardTo(mediator: FakeMediator, recipientDid: string, innerPacked: string): Promise<void> {
  const forward = {
    id: crypto.randomUUID(),
    typ: PLAIN_TYP,
    type: FORWARD,
    to: [mediator.did],
    created_time: Math.floor(Date.now() / 1000),
    body: { next: recipientDid },
    attachments: [{ id: crypto.randomUUID(), media_type: ENCRYPTED_MIME, data: { json: JSON.parse(innerPacked) as unknown } }],
  };
  const [outer] = await new Message(forward).pack_encrypted(mediator.did, null, null, { resolve: resolveDIDCommDoc }, secretsResolverFor([]), { forward: false });
  const response = await mediator.fetch(MEDIATOR_HTTP, { method: "POST", headers: { "Content-Type": ENCRYPTED_MIME }, body: outer });
  expect(response.ok).toBe(true);
}

/** A stranger with keys but no mediator: a did:peer:4 whose service is `endpoint`. */
async function stranger(fill: number, endpoint: string) {
  const identity = await deriveIdentity(await importSeed(seedOf(fill)), 0);
  return mintPeerDid(identity, endpoint);
}

const plain = (type: string, from: string | null, to: string, body: Record<string, unknown>) =>
  ({ id: crypto.randomUUID(), typ: PLAIN_TYP, type, ...(from === null ? {} : { from }), to: [to], created_time: Math.floor(Date.now() / 1000), body }) as IMessage;

describe("Agent under hostile mail", () => {
  it("does not attribute an anonymous envelope to whoever its plaintext names", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 11, mediator);
    const bob = await newParty("Bob", 12, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "real");
    await withTimeout(bob.next((v) => v.content === "real"));
    const aliceToBob = await myDidToward(alice, bob.agent.did as string);

    // Mallory seals two messages anonymously to Bob, both claiming to be
    // from Alice: a chat line, and a profile renaming her.
    const forged = plain(BASIC_MESSAGE, aliceToBob, bob.agent.did as string, { content: "forged" });
    const [anon1] = await new Message(forged).pack_encrypted(bob.agent.did as string, null, null, { resolve: resolveDIDCommDoc }, secretsResolverFor([]), { forward: false });
    await forwardTo(mediator, bob.agent.did as string, anon1);
    const forgedProfile = plain(PROFILE, aliceToBob, bob.agent.did as string, { profile: { displayName: "Mallory" }, send_back_yours: false });
    const [anon2] = await new Message(forgedProfile).pack_encrypted(bob.agent.did as string, null, null, { resolve: resolveDIDCommDoc }, secretsResolverFor([]), { forward: false });
    await forwardTo(mediator, bob.agent.did as string, anon2);
    // and, for contrast, a genuine follow-up from Alice
    await alice.agent.sendBasicMessage(bob.agent.did as string, "still real");
    await withTimeout(bob.next((v) => v.content === "still real"));

    // Both forgeries were logged as facts — sender null — but reached no
    // thread, and Alice's petname is untouched.
    const log = await bob.vault.messages.read();
    const anonymous = log.filter((r) => r.direction === "in" && r.sender === null);
    expect(anonymous.map((r) => r.msg.body.content ?? (r.msg.body.profile as { displayName: string }).displayName)).toEqual(["forged", "Mallory"]);
    expect(bob.messages.map((m) => m.view.content)).not.toContain("forged");
    expect((await bob.agent.history()).map((v) => v.content)).not.toContain("forged");
    expect((await bob.vault.contacts.byDid(aliceToBob))?.name).toBe("Alice");
    expect((await bob.vault.contacts.byDid(aliceToBob))?.claimedName).toBe("Alice");
    // and they were acked: handled, not stuck
    await withTimeout(until(() => [...mediator.queues.values()].every((q) => q.length === 0)));
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("answers a profile request only from a proven sender, and survives one whose reply path is dead", async () => {
    const mediator = await newMediator();
    let bob = await newParty("Bob", 13, mediator);
    await bob.agent.start();
    await withTimeout(bob.live);
    bob.agent.destroy();

    // Mallory has real keys but her service endpoint answers nothing.
    const mallory = await stranger(14, "http://nowhere.invalid/");
    const ask = plain(REQUEST_PROFILE, mallory.did, bob.agent.did as string, { query: ["displayName"] });
    const [authAsk] = await new Message(ask).pack_encrypted(bob.agent.did as string, mallory.did, null, { resolve: resolveDIDCommDoc }, secretsResolverFor(mallory.secrets), { forward: false });
    await forwardTo(mediator, bob.agent.did as string, authAsk);
    // and an anonymous ask claiming to be her
    const [anonAsk] = await new Message(ask).pack_encrypted(bob.agent.did as string, null, null, { resolve: resolveDIDCommDoc }, secretsResolverFor([]), { forward: false });
    await forwardTo(mediator, bob.agent.did as string, anonAsk);
    expect(mediator.queues.get(bob.vault.config.mediation!.me.did)).toHaveLength(2);

    // Bob starts into that queue: the dead reply path is logged, not fatal;
    // both asks are acked; the agent comes up live.
    bob = await reopen(bob, mediator);
    await bob.agent.start();
    await withTimeout(bob.live);
    expect(bob.agent.status).toEqual({ state: "live" });
    await withTimeout(until(() => mediator.queues.get(bob.vault.config.mediation!.me.did)?.length === 0));
    expect(bob.log.some((l) => l.startsWith("could not answer a profile request"))).toBe(true);
    expect(bob.log).toContain("anonymous profile request; ignoring");
    // the proven asker became a contact; nothing was sent for the anonymous one
    expect(await bob.vault.contacts.byDid(mallory.did)).not.toBeNull();
    expect((await bob.vault.messages.read()).filter((r) => r.direction === "out")).toHaveLength(0);
    bob.agent.destroy();
  });

  it("leaves an envelope it cannot open queued, and still handles the rest", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 15, mediator);
    let bob = await newParty("Bob", 16, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    bob.agent.destroy();

    // garbage that is not an envelope at all, then a real message behind it
    await forwardTo(mediator, bob.agent.did as string, JSON.stringify({ garbage: true }));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "after the garbage");
    const account = bob.vault.config.mediation!.me.did;
    expect(mediator.queues.get(account)).toHaveLength(3); // garbage, profile intro, chat

    bob = await reopen(bob, mediator);
    await bob.agent.start();
    await withTimeout(bob.live);
    expect((await bob.agent.history()).filter((v) => v.direction === "received").map((v) => v.content)).toEqual(["Alice", "after the garbage"]);
    // the garbage is still there for a later, maybe luckier, pickup — and
    // the drain did not spin on it
    expect(mediator.queues.get(account)).toHaveLength(1);
    expect(bob.log.some((l) => l.startsWith("could not open a delivered envelope; leaving it queued"))).toBe(true);
    expect(bob.log).toContain("nothing in the queue could be handled now; leaving it for a later pickup");
    expect(mediator.seenTypes.filter((t) => t.endsWith("delivery-request")).length).toBeLessThanOrEqual(4);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("picks up what queued during a socket outage when it reconnects", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 17, mediator);
    const bob = await newParty("Bob", 18, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "before");
    await withTimeout(bob.next((v) => v.content === "before"));

    // The mediator drops Bob's socket; Alice writes while it is down.
    const account = bob.vault.config.mediation!.me.did;
    const liveCount = bob.statuses.filter((s) => s.state === "live").length;
    mediator.dropSocket(account);
    await alice.agent.sendBasicMessage(bob.agent.did as string, "during");
    // No push happened (nobody was connected) — the reconnect's pickup
    // fetches it, and live delivery resumes after.
    const got = await withTimeout(bob.next((v) => v.content === "during"));
    expect(got.direction).toBe("received");
    await withTimeout(until(() => bob.statuses.filter((s) => s.state === "live").length > liveCount));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "after");
    await withTimeout(bob.next((v) => v.content === "after"));
    expect((await bob.agent.history()).filter((v) => v.kind === "chat").map((v) => v.content)).toEqual(["before", "during", "after"]);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("handles a burst of socket frames one at a time, losing none", async () => {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 19, mediator);
    const bob = await newParty("Bob", 20, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    // Bob's backend appends yield mid-way, like OPFS; overlapping appends
    // would compute one offset and overwrite each other.
    const inner = bob.backend.append.bind(bob.backend);
    let inFlight = 0;
    let overlapped = false;
    bob.backend.append = async (path, data) => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 2));
      await inner(path, data);
      inFlight--;
    };
    const texts = Array.from({ length: 8 }, (_, i) => `burst ${i}`);
    await Promise.all(texts.map((t) => alice.agent.sendBasicMessage(bob.agent.did as string, t)));
    await withTimeout(Promise.all(texts.map((t) => bob.next((v) => v.content === t))));
    expect(overlapped).toBe(false);
    const chats = (await bob.agent.history()).filter((v) => v.kind === "chat").map((v) => v.content);
    expect(chats.sort()).toEqual([...texts].sort());
    alice.agent.destroy();
    bob.agent.destroy();
  });
});
