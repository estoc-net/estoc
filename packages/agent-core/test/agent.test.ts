import { describe, expect, it } from "vitest";
import { FromPrior, Message } from "didcomm-node";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";
import { resolveDIDCommDoc } from "@estoc/did-peer";
import { readObject, signRoot, verifyTree } from "@estoc/folder-object";

import {
  Agent,
  BASIC_MESSAGE,
  ENCRYPTED_MIME,
  OBJECT_SHARE,
  RAW_MEDIA_TYPE,
  attachmentsOf,
  closureOf,
  verifyShare,
  FORWARD,
  KEY_INVITE_PREFIX,
  KEY_PAIRWISE_PREFIX,
  mediationKeyName,
  MemoryBackend,
  PLAIN_TYP,
  PROFILE,
  REQUEST_PROFILE,
  TRUST_PING,
  type ProtocolHandler,
  Vault,
  currentDid,
  currentMyDid,
  foldDeliveries,
  invitationUrl,
  mintPeerDid,
  parseInvitation,
  secretsResolverFor,
  type AgentStatus,
  type ContactRecord,
  type DeliveryEvent,
  type IMessage,
  type InvitationRecord,
  type MessageRecord,
  importVault,
  snapshotVault,
} from "../src/index.js";
import { chatView, history, type ChatMessage } from "./chat-view.js";
import { FakeMediator, MEDIATOR_HTTP, network } from "./fake-mediator.js";

const didcomm = { Message, FromPrior };
const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);

async function newMediator(): Promise<FakeMediator> {
  return new FakeMediator(await deriveIdentity(await importSeed(seedOf(200)), "anchor"));
}

interface Party {
  name: string;
  backend: MemoryBackend;
  vault: Vault;
  agent: Agent;
  seedKey: CryptoKey;
  statuses: AgentStatus[];
  messages: { record: MessageRecord; view: ChatMessage }[];
  deliveries: DeliveryEvent[];
  contacts: ContactRecord[];
  invitations: InvitationRecord[];
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
  mediator: Pick<FakeMediator, "fetch" | "WebSocket">,
  handlers: ProtocolHandler[] = []
): Party {
  const party = {
    name,
    backend,
    vault,
    seedKey,
    statuses: [],
    messages: [],
    deliveries: [],
    contacts: [],
    invitations: [],
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
    handlers,
    events: {
      onStatus(status) {
        party.statuses.push(status);
        if (status.state === "live") resolveLive();
      },
      onMessage(record, contact) {
        const view = chatView(record);
        if (view === null) return;
        if (contact !== null) view.contactCid = contact.cid;
        party.messages.push({ record, view });
        for (const w of [...waiters]) {
          if (w.pred(view)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(view);
          }
        }
      },
      onDelivery(event) {
        party.deliveries.push(event);
      },
      onContact(contact) {
        party.contacts.push(structuredClone(contact));
      },
      onInvitation(invitation) {
        party.invitations.push(structuredClone(invitation));
      },
      onLog(line) {
        party.log.push(line);
      },
    },
  });
  return party;
}

async function newParty(name: string, fill: number, mediator: FakeMediator, handlers: ProtocolHandler[] = []): Promise<Party> {
  const { backend, vault, seedKey } = await newVault(name, fill, mediator.did);
  return attach(name, backend, vault, seedKey, mediator, handlers);
}

/** The same vault, opened fresh from its bytes — a page reload. */
async function reopen(party: Party, mediator: Pick<FakeMediator, "fetch" | "WebSocket">): Promise<Party> {
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

/**
 * A send that could not be delivered: the record is in the log all the
 * same, not sent — its own try failed, or an earlier message to the same
 * contact did and it was not tried behind it — and the latest failure's
 * event says why. Resolves to the record.
 */
async function undelivered(party: Party, sending: Promise<MessageRecord>, error?: RegExp): Promise<MessageRecord> {
  const before = party.deliveries.length;
  const record = await sending;
  const own = party.deliveries.filter((e) => e.mid === record.mid).at(-1);
  expect(own?.status ?? "pending").not.toBe("sent");
  const failure = party.deliveries.slice(before).filter((e) => e.status === "failed").at(-1);
  expect(failure).toBeDefined();
  if (error !== undefined) expect(failure?.error).toMatch(error);
  return record;
}

/** The delivery state of `party`'s record, folded from the vault. */
async function deliveryOf(party: Party, mid: string) {
  return foldDeliveries(await party.vault.deliveries.read()).get(mid);
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
    expect(alice.vault.config.mediation?.public?.key).toBe(mediationKeyName(alice.vault.config.mediation!.id, "public"));
    expect(alice.vault.keystore.keys.map((k) => k.name)).toContain(alice.vault.config.mediation?.public?.key);
    expect(mediator.recipients.get(alice.agent.did as string)).toBe(alice.vault.config.mediation?.me.did);
    const aliceDoc = await resolveDIDCommDoc(alice.agent.did as string);
    expect(aliceDoc?.service[0]?.serviceEndpoint).toMatchObject({ uri: mediator.did });

    // Alice names Bob and writes; the intro (user-profile) rides ahead.
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    const sent = await alice.agent.sendBasicMessage(bob.agent.did as string, "hello bob");
    expect(sent.msg.type).toBe(BASIC_MESSAGE);
    expect(sent.direction).toBe("out");

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
    expect(alicesBobRecord.myDids?.[0]).toMatchObject({ did: aliceToBob, key: expect.stringMatching(`^${KEY_PAIRWISE_PREFIX}${alicesBobRecord.cid}/`) });
    expect(alicesBobRecord.myDids?.[0]?.registeredAt).toBeDefined();
    // Bob's copy of the thread is homed to his contact for Alice
    expect(got.contactCid).toBeDefined();

    // The stranger contact was created and then took Alice's claimed name;
    // send_back_yours made Bob introduce himself in return. Alice's first
    // message vouched for its fresh DID with her public one (from_prior),
    // so Bob's record for her opens with the public DID, closed — pasting
    // her business card later finds this contact instead of making a twin.
    const bobsAlice = await bob.vault.contacts.byDid(aliceToBob);
    expect(bobsAlice?.cid).toBe(got.contactCid);
    expect(bobsAlice?.dids.map((u) => u.did)).toEqual([alice.agent.did, aliceToBob]);
    expect(bobsAlice?.dids[0]?.until).toBeDefined();
    expect(bobsAlice?.dids[1]?.fromPrior).toMatch(/^eyJ/);
    expect((await bob.vault.contacts.byDid(alice.agent.did as string))?.cid).toBe(bobsAlice?.cid);
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
    expect(bobsAliceRecord.myDids?.map((u) => u.key)).toEqual([
      mediationKeyName(bob.vault.config.mediation!.id, "public"),
      expect.stringMatching(`^${KEY_PAIRWISE_PREFIX}${bobsAliceRecord.cid}/`),
    ]);
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
    const aliceHistory = await history(alice.agent);
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
    // and everything Alice sent went out from her DID toward Bob — the first
    // two vouched for by the public DID, the last not (Bob had written to it)
    expect(aliceLog.filter((r) => r.direction === "out").every((r) => r.msg.from === aliceToBob)).toBe(true);
    expect(aliceLog.filter((r) => r.direction === "out").map((r) => r.msg.from_prior !== undefined)).toEqual([true, true, false]);
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
    const replayed = await history(bob.agent);
    expect(replayed.filter((v) => v.kind === "chat").map((v) => v.content)).toEqual(["one", "two"]);
    expect(replayed.filter((v) => v.content === "one")).toHaveLength(1);
    // the reopened agent did not re-request mediation
    expect(mediator.seenTypes.filter((t) => t.endsWith("mediate-request"))).toHaveLength(2);

    alice.agent.destroy();
    bob.agent.destroy();
    alice = await reopen(alice, mediator);
    await alice.agent.start();
    await withTimeout(alice.live);
    expect((await history(alice.agent)).map((v) => v.content)).toEqual(["Alice", "one", "Bob", "two"]);
    alice.agent.destroy();
  });

  it("heals a mediation interrupted between recording the public DID and caching its key", async () => {
    const mediator = await newMediator();
    const { backend, vault, seedKey } = await newVault("Carol", 5, mediator.did);
    let carol = attach("Carol", backend, vault, seedKey, mediator);
    await carol.agent.start();
    await withTimeout(carol.live);
    const pub = carol.vault.config.mediation!.public!;
    expect(pub.key).toBe(mediationKeyName(carol.vault.config.mediation!.id, "public"));
    carol.agent.destroy();
    // The crash: config records the public DID, the keystore's cache never
    // heard of the key. The name is the derivation path, so nothing is lost.
    vault.keystore = { ...vault.keystore, keys: vault.keystore.keys.filter((k) => k.name !== pub.key) };
    await vault.saveKeystore();
    carol = await reopen(carol, mediator);
    await carol.agent.start();
    await withTimeout(carol.live);
    expect(carol.agent.did).toBe(pub.did);
    expect(carol.vault.config.mediation?.public).toEqual(pub);
    await expect(carol.vault.peerIdentity(seedKey, pub, mediator.did)).resolves.toMatchObject({ did: pub.did });
    // and the mediator did not have to be asked again
    expect(mediator.seenTypes.filter((t) => t.endsWith("mediate-request"))).toHaveLength(1);
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
    const voided = await undelivered(carol, carol.agent.sendBasicMessage(bob.agent.did as string, "into the void"), /fetch failed/);
    // the DID was minted and recorded, but the mediator never heard of it
    const record = (await carol.vault.contacts.byDid(bob.agent.did as string)) as ContactRecord;
    const use = currentMyDid(record);
    expect(use?.key).toMatch(new RegExp(`^${KEY_PAIRWISE_PREFIX}${record.cid}/`));
    expect(use?.registeredAt).toBeUndefined();
    expect(mediator.recipients.has(use?.did as string)).toBe(false);
    // the message is a fact in the log — written, not delivered: the
    // introduction and the message itself both wait in the outbox
    const outbound = (await carol.vault.messages.read()).filter((r) => r.direction === "out");
    expect(outbound.map((r) => r.msg.type)).toEqual([PROFILE, BASIC_MESSAGE]);
    // the introduction failed first — tried again ahead of the message, and
    // failed again — and the message was not even tried behind it
    expect(carol.deliveries.filter((e) => e.mid === outbound[0]!.mid).map((e) => e.status)).toEqual(["failed", "failed"]);
    expect(await deliveryOf(carol, voided.mid)).toBeUndefined();

    // the line comes back: the next send registers the same DID first, then
    // sends what waited, in order, then the new message
    cut = false;
    await carol.agent.sendBasicMessage(bob.agent.did as string, "hello from carol");
    await withTimeout(bob.next((v) => v.content === "hello from carol"));
    expect(bob.messages.filter((m) => m.view.kind === "chat").map((m) => m.view.content)).toEqual(["into the void", "hello from carol"]);
    expect((await deliveryOf(carol, voided.mid))?.status).toBe("sent");
    const after = (await carol.vault.contacts.byDid(bob.agent.did as string)) as ContactRecord;
    expect(after.myDids).toHaveLength(1);
    expect(currentMyDid(after)?.did).toBe(use?.did);
    expect(currentMyDid(after)?.registeredAt).toBeDefined();
    expect(mediator.recipients.get(use?.did as string)).toBe(carol.vault.config.mediation?.me.did);
    // and Bob can answer to it
    await bob.agent.sendBasicMessage(use?.did as string, "hi carol");
    await withTimeout(carol.next((v) => v.content === "hi carol"));

    // a start with unregistered DIDs on record registers them before
    // pickup, and sends what waited in the outbox
    const dan = await newParty("Dan", 10, mediator);
    await dan.agent.start();
    await withTimeout(dan.live);
    cut = true;
    await carol.agent.addContact(dan.agent.did as string, "Dan");
    const parked = await undelivered(carol, carol.agent.sendBasicMessage(dan.agent.did as string, "x"));
    const carolToDan = await myDidToward(carol, dan.agent.did as string);
    expect(mediator.recipients.has(carolToDan)).toBe(false);
    cut = false;
    const again = await reopen(carol, mediator);
    await again.agent.start();
    await withTimeout(again.live);
    expect(again.log).toContain("registering 1 pairwise DID(s) with the mediator");
    expect(mediator.recipients.get(carolToDan)).toBe(carol.vault.config.mediation?.me.did);
    expect(currentMyDid((await again.vault.contacts.byDid(dan.agent.did as string)) as ContactRecord)?.registeredAt).toBeDefined();
    await withTimeout(dan.next((v) => v.content === "x"));
    expect((await deliveryOf(again, parked.mid))?.status).toBe("sent");
    // the reload changed nothing about the record itself: same id on the wire
    expect(dan.messages.find((m) => m.view.content === "x")?.record.msg.id).toBe(parked.msg.id);

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
    // the mediator no longer accepts mail for that DID; the key stays listed (a name is never reused)
    expect(mediator.recipients.has(aliceToBob)).toBe(false);
    expect(alice.vault.keystore.keys.some((k) => k.name.startsWith(`${KEY_PAIRWISE_PREFIX}${record.cid}/`))).toBe(true);
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
    expect(issued.key).toBe(`${KEY_INVITE_PREFIX}${issued.id}`);
    expect(issued.did).toMatch(/^did:peer:4/);
    expect(issued.did).not.toBe(alice.agent.did);
    expect(issued.registeredAt).toBeDefined();
    expect(issued.acceptedBy).toBeUndefined();
    expect(issued.goal).toBe("Write to Alice");
    expect(mediator.recipients.get(issued.did)).toBe(alice.vault.config.mediation?.me.did);
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
    expect(bobsAlice.invitation).toBe(issued.id);
    expect(currentDid(bobsAlice)).toBe(issued.did);
    expect(bobsAlice.profileSharedAt).toBeDefined();
    const bobToAlice = currentMyDid(bobsAlice)?.did as string;
    expect(bobToAlice).toMatch(/^did:peer:4/);
    expect(bobToAlice).not.toBe(bob.agent.did);

    const intro = await withTimeout(alice.next((v) => v.kind === "profile"), 8000, "bob's intro");
    expect(intro.contactDid).toBe(bobToAlice);
    // the introduction answered the invitation the out-of-band way — pthid —
    // and vouched for nothing: neither side ever named a public DID
    const introRecord = alice.messages.find((m) => m.view.id === intro.id)?.record;
    expect(introRecord?.msg.pthid).toBe(issued.id);
    expect(introRecord?.msg.from_prior).toBeUndefined();

    // Alice's side: the invitation is taken by Bob's new contact record,
    // whose DID of hers is the invitation's — under its own key name
    await until(() => alice.invitations.some((i) => i.id === issued.id && i.acceptedBy !== undefined));
    const taken = (await alice.vault.invitations.byId(issued.id)) as InvitationRecord;
    const alicesBob = (await alice.vault.contacts.byDid(bobToAlice)) as ContactRecord;
    expect(taken.acceptedBy).toBe(alicesBob.cid);
    expect(alicesBob.dids.map((u) => u.did)).toEqual([bobToAlice]);
    expect(alicesBob.myDids).toHaveLength(1);
    expect(alicesBob.myDids?.[0]).toMatchObject({ did: issued.did, key: issued.key, registeredAt: issued.registeredAt });
    expect(alicesBob.addressedAs).toBe(issued.did);
    expect(alicesBob.name).toBe("Bob"); // his claimed name, the record was a placeholder

    // A conversation follows, from those two DIDs, with no from_prior anywhere
    await alice.agent.sendBasicMessage(bobToAlice, "you found me");
    const gotByBob = await withTimeout(bob.next((v) => v.content === "you found me"));
    expect(gotByBob.contactDid).toBe(issued.did);
    expect(gotByBob.contactCid).toBe(bobsAlice.cid);
    await bob.agent.sendBasicMessage(issued.did, "and you me");
    const gotByAlice = await withTimeout(alice.next((v) => v.content === "and you me"));
    expect(gotByAlice.contactCid).toBe(alicesBob.cid);
    for (const party of [alice, bob]) {
      for (const { record } of party.messages) {
        expect(record.msg.from_prior).toBeUndefined();
      }
    }
    expect((await alice.vault.contacts.byDid(bobToAlice))?.myDids).toHaveLength(1);
    expect(alice.messages.filter((m) => m.view.contactCid === alicesBob.cid).length).toBeGreaterThanOrEqual(3);

    // Carol got hold of the same URL: single-use, she is turned away
    await carol.agent.acceptInvitation(url, "Alice?");
    await until(() => alice.log.some((l) => l.includes("already taken")));
    expect(alice.messages.filter((m) => m.view.contactDid !== bobToAlice && m.view.direction === "received")).toHaveLength(0);
    expect(await alice.vault.contacts.all()).toHaveLength(1);

    // A restart re-derives the invitation's DID from the contact record
    const alice2 = await reopen(alice, mediator);
    await alice2.agent.start();
    await withTimeout(alice2.live);
    await bob.agent.sendBasicMessage(issued.did, "still there?");
    await withTimeout(alice2.next((v) => v.content === "still there?"));

    // Revoking: only open ones; a second invitation, withdrawn, is gone from the mediator
    await expect(alice2.agent.revokeInvitation(issued.id)).rejects.toThrow(/taken/);
    const second = await alice2.agent.createInvitation("Come talk");
    expect(second.goal).toBe("Come talk");
    expect(mediator.recipients.has(second.did)).toBe(true);
    await alice2.agent.revokeInvitation(second.id);
    expect(mediator.recipients.has(second.did)).toBe(false);
    expect(await alice2.vault.invitations.byId(second.id)).toBeNull();
    expect((await alice2.agent.invitations()).map((i) => i.id)).toEqual([issued.id]);
    await expect(carol.agent.acceptInvitation(
      invitationUrl("https://app.example/", alice2.agent.invitationMessage(second)), "Alice"
    )).resolves.toBeDefined();
    // Carol's answer to the revoked one bounces at the mediator; her side keeps the contact, the answer waits in her outbox
    expect(carol.log.some((l) => l.startsWith("could not deliver user-profile/1.0/profile"))).toBe(true);

    // a mediator's own invitation is not a person's
    const mediatorOob = { type: "https://didcomm.org/out-of-band/2.0/invitation", id: "m", typ: "application/didcomm-plain+json", from: mediator.did, body: { goal_code: "request-mediate" } };
    await expect(bob.agent.acceptInvitation(JSON.stringify(mediatorOob), "Med")).rejects.toThrow(/mediator's invitation/);

    alice2.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
  });

  it("registers an invitation issued while the mediator was unreachable at the next start", async () => {
    const mediator = await newMediator();
    const { backend, vault, seedKey } = await newVault("Dana", 34, mediator.did);
    let offline = false;
    const flaky: typeof fetch = (input, init) => {
      if (offline) return Promise.reject(new TypeError("fetch failed"));
      return mediator.fetch(input, init);
    };
    const dana = attach("Dana", backend, vault, seedKey, { ...mediator, fetch: flaky, WebSocket: mediator.WebSocket } as FakeMediator);
    await dana.agent.start();
    await withTimeout(dana.live);
    offline = true;
    await expect(dana.agent.createInvitation()).rejects.toThrow();
    // the record is there, unregistered — the URL is not usable yet
    const [pending] = await dana.vault.invitations.all();
    expect(pending?.registeredAt).toBeUndefined();
    expect(mediator.recipients.has(pending?.did as string)).toBe(false);
    offline = false;
    const dana2 = await reopen(dana, { ...mediator, fetch: flaky, WebSocket: mediator.WebSocket } as FakeMediator);
    await dana2.agent.start();
    await withTimeout(dana2.live);
    expect((await dana2.vault.invitations.byId(pending?.id as string))?.registeredAt).toBeDefined();
    expect(mediator.recipients.has(pending?.did as string)).toBe(true);
    dana2.agent.destroy();
  });

  it("reports an error status when the mediator does not resolve", async () => {
    const mediator = await newMediator();
    const { backend, vault, seedKey } = await newVault("Dan", 6, "did:web:nowhere.invalid");
    const dan = attach("Dan", backend, vault, seedKey, mediator);
    await dan.agent.start();
    expect(dan.agent.status).toEqual({ state: "error", detail: "mediator DID does not resolve" });
    await expect(dan.agent.sendBasicMessage("did:peer:4x", "x")).rejects.toThrow(/no public DID/);
    dan.agent.destroy();
  });

  it("comes up by itself once a mediator it could not reach at start is back", async () => {
    const mediator = await newMediator();
    const { backend, vault, seedKey } = await newVault("Eve", 7, mediator.did);
    let down = true;
    const flaky: typeof fetch = (input, init) =>
      down ? Promise.reject(new TypeError("fetch failed")) : mediator.fetch(input, init);
    const eve = attach("Eve", backend, vault, seedKey, { fetch: flaky, WebSocket: mediator.WebSocket });
    await eve.agent.start();
    expect(eve.agent.status.state).toBe("error");
    // the retries keep failing while it is down…
    await new Promise((r) => setTimeout(r, 60));
    expect(eve.agent.status.state).toBe("error");
    // …and the next one after it is back brings the agent up, no start() from outside
    down = false;
    await withTimeout(eve.live);
    expect(eve.agent.did?.startsWith("did:peer:4")).toBe(true);
    eve.agent.destroy();
  });

  it("moves to another mediator: every DID re-minted, contacts follow by from_prior, the old address dead", async () => {
    const one = await newMediator();
    const two = new FakeMediator(await deriveIdentity(await importSeed(seedOf(201)), "anchor"), "http://other-mediator/", "ws://other-mediator/ws");
    const net = network(one, two);
    const party = async (name: string, fill: number) => {
      const { backend, vault, seedKey } = await newVault(name, fill, one.did);
      return attach(name, backend, vault, seedKey, net);
    };
    let alice = await party("Alice", 41);
    const bob = await party("Bob", 42);
    const carol = await party("Carol", 43);
    const dan = await party("Dan", 44);
    await Promise.all([alice.agent.start(), bob.agent.start(), carol.agent.start(), dan.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live, carol.live, dan.live]));

    // Bob: a conversation both ways (he knows Alice by her pairwise DID)
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    await alice.agent.sendBasicMessage(bob.agent.did as string, "hello bob");
    await withTimeout(bob.next((v) => v.content === "hello bob"));
    const aliceToBob1 = await myDidToward(alice, bob.agent.did as string);
    await bob.agent.sendBasicMessage(aliceToBob1, "hi alice");
    await withTimeout(alice.next((v) => v.content === "hi alice"));
    // Carol: wrote to Alice's public DID; Alice's only answer was the automatic
    // profile (from a pairwise DID), so Carol has never written to anything but the public one
    await carol.agent.sendBasicMessage(alice.agent.did as string, "hey, stranger");
    await withTimeout(alice.next((v) => v.content === "hey, stranger"));
    await withTimeout(carol.next((v) => v.kind === "profile" && v.direction === "received"));
    const aliceToCarol1 = await myDidToward(alice, carol.agent.did as string);
    // Dan: came in through an invitation of Alice's; a second one stays open
    const invitation = await alice.agent.createInvitation();
    await dan.agent.acceptInvitation(invitationUrl("https://estoc.example/", alice.agent.invitationMessage(invitation)), "Alice");
    await withTimeout(until(() => alice.invitations.some((i) => i.id === invitation.id && i.acceptedBy !== undefined)));
    await withTimeout(dan.next((v) => v.kind === "profile" && v.direction === "received"));
    const open = await alice.agent.createInvitation();
    const alicePub1 = alice.agent.did as string;
    const before = alice.vault.config.mediation!;
    // Alice knows Dan by the DID he minted toward her, never his public one
    const danDid = await myDidToward(dan, invitation.did);
    const aliceToDan1 = await myDidToward(alice, danDid);
    expect(aliceToDan1).toBe(invitation.did);
    expect(one.recipients.has(alicePub1)).toBe(true);
    expect(one.recipients.has(open.did)).toBe(true);

    // the move
    await alice.agent.setMediator(two.did);
    await withTimeout(until(() => alice.agent.status.state === "live"));
    const mediation = alice.vault.config.mediation!;
    expect(mediation.mediatorDid).toBe(two.did);
    expect(mediation.id).not.toBe(before.id);
    expect(mediation.me.key).toBe(mediationKeyName(mediation.id, "me"));
    expect(mediation.public?.key).toBe(mediationKeyName(mediation.id, "public"));
    expect(mediation.routingDid).toBe(two.did);
    const alicePub2 = alice.agent.did as string;
    expect(alicePub2).not.toBe(alicePub1);
    expect((await resolveDIDCommDoc(alicePub2))?.service[0]?.serviceEndpoint).toMatchObject({ uri: two.did });
    // fresh DIDs toward Bob and Dan, on the new routing DID, registered there
    const aliceToBob2 = await myDidToward(alice, bob.agent.did as string);
    const aliceToDan2 = await myDidToward(alice, danDid);
    expect(aliceToBob2).not.toBe(aliceToBob1);
    expect(aliceToDan2).not.toBe(aliceToDan1);
    expect(aliceToDan2.startsWith("did:peer:4")).toBe(true);
    for (const did of [alicePub2, aliceToBob2, aliceToDan2]) {
      expect((await resolveDIDCommDoc(did))?.service[0]?.serviceEndpoint).toMatchObject({ uri: two.did });
      expect(two.recipients.get(did)).toBe(mediation.me.did);
    }
    // the old mediator was asked to drop everything, the open link is withdrawn
    for (const did of [alicePub1, aliceToBob1, aliceToDan1, open.did]) {
      expect(one.recipients.has(did)).toBe(false);
    }
    expect((await alice.agent.invitations()).map((i) => i.id)).toEqual([invitation.id]);
    expect(alice.log).toContain("withdrew 1 open invitation link(s); they led to the old mediator");
    expect(alice.log).toContain("minted a fresh DID toward 3 contact(s); the old ones named the old mediator");
    // Carol's history on Alice's side: the retired public DID, the first pairwise one, the new one
    const aliceToCarol2 = await myDidToward(alice, carol.agent.did as string);
    const carolRecord = (await alice.vault.contacts.byDid(carol.agent.did as string))!;
    expect(carolRecord.myDids?.map((u) => [u.did, u.until === undefined])).toEqual([[alicePub1, false], [aliceToCarol1, false], [aliceToCarol2, true]]);
    expect(carolRecord.addressedAs).toBe(alicePub1);

    // Bob and Dan were pinged from the new DIDs and moved by from_prior — no message from Alice needed
    await withTimeout(until(() => bob.log.some((l) => l.endsWith("moved to a new DID, vouched for by the old one"))), 8000, "Bob's rotation");
    await withTimeout(until(() => dan.log.some((l) => l.endsWith("moved to a new DID, vouched for by the old one"))), 8000, "Dan's rotation");
    await withTimeout(until(() => carol.log.some((l) => l.endsWith("moved to a new DID, vouched for by the old one"))), 8000, "Carol's rotation");
    const bobsAlice = (await bob.vault.contacts.byDid(aliceToBob2))!;
    expect(currentDid(bobsAlice)).toBe(aliceToBob2);
    expect(bobsAlice.dids.map((d) => d.did)).toEqual([alicePub1, aliceToBob1, aliceToBob2]);
    expect(bobsAlice.dids.at(-1)?.fromPrior).toBeDefined();
    expect(bob.log).toContain("Alice pinged us");
    const dansAlice = (await dan.vault.contacts.byDid(aliceToDan2))!;
    expect(dansAlice.dids.map((d) => d.did)).toEqual([aliceToDan1, aliceToDan2]);
    // the ping is a fact between contacts, so it is in both logs — Alice's
    // as sent, Bob's as received from the new DID; showing it or not is
    // the application's projection (chatView here yields nothing for it)
    const bobsPing = (await bob.vault.messages.read()).filter((r) => r.msg.type === TRUST_PING);
    expect(bobsPing.map((r) => [r.direction, r.sender])).toEqual([["in", aliceToBob2]]);
    expect((await alice.vault.messages.read()).filter((r) => r.msg.type === TRUST_PING && r.direction === "out")).toHaveLength(3);
    expect(bob.messages.some((m) => m.record.msg.type === TRUST_PING)).toBe(false);

    // they write to the new DIDs; the mail arrives through the new mediator
    await bob.agent.sendBasicMessage(aliceToBob2, "still there?");
    await withTimeout(alice.next((v) => v.content === "still there?"));
    expect((await alice.vault.contacts.byDid(bob.agent.did as string))?.addressedAs).toBe(aliceToBob2);
    await dan.agent.sendBasicMessage(aliceToDan2, "found you");
    await withTimeout(alice.next((v) => v.content === "found you"));
    // Carol, who only ever wrote to the retired public DID, was vouched to by it — signed after it stopped being ours to receive at
    const carolsAlice = (await carol.vault.contacts.byDid(aliceToCarol2))!;
    expect(carolsAlice.dids.map((d) => d.did)).toEqual([alicePub1, aliceToCarol1, aliceToCarol2]);
    await alice.agent.sendBasicMessage(carol.agent.did as string, "who is this?");
    await withTimeout(carol.next((v) => v.content === "who is this?"));
    await carol.agent.sendBasicMessage(aliceToCarol2, "it's carol");
    await withTimeout(alice.next((v) => v.content === "it's carol"));

    // the old business card: for Bob, who knows Alice, it still finds her (and goes to her current DID);
    // for someone who only ever held the card, it is dead — the old mediator bounces it
    await bob.agent.sendBasicMessage(alicePub1, "old card, same alice");
    await withTimeout(alice.next((v) => v.content === "old card, same alice"));
    await undelivered(dan, dan.agent.sendBasicMessage(alicePub1, "old card"));
    // the same mediator again is refused, nothing torn down
    await expect(alice.agent.setMediator(two.did)).rejects.toThrow(/already reached via/);
    expect(alice.agent.status.state).toBe("live");

    // a restart finds nothing stale and still receives
    alice = await reopen(alice, net);
    await alice.agent.start();
    await withTimeout(alice.live);
    expect(alice.log.some((l) => l.startsWith("minted a fresh DID toward"))).toBe(false);
    expect(alice.vault.config.mediation).toEqual(mediation);
    await bob.agent.sendBasicMessage(aliceToBob2, "after reload");
    await withTimeout(alice.next((v) => v.content === "after reload"));

    for (const p of [alice, bob, carol, dan]) p.agent.destroy();
  });

  it("heals a move interrupted before the DIDs were re-minted at the next start", async () => {
    const one = await newMediator();
    const two = new FakeMediator(await deriveIdentity(await importSeed(seedOf(202)), "anchor"), "http://other-mediator/", "ws://other-mediator/ws");
    const net = network(one, two);
    const { backend, vault, seedKey } = await newVault("Alice", 45, one.did);
    let alice = attach("Alice", backend, vault, seedKey, net);
    const bobVault = await newVault("Bob", 46, one.did);
    const bob = attach("Bob", bobVault.backend, bobVault.vault, bobVault.seedKey, net);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "hello");
    await withTimeout(bob.next((v) => v.content === "hello"));
    const aliceToBob1 = await myDidToward(alice, bob.agent.did as string);

    // the vault recorded the move; the process died before mediation and rotation
    alice.agent.destroy();
    await alice.vault.setMediator(alice.seedKey, two.did);
    alice = await reopen(alice, net);
    await alice.agent.start();
    await withTimeout(alice.live);
    expect(alice.log).toContain("minted a fresh DID toward 1 contact(s); the old ones named the old mediator");
    const aliceToBob2 = await myDidToward(alice, bob.agent.did as string);
    expect(aliceToBob2).not.toBe(aliceToBob1);
    expect(two.recipients.has(aliceToBob2)).toBe(true);
    await withTimeout(until(() => bob.log.some((l) => l.endsWith("moved to a new DID, vouched for by the old one"))), 8000, "Bob's rotation");
    await bob.agent.sendBasicMessage(aliceToBob2, "found you");
    await withTimeout(alice.next((v) => v.content === "found you"));
    alice.agent.destroy();
    bob.agent.destroy();
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
  const identity = await deriveIdentity(await importSeed(seedOf(fill)), "anchor");
  return mintPeerDid(identity, endpoint);
}

const plain = (type: string, from: string | null, to: string, body: Record<string, unknown>) =>
  ({ id: crypto.randomUUID(), typ: PLAIN_TYP, type, ...(from === null ? {} : { from }), to: [to], created_time: Math.floor(Date.now() / 1000), body }) as IMessage;

describe("Agent with application protocols", () => {
  it("logs every message between contacts whatever its type, and lets a handler answer inside its protocol", async () => {
    const POLL = "https://estoc.dev/poll/1.0/question";
    const VOTE = "https://estoc.dev/poll/1.0/vote";
    const mediator = await newMediator();
    const alice = await newParty("Alice", 21, mediator);
    // Bob's application speaks a poll protocol: a question gets a vote back on the thread
    const seenByHandler: string[] = [];
    const bob = await newParty("Bob", 22, mediator, [
      {
        types: [POLL, VOTE],
        async onInbound(record, contact, agent) {
          seenByHandler.push(`${contact.name}:${record.msg.type}`);
          if (record.msg.type === POLL) {
            await agent.reply(contact, VOTE, { choice: (record.msg.body.options as string[])[1] }, { thid: record.msg.id });
          }
        },
      },
    ]);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));

    // Alice, whose agent has no poll handler, still sends one: `send` takes any type
    const question = await alice.agent.send(bob.agent.did as string, POLL, { question: "lunch?", options: ["rice", "noodles"] });
    expect(question.msg.type).toBe(POLL);
    const aliceToBob = await myDidToward(alice, bob.agent.did as string);

    // Bob's handler saw it under Alice's contact and voted on the thread;
    // Alice logged the vote though nothing of hers handles it.
    await withTimeout(until(() => alice.log.some((l) => l.startsWith(`received a ${VOTE} message from`) && l.endsWith("logged, no handler for it"))));
    // (Alice's introduction arrived first, so the handler already saw her by name)
    expect(seenByHandler).toEqual([`Alice:${POLL}`]);
    const aliceLog = await alice.vault.messages.read();
    const vote = aliceLog.find((r) => r.msg.type === VOTE);
    expect(vote?.direction).toBe("in");
    expect(vote?.sender).toBe(await myDidToward(bob, aliceToBob));
    expect(vote?.msg.thid).toBe(question.msg.id);
    expect(vote?.msg.body).toEqual({ choice: "noodles" });
    // the introduction still preceded the first message, and every fact is in order
    expect(aliceLog.map((r) => `${r.direction}:${r.msg.type.split("/").at(-1)}`)).toEqual([
      "out:profile",
      "out:question",
      "in:profile",
      "in:vote",
    ]);
    // the application saw the vote through onMessage, homed to Bob, and chatView (rightly) made nothing of it
    expect(alice.messages.every((m) => m.record.msg.type !== VOTE)).toBe(true);
    alice.agent.destroy();
    bob.agent.destroy();
  });
});

describe("Agent with an outbox", () => {
  /** A party whose line to the mediator can be cut and restored. */
  async function flakyParty(name: string, fill: number, mediator: FakeMediator) {
    const { backend, vault, seedKey } = await newVault(name, fill, mediator.did);
    const line = { cut: false };
    const flaky: typeof fetch = (input, init) => {
      if (line.cut) return Promise.reject(new TypeError("fetch failed"));
      return mediator.fetch(input, init);
    };
    const party = attach(name, backend, vault, seedKey, { fetch: flaky, WebSocket: mediator.WebSocket });
    return { party, line };
  }

  it("keeps what is written offline, sends it in order when the socket comes back, and never twice", async () => {
    const mediator = await newMediator();
    const { party: alice, line } = await flakyParty("Alice", 51, mediator);
    const bob = await newParty("Bob", 52, mediator);
    const carol = await newParty("Carol", 53, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start(), carol.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live, carol.live]));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "one");
    await withTimeout(bob.next((v) => v.content === "one"));

    // offline: two to Bob, one to Carol (never written to before: her
    // introduction waits too). Every send resolves; every record is logged;
    // nothing is sent.
    line.cut = true;
    const two = await undelivered(alice, alice.agent.sendBasicMessage(bob.agent.did as string, "two"), /fetch failed/);
    const three = await undelivered(alice, alice.agent.sendBasicMessage(bob.agent.did as string, "three"));
    const toCarol = await undelivered(alice, alice.agent.sendBasicMessage(carol.agent.did as string, "hi carol"));
    expect(alice.messages.filter((m) => m.view.kind === "chat" && m.view.direction === "sent").map((m) => m.view.content)).toEqual(["one", "two", "three", "hi carol"]);
    // "two" was tried (and failed) twice: once on its own send, once ahead
    // of "three" — which itself was never tried, so as not to overtake it
    expect(alice.deliveries.filter((e) => e.mid === two.mid).map((e) => e.status)).toEqual(["failed", "failed"]);
    expect(await deliveryOf(alice, three.mid)).toBeUndefined();
    expect((await deliveryOf(alice, two.mid))?.error).toMatch(/fetch failed/);

    // the line comes back and the mediator drops Alice's socket: the
    // reconnect drains the outbox, in order per contact
    line.cut = false;
    mediator.dropSocket(alice.vault.config.mediation!.me.did);
    await withTimeout(bob.next((v) => v.content === "three"));
    await withTimeout(carol.next((v) => v.content === "hi carol"));
    expect(bob.messages.filter((m) => m.view.kind === "chat").map((m) => m.view.content)).toEqual(["one", "two", "three"]);
    // Carol was introduced first, then written to
    expect(carol.messages.filter((m) => m.view.direction === "received").map((m) => m.view.kind)).toEqual(["profile", "chat"]);
    for (const record of [two, three, toCarol]) {
      expect((await deliveryOf(alice, record.mid))?.status).toBe("sent");
    }
    // the wire ids never changed across the retries
    expect(bob.messages.find((m) => m.view.content === "two")?.record.msg.id).toBe(two.msg.id);
    // and a try that reached Bob but looked failed to Alice is not a second message for Bob
    const inner = mediator.fetch;
    let dropAnswerOnce = true;
    (mediator as { fetch: typeof fetch }).fetch = async (input, init) => {
      const response = await inner(input, init);
      if (dropAnswerOnce && String(init?.body).includes("ciphertext")) {
        dropAnswerOnce = false;
        throw new TypeError("connection reset after the POST");
      }
      return response;
    };
    const four = await undelivered(alice, alice.agent.sendBasicMessage(bob.agent.did as string, "four"), /connection reset/);
    await withTimeout(bob.next((v) => v.content === "four"));
    // by hand: the retry goes, and Bob keeps one "four"
    expect((await alice.agent.retry(four.mid)).status).toBe("sent");
    await alice.agent.sendBasicMessage(bob.agent.did as string, "five");
    await withTimeout(bob.next((v) => v.content === "five"));
    expect(bob.messages.filter((m) => m.view.content === "four")).toHaveLength(1);
    expect((await bob.vault.messages.read()).filter((r) => (r.msg.body as { content?: string }).content === "four")).toHaveLength(1);
    await expect(alice.agent.retry(four.mid)).rejects.toThrow(/not waiting/);

    alice.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
  });

  it("does not send what an import brought in undelivered until asked by hand", async () => {
    const mediator = await newMediator();
    const { party: alice, line } = await flakyParty("Alice", 54, mediator);
    const bob = await newParty("Bob", 55, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]));
    await alice.agent.sendBasicMessage(bob.agent.did as string, "sent before the backup");
    await withTimeout(bob.next((v) => v.content === "sent before the backup"));
    line.cut = true;
    const stuck = await undelivered(alice, alice.agent.sendBasicMessage(bob.agent.did as string, "written offline"));
    const files = await snapshotVault(alice.backend);
    alice.agent.destroy();

    // restored on another device (same seed, so every DID derives): the
    // start does not send it, though the line is up
    const other = new MemoryBackend();
    expect(await importVault(other, files)).toMatchObject({ kind: "restored", held: 1 });
    const again = attach("Alice again", other, await Vault.open(other), alice.seedKey, mediator);
    await again.agent.start();
    await withTimeout(again.live);
    await new Promise((r) => setTimeout(r, 50));
    expect(bob.messages.some((m) => m.view.content === "written offline")).toBe(false);
    expect((await deliveryOf(again, stuck.mid))).toMatchObject({ status: "held", attempts: 1 });
    // a new message to Bob goes, and does not drag the held one along
    await again.agent.sendBasicMessage(bob.agent.did as string, "from the new device");
    await withTimeout(bob.next((v) => v.content === "from the new device"));
    expect(bob.messages.some((m) => m.view.content === "written offline")).toBe(false);
    // by hand it goes — from the DID it was written from, which this device derives too
    expect((await again.agent.retry(stuck.mid))).toMatchObject({ status: "sent", attempt: 2 });
    await withTimeout(bob.next((v) => v.content === "written offline"));
    expect((await deliveryOf(again, stuck.mid))?.status).toBe("sent");

    again.agent.destroy();
    bob.agent.destroy();
  });
});

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
    expect((await history(bob.agent)).map((v) => v.content)).not.toContain("forged");
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
    expect(bob.log.some((l) => l.startsWith("could not deliver user-profile/1.0/profile"))).toBe(true);
    expect(bob.log).toContain(`logged an anonymous ${REQUEST_PROFILE} message; it is attributed to nobody`);
    // the proven asker became a contact and got an answer — logged, waiting
    // in the outbox since her endpoint is dead; nothing for the anonymous one
    expect(await bob.vault.contacts.byDid(mallory.did)).not.toBeNull();
    const log = await bob.vault.messages.read();
    const answers = log.filter((r) => r.direction === "out");
    expect(answers.map((r) => [r.msg.type, r.msg.to?.[0]])).toEqual([[PROFILE, mallory.did]]);
    expect((await deliveryOf(bob, answers[0]!.mid))?.status).toBe("failed");
    // both asks are facts in the log — one attributed, one not
    expect(log.filter((r) => r.msg.type === REQUEST_PROFILE).map((r) => r.sender)).toEqual([mallory.did, null]);
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
    expect((await history(bob.agent)).filter((v) => v.direction === "received").map((v) => v.content)).toEqual(["Alice", "after the garbage"]);
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
    expect((await history(bob.agent)).filter((v) => v.kind === "chat").map((v) => v.content)).toEqual(["before", "during", "after"]);
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
    const chats = (await history(bob.agent)).filter((v) => v.kind === "chat").map((v) => v.content);
    expect(chats.sort()).toEqual([...texts].sort());
    alice.agent.destroy();
    bob.agent.destroy();
  });
});

describe("Agent sharing objects", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const files = {
    "index.json": enc(JSON.stringify({ format: "https://estoc.dev/post/1.0", id: "01900000-0000-7000-8000-000000000000", name: "Sea day" })),
    "files/body.dj": enc("# Sea day\n\nWaves.\n"),
    "files/images/dot.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]),
  };
  const object = readObject(files);

  async function eventually(cond: () => Promise<boolean>, what: string): Promise<void> {
    await withTimeout(
      (async () => {
        while (!(await cond())) await new Promise((r) => setTimeout(r, 5));
      })(),
      8000,
      what
    );
  }

  async function connected(): Promise<{ mediator: FakeMediator; alice: Party; bob: Party }> {
    const mediator = await newMediator();
    const alice = await newParty("Alice", 1, mediator);
    const bob = await newParty("Bob", 2, mediator);
    await Promise.all([alice.agent.start(), bob.agent.start()]);
    await withTimeout(Promise.all([alice.live, bob.live]), 8000, "both live");
    await alice.agent.addContact(bob.agent.did as string, "Bob");
    return { mediator, alice, bob };
  }

  it("hands a contact a whole tree in one message, signed by the anchor, kept block by block", async () => {
    const { alice, bob } = await connected();
    const { root, blocks } = await closureOf(files);
    expect(blocks.size).toBe(6); // three directory nodes, three raw files
    const sent = await alice.agent.shareObject(bob.agent.did as string, object);
    expect(sent.msg.type).toBe(OBJECT_SHARE);
    expect(sent.msg.attachments).toHaveLength(blocks.size);
    // the sender keeps the blocks too
    expect(await alice.vault.blobs.has(root)).toBe(true);

    await eventually(() => bob.vault.blobs.has(root), "bob's copy");
    for (const cid of blocks.keys()) {
      expect(await bob.vault.blobs.has(cid)).toBe(true);
    }
    const fromBlobs = new Map<string, Uint8Array>();
    for (const cid of await bob.vault.blobs.list()) {
      fromBlobs.set(cid, (await bob.vault.blobs.get(cid)) as Uint8Array);
    }
    const tree = await verifyTree(root, fromBlobs);
    expect([...tree.files.keys()].sort()).toEqual(["files/body.dj", "files/images/dot.png", "index.json"]);

    // the record is in Bob's log, and its card names Alice's anchor — not
    // the pairwise DID the envelope came from
    const record = (await bob.vault.messages.read()).find((r) => r.msg.type === OBJECT_SHARE) as MessageRecord;
    const share = await verifyShare(record.msg);
    expect(share.card).toEqual({ did: alice.vault.config.identity.anchor.did, root });
    expect(share.card.did).toMatch(/^did:key:/);
    expect(share.object.meta.name).toBe("Sea day");
    expect(bob.log.some((l) => /post\/1.0 .* from .*: 3 files kept/.test(l))).toBe(true);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("passes a signed object on under its author's card, and refuses a card about another object", async () => {
    const { mediator, alice, bob } = await connected();
    const carol = await newParty("Carol", 3, mediator);
    await carol.agent.start();
    await withTimeout(carol.live, 8000, "carol live");
    const { root } = await closureOf(files);
    await alice.agent.shareObject(bob.agent.did as string, object);
    await eventually(() => bob.vault.blobs.has(root), "bob's copy");
    const record = (await bob.vault.messages.read()).find((r) => r.msg.type === OBJECT_SHARE) as MessageRecord;
    const card = (record.msg.body as { card: string }).card;

    await bob.agent.addContact(carol.agent.did as string, "Carol");
    await bob.agent.shareObject(carol.agent.did as string, object, { card });
    await eventually(() => carol.vault.blobs.has(root), "carol's copy");
    const carols = (await carol.vault.messages.read()).find((r) => r.msg.type === OBJECT_SHARE) as MessageRecord;
    expect((await verifyShare(carols.msg)).card.did).toBe(alice.vault.config.identity.anchor.did);

    await expect(
      bob.agent.shareObject(carol.agent.did as string, readObject({ ...files, "files/body.dj": enc("edited") }), { card })
    ).rejects.toThrow(/not this object/);
    alice.agent.destroy();
    bob.agent.destroy();
    carol.agent.destroy();
  });

  it("logs but does not keep a share whose blocks do not match its card", async () => {
    const { alice, bob } = await connected();
    const { root, blocks } = await closureOf(files);
    const anchor = alice.vault.config.identity.anchor;
    const card = await signRoot(anchor.did, root, (await alice.vault.derive(alice.seedKey, anchor.key)).signer);
    const attachments = attachmentsOf(blocks).map((a) =>
      a.media_type === RAW_MEDIA_TYPE && a.byte_count === files["files/body.dj"].length
        ? { ...a, data: { base64: attachmentsOf(new Map([[a.id, enc("# Forged\n")]]))[0]!.data.base64 } }
        : a
    );
    await alice.agent.send(bob.agent.did as string, OBJECT_SHARE, { card }, { attachments });
    await eventually(async () => bob.log.some((l) => /does not verify/.test(l)), "bob's refusal");
    expect(await bob.vault.blobs.list()).toEqual([]);
    expect((await bob.vault.messages.read()).some((r) => r.msg.type === OBJECT_SHARE)).toBe(true);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("does not keep a well-hashed tree that is not an object", async () => {
    const { alice, bob } = await connected();
    const notAnObject = { "readme.txt": enc("just a folder") };
    const { root, blocks } = await closureOf(notAnObject);
    const anchor = alice.vault.config.identity.anchor;
    const card = await signRoot(anchor.did, root, (await alice.vault.derive(alice.seedKey, anchor.key)).signer);
    await alice.agent.send(bob.agent.did as string, OBJECT_SHARE, { card }, { attachments: attachmentsOf(blocks) });
    await eventually(async () => bob.log.some((l) => /does not verify: malformed object/.test(l)), "bob's refusal");
    expect(await bob.vault.blobs.list()).toEqual([]);
    alice.agent.destroy();
    bob.agent.destroy();
  });

  it("refuses to share more than one message should carry", async () => {
    const mediator = await newMediator();
    const { backend, vault, seedKey } = await newVault("Alice", 1, mediator.did);
    const alice = attach("Alice", backend, vault, seedKey, mediator);
    const bob = await newParty("Bob", 2, mediator);
    alice.agent.destroy();
    const small = new Agent({
      vault,
      seedKey,
      didcomm,
      resolveDid: resolveDIDCommDoc,
      fetch: mediator.fetch,
      WebSocket: mediator.WebSocket,
      maxShareBytes: 16,
    });
    await Promise.all([small.start(), bob.agent.start()]);
    await withTimeout(bob.live, 8000, "bob live");
    await until(() => small.did !== null);
    await expect(small.shareObject(bob.agent.did as string, object)).rejects.toThrow(/at most 16/);
    small.destroy();
    bob.agent.destroy();
  });
});
