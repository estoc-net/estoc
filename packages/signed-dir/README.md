# @estoc/signed-dir

Owner-signed directory trees: hash a folder into a UnixFS merkle tree,
and sign/verify the **root card** that makes the tree someone's.

The trust contract is three pieces — *(object set, recursive hash, signed
root card)* — and a reader holding them can trust a whole tree without
understanding its contents. This package computes and checks the three
pieces; it never does IO, holds no file bytes beyond hashing them, and
decides no policy. One source runs unchanged in Node (≥20), Cloudflare
workerd, and the browser (sha-256 and Ed25519 via WebCrypto).

The hash notation is UnixFS under IPIP-499's `unixfs-v1-2025` profile —
CID/IPLD **as a format, not as infrastructure**. The same snapshot roots
the same CID here and in `ipfs add` (kubo ≥ 0.40), empty directories
included:

- file object = for a file ≤ 1 MiB, the bare bytes, named by a CIDv1
  (`raw` codec, sha-256 — the same digest R2 checksums, WebCrypto, and
  SRI compute); a larger file roots in a dag-pb node linking raw 1 MiB
  chunks (balanced, 1024 links per node);
- directory object = a dag-pb UnixFS directory node (links in UTF-8 byte
  order; HAMT-sharded past 256 KiB of block bytes), named by its CID;
  the empty directory is the well-known `bafybeiczss…f354`;
- root = the root directory node's CID.

No DHT, no IPNS, no pinning: addressing stays DID + path, CIDs are the
integrity and object-exchange names.

```sh
npm install @estoc/signed-dir
```

## Usage

```ts
import {
  hashTree,
  verifyTree,
  resolvePath,
  createCard,
  verifyCard,
} from "@estoc/signed-dir";

// Vault side: hash a flat snapshot (path → bytes; the shape
// agent-core's snapshotVault produces). Empty directories have no
// path, so they are listed separately.
const tree = await hashTree(files, { dirs: ["drafts"] });
// tree.root                → the CID the root card signs
// tree.nodes               → every block but single-block files
//                            (dir nodes, shards, chunks; CID → bytes)
// tree.files               → single-block files by their raw CID
//                            (CID → path in `files`); the object set
//                            is `nodes` plus those bytes

// …and sign the root card (any keystore Signer fits CardSigner)
const jws = await createCard({ did, root: tree.root }, signer, `${did}#key-1`);

// Relay/reader side: verify a card, then either a whole object set…
const { card } = await verifyCard(jws, (kid) => resolveEd25519Key(kid));
const { files, dirs } = await verifyTree(card.root, objects);
// files: path → file CID; dirs: path → directory CID (root under "")

// …or one path with O(depth + chunks) fetches, each hop proven against
// its CID
const hit = await resolvePath(card.root, "posts/2026/first.html", getObject);
```

## What stays out, by design

- **Reading and storing** — OPFS/R2/filesystem are the caller's; bytes
  pass through parameters only.
- **Acceptance policy** — `verifyCard` proves *who signed what*. The
  card is testimony about a tree, not a pointer to one, so it carries no
  issue order, expiry, or takedown form; "is this the current version"
  is answered by the tree's own contents, never by the signature.
- **CAR packing / gateway serving** — wire layer, arrives with the relay.
- **`_redirects` and other filename conventions** — interpretation is
  client-side; the tree is content, not protocol.
- **The DIDComm `publish` message** — protocol layer.

## Golden vectors

The test suite pins root CIDs cross-checked against kubo 0.43.0 (a
directory tree, a chunked 2 MiB file, a HAMT-sharded directory of 2200
entries, and empty directories alone and nested) plus a raw file CID
against an independent sha-256, so a dependency upgrade that shifts
canonical encoding fails loudly instead of silently re-rooting every
tree.
