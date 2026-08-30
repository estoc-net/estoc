import { hashTree } from "@estoc/folder-object";
import * as dagPB from "@ipld/dag-pb";
import { describe, expect, it } from "vitest";

import { BadBlock, DAG_PB_CODE, checkBlock, decodeNode, hashFile, linksOf, nameOf, reachable, readFile } from "../src/index.js";
import { HELLO_CID, bigBytes } from "./suite/blob-suite.js";

const enc = new TextEncoder();

describe("blocks of the profile", () => {
  it("name a file as @estoc/folder-object names it inside a tree", async () => {
    for (const bytes of [enc.encode("hello"), new Uint8Array(0), bigBytes()]) {
      const { root, blocks } = await hashFile(bytes);
      const tree = await hashTree({ f: bytes });
      expect([...tree.files.keys()]).toEqual([root]);
      for (const [cid, block] of blocks) {
        await checkBlock(cid, block); // every block put minted passes the check a putBlock makes
        if (cid !== root || root.startsWith("bafybei")) {
          expect(tree.nodes.get(cid)).toEqual(block);
        }
      }
    }
    expect((await hashFile(enc.encode("hello"))).root).toBe(HELLO_CID);
  });

  it("accept every node @estoc/folder-object makes for a tree", async () => {
    const files: Record<string, Uint8Array> = { "b.txt": enc.encode("b"), "a/x": enc.encode("x"), "a/y": bigBytes(), "é": enc.encode("e") };
    for (let i = 0; i < 1500; i++) {
      files[`many/${i.toString().padStart(4, "0")}-${"n".repeat(200)}`] = enc.encode(String(i)); // past the HAMT threshold
    }
    const tree = await hashTree(files);
    let shards = 0;
    for (const [cid, bytes] of tree.nodes) {
      await checkBlock(cid, bytes);
      if (cid.startsWith("bafybei") && decodeNode(cid, bytes).data.type === "hamt-sharded-directory") {
        shards += 1;
      }
    }
    expect(shards).toBeGreaterThan(0);
  });

  it("decode a node, list its links, and walk what a root reaches through the blocks held", async () => {
    const { root, blocks } = await hashFile(bigBytes());
    const rootBytes = blocks.get(root) as Uint8Array;
    expect(decodeNode(root, rootBytes).data.type).toBe("file");
    const links = linksOf(root, rootBytes);
    expect(links).toHaveLength(2);
    expect(links.every((cid) => blocks.has(cid))).toBe(true);
    expect(linksOf(HELLO_CID, enc.encode("hello"))).toEqual([]);
    const get = async (cid: string): Promise<Uint8Array | null> => blocks.get(cid) ?? null;
    expect([...(await reachable([root], get))].sort()).toEqual([...blocks.keys()].sort());
    // a partial tree: only what is held is walked, and a missing root is skipped
    const partial = new Map([[root, rootBytes]]);
    expect([...(await reachable([root, HELLO_CID], async (cid) => partial.get(cid) ?? null))]).toEqual([root]);
    expect(await readFile(root, async (cid) => partial.get(cid) ?? null)).toBeNull();
    expect(await readFile(root, get)).toEqual(bigBytes());
    expect(await readFile(HELLO_CID, async () => enc.encode("hello"))).toEqual(enc.encode("hello"));
  });

  it("reject a block whose bytes are not a profile node under a dag-pb name", async () => {
    const junk = enc.encode("\x00\x01junk");
    await expect(checkBlock(await nameOf(DAG_PB_CODE, junk), junk)).rejects.toBeInstanceOf(BadBlock);
    const empty = dagPB.encode({ Links: [] });
    await expect(checkBlock(await nameOf(DAG_PB_CODE, empty), empty)).rejects.toThrow(/UnixFS/);
    await expect(checkBlock("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq", enc.encode("hello!"))).rejects.toThrow(/hash/);
  });
});
