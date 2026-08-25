import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSeedKeystore, addDerivedKey } from "@estoc/keystore";
import { readTree } from "../src/fs.js";
import {
  readObject,
  hashObject,
  signObject,
  verifyObjectCard,
  signedTree,
  readAny,
  readSignedObject,
  MalformedObjectError,
} from "../src/index.js";
import { zipTree, unzipTree } from "../src/zip.js";

const seaDay = fileURLToPath(new URL("../../../../folder-object/examples/sea-day/", import.meta.url));
const enc = (s: string) => new TextEncoder().encode(s);

const seed = new Uint8Array(32).fill(7);
async function signer() {
  const { doc, seedKey } = await createSeedKeystore("pw", { seed });
  return (await addDerivedKey(doc, seedKey, "org/test")).identity.signer;
}

describe("object", () => {
  it("reads the sea-day example, drops litter, hashes deterministically", async () => {
    const mapping = await readTree(seaDay);
    mapping["draft.txt"] = enc("litter");
    const object = readObject(mapping);
    expect(Object.keys(object.tree).sort()).toEqual(["files/body.dj", "files/images/sunset.png", "index.json"]);
    const root = await hashObject(object);
    expect(root).toMatch(/^bafybei/);
    expect(await hashObject(readObject(await readTree(seaDay)))).toBe(root);
  });

  it("rejects the format and closure layers separately", () => {
    expect(() => readObject({})).toThrow(MalformedObjectError);
    expect(() => readObject({ "index.json": enc("{}") })).toThrow(/missing format/);
    const escaping = JSON.stringify({ format: "x", id: "01900000-0000-7000-8000-000000000000", content: { mediaType: "t", path: "../x" } });
    expect(() => readObject({ "index.json": enc(escaping) })).toThrow(/files\//);
    const hole = JSON.stringify({ format: "x", id: "01900000-0000-7000-8000-000000000000", content: { mediaType: "t", path: "files/b" } });
    try {
      readObject({ "index.json": enc(hole) });
      expect.unreachable();
    } catch (e) {
      expect((e as MalformedObjectError).layer).toBe("closure");
    }
  });

  it("a lone index.json with inline content is a complete object", () => {
    const idx = JSON.stringify({ format: "x", id: "01900000-0000-7000-8000-000000000000", content: { mediaType: "t", text: "hi" } });
    expect(readObject({ "index.json": enc(idx) }).tree).toHaveProperty("index.json");
  });
});

describe("card + signed object", () => {
  it("signs, zips, round-trips, verifies; a changed tree mismatches", async () => {
    const object = readObject(await readTree(seaDay));
    const s = await signer();
    const jws = await signObject(object, s);
    const zip = zipTree(signedTree(object, jws));
    const signed = readSignedObject(unzipTree(zip));
    expect(signed.card).toBe(jws);
    const verdict = await verifyObjectCard(signed.card, signed.object);
    expect(verdict).toMatchObject({ did: s.did(), matches: true });

    const tampered = readObject({ ...object.tree, "files/body.dj": enc("changed") });
    expect((await verifyObjectCard(jws, tampered)).matches).toBe(false);
  });

  it("zip output is deterministic", async () => {
    const object = readObject(await readTree(seaDay));
    expect(Buffer.from(zipTree(object.tree)).equals(Buffer.from(zipTree(object.tree)))).toBe(true);
  });

  it("readAny takes a bare object or a signed one; litter beside object/ is ignored", async () => {
    const object = readObject(await readTree(seaDay));
    expect(readAny(object.tree).card).toBeUndefined();
    const laid = { ...signedTree(object, "x.y.z"), "index.html": enc("<p>rendered</p>") };
    expect(readAny(laid)).toEqual({ object, card: "x.y.z" });
    expect(() => readSignedObject(object.tree)).toThrow(/not a signed one/);
    expect(() => readAny({ "readme.txt": enc("?") })).toThrow(MalformedObjectError);
  });
});
