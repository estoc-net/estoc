import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ESTOC_DIR } from "@estoc/agent-core";

import { nodeHost } from "./host.js";
import { serveDaemon, type Served } from "./serve.js";

export interface RunOptions {
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
 * caller's (a signal handler in the bins).
 */
export async function runDaemon(options: RunOptions): Promise<Served> {
  const root = path.resolve(options.root);
  const log = options.log ?? ((line) => process.stderr.write(line + "\n"));
  const token = options.token ?? (await storedToken(root));
  const served = await serveDaemon({
    host: nodeHost(root),
    bind: options.bind,
    port: options.port ?? 7357,
    token,
    appDir: options.appDir ?? undefined,
  });
  log(`vault:  ${path.join(root, ESTOC_DIR)}`);
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
  return served;
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

/** The token that stays with the vault, minted the first time. */
async function storedToken(root: string): Promise<string> {
  const file = path.join(root, ESTOC_DIR, "cache", "daemon.token");
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (token !== "") {
      return token;
    }
  } catch {
    // none yet
  }
  const token = randomBytes(24).toString("base64url");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, token, { mode: 0o600 });
  return token;
}
