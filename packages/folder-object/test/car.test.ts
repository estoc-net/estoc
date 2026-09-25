import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base32 } from "multiformats/bases/base32";
import { blobHash, decodeCar, encodeCar, fileCid, hashTree, isBlobHash } from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("CAR", () => {
  it("round-trips a tree's closure, roots first", async () => {
    const files = { "index.json": utf8('{"format":"x"}'), "files/a.txt": utf8("a"), "files/b/c.txt": utf8("cc") };
    const hashed = await hashTree(files);
    const blocks = new Map(hashed.nodes);
    for (const [cid, path] of hashed.files) blocks.set(cid, files[path as keyof typeof files]);
    const car = encodeCar([hashed.root], blocks);
    // header: varint length, then dag-cbor {roots:[…], version:1}
    expect(car[1]).toBe(0xa2);
    expect(new TextDecoder().decode(car.subarray(3, 8))).toBe("roots");
    const back = await decodeCar(car);
    expect(back.roots).toEqual([hashed.root]);
    expect(back.bad).toEqual([]);
    expect([...back.blocks.keys()]).toEqual([...blocks.keys()]);
    for (const [cid, bytes] of blocks) expect(back.blocks.get(cid)).toEqual(bytes);
  });

  it("drops a block whose bytes do not hash to its CID, and says so", async () => {
    const good = await fileCid(utf8("good"));
    const lie = await fileCid(utf8("what it claims"));
    const car = encodeCar([good], new Map([[good, utf8("good")], [lie, utf8("not that")]]));
    const back = await decodeCar(car);
    expect([...back.blocks.keys()]).toEqual([good]);
    expect(back.bad).toEqual([lie]);
  });

  it("refuses a truncated file and a wrong version", async () => {
    const cid = await fileCid(utf8("x"));
    const car = encodeCar([cid], new Map([[cid, utf8("x")]]));
    await expect(decodeCar(car.subarray(0, car.length - 1))).rejects.toThrow(/does not hold/);
    const tampered = new Uint8Array(car);
    tampered[car[0] as number] = 0x02; // the header's last byte: its version
    await expect(decodeCar(tampered)).rejects.toThrow(/Invalid CAR header/);

    // CARv2: the pragma, then characteristics, data offset, data size and index offset around the same CARv1
    const v2 = new Uint8Array(51 + car.length);
    v2.set([0x0a, 0xa1, 0x67, ...utf8("version"), 0x02]);
    const fields = new DataView(v2.buffer, 11);
    fields.setBigUint64(16, 51n, true);
    fields.setBigUint64(24, BigInt(car.length), true);
    v2.set(car, 51);
    await expect(decodeCar(v2)).rejects.toThrow(/version 2/);
  });

  it("refuses a section too short for the CID it opens with", async () => {
    const empty = await fileCid(new Uint8Array(0));
    const next = await fileCid(utf8("next"));
    const car = encodeCar([empty], new Map([[empty, new Uint8Array(0)], [next, utf8("next")]]));
    const header = 1 + (car[0] as number);
    expect(car[header]).toBe(36);
    const short = new Uint8Array(car);
    short[header] = 1;
    await expect(decodeCar(short)).rejects.toThrow(/does not hold/);
  });

  it("reads an empty block, no blocks at all, and a view into a larger buffer", async () => {
    const empty = await fileCid(new Uint8Array(0));
    const car = encodeCar([empty], new Map([[empty, new Uint8Array(0)]]));
    expect((await decodeCar(car)).blocks.get(empty)).toEqual(new Uint8Array(0));
    expect(await decodeCar(encodeCar([], new Map()))).toEqual({ roots: [], blocks: new Map(), bad: [] });

    const backing = new Uint8Array(car.length + 13).fill(0xff);
    backing.set(car, 5);
    expect(await decodeCar(backing.subarray(5, 5 + car.length))).toEqual(await decodeCar(car));
  });

  it("round-trips many roots and a big section", async () => {
    const big = new Uint8Array(300_000).fill(7);
    const cid = await fileCid(big);
    const other = await fileCid(utf8("o"));
    const back = await decodeCar(encodeCar([cid, other], new Map([[cid, big], [other, utf8("o")]])));
    expect(back.roots).toEqual([cid, other]);
    expect(back.blocks.get(cid)?.length).toBe(300_000);
  });
});

describe("blob names", () => {
  it("is the sha-256 multihash in base32 lower", async () => {
    const bytes = utf8("hello");
    const digest = createHash("sha256").update(bytes).digest();
    const expected = base32.encode(new Uint8Array([0x12, 0x20, ...digest]));
    expect(await blobHash(bytes)).toBe(expected);
    expect(expected).toMatch(/^b[a-z2-7]{55}$/);
    expect(isBlobHash(expected)).toBe(true);
    expect(isBlobHash("bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy")).toBe(false);
  });
});
