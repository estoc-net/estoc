import { encodeDrisl } from "@estoc/dasl";
import { hashTree } from "@estoc/folder-object";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";
import { describe, expect, it } from "vitest";

import {
  BadBlock,
  DRISL_CODE,
  NotAFile,
  RAW_CODE,
  checkBlock,
  decodeDocument,
  hashFile,
  isCid,
  linksOf,
  nameOf,
  parseCid,
  reach,
  reachable,
  readFile,
} from "../src/index.js";
import { HELLO_CID, bigBytes, link, manifestBlock } from "./suite/blob-suite.js";
import { expectBytes } from "./suite/helpers.js";

const enc = new TextEncoder();

describe("DASL names", () => {
  it("are CIDv1, sha-256, raw or drisl, base32 lower, in one spelling", async () => {
    expect(parseCid(HELLO_CID)?.code).toBe(RAW_CODE);
    expect(parseCid(HELLO_CID)?.text).toBe(HELLO_CID);
    const doc = encodeDrisl({ a: 1 });
    const docCid = await nameOf(DRISL_CODE, doc);
    expect(docCid.startsWith("bafyrei")).toBe(true);
    expect(parseCid(docCid)?.code).toBe(DRISL_CODE);
    expect(await nameOf(RAW_CODE, enc.encode("hello"))).toBe(HELLO_CID);
    await expect(nameOf(0x70, enc.encode("hello"))).rejects.toThrow(/raw nor drisl/);
    const digest = await sha256.digest(enc.encode("hello"));
    const notNames: [string, string][] = [
      [HELLO_CID.toUpperCase(), "not base32 lower"],
      [CID.parse(HELLO_CID).toString(base58btc), "another base"],
      [CID.create(1, 0x70, digest).toString(), "dag-pb"],
      [CID.create(0, 0x70, digest).toString(), "CIDv0"],
      [CID.create(1, RAW_CODE, await sha512.digest(enc.encode("hello"))).toString(), "sha-512"],
      ["not-a-cid", "not a CID"],
      ["", "empty"],
      ["b", "the prefix alone"],
    ];
    for (const [name, why] of notNames) {
      expect(parseCid(name), why).toBeNull();
      expect(isCid(name), why).toBe(false);
    }
    expect(isCid(HELLO_CID)).toBe(true);
    expect(isCid(docCid)).toBe(true);
    expect(isCid(42)).toBe(false);
  });
});

describe("blocks of a vault", () => {
  it("name a file as @estoc/folder-object names it as a leaf of a tree: one raw block, whatever its size", async () => {
    for (const bytes of [enc.encode("hello"), new Uint8Array(0), bigBytes()]) {
      const { root, blocks } = await hashFile(bytes);
      const tree = await hashTree({ f: bytes });
      expect([...tree.files.keys()]).toEqual([root]);
      expect([...blocks.keys()]).toEqual([root]);
      expectBytes(blocks.get(root), bytes);
      await checkBlock(root, bytes); // what put mints passes the check putBlock makes
      // and the tree's manifest is a drisl block the store takes, linking the leaf
      await checkBlock(tree.root, tree.manifest);
      expect(linksOf(tree.root, tree.manifest)).toEqual([root]);
    }
    expect((await hashFile(enc.encode("hello"))).root).toBe(HELLO_CID);
  });

  it("checkBlock: a DASL CID, the hash, and for drisl one canonical document — not its shape", async () => {
    const big = bigBytes();
    expect((await checkBlock(await nameOf(RAW_CODE, big), big)).code).toBe(RAW_CODE);
    const notAManifest = encodeDrisl({ hello: "world", n: [1, 2, { deep: link(HELLO_CID) }] });
    expect((await checkBlock(await nameOf(DRISL_CODE, notAManifest), notAManifest)).code).toBe(DRISL_CODE);
    const junk = enc.encode("\x00\x01junk");
    await expect(checkBlock(await nameOf(DRISL_CODE, junk), junk)).rejects.toThrow(/DRISL/);
    await expect(checkBlock(HELLO_CID, enc.encode("hello!"))).rejects.toThrow(/hash/);
    const digest = await sha256.digest(enc.encode("hello"));
    await expect(checkBlock(CID.create(1, 0x70, digest).toString(), enc.encode("hello"))).rejects.toThrow(/DASL CID/);
    const nonCanonical: [Uint8Array, string, RegExp][] = [
      [new Uint8Array([0x18, 0x05]), "a non-shortest integer", /shortest/],
      [new Uint8Array([0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02]), "an unsorted map", /order/],
      [new Uint8Array([...encodeDrisl(1), 0x00]), "trailing bytes", /trailing/],
      [new Uint8Array([0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x70, 0x12, 0x20, ...digest.digest]), "a link that is not a DASL CID", /neither raw nor drisl/],
    ];
    for (const [bytes, why, message] of nonCanonical) {
      const cid = await nameOf(DRISL_CODE, bytes);
      await expect(checkBlock(cid, bytes), why).rejects.toBeInstanceOf(BadBlock);
      await expect(checkBlock(cid, bytes), why).rejects.toThrow(message);
      expect(() => decodeDocument(cid, bytes), why).toThrow(BadBlock);
    }
    expect(decodeDocument(await nameOf(DRISL_CODE, notAManifest), notAManifest)).toEqual({ hello: "world", n: [1, 2, { deep: link(HELLO_CID) }] });
  });

  it("linksOf: none for raw; for drisl every link anywhere in the document, in document order, each once", async () => {
    const [l1, l2, l3, l4] = await Promise.all(["one", "two", "three", "four"].map((s) => nameOf(RAW_CODE, enc.encode(s)))) as [string, string, string, string];
    // map keys are encoded in sorted order: `extra`, `first`, `resources`
    const doc = encodeDrisl({
      resources: { "/a": { src: link(l1), size: 1 }, "/b": { src: link(l2), size: 2 } },
      first: link(l2),
      extra: [link(l3), [link(l1), { deep: link(l4) }], "text", 5, new Uint8Array([1]), null],
    });
    const cid = await nameOf(DRISL_CODE, doc);
    expect(linksOf(cid, doc)).toEqual([l3, l1, l4, l2]);
    expect(linksOf(HELLO_CID, enc.encode("hello"))).toEqual([]);
    expect(linksOf(await nameOf(DRISL_CODE, encodeDrisl({ none: [1, "x"] })), encodeDrisl({ none: [1, "x"] }))).toEqual([]);
    expect(() => linksOf(cid, enc.encode("junk"))).toThrow(BadBlock);
  });

  it("readFile: a raw root is its bytes or null; a drisl root is a document, not a file", async () => {
    const held = new Map<string, Uint8Array>([[HELLO_CID, enc.encode("hello")]]);
    const get = async (cid: string): Promise<Uint8Array | null> => held.get(cid) ?? null;
    expect(await readFile(HELLO_CID, get)).toEqual(enc.encode("hello"));
    expect(await readFile(await nameOf(RAW_CODE, enc.encode("absent")), get)).toBeNull();
    const manifest = await manifestBlock({ "/index.json": [HELLO_CID, 5] });
    held.set(manifest.cid, manifest.bytes);
    await expect(readFile(manifest.cid, get)).rejects.toBeInstanceOf(NotAFile);
    await expect(readFile("not-a-cid", get)).rejects.toBeInstanceOf(BadBlock);
    const big = await hashFile(bigBytes());
    expectBytes(await readFile(big.root, async (cid) => big.blocks.get(cid) ?? null), bigBytes());
  });

  it("reach and reachable walk what a root reaches through the blocks held", async () => {
    const big = bigBytes();
    const bigCid = await nameOf(RAW_CODE, big);
    const manifest = await manifestBlock({ "/index.json": [HELLO_CID, 5], "/files/big": [bigCid, big.length] });
    const blocks = new Map<string, Uint8Array>([
      [manifest.cid, manifest.bytes],
      [HELLO_CID, enc.encode("hello")],
      [bigCid, big],
    ]);
    const get = async (cid: string): Promise<Uint8Array | null> => blocks.get(cid) ?? null;
    expect(linksOf(manifest.cid, manifest.bytes).sort()).toEqual([HELLO_CID, bigCid].sort());
    expect([...(await reachable([manifest.cid], get))].sort()).toEqual([...blocks.keys()].sort());
    expect([...(await reachable([HELLO_CID], get))]).toEqual([HELLO_CID]); // a leaf reaches only itself
    // a partial object: only what is held is walked, and a missing root is skipped
    const partial = new Map([[manifest.cid, manifest.bytes]]);
    const loose = await nameOf(RAW_CODE, enc.encode("loose"));
    expect([...(await reachable([manifest.cid, loose], async (cid) => partial.get(cid) ?? null))]).toEqual([manifest.cid]);
    // the same walk, saying what it asked for and did not find: the missing root, and the leaves under the held manifest
    const { reached, absent } = await reach([manifest.cid, loose], async (cid) => partial.get(cid) ?? null);
    expect([...reached]).toEqual([manifest.cid]);
    expect([...absent].sort()).toEqual([loose, HELLO_CID, bigCid].sort());
    expect(await reach([manifest.cid], get)).toEqual({ reached: new Set(blocks.keys()), absent: new Set() });
    // a document linking a document: the walk goes through
    const outer = encodeDrisl({ inner: link(manifest.cid), note: "a document that is not a manifest" });
    const outerCid = await nameOf(DRISL_CODE, outer);
    blocks.set(outerCid, outer);
    expect([...(await reachable([outerCid], get))].sort()).toEqual([...blocks.keys()].sort());
    // a block that does not decode is reached and not walked past: damage the store sets aside on its own finding
    const damaged = await nameOf(DRISL_CODE, enc.encode("junk"));
    blocks.set(damaged, enc.encode("junk"));
    expect([...(await reachable([damaged], get))]).toEqual([damaged]);
    // a name that is not a DASL CID is not walked at all
    expect(await reach(["not-a-cid"], get)).toEqual({ reached: new Set(), absent: new Set() });
  });
});
