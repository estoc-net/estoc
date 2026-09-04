/** base64url helpers — same lineage as @estoc/did-peer's, atob/btoa based. */

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** The text the bytes are; throws on a byte sequence that is not UTF-8 (nothing is replaced by U+FFFD). */
export function base64urlToUtf8(encoded: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(base64urlToBytes(encoded));
}

export function utf8ToBase64url(text: string): string {
  return bytesToBase64url(new TextEncoder().encode(text));
}
