/**
 * The wasm adapter in a real browser: the page script and the Worker
 * script are bundled with esbuild and served, with `sqlite3.wasm`, to a
 * headless Chromium over localhost (a secure context, which OPFS
 * needs); the page drives the Workers and the results come back — one
 * vitest case per driver, open, event, object, vault, export and pool
 * case, and per case of the page's own. The one input the Worker cannot make for
 * itself, a UTF-16 database, is made here with Node's SQLite. Skipped, loudly, when no Chromium is found;
 * `ESTOC_BROWSER=/path/to/chrome` names one.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";

import { findChromium } from "../../browser/chromium.js";
import { poolCases } from "../../browser/pool-cases.js";
import type { WorkerCaseResult } from "../../browser/sqlite-worker.js";
import { driverCases } from "./driver-cases.js";
import { eventCases } from "./event-cases.js";
import { exportCases } from "./export-cases.js";
import { importCases } from "./import-cases.js";
import { objectCases } from "./object-cases.js";
import { openCases } from "./open-cases.js";
import { utf16Forged, utf16Snapshot } from "./utf16.js";
import { vaultCases } from "./vault-cases.js";

const browserPath = findChromium();
if (browserPath === null) {
  console.warn("SQLite driver cases in Chromium skipped: no Chromium found (set ESTOC_BROWSER to a Chrome or Chromium binary)");
}

const PAGE_CASES = [
  "the pool is refused on the main thread",
  "a second Worker is refused the directory another holds, and admitted once it is released",
  "a terminated Worker's directory frees up for the next",
];

describe.skipIf(browserPath === null)("sqlite-wasm driver (in a Chromium Worker)", () => {
  const results = new Map<string, WorkerCaseResult>();
  let server: http.Server | undefined;

  beforeAll(async () => {
    const bundle = async (entry: string, format: "iife" | "esm"): Promise<string> => {
      const out = await build({
        entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
        bundle: true,
        format,
        platform: "browser",
        target: "es2022",
        write: false,
      });
      return out.outputFiles[0]?.text ?? "";
    };
    const page = await bundle("../../browser/sqlite-page.ts", "iife");
    const worker = await bundle("../../browser/sqlite-worker.ts", "esm");
    const wasm = await readFile(createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"));
    const html = `<!doctype html><meta charset="utf-8"><title>sqlite</title><script>${page}</script>`;
    const dir = await mkdtemp(path.join(tmpdir(), "estoc-utf16-"));
    const utf16 = { snapshot: Array.from(await utf16Snapshot(path.join(dir, "snapshot.sqlite"))), forged: Array.from(await utf16Forged(path.join(dir, "forged.sqlite"))) };
    await rm(dir, { recursive: true, force: true });
    server = http.createServer((req, res) => {
      if (req.url === "/worker.js") {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(worker);
      } else if (req.url === "/sqlite3.wasm") {
        res.setHeader("content-type", "application/wasm");
        res.end(wasm);
      } else {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const browser = await chromium.launch({ executablePath: browserPath as string, headless: true, chromiumSandbox: false });
    try {
      const tab = await browser.newPage();
      tab.on("pageerror", (err) => console.error("page error:", err));
      tab.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") console.error(`browser ${message.type()}:`, message.text());
      });
      await tab.goto(`http://127.0.0.1:${port}/`);
      for (const result of await tab.evaluate((bytes) => window.runSqliteSuite(bytes), utf16)) {
        results.set(result.name, result);
        if (result.note !== undefined) console.info(`in Chromium: ${result.name}: ${result.note}`);
      }
    } finally {
      await browser.close();
    }
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  });

  function report(result: WorkerCaseResult | undefined): void {
    if (result === undefined) throw new Error("the browser reported nothing for this case");
    if (result.error !== undefined) throw new Error(result.error);
  }

  for (const c of driverCases) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const c of openCases) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const c of eventCases) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const c of objectCases) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const c of vaultCases) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const c of exportCases) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const c of importCases) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const c of poolCases) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const name of PAGE_CASES) {
    it(name, () => report(results.get(name)));
  }
});
