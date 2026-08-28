// Copy the built app (app/dist) into this package as app/, so estoc-daemon
// serves the UI itself. Run after `pnpm --filter estoc-app build`.
import { cp, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../app/dist/", import.meta.url));
const to = fileURLToPath(new URL("../app/", import.meta.url));
try {
  await stat(new URL("index.html", `file://${from}`));
} catch {
  console.error(`bundle-app: no app build at ${from} — run \`pnpm --filter estoc-app build\` first`);
  process.exit(1);
}
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log(`bundle-app: ${from} → ${to}`);
