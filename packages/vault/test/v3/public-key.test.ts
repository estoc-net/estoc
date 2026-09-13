import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { InvalidPublicKey, canonicalPublicKey, decodeBase64Url, decodePublicKey, encodeBase64Url, parsePublicKey, type PublicKey } from "../../src/v3/index.js";

const hex = (s: string) => Uint8Array.from(s.match(/../g) as string[], (b) => parseInt(b, 16));
const multibase = (prefix: string, bytes: Uint8Array) => "z" + bs58.encode(Uint8Array.from([...hex(prefix), ...bytes]));

/** The X25519 fixture: 0x09 then 31 zero bytes. */
const X25519_RAW = hex("09" + "00".repeat(31));
const X25519_CANONICAL = "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis";

/** The P-256 generator, whose y is odd. */
const P256_X = hex("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296");
const P256_Y = hex("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5");

describe("canonicalPublicKey", () => {
  it("encodes the X25519 fixture to its published value from raw bytes, from multibase and from a JWK", () => {
    expect(multibase("ec01", X25519_RAW)).toBe(X25519_CANONICAL);
    expect(canonicalPublicKey(X25519_CANONICAL)).toBe(X25519_CANONICAL);
    expect(canonicalPublicKey({ kty: "OKP", crv: "X25519", x: encodeBase64Url(X25519_RAW), kid: "ignored", use: "enc" })).toBe(X25519_CANONICAL);
    expect(decodePublicKey(X25519_CANONICAL as PublicKey)).toEqual({ type: "X25519", bytes: X25519_RAW });
  });

  it("tags Ed25519 as 0xed, and the same bytes under another type are another key", () => {
    const ed = canonicalPublicKey({ kty: "OKP", crv: "Ed25519", x: encodeBase64Url(X25519_RAW) });
    expect(ed).toBe(multibase("ed01", X25519_RAW));
    expect(ed).not.toBe(X25519_CANONICAL);
    expect(decodePublicKey(ed).type).toBe("Ed25519");
  });

  it("a Weierstrass key is its compressed point, from a JWK or from either multibase form", () => {
    const compressed = Uint8Array.from([0x03, ...P256_X]);
    const canonical = multibase("8024", compressed);
    expect(canonicalPublicKey({ kty: "EC", crv: "P-256", x: encodeBase64Url(P256_X), y: encodeBase64Url(P256_Y) })).toBe(canonical);
    expect(canonicalPublicKey(canonical)).toBe(canonical);
    expect(canonicalPublicKey(multibase("8024", Uint8Array.from([0x04, ...P256_X, ...P256_Y])))).toBe(canonical);
    expect(decodePublicKey(canonical as PublicKey)).toEqual({ type: "P-256", bytes: compressed });
    const evenY = Uint8Array.from(P256_Y);
    evenY[31] = 0x00;
    expect(canonicalPublicKey({ kty: "EC", crv: "P-256", x: encodeBase64Url(P256_X), y: encodeBase64Url(evenY) })).toBe(multibase("8024", Uint8Array.from([0x02, ...P256_X])));
  });

  it("knows the coordinate size and code of each supported curve", () => {
    for (const [crv, code, size] of [
      ["secp256k1", "e701", 32],
      ["P-384", "8124", 48],
      ["P-521", "8224", 66],
    ] as const) {
      const x = new Uint8Array(size).fill(0x11);
      const y = new Uint8Array(size).fill(0x22);
      expect(canonicalPublicKey({ kty: "EC", crv, x: encodeBase64Url(x), y: encodeBase64Url(y) })).toBe(multibase(code, Uint8Array.from([0x02, ...x])));
      expect(() => canonicalPublicKey({ kty: "EC", crv, x: encodeBase64Url(x.subarray(1)), y: encodeBase64Url(y) })).toThrow(InvalidPublicKey);
    }
  });

  it("refuses what is not a supported key in a supported encoding", () => {
    const bad: (string | Record<string, unknown>)[] = [
      "",
      "z",
      "did:key:" + X25519_CANONICAL,
      "f" + X25519_CANONICAL.slice(1),
      "z0" + X25519_CANONICAL.slice(1),
      multibase("0001", X25519_RAW),
      multibase("ec8100", X25519_RAW),
      multibase("ec01", X25519_RAW.subarray(1)),
      multibase("ec01", Uint8Array.from([...X25519_RAW, 0])),
      multibase("8024", Uint8Array.from([0x05, ...P256_X])),
      multibase("8024", Uint8Array.from([0x04, ...P256_X])),
      multibase("8024", P256_X),
      { kty: "OKP", crv: "X25519", x: encodeBase64Url(X25519_RAW) + "=" },
      { kty: "OKP", crv: "X25519", x: encodeBase64Url(X25519_RAW), y: encodeBase64Url(X25519_RAW) },
      { kty: "OKP", crv: "X25519", x: encodeBase64Url(X25519_RAW.subarray(1)) },
      { kty: "OKP", crv: "secp256k1", x: encodeBase64Url(X25519_RAW) },
      { kty: "EC", crv: "P-256", x: encodeBase64Url(P256_X) },
      { kty: "EC", crv: "P-256", x: encodeBase64Url(P256_X), y: 5 },
      { kty: "RSA", n: "AQAB", e: "AQAB" },
      { crv: "X25519", x: encodeBase64Url(X25519_RAW) },
    ];
    for (const value of bad) expect(() => canonicalPublicKey(value), JSON.stringify(value)).toThrow(InvalidPublicKey);
  });
});

describe("parsePublicKey", () => {
  it("accepts exactly the canonical form", () => {
    expect(parsePublicKey(X25519_CANONICAL)).toBe(X25519_CANONICAL);
    expect(() => parsePublicKey(multibase("8024", Uint8Array.from([0x04, ...P256_X, ...P256_Y])))).toThrow(InvalidPublicKey);
    expect(() => parsePublicKey("did:key:" + X25519_CANONICAL)).toThrow(InvalidPublicKey);
  });
});

describe("base64url", () => {
  it("round-trips every length and refuses padding, non-alphabet characters and non-zero trailing bits", () => {
    for (let n = 0; n <= 8; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 250) & 0xff);
      const text = encodeBase64Url(bytes);
      expect(text).toBe(Buffer.from(bytes).toString("base64url"));
      expect(decodeBase64Url(text)).toEqual(bytes);
    }
    expect(decodeBase64Url("")).toEqual(new Uint8Array(0));
    for (const bad of ["AQ==", "AQ=", "A", "AB+/", "AR", "AAB", "A A"]) expect(decodeBase64Url(bad), bad).toBeNull();
  });
});
