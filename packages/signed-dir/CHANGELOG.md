# @estoc/signed-dir

## 0.4.0 — 2026-08-24

The root card is now testimony about a tree, not a pointer to one:
`RootCard` is `{ did, root }`.

- `id`, `expires`, and the `root: null` takedown form are gone. All
  three served the public-folder relay, where a card was a mutable
  "DID → current root" pointer needing ordering, a TTL, and a way to
  point at nothing. Over an immutable tree (the folder-object bundle
  card) none of that applies: replaying a signature over a fact changes
  no state, a fact does not expire, and a fact cannot be un-signed —
  retraction is a new version, currency is the tree's own `id` /
  `updated` and the reader's mutable references. If a pointer statement
  is ever needed again it will be a separate statement type, not this
  signature.
- `root` is required and must be a string; `verifyCard` rejects null.
- `verifyCard` drops unknown payload members, so a legacy card still
  verifies as `{ did, root }`.

## 0.3.0 — 2026-08-24

Tree hashing rebuilt on UnixFS under IPIP-499's `unixfs-v1-2025` profile
(CIDv1, sha-256, raw leaves, 1 MiB chunks, balanced layout, 1024 links,
HAMT past 256 KiB block-bytes), replacing the dag-json directory nodes.
Every tree hashed by 0.2.0 re-roots.

- Same snapshot, same root as `ipfs add` — cross-checked against kubo
  0.43.0 for a directory tree, a chunked 2 MiB file, a HAMT-sharded
  directory, and empty directories (golden vectors in tree.test.ts).
- Single-block files (≤ 1 MiB) keep the exact raw CID 0.2.0 computed;
  only directory nodes and chunked files re-root.
- The profile is taken whole, **empty directories included**:
  `hashTree({})` roots the well-known empty directory
  (`bafybeiczss…f354`); new `HashOptions.dirs` lists directories to
  create whether or not files live under them (ancestors implied,
  duplicates no-ops, a file path a conflict); `verifyTree` and
  `resolvePath` accept a zero-link directory node like any other.
- `verifyTree` now returns `VerifiedTree { files, dirs }` — path → CID
  for files and for directories (root under `""`) — instead of the bare
  file map, so an empty directory is reported rather than invisible.
- `verifyTree` enforces canonical link order in flat directory nodes
  (UTF-8 byte order, kubo's order) — dag-pb decode is lenient, so the
  check lives here.
- API shifts: `HashedTree.nodes` now holds every block except
  single-block file roots (leaf chunks included); `DirEntry`,
  `isDirCid`, `encodeDirNode`, `decodeDirNode` are gone (codec bits no
  longer separate file from directory — a dag-pb CID can root either);
  new `isRawCid` / `isDagPbCid`; `resolvePath` reassembles chunked file
  bytes, so a file read is O(depth + chunks) fetches.
- Runtime deps: `ipfs-unixfs-importer`, `ipfs-unixfs-exporter` added;
  `@ipld/dag-json` dropped.

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
