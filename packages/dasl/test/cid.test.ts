import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { base32Decode, base32Encode, checkCid, cidOf, codecOf, drislCid, isDaslCid, parseCid, rawCid, DRISL_CODE, RAW_CODE } from "../src/index.js";

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
    expect(() => base32Decode("mz")).toThrow(/trailing/);
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
