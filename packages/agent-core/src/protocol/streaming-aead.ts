/**
 * Tink's `AES256_GCM_HKDF_1MB` streaming AEAD (`AesGcmHkdfStreaming`),
 * on WebCrypto — the ciphering of an object-share package
 * (`docs/object-share.md` §8). Wire format, as Tink defines it:
 *
 *     header  = len(1) ‖ salt(32) ‖ noncePrefix(7)          — 40 bytes
 *     segment = AES-256-GCM(derivedKey, nonce, plaintextPart) — with tag
 *     nonce   = noncePrefix ‖ segmentNumber(4, BE) ‖ lastSegment(1)
 *
 * The derived key is HKDF-SHA256(key, salt, info = associated data,
 * here empty). Ciphertext segments are 1 MiB including the 16-byte tag,
 * the first also including the header; so the first plaintext part is
 * 1 MiB − 40 − 16 and every later one 1 MiB − 16. Each segment
 * authenticates alone, in place, under its number and a last flag, so a
 * truncated or reordered stream fails. Whole buffers in and out here:
 * the package is fetched entire, and a 100 MiB blob cap makes that the
 * easy case; the per-segment layout is what leaves range checks open.
 *
 * On the last segment: Tink's writers differ on a plaintext that fills
 * segments exactly — Java holds the full buffer and marks it last, Go
 * emits an empty last segment after it. Encryption here does as Java;
 * decryption reads either, because it takes the final chunk of the
 * ciphertext, whatever its length, as the last segment.
 */

export const AES256_GCM_HKDF_1MB = "AES256_GCM_HKDF_1MB";

const KEY_BYTES = 32;
const NONCE_PREFIX_BYTES = 7;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_BYTES + NONCE_PREFIX_BYTES;
const SEGMENT_BYTES = 1024 * 1024;

/** A fresh 32-byte key. */
export function freshKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** Encrypt `plaintext` under `key`; `segmentBytes` is Tink's 1 MiB unless a test shrinks it. */
export async function encryptStream(
  key: Uint8Array,
  plaintext: Uint8Array,
  segmentBytes = SEGMENT_BYTES
): Promise<Uint8Array> {
  checkKey(key);
  const salt = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const prefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES));
  const derived = await deriveKey(key, salt);
  const plainSegment = segmentBytes - TAG_BYTES;
  const first = plainSegment - HEADER_BYTES;
  const parts: Uint8Array[] = [new Uint8Array([HEADER_BYTES, ...salt, ...prefix])];
  let at = 0;
  for (let n = 0; ; n++) {
    const size = n === 0 ? first : plainSegment;
    const end = Math.min(plaintext.length, at + size);
    const last = end === plaintext.length;
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce(prefix, n, last), tagLength: TAG_BYTES * 8 },
      derived,
      plaintext.subarray(at, end)
    );
    parts.push(new Uint8Array(sealed));
    at = end;
    if (last) break;
  }
  return concat(parts);
}

/** Decrypt a whole ciphertext; throws on any segment that does not authenticate, or a truncated stream. */
export async function decryptStream(
  key: Uint8Array,
  ciphertext: Uint8Array,
  segmentBytes = SEGMENT_BYTES
): Promise<Uint8Array> {
  checkKey(key);
  if (ciphertext.length < HEADER_BYTES + TAG_BYTES || ciphertext[0] !== HEADER_BYTES) {
    throw new Error("not an AES256_GCM_HKDF_1MB stream");
  }
  const salt = ciphertext.subarray(1, 1 + KEY_BYTES);
  const prefix = ciphertext.subarray(1 + KEY_BYTES, HEADER_BYTES);
  const derived = await deriveKey(key, salt);
  const parts: Uint8Array[] = [];
  let at = HEADER_BYTES;
  for (let n = 0; ; n++) {
    const end = Math.min(ciphertext.length, (n + 1) * segmentBytes);
    const last = end === ciphertext.length;
    let opened: ArrayBuffer;
    try {
      opened = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce(prefix, n, last), tagLength: TAG_BYTES * 8 },
        derived,
        ciphertext.subarray(at, end)
      );
    } catch {
      throw new Error(`segment ${n} of the stream does not authenticate`);
    }
    parts.push(new Uint8Array(opened));
    at = end;
    if (last) break;
  }
  return concat(parts);
}

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`AES256_GCM_HKDF_1MB takes a ${KEY_BYTES}-byte key`);
  }
}

async function deriveKey(key: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new Uint8Array(0) },
    ikm,
    KEY_BYTES * 8
  );
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function nonce(prefix: Uint8Array, segment: number, last: boolean): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix);
  new DataView(iv.buffer).setUint32(NONCE_PREFIX_BYTES, segment);
  iv[11] = last ? 1 : 0;
  return iv;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
