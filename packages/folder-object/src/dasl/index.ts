/**
 * @estoc/folder-object/dasl — the folder-object format over DASL
 * (https://dasl.ing): DASL CIDs, DRISL, and a MASL manifest as the tree.
 * Everything here is pure and dependency-free: sha-256 is WebCrypto's,
 * base32 and CBOR are a few dozen lines each.
 *
 * The object and signed-object layers are the main entry's; only the
 * hash encoding differs, so `hashObject`, `signObject` and
 * `verifyObjectCard` are re-done here over the manifest root.
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
export { Link, encodeDrisl, decodeDrisl, MAX_DEPTH, type Drisl } from "./drisl.js";
export {
  MAX_MANIFEST_BYTES,
  segmentsOf,
  encodeManifest,
  decodeManifest,
  hashTree,
  fetchManifest,
  verifyTree,
  walkTree,
  getterOf,
  resolvePath,
  type ManifestEntry,
  type HashedManifest,
  type VerifiedManifest,
  type VerifyOptions,
  type GetBlock,
  type Resolved,
} from "./tree.js";
export { hashObject, signObject, verifyCard, verifyObjectCard, verifyObject, checkObjectPaths, type VerifiedObject } from "./object.js";
