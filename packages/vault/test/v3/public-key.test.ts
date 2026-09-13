import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import { InvalidPublicKey, canonicalPublicKey, decodePublicKey, parsePublicKey, type PublicKey } from "../../src/v3/index.js";

const hex = (s: string) => Uint8Array.from(s.match(/../g) as string[], (b) => parseInt(b, 16));
const multibase = (prefix: string, bytes: Uint8Array) => "z" + base58.encode(Uint8Array.from([...hex(prefix), ...bytes]));
const b64 = (bytes: Uint8Array) => base64urlnopad.encode(bytes);

/** The X25519 fixture: 0x09 then 31 zero bytes. */
const X25519_RAW = hex("09" + "00".repeat(31));
const X25519_CANONICAL = "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis";

/** Each Weierstrass curve's generator G and its triple 3G; across them y is odd and even. */
const CURVES = [
  {
    crv: "P-256",
    code: "8024",
    g: { x: "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", y: "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" },
    g3: { x: "5ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c", y: "8734640c4998ff7e374b06ce1a64a2ecd82ab036384fb83d9a79b127a27d5032" },
  },
  {
    crv: "secp256k1",
    code: "e701",
    g: { x: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", y: "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8" },
    g3: { x: "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9", y: "388f7b0f632de8140fe337e62a37f3566500a99934c2231b6cb9fd7584b8e672" },
  },
  {
    crv: "P-384",
    code: "8124",
    g: {
      x: "aa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7",
      y: "3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f",
    },
    g3: {
      x: "077a41d4606ffa1464793c7e5fdc7d98cb9d3910202dcd06bea4f240d3566da6b408bbae5026580d02d7e5c70500c831",
      y: "c995f7ca0b0c42837d0bbe9602a9fc998520b41c85115aa5f7684c0edc111eacc24abd6be4b5d298b65f28600a2f1df1",
    },
  },
  {
    crv: "P-521",
    code: "8224",
    g: {
      x: "00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66",
      y: "011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650",
    },
    g3: {
      x: "01a73d352443de29195dd91d6a64b5959479b52a6e5b123d9ab9e5ad7a112d7a8dd1ad3f164a3a4832051da6bd16b59fe21baeb490862c32ea05a5919d2ede37ad7d",
      y: "013e9b03b97dfa62ddd9979f86c6cab814f2f1557fa82a9d0317d2f8ab1fa355ceec2e2dd4cf8dc575b02d5aced1dec3c70cf105c9bc93a590425f588ca1ee86c0e5",
    },
  },
] as const;

const P256 = CURVES[0];
const P256_X = hex(P256.g.x);
const P256_Y = hex(P256.g.y);

function compressed(point: { x: string; y: string }): Uint8Array {
  const y = hex(point.y);
  return Uint8Array.from([0x02 | ((y[y.length - 1] as number) & 1), ...hex(point.x)]);
}

describe("canonicalPublicKey", () => {
  it("encodes the X25519 fixture to its published value from raw bytes, from multibase and from a JWK", () => {
    expect(multibase("ec01", X25519_RAW)).toBe(X25519_CANONICAL);
    expect(canonicalPublicKey(X25519_CANONICAL)).toBe(X25519_CANONICAL);
    expect(canonicalPublicKey({ kty: "OKP", crv: "X25519", x: b64(X25519_RAW), kid: "ignored", use: "enc" })).toBe(X25519_CANONICAL);
    expect(decodePublicKey(X25519_CANONICAL as PublicKey)).toEqual({ type: "X25519", bytes: X25519_RAW });
  });

  it("tags Ed25519 as 0xed, and the same bytes under another type are another key", () => {
    const ed = canonicalPublicKey({ kty: "OKP", crv: "Ed25519", x: b64(X25519_RAW) });
    expect(ed).toBe(multibase("ed01", X25519_RAW));
    expect(ed).not.toBe(X25519_CANONICAL);
    expect(decodePublicKey(ed).type).toBe("Ed25519");
  });

  for (const curve of CURVES) {
    it(`${curve.crv}: a point is its compressed form, from a JWK or from either multibase encoding`, () => {
      for (const point of [curve.g, curve.g3]) {
        const canonical = multibase(curve.code, compressed(point));
        expect(canonicalPublicKey({ kty: "EC", crv: curve.crv, x: b64(hex(point.x)), y: b64(hex(point.y)) })).toBe(canonical);
        expect(canonicalPublicKey(canonical)).toBe(canonical);
        expect(canonicalPublicKey(multibase(curve.code, Uint8Array.from([0x04, ...hex(point.x), ...hex(point.y)])))).toBe(canonical);
        expect(decodePublicKey(canonical as PublicKey)).toEqual({ type: curve.crv, bytes: compressed(point) });
      }
    });

    it(`${curve.crv}: refuses a point off the curve, however it is encoded`, () => {
      const x = hex(curve.g.x);
      const y = hex(curve.g.y);
      const offCurve = Uint8Array.from(y);
      offCurve[0] = (offCurve[0] as number) ^ 0x10;
      const outOfField = new Uint8Array(x.length).fill(0xff);
      const noPoint = new Uint8Array(x.length);
      noPoint[x.length - 1] = curve.crv === "P-521" ? 3 : curve.crv === "secp256k1" ? 0 : 1;
      const bad: (string | Record<string, unknown>)[] = [
        { kty: "EC", crv: curve.crv, x: b64(x), y: b64(offCurve) },
        { kty: "EC", crv: curve.crv, x: b64(outOfField), y: b64(y) },
        { kty: "EC", crv: curve.crv, x: b64(x.subarray(1)), y: b64(y) },
        { kty: "EC", crv: curve.crv, x: b64(x) },
        multibase(curve.code, Uint8Array.from([0x04, ...x, ...offCurve])),
        multibase(curve.code, Uint8Array.from([0x02, ...outOfField])),
        multibase(curve.code, Uint8Array.from([0x02, ...noPoint])),
        multibase(curve.code, Uint8Array.from([0x06, ...x, ...y])),
        multibase(curve.code, Uint8Array.from([0x04, ...x, ...y, 0])),
        multibase(curve.code, Uint8Array.from([0x04, ...x])),
        multibase(curve.code, x),
      ];
      for (const value of bad) expect(() => canonicalPublicKey(value), JSON.stringify(value)).toThrow(InvalidPublicKey);
    });
  }

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
      { kty: "OKP", crv: "X25519", x: b64(X25519_RAW) + "=" },
      { kty: "OKP", crv: "X25519", x: b64(X25519_RAW).replace(/A$/, "B") },
      { kty: "OKP", crv: "X25519", x: b64(X25519_RAW), y: b64(X25519_RAW) },
      { kty: "OKP", crv: "X25519", x: b64(X25519_RAW.subarray(1)) },
      { kty: "OKP", crv: "secp256k1", x: b64(X25519_RAW) },
      { kty: "EC", crv: "P-256", x: b64(P256_X), y: 5 },
      { kty: "EC", crv: "Ed25519", x: b64(X25519_RAW), y: b64(X25519_RAW) },
      { kty: "RSA", n: "AQAB", e: "AQAB" },
      { crv: "X25519", x: b64(X25519_RAW) },
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
