/**
 * @estoc/signed-dir — the trust layer of the signed-directory design:
 * hash a folder into a merkle tree and sign/verify the root card that
 * makes the tree someone's.
 *
 * This branch is the UnixFS experiment: the tree is a UnixFS DAG under
 * IPIP-499's `unixfs-v1-2025` profile (raw leaves, 1 MiB chunks, dag-pb
 * directories, HAMT sharding) instead of the dag-json encoding on main.
 * Same snapshot, same CID as `ipfs add` in kubo ≥ 0.40. Empty
 * directories are rejected on both the hash and verify sides.
 *
 * Everything is a pure function over bytes passed in: no IO, no storage,
 * no policy. Reading files (OPFS, R2), keeping objects, deciding whether
 * an expired or older card is acceptable, resolving DIDs to keys — all
 * caller's. One source runs unchanged in Node, workerd, and the browser.
 *
 * What stays out, by design: CAR packing and gateway serving (wire
 * layer, comes with the relay), `_redirects` interpretation (client
 * convention), and the DIDComm publish message (protocol layer).
 */

export type { TreeFiles, HashedTree, RootCard, CardSigner } from "./types.js";
export { hashTree, verifyTree, resolvePath, type Resolved } from "./tree.js";
export {
  fileCid,
  isRawCid,
  isDagPbCid,
  compareNames,
  dagPbCode,
} from "./cid.js";
export { createCard, verifyCard, type VerifiedCard } from "./card.js";
