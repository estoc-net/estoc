import { describe, expect, it } from "vitest";

import type { VaultBackend } from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * The contract every VaultBackend must honour, as a reusable suite: the
 * memory backend runs it here, and the OPFS backend runs the same suite in
 * a real browser.
 */
export function backendSuite(name: string, fresh: () => Promise<VaultBackend>): void {
  describe(`${name} backend`, () => {
    it("reads null for a missing file and [] for a missing dir", async () => {
      const b = await fresh();
      expect(await b.read(".estoc/nope.json")).toBeNull();
      expect(await b.list(".estoc/contacts")).toEqual([]);
    });

    it("writes, reads back, and replaces", async () => {
      const b = await fresh();
      await b.write(".estoc/config.json", enc.encode("one"));
      expect(dec.decode((await b.read(".estoc/config.json")) as Uint8Array)).toBe("one");
      await b.write(".estoc/config.json", enc.encode("two"));
      expect(dec.decode((await b.read(".estoc/config.json")) as Uint8Array)).toBe("two");
    });

    it("appends, creating the file when missing", async () => {
      const b = await fresh();
      await b.append(".estoc/messages/0001.jsonl", enc.encode("a\n"));
      await b.append(".estoc/messages/0001.jsonl", enc.encode("b\n"));
      expect(dec.decode((await b.read(".estoc/messages/0001.jsonl")) as Uint8Array)).toBe(
        "a\nb\n"
      );
    });

    it("lists files (not subdirectories) directly inside a dir", async () => {
      const b = await fresh();
      await b.write(".estoc/contacts/alice.json", enc.encode("{}"));
      await b.write(".estoc/contacts/bob.json", enc.encode("{}"));
      await b.write(".estoc/contacts/deeper/carol.json", enc.encode("{}"));
      expect((await b.list(".estoc/contacts")).sort()).toEqual(["alice.json", "bob.json"]);
      expect(await b.list(".estoc")).toEqual([]);
    });

    it("removes, and removing a missing file is fine", async () => {
      const b = await fresh();
      await b.write(".estoc/contacts/alice.json", enc.encode("{}"));
      await b.remove(".estoc/contacts/alice.json");
      expect(await b.read(".estoc/contacts/alice.json")).toBeNull();
      await b.remove(".estoc/contacts/alice.json");
      await b.remove(".estoc/never/was.json");
    });

    it("hands back copies, not its own buffers", async () => {
      const b = await fresh();
      const data = enc.encode("abc");
      await b.write("f", data);
      data[0] = 0x7a;
      const read = (await b.read("f")) as Uint8Array;
      expect(dec.decode(read)).toBe("abc");
      read[0] = 0x7a;
      expect(dec.decode((await b.read("f")) as Uint8Array)).toBe("abc");
    });

    it("refuses .. and . segments", async () => {
      const b = await fresh();
      await expect(b.read("../x")).rejects.toThrow(/unsafe/);
      await expect(b.write("a/./b", enc.encode(""))).rejects.toThrow(/unsafe/);
    });
  });
}
