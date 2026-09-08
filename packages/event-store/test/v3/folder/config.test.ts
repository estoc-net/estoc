import { describe, expect, it } from "vitest";

import { ANCHOR_KEY, FORMAT, NotAVault, VERSION, checkKeystore, encodeConfig, parseConfig, text, utf8 } from "../../../src/v3/index.js";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const JWE = "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwicDJjIjoyMjAwMDAsInAycyI6IkFCQ0QifQ.QUJDRA.QUJDRA.QUJDRA.QUJDRA";

describe("config.json", () => {
  it("writes the file pretty-printed with LF, the members in a fixed order, and reads it back", () => {
    const bytes = encodeConfig(DID);
    expect(text(bytes)).toBe(`{\n  "format": "${FORMAT}",\n  "version": ${VERSION},\n  "identity": {\n    "anchor": {\n      "key": "${ANCHOR_KEY}",\n      "did": "${DID}"\n    }\n  }\n}\n`);
    expect(parseConfig(bytes)).toEqual({ format: "estoc", version: 3, identity: { anchor: { key: "anchor", did: DID } } });
    // any spelling of the same JSON reads the same: the file is JSON, not canonical bytes
    expect(parseConfig(utf8(JSON.stringify({ identity: { anchor: { did: DID, key: "anchor" } }, version: 3, format: "estoc" })))).toEqual(parseConfig(bytes));
  });

  it("refuses every other version, in words that name the version it opens", () => {
    const v2 = utf8(JSON.stringify({ format: "estoc", version: 2, identity: { anchor: { key: "anchor", did: DID } } }));
    expect(() => parseConfig(v2)).toThrow(NotAVault);
    expect(() => parseConfig(v2)).toThrow(/version 2 is not 3; this reader opens version 3 vaults only/);
    for (const version of [4, "3", 3.5, null]) {
      expect(() => parseConfig(utf8(JSON.stringify({ format: "estoc", version, identity: { anchor: { key: "anchor", did: DID } } }))), String(version)).toThrow(NotAVault);
    }
  });

  it("the member set is closed: an unknown or missing member at any level, the wrong format, key or DID form, or a duplicate member is NotAVault", () => {
    const good = { format: "estoc", version: 3, identity: { anchor: { key: "anchor", did: DID } } };
    const bad: [string, unknown][] = [
      ["extra top-level member", { ...good, extension: {} }],
      ["missing identity", { format: "estoc", version: 3 }],
      ["extra identity member", { ...good, identity: { ...good.identity, label: "me" } }],
      ["extra anchor member", { ...good, identity: { anchor: { key: "anchor", did: DID, createdAt: "2026" } } }],
      ["missing did", { ...good, identity: { anchor: { key: "anchor" } } }],
      ["wrong format", { ...good, format: "Estoc" }],
      ["wrong key", { ...good, identity: { anchor: { key: "root", did: DID } } }],
      ["not a did:key", { ...good, identity: { anchor: { key: "anchor", did: "did:web:example.com" } } }],
      ["empty did:key", { ...good, identity: { anchor: { key: "anchor", did: "did:key:" } } }],
      ["did not a string", { ...good, identity: { anchor: { key: "anchor", did: 7 } } }],
      ["identity not an object", { ...good, identity: "anchor" }],
      ["an array", [good]],
    ];
    for (const [what, value] of bad) {
      expect(() => parseConfig(utf8(JSON.stringify(value))), what).toThrow(NotAVault);
    }
    expect(() => parseConfig(utf8(`{"format":"estoc","version":3,"version":3,"identity":{"anchor":{"key":"anchor","did":"${DID}"}}}`))).toThrow(/duplicate/);
    expect(() => parseConfig(new Uint8Array([0xff, 0xfe]))).toThrow(/not UTF-8/);
    expect(() => parseConfig(utf8("{"))).toThrow(NotAVault);
  });
});

describe("keystore.json by shape", () => {
  it("accepts exactly version 3 and seedJwe, compact or as a JWE object", () => {
    expect(() => checkKeystore(utf8(JSON.stringify({ version: 3, seedJwe: JWE })))).not.toThrow();
    expect(() => checkKeystore(utf8(JSON.stringify({ seedJwe: { protected: "e30", iv: "aa", ciphertext: "bb", tag: "cc" }, version: 3 })))).not.toThrow();
  });

  it("refuses a derived-key cache, another version, another shape of seedJwe, and anything that is not the closed set", () => {
    const bad: [string, unknown, RegExp][] = [
      ["a v2 keystore with its keys cache", { version: 3, seedJwe: JWE, keys: [] }, /keys.*derived-key cache/],
      ["version 2", { version: 2, seedJwe: JWE }, /version 2 is not 3/],
      ["no seedJwe", { version: 3 }, /no "seedJwe"/],
      ["seedJwe not a JWE", { version: 3, seedJwe: "hunter2" }, /not a compact JWE/],
      ["seedJwe object missing tag", { version: 3, seedJwe: { protected: "e30", iv: "aa", ciphertext: "bb" } }, /seedJwe.tag/],
      ["seedJwe object with an extra member", { version: 3, seedJwe: { protected: "e30", iv: "aa", ciphertext: "bb", tag: "cc", aad: "dd" } }, /aad/],
      ["seedJwe a number", { version: 3, seedJwe: 1 }, /neither/],
      ["not an object", [3], /not a JSON object/],
    ];
    for (const [what, value, pattern] of bad) {
      expect(() => checkKeystore(utf8(JSON.stringify(value))), what).toThrow(NotAVault);
      expect(() => checkKeystore(utf8(JSON.stringify(value))), what).toThrow(pattern);
    }
    expect(() => checkKeystore(utf8("not json"))).toThrow(NotAVault);
  });
});
