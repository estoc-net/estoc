#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ESTOC_DIR } from "@estoc/agent-core";

import { nodeHost } from "./host.js";
import { serveDaemon } from "./serve.js";

const USAGE = `usage: estoc-daemon [folder] [options]

  Run the Estoc daemon on a folder: <folder>/.estoc is the vault, and the
  app connects to this process instead of running its own agent. Open the
  link it prints; the app remembers it (\`?_daemon=off\` forgets).

  --port <n>      listen on this port (default 7357; 0 picks a free one)
  --bind <addr>   listen on this address (default 127.0.0.1)
  --app <url>     the app to print a link for (default https://app.estoc.dev)
  --token <t>     the access token (default: kept in .estoc/cache/daemon.token)
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: "string", default: "7357" },
      bind: { type: "string", default: "127.0.0.1" },
      app: { type: "string", default: "https://app.estoc.dev" },
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
  const served = await serveDaemon({
    host: nodeHost(root),
    bind: values.bind,
    port: Number(values.port),
    token,
  });
  const app = new URL(values.app);
  app.searchParams.set("_daemon", served.url);
  process.stderr.write(`vault:  ${path.join(root, ESTOC_DIR)}\nsocket: ${served.url}\nopen:   ${app.href}\n`);
  // the daemon comes up on its own so a UI that connects finds it booted;
  // a UI's own boot() is then a replay
  await served.daemon.boot();
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

main().catch((err: unknown) => {
  process.stderr.write(`estoc-daemon: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
