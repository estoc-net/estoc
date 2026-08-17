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
  isValidKeyName,
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
  it("is deterministic and pinned: same seed and name → same DID and keys", async () => {
    const a = await deriveIdentity(await importSeed(FIXED_SEED), "anchor");
    const b = await deriveIdentity(await importSeed(FIXED_SEED), "anchor");
    expect(a.name).toBe("anchor");
    expect(a.did).toBe(b.did);
    expect(a.signer.x25519PublicKey()).toEqual(b.signer.x25519PublicKey());
    // Pinned vector (estoc/v3) — changing HKDF salt/info silently renames every DID; this must fail if it does.
    expect(a.did).toBe("did:key:z6Mkk4RzvEvh61iNGk7gJVk9UPSrGofjLgLDrtEqzdCATJ5A");
    expect(base64url.encode(a.signer.x25519PublicKey())).toBe("9PnyyHRLj01yHn0P804bi6YjXxZ6rPUvYqw30wtiqyo");
  });

  it("different names give unrelated keys; Ed25519 and X25519 halves are independent", async () => {
    const seedKey = await importSeed(FIXED_SEED);
    const [a, b] = await Promise.all([
      deriveIdentity(seedKey, "pair/c1/0198a"),
      deriveIdentity(seedKey, "pair/c1/0198b"),
    ]);
    expect(a.did).not.toBe(b.did);
    expect(a.signer.x25519PublicKey()).not.toEqual(b.signer.x25519PublicKey());
    const jwks = a.privateJwks();
    expect(jwks.ed25519).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(jwks.x25519).toMatchObject({ kty: "OKP", crv: "X25519" });
    expect(base64url.decode(jwks.ed25519.d!)).not.toEqual(base64url.decode(jwks.x25519.d!));
  });

  it("signer signs and does ECDH consistently with its published keys", async () => {
    const identity = await deriveIdentity(await importSeed(FIXED_SEED), "mediation/m1/me");
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

  it("rejects bad seeds and names", async () => {
    await expect(importSeed(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    const seedKey = await importSeed(FIXED_SEED);
    for (const bad of ["", "with space", "ünïcode", "a\nb", "semi;colon", "back\\slash"]) {
      await expect(deriveIdentity(seedKey, bad)).rejects.toThrow(/invalid key name/);
      expect(isValidKeyName(bad)).toBe(false);
    }
    for (const good of ["anchor", "mediation/0198abc/me", "pair/c-1/x.y_z", "invite/a1"]) {
      expect(isValidKeyName(good)).toBe(true);
    }
  });
});

describe("seed keystore", () => {
  it("create → add → serialize → parse → unlock → open round-trips", async () => {
    let { doc, seedKey } = await createSeedKeystore("hunter2", { seed: FIXED_SEED });
    let identity;
    ({ doc, identity } = await addDerivedKey(doc, seedKey, "anchor"));
    ({ doc } = await addDerivedKey(doc, seedKey, "pair/alice/1"));
    expect(doc.version).toBe(3);

    const reloaded = parseSeedKeystore(serializeKeystore(doc));
    expect(listKeys(reloaded).map((k) => k.name)).toEqual(["anchor", "pair/alice/1"]);
    expect(reloaded.keys[0]).toEqual({ name: "anchor", did: identity.did, createdAt: expect.any(String) });

    const unlocked = await unlockSeedKeystore(reloaded, "hunter2");
    const reopened = await openDerivedKey(reloaded, unlocked, "anchor");
    expect(reopened.did).toBe(identity.did);
    expect(reopened.name).toBe("anchor");
  });

  it("wrong passphrase fails without leaking jose internals; passphrase change works", async () => {
    const { doc } = await createSeedKeystore("right");
    await expect(unlockSeedKeystore(doc, "wrong")).rejects.toThrow(/wrong passphrase/);
    const changed = await changeSeedPassphrase(doc, "right", "newer");
    await expect(unlockSeedKeystore(changed, "right")).rejects.toThrow(/wrong passphrase/);
    await unlockSeedKeystore(changed, "newer");
    expect(changed.keys).toEqual(doc.keys);
  });

  it("the name is the key: add is idempotent, open needs no cache entry, remove forgets only the listing", async () => {
    let { doc, seedKey } = await createSeedKeystore("pw", { seed: FIXED_SEED });
    let a;
    ({ doc, identity: a } = await addDerivedKey(doc, seedKey, "pair/c/1", { now: new Date(0) }));
    const again = await addDerivedKey(doc, seedKey, "pair/c/1", { now: new Date(1000) });
    expect(again.identity.did).toBe(a.did);
    expect(again.doc).toBe(doc); // unchanged, createdAt kept
    expect(doc.keys).toHaveLength(1);

    // A name another store minted derives here without being listed.
    const unlisted = await openDerivedKey(doc, seedKey, "pair/c/2");
    expect(unlisted.did).not.toBe(a.did);
    expect(doc.keys.map((k) => k.name)).toEqual(["pair/c/1"]);

    doc = removeDerivedKey(doc, "pair/c/1");
    expect(doc.keys).toEqual([]);
    expect((await openDerivedKey(doc, seedKey, "pair/c/1")).did).toBe(a.did);
    let b;
    ({ doc, identity: b } = await addDerivedKey(doc, seedKey, "pair/c/1"));
    expect(b.did).toBe(a.did);
  });

  it("detects a seed that does not match a recorded DID", async () => {
    let { doc, seedKey } = await createSeedKeystore("pw", { seed: FIXED_SEED });
    ({ doc } = await addDerivedKey(doc, seedKey, "anchor"));
    const other = await importSeed(generateSeed());
    await expect(openDerivedKey(doc, other, "anchor")).rejects.toThrow(/does not derive/);
    await expect(addDerivedKey(doc, other, "anchor")).rejects.toThrow(/does not derive/);
  });

  it("rejects bad and unknown names", async () => {
    let { doc, seedKey } = await createSeedKeystore("pw");
    ({ doc } = await addDerivedKey(doc, seedKey, "anchor"));
    await expect(addDerivedKey(doc, seedKey, "")).rejects.toThrow(/invalid key name/);
    await expect(addDerivedKey(doc, seedKey, "no spaces")).rejects.toThrow(/invalid key name/);
    await expect(openDerivedKey(doc, seedKey, "no spaces")).rejects.toThrow(/invalid key name/);
    expect(() => removeDerivedKey(doc, "nope")).toThrow(/no key named/);
  });

  it("parser validates structure, keeps unknown fields, and refuses other versions", async () => {
    const { doc } = await createSeedKeystore("pw");
    expect(() => parseSeedKeystore("nope")).toThrow(/valid JSON/);
    expect(() => parseSeedKeystore('{"version":1,"keys":[]}')).toThrow(/unsupported seed keystore version/);
    expect(() => parseSeedKeystore('{"version":2,"seedJwe":"x","nextIndex":0,"keys":[]}')).toThrow(
      /v2 .* no longer supported/,
    );
    expect(() => parseKeystore(serializeKeystore(doc))).toThrow(/v3 seed keystore/);
    const bad = { ...doc, keys: [{ name: "bad name", did: "did:key:z", createdAt: "" }] };
    expect(() => parseSeedKeystore(JSON.stringify(bad))).toThrow(/invalid name/);
    const dup = { ...doc, keys: [
      { name: "x", did: "did:key:z", createdAt: "" },
      { name: "x", did: "did:key:z", createdAt: "" },
    ] };
    expect(() => parseSeedKeystore(JSON.stringify(dup))).toThrow(/duplicate key name/);
    const extra = { ...doc, future: { any: 1 }, keys: [{ name: "x", did: "did:key:z", createdAt: "", note: "kept" }] };
    const parsed = parseSeedKeystore(JSON.stringify(extra)) as unknown as Record<string, unknown>;
    expect(parsed.future).toEqual({ any: 1 });
    expect((parsed.keys as unknown[])[0]).toMatchObject({ note: "kept" });
  });
});
