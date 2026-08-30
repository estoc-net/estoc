import { describe, expect, it } from "vitest";

import { MemoryBlobStore, MemoryEventStore, MemoryFileStore, checkPath } from "../src/index.js";
import { blobSuite } from "./suite/blob-suite.js";
import { storeSuite } from "./suite/store-suite.js";

storeSuite("memory", async (options) => new MemoryEventStore(options));
blobSuite("memory", async (options) => new MemoryBlobStore(options));

describe("memory: FileStore", () => {
  it("reads back what it wrote, by path, and lists paths in order", async () => {
    const files = new MemoryFileStore();
    expect(await files.read("config.json")).toBeNull();
    expect(await files.list()).toEqual([]);
    const bytes = new Uint8Array([1, 2, 3]);
    await files.write("state/b.json", bytes);
    await files.write("config.json", new Uint8Array([4]));
    bytes[0] = 9; // the store keeps a copy
    expect(await files.read("state/b.json")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await files.list()).toEqual(["config.json", "state/b.json"]);
    await files.write("config.json", new Uint8Array([5]));
    expect(await files.read("config.json")).toEqual(new Uint8Array([5]));
  });

  it("takes a file's path and no other, and never a file and a directory of one name (event-store.md §6)", async () => {
    const files = new MemoryFileStore();
    for (const bad of [
      "devices/aaaaaa/01990000-0000-7000-8000-000000000010.jsonl",
      "blobs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq",
      "local/agent/options.json",
      "local",
      "devices",
      "devices/aaaaaa",
      "blobs",
      "extensions",
      "extensions/01990000-0000-7000-8000-00000000000a",
      "extensions/01990000-0000-7000-8000-00000000000a/devices",
      "extensions/01990000-0000-7000-8000-00000000000a/devices/aaaaaa",
      "extensions/01990000-0000-7000-8000-00000000000a/blobs",
    ]) {
      await expect(files.write(bad, new Uint8Array()), bad).rejects.toThrow(/not a file path/);
    }
    // under devices/ or blobs/ but not shaped like a segment or a blob: a file
    await files.write("devices/aaaaaa/readme.txt", new Uint8Array([1]));
    await files.write("blobs/not-a-cid", new Uint8Array([1]));
    await files.write("extensions/01990000-0000-7000-8000-00000000000a/readme.txt", new Uint8Array([1]));
    await files.write("state/a/b.json", new Uint8Array([1]));
    await expect(files.write("state/a", new Uint8Array())).rejects.toThrow(/is a directory/);
    await expect(files.write("state", new Uint8Array())).rejects.toThrow(/is a directory/);
    await expect(files.write("state/a/b.json/c", new Uint8Array())).rejects.toThrow(/is a file/);
    await expect(files.write("blobs/not-a-cid/x", new Uint8Array())).rejects.toThrow(/is a file/);
    expect(await files.list()).toEqual(["blobs/not-a-cid", "devices/aaaaaa/readme.txt", "extensions/01990000-0000-7000-8000-00000000000a/readme.txt", "state/a/b.json"]);
  });

  it("takes relative paths only", async () => {
    const files = new MemoryFileStore();
    for (const bad of ["", "/abs", "trailing/", "a//b", ".", "..", "a/../b", "./a", "..\\x", "a\\b", "café", "a b", "tab\there", "a\u0000b"]) {
      expect(() => checkPath(bad), bad).toThrow();
      await expect(files.write(bad, new Uint8Array()), bad).rejects.toThrow();
      await expect(files.read(bad), bad).rejects.toThrow();
    }
    expect(checkPath("a/.hidden/b.json")).toBe("a/.hidden/b.json");
  });
});

describe("memory: tokens", () => {
  it("name the instance and the store, so two stores of one instance do not share them", async () => {
    const vault = new MemoryEventStore({ instance: "i1", store: "vault" });
    const ext = new MemoryEventStore({ instance: "i1", store: "ext-1" });
    const token = (await vault.changes()).token;
    await expect(ext.changes(undefined, token)).rejects.toThrow(/instance/);
    const twin = new MemoryEventStore({ instance: "i1", store: "vault" });
    await twin.append({ type: "t", data: {} });
    // the same instance and store, further along: placeable; the reverse is not
    await expect(twin.changes(undefined, token)).resolves.toBeDefined();
    await expect(vault.changes(undefined, (await twin.changes()).token)).rejects.toThrow(/position/);
  });
});
