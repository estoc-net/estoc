import bs58 from "bs58";

/** multicodec ed25519-pub (0xed) as a varint, per the did:key method. */
const ED25519_PUB_PREFIX = new Uint8Array([0xed, 0x01]);

/** did:key for a raw 32-byte Ed25519 public key. */
export function didKeyFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  const prefixed = new Uint8Array(ED25519_PUB_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_PUB_PREFIX);
  prefixed.set(publicKey, ED25519_PUB_PREFIX.length);
  return `did:key:z${bs58.encode(prefixed)}`;
}

/** Raw 32-byte Ed25519 public key from a did:key (Ed25519 keys only). */
export function publicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) {
    throw new Error(`not a base58btc did:key: ${did}`);
  }
  const prefixed = bs58.decode(did.slice("did:key:z".length));
  if (
    prefixed.length !== 34 ||
    prefixed[0] !== ED25519_PUB_PREFIX[0] ||
    prefixed[1] !== ED25519_PUB_PREFIX[1]
  ) {
    throw new Error(`did:key does not encode an Ed25519 public key: ${did}`);
  }
  return prefixed.slice(2);
}
