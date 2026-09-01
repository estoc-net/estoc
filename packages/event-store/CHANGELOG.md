# Changelog

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
