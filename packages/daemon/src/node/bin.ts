#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ESTOC_DIR } from "@estoc/agent-core";

import { nodeHost } from "./host.js";
import { serveDaemon } from "./serve.js";

const USAGE = `usage: estoc-daemon [folder] [options]

  Run the Estoc daemon on a folder: <folder>/.estoc is the vault, and the
  app connects to this process instead of running its own agent. The
  daemon serves the app itself: open the link it prints.

  --port <n>      listen on this port (default 7357; 0 picks a free one)
  --bind <addr>   listen on this address (default 127.0.0.1)
  --app <url>     also print a link for an app served elsewhere (e.g. a dev
                  server): that page connects here with \`?_daemon=\` and the
                  token, and remembers it until \`?_daemon=off\`
  --no-serve      do not serve the app; --app then defaults to https://app.estoc.dev
  --token <t>     the access token (default: kept in .estoc/cache/daemon.token)
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: "string", default: "7357" },
      bind: { type: "string", default: "127.0.0.1" },
      app: { type: "string" },
      serve: { type: "boolean", default: true },
      token: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const root = path.resolve(positionals[0] ?? ".");
  const token = values.token ?? (await storedToken(root));
  const appDir = values.serve ? await bundledApp() : undefined;
  if (values.serve && appDir === undefined) {
    process.stderr.write("estoc-daemon: no app bundled with this install; printing a link to app.estoc.dev instead\n");
  }
  const served = await serveDaemon({
    host: nodeHost(root),
    bind: values.bind,
    port: Number(values.port),
    token,
    appDir,
  });
  const lines = [`vault:  ${path.join(root, ESTOC_DIR)}`, `socket: ${served.url}`];
  if (served.appUrl !== null) {
    lines.push(`open:   ${served.appUrl}`);
  }
  const elsewhere = values.app ?? (served.appUrl === null ? "https://app.estoc.dev" : undefined);
  if (elsewhere !== undefined) {
    const app = new URL(elsewhere);
    app.searchParams.set("_daemon", served.url);
    lines.push(`${served.appUrl === null ? "open:  " : "or:    "} ${app.href}`);
  }
  process.stderr.write(lines.join("\n") + "\n");
  // the daemon comes up on its own so a UI that connects finds it booted;
  // a UI's own boot() is then a replay
  await served.daemon.boot();
  const stop = () => {
    void served.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** The app built into this package (app/ next to dist/), if it is there. */
async function bundledApp(): Promise<string | undefined> {
  const dir = fileURLToPath(new URL("../../app/", import.meta.url));
  try {
    await readFile(path.join(dir, "index.html"));
    return dir;
  } catch {
    return undefined;
  }
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

main().catch((err: unknown) => {
  process.stderr.write(`estoc-daemon: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
