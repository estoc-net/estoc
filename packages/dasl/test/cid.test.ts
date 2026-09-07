import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { base32Decode, base32Encode, checkCid, cidFromBytes, cidOf, codecOf, drislCid, isDaslCid, parseCid, rawCid, DRISL_CODE, RAW_CODE } from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("base32 lower (RFC 4648, no padding)", () => {
  const vectors: [string, string][] = [["", ""], ["f", "my"], ["fo", "mzxq"], ["foo", "mzxw6"], ["foob", "mzxw6yq"], ["fooba", "mzxw6ytb"], ["foobar", "mzxw6ytboi"]];
  for (const [input, expected] of vectors) {
    it(`${JSON.stringify(input)} ↔ ${expected}`, () => {
      expect(base32Encode(utf8(input))).toBe(expected);
      expect(new TextDecoder().decode(base32Decode(expected))).toBe(input);
    });
  }
  it("rejects uppercase, padding, and non-zero trailing bits", () => {
    expect(() => base32Decode("MY")).toThrow(/base32/);
    expect(() => base32Decode("my======")).toThrow(/base32/);
    expect(() => base32Decode("mz")).toThrow(/base32/);
  });
});

describe("DASL CID", () => {
  it("raw CID is the one multiformats computes, byte for byte", async () => {
    const b = utf8("<h1>hi</h1>");
    expect(await rawCid(b)).toBe("bafkreihh7o3pxp2m4kkjcpvwfnj76a5hkrtett64bwbe3hr2fncucubpp4");
    expect(await rawCid(b)).toBe(CID.create(1, 0x55, await sha256.digest(b)).toString());
  });

  it("drisl CID agrees with multiformats, byte for byte", async () => {
    const b = utf8("a0");
    const ours = await cidOf(DRISL_CODE, b);
    const theirs = CID.create(1, 0x71, await sha256.digest(b));
    expect(ours.text).toBe(theirs.toString());
    expect([...ours.bytes]).toEqual([...theirs.bytes]);
    expect(ours.bytes.length).toBe(36);
    expect(await drislCid(b)).toBe(theirs.toString());
  });

  it("parses only the canonical spelling of a DASL CID", async () => {
    const raw = await rawCid(utf8("x"));
    expect(parseCid(raw).code).toBe(RAW_CODE);
    expect(codecOf(raw)).toBe(RAW_CODE);
    expect(isDaslCid(raw)).toBe(true);
    expect(isDaslCid("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354")).toBe(false); // dag-pb: UnixFS root
    expect(() => parseCid("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354")).toThrow(/0x70/);
    expect(isDaslCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(false); // CIDv0
    expect(isDaslCid(raw.toUpperCase())).toBe(false);
    expect(isDaslCid(raw + "a")).toBe(false);
    expect(isDaslCid(raw.slice(0, -1))).toBe(false);
    expect(isDaslCid(`z${raw.slice(1)}`)).toBe(false);
    expect(isDaslCid(42)).toBe(false);
    expect(codecOf("nope")).toBeNull();
  });

  it("checkCid proves bytes against a CID under its own codec", async () => {
    const b = utf8("hello");
    await expect(checkCid(await rawCid(b), b)).resolves.toBeTruthy();
    await expect(checkCid(await rawCid(b), utf8("hellp"))).rejects.toThrow(/do not hash/);
    // same digest, other codec: a different name
    expect(await drislCid(b)).not.toBe(await rawCid(b));
    await expect(checkCid(await drislCid(b), b)).resolves.toBeTruthy();
    await expect(cidOf(0x70, b)).rejects.toThrow(/neither raw nor drisl/);
  });
});

// docs/replica-model/dasl-objects.md — the version-3 vault names its objects by
// raw DASL CIDs. §4.2 gives two executable vectors; DO-3 lists what a reader
// must refuse. Refusing *drisl* CIDs is the object store's rule (DO §3), not
// this package's: parseCid accepts both codecs and says which one it saw.
describe("dasl-objects.md", () => {
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

  it("DO-2 the empty raw object has the CID of §4.2", async () => {
    const cid = await cidOf(RAW_CODE, new Uint8Array());
    expect(hex(cid.bytes)).toBe("01551220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(cid.text).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    expect(parseCid(cid.text).text).toBe(cid.text);
  });

  it("§4.2 UTF-8 \"hello\" has the CID of §4.2, in both forms", async () => {
    const cid = await cidOf(RAW_CODE, utf8("hello"));
    expect(hex(cid.bytes)).toBe("015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(cid.text).toBe("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
    expect(cidFromBytes(fromHex(hex(cid.bytes))).text).toBe(cid.text);
  });

  it("DO-3 CIDv0, uppercase, non-canonical base32, dag-pb, non-SHA-256 and a wrong digest length are refused", async () => {
    const raw = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
    const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    // CIDv0 (base58btc, dag-pb, sha-256)
    expect(() => parseCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toThrow(/prefix b/);
    // uppercase, whole and body only
    expect(() => parseCid(raw.toUpperCase())).toThrow(/prefix b/);
    expect(() => parseCid(`b${raw.slice(1).toUpperCase()}`)).toThrow(/base32/);
    // non-canonical base32: the last character carries three bits, the two below must be zero
    const last = ALPHABET.indexOf(raw[raw.length - 1]!);
    expect(() => parseCid(raw.slice(0, -1) + ALPHABET[last | 1])).toThrow(/base32/);
    // padding
    expect(() => parseCid(`${raw}=`)).toThrow(/base32/);
    // dag-pb (0x70) over the same digest
    expect(() => cidFromBytes(fromHex(`01701220${digest}`))).toThrow(/0x70/);
    // non-SHA-256: sha-512 (0x13) truncated to 32 bytes
    expect(() => cidFromBytes(fromHex(`01551320${digest}`))).toThrow(/sha-256/);
    // wrong digest length: 31 bytes declared over 32 given; 31 declared and 31 given
    expect(() => cidFromBytes(fromHex(`0155121f${digest}`))).toThrow(/32 bytes/);
    expect(() => cidFromBytes(fromHex(`0155121f${digest.slice(2)}`))).toThrow(/36 bytes/);
    // trailing binary bytes
    expect(() => cidFromBytes(fromHex(`01551220${digest}00`))).toThrow(/36 bytes/);
    // a valid CID whose digest is not the bytes'
    await expect(checkCid(raw, utf8("hellp"))).rejects.toThrow(/do not hash/);
    // drisl parses here; refusing it is the object store's job
    expect(codecOf(`b${base32Encode(fromHex(`01711220${digest}`))}`)).toBe(DRISL_CODE);
  });
});
