import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSeedKeystore, addDerivedKey } from "@estoc/keystore";
import { readTree } from "../src/fs.js";
import { MalformedObjectError, readObject, readSignedObject, signedTree, signRoot, verifyCard as verifyAnyCard } from "../src/index.js";
import { drislCid, encodeManifest, hashObject, hashTree, signObject, verifyCard, verifyObject, verifyObjectCard, parseCid, rawCid } from "../src/dasl/index.js";
import { zipTree, unzipTree } from "../src/zip.js";

const seaDay = fileURLToPath(new URL("./fixtures/sea-day/", import.meta.url));
const enc = (s: string) => new TextEncoder().encode(s);

async function signer() {
  const { doc, seedKey } = await createSeedKeystore("pw", { seed: new Uint8Array(32).fill(7) });
  return (await addDerivedKey(doc, seedKey, "org/test")).identity.signer;
}

describe("object over DASL", () => {
  it("hashes the canonical tree to a drisl root; litter and hidden entries never enter", async () => {
    const mapping = await readTree(seaDay);
    const root = await hashObject(readObject(mapping));
    expect(root).toBe("bafyreicdsejj526l225wrfl5cpxcgehq4pzbpxphocvmiuvy6dpwi467aa");
    expect(parseCid(root).code).toBe(0x71);
    mapping["draft.txt"] = enc("litter");
    mapping["files/.DS_Store"] = enc("junk");
    expect(await hashObject(readObject(mapping))).toBe(root);
  });

  it("signs, zips, round-trips, verifies; a changed tree mismatches; the card is the same card", async () => {
    const object = readObject(await readTree(seaDay));
    const s = await signer();
    const jws = await signObject(object, s);
    const card = await verifyCard(jws);
    expect(card).toEqual({ did: s.did(), root: "bafyreicdsejj526l225wrfl5cpxcgehq4pzbpxphocvmiuvy6dpwi467aa" });
    const signed = readSignedObject(unzipTree(zipTree(signedTree(object, jws))));
    expect(await verifyObjectCard(signed.card, signed.object)).toMatchObject({ did: s.did(), matches: true });
    const tampered = readObject({ ...object.tree, "files/body.md": enc("changed") });
    expect((await verifyObjectCard(jws, tampered)).matches).toBe(false);
  });

  it("a card whose root is not a manifest CID is malformed here, however good its signature", async () => {
    const s = await signer();
    const object = readObject(await readTree(seaDay));
    const overRaw = await signRoot(s.did(), await rawCid(enc("bytes")), s);
    const overUnixfs = await signRoot(s.did(), "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354", s);
    await expect(verifyAnyCard(overRaw)).resolves.toBeTruthy(); // the generic card layer does not know encodings
    await expect(verifyCard(overRaw)).rejects.toThrow(/not a manifest CID/);
    await expect(verifyObjectCard(overUnixfs, object)).rejects.toThrow(/not a manifest CID/);
  });
});

describe("verifyObject: an object read out of a root", () => {
  async function blocksOf(files: Record<string, Uint8Array>) {
    const hashed = await hashTree(files);
    const blocks = new Map<string, Uint8Array>([[hashed.root, hashed.manifest]]);
    for (const [cid, path] of hashed.files) blocks.set(cid, files[path]!);
    return { root: hashed.root, blocks };
  }

  it("reads the sea-day object back whole, the same object", async () => {
    const object = readObject(await readTree(seaDay));
    const { root, blocks } = await blocksOf(object.tree);
    const got = await verifyObject(root, blocks);
    expect(got.complete).toBe(true);
    expect(got.object.meta).toEqual(object.meta);
    expect(Object.keys(got.object.tree).sort()).toEqual(Object.keys(object.tree).sort());
    expect(await hashObject(got.object)).toBe(root);
  });

  it("a partial object: every path and size known, absent bytes absent, index.json required", async () => {
    const object = readObject(await readTree(seaDay));
    const { root, blocks } = await blocksOf(object.tree);
    const png = await rawCid(object.tree["files/images/sunset.png"]!);
    blocks.delete(png);
    await expect(verifyObject(root, blocks)).rejects.toThrow(/missing object/);
    const got = await verifyObject(root, blocks, { leaves: "optional" });
    expect(got.complete).toBe(false);
    expect(got.tree.partial.has("files/images/sunset.png")).toBe(true);
    expect(got.tree.sizes.get("files/images/sunset.png")).toBe(70);
    expect(Object.keys(got.object.tree).sort()).toEqual(["files/body.md", "index.json"]);
    const index = await rawCid(object.tree["index.json"]!);
    blocks.delete(index);
    await expect(verifyObject(root, blocks, { leaves: "optional" })).rejects.toThrow(/index.json's bytes are absent/);
  });

  it("a declined leaf makes the object incomplete, not malformed; a declined index.json cannot be read", async () => {
    const index = enc(JSON.stringify({ format: "x", id: "01900000-0000-7000-8000-000000000000", content: { mediaType: "application/octet-stream", path: "files/big.bin" } }));
    const { root, blocks } = await blocksOf({ "index.json": index, "files/big.bin": new Uint8Array(1000).fill(1) });
    const got = await verifyObject(root, blocks, { maxLeafBytes: 500 });
    expect(got.complete).toBe(false);
    expect([...got.tree.declined.keys()]).toEqual(["files/big.bin"]);
    expect(Object.keys(got.object.tree)).toEqual(["index.json"]);
    const err = await verifyObject(root, blocks, { maxLeafBytes: 100 }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(MalformedObjectError);
    expect((err as Error).message).toMatch(/maxLeafBytes/);
  });

  it("a root that reaches litter, a card, or a hidden file is not an object's — format layer, not filtered", async () => {
    const object = readObject(await readTree(seaDay));
    for (const stray of ["draft.txt", "card.jws", "files/.DS_Store", "files/images/.thumbs/x", "object/index.json"]) {
      const { root, blocks } = await blocksOf({ ...object.tree, [stray]: enc("stray") });
      const err = await verifyObject(root, blocks).catch((e: unknown) => e);
      expect(err, stray).toBeInstanceOf(MalformedObjectError);
      expect((err as { layer: string }).layer, stray).toBe("format");
      expect((err as Error).message, stray).toMatch(/no canonical tree holds/);
    }
    const { root, blocks } = await blocksOf({ "files/body.md": enc("no index") });
    await expect(verifyObject(root, blocks)).rejects.toThrow(/no index.json in the manifest/);
  });

  it("index.json malformed is format; content.path not in the manifest is closure", async () => {
    const bad = await blocksOf({ "index.json": enc("{}") });
    await expect(verifyObject(bad.root, bad.blocks)).rejects.toThrow(/missing format/);
    const hole = await blocksOf({ "index.json": enc(JSON.stringify({ format: "x", id: "01900000-0000-7000-8000-000000000000", content: { mediaType: "t", path: "files/b" } })) });
    const err = await verifyObject(hole.root, hole.blocks).catch((e: unknown) => e);
    expect((err as { layer: string }).layer).toBe("closure");
    // a hand-built manifest that names content.path but whose leaf is absent: partial, not a hole
    const index = enc(JSON.stringify({ format: "x", id: "01900000-0000-7000-8000-000000000000", content: { mediaType: "t", path: "files/b" } }));
    const manifest = encodeManifest([{ path: "index.json", cid: await rawCid(index), size: index.length }, { path: "files/b", cid: await rawCid(enc("b")), size: 1 }]);
    const root = await drislCid(manifest);
    const got = await verifyObject(root, new Map([[root, manifest], [await rawCid(index), index]]), { leaves: "optional" });
    expect(got.complete).toBe(false);
    expect(got.tree.partial.has("files/b")).toBe(true);
  });
});

describe("verifyObject: which layer says no", () => {
  it("a manifest that is not the canonical form is format-layer; a missing block or a bad leaf is not malformed", async () => {
    const bytes = enc("hello");
    const cid = await rawCid(bytes);
    const index = enc(JSON.stringify({ format: "x", id: "01900000-0000-7000-8000-000000000000", content: { mediaType: "t", text: "hi" } }));
    const manifest = encodeManifest([{ path: "index.json", cid: await rawCid(index), size: index.length }, { path: "files/a", cid, size: 4 }]);
    const root = await drislCid(manifest);
    const lying = await verifyObject(root, new Map([[root, manifest], [await rawCid(index), index], [cid, bytes]])).catch((e: unknown) => e);
    expect(lying).toBeInstanceOf(MalformedObjectError);
    expect((lying as { layer: string }).layer).toBe("format");
    expect((lying as Error).message).toMatch(/says 4 bytes/);
    const absent = await verifyObject(root, new Map([[root, manifest]])).catch((e: unknown) => e);
    expect(absent).not.toBeInstanceOf(MalformedObjectError);
    expect((absent as Error).message).toMatch(/missing object/);
    const forged = new Uint8Array(manifest);
    forged[forged.length - 1] = 0x18; // no longer canonical, and no longer hashing to root either
    const bad = await verifyObject(root, new Map([[root, forged]])).catch((e: unknown) => e);
    expect((bad as Error).message).toMatch(/do not hash/);
  });
});
