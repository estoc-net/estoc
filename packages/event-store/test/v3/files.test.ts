import { describe, expect, it } from "vitest";

import { MemoryFileStore, OWNED_ROOTS, ancestorsOf, checkFilePath, checkPath, comparePaths, isOwnedPath } from "../../src/v3/index.js";
import { expectBytes } from "./suite/helpers.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("checkPath (vault-folder.md §2)", () => {
  it("accepts conforming relative paths, Unicode included", () => {
    for (const path of ["notes.txt", "a/b/c", "résumé/中文.md", ".hidden", "a.b/..c", "x y"]) {
      expect(checkPath(path)).toBe(path);
    }
  });

  it("rejects an empty, absolute, NUL, backslash, empty-component, `.` or `..` path", () => {
    for (const path of ["", "/a", "a/", "a//b", "./a", "a/./b", "../a", "a/..", "a\\b", "a\0b", "a/\0"]) {
      expect(() => checkPath(path), JSON.stringify(path)).toThrow();
    }
  });

  it("r1-C rejects an unpaired surrogate anywhere, and keeps a paired one", () => {
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc01);
    for (const path of [high, low, `notes/${high}.txt`, `notes/${low}.txt`, `${high}/a`, `a/b${low}c`, `${low}${high}`]) {
      expect(() => checkPath(path), JSON.stringify(path)).toThrow(/unpaired surrogate/);
    }
    for (const path of ["\u{1F600}", "notes/\u{1F600}.txt", `${high}${low}`, "a/\u{10FFFF}"]) {
      expect(checkPath(path), JSON.stringify(path)).toBe(path);
    }
  });

  it("does not normalize or case-fold: `Config.json` and `config.json` are two paths", () => {
    expect(isOwnedPath("config.json")).toBe(true);
    expect(isOwnedPath("Config.json")).toBe(false);
  });
});

describe("owned paths (vault-folder.md §7.1)", () => {
  it("names the six structural roots", () => {
    expect([...OWNED_ROOTS]).toEqual(["config.json", "keystore.json", "events", "objects", "import", "local"]);
  });

  it("is a root, or anything under one", () => {
    for (const path of ["config.json", "keystore.json", "events", "events/x/y.jsonl", "objects/bafk", "import/journal", "local/replica.json"]) {
      expect(isOwnedPath(path), path).toBe(true);
    }
    for (const path of ["config.json.bak", "events.txt", "my/events/x", "objects2", "notes/local"]) {
      expect(isOwnedPath(path), path).toBe(false);
    }
  });

  it("checkFilePath refuses them and accepts the rest", () => {
    for (const path of ["config.json", "keystore.json", "events/a/b.jsonl", "objects/c", "import/j", "local/x"]) {
      expect(() => checkFilePath(path), path).toThrow(/owned/);
    }
    expect(checkFilePath("notes/today.md")).toBe("notes/today.md");
  });
});

describe("helpers", () => {
  it("ancestorsOf", () => {
    expect(ancestorsOf("a")).toEqual([]);
    expect(ancestorsOf("a/b/c")).toEqual(["a", "a/b"]);
  });

  it("comparePaths orders by code point, not UTF-16 unit", () => {
    // U+FF5E (BMP) sorts before U+1F600 (astral) by code point; by UTF-16 unit the surrogate 0xD83D comes first.
    expect(comparePaths("～", "\u{1F600}")).toBeLessThan(0);
    expect("～" < "\u{1F600}").toBe(false);
    expect(comparePaths("a", "a")).toBe(0);
    expect(comparePaths("a", "a/b")).toBeLessThan(0);
    expect(comparePaths("b", "a/b")).toBeGreaterThan(0);
  });
});

describe("MemoryFileStore (event-store.md §8.1, vault-folder.md §11.6)", () => {
  it("writes, reads and lists portable files; a missing path is null", async () => {
    const files = new MemoryFileStore();
    expect(await files.read("notes/a.txt")).toBeNull();
    await files.write("notes/a.txt", bytes("a"));
    await files.write("z.txt", bytes("z"));
    await files.write("notes/b.txt", bytes("b"));
    expectBytes(await files.read("notes/a.txt"), bytes("a"));
    expect(await files.list()).toEqual(["notes/a.txt", "notes/b.txt", "z.txt"]);
  });

  it("replaces a file whole", async () => {
    const files = new MemoryFileStore();
    await files.write("f", bytes("one"));
    await files.write("f", bytes("two-longer"));
    expectBytes(await files.read("f"), bytes("two-longer"));
    expect(await files.list()).toEqual(["f"]);
  });

  it("holds its own copy of the bytes, in and out", async () => {
    const files = new MemoryFileStore();
    const input = bytes("abc");
    await files.write("f", input);
    input[0] = 0x7a;
    const out = (await files.read("f")) as Uint8Array;
    expectBytes(out, bytes("abc"));
    out[1] = 0x7a;
    expectBytes(await files.read("f"), bytes("abc"));
  });

  it("refuses an owned path on write, and a non-path on read", async () => {
    const files = new MemoryFileStore();
    for (const path of ["config.json", "events/a/b.jsonl", "objects/c", "import/j", "local/replica.json"]) {
      await expect(files.write(path, bytes("x")), path).rejects.toThrow(/owned/);
    }
    await expect(files.read("../x")).rejects.toThrow();
    await expect(files.write("a/../b", bytes("x"))).rejects.toThrow();
    expect(await files.list()).toEqual([]);
  });

  it("r1-C refuses a path with an unpaired surrogate on read and write alike; an astral character is a name like any other", async () => {
    const files = new MemoryFileStore();
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc01);
    for (const path of [`notes/${high}.txt`, `notes/${low}.txt`]) {
      await expect(files.write(path, bytes("x")), JSON.stringify(path)).rejects.toThrow(/unpaired surrogate/);
      await expect(files.read(path), JSON.stringify(path)).rejects.toThrow(/unpaired surrogate/);
    }
    await files.write("notes/\u{1F600}.txt", bytes("smile"));
    await files.write("notes/\uFFFD.txt", bytes("replacement"));
    expectBytes(await files.read("notes/\u{1F600}.txt"), bytes("smile"));
    expect(await files.list()).toEqual(["notes/\uFFFD.txt", "notes/\u{1F600}.txt"]);
  });

  it("refuses to make one name both a file and a directory", async () => {
    const files = new MemoryFileStore();
    await files.write("a/b", bytes("x"));
    await expect(files.write("a", bytes("y"))).rejects.toThrow(/directory/);
    await expect(files.write("a/b/c", bytes("y"))).rejects.toThrow(/is a file/);
    expect(await files.list()).toEqual(["a/b"]);
  });

  it("refuses bytes that are not a Uint8Array", async () => {
    const files = new MemoryFileStore();
    await expect(files.write("f", "text" as unknown as Uint8Array)).rejects.toThrow(TypeError);
  });
});
