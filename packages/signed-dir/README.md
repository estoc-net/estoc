# @estoc/signed-dir

Owner-signed directory trees: hash a folder into an IPLD-notation merkle
tree, and sign/verify the **root card** that makes the tree someone's.

The trust contract is three pieces — *(object set, recursive hash, signed
root card)* — and a reader holding them can trust a whole tree without
understanding its contents. This package computes and checks the three
pieces; it never does IO, holds no file bytes beyond hashing them, and
decides no policy. One source runs unchanged in Node (≥20), Cloudflare
workerd, and the browser (sha-256 and Ed25519 via WebCrypto).

The hash notation is CID/IPLD **as a format, not as infrastructure**:

- file object = the bare bytes, named by a CIDv1 (`raw` codec, sha-256 —
  the same digest R2 checksums, WebCrypto, and SRI compute);
- directory object = dag-json `{"entries":[{name,type,hash,size}…]}`
  (name-sorted; canonicalisation is the codec's), named by its CID;
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
// agent-core's snapshotVault produces)
const tree = await hashTree(files);
// tree.root                → the CID the root card signs
// tree.nodes               → dir objects to push (CID → dag-json bytes)
// tree.files               → file objects to push (CID → path in `files`)

// …and sign the root card (any keystore Signer fits CardSigner)
const jws = await createCard(
  { did, id: uuidv7(), expires, root: tree.root },
  signer,
  `${did}#key-1`,
);

// Relay/reader side: verify a card, then either a whole object set…
const { card } = await verifyCard(jws, (kid) => resolveEd25519Key(kid));
const pathToCid = await verifyTree(card.root, objects);

// …or one path with O(depth) fetches, each hop proven against its CID
const hit = await resolvePath(card.root, "posts/2026/first.html", getObject);
```

## What stays out, by design

- **Reading and storing** — OPFS/R2/filesystem are the caller's; bytes
  pass through parameters only.
- **Acceptance policy** — `verifyCard` proves *who signed what*; whether
  the card is expired (`expires` is the DNS-TTL analogue) or older than
  the one you hold (`id` is uuidv7 — "newer" is a string comparison) is
  read-time policy.
- **CAR packing / gateway serving** — wire layer, arrives with the relay.
- **`_redirects` and other filename conventions** — interpretation is
  client-side; the tree is content, not protocol.
- **The DIDComm `publish` message** — protocol layer.

## Golden vectors

The test suite pins the root CID of a fixed snapshot and a raw file CID
(cross-checked against an independent sha-256 implementation), so a
dependency upgrade that shifts canonical encoding fails loudly instead of
silently re-rooting every tree.
