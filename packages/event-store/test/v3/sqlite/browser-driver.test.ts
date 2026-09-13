/**
 * The wasm adapter in a real browser: the page script and the Worker
 * script are bundled with esbuild and served, with `sqlite3.wasm`, to a
 * headless Chromium over localhost (a secure context, which OPFS
 * needs); the page drives the Workers, running at once, and the results come back — one
 * vitest case per driver, open, event, object, vault, export, import
 * and pool case, per test of the three conformance suites, and per
 * case of the page's own. The Worker's bundle gets the suites' `vitest`
 * from `test/browser/vitest-stand-in.ts`, which collects the tests for
 * the Worker to run. What the Worker cannot make for itself is made
 * here with Node's SQLite — a UTF-16 database, and a portable snapshot
 * of a sample vault, which the Worker inspects, restores, extends and
 * exports back, for the snapshot it made to be inspected and imported
 * here: the two platforms exchanging one format, each way. The page
 * is given the DevTools protocol before it loads, to measure what its
 * Workers hold. Skipped, loudly, when no Chromium is found;
 * `ESTOC_BROWSER=/path/to/chrome` names one.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type Browser, chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "../../../src/node.js";
import { exportVault, importVault, openPortable } from "../../../src/v3/index.js";
import { findChromium } from "../../browser/chromium.js";
import { poolCases } from "../../browser/pool-cases.js";
import type { SuiteOutput } from "../../browser/sqlite-page.js";
import type { WorkerCaseResult } from "../../browser/sqlite-worker.js";
import { driverCases } from "./driver-cases.js";
import { eventCases } from "./event-cases.js";
import { fillSample, inspectPortable, type Inspection } from "./exchange.js";
import { destination, exportCases, type ExportHarness, opened } from "./export-cases.js";
import { importCases } from "./import-cases.js";
import { objectCases } from "./object-cases.js";
import { openCases } from "./open-cases.js";
import { utf16Forged, utf16Snapshot } from "./utf16.js";
import { clock, make, retainedOf, rootsOf, vaultCases, vaultOver } from "./vault-cases.js";

const browserPath = findChromium();
if (browserPath === null) {
  console.warn("SQLite driver cases in Chromium skipped: no Chromium found (set ESTOC_BROWSER to a Chrome or Chromium binary)");
}

const PAGE_CASES = [
  "the pool is refused on the main thread",
  "a second Worker is refused the directory another holds, and admitted once it is released",
  "a terminated Worker's directory frees up for the next",
];

const SUITES = ["SqliteEventStore in the pool", "SqliteObjectStore in the pool", "SqliteVault in the pool"];

const BROWSER_TIME_LIMIT = 600_000;

interface Outcome extends SuiteOutput {
  /** The inputs' directory, and the sample vault in it the snapshot was exported from. */
  dir: string;
  sampleVault: string;
  /** The snapshot sent, inspected here before it went. */
  sample: Inspection;
}

async function bundle(entry: string, format: "iife" | "esm", alias: Record<string, string> = {}): Promise<string> {
  const out = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    format,
    platform: "browser",
    target: "es2022",
    write: false,
    alias,
  });
  return out.outputFiles[0]?.text ?? "";
}

/** Gives the page a channel to the DevTools protocol, as `window.devtools`, so it can measure what its Workers hold; done before the page loads. */
async function exposeDevTools(browser: Browser): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  const page = targetInfos.find((info) => info.type === "page");
  if (page === undefined) throw new Error("no page target to expose the DevTools protocol to");
  await session.send("Target.exposeDevToolsProtocol", { targetId: page.targetId, bindingName: "devtools" });
  await session.detach();
}

/** Everything the browser is given, everything it reports, and the sample as inspected here. */
async function inChromium(executablePath: string): Promise<Outcome> {
  const dir = await mkdtemp(path.join(tmpdir(), "estoc-browser-"));
  let n = 0;
  const harness: ExportHarness = {
    fresh: () => path.join(dir, `vault-${n++}.sqlite`),
    open: async (target, mode) => openNodeSqlite(target, { mode }),
    fileBytes: async (target) => new Uint8Array(await readFile(target)),
  };
  const sampleVault = harness.fresh();
  const { vault } = await make(harness, sampleVault, clock().now);
  await fillSample(vault, clock());
  const snapshotFile = harness.fresh();
  await exportVault(vault, destination(harness, snapshotFile), { heldRoots: rootsOf });
  await vault.close();
  const sent = await opened(harness, snapshotFile);
  const sample = await inspectPortable(sent);
  sent.close();
  const input = {
    utf16: { snapshot: Array.from(await utf16Snapshot(path.join(dir, "utf16.sqlite"))), forged: Array.from(await utf16Forged(path.join(dir, "forged.sqlite"))) },
    snapshot: Array.from(await readFile(snapshotFile)),
  };

  const page = await bundle("../../browser/sqlite-page.ts", "iife");
  const worker = await bundle("../../browser/sqlite-worker.ts", "esm", { vitest: fileURLToPath(new URL("../../browser/vitest-stand-in.ts", import.meta.url)) });
  const wasm = await readFile(createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"));
  const html = `<!doctype html><meta charset="utf-8"><title>sqlite</title><script>${page}</script>`;
  const server = http.createServer((req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // A profile on disk: its storage quota follows the disk, where an ephemeral context's follows memory and runs out under the large cases' databases all at once.
  const context = await chromium.launchPersistentContext(path.join(dir, "profile"), { executablePath, headless: true, chromiumSandbox: false });
  let expired: ReturnType<typeof setTimeout> | undefined;
  try {
    const browser = context.browser();
    if (browser === null) throw new Error("the persistent context has no browser to expose the DevTools protocol from");
    const tab = context.pages()[0] ?? (await context.newPage());
    await exposeDevTools(browser);
    tab.on("pageerror", (err) => console.error("page error:", err));
    tab.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") console.error(`browser ${message.type()}:`, message.text());
    });
    await tab.goto(`http://127.0.0.1:${port}/`);
    const output = await Promise.race([
      tab.evaluate((given) => window.runSqliteSuite(given), input),
      new Promise<never>((_, reject) => {
        expired = setTimeout(() => reject(new Error(`the browser did not finish within ${BROWSER_TIME_LIMIT / 1000} s`)), BROWSER_TIME_LIMIT);
      }),
    ]);
    for (const result of [...output.results, ...output.suites]) {
      if (result.note !== undefined) console.info(`in Chromium: ${result.name}: ${result.note}`);
    }
    return { ...output, dir, sampleVault, sample };
  } finally {
    clearTimeout(expired);
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const outcome = browserPath === null ? undefined : await inChromium(browserPath);

afterAll(async () => {
  if (outcome !== undefined) await rm(outcome.dir, { recursive: true, force: true });
});

describe.skipIf(outcome === undefined)("sqlite-wasm driver (in a Chromium Worker)", () => {
  const results = new Map<string, WorkerCaseResult>((outcome?.results ?? []).map((result) => [result.name, result]));
  const suites = outcome?.suites ?? [];

  function report(result: WorkerCaseResult | undefined): void {
    if (result === undefined) throw new Error("the browser reported nothing for this case");
    if (result.error !== undefined) throw new Error(result.error);
  }

  for (const c of [...driverCases, ...openCases, ...eventCases, ...objectCases, ...vaultCases, ...exportCases, ...importCases, ...poolCases]) {
    it(c.name, () => report(results.get(c.name)));
  }
  for (const name of PAGE_CASES) {
    it(name, () => report(results.get(name)));
  }

  describe("the conformance suites over the pool", () => {
    for (const suite of SUITES) {
      it(`${suite}: collected`, () => {
        expect(suites.filter((result) => result.name.startsWith(suite)).length).toBeGreaterThan(0);
      });
    }
    for (const result of suites) {
      it(result.name, () => report(result));
    }
  });

  describe("a portable snapshot crossing platforms", () => {
    it("the snapshot node:sqlite exported inspects in Chromium as it does here", () => {
      expect(outcome?.exchanged.inspected).toEqual(outcome?.sample);
    });

    it("the snapshot Chromium exported, continued from the one it was sent, inspects here as it did there, and imports into the sample vault", async () => {
      if (outcome === undefined) return;
      const { exchanged, sample, dir, sampleVault } = outcome;
      expect(exchanged.continued.events).toHaveLength(sample.events.length + 1);
      expect(exchanged.continued.objects).toHaveLength(sample.objects.length + 1);
      const file = path.join(dir, "continued.sqlite");
      await writeFile(file, new Uint8Array(exchanged.bytes));
      const back = openPortable(openNodeSqlite(file, { mode: "readonly" }));
      try {
        expect(await inspectPortable(back)).toEqual(exchanged.continued);
        const { vault } = await vaultOver(openNodeSqlite(sampleVault, { mode: "readwrite" }), clock().now);
        try {
          expect(await importVault(vault, back, { retainedRoots: retainedOf })).toEqual({ added: 1, duplicates: sample.events.length, conflicts: [], objects: 1, repaired: 0 });
        } finally {
          await vault.close();
        }
      } finally {
        back.close();
      }
    });
  });
});
