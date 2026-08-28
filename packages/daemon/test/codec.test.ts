import { describe, expect, it } from "vitest";

import { decode, encode } from "../src/index.js";

describe("codec", () => {
  it("round-trips records, bytes and maps", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const value = {
      kind: "call",
      args: [{ did: "did:peer:4z", n: 3, nested: { bytes } }, new Map([["a", bytes], ["b", new Uint8Array()]])],
      nothing: null,
    };
    const back = decode(encode(value)) as typeof value;
    expect(back.kind).toBe("call");
    expect(back.nothing).toBeNull();
    expect((back.args[0] as { nested: { bytes: Uint8Array } }).nested.bytes).toEqual(bytes);
    const map = back.args[1] as Map<string, Uint8Array>;
    expect(map).toBeInstanceOf(Map);
    expect(map.get("a")).toEqual(bytes);
    expect(map.get("b")).toEqual(new Uint8Array());
  });

  it("leaves ordinary objects with those keys alone when they carry more", () => {
    const value = { $bytes: "x", other: 1 };
    expect(decode(encode(value))).toEqual(value);
  });

  it("handles big byte arrays", () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    expect(decode(encode({ big }))).toEqual({ big });
  });
});
