/** Unpadded base64url (RFC 4648 §5), the encoding of JWK members and effect keys. */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUES = new Map([...ALPHABET].map((c, i) => [c, i]));

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHABET[n >>> 18]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET[n >>> 18]! + ALPHABET[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += ALPHABET[n >>> 18]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]!;
  }
  return out;
}

/**
 * The bytes of a canonical encoding, or `null` when `text` is not one:
 * a character outside the alphabet, padding, a length no byte string
 * encodes to, or trailing bits that are not zero.
 */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const c of text) {
    const value = VALUES.get(c);
    if (value === undefined) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[n++] = (acc >>> bits) & 0xff;
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return bytes;
}
