/**
 * @estoc/dasl — DASL (https://dasl.ing). CIDs, multihashes, base32 and
 * sha-256 are multiformats'; the DASL profile over them, the DRISL codec
 * and CAR are here.
 *
 * - cid: DASL CIDs — CIDv1, sha-256, codec raw (0x55) or drisl (0x71),
 *   base32 lower, always 36 bytes, one canonical spelling;
 * - drisl: the DRISL codec — deterministic CBOR with CIDs as tag 42; the
 *   encoder writes the one byte string a value has, the decoder refuses
 *   every other form, so a document's CID is a function of its content;
 * - car: DASL CAR — CARv1 whose blocks are named by DASL CIDs, checked
 *   against them on read.
 *
 * Everything here is pure: bytes in, bytes out, no IO, no policy. It runs
 * in Node, workerd and the browser. What a DRISL document *means* — a
 * folder-object manifest, say — is the business of whoever reads it.
 */

export {
  RAW_CODE,
  DRISL_CODE,
  CID_LENGTH,
  base32Encode,
  base32Decode,
  cidFromBytes,
  parseCid,
  isDaslCid,
  codecOf,
  cidOf,
  rawCid,
  drislCid,
  checkCid,
  compareBytes,
  type DaslCid,
} from "./cid.js";
export { Link, Float, encodeDrisl, decodeDrisl, MAX_DEPTH, type Drisl } from "./drisl.js";
export { encodeCar, decodeCar, type Car } from "./car.js";
