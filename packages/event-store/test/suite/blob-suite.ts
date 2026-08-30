import * as dagPB from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import { BadBlock, DAG_PB_CODE, MAX_RAW_BYTES, NotAFile, RAW_CODE, hashFile, nameOf, type BlobStore } from "../../src/index.js";
import { clock } from "./helpers.js";

export interface OpenBlobOptions {
  clock?: () => Date;
  graceMs?: number;
}

/** Open a fresh, empty blob store of the kind under test. */
export type OpenBlobs = (options?: OpenBlobOptions) => Promise<BlobStore>;

const HOUR = 60 * 60 * 1000;
const enc = new TextEncoder();

/** The well-known raw name of "hello" (`ipfs add --cid-version 1 --raw-leaves`). */
export const HELLO_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";

/** A file one byte past a raw block: two chunks and a root. */
export function bigBytes(): Uint8Array {
  const bytes = new Uint8Array(MAX_RAW_BYTES + 1);
  for (let i = 0; i < bytes.length; i += 4096) {
    bytes[i] = i % 251;
  }
  return bytes;
}

/** dag-pb bytes of a UnixFS node. */
function pbNode(data: UnixFS, links: dagPB.PBLink[] = []): Uint8Array {
  return dagPB.encode(dagPB.prepare({ Data: data.marshal(), Links: links }));
}

/**
 * The conformance suite of event-store.md §5: naming, the block check,
 * reading a file back, and collection by age.
 */
export function blobSuite(name: string, open: OpenBlobs): void {
  describe(`${name}: BlobStore`, () => {
    it("put names bytes by the profile: a small file is one raw block, its own name", async () => {
      const store = await open();
      const root = await store.put(enc.encode("hello"));
      expect(root).toBe(HELLO_CID);
      expect(await store.get(root)).toEqual(enc.encode("hello"));
      expect(await store.getBlock(root)).toEqual(enc.encode("hello"));
      expect(await store.has(root)).toBe(true);
      expect(await store.list()).toEqual([root]);
      const empty = await store.put(new Uint8Array(0));
      expect(empty).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
      expect(await store.get(empty)).toEqual(new Uint8Array(0));
      expect(await store.list()).toEqual([root, empty].sort());
    });

    it("get and getBlock are null for a name not held, and get throws on a name that is not a name", async () => {
      const store = await open();
      const absent = await nameOf(RAW_CODE, enc.encode("never put"));
      expect(await store.get(absent)).toBeNull();
      expect(await store.getBlock(absent)).toBeNull();
      expect(await store.has(absent)).toBe(false);
      await expect(store.get("not-a-cid")).rejects.toBeInstanceOf(BadBlock);
    });

    it("put chunks a file past 1 MiB under a dag-pb root, and get rejoins the chunks", async () => {
      const store = await open();
      const bytes = bigBytes();
      const root = await store.put(bytes);
      expect(root.startsWith("bafybei")).toBe(true);
      expect(await store.list()).toHaveLength(3);
      expect(await store.get(root)).toEqual(bytes);
      const rootBytes = await store.getBlock(root);
      expect(rootBytes).not.toBeNull();
      expect(dagPB.decode(rootBytes as Uint8Array).Links).toHaveLength(2);
      // the same bytes, the same name, in a second put and in another store
      expect(await store.put(bytes)).toBe(root);
      expect(await (await open()).put(bytes)).toBe(root);
    });

    it("get is null while any chunk is absent, and the file once the last block is in", async () => {
      const { root, blocks } = await hashFile(bigBytes());
      const store = await open();
      const [chunk1, chunk2] = dagPB.decode(blocks.get(root) as Uint8Array).Links.map((l) => l.Hash.toString()) as [string, string];
      await store.putBlock(root, blocks.get(root) as Uint8Array);
      expect(await store.get(root)).toBeNull();
      await store.putBlock(chunk1, blocks.get(chunk1) as Uint8Array);
      expect(await store.get(root)).toBeNull();
      await store.putBlock(chunk2, blocks.get(chunk2) as Uint8Array);
      expect(await store.get(root)).toEqual(bigBytes());
    });

    it("putBlock takes a block only when it is what its name says", async () => {
      const store = await open();
      const hello = enc.encode("hello");
      await store.putBlock(HELLO_CID, hello);
      const dir = pbNode(new UnixFS({ type: "directory" }));
      const dirCid = await nameOf(DAG_PB_CODE, dir);
      await store.putBlock(dirCid, dir);
      expect(await store.list()).toEqual([HELLO_CID, dirCid].sort());

      const digest = await sha256.digest(hello);
      const wrong: [string, Uint8Array, string][] = [
        [HELLO_CID, enc.encode("hellO"), "other bytes under a raw name"],
        [HELLO_CID.toUpperCase(), hello, "not base32 lower"],
        [CID.create(0, DAG_PB_CODE, digest).toString(), hello, "CIDv0"],
        [CID.create(1, 0x71, digest).toString(), hello, "dag-cbor"],
        [CID.create(1, RAW_CODE, await sha512.digest(hello)).toString(), hello, "sha-512"],
        [await nameOf(RAW_CODE, new Uint8Array(MAX_RAW_BYTES + 1)), new Uint8Array(MAX_RAW_BYTES + 1), "a raw block past 1 MiB"],
        [await nameOf(DAG_PB_CODE, hello), hello, "dag-pb name over bytes that are not dag-pb"],
        [await nameOf(DAG_PB_CODE, dagPB.encode({ Links: [] })), dagPB.encode({ Links: [] }), "the empty dag-pb node: no UnixFS data"],
        [await nameOf(DAG_PB_CODE, pbNode(new UnixFS({ type: "raw", data: hello }))), pbNode(new UnixFS({ type: "raw", data: hello })), "a UnixFS raw node, which the profile never makes"],
        [await nameOf(DAG_PB_CODE, pbNode(new UnixFS({ type: "symlink" }))), pbNode(new UnixFS({ type: "symlink" })), "a symlink"],
        [
          await nameOf(DAG_PB_CODE, pbNode(new UnixFS({ type: "file" }), [{ Hash: CID.create(1, 0x71, digest), Tsize: 5 }])),
          pbNode(new UnixFS({ type: "file" }), [{ Hash: CID.create(1, 0x71, digest), Tsize: 5 }]),
          "a file node linking a name that is not the profile's",
        ],
      ];
      for (const [cid, bytes, why] of wrong) {
        await expect(store.putBlock(cid, bytes), why).rejects.toBeInstanceOf(BadBlock);
      }
      expect(await store.list()).toEqual([HELLO_CID, dirCid].sort());
    });

    it("get throws on a root that names a directory, not a file", async () => {
      const store = await open();
      const dir = pbNode(new UnixFS({ type: "directory" }));
      const dirCid = await nameOf(DAG_PB_CODE, dir);
      await store.putBlock(dirCid, dir);
      await expect(store.get(dirCid)).rejects.toBeInstanceOf(NotAFile);
      expect(await store.getBlock(dirCid)).toEqual(dir); // as a block it is fine
    });

    it("collect unlinks what no kept root reaches, once it is older than the grace", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ clock: c.now, graceMs: HOUR });
      const a = await store.put(enc.encode("a"));
      const b = await store.put(enc.encode("b"));
      expect(await store.collect([a])).toEqual({ unlinked: [], young: [b] });
      c.advance(HOUR - 1);
      expect(await store.collect([a])).toEqual({ unlinked: [], young: [b] });
      c.advance(1);
      expect(await store.collect([a])).toEqual({ unlinked: [b], young: [] });
      expect(await store.has(a)).toBe(true);
      expect(await store.has(b)).toBe(false);
      expect(await store.get(b)).toBeNull();
      expect(await store.list()).toEqual([a]);
      // a root in `keep` that is not held is no error
      expect(await store.collect([a, b])).toEqual({ unlinked: [], young: [] });
      // nothing kept: everything old goes
      expect(await store.collect([])).toEqual({ unlinked: [a], young: [] });
      expect(await store.list()).toEqual([]);
    });

    it("a put or putBlock of a block already held renews its time", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ clock: c.now, graceMs: HOUR });
      const a = await store.put(enc.encode("a"));
      const b = await store.put(enc.encode("b"));
      c.advance(HOUR - 1);
      expect(await store.put(enc.encode("a"))).toBe(a);
      await store.putBlock(b, enc.encode("b"));
      c.advance(1);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [a, b].sort() });
      c.advance(HOUR - 1);
      expect(await store.collect([])).toEqual({ unlinked: [a, b].sort(), young: [] });
    });

    it("collect keeps every block a kept root reaches, and takes a whole tree no root reaches", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ clock: c.now, graceMs: 0 });
      const root = await store.put(bigBytes());
      const loose = await store.put(enc.encode("loose"));
      expect(await store.list()).toHaveLength(4);
      expect(await store.collect([root])).toEqual({ unlinked: [loose], young: [] });
      expect(await store.list()).toHaveLength(3);
      expect(await store.get(root)).toEqual(bigBytes());
      const gone = await store.collect([]);
      expect(gone.unlinked).toHaveLength(3);
      expect(gone.young).toEqual([]);
      expect(await store.list()).toEqual([]);
    });
  });
}
