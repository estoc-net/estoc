import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { readTree } from "../src/fs.js";
import { decodeCar, drislCid, encodeCar, encodeDrisl, Link, parseCid, rawCid } from "@estoc/dasl";
import {
  decodeManifest,
  encodeManifest,
  hashTree,
  ManifestError,
  readObject,
  resolvePath,
  verifyTree,
  type HashedTree,
  type TreeFiles,
} from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const seaDay = fileURLToPath(new URL("./fixtures/sea-day/", import.meta.url));
const minimal = fileURLToPath(new URL("./fixtures/minimal/", import.meta.url));

/** Independently computed (scratch Python: hand-rolled CBOR, hashlib, base32) over the same fixtures. */
const GOLDEN = {
  seaDay: "bafyreicdsejj526l225wrfl5cpxcgehq4pzbpxphocvmiuvy6dpwi467aa",
  seaDayManifestHex:
    "a1697265736f7572636573a36b2f696e6465782e6a736f6ea263737263d82a58250001551220c81eba2bf1cb3be0f9a3135a1acef3425b1d05e34168e8b93f37cbac37cfbe516473697a651901106e2f66696c65732f626f64792e6d64a263737263d82a5825000155122011103f04ce4e6f1deb531f9b0cb3990effb13e6d7fec80f77c1cf05a3f0e41c36473697a65185878182f66696c65732f696d616765732f73756e7365742e706e67a263737263d82a58250001551220c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce776473697a651846",
  minimal: "bafyreighoyuo2t5ymwyezn2uuzuxyamaqzgmdneypefczqchzibnfzt3v4",
  empty: "bafyreiarjrxb4yyyuxufubktb6de267lxmqvipdyk5dffbqjnvidwncvau",
};

function snapshot(): TreeFiles {
  return {
    "index.json": utf8('{"format":"x"}'),
    "files/body.md": utf8("hello"),
    "files/images/a.png": utf8("png-a"),
    "files/images/b.png": utf8("png-b"),
  };
}

/** The object set as a store holds it: the manifest block plus every leaf. */
function objectSet(files: TreeFiles, hashed: HashedTree): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>([[hashed.root, hashed.manifest]]);
  for (const [cid, path] of hashed.files) objects.set(cid, files[path] as Uint8Array);
  return objects;
}

function bigFile(mib: number): Uint8Array {
  const bytes = new Uint8Array(mib * 1024 * 1024 + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return bytes;
}

describe("golden vectors", () => {
  it("the sea-day example roots as independently computed, manifest byte for byte", async () => {
    const object = readObject(await readTree(seaDay));
    const hashed = await hashTree(object.tree);
    expect(hashed.root).toBe(GOLDEN.seaDay);
    expect(hex(hashed.manifest)).toBe(GOLDEN.seaDayManifestHex);
    expect(hashed.entries.map((e) => e.path)).toEqual(["index.json", "files/body.md", "files/images/sunset.png"]);
    expect(hashed.entries.map((e) => e.size)).toEqual([272, 88, 70]);
  });

  it("the minimal example (a lone index.json) and the empty mapping", async () => {
    expect((await hashTree(readObject(await readTree(minimal)).tree)).root).toBe(GOLDEN.minimal);
    expect((await hashTree({})).root).toBe(GOLDEN.empty);
    expect(hex((await hashTree({})).manifest)).toBe("a1697265736f7572636573a0");
  });

  it("agrees with @ipld/dag-cbor + multiformats building the same manifest", async () => {
    const object = readObject(await readTree(seaDay));
    const hashed = await hashTree(object.tree);
    const resources: Record<string, { src: CID; size: number }> = {};
    for (const [path, bytes] of Object.entries(object.tree)) {
      resources[`/${path}`] = { src: CID.create(1, 0x55, await sha256.digest(bytes)), size: bytes.length };
    }
    const theirs = dagCbor.encode({ resources });
    expect(hex(theirs)).toBe(hex(hashed.manifest));
    expect(CID.create(1, dagCbor.code, await sha256.digest(theirs)).toString()).toBe(hashed.root);
  });
});

describe("hashTree", () => {
  it("is deterministic and independent of insertion order", async () => {
    const a = await hashTree(snapshot());
    const b = await hashTree(Object.fromEntries(Object.entries(snapshot()).reverse()));
    expect(a.root).toBe(b.root);
    expect(hex(a.manifest)).toBe(hex(b.manifest));
  });

  it("root is a drisl CID; every file is one raw block, whatever its size", async () => {
    const files: TreeFiles = { ...snapshot(), "files/big.bin": bigFile(2) };
    const hashed = await hashTree(files);
    expect(parseCid(hashed.root).code).toBe(0x71);
    for (const cid of hashed.files.keys()) expect(parseCid(cid).code).toBe(0x55);
    const big = hashed.entries.find((e) => e.path === "files/big.bin");
    expect(big?.size).toBe(2 * 1024 * 1024 + 7);
    expect(big?.cid).toBe(await rawCid(files["files/big.bin"] as Uint8Array));
  });

  it("changing one byte changes the root; the other files keep their CIDs", async () => {
    const files = snapshot();
    const before = await hashTree(files);
    files["files/body.md"] = utf8("hellO");
    const after = await hashTree(files);
    expect(after.root).not.toBe(before.root);
    const a = await rawCid(utf8("png-a"));
    expect(before.files.get(a)).toBe("files/images/a.png");
    expect(after.files.get(a)).toBe("files/images/a.png");
  });

  it("identical bytes at two paths share one CID, listed once in files and twice in entries", async () => {
    const hashed = await hashTree({ "a.txt": utf8("same"), "b/c.txt": utf8("same") });
    expect(hashed.files.size).toBe(1);
    expect(hashed.entries.length).toBe(2);
  });

  it("refuses a mapping no file tree can hold", async () => {
    await expect(hashTree({ posts: utf8("x"), "posts/a.txt": utf8("y") })).rejects.toThrow(/both a file and a directory/);
    await expect(hashTree({ "../evil": utf8("x") })).rejects.toThrow(/unsafe/);
    await expect(hashTree({ "a/./b": utf8("x") })).rejects.toThrow(/unsafe/);
    await expect(hashTree({ "a//b": utf8("x") })).rejects.toThrow(/empty segment/);
    await expect(hashTree({ "/a": utf8("x") })).rejects.toThrow(/empty segment/);
    await expect(hashTree({ "a/": utf8("x") })).rejects.toThrow(/empty segment/);
    await expect(hashTree({ "": utf8("x") })).rejects.toThrow(/empty path/);
    await expect(hashTree({ "a\0b": utf8("x") })).rejects.toThrow(/NUL/);
  });
});

describe("the manifest block", () => {
  it("decodes back to its entries, in DRISL key order", async () => {
    const hashed = await hashTree(snapshot());
    expect(decodeManifest(hashed.manifest)).toEqual(hashed.entries);
    expect(hashed.entries.map((e) => e.path)).toEqual(["index.json", "files/body.md", "files/images/a.png", "files/images/b.png"]);
  });

  it("encodeManifest takes entries in any order and checks them", async () => {
    const cid = await rawCid(utf8("x"));
    const a = encodeManifest([{ path: "b", cid, size: 1 }, { path: "a", cid, size: 1 }]);
    const b = encodeManifest([{ path: "a", cid, size: 1 }, { path: "b", cid, size: 1 }]);
    expect(hex(a)).toBe(hex(b));
    const drisl = await drislCid(utf8("x"));
    expect(() => encodeManifest([{ path: "a", cid: drisl, size: 1 }])).toThrow(/raw CID/);
    expect(() => encodeManifest([{ path: "a", cid, size: -1 }])).toThrow(/non-negative/);
    expect(() => encodeManifest([{ path: "a", cid, size: 1.5 }])).toThrow(/non-negative integer/);
    expect(() => encodeManifest([{ path: "a", cid, size: 1 }, { path: "a/b", cid, size: 1 }])).toThrow(/both a file and a directory/);
    expect(() => encodeManifest([{ path: "a", cid, size: 1 }, { path: "a", cid, size: 2 }])).toThrow(/duplicate/);
  });

  it("refuses every shape that is not exactly a manifest", async () => {
    const link = new Link(parseCid(await rawCid(utf8("x"))));
    const drislLink = new Link(parseCid(await drislCid(utf8("x"))));
    const bad: [string, unknown, RegExp][] = [
      ["not a map", [1], /not a map/],
      ["no resources", {}, /exactly one member/],
      ["an extra top-level member (name)", { resources: {}, name: "x" }, /exactly one member/],
      ["version/roots (CAR header shape)", { resources: {}, version: 1, roots: [] }, /exactly one member/],
      ["resources not a map", { resources: [] }, /resources is not a map/],
      ["a key without the leading slash", { resources: { "a": { src: link, size: 1 } } }, /start with \//],
      ["a key with an empty segment", { resources: { "/a//b": { src: link, size: 1 } } }, /empty segment/],
      ["a key with a trailing slash", { resources: { "/a/": { src: link, size: 1 } } }, /empty segment/],
      ["the root key /", { resources: { "/": { src: link, size: 1 } } }, /empty path/],
      ["a dot segment", { resources: { "/a/../b": { src: link, size: 1 } } }, /unsafe/],
      ["a NUL", { resources: { "/a\0": { src: link, size: 1 } } }, /NUL/],
      ["a file that is also a directory", { resources: { "/files": { src: link, size: 1 }, "/files/x": { src: link, size: 1 } } }, /both a file and a directory/],
      ["an entry that is not a map", { resources: { "/a": link } }, /not a map/],
      ["an entry with content-type", { resources: { "/a": { src: link, size: 1, "content-type": "text/plain" } } }, /exactly src and size/],
      ["an entry without size", { resources: { "/a": { src: link } } }, /exactly src and size/],
      ["an entry without src", { resources: { "/a": { size: 1 } } }, /exactly src and size/],
      ["src that is a drisl CID (nesting)", { resources: { "/a": { src: drislLink, size: 1 } } }, /raw CID/],
      ["src that is a string", { resources: { "/a": { src: link.toString(), size: 1 } } }, /raw CID/],
      ["negative size", { resources: { "/a": { src: link, size: -1 } } }, /non-negative/],
      ["float size", { resources: { "/a": { src: link, size: 1.5 } } }, /non-negative/],
      ["bigint size", { resources: { "/a": { src: link, size: 1n << 60n } } }, /non-negative/],
      ["string size", { resources: { "/a": { src: link, size: "1" } } }, /non-negative/],
    ];
    for (const [name, doc, pattern] of bad) {
      expect(() => decodeManifest(encodeDrisl(doc as never)), name).toThrow(pattern);
    }
  });

  it("refuses a float size even though it decodes to an integer (the re-encode backstop)", async () => {
    // size 1 as float64: valid DRISL, decodes to the number 1, but not the bytes a hasher writes
    const hashed = await hashTree({ a: utf8("x") });
    const canonical = hex(hashed.manifest);
    const floated = canonical.replace(/6473697a6501$/, "6473697a65fb3ff0000000000000");
    expect(floated).not.toBe(canonical);
    const bytes = new Uint8Array((floated.match(/../g) ?? []).map((x) => parseInt(x, 16)));
    expect(() => decodeManifest(bytes)).toThrow(/not the encoding of their value/);
  });

  it("refuses one src under two sizes, and a manifest past the bound", async () => {
    const cid = await rawCid(utf8("x"));
    expect(() => encodeManifest([{ path: "a", cid, size: 1 }, { path: "b", cid, size: 2 }])).toThrow(/another entry sizes/);
    const link = new Link(parseCid(cid));
    expect(() => decodeManifest(encodeDrisl({ resources: { "/a": { src: link, size: 1 }, "/b": { src: link, size: 2 } } }))).toThrow(/another entry sizes/);
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 13000; i++) many[`f/${"n".repeat(40)}${i}`] = utf8("x");
    await expect(hashTree(many)).rejects.toThrow(/the most is 1048576/);
  });

  it("refuses non-canonical DRISL bytes, so one tree has one root", async () => {
    const hashed = await hashTree({ a: utf8("x") });
    // same value, longer int encoding for size: 18 01 instead of 01
    const canonical = hex(hashed.manifest);
    const padded = canonical.replace(/6473697a6501$/, "6473697a651801");
    expect(padded).not.toBe(canonical);
    const bytes = new Uint8Array((padded.match(/../g) ?? []).map((x) => parseInt(x, 16)));
    expect(() => decodeManifest(bytes)).toThrow(/not canonical DRISL.*shortest/);
  });
});

describe("verifyTree", () => {
  it("accepts a complete object set and lists every file with its size", async () => {
    const files = snapshot();
    const hashed = await hashTree(files);
    const verified = await verifyTree(hashed.root, objectSet(files, hashed));
    expect([...verified.files.keys()].sort()).toEqual(Object.keys(files).sort());
    expect(verified.sizes.get("files/body.md")).toBe(5);
    expect(verified.missing.size).toBe(0);
    expect(verified.partial.size).toBe(0);
  });

  it("rejects a missing leaf, a missing manifest, tampered bytes, a raw root", async () => {
    const files = snapshot();
    const hashed = await hashTree(files);
    const objects = objectSet(files, hashed);
    const leaf = await rawCid(utf8("hello"));
    const without = new Map(objects);
    without.delete(leaf);
    await expect(verifyTree(hashed.root, without)).rejects.toThrow(/missing object/);
    await expect(verifyTree(hashed.root, new Map())).rejects.toThrow(/missing object/);
    const tampered = new Map(objects);
    tampered.set(leaf, utf8("hellp"));
    await expect(verifyTree(hashed.root, tampered)).rejects.toThrow(/do not hash/);
    await expect(verifyTree(leaf, objects)).rejects.toThrow(/not a manifest/);
    const forged = new Map(objects);
    forged.set(hashed.root, utf8("a0"));
    await expect(verifyTree(hashed.root, forged)).rejects.toThrow(/do not hash/);
  });

  it("rejects a leaf whose length is not the size the manifest states", async () => {
    // hand-build a manifest lying about size; its own bytes are canonical so only the size check can catch it
    const bytes = utf8("hello");
    const cid = await rawCid(bytes);
    const manifest = encodeManifest([{ path: "a", cid, size: 4 }]);
    const root = await drislCid(manifest);
    await expect(verifyTree(root, new Map([[root, manifest], [cid, bytes]]))).rejects.toThrow(/says 4 bytes, the block holds 5/);
    // with optional leaves the lie is still caught when the leaf is present…
    await expect(verifyTree(root, new Map([[root, manifest], [cid, bytes]]), { leaves: "optional" })).rejects.toThrow(/says 4 bytes/);
    // …and reported as the manifest states when it is absent
    const partial = await verifyTree(root, new Map([[root, manifest]]), { leaves: "optional" });
    expect(partial.missing.get(cid)).toBe(4);
  });

  it("ignores unrelated objects and takes a lookup function", async () => {
    const files = snapshot();
    const hashed = await hashTree(files);
    const objects = objectSet(files, hashed);
    objects.set(await rawCid(utf8("noise")), utf8("noise"));
    const asked: string[] = [];
    const verified = await verifyTree(hashed.root, async (cid) => {
      asked.push(cid);
      return objects.get(cid) ?? null;
    });
    expect(verified.files.size).toBe(4);
    expect(new Set(asked)).toEqual(new Set([hashed.root, ...hashed.files.keys()]));
  });

  it("with optional leaves records what is absent, by CID and by path, with sizes", async () => {
    const files = snapshot();
    const hashed = await hashTree(files);
    const objects = objectSet(files, hashed);
    const a = await rawCid(utf8("png-a"));
    objects.delete(a);
    const verified = await verifyTree(hashed.root, objects, { leaves: "optional" });
    expect(verified.files.size).toBe(4);
    expect(verified.missing).toEqual(new Map([[a, 5]]));
    expect(verified.partial).toEqual(new Map([["files/images/a.png", [a]]]));
    // the skeleton alone: every path and size known, every leaf missing
    const skeleton = await verifyTree(hashed.root, new Map([[hashed.root, hashed.manifest]]), { leaves: "optional" });
    expect(skeleton.partial.size).toBe(4);
    let total = 0;
    for (const size of skeleton.missing.values()) total += size;
    expect(total).toBe(Object.values(files).reduce((n, b) => n + b.length, 0));
  });

  it("declines a leaf past maxLeafBytes without fetching it: unverifiable, not missing", async () => {
    const files = snapshot();
    const hashed = await hashTree(files);
    const objects = objectSet(files, hashed);
    const asked: string[] = [];
    const verified = await verifyTree(hashed.root, async (cid) => {
      asked.push(cid);
      return objects.get(cid) ?? null;
    }, { maxLeafBytes: 13 });
    expect(verified.declined).toEqual(new Map([["index.json", 14]]));
    expect(verified.missing.size).toBe(0);
    expect(asked).not.toContain(await rawCid(files["index.json"] as Uint8Array));
    expect(verified.files.size).toBe(4);
  });

  it("a shared leaf is fetched once", async () => {
    const files: TreeFiles = { "a.txt": utf8("same"), "b/c.txt": utf8("same") };
    const hashed = await hashTree(files);
    const objects = objectSet(files, hashed);
    const asked: string[] = [];
    await verifyTree(hashed.root, async (cid) => {
      asked.push(cid);
      return objects.get(cid) ?? null;
    });
    expect(asked.length).toBe(2);
  });
});

describe("resolvePath", () => {
  it("walks to a file in two fetches, whatever the depth", async () => {
    const files = snapshot();
    const hashed = await hashTree(files);
    const objects = objectSet(files, hashed);
    const fetched: string[] = [];
    const get = async (cid: string) => {
      fetched.push(cid);
      return objects.get(cid) ?? null;
    };
    const hit = await resolvePath(hashed.root, "files/images/b.png", get);
    expect(new TextDecoder().decode(hit.bytes)).toBe("png-b");
    expect(hit.size).toBe(5);
    expect(fetched.length).toBe(2);
  });

  it("errors on a path that is not there, a directory, unsafe paths, lies", async () => {
    const files = snapshot();
    const hashed = await hashTree(files);
    const objects = objectSet(files, hashed);
    const get = async (cid: string) => objects.get(cid) ?? null;
    await expect(resolvePath(hashed.root, "files/nope", get)).rejects.toThrow(/no such path/);
    await expect(resolvePath(hashed.root, "files/images", get)).rejects.toThrow(/no such path/);
    await expect(resolvePath(hashed.root, "", get)).rejects.toThrow(/empty path/);
    await expect(resolvePath(hashed.root, "../x", get)).rejects.toThrow(/unsafe/);
    await expect(resolvePath(hashed.root, "files/body.md", async () => utf8("lies"))).rejects.toThrow(/do not hash/);
  });
});

describe("CAR", () => {
  it("the closure travels as a DASL CAR: 36-byte CIDs, the manifest as root", async () => {
    const files = snapshot();
    const hashed = await hashTree(files);
    const car = encodeCar([hashed.root], objectSet(files, hashed));
    const back = await decodeCar(car);
    expect(back.roots).toEqual([hashed.root]);
    expect(back.bad).toEqual([]);
    const verified = await verifyTree(hashed.root, back.blocks);
    expect(verified.files.size).toBe(4);
  });
});

describe("a manifest is untrusted input", () => {
  it("a path of fifty thousand segments is laid out in linear time", async () => {
    const deep = `${"a/".repeat(50_000)}b`;
    const started = performance.now();
    const hashed = await hashTree({ [deep]: utf8("x") });
    expect(decodeManifest(hashed.manifest)[0]?.path).toBe(deep);
    const many: TreeFiles = {};
    for (let i = 0; i < 2000; i++) many[`${"d/".repeat(200)}${i}`] = utf8("x");
    await hashTree(many);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("a stated size is a claim: a block that arrives past maxLeafBytes is declined unhashed, and the source is told the bound", async () => {
    const big = new Uint8Array(5000).fill(3);
    const cid = await rawCid(big);
    const manifest = encodeManifest([{ path: "a", cid, size: 1 }]);
    const root = await drislCid(manifest);
    const limits: (number | undefined)[] = [];
    const get = async (name: string, limit?: number) => {
      limits.push(limit);
      return name === root ? manifest : name === cid ? big : null;
    };
    const verified = await verifyTree(root, get, { maxLeafBytes: 100 });
    expect(verified.declined).toEqual(new Map([["a", 5000]]));
    expect(verified.missing.size).toBe(0);
    expect(limits).toEqual([1024 * 1024, 100]);
    // without a bound the block is hashed, proven, and the manifest's lie is a format defect
    await expect(verifyTree(root, get)).rejects.toThrow(ManifestError);
    await expect(verifyTree(root, get)).rejects.toThrow(/says 1 bytes, the block holds 5000/);
    // a block that is neither the bytes named nor the size stated is a bad block, not a bad manifest
    const err = await verifyTree(root, async (name) => (name === root ? manifest : utf8("??"))).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ManifestError);
    expect((err as Error).message).toMatch(/do not hash/);
    // resolvePath under the same bound
    await expect(resolvePath(root, "a", get, { maxLeafBytes: 100 })).rejects.toThrow(/5000 bytes, past this reader's maxLeafBytes/);
    await expect(resolvePath(root, "a", get, { maxLeafBytes: 0 })).rejects.toThrow(/is 1 bytes, past this reader's maxLeafBytes/);
  });

  it("a manifest past the bound is refused before it is hashed", async () => {
    const hashed = await hashTree({ a: utf8("x") });
    const huge = new Uint8Array(1024 * 1024 + 1);
    let hashedHuge = false;
    const get = async (name: string) => {
      if (name === hashed.root) return huge;
      hashedHuge = true;
      return null;
    };
    await expect(verifyTree(hashed.root, get)).rejects.toThrow(/the most is 1048576/);
    expect(hashedHuge).toBe(false);
  });
});
