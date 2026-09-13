# Changelog

## Unreleased

- **Version 3 begins**, under `@estoc/vault/v3`: the identifier
  vocabulary as nominal types, the deterministic identifiers — the six
  UUIDv5 namespaces derived from the URL namespace, `relationshipId`,
  `contactIdOf`, `earlyPrivateDidId`, `inboundMessageId`, `executionId`,
  `effectKey`, `automaticMessageId`, the stored `decimalOrdinal` and
  the reserved keystore names — and `canonicalPublicKey`, the did:key
  encoding a supported key's JWK or base58btc multibase form normalizes
  to, a Weierstrass point verified on its curve by `@noble/curves`,
  base58btc and base64url by `@scure/base`, the multicodec prefix by
  `multiformats`, with `parsePublicKey` for the exact canonical form and
  `decodePublicKey` for its type and bytes. Each is checked against
  the published identifier and public-key vectors.
- **The version-3 event schemas, stored message document and
  projections**: `readVaultEvent`, `readVaultDraft` and `vaultDraft`
  check the payload of each of the 33 event types — closed member set,
  types, spellings (DIDs, DID URLs by their full RFC 3986 grammar, key
  names, UUID versions, CIDs, hashes), the rules between members and the
  `roots` the type retains — and throw `InvalidPayload` otherwise; they
  never look up a referenced event or verify a JWT. `storeMessage`,
  `readStoredDocument` and `wireAttachment` are the stored message
  document and its wire form, meeting at the same bytes: a stored
  inline descriptor always carries its byte count, and a payload is put
  back on the wire only when its length matches and, for JSON, it is
  already canonical. `readPlaintext`, `wirePlaintext`,
  `semanticProjection`, `intentProjection`, `intentHash`,
  `plaintextHash`, `expandPleaseAck` and `requestsAck` are the
  projections and hashes; every additional header, `__proto__`
  included, is an own member of the intent.
- **The version-3 keys, communication DIDs, retained peer document and
  `from_prior`**: `Keys` derives every key by name from the one seed
  through `@estoc/keystore`, the Ed25519 key and the separately derived
  X25519 key of each name, the latter for key agreement, and opens only over the
  seed that derives the recorded anchor; `mintDid` and
  `mintMediationDid` build the did:peer:4 input document of a
  communication DID (two keys and the route's DIDComm service) or of a
  mediation arrangement (the two keys of one name, no service); `checkDidCreated` and
  `checkMediationCreated` check a recorded entity by reading its own
  document back against the seed's keys and the bound route.
  `peerResolution` takes a long form to the fixed retained document —
  the raw bytes read as strict JSON, the method's input-document rules
  and the members' shapes enforced, every relationship reference
  resolved — under its RFC 8785 bytes and raw CID; `canonicalDidOf`,
  `authorizedMethodIds`, `methodPublicKey`, `didcommServiceUris` and
  `splitDidUrl` read DIDs and retained documents. `signFromPrior` and
  `verifyFromPrior` are the compact EdDSA JWT over `jose`, verified
  against the exact pinned predecessor document only. `@estoc/did-peer`
  exports `decodeLongForm`.
- The version-2 peer-key fingerprint's base32 is `@scure/base`'s
  `base32nopad`, lowercased; the output is unchanged.

## 0.2.0 — 2026-09-01

The version-2 vault is the package. What was `@estoc/vault/v2` is now
the root entry, and the version-1 format — `VaultBackend` and its
backends, the layout constants, `SegmentedLog`, the contact and
invitation stores, the message and delivery logs, `BlobStore`, the
trace log, `snapshotVault` / `importVault`, `Vault` — is deleted with
its tests and `docs/vault-format.md` retired. The folder, its backends
(`MemoryBackend`, `OpfsBackend`, `FsBackend` in
`@estoc/event-store/node`), blobs, local state, the trace and
interchange live in `@estoc/event-store` (`docs/event-store.md`,
`docs/vault-folder.md`); this package is what the events mean
(`docs/vault-events.md`).

- `exports` is `"."` only: `./node` is gone with `FsBackend` (import it
  from `@estoc/event-store/node`), `./v2` is the root.
- Everything `@estoc/vault/v2` exported is exported here unchanged: the
  event types and `readVaultEvent`, `peerKeyOf` / `fingerprint`,
  `EventSet`, `VaultFold`, `drafts`, the procedures (`record`,
  `recordMessage`, `eraseMessage`, `deleteContact`, `holdImported`,
  `importPolicy`, `collectBlobs`, `readRoot`, `sweepDeleted`, …),
  `Keys` with `MintDid`, `createFolderVault` / `openFolderVault`.
- A version-1 folder is refused on open (`NotAVault`), as it was by
  `@estoc/vault/v2`; there is nothing to migrate.

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
- `TraceLog.setPolicy(policy)`: keep by another policy from now on (a device
  preference changing while the vault is open); `policy` is a getter.
- **`trace/`, the trace log** (`docs/vault-format.md` §6.10): what this
  device observed, apart from what was said — `TraceLog` with five
  streams (`envelope`, `wire`, `wire.bytes`, `mediation`, `diag`), each
  line `{ stream, tid, at, event, parent?, mid?, … }`. The one log that
  is deleted from: a `TracePolicy` gives every stream a `keepMs` and a
  `capBytes`, segments rotate at a mebibyte or a day, and `prune()`
  unlinks whole segments by name — never a line — and leaves a `prune`
  line in `diag` when it was the cap that did it. `traceOf(mid)` follows
  `parent` both ways to hand back the whole onion of one message.
  `TRACE_OFF` / `TRACE_NORMAL` / `TRACE_VERBOSE` and `tracePolicy(level)`
  are the presets; `Vault` takes `{ trace?: TracePolicy }` (default
  normal) and exposes `vault.trace`. Scheduling `prune()` is the
  caller's. Never in a snapshot, never laid down by an import.
- `VaultBackend.size(path)`: a file's size without reading it, or null.
  Prune reads names and sizes, never contents. Every backend here has it;
  a backend elsewhere must add it.
