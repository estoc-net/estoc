import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import {
  createKey,
  emptyKeystore,
  listKeys,
  openKey,
  parseKeystore,
  publicKeyFromDidKey,
  removeKey,
  serializeKeystore,
} from "../src/index.js";


describe("keystore", () => {
  it("create → serialize → parse → open → sign → verify round-trips", async () => {
    const { doc } = await createKey(emptyKeystore(), "root", "hunter2");

    const reloaded = parseKeystore(serializeKeystore(doc));
    const signer = await openKey(reloaded, "root", "hunter2");

    const message = new TextEncoder().encode("estoc");
    const signature = await signer.sign(message);
    const publicKey = publicKeyFromDidKey(signer.did());
    expect(ed25519.verify(signature, message, publicKey)).toBe(true);
    expect(signer.did()).toBe(reloaded.keys[0]!.did);
  });

  it("lists names and DIDs without a passphrase", async () => {
    let doc = emptyKeystore();
    ({ doc } = await createKey(doc, "root", "pw"));
    ({ doc } = await createKey(doc, "work", "pw"));

    const infos = listKeys(doc);
    expect(infos.map((i) => i.name)).toEqual(["root", "work"]);
    for (const info of infos) expect(info.did.startsWith("did:key:z6Mk")).toBe(true);
  });

  it("rejects a wrong passphrase without leaking jose internals", async () => {
    const { doc } = await createKey(emptyKeystore(), "root", "right");
    await expect(openKey(doc, "root", "wrong")).rejects.toThrow(/wrong passphrase/);
  });

  it("rejects duplicate names, unknown names, and empty names", async () => {
    const { doc } = await createKey(emptyKeystore(), "root", "pw");
    await expect(createKey(doc, "root", "pw")).rejects.toThrow(/already exists/);
    await expect(openKey(doc, "nope", "pw")).rejects.toThrow(/no key named/);
    await expect(createKey(doc, "", "pw")).rejects.toThrow(/must not be empty/);
    expect(() => removeKey(doc, "nope")).toThrow(/no key named/);
  });

  it("removeKey drops the entry and leaves the input untouched", async () => {
    let doc = emptyKeystore();
    ({ doc } = await createKey(doc, "a", "pw"));
    ({ doc } = await createKey(doc, "b", "pw"));
    const after = removeKey(doc, "a");
    expect(listKeys(after).map((i) => i.name)).toEqual(["b"]);
    expect(listKeys(doc).map((i) => i.name)).toEqual(["a", "b"]);
  });

  it("two keys agree on the same X25519 shared secret", async () => {
    const { signer: alice } = await createKey(emptyKeystore(), "a", "pw");
    const { signer: bob } = await createKey(emptyKeystore(), "b", "pw");

    const ab = await alice.deriveSharedSecret(bob.x25519PublicKey());
    const ba = await bob.deriveSharedSecret(alice.x25519PublicKey());
    expect(ab).toEqual(ba);
    expect(ab).toHaveLength(32);
  });

  it("accepts a caller-supplied private key and stamps a fixed time", async () => {
    const privateKey = new Uint8Array(32).fill(9);
    const now = new Date("2026-08-13T00:00:00Z");
    const { doc, signer } = await createKey(emptyKeystore(), "fixed", "pw", {
      privateKey,
      now,
    });
    expect(doc.keys[0]!.createdAt).toBe("2026-08-13T00:00:00.000Z");
    // Deterministic key ⇒ deterministic DID.
    const again = await createKey(emptyKeystore(), "fixed", "pw", { privateKey });
    expect(again.signer.did()).toBe(signer.did());
  });

  it("parseKeystore rejects malformed documents", () => {
    expect(() => parseKeystore("not json")).toThrow(/not valid JSON/);
    expect(() => parseKeystore('"str"')).toThrow(/JSON object/);
    expect(() => parseKeystore('{"version":2,"keys":[]}')).toThrow(/unsupported keystore version/);
    expect(() => parseKeystore('{"version":1}')).toThrow(/must be an array/);
    expect(() => parseKeystore('{"version":1,"keys":[{"name":"x"}]}')).toThrow(/missing string field/);
    const entry =
      '{"name":"x","did":"did:key:z1","createdAt":"t","privateKeyJwe":"e"}';
    expect(() =>
      parseKeystore(`{"version":1,"keys":[${entry},${entry}]}`),
    ).toThrow(/duplicate key name/);
  });
});
