/**
 * @estoc/folder-object — an object is a folder.
 *
 * - tree: hash a mapping into a manifest (one DRISL block, a MASL
 *   bundle) over raw leaves — the DASL encoding of the folder-object
 *   spec (§2.1); verify an object set against a root; resolve one path
 *   in two fetches;
 * - object: read a mapping as an object (`index.json` + `files/…`),
 *   validate it, hash it to its version identity; read an object back
 *   out of a root and the blocks at hand;
 * - card: sign an object as a did:key, verify a card;
 * - signed object: `{object/, card.jws}` as a mapping.
 *
 * Everything here is pure: bytes in, bytes out, no IO, no policy. It runs
 * in Node, workerd and the browser. Node `fs` is on `./fs`; the zip
 * container is on `./zip`. The primitives — DASL CIDs, the DRISL codec,
 * DASL CAR — are `@estoc/dasl`'s.
 */

export type { TreeFiles, IndexJson, FolderObject, ObjectCard, CardSigner, SignedObject, MalformedLayer } from "./types.js";
export { MalformedObjectError } from "./types.js";
export {
  MAX_MANIFEST_BYTES,
  ManifestError,
  segmentsOf,
  encodeManifest,
  decodeManifest,
  hashTree,
  fetchManifest,
  verifyTree,
  walkTree,
  walkLeaves,
  getterOf,
  resolvePath,
  type ManifestEntry,
  type HashedTree,
  type VerifiedTree,
  type VerifyOptions,
  type GetBlock,
  type Resolved,
} from "./tree.js";
export { parseIndex, isHidden, isInsideFiles, readObject, hashObject, contentOf, checkObjectPaths, verifyObject, type VerifiedObject } from "./object.js";
export { CARD_TYP, didKeyKid, signRoot, signObject, verifyCard, verifyObjectCard, type CardVerdict } from "./card.js";
export { signedTree, readAny, readSignedObject } from "./signed.js";
export { blobHash, isBlobHash } from "./blob.js";
