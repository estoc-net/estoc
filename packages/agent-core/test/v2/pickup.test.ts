import { describe, expect, it } from "vitest";
import { FromPrior, Message } from "didcomm-node";

import { resolveDIDCommDoc, type DIDDoc } from "@estoc/did-peer";
import { MemoryBackend } from "@estoc/event-store";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";

import {
  BASIC_MESSAGE,
  DELIVERY,
  DELIVERY_REQUEST,
  FORWARD,
  LIVE_DELIVERY_CHANGE,
  MESSAGES_RECEIVED,
  PLAIN_TYP,
  RECIPIENT_UPDATE,
  STATUS,
  STATUS_REQUEST,
  secretsResolverFor,
  type IMessage,
} from "../../src/index.js";
import {
  AgentTrace,
  Keyring,
  MediatorLink,
  Pickup,
  createVault,
  type Fate,
  type LinkOptions,
  type MyIdentity,
  type Opened,
  type PeerVault,
  type PickupOptions,
  type TraceEvent,
} from "../../src/v2/index.js";
import { FakeMediator, mintMediatorIdentity, type FakeSocket } from "../fake-mediator.js";

const didcomm = { Message, FromPrior };
const seedOf = (fill: number) => new Uint8Array(32).map((_, i) => (i * 7 + fill) & 0xff);
const resolver = { resolve: resolveDIDCommDoc };

async function mediatorIdentity() {
  return deriveIdentity(await importSeed(seedOf(200)), "anchor");
}

async function newMediator(): Promise<FakeMediator> {
  return new FakeMediator(await mediatorIdentity());
}

interface Party {
  v: PeerVault;
  ring: Keyring;
  me: MyIdentity;
  trace: AgentTrace;
  link: MediatorLink;
  log: string[];
  /** every envelope this party POSTed, for reading what it told the mediator */
  posted: string[];
  /** the sockets its link opened, for pushing a frame down one */
  sockets: FakeSocket[];
}

/** A vault with a mediation toward `mediator`, its `me` known to the mediator as a recipient, and a link over it. */
async function party(mediator: FakeMediator, fill: number, over: Partial<LinkOptions> = {}): Promise<Party> {
  const { doc, seedKey } = await createSeedKeystore("test", { seed: seedOf(fill) });
  const v = await createVault(new MemoryBackend(), { keystore: doc, seedKey, label: `party ${fill}` });
  const ring = await Keyring.load(v);
  const { me } = await ring.createMediation(mediator.did);
  const trace = await AgentTrace.open(v.vault.local("agent"));
  const log: string[] = [];
  const posted: string[] = [];
  const sockets: FakeSocket[] = [];
  const link = new MediatorLink({
    didcomm,
    resolveDid: resolveDIDCommDoc,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(String(init?.body));
      return mediator.fetch(input, init);
    }) as typeof fetch,
    WebSocket: class extends mediator.WebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this as unknown as FakeSocket);
      }
    } as typeof WebSocket,
    trace,
    secrets: () => ring.secrets(),
    me: () => me.identity,
    mediatorDid: mediator.did,
    mediatorDoc: (await resolveDIDCommDoc(mediator.did)) as DIDDoc,
    log: (line) => log.push(line),
    ...over,
  });
  await link.roundTrip(RECIPIENT_UPDATE, { updates: [{ recipient_did: me.identity.did, action: "add" }] });
  return { v, ring, me, trace, link, log, posted, sockets };
}

function plain(type: string, from: string | null, to: string, body: Record<string, unknown>): IMessage {
  return { id: crypto.randomUUID(), typ: PLAIN_TYP, type, ...(from === null ? {} : { from }), to: [to], created_time: 1, body } as IMessage;
}

/**
 * `from` writes to `to` through the mediator: a basic message sealed to
 * `sealedTo` (their DID, unless the test wants mail the recipient cannot
 * open), inside an anonymous forward to the mediator naming `to`.
 */
async function post(mediator: FakeMediator, from: Party, to: Party, content: string, sealedTo = to.me.identity.did): Promise<void> {
  const mail = await from.link.seal(plain(BASIC_MESSAGE, from.me.identity.did, sealedTo, { content }), sealedTo, from.me.identity.did);
  const forward = { ...plain(FORWARD, null, mediator.did, { next: to.me.identity.did }), attachments: [{ id: "a", data: { json: JSON.parse(mail.packed) } }] } as IMessage;
  await mediator.handleHttp((await from.link.seal(forward, mediator.did, null)).packed);
}

const contentOf = (opened: Opened) => (opened.msg.body as { content: string }).content;
const queued = (mediator: FakeMediator, who: Party) => (mediator.queues.get(who.me.identity.did) ?? []).map((item) => item.id);

/** What a party acknowledged, in order: the id lists of every messages-received it posted. */
async function acked(who: Party): Promise<string[][]> {
  const secrets = mintMediatorIdentity(await mediatorIdentity()).secrets;
  const lists: string[][] = [];
  for (const packed of who.posted) {
    const [msg] = await Message.unpack(packed, resolver, secretsResolverFor(secrets), {});
    const value = msg.as_value();
    if (value.type === MESSAGES_RECEIVED) {
      lists.push((value.body as { message_id_list: string[] }).message_id_list);
    }
  }
  return lists;
}

/** A pickup whose handle collects what it was handed, answering as `fate` says (acked, by default). */
function pickup(who: Party, fate: (opened: Opened) => Promise<Fate> | Fate = () => "acked", options: PickupOptions = {}) {
  const seen: Opened[] = [];
  const handle = new Pickup(
    who.link,
    (opened) => {
      seen.push(opened);
      return fate(opened);
    },
    { log: (line) => who.log.push(line), ...options }
  );
  return { handle, seen, contents: () => seen.map(contentOf) };
}

async function until(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`${what}: still not, after two seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const byEid = (events: TraceEvent[]) => new Map(events.map((event) => [event.eid, event]));

describe("v2 pickup: the mail the mediator holds for us", () => {
  it("a drain: status, delivery, every attachment opened and handed over in order, the taken ones acknowledged; an empty queue is one question", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 1);
    const bob = await party(mediator, 2);
    await post(mediator, bob, alice, "one");
    await post(mediator, bob, alice, "two");
    await post(mediator, bob, alice, "three");
    const ids = queued(mediator, alice);
    expect(ids).toHaveLength(3);
    mediator.seenTypes.length = 0;
    alice.posted.length = 0;

    // the handle names the record the first one ended in; the others it leaves to the pickup to note
    const inbox = pickup(alice, (opened) => (contentOf(opened) === "one" ? alice.link.noteOpen(opened, "m1").then(() => "acked") : "acked"));
    expect(await inbox.handle.drain()).toEqual({ acked: 3, ended: "empty" });
    expect(inbox.contents()).toEqual(["one", "two", "three"]);
    expect(inbox.seen.map((opened) => [opened.sender, opened.recipient])).toEqual([
      [bob.me.identity.did, alice.me.identity.did],
      [bob.me.identity.did, alice.me.identity.did],
      [bob.me.identity.did, alice.me.identity.did],
    ]);
    expect(await acked(alice)).toEqual([ids]);
    expect(queued(mediator, alice)).toEqual([]);
    expect(mediator.seenTypes).toEqual([STATUS_REQUEST, DELIVERY_REQUEST, MESSAGES_RECEIVED, STATUS_REQUEST]);
    expect(alice.log).toEqual(["3 message(s) queued at the mediator"]);

    // the trace: each mail's open hangs on the delivery's, which hangs on the HTTP answer; the first names its record
    const envelope = await alice.trace.read("envelope");
    const opens = envelope.filter((event) => event.type === "envelope.open" && event.data["type"] === BASIC_MESSAGE);
    expect(opens.map((event) => event.data["mid"])).toEqual(["m1", undefined, undefined]);
    expect(opens.map((event) => event.eid)).toEqual(inbox.seen.map((opened) => opened.eid));
    const wrap = byEid(envelope).get(opens[0]?.data["parent"] as string) as TraceEvent;
    expect(wrap).toMatchObject({ type: "envelope.open", data: { type: DELIVERY } });
    expect(new Set(opens.map((event) => event.data["parent"]))).toEqual(new Set([wrap.eid]));
    expect(byEid(await alice.trace.read("wire")).get(wrap.data["parent"] as string)).toMatchObject({ type: "wire.in", data: { via: "http" } });

    // nothing queued: one question, nothing fetched, nothing handed over
    mediator.seenTypes.length = 0;
    expect(await inbox.handle.drain()).toEqual({ acked: 0, ended: "empty" });
    expect(mediator.seenTypes).toEqual([STATUS_REQUEST]);
    expect(inbox.seen).toHaveLength(3);
  });

  it("what will not open, what the handle skips and what it threw on stay queued; the rest is acknowledged, and a round that takes nothing ends the drain", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 3);
    const bob = await party(mediator, 4);
    const carol = await party(mediator, 5);
    await post(mediator, bob, alice, "sealed to carol", carol.me.identity.did);
    await post(mediator, bob, alice, "not now");
    await post(mediator, bob, alice, "fine");
    await post(mediator, bob, alice, "hot");
    const [stray, later, fine, hot] = queued(mediator, alice) as [string, string, string, string];
    mediator.seenTypes.length = 0;

    let patient = false;
    const inbox = pickup(alice, (opened) => {
      switch (contentOf(opened)) {
        case "not now":
          return patient ? "acked" : "skip";
        case "hot":
          throw new Error("too hot to handle");
        default:
          return "acked";
      }
    });
    expect(await inbox.handle.drain()).toEqual({ acked: 1, ended: "left" });
    expect(await acked(alice)).toEqual([[fine]]);
    expect(queued(mediator, alice)).toEqual([stray, later, hot]);
    // the second round fetched the three left and took none: the drain stopped there, nothing acknowledged
    expect(mediator.seenTypes).toEqual([STATUS_REQUEST, DELIVERY_REQUEST, MESSAGES_RECEIVED, STATUS_REQUEST, DELIVERY_REQUEST]);
    expect(inbox.contents()).toEqual(["not now", "fine", "hot", "not now", "hot"]);
    expect(alice.log).toEqual([
      "4 message(s) queued at the mediator",
      expect.stringMatching(/^could not open a delivered envelope; leaving it queued: /),
      `a delivered ${BASIC_MESSAGE} was not handled; leaving it queued: too hot to handle`,
      "3 message(s) queued at the mediator",
      expect.stringMatching(/^could not open a delivered envelope; leaving it queued: /),
      `a delivered ${BASIC_MESSAGE} was not handled; leaving it queued: too hot to handle`,
      "nothing in the queue could be taken now; leaving it for a later pickup",
    ]);
    // the one that would not open left the link's word; the ones handed over were noted, record or no record
    const envelope = await alice.trace.read("envelope");
    expect(envelope.filter((event) => event.type === "envelope.error")).toHaveLength(2);
    expect(envelope.filter((event) => event.type === "envelope.open" && event.data["type"] === BASIC_MESSAGE)).toHaveLength(5);

    // a later pickup, the handle now patient: the skipped one is taken; the other two wait on
    patient = true;
    alice.posted.length = 0;
    expect(await inbox.handle.drain()).toEqual({ acked: 1, ended: "left" });
    expect(await acked(alice)).toEqual([[later]]);
    expect(queued(mediator, alice)).toEqual([stray, hot]);
  });

  it("mail that keeps coming: ten rounds, then the drain stops with mail still queued", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 6);
    const bob = await party(mediator, 7);
    await post(mediator, bob, alice, "0");
    let n = 0;
    const inbox = pickup(alice, async (): Promise<Fate> => {
      // one more arrives while this one is in hand
      await post(mediator, bob, alice, String(++n));
      return "acked";
    });
    expect(await inbox.handle.drain()).toEqual({ acked: 10, ended: "rounds" });
    expect(inbox.contents()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(queued(mediator, alice)).toHaveLength(1);
    expect(alice.log.at(-1)).toBe("pickup stopped after ten rounds with mail still queued");
  });

  it("an acknowledgement that failed is a line: the mail stays queued and comes again, for the handle to tell apart", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 8);
    const bob = await party(mediator, 9);
    await post(mediator, bob, alice, "once");
    let refusals = 1;
    class Flaky extends MediatorLink {
      override async roundTrip(type: string, body: Record<string, unknown>): Promise<IMessage> {
        if (type === MESSAGES_RECEIVED && refusals-- > 0) {
          throw new Error("connection reset");
        }
        return super.roundTrip(type, body);
      }
    }
    const link = new Flaky({
      didcomm,
      resolveDid: resolveDIDCommDoc,
      fetch: mediator.fetch,
      trace: alice.trace,
      secrets: () => alice.ring.secrets(),
      me: () => alice.me.identity,
      mediatorDid: mediator.did,
      mediatorDoc: (await resolveDIDCommDoc(mediator.did)) as DIDDoc,
    });
    const seen: string[] = [];
    const log: string[] = [];
    const handle = new Pickup(
      link,
      (opened) => {
        seen.push(contentOf(opened));
        return "acked";
      },
      { log: (line) => log.push(line) }
    );
    expect(await handle.drain()).toEqual({ acked: 2, ended: "empty" });
    expect(seen).toEqual(["once", "once"]);
    expect(log).toEqual([
      "1 message(s) queued at the mediator",
      "ack failed (connection reset); messages stay queued and will be deduplicated on the next pickup",
      "1 message(s) queued at the mediator",
    ]);
    expect(queued(mediator, alice)).toEqual([]);
  });

  it("the socket: live delivery is told, a delivery down it is taken and acknowledged, one with nothing inside is taken unopened, a stray frame is logged; inbound steps run one after another", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 10);
    const bob = await party(mediator, 11);
    let live = 0;
    let release: () => void = () => undefined;
    const inbox = pickup(
      alice,
      async (opened): Promise<Fate> => {
        if (contentOf(opened) === "slow") {
          await new Promise<void>((resolve) => (release = resolve));
        }
        return "acked";
      },
      { onLive: () => live++ }
    );
    let closed = 0;
    alice.link.openSocket((opened) => inbox.handle.onFrame(opened), () => closed++);
    await until("live delivery", () => live === 1);
    expect(mediator.seenTypes.at(-1)).toBe(LIVE_DELIVERY_CHANGE);
    alice.posted.length = 0;

    // two deliveries down the socket: the second waits for the first, however long it takes
    await post(mediator, bob, alice, "slow");
    await post(mediator, bob, alice, "quick");
    const [slow, quick] = queued(mediator, alice) as [string, string];
    await until("the first in hand", () => inbox.seen.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inbox.contents()).toEqual(["slow"]);
    expect(await acked(alice)).toEqual([]);
    release();
    await until("both acknowledged", () => queued(mediator, alice).length === 0);
    expect(inbox.contents()).toEqual(["slow", "quick"]);
    expect(await acked(alice)).toEqual([[slow], [quick]]);
    // and the mail's open hangs on the delivery frame's, which hangs on the socket's wire.in
    const envelope = byEid(await alice.trace.read("envelope"));
    const wrap = envelope.get(inbox.seen[0]?.open["parent"] as string) as TraceEvent;
    expect(wrap).toMatchObject({ type: "envelope.open", data: { type: DELIVERY } });
    expect(byEid(await alice.trace.read("wire")).get(wrap.data["parent"] as string)).toMatchObject({ type: "wire.in", data: { via: "ws" } });

    // a delivery with nothing to open inside (an attachment by link, say): taken without a word, so the mediator stops offering it
    const secrets = mintMediatorIdentity(await mediatorIdentity()).secrets;
    const hollow = {
      ...plain(DELIVERY, mediator.did, alice.me.identity.did, { recipient_did: alice.me.identity.did }),
      attachments: [{ id: "hollow", data: { links: ["https://mediator.invalid/mail/hollow"], hash: "n/a" } }],
    } as IMessage;
    const [packed] = await new Message(hollow).pack_encrypted(alice.me.identity.did, mediator.did, null, resolver, secretsResolverFor(secrets), { forward: false });
    alice.posted.length = 0;
    alice.sockets[0]?.deliver(packed);
    await until("the hollow one acknowledged", () => alice.posted.length === 1);
    expect(await acked(alice)).toEqual([["hollow"]]);
    expect(inbox.seen).toHaveLength(2);

    // a frame that is neither status nor delivery: a line, and the socket stays up
    const carol = await party(mediator, 12);
    const stray = await carol.link.seal(plain(BASIC_MESSAGE, carol.me.identity.did, alice.me.identity.did, { content: "psst" }), alice.me.identity.did, carol.me.identity.did);
    alice.sockets[0]?.deliver(stray.packed);
    await until("the stray frame logged", () => alice.log.includes(`unexpected frame type ${BASIC_MESSAGE}`));
    expect(inbox.seen).toHaveLength(2);
    expect(alice.link.live).toBe(true);
    expect(closed).toBe(0);
    alice.link.closeSocket();
    expect(alice.log).toEqual([`unexpected frame type ${BASIC_MESSAGE}`]);
  });

  it("a status down the socket that is not about live delivery is nothing to tell", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 13);
    let live = 0;
    const inbox = pickup(alice, () => "acked", { onLive: () => live++ });
    await inbox.handle.onFrame({ msg: plain(STATUS, mediator.did, alice.me.identity.did, { message_count: 0 }), sender: mediator.did, recipient: alice.me.identity.did, fromPrior: null, metadata: {}, open: {} } as unknown as Opened);
    expect(live).toBe(0);
    expect(alice.log).toEqual([]);
  });
});
