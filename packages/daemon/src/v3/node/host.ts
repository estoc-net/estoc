import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { openNodeSqlite } from "@estoc/event-store/node";
import type { DidcommApi } from "@estoc/agent-core";

import { guardedFetch } from "../../node/guarded-fetch.js";
import type { DaemonHost, DaemonStorage } from "../host.js";

/** Where a folder keeps its vault: beside the person's files, never among them. */
export const ESTOC_DIR = ".estoc";

export interface NodeHostOptions {
  /**
   * The transports of the agent. Every address the default fetch is
   * given — a mediator's, a peer's endpoint, a `did:web` document's —
   * is somebody else's word, and it refuses any that is not public; a
   * mediator on this machine needs a fetch that reaches it.
   */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
}

/**
 * The daemon in a folder on disk: `<root>/.estoc/vault.sqlite` is the
 * vault, owned through SQLite's own locking for as long as it is open,
 * so a second daemon on the folder waits and none needs a pid file. A
 * snapshot in transit is a file beside it. The seed unlocked from the
 * vault's wrapper lives in this process's memory only: every start is
 * a locked vault until a UI gives the passphrase.
 */
export function nodeHost(root: string, options: NodeHostOptions = {}): DaemonHost {
  const dir = path.join(root, ESTOC_DIR);
  const fileOf = (name: string): string => {
    if (name !== path.basename(name)) throw new Error(`${name} is no file name`);
    return path.join(dir, name);
  };
  const exists = (file: string): Promise<boolean> =>
    stat(file).then(
      () => true,
      () => false
    );
  let seedKey: Awaited<ReturnType<DaemonHost["cachedSeedKey"]>> = null;

  const storage: DaemonStorage = {
    has: (name) => exists(fileOf(name)),
    async open(name, mode, kind) {
      if (mode === "create") await mkdir(dir, { recursive: true });
      return openNodeSqlite(fileOf(name), { mode, journal: kind === "runtime" ? "wal" : "delete" });
    },
    exportFile: async (name) => new Uint8Array(await readFile(fileOf(name))),
    async importFile(name, bytes) {
      await mkdir(dir, { recursive: true });
      await writeFile(fileOf(name), bytes, { flag: "wx", mode: 0o600 });
    },
    async remove(name) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(fileOf(name) + suffix, { force: true });
    },
  };

  return {
    storage: async () => storage,
    async unreadable() {
      if (!(await exists(path.join(dir, "config.json")))) return null;
      return `${dir} holds a vault of the folder format, which this version does not read or migrate; it is left as it is`;
    },
    cachedSeedKey: async () => seedKey,
    async cacheSeedKey(key) {
      seedKey = key;
    },
    async forgetSeedKey() {
      seedKey = null;
    },
    async didcomm(): Promise<DidcommApi> {
      const { Message, FromPrior } = await import("@estoc/didcomm-node");
      return { Message, FromPrior } as unknown as DidcommApi;
    },
    agentOptions: { fetch: options.fetch ?? guardedFetch, WebSocket: options.WebSocket },
  };
}
