import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { filesFromZip, zipFiles, type VaultFiles } from "../src/index.js";

const enc = new TextEncoder();

const files: VaultFiles = {
  ".estoc/devices/aaaaaa/01990000-0000-7000-8000-000000000010.jsonl": enc.encode("{}\n"),
  ".estoc/config.json": enc.encode('{"format":"estoc","version":2}'),
  ".estoc/blobs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq": enc.encode("hello"),
};

describe("zip", () => {
  it("holds the tree's paths as they are, in order, and gives them back", async () => {
    const zip = zipFiles(files);
    expect(Object.keys(unzipSync(zip))).toEqual(Object.keys(files).sort());
    expect(filesFromZip(zip)).toEqual(files);
  });

  it("re-roots what a person zipped: a folder around .estoc/, the inside of .estoc/, a Finder's droppings", () => {
    const wrapped = zipFiles(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`my vault/${path}`, bytes])));
    expect(filesFromZip(wrapped)).toEqual(files);
    const inside = zipFiles({
      ...Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path.slice(".estoc/".length), bytes])),
      "__MACOSX/._config.json": enc.encode("junk"),
    });
    expect(filesFromZip(inside)).toEqual(files);
    expect(() => filesFromZip(zipFiles({ "readme.txt": enc.encode("no vault here") }))).toThrow(/config\.json/);
  });

  it("roots at the shallowest config.json, whatever order the archive lists a nested one in", () => {
    const nested = { ...files, ".estoc/state/config.json": enc.encode("{}") };
    const insideFirst = zipSync({
      "state/config.json": nested[".estoc/state/config.json"],
      ...Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path.slice(".estoc/".length), bytes])),
    });
    expect(Object.keys(unzipSync(insideFirst))[0]).toBe("state/config.json");
    expect(filesFromZip(insideFirst)).toEqual(nested);
    const wrappedFirst = zipSync({
      "my vault/state/.estoc/config.json": enc.encode("{}"),
      ...Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`my vault/${path}`, bytes])),
    });
    expect(filesFromZip(wrappedFirst)).toEqual({ ...files, "state/.estoc/config.json": enc.encode("{}") }); // outside .estoc/: not a vault path, ignored by every reader
  });
});
