import { describe, expect, it } from "vitest";
import { Message } from "didcomm-node";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";
import { resolveDIDCommDoc } from "@estoc/did-peer";

import {
  Agent,
  BASIC_MESSAGE,
  KEY_PUBLIC,
  MemoryBackend,
  PROFILE,
  Vault,
  type AgentStatus,
  type ChatMessage,
  type ContactRecord,
  type MessageRecord,
} from "../src/index.js";
import { FakeMediator } from "./fake-mediator.js";

const didcomm = { Message };
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

describe("Agent through a mediator", () => {
  it("mediates, exchanges basic messages and profiles, and shows every layer", async () => {
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
    expect(sent.layers.map((l) => l.kind)).toEqual(["plaintext", "authcrypt", "forward", "anoncrypt"]);

    // Bob receives it live: outer, delivery, inner, plain.
    const got = await withTimeout(bob.next((v) => v.kind === "chat" && v.content === "hello bob"), 8000, "bob's chat");
    expect(got.direction).toBe("received");
    expect(got.contactDid).toBe(alice.agent.did);
    expect(got.layers.map((l) => l.kind)).toEqual(["authcrypt", "plaintext", "authcrypt", "plaintext"]);

    // The stranger contact was created and then took Alice's claimed name;
    // send_back_yours made Bob introduce himself in return.
    const bobsAlice = await bob.vault.contacts.byDid(alice.agent.did as string);
    expect(bobsAlice?.name).toBe("Alice");
    expect(bobsAlice?.claimedName).toBe("Alice");
    expect(bobsAlice?.profileSharedAt).toBeDefined();
    const bobsIntro = await withTimeout(alice.next((v) => v.kind === "profile" && v.direction === "received"), 8000, "bob's intro");
    expect(bobsIntro.content).toBe("Bob");
    const alicesBob = await alice.vault.contacts.byDid(bob.agent.did as string);
    // Alice typed "Bob" herself, so the claim is remembered but does not rename.
    expect(alicesBob?.name).toBe("Bob");
    expect(alicesBob?.claimedName).toBe("Bob");

    // Bob replies; Alice receives.
    await bob.agent.sendBasicMessage(alice.agent.did as string, "hi alice");
    const reply = await withTimeout(alice.next((v) => v.content === "hi alice"), 8000, "alice's reply");
    expect(reply.direction).toBe("received");

    // The logs hold the facts: Alice sent profile+chat, got profile+chat.
    const aliceLog = await alice.vault.messages.read();
    expect(aliceLog.map((r) => `${r.direction}:${r.msg.type === PROFILE ? "profile" : "chat"}`)).toEqual([
      "out:profile",
      "out:chat",
      "in:profile",
      "in:chat",
    ]);
    // inbound records carry the envelope-proven sender
    expect(aliceLog.filter((r) => r.direction === "in").every((r) => r.sender === bob.agent.did)).toBe(true);
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

  it("reports an error status when the mediator does not resolve", async () => {
    const mediator = await newMediator();
    const { backend, vault, seedKey } = await newVault("Dan", 6, "did:web:nowhere.invalid");
    const dan = attach("Dan", backend, vault, seedKey, mediator);
    await dan.agent.start();
    expect(dan.agent.status).toEqual({ state: "error", detail: "mediator DID does not resolve" });
    await expect(dan.agent.sendBasicMessage("did:peer:4x", "x")).rejects.toThrow(/no public DID/);
  });
});
