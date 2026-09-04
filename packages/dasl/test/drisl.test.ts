import { describe, expect, it } from "vitest";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { decodeDrisl, encodeDrisl, Link, parseCid, MAX_DEPTH } from "../src/index.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const RAW = "bafkreihh7o3pxp2m4kkjcpvwfnj76a5hkrtett64bwbe3hr2fncucubpp4";

describe("DRISL encode — RFC 8949 Appendix A vectors that DRISL keeps", () => {
  const vectors: [unknown, string][] = [
    [0, "00"], [1, "01"], [10, "0a"], [23, "17"], [24, "1818"], [25, "1819"], [100, "1864"],
    [1000, "1903e8"], [1000000, "1a000f4240"], [1000000000000, "1b000000e8d4a51000"],
    [18446744073709551615n, "1bffffffffffffffff"], [-1, "20"], [-10, "29"], [-100, "3863"], [-1000, "3903e7"],
    [-18446744073709551616n, "3bffffffffffffffff"],
    [false, "f4"], [true, "f5"], [null, "f6"],
    [1.1, "fb3ff199999999999a"], [1.0e300, "fb7e37e43c8800759c"], [-4.1, "fbc010666666666666"],
    ["", "60"], ["a", "6161"], ["IETF", "6449455446"], ['"\\', "62225c"], ["ü", "62c3bc"], ["水", "63e6b0b4"], ["𐅑", "64f0908591"],
    [new Uint8Array(0), "40"], [new Uint8Array([1, 2, 3, 4]), "4401020304"],
    [[], "80"], [[1, 2, 3], "83010203"], [[1, [2, 3], [4, 5]], "8301820203820405"],
    [Array.from({ length: 25 }, (_, i) => i + 1), "98190102030405060708090a0b0c0d0e0f101112131415161718181819"],
    [{}, "a0"], [{ a: 1, b: [2, 3] }, "a26161016162820203"],
    [{ a: "A", b: "B", c: "C", d: "D", e: "E" }, "a56161614161626142616361436164614461656145"],
    [["a", { b: "c" }], "826161a161626163"],
  ];
  for (const [value, expected] of vectors) {
    it(`${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v))} → ${expected}`, () => {
      expect(hex(encodeDrisl(value as never))).toBe(expected);
      const back = decodeDrisl(bytes(expected));
      expect(back).toEqual(value);
    });
  }

  it("floats that RFC 8949 would shorten stay 64-bit (1.5 is fb…, never f93e00)", () => {
    expect(hex(encodeDrisl(1.5))).toBe("fb3ff8000000000000");
    expect(hex(encodeDrisl(100000.0))).toBe("1a000186a0"); // integral numbers are integers
  });

  it("map keys sort by the bytewise order of their encoding: shorter keys first, then bytes", () => {
    expect(hex(encodeDrisl({ aa: 1, b: 2 }))).toBe("a2616202626161" + "01");
    expect(hex(encodeDrisl({ b: 1, a: 2 }))).toBe("a2616102616201");
    // a 24-byte key gets a two-byte head (0x78 0x18) and sorts after every one-byte-head key
    const long = "x".repeat(24);
    const short = "z".repeat(23);
    expect(hex(encodeDrisl({ [long]: 1, [short]: 2 })).startsWith("a2" + "77" + hex(new TextEncoder().encode(short)) + "02" + "7818")).toBe(true);
    // non-ASCII: byte order of UTF-8, not code-unit order
    expect(hex(encodeDrisl({ "𐅑": 1, "水": 2 }))).toBe("a263e6b0b40264f090859101");
  });

  it("a CID is tag 42 over 0x00 ‖ the 36 CID bytes", () => {
    const cid = parseCid(RAW);
    expect(hex(encodeDrisl(new Link(cid)))).toBe("d82a5825" + "00" + hex(cid.bytes));
    const back = decodeDrisl(encodeDrisl({ src: new Link(cid) })) as { src: Link };
    expect(back.src).toBeInstanceOf(Link);
    expect(back.src.toString()).toBe(RAW);
  });

  it("refuses what it cannot encode", () => {
    expect(() => encodeDrisl(Number.NaN)).toThrow(/NaN/);
    expect(() => encodeDrisl(Number.POSITIVE_INFINITY)).toThrow(/infinity/);
    expect(hex(encodeDrisl(2 ** 53))).toBe("fb4340000000000000"); // past 2^53 a number is a float, as cborg encodes it
    expect(() => encodeDrisl(1n << 64n)).toThrow(/64 bits/);
    expect(() => encodeDrisl("\ud800")).toThrow(/surrogate/);
    expect(() => encodeDrisl(undefined as never)).toThrow(/cannot encode/);
    const deep: unknown[] = [];
    let cursor = deep;
    for (let i = 0; i < MAX_DEPTH + 1; i++) {
      const next: unknown[] = [];
      cursor.push(next);
      cursor = next;
    }
    expect(() => encodeDrisl(deep as never)).toThrow(/deeper/);
  });
});

describe("DRISL decode — strict: exactly one byte string per value", () => {
  const rejected: [string, string, RegExp][] = [
    ["non-shortest int 5 as 18 05", "1805", /shortest/],
    ["non-shortest int 255 as 19 00ff", "1900ff", /shortest/],
    ["non-shortest length", "7801" + "61", /shortest/],
    ["half-precision float", "f93e00", /64-bit/],
    ["single-precision float", "fa3fc00000", /64-bit/],
    ["NaN", "fb7ff8000000000000", /NaN/],
    ["infinity", "fb7ff0000000000000", /NaN|infinity/],
    ["negative zero", "fb8000000000000000", /negative zero/],
    ["undefined (simple 23)", "f7", /simple value 23/],
    ["one-byte simple value", "f818", /one-byte simple/],
    ["indefinite array", "9f01ff", /indefinite/],
    ["indefinite bytes", "5f4101ff", /indefinite/],
    ["indefinite text", "7f6161ff", /indefinite/],
    ["indefinite map", "bf616101ff", /indefinite/],
    ["break alone", "ff", /indefinite/],
    ["reserved additional info 28", "1c", /reserved/],
    ["integer map key", "a1010a", /not a text string/],
    ["duplicate keys", "a2616101616102", /ascending/],
    ["keys out of byte order", "a2616202616101", /ascending/],
    ["keys out of length order", "a262616101616102", /ascending/],
    ["tag 1", "c11a514b67b0", /tag 1 /],
    ["tag 42 over text", "d82a6161", /not a byte string/],
    ["tag 42 without the 0x00 prefix", "d82a5824" + "01551220" + "00".repeat(32), /0x00/],
    ["tag 42 with a 35-byte CID", "d82a5824" + "00" + "01551220" + "00".repeat(31), /36 bytes/],
    ["tag 42 with a dag-pb CID", "d82a5825" + "00" + "01701220" + "00".repeat(32), /codec 0x70/],
    ["tag 42 with a sha-512 CID", "d82a5825" + "00" + "01551320" + "00".repeat(32), /sha-256/],
    ["trailing bytes", "0100", /trailing/],
    ["truncated int", "1a0001", /truncated/],
    ["truncated text", "6261", /truncated/],
    ["array longer than the input", "9b0000000100000000", /longer than the input|truncated/],
    ["map longer than the input", "b90100" + "616101", /longer than the input|truncated/],
    ["invalid UTF-8 text", "61ff", /UTF-8/],
    ["invalid UTF-8 key", "a161ff01", /UTF-8/],
    ["CESU-encoded surrogate in text", "63eda080", /UTF-8/],
    ["nesting past the limit", "81".repeat(MAX_DEPTH + 1) + "80", /deeper/],
    ["empty input", "", /truncated/],
  ];
  for (const [name, input, pattern] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => decodeDrisl(bytes(input))).toThrow(pattern);
    });
  }

  it("accepts nesting at the limit", () => {
    expect(decodeDrisl(bytes("81".repeat(MAX_DEPTH) + "80"))).toBeTruthy();
  });

  it("integers beyond 2^53 come back as bigint, within it as number", () => {
    expect(decodeDrisl(bytes("1b0020000000000000"))).toBe(2n ** 53n);
    expect(decodeDrisl(bytes("1b001fffffffffffff"))).toBe(Number.MAX_SAFE_INTEGER);
    expect(decodeDrisl(bytes("3b001fffffffffffff"))).toBe(-(2n ** 53n));
    expect(decodeDrisl(bytes("3b001ffffffffffffe"))).toBe(Number.MIN_SAFE_INTEGER);
  });
});

describe("DRISL agrees with @ipld/dag-cbor (cborg) on the values a manifest is made of", () => {
  const cid = CID.parse(RAW);
  const samples: [unknown, unknown][] = [
    [{ resources: { "/index.json": { src: new Link(parseCid(RAW)), size: 272 } } }, { resources: { "/index.json": { src: cid, size: 272 } } }],
    [{ b: [1, "two", new Uint8Array([3])], a: { z: null, y: true, xx: false } }, { b: [1, "two", new Uint8Array([3])], a: { z: null, y: true, xx: false } }],
    [[0, -1, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, 1.5, -0.25], [0, -1, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, 1.5, -0.25]],
    [{ "水": "𐅑", "aa": "", "b": "ü" }, { "水": "𐅑", "aa": "", "b": "ü" }],
  ];
  for (const [ours, theirs] of samples) {
    it(`byte-identical: ${JSON.stringify(theirs).slice(0, 60)}`, () => {
      const a = encodeDrisl(ours as never);
      const b = dagCbor.encode(theirs);
      expect(hex(a)).toBe(hex(b));
      // and each decodes the other's bytes
      expect(() => decodeDrisl(b)).not.toThrow();
      expect(() => dagCbor.decode(a)).not.toThrow();
    });
  }
});

describe("DRISL agrees with @atcute/cbor (the AT Protocol's DASL codec)", () => {
  it("byte-identical manifest, and each decodes the other's bytes", async () => {
    const atcute = await import("@atcute/cbor");
    const atcid = await import("@atcute/cid");
    const ours = encodeDrisl({ resources: { "/index.json": { src: new Link(parseCid(RAW)), size: 272 }, "/files/a.png": { src: new Link(parseCid(RAW)), size: 5 } } });
    const link = atcid.toCidLink(atcid.fromString(RAW));
    const theirs = atcute.encode({ resources: { "/index.json": { src: link, size: 272 }, "/files/a.png": { src: link, size: 5 } } });
    expect(hex(theirs)).toBe(hex(ours));
    const back = atcute.decode(ours) as { resources: Record<string, { src: unknown; size: number }> };
    expect(back.resources["/files/a.png"]?.size).toBe(5);
    expect(atcid.toString(atcid.fromCidLink(back.resources["/files/a.png"]!.src as never))).toBe(RAW);
    expect(decodeDrisl(theirs)).toEqual(decodeDrisl(ours));
  });
});

describe("DRISL maps have no prototype", () => {
  it("a __proto__ key is a plain own property, round-trips, and pollutes nothing", () => {
    const doc = decodeDrisl(bytes("a1" + "69" + hex(new TextEncoder().encode("__proto__")) + "a1" + "61" + "61" + "01"));
    expect(Object.getPrototypeOf(doc)).toBeNull();
    expect(Object.keys(doc as object)).toEqual(["__proto__"]);
    expect(({} as { a?: number }).a).toBeUndefined();
    expect(hex(encodeDrisl(doc))).toBe("a1" + "69" + hex(new TextEncoder().encode("__proto__")) + "a1" + "61" + "61" + "01");
    const own = Object.defineProperty({}, "__proto__", { value: { a: 1 }, enumerable: true }) as never;
    expect(hex(encodeDrisl(own))).toBe(hex(encodeDrisl(doc)));
  });

  it("constructor and hasOwnProperty are keys like any other", () => {
    const doc = decodeDrisl(encodeDrisl({ constructor: 1, hasOwnProperty: 2 })) as { [key: string]: unknown };
    expect(doc["constructor"]).toBe(1);
    expect(doc["hasOwnProperty"]).toBe(2);
    expect("toString" in doc).toBe(false);
  });
});
