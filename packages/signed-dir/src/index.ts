/**
 * @estoc/signed-dir — the trust layer of the signed-directory design:
 * hash a folder into an IPLD-notation merkle tree (raw file CIDs +
 * dag-json directory nodes) and sign/verify the root card that makes the
 * tree someone's.
 *
 * Everything is a pure function over bytes passed in: no IO, no storage,
 * no policy. Reading files (OPFS, R2), keeping objects, deciding whether
 * an expired or older card is acceptable, resolving DIDs to keys — all
 * caller's. One source runs unchanged in Node, workerd, and the browser
 * (sha-256 and Ed25519 via WebCrypto).
 *
 * What stays out, by design: CAR packing and gateway serving (wire
 * layer, comes with the relay), `_redirects` interpretation (client
 * convention), and the DIDComm publish message (protocol layer).
 */

export type {
  TreeFiles,
  DirEntry,
  HashedTree,
  RootCard,
  CardSigner,
} from "./types.js";
export { hashTree, verifyTree, resolvePath, type Resolved } from "./tree.js";
export {
  fileCid,
  isDirCid,
  compareNames,
  encodeDirNode,
  decodeDirNode,
} from "./cid.js";
export { createCard, verifyCard, type VerifiedCard } from "./card.js";
