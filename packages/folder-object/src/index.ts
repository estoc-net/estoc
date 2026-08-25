/**
 * @estoc/folder-object — an object is a folder.
 *
 * - tree: hash a mapping into a UnixFS DAG (IPIP-499 `unixfs-v1-2025`,
 *   the same CID as `ipfs add`), verify an object set against a root,
 *   resolve one path block by block;
 * - object: read a mapping as an object (`index.json` + `files/…`),
 *   validate it, hash it to its version identity;
 * - card: sign an object as a did:key, verify a card;
 * - signed object: `{object/, card.jws}` as a mapping.
 *
 * Everything here is pure: bytes in, bytes out, no IO, no policy. It runs
 * in Node, workerd and the browser. Node `fs` is on `./fs`; the zip
 * container is on `./zip`.
 */

export type {
  TreeFiles,
  HashOptions,
  HashedTree,
  VerifiedTree,
  IndexJson,
  FolderObject,
  ObjectCard,
  CardSigner,
  SignedObject,
  MalformedLayer,
} from "./types.js";
export { MalformedObjectError } from "./types.js";
export { hashTree, verifyTree, resolvePath, type Resolved } from "./tree.js";
export { fileCid, isRawCid, isDagPbCid, compareNames, dagPbCode } from "./cid.js";
export { parseIndex, isInsideFiles, readObject, hashObject, contentOf } from "./object.js";
export { CARD_TYP, didKeyKid, signRoot, signObject, verifyCard, verifyObjectCard, type CardVerdict } from "./card.js";
export { signedTree, readAny, readSignedObject } from "./signed.js";
