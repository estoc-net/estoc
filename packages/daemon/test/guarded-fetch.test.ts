import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { guardedFetch, isPublicAddress } from "../src/node/index.js";

describe("guarded fetch", () => {
  it("knows a public address from the rest", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    for (const bad of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(bad), bad).toBe(false);
    }
  });

  it("refuses a loopback literal, a loopback name and a private literal without connecting", async () => {
    const server = createServer((_req, res) => res.end("secret"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/refused/);
      await expect(guardedFetch(`http://localhost:${port}/`)).rejects.toThrow(/refused|EBLOCKED/);
      await expect(guardedFetch(`http://[::1]:${port}/`)).rejects.toThrow(/refused/);
      await expect(guardedFetch(`http://169.254.169.254/latest/meta-data/`)).rejects.toThrow(/refused/);
      await expect(guardedFetch(`ftp://example.com/x`)).rejects.toThrow(/scheme/);
    } finally {
      server.close();
    }
  });
});
