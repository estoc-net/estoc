import { sha256 } from "@noble/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
  InvalidCid,
  LatchRegistry,
  ObjectTooLarge,
  chunksOf,
  compareCids,
  hashSource,
  isRawCid,
  rawCidFromDigest,
  rawCidOf,
  sortCids,
  type Cid,
} from "../../src/v3/index.js";
import { BAD_CIDS, EMPTY_CID, HELLO_CID, bytesOf, chunked, join, streamOf } from "./suite/object-store-suite.js";

const HELLO = new TextEncoder().encode("hello");

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

describe("raw CIDs (dasl-objects.md §3, §4)", () => {
  it("§4.2: the vectors — from a digest, and back to the digest", () => {
    expect(rawCidFromDigest(sha256(new Uint8Array(0))).text).toBe(EMPTY_CID);
    expect(rawCidFromDigest(sha256(HELLO)).text).toBe(HELLO_CID);
    const parsed = rawCidOf(HELLO_CID);
    expect(parsed.code).toBe(0x55);
    expect([...parsed.digest]).toEqual([...sha256(HELLO)]);
    expect(parsed.bytes.length).toBe(36);
    expect(Buffer.from(parsed.bytes).toString("hex")).toBe("015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("DO-3, DO-15: rawCidOf refuses every non-raw, non-canonical or malformed identifier, each as InvalidCid; isRawCid agrees", () => {
    for (const [why, bad] of BAD_CIDS) {
      expect(() => rawCidOf(bad), why).toThrow(InvalidCid);
      expect(isRawCid(bad), why).toBe(false);
    }
    expect(() => rawCidOf(undefined)).toThrow(InvalidCid);
    expect(() => rawCidOf(42)).toThrow(InvalidCid);
    expect(() => rawCidOf({ toString: () => HELLO_CID })).toThrow(InvalidCid);
    expect(isRawCid(HELLO_CID)).toBe(true);
    expect(() => rawCidFromDigest(new Uint8Array(31))).toThrow(InvalidCid);
  });

  it("compareCids orders by the binary CID, where the base32 alphabet would not; sortCids also deduplicates", () => {
    const cids = Array.from({ length: 64 }, (_, i) => rawCidFromDigest(sha256(bytesOf(8, i + 1))).text as Cid);
    const sorted = sortCids([...cids, ...cids]);
    expect(sorted.length).toBe(64);
    for (let i = 1; i < sorted.length; i++) {
      const a = rawCidOf(sorted[i - 1] as Cid).bytes;
      const b = rawCidOf(sorted[i] as Cid).bytes;
      expect(Buffer.compare(a, b)).toBe(-1);
    }
    expect([...sorted].sort()).not.toEqual(sorted);
    expect(compareCids(EMPTY_CID, EMPTY_CID)).toBe(0);
    expect(Math.sign(compareCids(EMPTY_CID, HELLO_CID))).toBe(-Math.sign(compareCids(HELLO_CID, EMPTY_CID)));
  });
});

describe("chunksOf and hashSource (dasl-objects.md §5, §6.1)", () => {
  it("takes the three shapes and yields the same chunks; a whole Uint8Array is one chunk", async () => {
    const bytes = bytesOf(100, 1);
    expect(await collect(chunksOf(bytes))).toEqual([bytes]);
    expect(join(await collect(chunksOf(chunked(bytes, [30, 30]))))).toEqual(bytes);
    expect(await collect(chunksOf(streamOf([bytes.slice(0, 40), bytes.slice(40)])))).toEqual([bytes.slice(0, 40), bytes.slice(40)]);
  });

  it("refuses what is not a source, and a chunk that is not a Uint8Array, where it is met", async () => {
    await expect(collect(chunksOf("hello" as unknown as Uint8Array))).rejects.toThrow(TypeError);
    await expect(collect(chunksOf([HELLO] as unknown as Uint8Array))).rejects.toThrow(TypeError);
    async function* strings(): AsyncIterable<Uint8Array> {
      yield HELLO;
      yield "world" as unknown as Uint8Array;
    }
    const seen: Uint8Array[] = [];
    await expect(
      (async () => {
        for await (const chunk of chunksOf(strings())) seen.push(chunk);
      })()
    ).rejects.toThrow(TypeError);
    expect(seen).toEqual([HELLO]);
    await expect(collect(chunksOf(streamOf(["x" as unknown as Uint8Array])))).rejects.toThrow(TypeError);
  });

  it("stopping early releases the source: a stream is cancelled, an iterator returned", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(bytesOf(10, 2)),
      cancel: () => {
        cancelled = true;
      },
    });
    for await (const chunk of chunksOf(stream)) {
      expect(chunk.length).toBe(10);
      break;
    }
    expect(cancelled).toBe(true);
    let returned = false;
    async function* endless(): AsyncIterable<Uint8Array> {
      try {
        for (;;) yield bytesOf(10, 3);
      } finally {
        returned = true;
      }
    }
    for await (const _ of chunksOf(endless())) break;
    expect(returned).toBe(true);
  });

  it("hashSource hands every chunk to the sink in order, holds none itself, and names the raw CID at the end", async () => {
    const bytes = bytesOf(10_000, 4);
    const seen: Uint8Array[] = [];
    const { cid, size } = await hashSource(chunked(bytes, [3_000, 3_000, 3_000, 1_000]), Infinity, (chunk) => seen.push(chunk));
    expect(cid.text).toBe(rawCidFromDigest(sha256(bytes)).text);
    expect(size).toBe(10_000);
    expect(seen.map((c) => c.length)).toEqual([3_000, 3_000, 3_000, 1_000]);
    expect(join(seen)).toEqual(bytes);
    expect((await hashSource(new Uint8Array(0), 0, () => undefined)).cid.text).toBe(EMPTY_CID);
  });

  it("hashSource stops at the chunk that crosses maxBytes, having read no further", async () => {
    let pulled = 0;
    async function* endless(): AsyncIterable<Uint8Array> {
      for (;;) {
        pulled += 1;
        yield bytesOf(100, pulled);
      }
    }
    await expect(hashSource(endless(), 250, () => undefined)).rejects.toThrow(ObjectTooLarge);
    expect(pulled).toBe(3);
    await expect(hashSource(bytesOf(251, 1), 250, () => undefined)).rejects.toThrow(ObjectTooLarge);
    expect((await hashSource(bytesOf(250, 1), 250, () => undefined)).size).toBe(250);
  });
});

describe("LatchRegistry (event-store.md §10)", () => {
  it("counts holds per CID; a release releases one hold, once; the last release clears the CID", () => {
    const latches = new LatchRegistry();
    expect(latches.isLatched(HELLO_CID)).toBe(false);
    const a = latches.acquire(HELLO_CID);
    const b = latches.acquire(HELLO_CID);
    const c = latches.acquire(EMPTY_CID);
    expect(latches.count(HELLO_CID)).toBe(2);
    expect(latches.latched()).toEqual(sortCids([HELLO_CID, EMPTY_CID]));
    a();
    a();
    a();
    expect(latches.count(HELLO_CID)).toBe(1);
    expect(latches.isLatched(HELLO_CID)).toBe(true);
    b();
    expect(latches.isLatched(HELLO_CID)).toBe(false);
    expect(latches.count(HELLO_CID)).toBe(0);
    expect(latches.latched()).toEqual([EMPTY_CID]);
    c();
    expect(latches.latched()).toEqual([]);
  });
});
