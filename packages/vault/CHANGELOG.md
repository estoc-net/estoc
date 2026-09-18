# Changelog

## Unreleased

- **Version 3**, under `@estoc/vault/v3`: the code form of the
  replica model's vault events, channels, relationship policy and
  distributed delivery over `@estoc/event-store/v3`. Version 2 is
  untouched beside it.
- **Identifiers and values.** `types.ts` is one nominal type per kind
  of value a payload names, and the channel, an ordered pair of a
  local and a peer DID in canonical did:peer:4 short form (`Channel`,
  `channelOf`, `channelKey`, `compareChannels`, `sameChannel`).
  `ids.ts` derives the three UUIDv5 namespaces from the URL namespace
  and every ID a rule derives rather than mints: `inboundMessageId`
  and `executionId` from the canonical sender, recipient and wire ID,
  `anonymousMessageId` from the decrypting local key, `effectKey`
  over the tagged execution and effect type and `automaticMessageId`
  from it, and the reserved keystore names, each derivation checked
  against the published vectors.
  `canonicalPublicKey` is the did:key encoding a supported key's JWK
  or base58btc multibase form normalizes to, a Weierstrass point
  verified on its curve by `@noble/curves`, base58btc and base64url by
  `@scure/base`, the multicodec prefix by `multiformats`;
  `agreementKey` refuses an X25519 low-order point.
- **Event schemas, stored document and projections.**
  `readVaultEvent`, `readVaultDraft` and `vaultDraft` check the
  payload of each of the 28 event types — closed member set, types,
  spellings, the rules between members and the `roots` the type
  retains — and throw `InvalidPayload`; they never look up a
  referenced event or verify a JWT. `storeMessage`,
  `readStoredDocument` and `wireAttachment` are the stored message
  document and its wire form, meeting at the same bytes.
  `readPlaintext`, `wirePlaintext`, `semanticProjection`,
  `intentProjection`, `intentHash`, `plaintextHash`, `expandPleaseAck`
  and `requestsAck` are the projections and hashes; `from_prior` is
  kept as the original string, JWT or not.
- **Keys, communication DIDs, retained peer documents and proofs.**
  `Keys` derives every key by name from the one seed through
  `@estoc/keystore` and opens only over the seed that derives the
  recorded anchor; `mintDid` and `mintMediationDid` build the
  did:peer:4 input documents, `checkDidCreated` and
  `checkMediationCreated` read a recorded entity's own document back
  against the seed and the bound route. `peerResolution` takes a
  long form to the fixed retained document under its RFC 8785 bytes
  and raw CID, every service URI checked by its RFC 3986 grammar;
  `canonicalDidOf`, `authorizedMethodIds`, `methodPublicKey`,
  `didcommServiceUris` and `splitDidUrl` read DIDs and documents.
  `signFromPrior` issues the compact EdDSA JWT over `jose`;
  `fromPriorClaims`, `carriedClaims` and `verifyFromPrior` read a
  carried proof in three steps, the signature only against the
  issuer's immutable document; `verifyLocalProof` holds a rotation
  decision's frozen proof to its counterpart.
- **The folds**, under `fold/`, every one a pure function of the
  event set, the same over any permutation, with what needs the seed,
  the retained documents or the objects computed beside it and handed
  in as verdicts (`verifyDidKeys`, `verifyMediationKeys`,
  `verifyResolutions`, `verifyProofs`, `checkVault`, `scanVault`):
  `VaultEventSet`; `foldAuthors`, `foldLabel`, `foldMediations`,
  `foldRoutes` and `requiredReceivingSet`, a retired entity receiving
  while its route is not terminal; `heldRoots`, `foldErasures` and
  `readState`, the retention edge by edge; `foldChannelEvidence`, the
  sources, receipts, carriers and rotation decisions and which sources
  are positive; `foldContinuity`, the graph of channels whose edges
  replace one endpoint — the peer's by a carrier's verified proof,
  ours by a decision the peer or a verified successor has confirmed by
  writing to the predecessor — with conflicts found over the whole
  graph and authority granted only through channels free of them,
  answering each carrier's and decision's status, a channel's head,
  supersession, conflict, denials and decisions, and the
  role-preserving path an ACK may follow; `foldInvitations`, each
  one-use disclosure's consumption and candidates; `foldContacts`,
  the latest-wins table under each contact ID; `foldInbound`, one
  execution per input in its channel, complete once one member is a
  complete witness, its kind and first receipt key; `foldOutbound`,
  each message's intent, channel, packages, submission, failures,
  acknowledgments, effect against its source and work left, plus
  `notificationFor`, `ackTargets` and `inReplyTo`; `foldVault`, the
  whole over one set.
- **The views**, `fold/views.ts`, reached as `fold.views`: a channel
  with its inputs in first-receipt order, its outbounds, the problem
  reports peers sent beside the outbound each answers, and its send
  gate (`senderGate`, `channelPolicy`); a contact, or several shown as
  one, as the channels it selected followed by the related history
  verified continuity connects, each message once in its own channel,
  with `writeTo`, a `useDid` preference matched along verified local
  successors and `defaultWriteTo` only when one head is left.
- **The procedures**, `procedures.ts`, over a `VaultRuntime` under its
  lock: `vaultRetention`, `vaultHeldRoots` and `collectGarbage`;
  `eraseMessage` and `closeErasures`; `consumeInvitations`;
  `unfinishedWork`, what an open lists for manual action and
  dispatches nothing of — outbounds to prepare or dispatch, the pure
  ACKs and Ping replies established inputs may still be given under
  `responseChannel`, the notifications verified decisions permit, the
  notification conflicts, the proofs waiting for issuer material and
  the consumptions; `automaticIntent`; `decisionFor`, the decision a
  rotation away from a pair reuses; `blockChannels`; `deleteContact`,
  the tombstone with an optional denial of each selected channel and
  the erasure of every message their views show.
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
