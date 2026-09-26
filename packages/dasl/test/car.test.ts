import { encode as encodeDagCbor } from "@ipld/dag-cbor";
import { describe, expect, it, test } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { decodeCar, decodeDrisl, drislCid, encodeCar, encodeDrisl, Float, Link, parseCid, rawCid } from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function closure(): Promise<{ root: string; blocks: Map<string, Uint8Array> }> {
  const a = utf8("a");
  const b = utf8("cc");
  const doc = encodeDrisl({ items: [new Link(parseCid(await rawCid(a))), new Link(parseCid(await rawCid(b)))] });
  const root = await drislCid(doc);
  return { root, blocks: new Map([[root, doc], [await rawCid(a), a], [await rawCid(b), b]]) };
}

describe("DASL CAR", () => {
  it("round-trips a closure: a DRISL header {roots, version: 1}, then 36-byte CIDs and their bytes", async () => {
    const { root, blocks } = await closure();
    const car = encodeCar([root], blocks);
    // header: varint length, then DRISL a2 65 "roots" 81 d8 2a 58 25 00 <36> 67 "version" 01
    const headerLength = car[0] as number;
    const header = car.subarray(1, 1 + headerLength);
    expect(hex(header.subarray(0, 8))).toBe("a26572" + "6f6f7473" + "81");
    expect(hex(header.subarray(header.length - 9))).toBe("6776657273696f6e01");
    expect(decodeDrisl(header)).toEqual({ roots: [new Link(parseCid(root))], version: 1 });
    const back = await decodeCar(car);
    expect(back.roots).toEqual([root]);
    expect(back.bad).toEqual([]);
    expect([...back.blocks.keys()]).toEqual([...blocks.keys()]);
    for (const [cid, bytes] of blocks) expect(back.blocks.get(cid)).toEqual(bytes);
  });

  it("drops a block whose bytes do not hash to its CID, and says so", async () => {
    const good = await rawCid(utf8("good"));
    const lie = await rawCid(utf8("what it claims"));
    const car = encodeCar([good], new Map([[good, utf8("good")], [lie, utf8("not that")]]));
    const back = await decodeCar(car);
    expect([...back.blocks.keys()]).toEqual([good]);
    expect(back.bad).toEqual([lie]);
  });

  it("drops a block named by a CID that is not a DASL CID — dag-pb, CIDv0 — and keeps the rest; a section that opens with no CID at all is a malformed container", async () => {
    const good = await rawCid(utf8("good"));
    const dagPb = CID.create(1, 0x70, await sha256.digest(utf8("node")));
    const v0 = CID.create(0, 0x70, await sha256.digest(utf8("node")));
    expect(dagPb.bytes.length).toBe(36);
    const car = encodeCar([good], new Map([[good, utf8("good")]]));
    const back = await decodeCar(concat(car, section(dagPb.bytes, utf8("node")), section(v0.bytes, utf8("node"))));
    expect([...back.blocks.keys()]).toEqual([good]);
    expect(back.bad).toEqual([`b${base32(dagPb.bytes)}`, `b${base32(v0.bytes)}`]);
    expect(back.bad[0]).toBe(dagPb.toString()); // the spelling multiformats gives the same bytes: a name, not a DASL CID
    await expect(decodeCar(concat(car, section(new Uint8Array(36), utf8(""))))).rejects.toThrow(/CID version/);
  });

  it("refuses a header that is not the CAR header: no roots, a version other than 1, non-DASL roots, non-canonical DRISL, extra members, empty", async () => {
    const good = await rawCid(utf8("x"));
    const block = section(parseCid(good).bytes, utf8("x"));
    const withHeader = (header: Uint8Array) => concat(varint(header.length), header, block);
    await expect(decodeCar(withHeader(encodeDrisl({ version: 1 })))).rejects.toThrow(/Invalid CAR header/);
    await expect(decodeCar(withHeader(encodeDrisl({ roots: [], version: 2 })))).rejects.toThrow(/Invalid CAR header/);
    await expect(decodeCar(withHeader(encodeDrisl({ roots: [good], version: 1 })))).rejects.toThrow(/Invalid CAR header/);
    await expect(decodeCar(withHeader(encodeDrisl([1])))).rejects.toThrow(/Invalid CAR header/);
    await expect(decodeCar(withHeader(encodeDrisl({ note: "hi", roots: [new Link(parseCid(good))], version: 1 })))).rejects.toThrow(/Invalid CAR header/);
    await expect(decodeCar(withHeader(new Uint8Array([0xa2, 0x65, ...utf8("roots"), 0x80, 0x67, ...utf8("version"), 0x18, 0x01])))).rejects.toThrow(/CBOR decode error/);
    await expect(decodeCar(new Uint8Array([0x00]))).rejects.toThrow(/zero length/);
    const dagPb = CID.create(1, 0x70, await sha256.digest(utf8("node")));
    await expect(decodeCar(withHeader(encodeDagCbor({ roots: [dagPb], version: 1 })))).rejects.toThrow(/roots are not DASL CIDs: CID codec 0x70/);
  });

  it("refuses a CARv2 around the same blocks", async () => {
    const cid = await rawCid(utf8("x"));
    const car = encodeCar([cid], new Map([[cid, utf8("x")]]));
    // the pragma, then characteristics, data offset, data size and index offset around the CARv1
    const v2 = new Uint8Array(51 + car.length);
    v2.set([0x0a, 0xa1, 0x67, ...utf8("version"), 0x02]);
    const fields = new DataView(v2.buffer, 11);
    fields.setBigUint64(16, 51n, true);
    fields.setBigUint64(24, BigInt(car.length), true);
    v2.set(car, 51);
    await expect(decodeCar(v2)).rejects.toThrow(/version 2 is not 1/);
  });

  it("refuses a truncated file and a section shorter than the CID it opens with", async () => {
    const { root, blocks } = await closure();
    const car = encodeCar([root], blocks);
    await expect(decodeCar(car.subarray(0, car.length - 1))).rejects.toThrow(/does not hold/);
    const offset = 1 + (car[0] as number);
    expect(car[offset]).toBe(36 + blocks.get(root)!.length);
    const short = new Uint8Array(car);
    short[offset] = 1;
    await expect(decodeCar(short)).rejects.toThrow(/does not hold/);
  });

  it("round-trips many roots, no roots, an empty block, a big section and a view into a larger buffer, and keeps a repeated CID once", async () => {
    const big = new Uint8Array(300_000).fill(7);
    const cid = await rawCid(big);
    const other = await rawCid(utf8("o"));
    const back = await decodeCar(encodeCar([cid, other], new Map([[cid, big], [other, utf8("o")]])));
    expect(back.roots).toEqual([cid, other]);
    expect(back.blocks.get(cid)?.length).toBe(300_000);
    expect(await decodeCar(encodeCar([], new Map()))).toEqual({ roots: [], blocks: new Map(), bad: [] });
    const empty = await rawCid(new Uint8Array(0));
    expect((await decodeCar(encodeCar([empty], new Map([[empty, new Uint8Array(0)]])))).blocks.get(empty)).toEqual(new Uint8Array(0));
    const twice = concat(encodeCar([], new Map([[other, utf8("o")]])), section(parseCid(other).bytes, utf8("o")));
    expect((await decodeCar(twice)).blocks.size).toBe(1);
    const backing = new Uint8Array(twice.length + 13).fill(0xff);
    backing.set(twice, 5);
    expect(await decodeCar(backing.subarray(5, 5 + twice.length))).toEqual(await decodeCar(twice));
  });

  it("reads the container as the library does: a version written as the float 1.0, a length not minimally encoded, header keys out of order", async () => {
    const good = await rawCid(utf8("x"));
    const block = section(parseCid(good).bytes, utf8("x"));
    const withHeader = (header: Uint8Array) => concat(varint(header.length), header, block);
    const float = await decodeCar(withHeader(encodeDrisl({ roots: [], version: new Float(1) })));
    expect([float.roots, [...float.blocks.keys()]]).toEqual([[], [good]]);
    const car = withHeader(encodeDrisl({ roots: [], version: 1 }));
    const overlongHeader = concat(new Uint8Array([(car[0] as number) | 0x80, 0]), car.subarray(1));
    expect([...(await decodeCar(overlongHeader)).blocks.keys()]).toEqual([good]);
    const offset = 1 + (car[0] as number);
    expect(car[offset]).toBe(37);
    const overlongBlock = concat(car.subarray(0, offset), new Uint8Array([37 | 0x80, 0]), car.subarray(offset + 1));
    expect([...(await decodeCar(overlongBlock)).blocks.keys()]).toEqual([good]);
    const unsorted = await decodeCar(withHeader(new Uint8Array([0xa2, 0x67, ...utf8("version"), 0x01, 0x65, ...utf8("roots"), 0x80])));
    expect([...unsorted.blocks.keys()]).toEqual([good]);
  });

  it("reads lengths across the one- and two-byte varint boundaries", async () => {
    for (const size of [127 - 36, 128 - 36, 16383 - 36, 16384 - 36]) {
      const big = new Uint8Array(size).fill(1);
      const c = await rawCid(big);
      const back = await decodeCar(encodeCar([c], new Map([[c, big]])));
      expect(back.blocks.get(c)?.length).toBe(size);
      expect(back.bad).toEqual([]);
    }
  });

  test("encodeCar takes only DASL CIDs", async () => {
    expect(() => encodeCar(["bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354"], new Map())).toThrow(/0x70/);
    expect(() => encodeCar([], new Map([["nope", utf8("x")]]))).toThrow(/base32/);
  });
});

function varint(n: number): Uint8Array {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return new Uint8Array(out);
}

function section(name: Uint8Array, data: Uint8Array): Uint8Array {
  return concat(varint(name.length + data.length), name, data);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
