import { describe, expect, it } from "vitest";
import { FromPrior, Message } from "didcomm-node";

import { resolveDIDCommDoc, type DIDDoc } from "@estoc/did-peer";
import { MemoryBackend } from "@estoc/event-store";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";

import {
  BASIC_MESSAGE,
  DELIVERY,
  FORWARD,
  LIVE_DELIVERY_CHANGE,
  MEDIATE_GRANT,
  MEDIATE_REQUEST,
  PLAIN_TYP,
  RECIPIENT_UPDATE,
  RECIPIENT_UPDATE_RESPONSE,
  STATUS,
  secretsResolverFor,
  type IMessage,
} from "../../src/index.js";
import {
  AgentTrace,
  Keyring,
  MediatorLink,
  createVault,
  type LinkOptions,
  type MyIdentity,
  type Opened,
  type PeerVault,
  type TraceEvent,
} from "../../src/v2/index.js";
import { FakeMediator, MEDIATOR_HTTP, MEDIATOR_WS, mintMediatorIdentity, type FakeSocket } from "../fake-mediator.js";

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
}

/** A vault with a mediation toward `mediator` (created, not yet granted: the link needs only `me`), and a link over it. */
async function party(mediator: FakeMediator, fill: number, over: Partial<LinkOptions> = {}, backend = new MemoryBackend()): Promise<Party> {
  const { doc, seedKey } = await createSeedKeystore("test", { seed: seedOf(fill) });
  const v = await createVault(backend, { keystore: doc, seedKey, label: `party ${fill}` });
  const ring = await Keyring.load(v);
  const { me } = await ring.createMediation(mediator.did);
  const trace = await AgentTrace.open(v.vault.local("agent"));
  const log: string[] = [];
  const link = new MediatorLink({
    didcomm,
    resolveDid: resolveDIDCommDoc,
    fetch: mediator.fetch,
    WebSocket: mediator.WebSocket,
    trace,
    secrets: () => ring.secrets(),
    me: () => me.identity,
    mediatorDid: mediator.did,
    mediatorDoc: (await resolveDIDCommDoc(mediator.did)) as DIDDoc,
    log: (line) => log.push(line),
    ...over,
  });
  return { v, ring, me, trace, link, log };
}

function plain(type: string, from: string | null, to: string, body: Record<string, unknown>): IMessage {
  return { id: crypto.randomUUID(), typ: PLAIN_TYP, type, ...(from === null ? {} : { from }), to: [to], created_time: 1, body } as IMessage;
}

/** Frames as they come down the socket, and a way to wait for the next. */
function frames() {
  const seen: Opened[] = [];
  const waiting: ((opened: Opened) => void)[] = [];
  return {
    seen,
    onFrame: (opened: Opened) => {
      seen.push(opened);
      waiting.shift()?.(opened);
    },
    next: (): Promise<Opened> =>
      new Promise((resolve, reject) => {
        waiting.push(resolve);
        setTimeout(() => reject(new Error("no frame came")), 2000);
      }),
  };
}

const byEid = (events: TraceEvent[]) => new Map(events.map((event) => [event.eid, event]));

describe("v2 link: the line to the mediator", () => {
  it("a ritual is one HTTP round trip: sealed from me to the mediator with return_route, the reply opened, the whole of it traced", async () => {
    const mediator = await newMediator();
    const posted: string[] = [];
    const alice = await party(mediator, 1, {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        posted.push(String(init?.body));
        return mediator.fetch(input, init);
      }) as typeof fetch,
    });

    const grant = await alice.link.roundTrip(MEDIATE_REQUEST, {});
    expect(grant.type).toBe(MEDIATE_GRANT);
    expect(grant.body).toEqual({ routing_did: [mediator.did] });
    expect(mediator.seenTypes).toEqual([MEDIATE_REQUEST]);

    // on the wire: authcrypt from me to the mediator, return_route declared
    const mediatorSecrets = mintMediatorIdentity(await mediatorIdentity()).secrets;
    const [request] = await Message.unpack(posted[0] as string, resolver, secretsResolverFor(mediatorSecrets), {});
    expect(request.as_value()).toMatchObject({ type: MEDIATE_REQUEST, from: alice.me.identity.did, to: [mediator.did], return_route: "all" });

    // the reply, whole
    const opened = await alice.link.exchange(RECIPIENT_UPDATE, { updates: [{ recipient_did: "did:example:x", action: "add" }] });
    expect(opened.msg.type).toBe(RECIPIENT_UPDATE_RESPONSE);
    expect(opened.sender).toBe(mediator.did);
    expect(opened.recipient).toBe(alice.me.identity.did);
    expect(opened.fromPrior).toBeNull();
    expect(opened.metadata.encrypted_from_kid).toBe(`${mediator.did}#key-2`);
    expect(opened.eid).toMatch(/^[0-9a-f-]{36}$/);

    // the trace: the frame, the envelope on it, the ritual in that — out and back, each hung on the last
    const wire = await alice.trace.read("wire");
    const envelope = await alice.trace.read("envelope");
    const mediation = await alice.trace.read("mediation");
    const bytes = await alice.trace.read("wire.bytes");
    expect(wire.map((event) => event.type)).toEqual(["wire.out", "wire.in", "wire.out", "wire.in"]);
    const [out, back] = wire as [TraceEvent, TraceEvent];
    expect(out.data).toEqual({ via: "http", endpoint: MEDIATOR_HTTP, type: MEDIATE_REQUEST, bytes: posted[0]?.length });
    expect(back.data).toMatchObject({ via: "http", parent: out.eid, status: 200, ms: expect.any(Number) });
    const [seal, open] = envelope as [TraceEvent, TraceEvent];
    expect(seal).toMatchObject({ type: "envelope.seal", data: { parent: out.eid, kind: "authcrypt", type: MEDIATE_REQUEST, skid: `${alice.me.identity.did}#key-2`, kids: [`${mediator.did}#key-2`] } });
    expect(open).toMatchObject({ type: "envelope.open", data: { parent: back.eid, kind: "authcrypt", type: MEDIATE_GRANT, from_kid: `${mediator.did}#key-2`, to_kids: [`${alice.me.identity.did}#key-2`] } });
    expect(open.data["mid"]).toBeUndefined();
    expect(mediation.slice(0, 2)).toMatchObject([
      { type: "mediation.out", data: { parent: seal.eid, msg: { type: MEDIATE_REQUEST, from: alice.me.identity.did } } },
      { type: "mediation.in", data: { parent: open.eid, msg: { type: MEDIATE_GRANT, body: { routing_did: [mediator.did] } } } },
    ]);
    // the plaintext kept is the message as composed: return_route is the envelope's word, not the ritual's
    expect((mediation[0]?.data["msg"] as { return_route?: unknown }).return_route).toBeUndefined();
    expect(bytes.slice(0, 2)).toMatchObject([
      { type: "wire.out", data: { parent: out.eid, body: posted[0] } },
      { type: "wire.in", data: { parent: back.eid, body: expect.any(String) } },
    ]);
    expect(envelope[3]?.eid).toBe(opened.eid);
    expect(alice.log).toEqual([]);
  });

  it("the socket: live delivery is the first frame up, every frame down is opened and handed over, a drop is reported and a close on purpose is not", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 2);
    const bob = await party(mediator, 3);
    // Alice is known to the mediator by a DID of hers: what a forward is addressed to
    await alice.link.roundTrip(RECIPIENT_UPDATE, { updates: [{ recipient_did: alice.me.identity.did, action: "add" }] });

    const down = frames();
    let closed = 0;
    alice.link.openSocket(down.onFrame, () => closed++);
    expect(alice.link.live).toBe(true);
    const status = await down.next();
    expect(status.msg.type).toBe(STATUS);
    expect(status.msg.body).toEqual({ live_delivery: true });
    expect(mediator.seenTypes.at(-1)).toBe(LIVE_DELIVERY_CHANGE);

    // Bob writes to Alice through her mediator: the forward is anonymous, the mail inside it authcrypt to her
    const mail = await bob.link.seal(plain(BASIC_MESSAGE, bob.me.identity.did, alice.me.identity.did, { content: "hello" }), alice.me.identity.did, bob.me.identity.did);
    const forward = { ...plain(FORWARD, null, mediator.did, { next: alice.me.identity.did }), attachments: [{ id: "a", data: { json: JSON.parse(mail.packed) } }] } as IMessage;
    await mediator.handleHttp((await bob.link.seal(forward, mediator.did, null)).packed);

    const delivery = await down.next();
    expect(delivery.msg.type).toBe(DELIVERY);
    expect(delivery.sender).toBe(mediator.did);
    expect(delivery.eid).toBeDefined();
    const inner = (delivery.msg.attachments as { data: { json: unknown } }[])[0]?.data.json;
    const opened = await alice.link.unpack(JSON.stringify(inner), delivery.eid);
    expect(opened.msg.body).toEqual({ content: "hello" });
    expect(opened.sender).toBe(bob.me.identity.did);
    expect(opened.recipient).toBe(alice.me.identity.did);
    await alice.link.noteOpen(opened, "m1");

    // the onion, from the frame to the record: wire.in (ws) ← envelope.open delivery ← envelope.open mail [mid]
    const onion = await alice.trace.traceOf("m1");
    const events = byEid(onion);
    const end = onion.find((event) => event.data["mid"] === "m1") as TraceEvent;
    expect(end).toMatchObject({ stream: "envelope", type: "envelope.open", data: { kind: "authcrypt", type: BASIC_MESSAGE, from_kid: `${bob.me.identity.did}#key-2` } });
    const wrap = events.get(end.data["parent"] as string) as TraceEvent;
    expect(wrap).toMatchObject({ stream: "envelope", type: "envelope.open", data: { kind: "authcrypt", type: DELIVERY } });
    const frame = events.get(wrap.data["parent"] as string) as TraceEvent;
    expect(frame).toMatchObject({ stream: "wire", type: "wire.in", data: { via: "ws", endpoint: MEDIATOR_WS } });
    expect(frame.data["parent"]).toBeUndefined();
    expect(onion.find((event) => event.stream === "mediation")).toMatchObject({ type: "mediation.in", data: { parent: wrap.eid, msg: { type: DELIVERY, attachments: [{ data: { bytes: expect.any(Number) } }] } } });
    // nothing here has the plaintext but the ritual, and the ritual has only the attachment's size
    for (const event of onion) {
      expect(JSON.stringify(event)).not.toContain("hello");
    }
    // the frame going up: the socket's own wire.out and the seal on it
    expect((await alice.trace.read("wire")).find((event) => event.type === "wire.out" && event.data["via"] === "ws")).toMatchObject({ data: { endpoint: MEDIATOR_WS, type: LIVE_DELIVERY_CHANGE } });

    // the mediator drops the socket: reported once; a close on purpose is not
    mediator.dropSocket(alice.me.identity.did);
    expect(closed).toBe(1);
    expect(alice.link.live).toBe(false);
    alice.link.openSocket(down.onFrame, () => closed++);
    expect((await down.next()).msg.type).toBe(STATUS);
    alice.link.closeSocket();
    expect(closed).toBe(1);
    expect(alice.link.live).toBe(false);
    alice.link.closeSocket();
    expect(alice.log).toEqual([]);
  });

  it("a socket that cannot switch live delivery on is closed, and the close reported; a frame that will not open is logged and dropped", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 4, {
      me: () => {
        throw new Error("no mediation yet");
      },
    });
    let closed = 0;
    alice.link.openSocket(() => undefined, () => closed++);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(1);
    expect(alice.link.live).toBe(false);
    expect(alice.log).toEqual(["could not open live delivery: no mediation yet"]);

    // the sockets Bob's link opens, so the test can push a frame down one
    const sockets: FakeSocket[] = [];
    const bob = await party(mediator, 5, {
      WebSocket: class extends mediator.WebSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this as unknown as FakeSocket);
        }
      } as typeof WebSocket,
    });
    const down = frames();
    bob.link.openSocket(down.onFrame);
    await down.next();
    // a frame sealed to someone else: opened by no key of Bob's
    const carol = await party(mediator, 6);
    const stray = await carol.link.seal(plain(STATUS, carol.me.identity.did, carol.me.identity.did, {}), carol.me.identity.did, carol.me.identity.did);
    sockets[0]?.deliver(stray.packed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(down.seen).toHaveLength(1);
    expect(bob.log).toEqual([expect.stringMatching(/^could not open a socket frame: /)]);
    expect((await bob.trace.read("envelope")).at(-1)).toMatchObject({ type: "envelope.error", data: { kind: "authcrypt", skid: `${carol.me.identity.did}#key-2`, error: expect.any(String) } });
    // and a handler that throws is a line, not a dead socket
    bob.log.length = 0;
    bob.link.openSocket(() => {
      throw new Error("not now");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bob.log).toEqual(["a socket frame was not handled: not now"]);
    expect(bob.link.live).toBe(true);
    expect(sockets).toHaveLength(2);
    bob.link.closeSocket();
  });

  it("an envelope that will not open leaves envelope.error and throws; a mediator that answers badly, or not at all, leaves the wire's word and throws", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 7);
    await expect(alice.link.unpack("not an envelope", "p0")).rejects.toThrow();
    const bob = await party(mediator, 8);
    const toBob = await alice.link.seal(plain(BASIC_MESSAGE, alice.me.identity.did, bob.me.identity.did, {}), bob.me.identity.did, alice.me.identity.did);
    await expect(alice.link.unpack(toBob.packed)).rejects.toThrow();
    expect(await alice.trace.read("envelope")).toMatchObject([
      { type: "envelope.error", data: { kind: "unknown", parent: "p0", error: expect.any(String) } },
      { type: "envelope.error", data: { kind: "authcrypt", skid: `${alice.me.identity.did}#key-2`, kids: [`${bob.me.identity.did}#key-2`], error: expect.any(String) } },
    ]);
    expect((await alice.trace.read("envelope"))[1]?.data["parent"]).toBeUndefined();

    const answers = { status: 500 };
    const flaky = await party(mediator, 9, {
      fetch: (async () => {
        if (answers.status === 0) {
          throw new TypeError("fetch failed");
        }
        return new Response("no", { status: answers.status });
      }) as typeof fetch,
    });
    await expect(flaky.link.roundTrip(MEDIATE_REQUEST, {})).rejects.toThrow(`mediator answered 500 to ${MEDIATE_REQUEST}`);
    answers.status = 0;
    await expect(flaky.link.roundTrip(MEDIATE_REQUEST, {})).rejects.toThrow("fetch failed");
    const wire = await flaky.trace.read("wire");
    expect(wire.map((event) => event.type)).toEqual(["wire.out", "wire.in", "wire.out", "wire.error"]);
    expect(wire[1]?.data).toMatchObject({ parent: wire[0]?.eid, status: 500 });
    expect(wire[3]?.data).toMatchObject({ via: "http", parent: wire[2]?.eid, error: "fetch failed", ms: expect.any(Number) });
    // the request was sealed and noted either way; nothing was opened
    expect((await flaky.trace.read("envelope")).map((event) => event.type)).toEqual(["envelope.seal", "envelope.seal"]);
    expect((await flaky.trace.read("mediation")).map((event) => event.type)).toEqual(["mediation.out", "mediation.out"]);
  });

  it("http() and ws() are the mediator's endpoints; a document that lists none is refused where it is needed", async () => {
    const mediator = await newMediator();
    const alice = await party(mediator, 10);
    expect(alice.link.http()).toBe(MEDIATOR_HTTP);
    expect(alice.link.ws()).toBe(MEDIATOR_WS);
    expect(alice.link.mediatorDid).toBe(mediator.did);

    const doc = (await resolveDIDCommDoc(mediator.did)) as DIDDoc;
    const mute = await party(mediator, 11, { mediatorDoc: { ...doc, service: [] } });
    expect(() => mute.link.http()).toThrow("mediator has no HTTP endpoint");
    expect(() => mute.link.ws()).toThrow("mediator has no WebSocket endpoint");
    await expect(mute.link.roundTrip(MEDIATE_REQUEST, {})).rejects.toThrow("mediator has no HTTP endpoint");
    expect(() => mute.link.openSocket(() => undefined)).toThrow("mediator has no WebSocket endpoint");
    expect(mute.link.live).toBe(false);
    // nothing went out, so nothing was traced
    expect(await mute.trace.read("wire")).toEqual([]);
  });

  it("a trace that cannot be written is reported to the log, not thrown: the ritual still completes", async () => {
    const mediator = await newMediator();
    class Full extends MemoryBackend {
      override async append(path: string, data: Uint8Array): Promise<void> {
        if (path.includes("/local/agent/trace/")) {
          throw new Error("disk full");
        }
        return super.append(path, data);
      }
      override async write(path: string, data: Uint8Array): Promise<void> {
        if (path.includes("/local/agent/trace/")) {
          throw new Error("disk full");
        }
        return super.write(path, data);
      }
    }
    const alice = await party(mediator, 12, {}, new Full());
    const opened = await alice.link.exchange(MEDIATE_REQUEST, {});
    expect(opened.msg.type).toBe(MEDIATE_GRANT);
    expect(opened.eid).toBeUndefined();
    expect(alice.log.length).toBeGreaterThan(0);
    expect(new Set(alice.log)).toEqual(new Set(["trace not written: disk full"]));
    expect(await alice.trace.read("wire")).toEqual([]);
  });
});
