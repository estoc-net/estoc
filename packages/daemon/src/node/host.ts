import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { openNodeSqlite } from "@estoc/event-store/node";
import { DatabaseExists, type SqliteDriver } from "@estoc/event-store";
import type { DidcommApi } from "@estoc/agent-core";

import { guardedFetch } from "./guarded-fetch.js";
import type { DaemonHost, DaemonStorage } from "../host.js";

/** Where a folder keeps its vault: beside the person's files, never among them. */
export const ESTOC_DIR = ".estoc";

/** The empty database a daemon holds open for as long as the folder is its own. */
const OWNER_FILE = "owner.sqlite";

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
 * vault, and a snapshot in transit is a file beside it. The folder is
 * one daemon's at a time through SQLite's own locking, on a database
 * kept for nothing else: the vault's lock alone covers neither the
 * moments the vault is closed — between a lock and an unlock, before a
 * removal — nor a file that does not exist yet, and a lock SQLite holds
 * goes with the process that held it, so a second daemon on the folder
 * waits and none needs a pid file. The seed unlocked from the vault's
 * wrapper lives in this process's memory only: every start is a locked
 * vault until a UI gives the passphrase.
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

  /** Two daemons that both find no owner file race to make it; the one that loses opens what the other made, and SQLite's lock decides between them. */
  function takeFolder(): SqliteDriver {
    try {
      return openNodeSqlite(fileOf(OWNER_FILE), { mode: "create", journal: "delete" });
    } catch (err) {
      if (!(err instanceof DatabaseExists)) throw err;
    }
    return openNodeSqlite(fileOf(OWNER_FILE), { mode: "readwrite" });
  }

  function storageUnder(owner: SqliteDriver): DaemonStorage {
    return {
      has: (name) => exists(fileOf(name)),
      open: async (name, mode, kind) => openNodeSqlite(fileOf(name), { mode, journal: kind === "runtime" ? "wal" : "delete" }),
      exportFile: async (name) => new Uint8Array(await readFile(fileOf(name))),
      importFile: (name, bytes) => writeFile(fileOf(name), bytes, { flag: "wx", mode: 0o600 }),
      async remove(name) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(fileOf(name) + suffix, { force: true });
      },
      close: async () => owner.close(),
    };
  }

  return {
    async storage() {
      await mkdir(dir, { recursive: true });
      return storageUnder(takeFolder());
    },
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
      const { Message } = await import("@estoc/didcomm-node");
      return { Message } as unknown as DidcommApi;
    },
    agentOptions: { fetch: options.fetch ?? guardedFetch, WebSocket: options.WebSocket },
  };
}
