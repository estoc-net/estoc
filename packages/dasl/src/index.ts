/**
 * @estoc/dasl — DASL (https://dasl.ing). CIDs, multihashes, base32,
 * sha-256 and varints are multiformats', a CAR is written by @ipld/car;
 * the DASL profile over them and the DRISL codec are here, one module
 * each: cid, drisl, car.
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
