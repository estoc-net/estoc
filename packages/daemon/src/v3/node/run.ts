import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
 * this version does not read is refused before anything is written to it.
 */
export async function runDaemon(options: RunOptions): Promise<Served> {
  const root = path.resolve(options.root);
  const dir = path.join(root, ESTOC_DIR);
  const log = options.log ?? ((line) => process.stderr.write(line + "\n"));
  const host = nodeHost(root, { fetch: options.fetch, WebSocket: options.WebSocket });
  const refusal = await host.unreadable?.();
  if (refusal != null) throw new Error(refusal);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const token = options.token ?? (await storedToken(dir));
  const served = await serveDaemon({
    host,
    bind: options.bind,
    // 3-7-8-6-2: E-S-T-O-C on a phone keypad
    port: options.port ?? 37862,
    token,
    appDir: options.appDir ?? undefined,
  });
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
  // Past the boot the folder is this daemon's: one still waiting for it has nothing to say where it listens.
  const socketFile = path.join(dir, SOCKET_FILE);
  await writeFile(socketFile, served.url, { mode: 0o600 });
  return {
    ...served,
    async close() {
      await served.close();
      await rm(socketFile, { force: true });
    },
  };
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

/** Wire SIGINT/SIGTERM to closing the daemon and exiting. */
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
