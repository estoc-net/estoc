import { describe, expect, it } from "vitest";

import {
  DamagedObject,
  DEFAULT_EXTENT_BYTES,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_OBJECT_BYTES,
  LatchRegistry,
  MemoryObjectStore,
  chunksOf,
  type Cid,
  type ObjectStore,
} from "../../src/v3/index.js";
import { expectBytes } from "./suite/helpers.js";
import { EMPTY_CID, HELLO_CID, bytesOf, chunked, cidOf, drain, join, objectStoreSuite, type OpenObjectOptions } from "./suite/object-store-suite.js";

objectStoreSuite("MemoryObjectStore", async (options: OpenObjectOptions = {}) => {
  const store = new MemoryObjectStore(options);
  return { store, corrupt: async (cid: Cid) => store.damage(cid) };
});

/**
 * `inner` with its output streams cut into chunks of at most `n` bytes
 * — for the first 256 chunks of each stream; 64 KiB after that, so a
 * large object (DO-7) does not come out in millions — the latch
 * untouched: a store that chunks its output otherwise than by extent,
 * which the suite must accept just the same.
 */
function rechunked(inner: ObjectStore, n: number): ObjectStore {
  return {
    ...passthrough(inner),
    open: async (cid) => {
      const stream = await inner.open(cid);
      if (stream === null) return null;
      const reader = stream.getReader();
      let pending: Uint8Array = new Uint8Array(0);
      let handed = 0;
      return new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            while (pending.length === 0) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              pending = value;
            }
            const size = handed < 256 ? n : 64 * 1024;
            handed += 1;
            controller.enqueue(pending.slice(0, size));
            pending = pending.subarray(size);
          },
          cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 }
      );
    },
  };
}

/**
 * `inner` with each output stream closed together with its last chunk:
 * the inner stream is read one chunk ahead, so its verification and
 * EOF come before the last chunk is handed out, and the outer stream
 * closes on that same pull. The outer stream holds a latch of its own
 * in the store's registry until it closes, fails or is cancelled. A
 * store that completes with the last chunk rather than on the read
 * after it, which the suite must accept just the same.
 */
function closingOnLast(inner: MemoryObjectStore): ObjectStore {
  return {
    ...passthrough(inner),
    open: async (cid) => {
      const stream = await inner.open(cid);
      if (stream === null) return null;
      const release = inner.latches.acquire(cid);
      const reader = stream.getReader();
      let ahead = await reader.read().catch((err: unknown) => {
        release();
        throw err;
      });
      return new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            if (ahead.done) {
              release();
              controller.close();
              return;
            }
            const chunk = ahead.value;
            try {
              ahead = await reader.read();
            } catch (err) {
              release();
              controller.error(err);
              return;
            }
            controller.enqueue(chunk);
            if (ahead.done) {
              release();
              controller.close();
            }
          },
          cancel: async (reason) => {
            release();
            await reader.cancel(reason);
          },
        },
        { highWaterMark: 0 }
      );
    },
  };
}

/**
 * `inner` with every object verified before a byte of it is handed
 * out: `open` reads the inner stream to its end once — its check — and
 * throws `DamagedObject` from `open` itself if that fails; otherwise it
 * opens the object again and passes it through. A latch of the outer
 * stream's own covers the gap between the two. A store that does not
 * verify lazily, which the suite must accept just the same.
 */
function verifyingFirst(inner: MemoryObjectStore): ObjectStore {
  return {
    ...passthrough(inner),
    open: async (cid) => {
      const check = await inner.open(cid);
      if (check === null) return null;
      const release = inner.latches.acquire(cid);
      try {
        for await (const _ of chunksOf(check)) {
          // read to the end: the verification
        }
        const stream = (await inner.open(cid)) as ReadableStream<Uint8Array>;
        const reader = stream.getReader();
        return new ReadableStream<Uint8Array>(
          {
            pull: async (controller) => {
              const { done, value } = await reader.read();
              if (done) controller.close();
              else controller.enqueue(value);
            },
            cancel: (reason) => reader.cancel(reason),
          },
          { highWaterMark: 0 }
        );
      } finally {
        release();
      }
    },
  };
}

function passthrough(inner: ObjectStore): ObjectStore {
  return {
    putRaw: (source) => inner.putRaw(source),
    putObject: (cid, source) => inner.putObject(cid, source),
    open: (cid) => inner.open(cid),
    read: (cid, max) => inner.read(cid, max),
    stat: (cid) => inner.stat(cid),
    has: (cid) => inner.has(cid),
    list: () => inner.list(),
    collect: (keep) => inner.collect(keep),
  };
}

objectStoreSuite("MemoryObjectStore, closing with the last chunk", async (options: OpenObjectOptions = {}) => {
  const store = new MemoryObjectStore(options);
  return { store: closingOnLast(store), corrupt: async (cid: Cid) => store.damage(cid) };
});

objectStoreSuite("MemoryObjectStore, verifying before the first chunk", async (options: OpenObjectOptions = {}) => {
  const store = new MemoryObjectStore(options);
  return { store: verifyingFirst(store), corrupt: async (cid: Cid) => store.damage(cid) };
});

objectStoreSuite("MemoryObjectStore, 16 MiB extents unless told otherwise", async (options: OpenObjectOptions = {}) => {
  const store = new MemoryObjectStore({ extentBytes: 16 << 20, ...options });
  return { store, corrupt: async (cid: Cid) => store.damage(cid) };
});

objectStoreSuite("MemoryObjectStore, output in 2-byte chunks", async (options: OpenObjectOptions = {}) => {
  const store = new MemoryObjectStore(options);
  return { store: rechunked(store, 2), corrupt: async (cid: Cid) => store.damage(cid) };
});

objectStoreSuite("MemoryObjectStore, output in 3-byte chunks", async (options: OpenObjectOptions = {}) => {
  const store = new MemoryObjectStore(options);
  return { store: rechunked(store, 3), corrupt: async (cid: Cid) => store.damage(cid) };
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
    expectBytes(parts[0], bytes.slice(0, 4));
    const one = new MemoryObjectStore({ extentBytes: 1 << 20 });
    const single = (await one.putRaw(chunked(bytes, [1, 2, 3]))).cid;
    expect((await drain((await one.open(single)) as ReadableStream<Uint8Array>)).chunks).toBe(1);
    expect((await drain((await one.open(EMPTY_CID)) ?? (await one.putRaw(new Uint8Array(0)), (await one.open(EMPTY_CID)) as ReadableStream<Uint8Array>))).chunks).toBe(0);
  });

  it("a large object comes out in as many extents as it spans — one, when the extent is larger than the object", async () => {
    const size = 8 * 1024 * 1024 + 1;
    const chunk = 64 * 1024;
    async function* large(): AsyncIterable<Uint8Array> {
      for (let at = 0; at < size; at += chunk) yield bytesOf(Math.min(chunk, size - at), at + 1);
    }
    for (const [extentBytes, chunks] of [
      [1 << 20, 9],
      [16 << 20, 1],
      [size, 1],
      [size - 1, 2],
    ] as const) {
      const store = new MemoryObjectStore({ extentBytes });
      const { cid } = await store.putRaw(large());
      const { chunks: got, bytes } = await drain((await store.open(cid)) as ReadableStream<Uint8Array>);
      expect(got, `extent ${extentBytes}`).toBe(chunks);
      expect(bytes.length, `extent ${extentBytes}`).toBe(size);
    }
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
    expectBytes(await store.read(cid, 12), want);
  });

  it("a Buffer is a Uint8Array whose slice is a view — one put whole, one reused by a generator, one chunk handed out by a stream: none of them shares memory with what is held", async () => {
    // Put whole, then the caller's Buffer rewritten.
    const one = new MemoryObjectStore();
    const hello = Buffer.from("hello");
    expect((await one.putRaw(hello)).cid).toBe(HELLO_CID);
    hello[0] = 0x48;
    expectBytes(await one.read(HELLO_CID, 5), new TextEncoder().encode("hello"));
    // A generator refilling one 4-byte Buffer: 1s, then 2s, then 3s; an extent of 12 keeps all three in one extent.
    const reusing = new MemoryObjectStore({ extentBytes: 12 });
    const scratch = Buffer.alloc(4);
    async function* refill(): AsyncIterable<Uint8Array> {
      for (let i = 1; i <= 3; i++) {
        scratch.fill(i);
        yield scratch;
      }
    }
    const want = Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect((await reusing.putRaw(refill())).cid).toBe(cidOf(want));
    expectBytes(await reusing.read(cidOf(want), 12), want);
    // A chunk from open() rewritten by its reader, the stream read to completion, then the object read again.
    const reader = ((await one.open(HELLO_CID)) as ReadableStream<Uint8Array>).getReader();
    const first = (await reader.read()).value as Uint8Array;
    first[0] = 0x48;
    expect((await reader.read()).done).toBe(true);
    expectBytes(await one.read(HELLO_CID, 5), new TextEncoder().encode("hello"));
    expect(await one.has(HELLO_CID)).toBe(true);
  });

  it("a put over a damaged object that nothing has read replaces its bytes; the old bytes' reader fails, the new bytes stay", async () => {
    const store = new MemoryObjectStore({ extentBytes: 2 });
    const bytes = bytesOf(10, 5);
    const cid = (await store.putRaw(bytes)).cid;
    store.damage(cid);
    expect(await store.putObject(cid, bytes)).toEqual({ cid, codec: "raw", size: 10 });
    expectBytes(await store.read(cid, 10), bytes);
    store.damage(cid);
    expect(await store.putRaw(chunked(bytes, [3, 3, 3]))).toEqual({ cid, codec: "raw", size: 10 });
    expectBytes(await store.read(cid, 10), bytes);
    const streamed = await drain((await store.open(cid)) as ReadableStream<Uint8Array>);
    expectBytes(streamed.bytes, bytes);
    expect(streamed.chunks).toBe(5);
  });

  it("this store completes on the read after the last chunk, not with it — every byte handed out, the object is still latched until the reader sees the end", async () => {
    const store = new MemoryObjectStore({ graceMs: 0, extentBytes: 4 });
    const bytes = bytesOf(10, 6);
    const cid = (await store.putRaw(bytes)).cid;
    const reader = ((await store.open(cid)) as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) parts.push((await reader.read()).value as Uint8Array);
    expectBytes(join(parts), bytes);
    expect(store.latches.count(cid)).toBe(1);
    expect(await store.collect([])).toEqual({ unlinked: [], young: [] });
    expect((await reader.read()).done).toBe(true);
    expect(store.latches.count(cid)).toBe(0);
    expect(await store.collect([])).toEqual({ unlinked: [cid], young: [] });
  });

  it("this store verifies lazily — a damaged chunk goes out before the failure; a put that repairs the object meanwhile is left alone by the old reader's failure", async () => {
    const store = new MemoryObjectStore({ extentBytes: 4 });
    const bytes = bytesOf(10, 7);
    const cid = (await store.putRaw(bytes)).cid;
    store.damage(cid);
    const reader = ((await store.open(cid)) as ReadableStream<Uint8Array>).getReader();
    const first = (await reader.read()).value as Uint8Array;
    expect(first).not.toEqual(bytes.slice(0, 4)); // the damaged chunk, out before anything checked it
    await store.putObject(cid, bytes);
    let failed: unknown;
    try {
      for (;;) {
        if ((await reader.read()).done) break;
      }
    } catch (err) {
      failed = err;
    }
    expect(failed).toBeInstanceOf(DamagedObject);
    expect(store.latches.count(cid)).toBe(0);
    expect(await store.has(cid)).toBe(true);
    expectBytes(await store.read(cid, 10), bytes);
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
    expectBytes(await store.read(cid, 30), bytes);
  });
});

/** `globalThis[name]` replaced by a Proxy whose `construct` may throw, for the length of `run` (fault injection). */
async function withConstructFault<T>(name: "Uint8Array" | "ReadableStream", shouldThrow: (args: unknown[]) => boolean, run: () => Promise<T>): Promise<T> {
  const Real = globalThis[name] as unknown as new (...args: unknown[]) => unknown;
  (globalThis as Record<string, unknown>)[name] = new Proxy(Real, {
    construct: (target, args, newTarget) => {
      if (shouldThrow(args)) throw new RangeError(`injected: new ${name}(...)`);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    return await run();
  } finally {
    (globalThis as Record<string, unknown>)[name] = Real;
  }
}

describe("MemoryObjectStore open releases the latch on every failure (event-store.md §10)", () => {
  const T0 = "2026-09-07T10:00:00.000Z";

  async function orphaned(): Promise<{ store: MemoryObjectStore; cid: Cid; bytes: Uint8Array }> {
    const store = new MemoryObjectStore({ now: () => new Date(T0).getTime(), graceMs: 0 });
    const bytes = new TextEncoder().encode("hello");
    const { cid } = await store.putRaw(bytes);
    return { store, cid, bytes };
  }

  it("a chunk copy that throws fails the stream with that error, releases the latch, and the object is collectable", async () => {
    const { store, cid, bytes } = await orphaned();
    const stream = (await store.open(cid)) as ReadableStream<Uint8Array>;
    expect(store.latches.count(cid)).toBe(1);
    const reader = stream.getReader();
    await withConstructFault(
      "Uint8Array",
      (args) => args.length === 1 && args[0] instanceof Uint8Array && args[0].length === bytes.length,
      async () => {
        await expect(reader.read()).rejects.toThrow(/injected/);
      }
    );
    reader.releaseLock();
    await expect(stream.cancel()).rejects.toThrow(/injected/); // an errored stream: cancel rejects, and releases nothing — the store already did
    expect(store.latches.count(cid)).toBe(0);
    expect(await store.collect([])).toEqual({ unlinked: [cid], young: [] });
  });

  it("a stream that cannot be built rejects open, releases the latch, and holds another reader's latch on the same CID", async () => {
    const { store, cid, bytes } = await orphaned();
    const other = (await store.open(cid)) as ReadableStream<Uint8Array>;
    expect(store.latches.count(cid)).toBe(1);
    await withConstructFault(
      "ReadableStream",
      () => true,
      async () => {
        await expect(store.open(cid)).rejects.toThrow(/injected/);
      }
    );
    expect(store.latches.count(cid)).toBe(1);
    expect(await store.collect([])).toEqual({ unlinked: [], young: [] });
    expectBytes((await drain(other)).bytes, bytes);
    expect(store.latches.count(cid)).toBe(0);
    expect(await store.collect([])).toEqual({ unlinked: [cid], young: [] });
  });
});
