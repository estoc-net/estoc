import { describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { base64url } from "jose";
import {
  addDerivedKey,
  changeSeedPassphrase,
  createSeedKeystore,
  deriveIdentity,
  generateSeed,
  importSeed,
  listKeys,
  openDerivedKey,
  parseKeystore,
  parseSeedKeystore,
  publicKeyFromDidKey,
  removeDerivedKey,
  serializeKeystore,
  unlockSeedKeystore,
} from "../src/index.js";

const FIXED_SEED = new Uint8Array(32).map((_, i) => i);

describe("seed derivation", () => {
  it("is deterministic and pinned: same seed and index → same DID and keys", async () => {
    const a = await deriveIdentity(await importSeed(FIXED_SEED), 0);
    const b = await deriveIdentity(await importSeed(FIXED_SEED), 0);
    expect(a.did).toBe(b.did);
    expect(a.signer.x25519PublicKey()).toEqual(b.signer.x25519PublicKey());
    // Pinned vector — changing HKDF salt/info silently renames every DID; this must fail if it does.
    expect(a.did).toBe("did:key:z6Mkop5FwEQLSdvJfTw4Negd1WQxSe2N5gkRBAG9XYFEu8QA");
    expect(base64url.encode(a.signer.x25519PublicKey())).toBe("Wfaj-H89zaIIPs7OMcSHF7JkpbNsTXefEr02U1YTkwE");
  });

  it("different indices give unrelated keys; Ed25519 and X25519 halves are independent", async () => {
    const seedKey = await importSeed(FIXED_SEED);
    const [i0, i1] = await Promise.all([deriveIdentity(seedKey, 0), deriveIdentity(seedKey, 1)]);
    expect(i0.did).not.toBe(i1.did);
    expect(i0.signer.x25519PublicKey()).not.toEqual(i1.signer.x25519PublicKey());
    const jwks = i0.privateJwks();
    expect(jwks.ed25519).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(jwks.x25519).toMatchObject({ kty: "OKP", crv: "X25519" });
    expect(base64url.decode(jwks.ed25519.d!)).not.toEqual(base64url.decode(jwks.x25519.d!));
  });

  it("signer signs and does ECDH consistently with its published keys", async () => {
    const identity = await deriveIdentity(await importSeed(FIXED_SEED), 3);
    const message = new TextEncoder().encode("estoc");
    const sig = await identity.signer.sign(message);
    expect(ed25519.verify(sig, message, publicKeyFromDidKey(identity.did))).toBe(true);
    // Verify the JWK escape hatch agrees with the signer.
    const jwks = identity.privateJwks();
    expect(base64url.decode(jwks.ed25519.x!)).toEqual(identity.signer.publicKey());
    expect(base64url.decode(jwks.x25519.x!)).toEqual(identity.signer.x25519PublicKey());
    const theirPriv = x25519.utils.randomPrivateKey();
    const shared = await identity.signer.deriveSharedSecret(x25519.getPublicKey(theirPriv));
    expect(shared).toEqual(x25519.getSharedSecret(theirPriv, identity.signer.x25519PublicKey()));
  });

  it("the imported seed key is non-extractable", async () => {
    const seedKey = await importSeed(generateSeed());
    expect(seedKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", seedKey)).rejects.toThrow();
  });

  it("rejects bad seeds and indices", async () => {
    await expect(importSeed(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    const seedKey = await importSeed(FIXED_SEED);
    await expect(deriveIdentity(seedKey, -1)).rejects.toThrow(/non-negative/);
    await expect(deriveIdentity(seedKey, 1.5)).rejects.toThrow(/non-negative/);
  });
});

describe("seed keystore", () => {
  it("create → add → serialize → parse → unlock → open round-trips", async () => {
    let { doc, seedKey } = await createSeedKeystore("hunter2", { seed: FIXED_SEED });
    let identity;
    ({ doc, identity } = await addDerivedKey(doc, seedKey, "root"));
    ({ doc } = await addDerivedKey(doc, seedKey, "alice"));

    const reloaded = parseSeedKeystore(serializeKeystore(doc));
    expect(listKeys(reloaded).map((k) => k.name)).toEqual(["root", "alice"]);

    const unlocked = await unlockSeedKeystore(reloaded, "hunter2");
    const reopened = await openDerivedKey(reloaded, unlocked, "root");
    expect(reopened.did).toBe(identity.did);
    expect(reopened.index).toBe(0);
    expect((await openDerivedKey(reloaded, unlocked, "alice")).index).toBe(1);
  });

  it("wrong passphrase fails without leaking jose internals; passphrase change works", async () => {
    const { doc } = await createSeedKeystore("right");
    await expect(unlockSeedKeystore(doc, "wrong")).rejects.toThrow(/wrong passphrase/);
    const changed = await changeSeedPassphrase(doc, "right", "newer");
    await expect(unlockSeedKeystore(changed, "right")).rejects.toThrow(/wrong passphrase/);
    await unlockSeedKeystore(changed, "newer");
    expect(changed.keys).toEqual(doc.keys);
  });

  it("never reuses an index after removal", async () => {
    let { doc, seedKey } = await createSeedKeystore("pw", { seed: FIXED_SEED });
    let a;
    ({ doc, identity: a } = await addDerivedKey(doc, seedKey, "a"));
    doc = removeDerivedKey(doc, "a");
    let b;
    ({ doc, identity: b } = await addDerivedKey(doc, seedKey, "a"));
    expect(b.index).toBe(1);
    expect(b.did).not.toBe(a.did);
    expect(doc.nextIndex).toBe(2);
  });

  it("detects a seed that does not match a recorded DID", async () => {
    let { doc, seedKey } = await createSeedKeystore("pw", { seed: FIXED_SEED });
    ({ doc } = await addDerivedKey(doc, seedKey, "root"));
    const other = await importSeed(generateSeed());
    await expect(openDerivedKey(doc, other, "root")).rejects.toThrow(/does not derive/);
  });

  it("rejects duplicate, unknown and empty names", async () => {
    let { doc, seedKey } = await createSeedKeystore("pw");
    ({ doc } = await addDerivedKey(doc, seedKey, "root"));
    await expect(addDerivedKey(doc, seedKey, "root")).rejects.toThrow(/already exists/);
    await expect(addDerivedKey(doc, seedKey, "")).rejects.toThrow(/must not be empty/);
    await expect(openDerivedKey(doc, seedKey, "nope")).rejects.toThrow(/no key named/);
    expect(() => removeDerivedKey(doc, "nope")).toThrow(/no key named/);
  });

  it("parser validates structure and refuses the other version", async () => {
    const { doc } = await createSeedKeystore("pw");
    expect(() => parseSeedKeystore("nope")).toThrow(/valid JSON/);
    expect(() => parseSeedKeystore('{"version":1,"keys":[]}')).toThrow(/unsupported seed keystore version/);
    expect(() => parseKeystore(serializeKeystore(doc))).toThrow(/v2 seed keystore/);
    const bad = { ...doc, nextIndex: 0, keys: [{ name: "x", index: 0, did: "did:key:z", createdAt: "" }] };
    expect(() => parseSeedKeystore(JSON.stringify(bad))).toThrow(/invalid index/);
    const dup = { ...doc, nextIndex: 2, keys: [
      { name: "x", index: 0, did: "did:key:z", createdAt: "" },
      { name: "y", index: 0, did: "did:key:z", createdAt: "" },
    ] };
    expect(() => parseSeedKeystore(JSON.stringify(dup))).toThrow(/duplicate key index/);
  });
});
