import { base32Encode } from "@estoc/dasl";
import { sha256 } from "@noble/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
  DamagedObject,
  DigestMismatch,
  InvalidCid,
  ObjectTooLarge,
  chunksOf,
  compareCids,
  rawCidFromDigest,
  type Cid,
  type ObjectStore,
} from "../../../src/v3/index.js";
import { expectBytes, partition, shuffle } from "./helpers.js";

export interface OpenObjectOptions {
  /** the largest object a put accepts */
  maxObjectBytes?: number;
  /** the backend's internal extent size, where it has one */
  extentBytes?: number;
}

export interface ObjectStoreUnderTest {
  store: ObjectStore;
  /** Damage an accepted object's stored bytes in place, as a bad sector would, without telling the store; left out when the backend cannot. */
  corrupt?: (cid: Cid) => Promise<void>;
}

/** Open a fresh, empty store of the kind under test. */
export type OpenObjectStore = (options?: OpenObjectOptions) => Promise<ObjectStoreUnderTest>;

/** The executable raw DASL CID vectors. */
export const EMPTY_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" as Cid;
export const HELLO_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq" as Cid;
const HELLO = new TextEncoder().encode("hello");

// ---- bytes and sources ----------------------------------------------------

/** `n` deterministic bytes from `seed`: the same every run, different for every seed, no two runs of one value. */
export function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

/** The raw CID of `bytes`, computed here, apart from any store. */
export function cidOf(bytes: Uint8Array): Cid {
  return rawCidFromDigest(sha256(bytes)).text as Cid;
}

/** `bytes` as an async source in chunks of the given sizes (the last takes the rest). */
export async function* chunked(bytes: Uint8Array, sizes: number[]): AsyncIterable<Uint8Array> {
  let at = 0;
  for (const [i, size] of sizes.entries()) {
    const end = i === sizes.length - 1 ? bytes.length : Math.min(at + size, bytes.length);
    yield bytes.slice(at, end);
    at = end;
  }
}

/** `chunks` as a `ReadableStream`. */
export function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull: (controller) => {
      const chunk = chunks[i++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

/** Everything a stream yields, joined, and how many chunks it came in. */
export async function drain(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; chunks: number }> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunksOf(stream)) parts.push(chunk);
  return { bytes: join(parts), chunks: parts.length };
}

export function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

/** A CID string from a binary form the tests compose by hand: the `b` prefix and the canonical base32. */
function spelled(bytes: number[]): string {
  return `b${base32Encode(Uint8Array.from(bytes))}`;
}

const DIGEST = [...sha256(HELLO)];

/** What a store refuses as a CID, each with the reason it is not a raw DASL CID. */
export const BAD_CIDS: [string, string][] = [
  ["CIDv0", "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"],
  ["uppercase base32", HELLO_CID.toUpperCase()],
  ["padded base32", `${HELLO_CID}=`],
  ["non-canonical base32 (non-zero trailing bits)", `${HELLO_CID.slice(0, -1)}r`],
  ["DRISL / dag-cbor", spelled([0x01, 0x71, 0x12, 0x20, ...DIGEST])],
  ["dag-pb", spelled([0x01, 0x70, 0x12, 0x20, ...DIGEST])],
  ["BLAKE3 (BDASL)", spelled([0x01, 0x55, 0x1e, 0x20, ...DIGEST])],
  ["sha-512", spelled([0x01, 0x55, 0x13, 0x40, ...DIGEST, ...DIGEST])],
  ["wrong digest length", spelled([0x01, 0x55, 0x12, 0x10, ...DIGEST.slice(0, 16)])],
  ["trailing byte", spelled([0x01, 0x55, 0x12, 0x20, ...DIGEST, 0x00])],
  ["CIDv1 raw without multibase prefix", HELLO_CID.slice(1)],
  ["empty string", ""],
];

/**
 * The conformance suite over one `ObjectStore`, whatever it is made of:
 * what a store in memory and a database must both agree on. `open`
 * gives the suite fresh stores. Durability across a process restart and
 * the commit boundary are a backend's and the vault's to show with their
 * own tests.
 */
export function objectStoreSuite(name: string, open: OpenObjectStore): void {
  describe(`${name}: objectStoreSuite`, () => {
    describe("identity, verification and streaming", () => {
      it("the empty object has the CID of the vector, size 0, and round-trips", async () => {
        const { store } = await open();
        const info = await store.putRaw(new Uint8Array(0));
        expect(info).toEqual({ cid: EMPTY_CID, codec: "raw", size: 0 });
        expect(await store.has(EMPTY_CID)).toBe(true);
        expect(await store.stat(EMPTY_CID)).toEqual(info);
        expectBytes(await store.read(EMPTY_CID, 0), new Uint8Array(0));
        const stream = await store.open(EMPTY_CID);
        expect(stream).not.toBeNull();
        expectBytes((await drain(stream as ReadableStream<Uint8Array>)).bytes, new Uint8Array(0));
        expect(await all(store.list())).toEqual([EMPTY_CID]);
      });

      it('"hello" has the CID of the vector, by putRaw and by putObject alike', async () => {
        const { store } = await open();
        expect(await store.putRaw(HELLO)).toEqual({ cid: HELLO_CID, codec: "raw", size: 5 });
        const { store: other } = await open();
        expect(await other.putObject(HELLO_CID, HELLO)).toEqual({ cid: HELLO_CID, codec: "raw", size: 5 });
        expectBytes(await other.read(HELLO_CID, 5), HELLO);
      });

      it("one shot, every chunking, an async iterable and a ReadableStream give one CID and the exact bytes back", async () => {
        const bytes = bytesOf(100_003, 1);
        const want = cidOf(bytes);
        const { store: whole } = await open();
        expect((await whole.putRaw(bytes)).cid).toBe(want);
        const cuts: number[][] = [[1], [7, 7, 7], [50_000, 50_000], [100_003], [1, 100_000, 1], shuffle([13, 1_000, 99, 40_000, 3, 58_888], 4)];
        for (const [i, sizes] of cuts.entries()) {
          const { store } = await open();
          const info = await store.putRaw(chunked(bytes, sizes));
          expect(info, `chunking ${i}`).toEqual({ cid: want, codec: "raw", size: bytes.length });
          expectBytes(await store.read(want, bytes.length), bytes, `chunking ${i}`);
          const { store: viaStream } = await open();
          const parts = partition([...bytes], sizes).map((p) => Uint8Array.from(p));
          expect((await viaStream.putObject(want, streamOf(parts))).cid, `stream ${i}`).toBe(want);
          const stream = await viaStream.open(want);
          expectBytes((await drain(stream as ReadableStream<Uint8Array>)).bytes, bytes, `stream ${i}`);
        }
      });

      it("every CID a reader or writer is handed is checked first; what is not a canonical raw DASL CID is InvalidCid, whatever the method", async () => {
        const { store } = await open();
        await store.putRaw(HELLO);
        for (const [why, bad] of BAD_CIDS) {
          const cid = bad as Cid;
          await expect(store.putObject(cid, HELLO), why).rejects.toThrow(InvalidCid);
          await expect(store.has(cid), why).rejects.toThrow(InvalidCid);
          await expect(store.stat(cid), why).rejects.toThrow(InvalidCid);
          await expect(store.open(cid), why).rejects.toThrow(InvalidCid);
          await expect(store.read(cid, 1 << 20), why).rejects.toThrow(InvalidCid);
          await expect(store.collect([HELLO_CID, cid]), why).rejects.toThrow(InvalidCid);
        }
        expect(await all(store.list())).toEqual([HELLO_CID]); // nothing accepted, nothing unlinked
      });

      it("bytes that do not hash to the CID given — one byte changed, one missing, one extra — are refused with no object exposed", async () => {
        const bytes = bytesOf(5_000, 2);
        const want = cidOf(bytes);
        const changed = bytes.slice();
        changed[2_500] = (changed[2_500] as number) ^ 0x01;
        for (const [why, wrong] of [
          ["one byte changed", changed],
          ["one byte short", bytes.slice(0, -1)],
          ["one byte over", join([bytes, new Uint8Array([0])])],
        ] as const) {
          const { store } = await open();
          await expect(store.putObject(want, chunked(wrong, [1_000, 1_000])), why).rejects.toThrow(DigestMismatch);
          expect(await store.has(want), why).toBe(false);
          expect(await store.stat(want), why).toBeNull();
          expect(await store.open(want), why).toBeNull();
          expect(await store.read(want, 10_000), why).toBeNull();
          expect(await all(store.list()), why).toEqual([]);
          expect(await store.has(cidOf(wrong)), why).toBe(false); // nor under the CID the bytes do have
        }
      });

      it("a source that throws midway leaves nothing behind", async () => {
        const { store } = await open();
        const bytes = bytesOf(1_000, 3);
        async function* failing(): AsyncIterable<Uint8Array> {
          yield bytes.slice(0, 500);
          throw new Error("disk gone");
        }
        await expect(store.putRaw(failing())).rejects.toThrow("disk gone");
        await expect(store.putObject(cidOf(bytes), failing())).rejects.toThrow("disk gone");
        expect(await all(store.list())).toEqual([]);
      });

      it("the backend's extent size changes neither the CID nor the bytes that come back", async () => {
        const bytes = bytesOf(70_001, 4);
        const want = cidOf(bytes);
        const infos = [];
        for (const extentBytes of [1, 7, 4_096, 70_001, 1 << 20]) {
          const { store } = await open({ extentBytes });
          infos.push(await store.putRaw(chunked(bytes, [30_000, 30_000])));
          expect(await store.stat(want), `extent ${extentBytes}`).toEqual({ cid: want, codec: "raw", size: bytes.length });
          const stream = await store.open(want);
          expectBytes((await drain(stream as ReadableStream<Uint8Array>)).bytes, bytes, `extent ${extentBytes}`);
          expectBytes(await store.read(want, bytes.length), bytes, `extent ${extentBytes}`);
        }
        expect(new Set(infos.map((info) => info.cid)).size).toBe(1);
      });

      it("a large object streams in, streams out — in however many chunks the store chooses — verifies, and a bounded read refuses before allocating", async () => {
        const size = 8 * 1024 * 1024 + 1;
        const chunk = 64 * 1024;
        // The source is generated as it is pulled; nothing here holds the whole object.
        async function* large(): AsyncIterable<Uint8Array> {
          for (let at = 0; at < size; at += chunk) yield bytesOf(Math.min(chunk, size - at), at + 1);
        }
        const hash = sha256.create();
        for await (const part of large()) hash.update(part);
        const want = rawCidFromDigest(hash.digest()).text as Cid;

        const { store } = await open();
        expect(await store.putRaw(large())).toEqual({ cid: want, codec: "raw", size });
        const stream = await store.open(want);
        // Read back incrementally, hashing as it comes; how the store chunks its output is its own.
        const readBack = sha256.create();
        let seen = 0;
        for await (const part of chunksOf(stream as ReadableStream<Uint8Array>)) {
          readBack.update(part);
          seen += part.length;
        }
        expect(seen).toBe(size);
        expect(rawCidFromDigest(readBack.digest()).text).toBe(want);
        await expect(store.read(want, size - 1)).rejects.toThrow(ObjectTooLarge);
        expect((await store.read(want, size))?.length).toBe(size);
      });

      it("an object over the store's accepted-size bound is ObjectTooLarge, nothing is accepted, and the source is not read past the bound", async () => {
        const { store } = await open({ maxObjectBytes: 1_000 });
        let pulled = 0;
        async function* endless(): AsyncIterable<Uint8Array> {
          for (;;) {
            pulled += 1;
            yield bytesOf(300, pulled);
          }
        }
        await expect(store.putRaw(endless())).rejects.toThrow(ObjectTooLarge);
        expect(pulled).toBe(4); // 300, 600, 900, then the chunk that crosses
        expect(await all(store.list())).toEqual([]);
        expect((await store.putRaw(bytesOf(1_000, 9))).size).toBe(1_000); // the bound itself is allowed
        await expect(store.putObject(cidOf(bytesOf(1_001, 9)), bytesOf(1_001, 9))).rejects.toThrow(ObjectTooLarge);
      });

      it("putObject of a CID already held is idempotent — one object, its bytes untouched — and a wrong source under it is still refused", async () => {
        const { store } = await open();
        const bytes = bytesOf(3_000, 5);
        const cid = cidOf(bytes);
        await store.putRaw(bytes);
        expect(await store.putObject(cid, bytes)).toEqual({ cid, codec: "raw", size: 3_000 });
        expect(await store.putRaw(chunked(bytes, [1, 1]))).toEqual({ cid, codec: "raw", size: 3_000 });
        expect(await all(store.list())).toEqual([cid]);
        await expect(store.putObject(cid, bytesOf(3_000, 6))).rejects.toThrow(DigestMismatch);
        expectBytes(await store.read(cid, 3_000), bytes);
      });

      it("read refuses an object larger than maxBytes and a bound that is not a non-negative integer; an absent object is null", async () => {
        const { store } = await open();
        await store.putRaw(HELLO);
        await expect(store.read(HELLO_CID, 4)).rejects.toThrow(ObjectTooLarge);
        expectBytes(await store.read(HELLO_CID, 5), HELLO);
        expectBytes(await store.read(HELLO_CID, 6), HELLO);
        for (const bad of [-1, 1.5, NaN, Infinity]) {
          await expect(store.read(HELLO_CID, bad)).rejects.toThrow(RangeError);
        }
        expect(await store.read(EMPTY_CID, 0)).toBeNull();
        expect(await store.has(EMPTY_CID)).toBe(false);
        expect(await store.stat(EMPTY_CID)).toBeNull();
        expect(await store.open(EMPTY_CID)).toBeNull();
      });

      it("the bytes a read hands out are the caller's: changing them changes nothing held", async () => {
        const { store } = await open();
        const bytes = bytesOf(100, 7);
        const cid = cidOf(bytes);
        await store.putRaw(bytes);
        const read = (await store.read(cid, 100)) as Uint8Array;
        read.fill(0);
        const { bytes: streamed } = await drain((await store.open(cid)) as ReadableStream<Uint8Array>);
        streamed.fill(0);
        expectBytes(await store.read(cid, 100), bytes);
      });

      it("what is held is the store's own memory — a source's buffer rewritten after put, a generator reusing one buffer, a streamed chunk rewritten by its reader change nothing", async () => {
        const bytes = bytesOf(24, 8);
        const cid = cidOf(bytes);
        // One shot, as a view into a larger buffer the caller keeps and rewrites.
        const arena = new Uint8Array(64);
        arena.set(bytes, 20);
        const { store: a } = await open({ extentBytes: 5 });
        expect((await a.putRaw(arena.subarray(20, 44))).cid).toBe(cid);
        arena.fill(0xff);
        expectBytes(await a.read(cid, 24), bytes);
        // Chunked, every chunk a view into one buffer the generator refills.
        const scratch = new Uint8Array(8);
        async function* reusing(): AsyncIterable<Uint8Array> {
          for (let at = 0; at < bytes.length; at += 8) {
            scratch.set(bytes.subarray(at, at + 8));
            yield scratch.subarray(0, 8);
          }
        }
        const { store: b } = await open({ extentBytes: 5 });
        expect((await b.putObject(cid, reusing())).cid).toBe(cid);
        scratch.fill(0);
        expectBytes(await b.read(cid, 24), bytes);
        // Streamed out, the chunk the reader was handed rewritten before the next read.
        const reader = ((await b.open(cid)) as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          (value as Uint8Array).fill(0xee);
        }
        expectBytes(await b.read(cid, 24), bytes);
        expect(await all(b.list())).toEqual([cid]);
      });

      it("list: every accepted object once, in binary-CID byte order, which is not string order", async () => {
        const { store } = await open();
        const cids: Cid[] = [];
        for (let i = 0; i < 40; i++) cids.push((await store.putRaw(bytesOf(10, 100 + i))).cid);
        const listed = await all(store.list());
        expect(listed).toEqual([...cids].sort(compareCids));
        expect([...listed].sort()).not.toEqual(listed); // the base32 alphabet (a–z, 2–7) is not in ASCII order
        expect(new Set(listed).size).toBe(40);
      });
    });

    describe("collection and damage", () => {
      /** The first read to find `cid` damaged, by stream: the failure may come from `open` itself or from the stream, never a completion. */
      async function discover(store: ObjectStore, cid: Cid): Promise<void> {
        let failed: unknown;
        try {
          const stream = (await store.open(cid)) as ReadableStream<Uint8Array>;
          for await (const _ of chunksOf(stream)) {
            // consumed and discarded: chunks handed out before the failure were not to be trusted
          }
        } catch (err) {
          failed = err;
        }
        expect(failed).toBeInstanceOf(DamagedObject);
      }

      /** Every read and presence operation on a known damaged object fails with `DamagedObject`, and so does listing. */
      async function expectDamaged(store: ObjectStore, cid: Cid): Promise<void> {
        await expect(store.has(cid)).rejects.toThrow(DamagedObject);
        await expect(store.stat(cid)).rejects.toThrow(DamagedObject);
        await expect(store.open(cid)).rejects.toThrow(DamagedObject);
        await expect(store.read(cid, 1 << 20)).rejects.toThrow(DamagedObject);
        await expect(all(store.list())).rejects.toThrow(DamagedObject);
      }

      it("collect deletes exactly the unkept, at once and whatever their age; the keep set is exact, a duplicate no different; removed is unique, in binary-CID byte order", async () => {
        const { store } = await open();
        const kept = (await store.putRaw(bytesOf(10, 11))).cid;
        const orphans: Cid[] = [];
        for (let i = 0; i < 12; i++) orphans.push((await store.putRaw(bytesOf(10, 200 + i))).cid);
        expect(await store.collect([kept, kept])).toEqual({ removed: [...orphans].sort(compareCids) });
        for (const orphan of orphans) {
          expect(await store.has(orphan)).toBe(false);
          expect(await store.stat(orphan)).toBeNull();
          expect(await store.open(orphan)).toBeNull();
          expect(await store.read(orphan, 10)).toBeNull();
        }
        expect(await store.has(kept)).toBe(true);
        expect(await all(store.list())).toEqual([kept]);
        expect(await store.collect([kept])).toEqual({ removed: [] });
        expectBytes(await store.read(kept, 10), bytesOf(10, 11));
      });

      it("with no keep set at all, everything goes; a store with nothing collects nothing", async () => {
        const { store } = await open();
        expect(await store.collect([])).toEqual({ removed: [] });
        const cids = [];
        for (let i = 0; i < 5; i++) cids.push((await store.putRaw(bytesOf(20, 20 + i))).cid);
        expect(await store.collect([])).toEqual({ removed: [...cids].sort(compareCids) });
        expect(await all(store.list())).toEqual([]);
        expect(await store.collect([])).toEqual({ removed: [] });
      });

      it("an invalid CID in keep fails the pass before it begins: nothing is touched", async () => {
        const { store } = await open();
        const cid = (await store.putRaw(HELLO)).cid;
        await expect(store.collect([cid, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" as Cid])).rejects.toThrow(InvalidCid);
        await expect(store.collect(["" as Cid])).rejects.toThrow(InvalidCid);
        expect(await store.has(cid)).toBe(true);
      });

      it("a CID written inside an object's bytes retains nothing; only the keep set does", async () => {
        const { store } = await open();
        const leaf = (await store.putRaw(bytesOf(50, 14))).cid;
        const root = (await store.putRaw(new TextEncoder().encode(JSON.stringify({ attachment: leaf })))).cid;
        expect(await store.collect([root])).toEqual({ removed: [leaf] });
        expect(await store.has(root)).toBe(true);
        expect(await store.has(leaf)).toBe(false);
      });

      it("a stream open when its object is collected completes with the whole object or fails explicitly, never a truncation; the object is absent either way", async () => {
        const { store } = await open({ extentBytes: 4 });
        const bytes = bytesOf(10, 15);
        const cid = (await store.putRaw(bytes)).cid;
        const reader = ((await store.open(cid)) as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(await store.collect([])).toEqual({ removed: [cid] });
        expect(await store.has(cid)).toBe(false);
        expect(await store.open(cid)).toBeNull();
        const parts = [first.value as Uint8Array];
        let failed = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
          }
        } catch (err) {
          expect(err).toBeInstanceOf(Error); // failed, explicitly
          failed = true;
        }
        if (!failed) expectBytes(join(parts), bytes); // or completed: then with every byte
      });

      it("an object a read finds not to hash to its CID fails that read and is known damaged from then on: has, stat, open, read and list all fail, other objects are untouched", async () => {
        const { store, corrupt } = await open({ extentBytes: 4 });
        if (corrupt === undefined) return; // a backend that cannot be damaged from outside has nothing to show here
        const bytes = bytesOf(10, 22);
        const cid = (await store.putRaw(bytes)).cid;
        const other = (await store.putRaw(bytesOf(10, 23))).cid;
        await corrupt(cid);
        expect(await store.has(cid)).toBe(true); // nothing has looked yet
        await discover(store, cid);
        await expectDamaged(store, cid);
        expect(await store.has(other)).toBe(true);
        expectBytes(await store.read(other, 10), bytesOf(10, 23));
        // a bounded read discovers it just the same
        const { store: fresh, corrupt: corruptFresh } = await open({ extentBytes: 4 });
        if (corruptFresh === undefined) return;
        await fresh.putRaw(bytes);
        await corruptFresh(cid);
        await expect(fresh.read(cid, 10)).rejects.toThrow(DamagedObject);
        await expectDamaged(fresh, cid);
      });

      it("collection with a known damaged object: kept, it stays and stays damaged; unkept, it goes, is in removed, and reports absence after", async () => {
        const { store, corrupt } = await open({ extentBytes: 4 });
        if (corrupt === undefined) return;
        const bytes = bytesOf(10, 24);
        const cid = (await store.putRaw(bytes)).cid;
        const sound = (await store.putRaw(bytesOf(10, 25))).cid;
        await corrupt(cid);
        await discover(store, cid);
        expect(await store.collect([cid, sound])).toEqual({ removed: [] });
        await expectDamaged(store, cid);
        expect(await store.collect([sound])).toEqual({ removed: [cid] });
        expect(await store.has(cid)).toBe(false);
        expect(await store.stat(cid)).toBeNull();
        expect(await store.open(cid)).toBeNull();
        expect(await store.read(cid, 10)).toBeNull();
        expect(await all(store.list())).toEqual([sound]);
      });

      it("verified replacement of a known damaged object restores normal results, by putObject and by putRaw alike; wrong bytes are DigestMismatch and leave the damage as it was", async () => {
        const { store, corrupt } = await open({ extentBytes: 4 });
        if (corrupt === undefined) return;
        const bytes = bytesOf(10, 26);
        const cid = (await store.putRaw(bytes)).cid;
        await corrupt(cid);
        await discover(store, cid);
        await expect(store.putObject(cid, bytesOf(10, 27))).rejects.toThrow(DigestMismatch);
        await expectDamaged(store, cid);
        expect(await store.putObject(cid, chunked(bytes, [3, 3]))).toEqual({ cid, codec: "raw", size: 10 });
        expect(await store.has(cid)).toBe(true);
        expect(await store.stat(cid)).toEqual({ cid, codec: "raw", size: 10 });
        expectBytes(await store.read(cid, 10), bytes);
        expectBytes((await drain((await store.open(cid)) as ReadableStream<Uint8Array>)).bytes, bytes);
        expect(await all(store.list())).toEqual([cid]);
        await corrupt(cid);
        await expect(store.read(cid, 10)).rejects.toThrow(DamagedObject);
        expect(await store.putRaw(bytes)).toEqual({ cid, codec: "raw", size: 10 });
        expectBytes(await store.read(cid, 10), bytes);
        expect(await all(store.list())).toEqual([cid]);
      });
    });
  });
}
