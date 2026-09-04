import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { decodeCar, decodeDrisl, drislCid, encodeCar, encodeDrisl, Link, parseCid, rawCid } from "../src/index.js";

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

  it("drops a block named by something that is not a DASL CID — dag-pb, CIDv0 — and keeps the rest", async () => {
    const good = await rawCid(utf8("good"));
    const dagPb = CID.create(1, 0x70, await sha256.digest(utf8("node")));
    const v0 = CID.create(0, 0x70, await sha256.digest(utf8("node")));
    expect(dagPb.bytes.length).toBe(36);
    const car = encodeCar([good], new Map([[good, utf8("good")]]));
    const withOthers = concat(car, section(dagPb.bytes, utf8("node")), section(v0.bytes, utf8("node")), section(new Uint8Array(36), utf8("")));
    const back = await decodeCar(withOthers);
    expect([...back.blocks.keys()]).toEqual([good]);
    expect(back.bad.length).toBe(3);
    expect(back.bad[0]).toBe(`b${base32(dagPb.bytes)}`);
    expect(back.bad[0]).toBe(dagPb.toString()); // the spelling multiformats gives the same bytes: a name, not a DASL CID
  });

  it("refuses a header that is not the CAR header: no roots, a version other than 1, non-DASL roots, non-canonical DRISL, empty", async () => {
    const good = await rawCid(utf8("x"));
    const block = section(parseCid(good).bytes, utf8("x"));
    const withHeader = (header: Uint8Array) => concat(varint(header.length), header, block);
    await expect(decodeCar(withHeader(encodeDrisl({ version: 1 })))).rejects.toThrow(/roots are not CIDs/);
    await expect(decodeCar(withHeader(encodeDrisl({ roots: [], version: 2 })))).rejects.toThrow(/version 2/);
    await expect(decodeCar(withHeader(encodeDrisl({ roots: [good], version: 1 })))).rejects.toThrow(/roots are not CIDs/);
    await expect(decodeCar(withHeader(encodeDrisl([1])))).rejects.toThrow(/not a map/);
    await expect(decodeCar(withHeader(new Uint8Array([0xa2, 0x65, ...utf8("roots"), 0x80, 0x67, ...utf8("version"), 0x18, 0x01])))).rejects.toThrow(/not DRISL/);
    await expect(decodeCar(new Uint8Array([0x00]))).rejects.toThrow(/empty/);
    // a header with extra metadata members is still a CAR header
    const extra = await decodeCar(withHeader(encodeDrisl({ note: "hi", roots: [new Link(parseCid(good))], version: 1 })));
    expect(extra.roots).toEqual([good]);
    expect(extra.blocks.size).toBe(1);
  });

  it("refuses a truncated file and a section shorter than a CID", async () => {
    const { root, blocks } = await closure();
    const car = encodeCar([root], blocks);
    await expect(decodeCar(car.subarray(0, car.length - 1))).rejects.toThrow(/truncated/);
    const short = concat(car, varint(10), new Uint8Array(10));
    await expect(decodeCar(short)).rejects.toThrow(/shorter than a CID/);
  });

  it("many roots, an empty roots array, big sections; a repeated CID is kept once", async () => {
    const big = new Uint8Array(300_000).fill(7);
    const cid = await rawCid(big);
    const other = await rawCid(utf8("o"));
    const back = await decodeCar(encodeCar([cid, other], new Map([[cid, big], [other, utf8("o")]])));
    expect(back.roots).toEqual([cid, other]);
    expect(back.blocks.get(cid)?.length).toBe(300_000);
    const none = await decodeCar(encodeCar([], new Map()));
    expect(none.roots).toEqual([]);
    expect(none.blocks.size).toBe(0);
    const twice = concat(encodeCar([], new Map([[other, utf8("o")]])), section(parseCid(other).bytes, utf8("o")));
    expect((await decodeCar(twice)).blocks.size).toBe(1);
  });

  it("encodeCar takes only DASL CIDs", async () => {
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
