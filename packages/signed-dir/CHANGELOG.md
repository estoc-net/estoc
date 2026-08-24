# @estoc/signed-dir

## Unreleased — `unixfs-hash` branch experiment

Tree hashing rebuilt on UnixFS under IPIP-499's `unixfs-v1-2025` profile
(CIDv1, sha-256, raw leaves, 1 MiB chunks, balanced layout, 1024 links,
HAMT past 256 KiB block-bytes), replacing the dag-json directory nodes.

- Same snapshot, same root as `ipfs add` — cross-checked against kubo
  0.43.0 for both a directory tree and a chunked 2 MiB file (golden
  vectors in tree.test.ts).
- Single-block files (≤ 1 MiB) keep the exact raw CID the dag-json
  branch computed; only directory nodes and chunked files re-root.
- Empty directories are rejected on both sides: `hashTree({})` throws,
  and `verifyTree` fails a directory node with zero entries (deliberate
  deviation from the profile's "included (opt-out)").
- `verifyTree` also enforces canonical link order in flat directory
  nodes (UTF-8 byte order, kubo's order) — dag-pb decode is lenient, so
  the check lives here.
- API shifts: `HashedTree.nodes` now holds every block except
  single-block file roots (leaf chunks included); `DirEntry`,
  `isDirCid`, `encodeDirNode`, `decodeDirNode` are gone (codec bits no
  longer separate file from directory — a dag-pb CID can root either);
  new `isRawCid` / `isDagPbCid`; `resolvePath` reassembles chunked file
  bytes, so a file read is O(depth + chunks) fetches.
- New runtime deps: `ipfs-unixfs-importer`, `ipfs-unixfs-exporter`.

## 0.2.0 — 2026-08-21

Takedown cards, per public-folder/1.0: `RootCard.root` is now nullable
(`string | null`, still required).

- A card with `root: null` asserts "I publish nothing" — the takedown
  form. `createCard` signs it as-is; `verifyCard` returns it with
  `root: null`.
- Null is the **only** encoding: a payload *missing* the `root` field
  (or carrying a non-string, non-null value) is rejected as a malformed
  root card. A takedown is destructive, so it must be written
  deliberately — a producer bug that drops a field must not mint a
  valid takedown card (RFC 7386's null-means-removal idiom, DID Core's
  explicit `deactivated`). Verifiers need a single check:
  `card.root === null`.

## 0.1.0 — 2026-08-19

Initial release: IPLD-notation merkle hashing (raw file CIDs + dag-json
directory nodes) — `hashTree` / `verifyTree` / `resolvePath` — and the
signed root card (`createCard` / `verifyCard`, compact JWS EdDSA verified
with zero-dependency WebCrypto). Pure functions, no IO.
