import { describe, expect, it } from "vitest";
import { didKeyFromPublicKey, publicKeyFromDidKey } from "../src/index.js";

function hex(s: string): Uint8Array {
  return Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
}

// RFC 8032 §7.1 TEST 1 public key.
const RFC8032_TEST1_PUB = hex(
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
);

describe("did:key codec", () => {
  it("encodes the RFC 8032 test key to a stable did:key", () => {
    expect(didKeyFromPublicKey(RFC8032_TEST1_PUB)).toBe(
      "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw",
    );
  });

  it("round-trips arbitrary 32-byte keys", () => {
    const pub = new Uint8Array(32).map((_, i) => i * 7 + 1);
    const did = didKeyFromPublicKey(pub);
    expect(did.startsWith("did:key:z6Mk")).toBe(true);
    expect(publicKeyFromDidKey(did)).toEqual(pub);
  });

  it("rejects wrong-length public keys", () => {
    expect(() => didKeyFromPublicKey(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it("rejects non-did:key strings and non-Ed25519 did:keys", () => {
    expect(() => publicKeyFromDidKey("did:web:example.com")).toThrow(/not a base58btc did:key/);
    // did:key of a secp256k1 key (multicodec 0xe7) must be refused.
    expect(() =>
      publicKeyFromDidKey("did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme"),
    ).toThrow(/does not encode an Ed25519/);
  });
});
