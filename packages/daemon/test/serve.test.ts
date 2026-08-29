import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterAll, describe, expect, it } from "vitest";

import { connect, decode, encode, type Daemon, type DaemonEvents, type Port } from "../src/index.js";
import { nodeHost, serveDaemon } from "../src/node/index.js";

/** A ws client as the port the RPC speaks over — what the app's client.ts does. */
async function clientPort(url: string): Promise<Port> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    postMessage: (m) => ws.send(encode(m)),
    addEventListener(type: "message" | "close", listener: (event: MessageEvent) => void) {
      if (type === "close") {
        ws.on("close", () => (listener as () => void)());
      } else {
        ws.on("message", (data) => listener({ data: decode(data.toString()) } as MessageEvent));
      }
    },
  } as Port;
}

function recorder(): { events: [string, ...unknown[]][]; handlers: DaemonEvents; next(name: string): Promise<unknown[]> } {
  const events: [string, ...unknown[]][] = [];
  const waiting = new Map<string, (args: unknown[]) => void>();
  const handlers = new Proxy({} as DaemonEvents, {
    get: (_, name: string) => (...args: unknown[]) => {
      events.push([name, ...args]);
      waiting.get(name)?.(args);
    },
  });
  return {
    events,
    handlers,
    next: (name) => new Promise((resolve) => waiting.set(name, resolve)),
  };
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true });
  }
});

describe("the daemon over a socket", () => {
  it("boots a folder to onboarding, mints an identity, replays for a second client, refuses a bad token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "estoc-daemon-"));
    dirs.push(root);
    const served = await serveDaemon({ host: nodeHost(root), port: 0, token: "t0k3n" });
    try {
      const a = recorder();
      const alice = connect<Daemon>(await clientPort(served.url), a.handlers as never);
      const phase = a.next("phase");
      await alice.boot();
      expect(await phase).toEqual(["onboarding"]);

      const opened = a.next("opened");
      await alice.createIdentity("Alice", "alice-passes-the-salt");
      const [snapshot] = (await opened) as [{ label: string; contacts: unknown[] }];
      expect(snapshot.label).toBe("Alice");
      expect(snapshot.contacts).toEqual([]);
      await stat(path.join(root, ".estoc", "config.json"));
      await stat(path.join(root, ".estoc", "cache", "daemon.pid"));

      // a second UI joins: its boot is a replay, not a second open
      const b = recorder();
      const again = connect<Daemon>(await clientPort(served.url), b.handlers as never);
      const replayed = b.next("opened");
      await again.boot();
      expect(((await replayed)[0] as { label: string }).label).toBe("Alice");
      expect(a.events.filter(([name]) => name === "opened")).toHaveLength(1);

      // bytes cross: the backup is the vault zipped
      const backup = await alice.exportBackup();
      expect(backup.bytes).toBeInstanceOf(Uint8Array);
      expect(backup.name).toMatch(/^Alice-.*\.estoc\.zip$/);

      // no token, no service
      const bad = new WebSocket(served.url.replace(/token=.*$/, "token=nope"));
      const outcome = await new Promise<string>((resolve) => {
        bad.once("open", () => resolve("open"));
        bad.once("error", () => resolve("refused"));
      });
      expect(outcome).toBe("refused");

      // lock, and the seed is gone from memory: a fresh boot is locked
      await alice.lock();
      expect(a.events.at(-1)).toEqual(["phase", "locked"]);
      await expect(alice.unlock("wrong")).rejects.toThrow(/wrong passphrase/);
      const reopened = a.next("opened");
      await alice.unlock("alice-passes-the-salt");
      await reopened;
    } finally {
      await served.close();
    }
  });

  it("keeps the trace level as a device preference, remembered across runs and not in the vault", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "estoc-daemon-"));
    dirs.push(root);
    let served = await serveDaemon({ host: nodeHost(root), port: 0, token: "t0k3n" });
    try {
      const a = recorder();
      const alice = connect<Daemon>(await clientPort(served.url), a.handlers as never);
      await alice.boot();
      const opened = a.next("opened");
      await alice.createIdentity("Alice", "alice-passes-the-salt");
      await opened;
      expect(await alice.traceLevel()).toBe("normal");
      expect(await alice.traceOf("no-such-record")).toEqual([]);
      await expect(alice.setTraceLevel("loud" as never)).rejects.toThrow(/no such trace level/);

      expect(await alice.setTraceLevel("off")).toBe("off");
      expect((await readFile(path.join(root, ".estoc", "cache", "trace-level"), "utf8")).trim()).toBe("off");
    } finally {
      await served.close();
    }

    // a later run of the daemon on the same folder keeps the preference; the vault carries none of it
    served = await serveDaemon({ host: nodeHost(root), port: 0, token: "t0k3n" });
    try {
      const b = recorder();
      const again = connect<Daemon>(await clientPort(served.url), b.handlers as never);
      await again.boot();
      expect(await again.traceLevel()).toBe("off");
      expect(await again.setTraceLevel("verbose")).toBe("verbose");
    } finally {
      await served.close();
    }
  });
});
