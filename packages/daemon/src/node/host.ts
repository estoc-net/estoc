import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ESTOC_DIR, type TraceLevel } from "@estoc/vault";
import { FsBackend } from "@estoc/vault/node";
import type { DidcommApi } from "@estoc/agent-core";

import type { DaemonHost } from "../host.js";
import { guardedFetch } from "./guarded-fetch.js";

/**
 * The daemon in a folder on disk: `<root>/.estoc/` is the vault (the git
 * model — the person's files stay theirs, the machinery is in `.estoc`).
 * One daemon per folder is kept by a pid file under `.estoc/cache/`,
 * which snapshots skip; the seed unlocked from the keystore lives in this
 * process's memory only, so every start is a locked vault until a UI
 * types the passphrase.
 */
export function nodeHost(root: string): DaemonHost {
  const dir = path.join(root, ESTOC_DIR);
  const pidFile = path.join(dir, "cache", "daemon.pid");
  /** the trace level, a device preference: under cache/ like the pid, where snapshots do not look */
  const traceFile = path.join(dir, "cache", "trace-level");
  let seedKey: CryptoKey | null = null;

  async function takePid(): Promise<boolean> {
    await mkdir(path.dirname(pidFile), { recursive: true });
    try {
      await writeFile(pidFile, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") {
        throw err;
      }
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) {
      return false;
    }
    // stale: whoever wrote it is gone
    await rm(pidFile, { force: true });
    return takePid();
  }

  return {
    async lock(onWaiting) {
      if (await takePid()) {
        return;
      }
      onWaiting();
      while (!(await takePid())) {
        await sleep(2000);
      }
    },
    async backend() {
      return new FsBackend(root);
    },
    async wipe() {
      await rm(dir, { recursive: true, force: true });
      await takePid();
    },
    cachedSeedKey: async () => seedKey,
    async cacheSeedKey(key) {
      seedKey = key;
    },
    async forgetSeedKey() {
      seedKey = null;
    },
    async traceLevel() {
      try {
        const text = (await readFile(traceFile, "utf8")).trim();
        return text === "off" || text === "verbose" ? text : "normal";
      } catch {
        return "normal";
      }
    },
    async setTraceLevel(level: TraceLevel) {
      await mkdir(path.dirname(traceFile), { recursive: true });
      await writeFile(traceFile, level + "\n");
    },
    async didcomm(): Promise<DidcommApi> {
      const { Message, FromPrior } = await import("didcomm-node");
      return { Message, FromPrior } as unknown as DidcommApi;
    },
    agentOptions: { packageFetch: guardedFetch },
  };
}

/** Whether a process with this pid exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}
