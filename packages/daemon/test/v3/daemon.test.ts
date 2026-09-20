import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { PING_TYPE, type Channel, type DidId } from "@estoc/vault/v3";

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

/** A daemon over a folder of its own, its agent's transports the mediator's. */
function daemonOver(root: string, mediator: FakeMediator): { daemon: DaemonCore; heard: Told } {
  const heard = told();
  const daemon = createDaemon(nodeHost(root, { fetch: mediator.fetch, WebSocket: mediator.WebSocket }), heard.emit);
  daemons.push(daemon);
  return { daemon, heard };
}

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
  });
});

describe("two daemons over a mediator", () => {
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
