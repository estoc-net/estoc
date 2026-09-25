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

  it("hands back a record whose one key reads as a tag as the record it was, at any depth and beside real bytes and maps", () => {
    const lookalikes = [{ $bytes: "aGVsbG8=" }, { $bytes: "not base64!" }, { $bytes: 7 }, { $map: [["topic", "hello"]] }, { $map: "no list" }, { $$bytes: "aGVsbG8=" }, { $: null }, { $other: { $bytes: "aGVsbG8=" } }];
    for (const body of lookalikes) {
      const back = decode(encode(body));
      expect(back).toEqual(body);
      expect(back).not.toBeInstanceOf(Uint8Array);
      expect(back).not.toBeInstanceOf(Map);
    }
    const bytes = new Uint8Array([1, 2, 3]);
    const value = { body: { $bytes: "aGVsbG8=" }, attachments: [{ data: { json: { $map: [[{ $bytes: "AQID" }, bytes]] } } }], kept: new Map<string, unknown>([["$bytes", { $map: [] }]]), bytes };
    expect(decode(encode(value))).toEqual(value);
  });

  it("refuses text whose tag is none of its own or holds what that tag does not", () => {
    for (const text of ['{"$bytes":"not base64!"}', '{"$bytes":7}', '{"$map":[["k"]]}', '{"$map":"no list"}', '{"$other":1}', "not json"]) {
      expect(() => decode(text)).toThrow();
    }
  });

  it("round-trips a large byte array", () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    expect(decode(encode({ big }))).toEqual({ big });
  });
});
