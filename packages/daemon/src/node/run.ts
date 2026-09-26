import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DaemonHost } from "../host.js";
import { ESTOC_DIR, nodeHost, type NodeHostOptions } from "./host.js";
import { serveDaemon, type Served } from "./serve.js";

/** The access token that stays with the folder, minted the first time a daemon runs on it. */
export const TOKEN_FILE = "daemon.token";

/**
 * Where the daemon that holds the folder listens, token included, for
 * another process on this machine that finds the folder taken. A daemon
 * that died leaves it behind, so it means something only to somebody
 * the folder was just refused to.
 */
export const SOCKET_FILE = "daemon.url";

export interface RunOptions extends NodeHostOptions {
  /** the folder whose .estoc is the vault */
  root: string;
  port?: number;
  bind?: string;
  /** the built app to serve at `/`; `null` to serve none */
  appDir: string | null;
  /** an app served elsewhere to also print a `?_daemon=` link for */
  app?: string;
  token?: string;
  /** where the lines go (default stderr) */
  log?: (line: string) => void;
}

/**
 * The daemon as a command: take the folder, mint or read its token, serve,
 * print where, boot. Resolves once the daemon is up; `close()` is the
 * caller's (a signal handler in the bins). A folder that holds a vault
 * this version does not read is refused before anything is written to it,
 * and a start that fails past listening closes what it opened before it
 * rejects.
 */
export async function runDaemon(options: RunOptions): Promise<Served> {
  const root = path.resolve(options.root);
  const log = options.log ?? ((line) => process.stderr.write(line + "\n"));
  const files = nodeHost(root, { fetch: options.fetch, WebSocket: options.WebSocket });
  const refusal = await files.foreign?.();
  if (refusal != null) throw new Error(refusal);
  const dir = await vaultDir(root);
  const socketFile = path.join(dir, SOCKET_FILE);
  let folderTaken = false;
  let published = false;
  // Word of where this daemon listens is written and removed only while the folder is held: past
  // the release another daemon may have left its own, which is not this one's to remove.
  const host: DaemonHost = {
    ...files,
    async storage() {
      const taken = await files.storage();
      folderTaken = true;
      return {
        ...taken,
        async close() {
          try {
            if (published) await rm(socketFile, { force: true });
          } finally {
            await taken.close();
          }
        },
      };
    },
  };
  const token = options.token ?? (await storedToken(dir));
  const served = await serveDaemon({
    host,
    bind: options.bind,
    // 3-7-8-6-2: E-S-T-O-C on a phone keypad
    port: options.port ?? 37862,
    token,
    appDir: options.appDir ?? undefined,
  });
  try {
    log(`vault:  ${dir}`);
    log(`socket: ${served.url}`);
    if (served.appUrl !== null) {
      log(`open:   ${served.appUrl}`);
    }
    const elsewhere = options.app ?? (served.appUrl === null ? "https://app.estoc.dev" : undefined);
    if (elsewhere !== undefined) {
      const app = new URL(elsewhere);
      app.searchParams.set("_daemon", served.url);
      log(`${served.appUrl === null ? "open:  " : "or:    "} ${app.href}`);
    }
    // the daemon comes up on its own so a UI that connects finds it booted;
    // a UI's own boot() is then a replay
    await served.daemon.boot();
    // A boot that could not take the folder leaves the daemon up to say so, with no claim on the folder to publish.
    if (folderTaken) {
      await writeFile(socketFile, served.url, { mode: 0o600 });
      published = true;
    }
  } catch (err) {
    // Nobody was handed the server yet, so nobody else can close it.
    await served.close();
    throw err;
  }
  return served;
}

/**
 * `root`/.estoc, made if it is not there and the owner's alone either
 * way. The files inside are created with default modes, so the
 * directory is what keeps them from everybody else on the machine, and
 * one that stood there already may have been made open.
 */
export async function vaultDir(root: string): Promise<string> {
  const dir = path.join(root, ESTOC_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

/** The built app, if `@estoc/app` is installed next to this package. */
export async function installedApp(): Promise<string | null> {
  try {
    // an optional peer: not a dependency of this package, so not a literal
    // the compiler would resolve
    const name = "@estoc/app";
    const mod = (await import(name)) as { appDir: string };
    await readFile(path.join(mod.appDir, "index.html"));
    return mod.appDir;
  } catch {
    return null;
  }
}

export function exitOnSignal(served: Served): void {
  const stop = () => {
    void served.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function storedToken(dir: string): Promise<string> {
  const file = path.join(dir, TOKEN_FILE);
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (token !== "") {
      return token;
    }
  } catch {
    // none yet
  }
  const token = randomBytes(24).toString("base64url");
  await writeFile(file, token, { mode: 0o600 });
  return token;
}
