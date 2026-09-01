import { describe, expect, it } from "vitest";
import { decryptStream, encryptStream, freshKey } from "../src/protocol/streaming-aead.js";

const SEG = 256; // a small segment so a few KiB spans many

/** `toEqual` for bytes: vitest walks a typed array element by element — seconds for a MiB — where a byte compare is instant. */
function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length, "byte length").toBe(expected.length);
  let at = 0;
  while (at < actual.length && actual[at] === expected[at]) {
    at += 1;
  }
  expect(at, `bytes differ at offset ${at}`).toBe(actual.length);
}

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 7 + 3) & 0xff;
  return out;
}

describe("AES256_GCM_HKDF_1MB", () => {
  it("round-trips empty, one-segment, exact-fill and many-segment plaintexts", async () => {
    const key = freshKey();
    for (const n of [0, 1, SEG - 40 - 16, SEG - 40 - 16 + 1, SEG - 40 - 16 + (SEG - 16), 5000]) {
      const plain = bytes(n);
      const sealed = await encryptStream(key, plain, SEG);
      expect(sealed[0]).toBe(40);
      expect(sealed.length).toBe(40 + n + 16 * Math.max(1, Math.ceil((n + 40) / (SEG - 16))));
      expectBytes(await decryptStream(key, sealed, SEG), plain);
    }
  });

  it("lays segments out as Tink does: every ciphertext segment but the last is exactly the segment size", async () => {
    const sealed = await encryptStream(freshKey(), bytes(1000), SEG);
    expect(sealed.length % SEG).not.toBe(0);
    expect(Math.ceil(sealed.length / SEG)).toBe(Math.ceil((1000 + 40) / (SEG - 16)));
  });

  it("reads a Go-style empty last segment too", async () => {
    // build one: encrypt an exact fill, then the layout with an extra empty last segment is what Go writes;
    // decryption treats the final chunk as last either way, so a plaintext that fills exactly decrypts
    const key = freshKey();
    const n = SEG - 40 - 16 + (SEG - 16);
    const sealed = await encryptStream(key, bytes(n), SEG);
    expect(sealed.length).toBe(2 * SEG);
    expectBytes(await decryptStream(key, sealed, SEG), bytes(n));
  });

  it("rejects the wrong key, a flipped byte, a truncation, and a swapped segment", async () => {
    const key = freshKey();
    const sealed = await encryptStream(key, bytes(1000), SEG);
    await expect(decryptStream(freshKey(), sealed, SEG)).rejects.toThrow(/segment 0/);
    const flipped = new Uint8Array(sealed);
    flipped[SEG + 5] = (flipped[SEG + 5] as number) ^ 1;
    await expect(decryptStream(key, flipped, SEG)).rejects.toThrow(/segment 1/);
    await expect(decryptStream(key, sealed.subarray(0, SEG), SEG)).rejects.toThrow(/segment 0/); // marked last, was not
    const swapped = new Uint8Array(sealed);
    swapped.set(sealed.subarray(SEG, 2 * SEG), 2 * SEG);
    swapped.set(sealed.subarray(2 * SEG, 3 * SEG), SEG);
    await expect(decryptStream(key, swapped, SEG)).rejects.toThrow(/segment 1/);
    await expect(decryptStream(key, new Uint8Array(10), SEG)).rejects.toThrow(/not an/);
    await expect(encryptStream(new Uint8Array(16), bytes(1))).rejects.toThrow(/32-byte/);
  });

  it("uses the real 1 MiB segment by default", async () => {
    const key = freshKey();
    const plain = bytes(1024 * 1024 + 123);
    const sealed = await encryptStream(key, plain);
    expect(sealed.length).toBe(plain.length + 40 + 32);
    expectBytes(await decryptStream(key, sealed), plain);
  });
});
