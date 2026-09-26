import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, test } from "vitest";

import { SqliteVault, exportVault, openPortable, restoreVault, type SqliteDriver } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import { unlockSeedKeystore } from "@estoc/keystore";
import { EMPTY_MESSAGE_TYPE, Keys, PING_TYPE, PURE_ACK_EFFECT, vaultHeldRoots, type Channel, type DidId, type MintedDid } from "@estoc/vault";

import { PROFILE, RECIPIENT_QUERY, RECIPIENT_UPDATE } from "@estoc/agent-core";
import { FORWARD } from "../../agent-core/src/protocol/spec.js";
import { issuerRecovered, newMediator, peerSealer, proofOfSuccession, sealed, type Addressed, type DirectParty } from "../../agent-core/test/helpers.js";
import type { FakeMediator } from "../../agent-core/test/fake-mediator.js";
import { channelOf, forwarded, run, stopAll } from "../../agent-core/test/e2e/running.js";
import { connect, createDaemon, decode, encode, type Daemon, type DaemonCore, type DaemonEvents, type DaemonHost, type Lines, type Port, type Snapshot } from "../src/index.js";
import { nodeHost, serveDaemon } from "../src/node/index.js";

const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
const PASSPHRASE = "alice-passes-the-salt";
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const LONG = 300_000;

const roots: string[] = [];
const daemons: DaemonCore[] = [];

afterEach(async () => {
  await stopAll();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "estoc-daemon-"));
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
function daemonOver(root: string, mediator?: FakeMediator, agentOptions: Partial<NonNullable<DaemonHost["agentOptions"]>> = {}): { daemon: DaemonCore; heard: Told } {
  const heard = told();
  const host = nodeHost(root, mediator === undefined ? {} : { fetch: mediator.fetch, WebSocket: mediator.WebSocket });
  const daemon = createDaemon({ ...host, agentOptions: { ...host.agentOptions!, ...agentOptions } }, heard.emit);
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
    for (const index of [1, 4]) expect((results[index] as PromiseFulfilledResult<unknown>).value).toMatchObject({ added: 0 });
    // An export is whole if it validates as a snapshot, which a merge does before it takes anything from one.
    for (const index of [0, 2, 5]) {
      const exported = (results[index] as PromiseFulfilledResult<{ bytes: Uint8Array }>).value;
      expect(await daemon.mergeBackup(exported.bytes)).toMatchObject({ added: 0 });
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

/** A channel to write a contact over: what the daemon takes for one is two short forms, whoever holds them. */
const pairWith = (peer: string): Channel[] => [{ localDid: "did:peer:4zQmAnna", peerDid: `did:peer:4zQm${peer}` }] as Channel[];

describe("a vault whose history is damaged", () => {
  /** One accepted event's bytes cut short in the vault's file, which no daemon holds meanwhile. */
  function damageAnEvent(root: string): void {
    const db = new DatabaseSync(vaultFile(root));
    try {
      const { cid, canonical } = db.prepare("SELECT cid, canonical FROM events ORDER BY cid DESC LIMIT 1").get() as { cid: string; canonical: Uint8Array };
      db.prepare("UPDATE events SET canonical = ? WHERE cid = ?").run(canonical.slice(0, -3), cid);
    } finally {
      db.close();
    }
  }

  it("is not run: the daemon that finds it locked says it is damaged and why, shows no records short of what was lost, leaves the file as it is, and makes room for a restore only when asked", async () => {
    const root = await folder();
    const first = daemonOver(root);
    await first.daemon.boot();
    await first.daemon.createIdentity("Alice", PASSPHRASE);
    const backup = await first.daemon.exportBackup();
    await first.daemon.createContact("Bob", pairWith("Bob"));
    await first.daemon.close();
    damageAnEvent(root);
    const damagedBytes = (await stat(vaultFile(root))).size;

    const { daemon, heard } = daemonOver(root);
    await daemon.boot();
    expect(heard.phases()).toEqual(["damaged"]);
    expect(heard.events.at(-1)).toEqual(["phase", "damaged", expect.stringMatching(/^events\/.* is damaged/)]);
    expect(heard.events.some(([name]) => name === "opened" || name === "changed")).toBe(false);
    await expect(daemon.unlock(PASSPHRASE)).rejects.toThrow("nothing to unlock");
    await expect(daemon.createIdentity("Another", PASSPHRASE)).rejects.toThrow("a vault already exists here");
    expect((await stat(vaultFile(root))).size).toBe(damagedBytes);

    await daemon.forgetIdentity();
    expect(heard.phases().at(-1)).toBe("onboarding");
    await daemon.restoreIdentity(backup.bytes, PASSPHRASE);
    expect(heard.snapshot()).toMatchObject({ label: "Alice", contacts: [], restoreUnexplained: true });
  });

  it("with its seed at hand is no more run than locked: the daemon that would have opened it says damaged, and nothing of it is shown", async () => {
    const root = await folder();
    const host = nodeHost(root);
    const first = createDaemon(host, () => undefined);
    daemons.push(first);
    await first.boot();
    await first.createIdentity("Alice", PASSPHRASE);
    await first.close();
    damageAnEvent(root);

    const heard = told();
    const daemon = createDaemon(host, heard.emit);
    daemons.push(daemon);
    expect(await host.cachedSeedKey()).not.toBeNull();
    await daemon.boot();
    expect(heard.events).toEqual([["phase", "damaged", expect.stringMatching(/^events\/.* is damaged/)]]);
  });

  /** A host whose daemon's own connection to the vault, the one way to the file while it holds it, cuts an accepted event's bytes short. */
  function damageable(root: string): { host: DaemonHost; damageAnEvent(): void } {
    const host = nodeHost(root);
    let held: SqliteDriver | null = null;
    return {
      host: {
        ...host,
        async storage() {
          const storage = await host.storage();
          return { ...storage, open: async (name, mode, kind) => (held = await storage.open(name, mode, kind)) };
        },
      },
      damageAnEvent() {
        const last = held!.prepare("SELECT cid, canonical FROM events ORDER BY cid DESC LIMIT 1");
        const { cid, canonical } = last.get() as { cid: string; canonical: Uint8Array };
        last.finalize();
        const cut = held!.prepare("UPDATE events SET canonical = ? WHERE cid = ?");
        cut.run(canonical.slice(0, -3), cid);
        cut.finalize();
      },
    };
  }

  it("met by a read while the vault runs, stops it there: no records short of the damaged event are shown, the daemon goes from open to damaged and lets the vault go", async () => {
    const root = await folder();
    const heard = told();
    const running = damageable(root);
    const daemon = createDaemon(running.host, heard.emit);
    daemons.push(daemon);
    await daemon.boot();
    await daemon.createIdentity("Alice", PASSPHRASE);
    await daemon.createContact("Bob", pairWith("Bob"));
    const shown = heard.events.length;

    running.damageAnEvent();

    await daemon.refresh();
    await until("the daemon says damaged", () => heard.phases().at(-1) === "damaged");
    expect(heard.events.slice(shown).filter(([name]) => name === "changed")).toEqual([]);
    await expect(daemon.createContact("Carmen", pairWith("Carmen"))).rejects.toThrow("no open vault");
    await daemon.close();
    const next = daemonOver(root);
    await next.daemon.boot();
    expect(next.heard.phases()).toEqual(["damaged"]);
  });

  it("met first by the read for a UI that joins stops the vault all the same: the one joining is shown no records and told damaged, and so is the one already there", async () => {
    const root = await folder();
    const running = damageable(root);
    const served = await serveDaemon({ host: running.host, port: 0, token: "t0k3n" });
    daemons.push(served.daemon as DaemonCore);
    // The client answers any name as a call, `then` too: it is handed over inside an object, never awaited itself.
    const joined = async (heard: ReturnType<typeof told>) => ({
      ui: connect<Daemon>(await clientPort(served.url), new Proxy({} as DaemonEvents, { get: (_, name: string) => (...args: unknown[]) => heard.emit(name, ...args) }) as never),
    });
    const heard = told();
    const { ui } = await joined(heard);
    await ui.boot();
    await ui.createIdentity("Alice", PASSPHRASE);
    await ui.createContact("Bob", pairWith("Bob"));

    running.damageAnEvent();

    const late = told();
    await (await joined(late)).ui.boot();
    const damaged = ["phase", "damaged", expect.stringMatching(/^events\/.* is damaged/)];
    expect(late.events.filter(([name]) => name === "opened" || name === "changed")).toEqual([]);
    expect(late.events.at(-1)).toEqual(damaged);
    await until("the UI already there is told", () => heard.phases().at(-1) === "damaged");
    expect(heard.events.at(-1)).toEqual(damaged);
    await expect(ui.createContact("Carmen", pairWith("Carmen"))).rejects.toThrow("no open vault");
    await served.close();
  });
});

describe("two copies of one runtime, both written to", () => {
  it("merge once the one merged into has taken a replica ID of its own: nothing of either history is lost or rewritten, the merge says it renewed, and the next one does not", async () => {
    const original = await folder();
    const first = daemonOver(original);
    await first.daemon.boot();
    await first.daemon.createIdentity("Alice", PASSPHRASE);
    await first.daemon.close();
    const copy = await folder();
    await cp(path.join(original, ".estoc"), path.join(copy, ".estoc"), { recursive: true });

    const here = daemonOver(original);
    await here.daemon.boot();
    await here.daemon.unlock(PASSPHRASE);
    await here.daemon.createContact("Bob", pairWith("Bob"));
    const fromHere = await here.daemon.exportBackup();

    const there = daemonOver(copy);
    await there.daemon.boot();
    await there.daemon.unlock(PASSPHRASE);
    await there.daemon.createContact("Carmen", pairWith("Carmen"));

    const merged = await there.daemon.mergeBackup(fromHere.bytes);
    expect(merged).toMatchObject({ renewed: true });
    expect(merged.added).toBeGreaterThan(0);
    expect(there.heard.phases()).not.toContain("unreadable");
    expect(there.heard.snapshot().contacts.map((contact) => contact.petname).sort()).toEqual(["Bob", "Carmen"]);
    expect(await there.daemon.mergeBackup(fromHere.bytes)).toMatchObject({ renewed: false, added: 0 });
    await there.daemon.createContact("Dave", pairWith("Dave"));

    const back = await here.daemon.mergeBackup((await there.daemon.exportBackup()).bytes);
    expect(back.renewed).toBe(true);
    expect(here.heard.snapshot().contacts.map((contact) => contact.petname).sort()).toEqual(["Bob", "Carmen", "Dave"]);
    await here.daemon.createContact("Erin", pairWith("Erin"));
    expect(await there.daemon.mergeBackup((await here.daemon.exportBackup()).bytes)).toMatchObject({ renewed: false, added: 3 });
  });

  it(
    "asks the mediator nothing between the two merges: an address only the backup knows stays registered, and what waited there for it is received once the merge is over",
    async () => {
      const mediator = await newMediator();
      const first = await person(mediator, "Alice");
      await first.daemon.close();
      const copy = await folder();
      await cp(path.join(first.root, ".estoc"), path.join(copy, ".estoc"), { recursive: true });

      let merges = 0;
      let secondMergeReached = false;
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      const heard = told();
      const host = nodeHost(copy, { fetch: mediator.fetch, WebSocket: mediator.WebSocket });
      const there = createDaemon(
        {
          ...host,
          async storage() {
            const storage = await host.storage();
            return {
              ...storage,
              async importFile(name, bytes) {
                if (name === "merge-source.sqlite" && ++merges === 2) {
                  secondMergeReached = true;
                  await released;
                }
                return storage.importFile(name, bytes);
              },
            };
          },
        },
        heard.emit
      );
      daemons.push(there);
      await there.boot();
      await there.unlock(PASSPHRASE);
      await there.reconnect();
      await there.createContact("Carmen", pairWith("Carmen"));

      const here = daemonOver(first.root, mediator);
      await here.daemon.boot();
      await here.daemon.unlock(PASSPHRASE);
      const { didId, invitation } = await here.daemon.createInvitation("many");
      const invited = here.heard.snapshot().dids.find((did) => did.didId === didId)!.did!;
      const backup = await here.daemon.exportBackup();
      await here.daemon.close();
      const bob = await person(mediator, "Bob");
      expect(await bob.daemon.acceptInvitation(invitation, "Alice")).toMatchObject({ outcome: "submitted" });
      await bob.daemon.close();
      expect(mediator.recipients.has(invited)).toBe(true);

      const asked = mediator.seenTypes.length;
      const opened = heard.events.filter(([name]) => name === "opened").length;
      const merging = there.mergeBackup(backup.bytes);
      try {
        await until("the second merge is reached", () => secondMergeReached);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(mediator.seenTypes.slice(asked)).toEqual([]);
        expect(heard.events.filter(([name]) => name === "opened")).toHaveLength(opened);
        await expect(there.refresh()).rejects.toThrow("no open vault");
      } finally {
        release();
      }
      expect(await merging).toMatchObject({ renewed: true });
      await until("what waited for the backup's address is received", () => messagesOf(heard.snapshot()).some((message) => message.direction === "in" && message.msg?.type === PING_TYPE));
      expect(mediator.recipients.has(invited)).toBe(true);
      expect(heard.lines()?.discarded ?? []).toEqual([]);
    },
    LONG
  );
});

describe("two daemons over a mediator", () => {
  const stillWaiting = (work: Promise<unknown>) => Promise.race([work.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300))]);

  /** The mediator keeps the first message `held` picks until the release, having received it. */
  function holding(mediator: FakeMediator, held: (message: Parameters<NonNullable<FakeMediator["intercept"]>>[0]) => boolean): { reached(): boolean; release(): void } {
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    mediator.intercept = async (message) => {
      if (reached || !held(message)) return undefined;
      reached = true;
      await released;
      return undefined;
    };
    return { reached: () => reached, release };
  }

  it(
    "waits, closing, for the answer a mediator owes it and asks nothing on that answer: the next daemon over the vault keeps what it registers",
    async () => {
      const mediator = await newMediator();
      const { root, daemon, heard } = await person(mediator, "Alice");
      await until("the first connection is through", () => heard.lines()?.connections[0]?.live === true);

      const query = holding(mediator, (message) => message.type === RECIPIENT_QUERY);
      try {
        const reconnecting = daemon.reconnect();
        await until("the query is with the mediator", query.reached);
        const closing = daemon.close();
        expect(await stillWaiting(closing)).toBe(true);
        await expect(daemon.reconnect()).rejects.toThrow(/no open vault/);
        const seen = mediator.seenTypes.length;
        const said = heard.events.length;
        query.release();
        await closing;
        await reconnecting;
        expect(mediator.seenTypes.slice(seen)).toEqual([]);
        expect(heard.events).toHaveLength(said);

        const next = daemonOver(root, mediator);
        await next.daemon.boot();
        await next.daemon.unlock(PASSPHRASE);
        await next.daemon.createInvitation("one");
        expect(mediator.recipients.size).toBe(1);
        expect(mediator.seenTypes.slice(seen).filter((type) => type === RECIPIENT_UPDATE)).toHaveLength(1);
      } finally {
        query.release();
        mediator.intercept = null;
      }
    },
    LONG
  );

  it(
    "hands the vault on, to the next daemon or to the agent after a merge, only once a removal already with the mediator has landed: what is registered next stays",
    async () => {
      for (const handOn of ["close", "merge"] as const) {
        const mediator = await newMediator();
        const original = await person(mediator, "Alice");
        const before = await original.daemon.exportBackup();
        await original.daemon.createInvitation("one");
        const newer = await original.daemon.exportBackup();
        const registered = [...mediator.recipients.keys()];
        expect(registered).toHaveLength(1);
        await original.daemon.close();

        // Restored from before the invitation, the vault has its agent take the invitation's address away.
        const removal = holding(mediator, (message) => message.type === RECIPIENT_UPDATE && (message.body as { updates: { action: string }[] }).updates.some((update) => update.action === "remove"));
        try {
          const root = await folder();
          const restored = daemonOver(root, mediator);
          await restored.daemon.boot();
          await restored.daemon.restoreIdentity(before.bytes, PASSPHRASE);
          await until("the removal is with the mediator", removal.reached);

          let merged: DaemonCore;
          if (handOn === "close") {
            const closing = restored.daemon.close();
            expect(await stillWaiting(closing)).toBe(true);
            removal.release();
            await closing;
            merged = daemonOver(root, mediator).daemon;
            await merged.boot();
            await merged.unlock(PASSPHRASE);
            await merged.mergeBackup(newer.bytes);
          } else {
            merged = restored.daemon;
            const merging = merged.mergeBackup(newer.bytes);
            expect(await stillWaiting(merging)).toBe(true);
            removal.release();
            await merging;
          }
          await merged.reconnect();
          expect([...mediator.recipients.keys()]).toEqual(registered);
        } finally {
          removal.release();
          mediator.intercept = null;
        }
      }
    },
    LONG
  );

  it(
    "waits as well for what the agent began on its own: the removal a retry has with the mediator lands before the next daemon registers",
    async () => {
      const mediator = await newMediator();
      const original = await person(mediator, "Alice");
      const before = await original.daemon.exportBackup();
      await original.daemon.createInvitation("one");
      const newer = await original.daemon.exportBackup();
      const [[invited, account]] = [...mediator.recipients] as [[string, string]];
      await original.daemon.close();

      const root = await folder();
      const current = daemonOver(root, mediator, { retry: { firstWaitMs: 500 } });
      await current.daemon.boot();
      await current.daemon.restoreIdentity(before.bytes, PASSPHRASE);
      await current.daemon.reconnect();
      await current.daemon.explainedRestore();
      expect(mediator.recipients.has(invited)).toBe(false);
      const bob = await person(mediator, "Bob");
      const { invitation } = await bob.daemon.createInvitation("many");

      // Another copy of the vault, from after the invitation, registers its address again.
      const ahead = daemonOver(await folder(), mediator);
      await ahead.daemon.boot();
      await ahead.daemon.restoreIdentity(newer.bytes, PASSPHRASE);
      await ahead.daemon.reconnect();
      expect(mediator.recipients.get(invited)).toBe(account);
      await ahead.daemon.close();

      // The call answers `pending` on a registration that failed; the retry is the dispatcher's own, and reconciles from a fold without the invitation.
      let refused = false;
      let removing = false;
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      mediator.intercept = async (message, from) => {
        if (from !== account) return undefined;
        if (message.type === RECIPIENT_QUERY && !refused) {
          refused = true;
          throw new Error("not just now");
        }
        if (message.type === RECIPIENT_UPDATE && !removing && (message.body as { updates: { action: string }[] }).updates.some((update) => update.action === "remove")) {
          removing = true;
          await released;
        }
        return undefined;
      };
      try {
        expect((await current.daemon.acceptInvitation(invitation, "Bob")).outcome).toBe("pending");
        await until("the retry's removal is with the mediator", () => removing);
        const closing = current.daemon.close();
        expect(await stillWaiting(closing)).toBe(true);
        release();
        await closing;

        const next = daemonOver(root, mediator);
        await next.daemon.boot();
        await next.daemon.unlock(PASSPHRASE);
        await next.daemon.mergeBackup(newer.bytes);
        await next.daemon.reconnect();
        expect(mediator.recipients.get(invited)).toBe(account);
      } finally {
        release();
        mediator.intercept = null;
      }
    },
    LONG
  );

  test(
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
      await expect(alice.daemon.createContact("Nobody", [])).rejects.toThrow("at least one channel");
      expect(alice.heard.snapshot().contacts).toEqual([]);
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
      expect(merged).toMatchObject({ added: 0, objects: 0 });
      expect(merged.duplicates).toBeGreaterThan(0);
      await until("the agent over the merged vault is live", () => again.heard.events.at(-1)![0] === "lines" && again.heard.lines()!.connections[0]!.live);
      const bobs = await bob.daemon.exportBackup();
      await bob.daemon.eraseMessage(reply.messageId);
      expect(await bob.daemon.mergeBackup(bobs.bytes)).toMatchObject({ added: 0, objects: 0 });

      await again.daemon.forgetIdentity();
      expect(again.heard.phases().at(-1)).toBe("onboarding");
      await expect(stat(path.join(root, ".estoc", "vault.sqlite"))).rejects.toThrow();
    },
    LONG
  );
});

describe("a daemon whose vault records an observation it does not admit", () => {
  const forwardsSeen = (mediator: FakeMediator): number => mediator.seenTypes.filter((type) => type === FORWARD).length;
  const channelIn = (snapshot: Snapshot, channel: Channel) => snapshot.channels.find((record) => record.channel.localDid === channel.localDid && record.channel.peerDid === channel.peerDid)!;
  const liveAfter = (heard: Told, index: number): boolean => heard.events.slice(index).some(([name, lines]) => name === "lines" && (lines as Lines).connections[0]?.live === true);
  /** The records of a snapshot as the UI is handed them. */
  const recordsOf = (snapshot: Snapshot): unknown => JSON.parse(JSON.stringify({ channels: snapshot.channels, unplaced: snapshot.unplaced, pending: snapshot.pending }));
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test(
    "hands the UI the observation as no message: listed under its channel, ignored, with nothing it carries, claiming no name and earning no acknowledgement; the daemon opened again over the vault, and one restored from before it and merged, read the same records and send nothing",
    async () => {
      const mediator = await newMediator();
      const root = await folder();
      const alice = daemonOver(root, mediator);
      await alice.daemon.boot();
      await alice.daemon.createIdentity("Alice", PASSPHRASE);
      await alice.daemon.setMediator(mediator.did);
      await until("alice's line is live", () => alice.heard.lines()?.connections[0]?.live === true);
      const { invitation, didId } = await alice.daemon.createInvitation("many");
      const a0 = alice.heard.snapshot().dids.find((did) => did.didId === didId)!.did!;

      // Bob's first word has Alice move to a private address toward him; he writes there before he moves himself.
      const bob = await run(mediator, 2, BOB, { privateAddresses: false });
      const b0 = bob.party.did;
      await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: invitation.from }, { type: BASIC_MESSAGE, body: { content: "hello" } });
      await until("bob holds alice's move", () => bob.inbounds.length === 1);
      const old = alice.heard.snapshot().channels.find((channel) => channel.channel.localDid === a0)!.head!;
      const a1 = old.localDid;
      await bob.agent.send({ channel: channelOf(b0, a1) }, { type: BASIC_MESSAGE, body: { content: "before I move" } });
      await until("alice reads bob at her new address", () => channelIn(alice.heard.snapshot(), old).messages.some((message) => message.body.state === "available" && message.body.body["content"] === "before I move"));
      expect((await alice.daemon.send({ channel: old }, { type: BASIC_MESSAGE, body: { content: "hello yourself" } })).outcome).toBe("submitted");
      await until("bob reads the answer", () => bob.inbounds.length === 2);
      const before = await alice.daemon.exportBackup();

      await bob.agent.manual.rotate({ localDidId: BOB, peerDid: a1 });
      await until("bob holds alice's acknowledgement of his move", () => bob.inbounds.length === 3);
      await until("alice has the rotation", () => channelIn(alice.heard.snapshot(), old).superseded);

      // Bob's acknowledgement of Alice's move and his word at her new address are admitted there; what he seals by hand from the address he left, a name for himself asking to be acknowledged, is not.
      await forwarded(mediator, a1, await sealed(await peerSealer(bob.party as unknown as DirectParty, b0), a1, { type: PROFILE, body: { profile: { displayName: "Still Bob" } }, please_ack: [""] }));
      const forwards = forwardsSeen(mediator);
      const inbounds = bob.inbounds.length;
      await until("alice holds the observation", () => channelIn(alice.heard.snapshot(), old).observations.length === 3);
      await pause(500);

      const shown = channelIn(alice.heard.snapshot(), old);
      expect(shown.messages.filter(({ direction, msg }) => direction === "in" && msg?.type !== EMPTY_MESSAGE_TYPE).map(({ body }) => (body.state === "available" ? body.body : body.state))).toEqual([{ content: "before I move" }]);
      expect(shown.peerName).toBeNull();
      expect(shown.observations.map(({ standing, disposition, contradicting }) => [standing, disposition, contradicting])).toEqual([
        [{ status: "complete" }, { status: "admitted" }, false],
        [{ status: "complete" }, { status: "admitted" }, false],
        [{ status: "complete" }, { status: "ignored-superseded" }, false],
      ]);
      for (const observation of shown.observations) expect(Object.keys(observation).sort()).toEqual(["at", "channel", "contradicting", "disposition", "messageId", "sourceEventCid", "standing", "verification"]);
      expect(alice.heard.snapshot()).toMatchObject({ unplaced: { inputs: [] }, pending: { pendingOutbounds: [], missingResponses: [] } });
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);
      const settled = recordsOf(alice.heard.snapshot());
      const after = await alice.daemon.exportBackup();
      await alice.daemon.close();

      const again = daemonOver(root, mediator);
      await again.daemon.boot();
      await again.daemon.unlock(PASSPHRASE);
      await until("the line is live again", () => again.heard.lines()?.connections[0]?.live === true);
      await pause(500);
      expect(recordsOf(again.heard.snapshot())).toEqual(settled);
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);
      await again.daemon.close();

      const restored = daemonOver(await folder(), mediator);
      await restored.daemon.boot();
      await restored.daemon.restoreIdentity(before.bytes, PASSPHRASE);
      const merging = restored.heard.events.length;
      expect((await restored.daemon.mergeBackup(after.bytes)).added).toBeGreaterThan(0);
      await until("the merged vault's line is live", () => liveAfter(restored.heard, merging));
      await pause(500);
      expect(recordsOf(restored.heard.snapshot())).toEqual(settled);
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);
    },
    LONG
  );
  /** Alice's backup restored on another machine, the issuer's document brought in there, and that replica exported: the evidence comes back as a backup to merge. */
  async function backupHoldingIssuer(backup: Uint8Array, didId: DidId, prior: MintedDid): Promise<Uint8Array> {
    const root = await folder();
    await writeFile(path.join(root, "backup.sqlite"), backup);
    const source = openPortable(openNodeSqlite(path.join(root, "backup.sqlite"), { mode: "readonly" }));
    let runtime: SqliteVault;
    try {
      const restored = await restoreVault(source, (mode) => openNodeSqlite(path.join(root, "replica.sqlite"), { mode }), {
        heldRoots: vaultHeldRoots(null),
        anchor: async (wrapped) => Keys.anchorOf(await unlockSeedKeystore(wrapped, PASSPHRASE)),
      });
      runtime = new SqliteVault(restored.runtime);
    } finally {
      source.close();
    }
    try {
      await issuerRecovered({ runtime, didId } as Addressed, prior);
      await exportVault(runtime, (mode) => openNodeSqlite(path.join(root, "evidence.sqlite"), { mode }), { heldRoots: vaultHeldRoots(null) });
    } finally {
      await runtime.close();
    }
    return new Uint8Array(await readFile(path.join(root, "evidence.sqlite")));
  }

  const inputsOf = (channel: Snapshot["channels"][number]) => channel.messages.filter(({ direction, msg }) => direction === "in" && msg?.type !== EMPTY_MESSAGE_TYPE).map(({ body, verification }) => [body.state === "available" ? body.body : body.state, verification.status]);

  test(
    "admits the observation once the evidence its proof waited for is merged in: the UI is handed the message with its content, and the acknowledgement it asks for as work owed, sent only by hand; the daemon opened again over the vault reads the same records and sends nothing",
    async () => {
      const mediator = await newMediator();
      const root = await folder();
      const alice = daemonOver(root, mediator);
      await alice.daemon.boot();
      await alice.daemon.createIdentity("Alice", PASSPHRASE);
      await alice.daemon.setMediator(mediator.did);
      await until("alice's line is live", () => alice.heard.lines()?.connections[0]?.live === true);
      const { invitation, didId } = await alice.daemon.createInvitation("many");
      const a0 = alice.heard.snapshot().dids.find((did) => did.didId === didId)!.did!;

      const bob = await run(mediator, 2, BOB, { privateAddresses: false });
      const b0 = bob.party.did;
      await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: invitation.from }, { type: BASIC_MESSAGE, body: { content: "hello" } });
      await until("bob holds alice's move", () => bob.inbounds.length === 1);
      const pair = alice.heard.snapshot().channels.find((channel) => channel.channel.localDid === a0)!.head!;
      const a1 = alice.heard.snapshot().dids.find((did) => did.did === pair.localDid)!.didId;

      // Bob's word at Alice's new address proves his address succeeds one whose document Alice has never held: the observation is recorded, its admission waiting for that document.
      const { prior, proof } = await proofOfSuccession(bob.party, BOB_PRIOR);
      await forwarded(mediator, pair.localDid, await sealed(await peerSealer(bob.party as unknown as DirectParty), pair.localDid, { type: BASIC_MESSAGE, body: { content: "as I was saying" }, from_prior: proof, please_ack: [""] }));
      const forwards = forwardsSeen(mediator);
      const inbounds = bob.inbounds.length;
      await until("alice holds the observation", () => channelIn(alice.heard.snapshot(), pair).observations.some(({ disposition }) => disposition.status === "pending-admission"));
      await pause(500);
      const waiting = channelIn(alice.heard.snapshot(), pair);
      expect(inputsOf(waiting)).toEqual([]);
      expect(waiting.observations.at(-1)).toMatchObject({ standing: { status: "complete" }, verification: { status: "pending-proof" }, disposition: { status: "pending-admission", because: "the source's proof is not yet verified" } });
      expect(alice.heard.snapshot().pending).toMatchObject({ missingResponses: [], pendingProofs: [{ sourceEventCid: waiting.observations.at(-1)!.sourceEventCid, channel: pair }] });

      const evidence = await backupHoldingIssuer((await alice.daemon.exportBackup()).bytes, a1, prior);
      const merging = alice.heard.events.length;
      expect(await alice.daemon.mergeBackup(evidence)).toMatchObject({ added: 1, renewed: false });
      await until("the agent over the merged vault is live", () => liveAfter(alice.heard, merging));
      await pause(500);
      await until("the UI is handed the admission", () => channelIn(alice.heard.snapshot(), pair).observations.at(-1)?.disposition.status === "admitted", 5_000);
      const admitted = channelIn(alice.heard.snapshot(), pair);
      expect(inputsOf(admitted)).toEqual([[{ content: "as I was saying" }, "verified"]]);
      expect(admitted.observations.at(-1)).toMatchObject({ standing: { status: "complete" }, verification: { status: "verified" }, disposition: { status: "admitted" }, contradicting: false });
      expect(alice.heard.snapshot().pending).toMatchObject({ missingResponses: [{ effectType: PURE_ACK_EFFECT, channel: pair }], pendingProofs: [] });
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);
      const settled = recordsOf(alice.heard.snapshot());
      await alice.daemon.close();

      const again = daemonOver(root, mediator);
      await again.daemon.boot();
      await again.daemon.unlock(PASSPHRASE);
      await until("the line is live again", () => again.heard.lines()?.connections[0]?.live === true);
      await pause(500);
      expect(recordsOf(again.heard.snapshot())).toEqual(settled);
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);

      const { executionId } = again.heard.snapshot().pending.missingResponses[0]!;
      expect(await again.daemon.completeResponse(executionId, PURE_ACK_EFFECT)).toEqual({ outcome: "submitted", because: null });
      await until("bob holds the acknowledgement", () => bob.inbounds.length === inbounds + 1);
      expect(forwardsSeen(mediator)).toBe(forwards + 1);
      await until("the acknowledgement is no longer owed", () => again.heard.snapshot().pending.missingResponses.length === 0);
    },
    LONG
  );
});
