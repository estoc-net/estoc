import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterAll, describe, expect, it } from "vitest";

import { nodeHost, serveDaemon } from "../src/node/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true });
  }
});

function handshake(url: string, headers: Record<string, string>): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => {
      ws.close();
      resolve("open");
    });
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => undefined);
  });
}

describe("the daemon serving the app", () => {
  it("serves the files, marks index.html, falls back to it, and lets its own pages in without the token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "estoc-daemon-"));
    dirs.push(root);
    const appDir = path.join(root, "app");
    await mkdir(path.join(appDir, "assets"), { recursive: true });
    await writeFile(path.join(appDir, "index.html"), "<!doctype html><html><head><title>x</title></head><body></body></html>");
    await writeFile(path.join(appDir, "assets", "a.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d]));
    const served = await serveDaemon({ host: nodeHost(root), port: 0, token: "t0k3n", appDir });
    try {
      const app = served.appUrl!;
      expect(app).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const index = await fetch(app);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await index.text()).toContain('<head><meta name="estoc-daemon" content="same-origin"><title>x</title>');
      expect(await (await fetch(`${app}some/route`)).text()).toContain("estoc-daemon");
      const wasm = await fetch(`${app}assets/a.wasm`);
      expect(wasm.headers.get("content-type")).toBe("application/wasm");
      expect(wasm.headers.get("cache-control")).toContain("immutable");
      expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 0x61, 0x73, 0x6d]));
      expect((await fetch(app, { method: "POST" })).status).toBe(405);

      const host = new URL(app).host;
      const socket = `ws://${host}/`;
      expect(await handshake(socket, { origin: `http://${host}` })).toBe("open");
      expect(await handshake(socket, { origin: "http://evil.example" })).toBe(401);
      expect(await handshake(socket, {})).toBe(401);
      expect(await handshake(served.url, { origin: "http://evil.example" })).toBe("open");
    } finally {
      await served.close();
    }
  });

  it("without an app directory answers plain HTTP with 426 and takes only the token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "estoc-daemon-"));
    dirs.push(root);
    const served = await serveDaemon({ host: nodeHost(root), port: 0, token: "t0k3n" });
    try {
      expect(served.appUrl).toBeNull();
      const base = served.url.replace(/^ws/, "http").replace(/\?.*$/, "");
      expect((await fetch(base)).status).toBe(426);
      expect(await handshake(base.replace(/^http/, "ws"), { origin: `http://${new URL(base).host}` })).toBe(401);
    } finally {
      await served.close();
    }
  });
});
