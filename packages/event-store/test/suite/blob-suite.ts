import { Link, encodeDrisl, parseCid as parseDaslCid, type Drisl } from "@estoc/dasl";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import { BadBlock, DRISL_CODE, NotAFile, RAW_CODE, nameOf, type BlobStore } from "../../src/index.js";
import { clock, expectBytes } from "./helpers.js";

export interface OpenBlobOptions {
  clock?: () => Date;
  graceMs?: number;
}

/** Open a fresh, empty blob store of the kind under test. */
export type OpenBlobs = (options?: OpenBlobOptions) => Promise<BlobStore>;

const HOUR = 60 * 60 * 1000;
const enc = new TextEncoder();

/** The well-known raw name of "hello". */
export const HELLO_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";

/** A file of 3 MiB: one raw block all the same. */
export function bigBytes(): Uint8Array {
  const bytes = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 4096) {
    bytes[i] = i % 251;
  }
  return bytes;
}

/** A DASL CID as a DRISL document links it. */
export function link(cid: string): Link {
  return new Link(parseDaslCid(cid));
}

/** A drisl block in the manifest's shape (`@estoc/folder-object` §2.1) over `leaves`: path → [raw CID, size]; its name and its canonical bytes. */
export async function manifestBlock(leaves: Record<string, [string, number]>): Promise<{ cid: string; bytes: Uint8Array }> {
  const resources: Record<string, { src: Link; size: number }> = {};
  for (const [path, [cid, size]] of Object.entries(leaves)) {
    resources[path] = { src: link(cid), size };
  }
  const bytes = encodeDrisl({ resources });
  return { cid: await nameOf(DRISL_CODE, bytes), bytes };
}

/** A drisl name over `bytes` that are not what the codec says — the name is honest, the bytes are not a canonical document. */
async function drislOver(bytes: Uint8Array): Promise<[string, Uint8Array]> {
  return [await nameOf(DRISL_CODE, bytes), bytes];
}

/**
 * The conformance suite of event-store.md §5: naming, the block check,
 * reading a file back, and collection by age.
 */
export function blobSuite(name: string, open: OpenBlobs): void {
  describe(`${name}: BlobStore`, () => {
    it("put names bytes by their raw CID: a file is one raw block, its own name", async () => {
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

    it("put keeps a file of 3 MiB as one raw block, whatever its size, and get returns it whole", async () => {
      const store = await open();
      const bytes = bigBytes();
      const root = await store.put(bytes);
      expect(root.startsWith("bafkrei")).toBe(true);
      expect(await store.list()).toEqual([root]);
      expectBytes(await store.get(root), bytes);
      expectBytes(await store.getBlock(root), bytes);
      // the same bytes, the same name, in a second put and in another store
      expect(await store.put(bytes)).toBe(root);
      expect(await (await open()).put(bytes)).toBe(root);
    });

    it("putBlock takes a received object as its blocks: the manifest, a drisl block, and its leaves, raw blocks", async () => {
      const store = await open();
      const big = bigBytes();
      const bigCid = await nameOf(RAW_CODE, big);
      const manifest = await manifestBlock({ "/index.json": [HELLO_CID, 5], "/files/big": [bigCid, big.length] });
      expect(manifest.cid.startsWith("bafyrei")).toBe(true);
      await store.putBlock(manifest.cid, manifest.bytes); // root first is fine: not a closure check
      expect(await store.list()).toEqual([manifest.cid]);
      await store.putBlock(HELLO_CID, enc.encode("hello"));
      await store.putBlock(bigCid, big);
      expect(await store.list()).toEqual([manifest.cid, HELLO_CID, bigCid].sort());
      expect(await store.getBlock(manifest.cid)).toEqual(manifest.bytes);
      expectBytes(await store.get(bigCid), big); // a leaf is a file
    });

    it("putBlock takes a block only when it is what its name says", async () => {
      const store = await open();
      const hello = enc.encode("hello");
      await store.putBlock(HELLO_CID, hello);
      const doc = encodeDrisl({ hello: link(HELLO_CID) });
      const docCid = await nameOf(DRISL_CODE, doc);
      await store.putBlock(docCid, doc);
      expect(await store.list()).toEqual([HELLO_CID, docCid].sort());

      const digest = await sha256.digest(hello);
      const dagPbLink = new Uint8Array([0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x70, 0x12, 0x20, ...digest.digest]); // tag 42 over a dag-pb CID
      const wrong: [string, Uint8Array, string][] = [
        [HELLO_CID, enc.encode("hellO"), "other bytes under a raw name"],
        [HELLO_CID.toUpperCase(), hello, "not base32 lower"],
        [CID.create(0, 0x70, digest).toString(), hello, "CIDv0"],
        [CID.create(1, 0x70, digest).toString(), hello, "a dag-pb name, which is not a DASL CID"],
        [CID.create(1, RAW_CODE, await sha512.digest(hello)).toString(), hello, "sha-512"],
        [await nameOf(DRISL_CODE, hello), hello, "a drisl name over bytes that are not DRISL"],
        [...(await drislOver(new Uint8Array([0x18, 0x05]))), "a non-shortest integer"],
        [...(await drislOver(new Uint8Array([0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02]))), "an unsorted map"],
        [...(await drislOver(new Uint8Array([0x9f, 0x01, 0xff]))), "an indefinite-length array"],
        [...(await drislOver(new Uint8Array([...encodeDrisl(1), 0x00]))), "trailing bytes after the document"],
        [...(await drislOver(new Uint8Array([0xd8, 0x2b, 0x01]))), "a tag that is not 42"],
        [...(await drislOver(dagPbLink)), "a link that is not a DASL CID"],
      ];
      for (const [cid, bytes, why] of wrong) {
        await expect(store.putBlock(cid, bytes), why).rejects.toBeInstanceOf(BadBlock);
      }
      expect(await store.list()).toEqual([HELLO_CID, docCid].sort());
    });

    it("putBlock does not judge a document's shape: a DRISL block that is not a manifest is a block", async () => {
      const store = await open();
      const docs: Drisl[] = [
        1,
        -1,
        1.5,
        1n << 60n,
        "text",
        null,
        true,
        new Uint8Array([1, 2, 3]),
        [],
        {},
        [link(HELLO_CID), { deep: [link(HELLO_CID)] }],
        { resources: "not a mapping" },
      ];
      const names: string[] = [];
      for (const doc of docs) {
        const bytes = encodeDrisl(doc);
        const cid = await nameOf(DRISL_CODE, bytes);
        await store.putBlock(cid, bytes);
        expect(await store.getBlock(cid)).toEqual(bytes);
        names.push(cid);
      }
      expect(await store.list()).toEqual([...new Set(names)].sort());
    });

    it("keeps its own copy of the bytes, taken before the caller can touch them again", async () => {
      const store = await open();
      const viaBlock = enc.encode("hello");
      const pending = store.putBlock(HELLO_CID, viaBlock);
      viaBlock[0] = 0x48; // "Hello", before the check has run
      await pending;
      expect(await store.getBlock(HELLO_CID)).toEqual(enc.encode("hello"));
      const viaPut = enc.encode("world");
      const putting = store.put(viaPut);
      viaPut[0] = 0x57;
      const root = await putting;
      expect(root).toBe(await nameOf(RAW_CODE, enc.encode("world")));
      expect(await store.get(root)).toEqual(enc.encode("world"));
      // and what it hands out is a copy too
      const out = (await store.getBlock(HELLO_CID)) as Uint8Array;
      out[0] = 0x48;
      expect(await store.getBlock(HELLO_CID)).toEqual(enc.encode("hello"));
      const file = (await store.get(root)) as Uint8Array;
      file[0] = 0x57;
      expect(await store.get(root)).toEqual(enc.encode("world"));
    });

    it("get throws on a drisl root, which names a document, not a file", async () => {
      const store = await open();
      const manifest = await manifestBlock({ "/index.json": [HELLO_CID, 5] });
      await store.putBlock(manifest.cid, manifest.bytes);
      await expect(store.get(manifest.cid)).rejects.toBeInstanceOf(NotAFile);
      expect(await store.getBlock(manifest.cid)).toEqual(manifest.bytes); // as a block it is fine
      // the codec is in the name: a drisl root not held is not a file either
      const other = await nameOf(DRISL_CODE, encodeDrisl({ never: "put" }));
      await expect(store.get(other)).rejects.toBeInstanceOf(NotAFile);
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

    it("collect keeps every block a kept drisl root reaches through its links, and takes a whole object no root reaches", async () => {
      const c = clock("2026-08-30T10:00:00.000Z");
      const store = await open({ clock: c.now, graceMs: 0 });
      const hello = await store.put(enc.encode("hello"));
      const big = await store.put(bigBytes());
      const manifest = await manifestBlock({ "/index.json": [hello, 5], "/files/big": [big, bigBytes().length] });
      await store.putBlock(manifest.cid, manifest.bytes);
      const loose = await store.put(enc.encode("loose"));
      // a partial object: a manifest whose leaf never arrived is kept, the absent leaf unremarked
      const partial = await manifestBlock({ "/index.json": [await nameOf(RAW_CODE, enc.encode("absent")), 6] });
      await store.putBlock(partial.cid, partial.bytes);
      expect(await store.list()).toHaveLength(5);
      expect(await store.collect([manifest.cid, partial.cid])).toEqual({ unlinked: [loose], young: [] });
      expect(await store.list()).toEqual([hello, big, manifest.cid, partial.cid].sort());
      expectBytes(await store.get(big), bigBytes());
      // the leaves are held through the manifest alone: keep it and they stay; keep only a leaf and the rest goes
      expect(await store.collect([hello])).toEqual({ unlinked: [big, manifest.cid, partial.cid].sort(), young: [] });
      expect(await store.list()).toEqual([hello]);
      expect(await store.collect([])).toEqual({ unlinked: [hello], young: [] });
      expect(await store.list()).toEqual([]);
    });
  });
}
