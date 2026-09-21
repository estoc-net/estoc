import { describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { base64url } from "jose";
import {
  changeSeedPassphrase,
  createSeedKeystore,
  deriveIdentity,
  generateSeed,
  importSeed,
  isValidKeyName,
  parseSeedKeystore,
  publicKeyFromDidKey,
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
  it("create → serialize → parse → unlock round-trips to the same keys", async () => {
    const { doc, seedKey } = await createSeedKeystore("hunter2", { seed: FIXED_SEED });
    expect(doc).toEqual({ version: 3, seedJwe: expect.any(String) });
    const identity = await deriveIdentity(seedKey, "anchor");

    const reloaded = parseSeedKeystore(serializeKeystore(doc));
    const unlocked = await unlockSeedKeystore(reloaded, "hunter2");
    const reopened = await deriveIdentity(unlocked, "anchor");
    expect(reopened.did).toBe(identity.did);
    expect(reopened.name).toBe("anchor");
  });

  it("wrong passphrase fails without leaking jose internals; passphrase change works", async () => {
    const { doc, seedKey } = await createSeedKeystore("right");
    await expect(unlockSeedKeystore(doc, "wrong")).rejects.toThrow(/wrong passphrase/);
    const changed = await changeSeedPassphrase(doc, "right", "newer");
    await expect(unlockSeedKeystore(changed, "right")).rejects.toThrow(/wrong passphrase/);
    const unlocked = await unlockSeedKeystore(changed, "newer");
    expect((await deriveIdentity(unlocked, "anchor")).did).toBe((await deriveIdentity(seedKey, "anchor")).did);
  });

  it("another seed derives another key under the same name", async () => {
    const { seedKey } = await createSeedKeystore("pw", { seed: FIXED_SEED });
    const other = await importSeed(generateSeed());
    expect((await deriveIdentity(other, "anchor")).did).not.toBe((await deriveIdentity(seedKey, "anchor")).did);
  });

  it("parser validates structure, keeps unknown fields, and refuses other versions and listed keys", async () => {
    const { doc } = await createSeedKeystore("pw");
    expect(() => parseSeedKeystore("nope")).toThrow(/valid JSON/);
    expect(() => parseSeedKeystore('"str"')).toThrow(/JSON object/);
    expect(() => parseSeedKeystore('{"version":1,"keys":[]}')).toThrow(/v1 .* no longer supported/);
    expect(() => parseSeedKeystore('{"version":2,"seedJwe":"x","nextIndex":0,"keys":[]}')).toThrow(
      /v2 .* no longer supported/,
    );
    expect(() => parseSeedKeystore('{"version":4,"seedJwe":"x"}')).toThrow(/unsupported seed keystore version/);
    expect(() => parseSeedKeystore('{"version":3}')).toThrow(/seedJwe must be a string/);
    expect(() => parseSeedKeystore('{"version":3,"seedJwe":"x","keys":[]}')).toThrow(/list their keys/);
    const extra = { ...doc, future: { any: 1 } };
    const parsed = parseSeedKeystore(JSON.stringify(extra)) as unknown as Record<string, unknown>;
    expect(parsed.future).toEqual({ any: 1 });
  });
});
