import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSeedKeystore, addDerivedKey } from "@estoc/keystore";
import { readTree } from "../src/fs.js";
import { readObject, readSignedObject, signedTree, signRoot, verifyCard as verifyAnyCard } from "../src/index.js";
import { hashObject, signObject, verifyCard, verifyObjectCard, parseCid, rawCid } from "../src/dasl/index.js";
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
