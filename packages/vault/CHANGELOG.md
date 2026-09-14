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
  resolved, every service carrying an endpoint whose string form is an
  RFC 3986 URI with any bracketed host validated as IPv6 by `ipaddr.js`
  or as IPvFuture by its URI grammar —
  under its RFC 8785 bytes and raw CID; `canonicalDidOf`,
  `authorizedMethodIds`, `methodPublicKey`, `didcommServiceUris` and
  `splitDidUrl` read DIDs and retained documents. `signFromPrior` and
  `verifyFromPrior` are the compact EdDSA JWT over `jose`, verified
  against the exact pinned predecessor document only. `@estoc/did-peer`
  exports `decodeLongForm`.
- **The first version-3 folds**, under `fold/`: `VaultEventSet` holds
  every event once by ID, reads each version-3 event against its schema
  on entry and keeps an invalid or unknown-typed one for its roots
  without applying it, hands a type's events out in canonical order and
  resolves a typed reference to its target as present, missing or
  mismatched. `foldAuthors` and `foldLabel`; `foldMediations` (one
  consistent creation, one grant, retirement, conflicts, the preferred
  arrangement); `foldRoutes` (each route's consistent configuration,
  retirement, conflict, usability and terminal dependency; each local
  DID entity's consistent record, own document read back, route target,
  disclosures in canonical order, retirement, faults, conflict and
  liveness; the reverse maps from key name and from either spelling to
  the entity; the desired mediator recipient set; whether an entity may
  still receive, eligible, pending or terminal, what is terminal
  settled before what is missing); `requiredReceivingSet`;
  `foldInvitations` (each one-use OOB disclosure's consumers, read from
  the root-address receipts that name it as `pthid` at the disclosed DID
  through a binding whose own evidence holds together, pending receipts
  whose evidence is missing and which hold a one-use invitation until
  it arrives, inconsistent receipts that the evidence already here
  contradicts, which hold nothing, the conflicts — disclosures of one ID that
  disagree, two consumers of one use — availability and `consumable`,
  consumable, pending or unavailable, so a caller waits on what is
  missing and turns away only what is settled); `foldContacts` (origin,
  tombstone,
  petname, flags, DID preference, peer DID seeds by exact add reference,
  display groups from `contact.merged`, and faults for a removal that
  names nothing it can remove). Every fold is a pure function of the
  set, the same over any permutation. `verifyDidKeys` and
  `verifyMediationKeys` run the seed check beside the fold and return the
  verdicts a fold takes as `keyChecks`, and `foldWithSeed` does both
  folds with every verdict in; an entity or arrangement the seed has not
  confirmed is pending, never live, usable, preferred, desired or
  required. A document that does not read, or that sends elsewhere than
  its bound route, is that entity's conflict and stops nothing else.
  `checkDidCreated` and `checkMediationCreated` are now composed of the
  exported `didDocumentOf`, `documentSendsTo`, `routeServiceUri`,
  `checkDidKeys` and `checkMediationKeys`.
- **The relationship fold**, `fold/relationships.ts`: `foldRelationships`
  groups `relationship.bound` by ID — equivalent bindings (one root local
  DID, one canonical peer DID, one document CID, whatever resolution
  events they name) are one, incompatible ones a conflict, and the root
  must hold together: resolution at the local DID's key-agreement key,
  distinct addresses deriving the ID — and folds the two chains from
  it. The local chain follows `relationship.localTransitioned`, the
  peer chain `relationship.peerTransitioned`; every edge is judged on
  its own evidence first, whether or not the binding stands yet — a
  successor entity in conflict, a predecessor or successor reference
  of another type, a prior or successor resolution that says otherwise
  or whose snapshot is not its document's, a local key outside a
  complete local history, a carrier bound elsewhere or whose
  observation group is in conflict, a trigger that confirms nothing or
  is control input, a proof found invalid are its own conflicts; the
  proof check, the successor's creation or resolution and the snapshot
  verdicts, a witnessing observation in a complete group, the
  predecessor's confirmation by input scoped to this relationship are
  what it waits for — and only then are equal edges merged (one proof
  to one successor DID; a successor snapshot not here yet is no second
  document, two here that differ are), so a contradiction in one
  duplicate is never covered by another; at each node the one class
  leaving it is applied and every applied member names the node, a
  cycle or a predecessor snapshot that is not the chain's document
  conflicts, competing classes conflict, and no timestamp ever picks a
  branch. The observations of one message are judged as a group in
  the relationship, each by the row it claims — authenticated by its
  own checked resolution, arrived at a key of the local history, and
  a root sender under the pinned root document, a successor under the
  applied transition it names, or a carrier whose proof names its
  sender and that an applied transition witnesses. One that
  contradicts (another key, another spelling, a message ID it does
  not derive, a snapshot that is not its document's, a key no node
  and no local edge of the relationship adds, a transition of
  another relationship, a proof found invalid) conflicts the group,
  and a group in conflict witnesses no proof and confirms no
  address; one whose evidence is absent waits alone, and a witness or
  a confirmation is an observation whose own row is complete in a
  group without conflict. Since that scope
  comes from the peer chain and a peer edge's key from the local
  chain, the two are folded together until nothing changes. Each
  relationship exposes
  `localChain`, `peerChain`, `currentLocalDidId`, `currentPeerDid`,
  `recipientKeyNames`, the one `contactId` or a conflict of several,
  `deferred` and `faults`. The fold exposes every transition's status,
  the address index — `claimants(localDid, peerDid)` over every
  historical pair of every relationship, a pair two relationships reach
  a conflict for each — `retainedDidIds` for `requiredReceivingSet`,
  and the pending claims a proof-free delivery must wait at: a committed
  carrier whose proof names its sender and has no applied transition,
  or a deferred edge at every pair it would add. Beside the fold,
  `verifyResolutions` checks every `peer.resolved` snapshot against its
  own document — its presented spelling one of its canonical DID's,
  the document derived from a numalgo-4 long form, or read from the
  object store under its CID in canonical form and, for a numalgo-4
  DID, required to be exactly what its own long form derives — for
  the method IDs it enumerates and the key it authenticates, and
  `verifyTransitions` checks every proof
  against the exact predecessor document, a local edge's against the
  predecessor entity's own, a peer edge's against the named prior
  resolution's; `foldRelationshipsVerified` folds with both verdicts
  in. An unchecked root snapshot leaves the binding standing on
  nothing, an unchecked edge is deferred, never applied.
  `fromPriorClaims` reads a proof's claims without verifying it.
  `bindingHolds` is now shared with the invitation fold. The fold also
  exposes every observation's standing, `observations`, as the
  relationship its row gives it scope in, waiting, contradicting or
  anonymous, and every message ID's observations as a group,
  `groups`, complete when all are scoped in one relationship and agree
  on the intent, so what consumes received evidence reads one
  judgement; an observation whose row holds is still a contradiction
  when the pair it arrived at is in another relationship's history
  too.
- **The outbound, held-root and profile folds**. `foldOutbound`
  (`fold/outbound.ts`) groups `message.out` by message ID: equal
  intents are one logical message, different ones a conflict that
  keeps every package and works nothing; the consistent packages, a
  package recorded with two contents, prepared for two messages or
  carrying another intent being a fault; each package's retirement,
  package-scoped failure and submission; `submitted` once a package
  that belongs, of a message that stands, has a committed submission,
  closing the message for good — a submission of a package still
  waiting or contradicting releasing nothing, and what another package
  waits for or an execution conflict found later taking nothing back;
  the first message-scoped failure; the message's membership
  in its relationship — a birth that derives the ID and agrees with
  the binding, a relationship that stands and does not contradict,
  each package sent from a node of the local chain (one a local edge
  would add waits, any other is outside), carrying exactly the proof of
  the transition that added its sender or none from the root, to a
  recipient resolution taken at its key, verified against its document
  and pinned by a node of the peer chain (one a peer edge would add
  waits); the one ACK-bearing response per execution, a second message
  ID conflicting both; an automatic intent's carrier, every
  observation whose own row is scoped under the relationship and wire
  ID deriving the execution proving the intent it carried to that
  relationship alone, and two that disagree — at the peer's prior and
  successor keys, or in one group — contradicting the execution
  whatever their groups later wait for, contradict or take in from
  another relationship, else one group complete in the intent's
  relationship, else waiting, else — anonymous, scoped elsewhere, in
  conflict — a contradiction; `ackWitnesses`, the
  complete scoped observations of complete groups in the relationship
  whose `ack` names the message, applied only once membership is
  verified, the earliest as `receiptInstant`, `late` at or after
  `expiresTime`; a `delivery.acknowledged` event checked against the
  observations it names by the same witness rule — the message's
  membership, resolution, scope, group and relationship, a
  contradiction of any final whatever the others still wait for — its
  diagnostics kept apart as `ackDeferred` / `ackFaults` since receipt
  information changes no work, outcome or retention; the displayed `outcome` in its precedence, and `work` —
  prepare, submit these packages, repack these, or nothing and why —
  from the events alone, the clock and the bytes being the worker's:
  work waits while a local transition of the relationship is still
  unjudged, and a package from a successor no scoped input — of any
  type, a problem report included — has confirmed is submittable only
  with the transition's proof. `heldRoots` (`fold/held.ts`) is what collection
  keeps: every root an accepted event retains, an unknown or unreadable
  event's and a resolution's pinned document included, less what an
  erasure released from that message,
  and a prepared envelope only while `retainEnvelope` — not erased,
  the message neither submitted nor failed, the package neither retired
  nor failed — holds, a disputed or intent-less package held until
  erased; `foldErasures` and `readState`, erased before absent.
  `foldProfiles` (`fold/profile.ts`) lifts each relationship's
  `claimedName` from its latest complete scoped inbound source, the
  observations of one wire ID and intent in the relationship being one
  source at whatever keys they arrived, `nameConflict` when one source
  was lifted two names, and `shared` as the earliest intent event of
  the latest submitted, verified disclosure of our profile; sources are
  ordered by their earliest event, never by the lift, and a lift whose
  source is missing or unscoped waits while one whose source is
  anonymous, elsewhere, contradicting or of another type is a fault.
- **The inbound fold and the contact view**. `foldInbound`
  (`fold/inbound.ts`) reads every `message.in` into an observation
  with its receipt key, the exact integer ordinal then the author, and
  the executions the observations derive: one wire ID in one
  relationship is one execution and the logical message, the
  observations of every group scoped there at whatever local key each
  arrived and under whatever peer key the sender used, so a repack or a
  verified rotation converges on one; its intent is proven by every
  observation whose own row is scoped there, two that disagree
  contradicting the execution whatever their groups later wait for or
  contradict, else one complete group completes it, one waiting defers
  it and groups that all contradict conflict it; a complete execution
  is classified — application input, or a pure acknowledgment, an
  address notification whose proof a transition validated, an Empty or
  ping response in a thread an outbound of the relationship opened, a
  no-response error, or a control type that fails its predicate, which
  is neither application input nor executable — and carries its first
  receipt key and earliest observation; anonymous groups are messages
  of their own; two events of one author under one ordinal are a
  receipt conflict that keeps their messages from being fresh
  acknowledgment targets and changes nothing else; `nextReceiptOrdinal`
  is one above every ordinal here, erased messages and every author
  included. `ackTargets` gives the wire IDs a complete carrier may
  acknowledge, each requested ID that is a complete, conflict-free
  execution of the carrier's own relationship, in first-receipt order,
  never by the clock. `foldOutbound` now takes the inbound fold and
  reads an automatic intent's carrier from its execution, one judgement
  for both. `foldContactViews` (`fold/contacts.ts`) is what a contact
  holds through the relationships uniquely assigned to it and nothing
  else: each with its standing, the ones another contact contests, the
  latest claimed name and the disclosures of our profile across them,
  the non-retired local addresses and the current ends, `writeTo` —
  standing, not contradicted, the contact not deleted, the current
  local end live and no local transition unjudged — and the ones
  `useDid` prefers, the thread of complete application messages by
  earliest observation, control input and anything unresolved left out,
  and the diagnostics of `foldDiagnostics`: the same-DID key change, an
  authenticated proof-free observation at one of the relationship's
  keys from its current peer DID under a document the peer chain does
  not pin, at an address pair the relationship alone claims, kept out
  of the thread and never scoped, and the remote error, a no-response
  problem report whose parent thread names exactly one outbound of the
  relationship among those with a package history — consistent or
  disputed, since dropping a contradicted candidate could make another
  unique — that one compatible: its own standing verified and a package
  of it a verified member of the chains, no package contradicting, and
  another package's wait taking nothing from it; its code shown while
  its body is here and unerased; ambiguity, a candidate waiting or
  contradicted, absence and erasure each supply none. `Outbound` now
  carries `standing`, the message's own standing — one intent, birth
  and binding agreeing, the relationship standing — apart from its
  packages and carrier, what a submission completes under; intents
  that disagree under one ID are that standing's conflict.
  `readProblemReports` reads the reports' bodies from the objects
  beside the fold and admits only a well-formed problem code: sorter,
  scope and descriptors in lower kebab-case, a code without a
  descriptor read as the protocol only asks senders to include one. An observation whose execution two scoped
  observations put in intent conflict acknowledges nothing and names
  nothing: `foldOutbound` reads the execution beside the row and group
  for every witness, and `foldProfiles` now takes the inbound fold and
  makes the execution the logical source, one in intent conflict a
  fault of every lift from it, whatever the source's own group still
  waits for. `SourceKey`, `keyOf` and `compareKeys`
  move to `fold/set.ts`.
  The test scene of two vaults is shared by the relationship, outbound,
  held-root and profile tests as `test/v3/fold/scene.ts`.
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
