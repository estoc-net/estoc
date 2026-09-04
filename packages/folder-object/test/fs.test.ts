import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { placeUnder, writeTree } from "../src/fs.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("placeUnder: a mapping's path onto a platform's", () => {
  it("posix: every segment is one entry name, the result is inside the directory", () => {
    const p = path.posix;
    expect(placeUnder("/dest", "files/a.txt", p)).toBe("/dest/files/a.txt");
    expect(placeUnder("/dest", "a\\..\\..\\..\\outside", p)).toBe("/dest/a\\..\\..\\..\\outside"); // a legal name on posix
    expect(placeUnder("/dest", "files/a:b", p)).toBe("/dest/files/a:b");
    for (const bad of ["", "a//b", "/a", "a/", ".", "..", "a/../b", "./a"]) {
      expect(() => placeUnder("/dest", bad, p), bad).toThrow(/unsafe|not one entry name|inside/);
    }
  });

  it("windows: a backslash, a drive, a dot-dot in one segment do not reach past the directory", () => {
    const p = path.win32;
    expect(placeUnder("C:\\dest", "files/a.txt", p)).toBe("C:\\dest\\files\\a.txt");
    for (const bad of ["a\\..\\..\\..\\outside", "files/a\\b", "files/..\\x", "C:\\x", "files/C:\\x", "\\\\server\\share", "files/\\x"]) {
      expect(() => placeUnder("C:\\dest", bad, p), bad).toThrow(/not one entry name|inside/);
    }
  });

  it("writes a mapping, replacing the top-level entries it names and refusing one it cannot place before touching anything", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fo-fs-"));
    await writeTree(dir, { "object/index.json": enc("{}"), "object/files/a.txt": enc("a"), "card.jws": enc("x.y.z") });
    expect(new TextDecoder().decode(await readFile(path.join(dir, "object", "files", "a.txt")))).toBe("a");
    await writeTree(dir, { "object/index.json": enc("{}") });
    await expect(stat(path.join(dir, "object", "files"))).rejects.toThrow();
    expect(new TextDecoder().decode(await readFile(path.join(dir, "card.jws")))).toBe("x.y.z");
    await expect(writeTree(dir, { "fine.txt": enc("ok"), "../escape.txt": enc("no") })).rejects.toThrow(/unsafe/);
    await expect(stat(path.join(dir, "fine.txt"))).rejects.toThrow();
  });
});
