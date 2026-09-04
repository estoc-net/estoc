# Changelog

## Unreleased

- **Blocks are DASL** (`docs/event-store.md` §5.1; `@estoc/folder-object`
  0.7.0, whose tree is one DRISL manifest over raw leaves). A name is a
  DASL CID — CIDv1, sha-256, codec `raw` (`bafkrei…`) or `drisl`
  (`bafyrei…`), base32 lower, one spelling — parsed by `@estoc/dasl`, the
  parser every layer shares. A file is one raw block whatever its size:
  `put` hashes bytes to their raw CID and keeps them as they are; there
  is no 1 MiB bound, no chunking, no dag-pb root. A received object comes
  in by `putBlock` as its manifest and its leaves. The check is three
  things: a DASL CID, the hash, and for a drisl block one canonical DRISL
  document — the strict decoder takes it and the encoder gives the same
  bytes back — whose links are DASL CIDs; not the manifest shape, which
  is `@estoc/folder-object`'s judgment, so a DRISL block that is not a
  manifest is not damage. `get` of a drisl root throws `NotAFile`: a
  document is not a file. What a root reaches: raw nothing, drisl every
  link anywhere in the document (`linksOf`). No migration: a dag-pb name
  is not a DASL CID and a store refuses it like any other.
- Removed: `PROFILE`, `MAX_RAW_BYTES`, `DAG_PB_CODE`, `decodeNode` and
  `Node`, with the UnixFS dependencies (`ipfs-unixfs`,
  `ipfs-unixfs-importer`, `@ipld/dag-pb`, `multiformats`). Added:
  `DRISL_CODE`, `decodeDocument`, the `DaslCid` type `checkBlock` and
  `parseCid` now return.
- **`reach(roots, get)`**: the walk `reachable` makes, also saying what
  it asked for and did not find — a root, or a link of a reached block
  — under which nothing is known. `reachable` is its `reached`. For a
  caller that must not go on past an absent block: a delivery that
  would otherwise put a partial object on the wire.

## 0.1.0 — 2026-09-01

- The event model of `docs/event-store.md` §2–§4: envelope validation,
  canonical order, JSON equality, the filter, `EidMinter`.
- `EventStore`, `BlobStore` (§5), `FileStore` (§6) and `LocalEventStore`
  (§7.2) interfaces.
- In-memory stores for all three, and the block functions of the
  `unixfs-v1-2025` profile they are built on.
- Conformance suites `storeSuite` and `blobSuite`.
- The folder of `docs/vault-folder.md`: `VaultBackend` with
  `modified`, the memory, OPFS and Node `fs` backends; the folder
  event, blob and file stores; `FolderLocalEventStore` and
  `LocalOwner` for `local/`; `FolderVault` with extension stores and
  `dispose`. The backend cases run against OPFS in a real browser.
- Interchange (`docs/event-store.md` §10, `docs/vault-folder.md` §10):
  `snapshot`, `exportVault`, `importVault` with an `ImportPolicy` the
  vault supplies, `restoreFolder` (tolerates a `local/` without
  `self.json`), and `zipFiles` / `filesFromZip` for the shape a backup
  travels in.
