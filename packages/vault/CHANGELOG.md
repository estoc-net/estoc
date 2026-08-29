# Changelog

## 0.1.0 — 2026-08-29

The `.estoc` format on its own. Everything here moved out of
`@estoc/agent-core` 0.16 unchanged in behaviour — `VaultBackend` with
`MemoryBackend` and `OpfsBackend`, the layout constants, `SegmentedLog`,
the contact and invitation stores, the message and delivery logs,
`BlobStore`, `snapshotVault` / `importVault`, and `Vault` — with two
changes at the edges:

- `Vault` no longer knows did:peer:4. `Vault.open(backend, { mint })` and
  `Vault.create(backend, { …, mint })` take a `MintDid`:
  `(identity, serviceUri) => { did, … }`, deterministic. `setMediator`,
  `mintPairwise`, `createInvitation` and `peerIdentity` call it and
  record what it returns; the type of what it returns is the vault's
  type parameter (`Vault<M>`). `@estoc/agent-core` binds it to
  `mintPeerDid` (`openVault`, `createVault`, `PeerVault` there).
- `FsBackend`, a folder on disk, moved here from `@estoc/daemon` as
  `@estoc/vault/node`, and now keeps the mode of a file it replaces (a
  keystore made 0600 stays 0600).
