import { describe, expect, it } from "vitest";

import { DEFAULT_EXTENT_BYTES, DEFAULT_GRACE_MS, DEFAULT_MAX_OBJECT_BYTES, LatchRegistry, MemoryObjectStore, chunksOf, type Cid } from "../../src/v3/index.js";
import { EMPTY_CID, HELLO_CID, bytesOf, chunked, cidOf, drain, objectStoreSuite, type OpenObjectOptions } from "./suite/object-store-suite.js";

objectStoreSuite("MemoryObjectStore", async (options: OpenObjectOptions = {}) => {
  const store = new MemoryObjectStore(options);
  return { store, corrupt: async (cid: Cid) => store.damage(cid) };
});

describe("MemoryObjectStore", () => {
  it("has its defaults: an hour of grace, 1 GiB accepted, 1 MiB extents, a registry of its own", () => {
    expect(DEFAULT_GRACE_MS).toBe(3_600_000);
    expect(DEFAULT_MAX_OBJECT_BYTES).toBe(1 << 30);
    expect(DEFAULT_EXTENT_BYTES).toBe(1 << 20);
    const a = new MemoryObjectStore();
    const b = new MemoryObjectStore();
    expect(a.latches).toBeInstanceOf(LatchRegistry);
    expect(a.latches).not.toBe(b.latches);
    const shared = new LatchRegistry();
    expect(new MemoryObjectStore({ latches: shared }).latches).toBe(shared);
  });

  it("refuses a bound that is not a non-negative integer, and an extent size of zero", () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => new MemoryObjectStore({ graceMs: bad })).toThrow(RangeError);
      expect(() => new MemoryObjectStore({ maxObjectBytes: bad })).toThrow(RangeError);
      expect(() => new MemoryObjectStore({ extentBytes: bad })).toThrow(RangeError);
    }
    expect(() => new MemoryObjectStore({ extentBytes: 0 })).toThrow(RangeError);
    expect(() => new MemoryObjectStore({ graceMs: 0, maxObjectBytes: 0, extentBytes: 1 })).not.toThrow();
  });

  it("streams an object out one extent per chunk, whatever chunks it came in", async () => {
    const store = new MemoryObjectStore({ extentBytes: 4 });
    const bytes = bytesOf(10, 1);
    const cid = (await store.putRaw(chunked(bytes, [1, 2, 3]))).cid;
    const stream = (await store.open(cid)) as ReadableStream<Uint8Array>;
    const parts: Uint8Array[] = [];
    for await (const part of chunksOf(stream)) parts.push(part);
    expect(parts.map((p) => p.length)).toEqual([4, 4, 2]);
    expect(parts[0]).toEqual(bytes.slice(0, 4));
    const one = new MemoryObjectStore({ extentBytes: 1 << 20 });
    const single = (await one.putRaw(chunked(bytes, [1, 2, 3]))).cid;
    expect((await drain((await one.open(single)) as ReadableStream<Uint8Array>)).chunks).toBe(1);
    expect((await drain((await one.open(EMPTY_CID)) ?? (await one.putRaw(new Uint8Array(0)), (await one.open(EMPTY_CID)) as ReadableStream<Uint8Array>))).chunks).toBe(0);
  });

  it("copies what a caller's source yields: reusing the buffer afterwards changes nothing held", async () => {
    const store = new MemoryObjectStore({ extentBytes: 3 });
    const buffer = new Uint8Array(4);
    async function* reusing(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < 3; i++) {
        buffer.fill(i + 1);
        yield buffer;
      }
    }
    const want = Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    const { cid } = await store.putRaw(reusing());
    expect(cid).toBe(cidOf(want));
    expect(await store.read(cid, 12)).toEqual(want);
  });

  it("a stream pulls nothing until it is read: an opened, unread stream hands out no bytes and stays latched", async () => {
    const store = new MemoryObjectStore({ graceMs: 0, extentBytes: 4 });
    const cid = (await store.putRaw(bytesOf(10, 2))).cid;
    const stream = (await store.open(cid)) as ReadableStream<Uint8Array>;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.latches.count(cid)).toBe(1);
    expect(await store.collect([])).toEqual({ unlinked: [], young: [] });
    await stream.cancel();
    expect(store.latches.count(cid)).toBe(0);
  });

  it("damage: flips a byte of a held object in place; refuses an absent object and one with no bytes", async () => {
    const store = new MemoryObjectStore();
    await store.putRaw(new Uint8Array(0));
    expect(() => store.damage(EMPTY_CID)).toThrow("no bytes");
    expect(() => store.damage(HELLO_CID)).toThrow("not held");
    await store.putRaw(new TextEncoder().encode("hello"));
    store.damage(HELLO_CID);
    expect(await store.has(HELLO_CID)).toBe(true);
    await expect(store.read(HELLO_CID, 5)).rejects.toThrow("no longer hash");
    expect(await store.has(HELLO_CID)).toBe(false);
    expect(await store.has(EMPTY_CID)).toBe(true);
  });

  it("a read that finds damage evicts that object only; a put of the same CID afterwards is a fresh acceptance", async () => {
    const store = new MemoryObjectStore({ graceMs: 0 });
    const bytes = bytesOf(30, 3);
    const cid = (await store.putRaw(bytes)).cid;
    const other = (await store.putRaw(bytesOf(30, 4))).cid;
    store.damage(cid);
    await expect(store.read(cid, 30)).rejects.toThrow();
    expect(await store.has(other)).toBe(true);
    expect(await store.putObject(cid, bytes)).toEqual({ cid, codec: "raw", size: 30 });
    expect(await store.read(cid, 30)).toEqual(bytes);
  });
});
