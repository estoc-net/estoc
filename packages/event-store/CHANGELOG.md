# Changelog

## Unreleased

- **`@estoc/event-store/v3`**: the version-3 event model of
  `docs/replica-model/event-store.md`, built beside version 2 until the
  vault switches over (v3 A02). RFC 8785 canonical JSON — `canonicalize`
  and a `parseStrict` — jsonc-parser's scanner held to RFC 8259 — that
  refuses a duplicate member, an unpaired surrogate, a noncharacter and a
  number outside binary64 (§3.3); the six-field
  envelope `eventId`/`at`/`author`/`type`/`roots`/`data` with
  `validateEvent` and `validateDraft` (§3.4; `roots` are raw DASL CIDs
  from `@estoc/dasl`); `atOf`/`isCanonicalAt` for the one canonical
  millisecond spelling, `compareEvents` for `(at, eventId, author)`
  (§4.2–4.3); the `EventStore` interface (§5); and `mint`, which reads
  the clock once for `at` and takes `eventId` from the `uuid` package's
  standard UUIDv7 generator — the profile asks nothing of the generator
  beyond RFC 9562 (§4.2). No store yet.

- **`MemoryEventStore` v3 and the store suite** (v3 A03). The version-3
  event store as a map in memory, under `@estoc/event-store/v3`: `append`
  and `appendAll` validate every draft first and mint one `at` for the
  batch (§5.1–5.2, ES-19/20/22); `ingest` reads its whole input before
  writing, unions by `eventId`, counts duplicates under any serialization
  by canonical bytes, keeps the held value on a conflict, and throws
  `ForkedAuthor` — having added nothing — on an event of its own author
  it does not hold (§5.3, ES-5/6/7), and classifies its input against
  what is held under the writer lock, not before; what it holds,
  appended or ingested, is the form the canonical bytes parse to,
  frozen; `scan` sorts in canonical order and filters by equality
  (§5.4, ES-9); `changes` tokens name one generation — the instance's
  own, never given — one position and the event accepted before it, and
  are refused otherwise with `BadToken` (§5.5, ES-11/12). `test/v3/
  suite/eventStoreSuite(name, open)` is the conformance suite every
  version-3 store runs — ES-1/5/6/7/8/9/11/12/16/19/20/21/22 — the folder
  store next.

- **`MemoryObjectStore` v3 and the object suite** (v3 A04). The object
  model of `docs/replica-model/dasl-objects.md` under
  `@estoc/event-store/v3`: `ByteSource` in its three shapes, unified by
  `chunksOf`; `hashSource`, which hashes a source as it streams with
  `@noble/hashes` (a new dependency) and stops at the chunk that crosses
  the size bound; `rawCidOf`, the check every CID argument passes — a
  CIDv0, an uppercase or padded spelling, a DRISL, dag-pb, BLAKE3 or
  truncated identifier is `InvalidCid` from reader and writer alike (§3,
  DO-3/15); `rawCidFromDigest`; `compareCids`/`sortCids` for binary-CID
  byte order; the `ObjectStore` interface (§6); and `LatchRegistry`, the
  per-CID read latch of event-store.md §10, which the vault runtime will
  share. `MemoryObjectStore` holds an object in internal extents of a
  chosen size (§5, DO-6); `putRaw`/`putObject` make it visible only
  whole, a wrong digest being `DigestMismatch` with nothing exposed (§6.1–
  6.2, DO-4); `open` streams pull-on-read under a latch released on
  completion, failure or cancel, and rehashes on the way out — a
  corrupted object fails its stream and leaves the accepted namespace as
  `DamagedObject` (§6.3, DO-16); `read` refuses an object over `maxBytes`
  before allocating (`ObjectTooLarge`); `collect(keep)` checks every keep
  CID first, skips latched objects unlisted, reports unkept objects within
  grace as `young` and unlinks the rest, both in binary-CID order (§8.3,
  DO-10/11). `test/v3/suite/objectStoreSuite(name, open)` covers
  DO-1/2/3/4/6/7/10/11/15/16 and the latch rules; the folder store runs
  it next.

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
