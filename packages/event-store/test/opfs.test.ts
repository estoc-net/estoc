/**
 * The OPFS backend in a real browser: the backend cases are bundled with
 * esbuild, served to a headless Chromium over localhost (a secure
 * context, which OPFS needs), run there, and their results read back —
 * one vitest case per backend case. Skipped, loudly, when no Chromium is
 * found; `ESTOC_BROWSER=/path/to/chrome` names one.
 */

import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";

import { backendCases } from "./suite/backend-cases.js";
import type { CaseResult } from "./browser/opfs-entry.js";

function findBrowser(): string | null {
  const candidates = [
    process.env["ESTOC_BROWSER"],
    process.env["CHROME_BIN"],
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "" && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const browserPath = findBrowser();
if (browserPath === null) {
  console.warn("OPFS backend cases skipped: no Chromium found (set ESTOC_BROWSER to a Chrome or Chromium binary)");
}

describe.skipIf(browserPath === null)("opfs backend (in Chromium)", () => {
  const results = new Map<string, CaseResult>();
  let server: http.Server | undefined;

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("./browser/opfs-entry.ts", import.meta.url))],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
    });
    const html = `<!doctype html><meta charset="utf-8"><title>opfs</title><script>${bundle.outputFiles[0]?.text ?? ""}</script>`;
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const browser = await chromium.launch({ executablePath: browserPath as string, headless: true, chromiumSandbox: false });
    try {
      const page = await browser.newPage();
      page.on("pageerror", (err) => console.error("page error:", err));
      await page.goto(`http://127.0.0.1:${port}/`);
      for (const result of await page.evaluate(() => window.runBackendCases())) {
        results.set(result.name, result);
      }
    } finally {
      await browser.close();
    }
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  });

  for (const c of backendCases) {
    it(c.name, () => {
      const result = results.get(c.name);
      if (result === undefined) {
        throw new Error("the browser reported nothing for this case");
      }
      if (result.error !== undefined) {
        throw new Error(result.error);
      }
    });
  }
});
