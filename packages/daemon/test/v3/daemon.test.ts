import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { PING_TYPE, type Channel, type DidId } from "@estoc/vault/v3";

import { RECIPIENT_QUERY, RECIPIENT_UPDATE } from "@estoc/agent-core";
import { newMediator } from "../../../agent-core/test/v3/helpers.js";
import type { FakeMediator } from "../../../agent-core/test/fake-mediator.js";
import { connect, createDaemon, decode, encode, type Daemon, type DaemonCore, type DaemonEvents, type Lines, type Port, type Snapshot } from "../../src/v3/index.js";
import { nodeHost, serveDaemon } from "../../src/v3/node/index.js";

const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
const PASSPHRASE = "alice-passes-the-salt";
const LONG = 300_000;

const roots: string[] = [];
const daemons: DaemonCore[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "estoc-daemon-v3-"));
  roots.push(root);
  return root;
}

/** What one listener was told, in order, and the latest of each. */
interface Told {
  events: [string, ...unknown[]][];
  phases(): string[];
  snapshot(): Snapshot;
  lines(): Lines | null;
}

function told(): Told & { emit: (name: string, ...args: unknown[]) => void } {
  const events: [string, ...unknown[]][] = [];
  const last = (...names: string[]) => events.filter(([name]) => names.includes(name)).at(-1);
  return {
    events,
    emit: (name, ...args) => events.push([name, ...args]),
    phases: () => events.filter(([name]) => name === "phase").map(([, phase]) => phase as string),
    snapshot: () => last("opened", "changed")![1] as Snapshot,
    lines: () => (last("lines")?.[1] as Lines | undefined) ?? null,
  };
}

async function until(what: string, condition: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not, after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A daemon over a folder, its agent's transports the mediator's when there is one. */
function daemonOver(root: string, mediator?: FakeMediator): { daemon: DaemonCore; heard: Told } {
  const heard = told();
  const daemon = createDaemon(nodeHost(root, mediator === undefined ? {} : { fetch: mediator.fetch, WebSocket: mediator.WebSocket }), heard.emit);
  daemons.push(daemon);
  return { daemon, heard };
}

const vaultFile = (root: string) => path.join(root, ".estoc", "vault.sqlite");

async function person(mediator: FakeMediator, name: string): Promise<{ root: string; daemon: DaemonCore; heard: Told }> {
  const root = await folder();
  const { daemon, heard } = daemonOver(root, mediator);
  await daemon.boot();
  await daemon.createIdentity(name, PASSPHRASE);
  await daemon.setMediator(mediator.did);
  return { root, daemon, heard };
}

const messagesOf = (snapshot: Snapshot) => snapshot.channels.flatMap((channel) => channel.messages);

/** A ws client as the port the RPC speaks over: what a UI's client does. */
async function clientPort(url: string): Promise<Port> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    postMessage: (message) => ws.send(encode(message)),
    addEventListener(type: "message" | "close", listener: (event: MessageEvent) => void) {
      if (type === "close") ws.on("close", () => (listener as () => void)());
      else ws.on("message", (data) => listener({ data: decode(data.toString()) } as MessageEvent));
    },
  } as Port;
}

describe("the daemon over a folder", () => {
  it("lands on the screen the folder dictates, keeps the vault to itself while it holds it, and hands every record over a socket as it is", async () => {
    const root = await folder();
    const served = await serveDaemon({ host: nodeHost(root), port: 0, token: "t0k3n" });
    daemons.push(served.daemon as DaemonCore);
    const heard = told();
    const ui = connect<Daemon>(await clientPort(served.url), new Proxy({} as DaemonEvents, { get: (_, name: string) => (...args: unknown[]) => heard.emit(name, ...args) }) as never);
    await ui.boot();
    expect(heard.phases()).toEqual(["onboarding"]);

    await ui.createIdentity("Alice", PASSPHRASE);
    expect(heard.snapshot()).toMatchObject({ label: "Alice", restoreUnexplained: false, mediations: [], dids: [], contacts: [], channels: [], invitations: [] });
    await stat(path.join(root, ".estoc", "vault.sqlite"));

    const late = told();
    const second = connect<Daemon>(await clientPort(served.url), new Proxy({} as DaemonEvents, { get: (_, name: string) => (...args: unknown[]) => late.emit(name, ...args) }) as never);
    await second.boot();
    expect(late.snapshot().label).toBe("Alice");
    expect(heard.events.filter(([name]) => name === "opened")).toHaveLength(1);

    const backup = await ui.exportBackup();
    expect(backup.bytes).toBeInstanceOf(Uint8Array);
    expect(backup.name).toMatch(/^Alice-.*\.estoc\.sqlite$/);
    expect(new TextDecoder().decode(backup.bytes.subarray(0, 15))).toBe("SQLite format 3");

    const other = told();
    const elsewhere = createDaemon(nodeHost(root), other.emit);
    daemons.push(elsewhere);
    const waiting = elsewhere.boot();
    await until("the second daemon says the vault is held elsewhere", () => other.phases().includes("elsewhere"));

    await ui.lock();
    expect(heard.phases().at(-1)).toBe("locked");
    await expect(ui.unlock("wrong")).rejects.toThrow(/wrong passphrase/);
    await expect(ui.send({ contactId: "018f0000-0000-7000-8000-000000000000" as never }, { type: BASIC_MESSAGE, body: { content: "hi" } })).rejects.toThrow(/no open vault/);
    await ui.unlock(PASSPHRASE);
    expect(heard.events.filter(([name]) => name === "opened")).toHaveLength(2);

    await served.close();
    await waiting;
    expect(other.phases().at(-1)).toBe("locked");
  });

  it("closes the socket a frame that does not decode came on, answers nothing that is no call, and goes on serving", async () => {
    const served = await serveDaemon({ host: nodeHost(await folder()), port: 0, token: "t0k3n" });
    try {
      const garbled = new WebSocket(served.url);
      await new Promise<void>((resolve, reject) => {
        garbled.once("open", resolve);
        garbled.once("error", reject);
      });
      const closedWith = new Promise<number>((resolve) => garbled.once("close", resolve));
      garbled.send('{"kind":"call","id":1,"method":"send","args":[{"$bytes":"not base64!"}]}');
      expect(await closedWith).toBe(1007);

      const port = await clientPort(served.url);
      const noCalls = [null, [], "boot", { kind: "call", id: 1, method: "boot" }, { kind: "call", id: 1, method: { toString: null }, args: [] }, { kind: "call", id: 1, method: ["boot"], args: [] }, { kind: "call", id: "1", method: "boot", args: [] }];
      for (const noCall of noCalls) port.postMessage(noCall);
      const heard = told();
      const ui = connect<Daemon & { constructor(): Promise<unknown> }>(port, new Proxy({} as DaemonEvents, { get: (_, name: string) => (...args: unknown[]) => heard.emit(name, ...args) }) as never);
      await ui.boot();
      expect(heard.phases()).toEqual(["onboarding"]);
      await expect(ui.constructor()).rejects.toThrow(/no such method: constructor/);
    } finally {
      await served.close();
    }
  });

  it("reads no folder-format vault, and leaves it as it is", async () => {
    const root = await folder();
    await mkdir(path.join(root, ".estoc"));
    await writeFile(path.join(root, ".estoc", "config.json"), '{"format":"estoc","version":2}');
    const heard = told();
    const daemon = createDaemon(nodeHost(root), heard.emit);
    daemons.push(daemon);
    await daemon.boot();
    expect(heard.events).toEqual([["phase", "unreadable", expect.stringMatching(/folder format/)]]);
    await expect(daemon.createIdentity("Alice", PASSPHRASE)).rejects.toThrow();
    await stat(path.join(root, ".estoc", "config.json"));
    expect(await readdir(path.join(root, ".estoc"))).toEqual(["config.json"]);
  });
});

describe("a daemon's files, one operation at a time", () => {
  const settledAs = (results: PromiseSettledResult<unknown>[]) => results.map((result) => (result.status === "fulfilled" ? "fulfilled" : String((result.reason as Error).message)));

  it("makes one vault of two asked for at once, whichever way they are made: the one refused takes nothing of the other's", async () => {
    const source = daemonOver(await folder());
    await source.daemon.boot();
    await source.daemon.createIdentity("Alice", PASSPHRASE);
    const backup = await source.daemon.exportBackup();

    const occupied = /a vault already exists here/;
    const races: [string, (daemon: DaemonCore) => Promise<unknown>[]][] = [
      ["Alice", (daemon) => [daemon.createIdentity("Alice", PASSPHRASE), daemon.createIdentity("Bob", PASSPHRASE)]],
      ["Alice", (daemon) => [daemon.restoreIdentity(backup.bytes, PASSPHRASE), daemon.createIdentity("Bob", PASSPHRASE)]],
      ["Bob", (daemon) => [daemon.createIdentity("Bob", PASSPHRASE), daemon.restoreIdentity(backup.bytes, PASSPHRASE)]],
    ];
    for (const [label, race] of races) {
      const root = await folder();
      const { daemon, heard } = daemonOver(root);
      await daemon.boot();
      expect(settledAs(await Promise.allSettled(race(daemon)))).toEqual(["fulfilled", expect.stringMatching(occupied)]);
      expect(heard.events.filter(([name]) => name === "opened").map(([, snapshot]) => (snapshot as Snapshot).label)).toEqual([label]);
      await stat(vaultFile(root));
      expect((await daemon.exportBackup()).bytes.length).toBeGreaterThan(0);
    }
  });

  it("neither forgets nor makes a vault in a folder another daemon holds, and a daemon closed while it waits for one asks no more", async () => {
    const root = await folder();
    const owner = daemonOver(root);
    await owner.daemon.boot();
    await owner.daemon.createIdentity("Alice", PASSPHRASE);

    const other = daemonOver(root);
    const waiting = other.daemon.boot();
    await until("the second daemon says the folder is held elsewhere", () => other.heard.phases().includes("elsewhere"));
    const elsewhere = /held elsewhere/;
    await expect(other.daemon.forgetIdentity()).rejects.toThrow(elsewhere);
    await expect(other.daemon.createIdentity("Mallory", PASSPHRASE)).rejects.toThrow(elsewhere);
    await expect(other.daemon.lock()).rejects.toThrow(elsewhere);
    await stat(vaultFile(root));
    expect((await owner.daemon.exportBackup()).bytes.length).toBeGreaterThan(0);

    const closed = other.daemon.close();
    expect(other.daemon.close()).toBe(closed);
    await closed;
    await waiting;
    const saidByClose = other.heard.events.length;
    await expect(other.daemon.unlock(PASSPHRASE)).rejects.toThrow(/the daemon is closed/);

    // The owner gone, the folder is free at once: nothing of the closed daemon comes back for it.
    await owner.daemon.close();
    const next = daemonOver(root);
    await next.daemon.boot();
    expect(next.heard.phases()).toEqual(["locked"]);
    expect(other.heard.events).toHaveLength(saidByClose);
    expect(other.heard.phases()).toEqual(["elsewhere"]);
  });

  it("stays locked when locked again, by one UI or by two at once", async () => {
    const { daemon, heard } = daemonOver(await folder());
    await daemon.boot();
    await daemon.createIdentity("Alice", PASSPHRASE);
    await daemon.lock();
    await daemon.lock();
    await Promise.all([daemon.lock(), daemon.lock()]);
    expect(heard.phases()).toEqual(["onboarding", "locked"]);
    await daemon.unlock(PASSPHRASE);
    await Promise.all([daemon.lock(), daemon.lock()]);
    expect(heard.phases()).toEqual(["onboarding", "locked", "locked"]);
    await daemon.unlock(PASSPHRASE);
    expect(heard.snapshot().label).toBe("Alice");
  });

  it("carries exports and merges asked for at once each to its own end, a merge that fails among them, and leaves no snapshot behind", async () => {
    const root = await folder();
    const { daemon } = daemonOver(root);
    await daemon.boot();
    await daemon.createIdentity("Alice", PASSPHRASE);
    const backup = await daemon.exportBackup();
    const noSnapshot = new TextEncoder().encode("no database at all");

    const results = await Promise.allSettled([daemon.exportBackup(), daemon.mergeBackup(backup.bytes), daemon.exportBackup(), daemon.mergeBackup(noSnapshot), daemon.mergeBackup(backup.bytes), daemon.exportBackup()]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    for (const index of [1, 4]) expect((results[index] as PromiseFulfilledResult<unknown>).value).toMatchObject({ added: 0, conflicts: 0 });
    // An export is whole if it validates as a snapshot, which a merge does before it takes anything from one.
    for (const index of [0, 2, 5]) {
      const exported = (results[index] as PromiseFulfilledResult<{ bytes: Uint8Array }>).value;
      expect(await daemon.mergeBackup(exported.bytes)).toMatchObject({ added: 0, conflicts: 0 });
    }

    // A close lets the operation under way finish and refuses the one still waiting behind it.
    const underWay = daemon.exportBackup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const behind = daemon.mergeBackup(backup.bytes);
    const closed = daemon.close();
    expect(settledAs(await Promise.allSettled([underWay, behind]))).toEqual(["fulfilled", expect.stringMatching(/the daemon is closed/)]);
    await closed;
    expect((await readdir(path.join(root, ".estoc"))).filter((name) => !/^(vault|owner)\.sqlite/.test(name))).toEqual([]);
  });
});

describe("two daemons over a mediator", () => {
  it(
    "asks the mediator nothing once it is closed: a reconciliation cut short takes away no address the next daemon over the vault registers",
    async () => {
      const mediator = await newMediator();
      const { root, daemon, heard } = await person(mediator, "Alice");
      await until("the first connection is through", () => heard.lines()?.connections[0]?.live === true);

      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let asked = false;
      mediator.intercept = async (message) => {
        if (message.type !== RECIPIENT_QUERY || asked) return undefined;
        asked = true;
        await held;
        return undefined;
      };
      try {
        const reconnecting = daemon.reconnect();
        await until("the query is with the mediator", () => asked);
        await daemon.close();
        await reconnecting;
        const saidByClose = heard.events.length;

        const next = daemonOver(root, mediator);
        await next.daemon.boot();
        await next.daemon.unlock(PASSPHRASE);
        await next.daemon.createInvitation("one");
        const registered = [...mediator.recipients.keys()];
        expect(registered).toHaveLength(1);

        const seen = mediator.seenTypes.length;
        release();
        // The mediator answers the query it held; what the closed daemon would have sent on that answer has long had its chance by then.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(mediator.seenTypes.slice(seen).filter((type) => type === RECIPIENT_UPDATE)).toEqual([]);
        expect([...mediator.recipients.keys()]).toEqual(registered);
        expect(heard.events).toHaveLength(saidByClose);
      } finally {
        release();
        mediator.intercept = null;
      }
    },
    LONG
  );

  it(
    "an invitation accepted becomes a contact on one side and a channel to name on the other; a restored vault receives at once and sends only once the restore is explained",
    async () => {
      const mediator = await newMediator();
      const alice = await person(mediator, "Alice");
      const bob = await person(mediator, "Bob");
      expect(alice.heard.snapshot().mediations).toMatchObject([{ mediatorDid: mediator.did, selected: true, usable: true }]);
      await until("alice's line is live", () => alice.heard.lines()?.connections[0]?.live === true);

      const { invitation, didId } = await alice.daemon.createInvitation("one");
      expect(alice.heard.snapshot().invitations).toMatchObject([{ oobId: invitation.id, didId, state: { status: "available" } }]);

      const accepted = await bob.daemon.acceptInvitation(invitation, "Alice");
      expect(accepted).toMatchObject({ outcome: "submitted", because: null });
      expect(bob.heard.snapshot().contacts).toMatchObject([{ petname: "Alice", channels: [{ channel: accepted.channel, selected: true }] }]);

      await until("alice holds bob's Ping", () => messagesOf(alice.heard.snapshot()).some((message) => message.direction === "in" && message.msg?.type === PING_TYPE));
      await until("the invitation is consumed", () => alice.heard.snapshot().invitations[0]?.state.status === "consumed");
      await until("bob's Ping is acknowledged", () => messagesOf(bob.heard.snapshot()).some((message) => message.messageId === accepted.messageId && message.acknowledged));

      // Bob's first word at a disclosed address has Alice select a private successor toward him: the pair she names is the one she now writes from.
      const moved = (snapshot: Snapshot) => snapshot.channels.find((channel) => channel.head !== null && channel.head.localDid !== channel.channel.localDid);
      await until("alice's successor is the head of the pair bob wrote in", () => moved(alice.heard.snapshot()) !== undefined);
      const head = moved(alice.heard.snapshot())!.head as Channel;
      const contactId = await alice.daemon.createContact("Bob", [head]);
      expect(alice.heard.snapshot().contacts).toMatchObject([{ petname: "Bob", defaultWriteTo: head }]);
      await alice.daemon.renameContact(contactId, "Bobby");
      expect(alice.heard.snapshot().contacts[0]!.petname).toBe("Bobby");

      const hello = await alice.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "hello" } });
      expect(hello).toMatchObject({ outcome: "submitted", channel: head });
      await until("bob reads the hello", () => messagesOf(bob.heard.snapshot()).some((message) => message.body.state === "available" && message.body.body["content"] === "hello"));

      const backup = await alice.daemon.exportBackup();
      await alice.daemon.close();

      const root = await folder();
      const first = daemonOver(root, mediator);
      await first.daemon.boot();
      await expect(first.daemon.restoreIdentity(backup.bytes, "not the passphrase")).rejects.toThrow(/does not open this backup/);
      await expect(stat(path.join(root, ".estoc", "vault.sqlite"))).rejects.toThrow();
      await first.daemon.restoreIdentity(backup.bytes, PASSPHRASE);
      expect(first.heard.snapshot()).toMatchObject({ label: "Alice", restoreUnexplained: true, contacts: [{ petname: "Bobby" }] });

      const closed = /sending opens once what a restore cannot bring back has been explained/;
      const bobsDid = head.peerDid;
      const successor = first.heard.snapshot().dids.find((did) => did.did === head.localDid)!.didId as DidId;
      await expect(first.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "too soon" } })).rejects.toThrow(closed);
      await expect(first.daemon.retry(hello.messageId)).rejects.toThrow(closed);
      await expect(first.daemon.rotate(successor, bobsDid)).rejects.toThrow(closed);
      await expect(first.daemon.completeResponse("00000000-0000-5000-8000-000000000000" as never, "pure-ack")).rejects.toThrow(closed);
      await expect(first.daemon.completeNotification("018f0000-0000-7000-8000-000000000000" as never)).rejects.toThrow(closed);
      await expect(first.daemon.acceptInvitation(invitation, "nobody")).rejects.toThrow(closed);
      expect(messagesOf(first.heard.snapshot()).filter((message) => message.direction === "out" && message.msg?.type === BASIC_MESSAGE)).toHaveLength(1);

      // Receiving, reconciling and what the vault owes on its own wait for no explanation.
      await until("the restored vault's line is live", () => first.heard.lines()?.connections[0]?.live === true);
      const reply = await bob.daemon.send({ contactId: accepted.contactId }, { type: BASIC_MESSAGE, body: { content: "still there?" }, pleaseAck: [""] });
      expect(reply.outcome).toBe("submitted");
      await until("the restored vault reads bob", () => messagesOf(first.heard.snapshot()).some((message) => message.body.state === "available" && message.body.body["content"] === "still there?"));
      await until("bob's message is acknowledged by the restored vault", () => messagesOf(bob.heard.snapshot()).some((message) => message.messageId === reply.messageId && message.acknowledged));
      expect(await first.daemon.pending()).toMatchObject({ pendingOutbounds: [] });

      // The explanation is owed by this runtime, not by this process: another over the same file owes it still.
      await first.daemon.close();
      const again = daemonOver(root, mediator);
      await again.daemon.boot();
      expect(again.heard.phases()).toEqual(["locked"]);
      await again.daemon.unlock(PASSPHRASE);
      expect(again.heard.snapshot().restoreUnexplained).toBe(true);
      await expect(again.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "too soon" } })).rejects.toThrow(closed);

      await again.daemon.explainedRestore();
      expect(again.heard.snapshot().restoreUnexplained).toBe(false);
      const after = await again.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "back again" } });
      expect(after.outcome).toBe("submitted");
      await until("bob reads the restored vault", () => messagesOf(bob.heard.snapshot()).some((message) => message.body.state === "available" && message.body.body["content"] === "back again"));

      // A restored vault never held the envelopes its submitted messages released, and an erasure collects the ones a vault did hold: neither is asked for them again.
      const merged = await again.daemon.mergeBackup(backup.bytes);
      expect(merged).toMatchObject({ added: 0, conflicts: 0, objects: 0 });
      expect(merged.duplicates).toBeGreaterThan(0);
      await until("the agent over the merged vault is live", () => again.heard.events.at(-1)![0] === "lines" && again.heard.lines()!.connections[0]!.live);
      const bobs = await bob.daemon.exportBackup();
      await bob.daemon.eraseMessage(reply.messageId);
      expect(await bob.daemon.mergeBackup(bobs.bytes)).toMatchObject({ added: 0, conflicts: 0, objects: 0 });

      await again.daemon.forgetIdentity();
      expect(again.heard.phases().at(-1)).toBe("onboarding");
      await expect(stat(path.join(root, ".estoc", "vault.sqlite"))).rejects.toThrow();
    },
    LONG
  );
});
