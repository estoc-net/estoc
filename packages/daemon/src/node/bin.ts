#!/usr/bin/env node
import { parseArgs } from "node:util";

import { exitOnSignal, installedApp, runDaemon } from "./run.js";

const USAGE = `usage: estoc-daemon [folder] [options]

  Run the Estoc daemon on a folder: <folder>/.estoc is the vault, and the
  app connects to this process instead of running its own agent. With
  @estoc/app installed (\`estoc serve\` brings it) the daemon serves the
  app itself: open the link it prints.

  --port <n>        listen on this port (default 37862; 0 picks a free one)
  --bind <addr>     listen on this address (default 127.0.0.1)
  --app-dir <dir>   serve the app from this directory (default: @estoc/app)
  --no-serve        do not serve the app; --app then defaults to https://app.estoc.dev
  --app <url>       also print a link for an app served elsewhere (e.g. a dev
                    server): that page connects here with \`?_daemon=\` and the
                    token, and remembers it until \`?_daemon=off\`
  --token <t>       the access token (default: kept in .estoc/cache/daemon.token)
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: "string", default: "37862" },
      bind: { type: "string", default: "127.0.0.1" },
      "app-dir": { type: "string" },
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
  const appDir = !values.serve ? null : (values["app-dir"] ?? (await installedApp()));
  if (values.serve && appDir === null) {
    process.stderr.write("estoc-daemon: @estoc/app is not installed here; printing a link to app.estoc.dev instead\n");
  }
  const served = await runDaemon({
    root: positionals[0] ?? ".",
    port: Number(values.port),
    bind: values.bind,
    appDir,
    app: values.app,
    token: values.token,
  });
  exitOnSignal(served);
}

main().catch((err: unknown) => {
  process.stderr.write(`estoc-daemon: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
