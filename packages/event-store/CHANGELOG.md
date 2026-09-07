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
  chosen size (§5, DO-6), each a copy in memory of its own — a `Buffer`
  is a `Uint8Array` whose `slice` is a view, so nothing a source or a
  reader holds is shared with the store (§12); `putRaw`/`putObject` make
  it visible only whole, a wrong digest being `DigestMismatch` with
  nothing exposed (§6.1–6.2, DO-4), and a put over a CID already held
  holds the bytes verified now — one object still, sound again if what
  was held had gone bad underneath; `open` streams pull-on-read under a latch released on
  completion, failure or cancel, and rehashes on the way out — a
  corrupted object fails its stream and leaves the accepted namespace as
  `DamagedObject` (§6.3, DO-16); `read` refuses an object over `maxBytes`
  before allocating (`ObjectTooLarge`); `collect(keep)` checks every keep
  CID first, skips latched objects unlisted, reports unkept objects within
  grace as `young` and unlinks the rest, both in binary-CID order (§8.3,
  DO-10/11). `test/v3/suite/objectStoreSuite(name, open)` covers
  DO-1/2/3/4/6/7/10/11/15/16 and the latch rules; the folder store runs
  it next.

- **`Vault` v3 and the vault in memory** (v3 A05). The vault interface
  of event-store.md §10 under `@estoc/event-store/v3`: `Vault` — events
  to read (`scan`/`changes`/`damaged`/`conflicting`, nothing else),
  objects to read (no put, no collection), portable files, and
  `commit(objects, drafts)`, which under the writer lock validates every
  draft and every CID before reading a byte, accepts each object under
  `putObject`'s rules, requires every draft root — new or reused — to be
  present (`MissingRoot` otherwise), and appends one all-or-nothing
  batch (§10, §5.2, ES-3, DO-8); `VaultRuntime` — `author`,
  `generation`, the `vault`, `locked(op)`, `collect(keep)` and `ingest`
  — what a host opens and application code never sees; `Held`, the
  view an operation holding the lock works through, so a read nested in
  a commit, an import or an export shares the lock instead of waiting
  for itself, with `ingest`, `collect` and nested `locked`;
  `KeepUnderLock`, the keep set as a function called only once the pass
  holds the lock (§10, DO-19); `WriterLock`, the vault-wide lock for one
  process; `Runtime`, the lock, facade and held view over any three
  stores; and `MemoryVault`, the three memory stores under one runtime
  and one `LatchRegistry`. Through the facade a read of events, object
  metadata or files takes no lock; `open` takes it for the presence
  check and latch registration and releases it before the stream is
  consumed; `read` is `open` drained outside the lock, refused before
  allocation over `maxBytes`. Portable files, version 3 (§8.1,
  vault-folder.md §2, §7.1, §11.6): the `FileStore` interface,
  `checkPath` (no NUL, no backslash, no empty, `.` or `..` component,
  Unicode compared by code point, never normalized), the six owned roots
  a file store refuses to write, and `MemoryFileStore`; `checkPath`
  also refuses an unpaired surrogate, which no UTF-8 folder could hold.
  `ingest` fixes each input — a canonical copy, or a rejection with its
  error — before asking the source for the next (`canonicalEvent`,
  exported), so a source that reuses one object between yields is read
  as it yielded; a bounded `read` cancels the stream it opened on any
  failure, so no latch outlives a failed read. Tests: ES-3, ES-27,
  ES-28, ES-29, ES-30, DO-8, DO-18, DO-19.

- **Folder layout and the folder event store** (v3 A06). The folder of
  vault-folder.md, so far its events, under `@estoc/event-store/v3`:
  `kindOf(path)` and the root names of the layout (§3) — an entry
  inside a structural root that is not the layout's is damage, a
  top-level path outside every root an opaque portable file (VF-16);
  segment lines (§6, §8, §11.5) — `decodeLine` accepts exactly
  `canonicalEventBytes(event)`, parsed and compared as bytes, so bad
  UTF-8, a byte order mark, bad JSON, a non-canonical spelling, a bad
  envelope or an author the directory does not confirm is damage
  reported by `<path>:<line>` (VF-2, VF-9), `decodeSegment` reads a
  segment's complete lines and reports a trailing fragment without
  joining it to anything (VF-10), `encodeLines` writes them (ES-10);
  `local/replica.json` (§10.1) — `mintReplica`, `parseReplica`
  (exactly two members, both canonical UUIDv7; otherwise
  `DamagedReplica`, never a partial repair, VF-6), `readReplica`,
  `openReplica` (minted and written on first writable open, no event
  appended, VF-7); and `FolderEventStore` over the version-2
  `VaultBackend`, its author and generation the replica file's. It
  writes only under its own author directory: `append` to the newest
  segment when that ends in LF, to a fresh one when a crash or a failed
  write left a fragment — nothing is ever appended after a fragment, so
  it stays reportable damage whatever it spells (§8.1, VF-10) — and to
  a fresh one past `rotateBytes`; `appendAll` as a fresh segment
  written whole; `ingest` as one fresh segment per incoming author of
  decoded, reserialized events, nothing on `ForkedAuthor` (§8.2,
  VF-11). It reads every segment whatever the filter, confirms each
  line's author against its directory, keeps the first content per
  `eventId` by path order then line offset and reports every other
  with its `source` (§11.5), takes nothing from physical order (VF-12),
  and reports unknown entries under `events/`; `changes` tokens name
  the store generation and every segment's accepted length and are
  refused for another generation, a missing or shorter segment, a
  position inside a line or an unrecognized shape (§10.3).
  `validateDraft` now refuses a draft carrying `eventId`, `at` or
  `author` — an event handed back as a draft is refused, not re-minted
  (vault-folder.md §11.3) — for every store. `deepFreeze` is exported.
  The A03 `eventStoreSuite` runs over the folder store on
  `MemoryBackend` and `FsBackend`; folder tests cover
  VF-1/2/6/7/9/10/11/12/16 and ES-10. A file where `events/` itself
  belongs is damage at `events`, not an empty store (§3, §11.1), and
  `append`, `appendAll` and an `ingest` with something to add are
  refused there as `DamagedLayout` before anything lands;
  vault-folder.md §11.2 and §11.5 and event-store.md §5.4 now say what
  the store does — the accepted content per `eventId` is chosen over
  every author directory, and a filter only narrows the result.

- **The folder object store** (v3 A07). `FolderObjectStore` under
  `@estoc/event-store/v3`, the object side of vault-folder.md §9 and
  dasl-objects.md §10 over the same `VaultBackend`: one file per
  accepted object, `objects/<cid>`, flat, holding exactly the resource
  bytes — no extent directory, no chunk, no metadata node (VF-27,
  VF-28). A put streams its source into a staging file under
  `local/staging/objects/`, hashing as it goes and holding one chunk
  at a time (§5), refuses the chunk that crosses `maxObjectBytes`, and
  only once the whole stream has matched — the CID given, or the one
  computed — moves the file into `objects/` in one step (§6.1, §6.2,
  VF-31); a source that fails or mismatches leaves nothing, a crash
  leaves a staging file that is not an object and is swept once past
  grace (DO-4, DO-12, DO-17, §12). A read streams the file back,
  rehashing on the way out; a file whose bytes no longer spell its
  name fails the stream before completion, is moved to
  `local/damaged/objects/` — under a numbered suffix when the name is
  taken, and only if its bytes, read again in the store's turn, still
  do not spell its name, so a put that healed it meanwhile stands
  whatever its length or clock tick (r1-C) — and reads as absent from
  then on (§6.3, §8.2, DO-13, DO-16, VF-13). An object's orphan age
  counts from its acceptance, recorded as the modification time of a
  stamp file `local/accepted/objects/<cid>` written once the move into
  `objects/` has completed — any earlier stamp of the CID removed
  before the move — and rewritten by repeating acceptance (§9): not
  the object file's own time, which a backend sets at the last chunk,
  however long the source then idled or the move took (r1-D, r2-A);
  an object with no stamp — a crash before it, `local/` deleted — is
  of unknown age, stamped by the first collection pass that sees it
  and counted young; a stamp with no object is removed.
  `collect` unlinks exactly the unkept, unlatched objects past grace,
  with their stamps (§8.3). What is in `objects/` and
  not an object path — a name that is not a raw DASL CID, a directory,
  a file where the directory belongs — is reported by `damaged()`,
  listed as nothing, left alone by collection, and refused as
  `DamagedLayout` by every put when it is the root itself (§3, VF-16);
  `verify()` reads every object whole, moves the mismatched and the
  misnamed aside and reports them. The `VaultBackend` gained three
  members for bytes too large to hold whole: `open(path)` streams a
  file out, `create(path, source)` streams one in and makes it visible
  only once the source has ended — nothing, not even an empty file,
  stands at a fresh path before that, and a source that throws leaves
  the path as it was — and `rename(from, to)` moves a file into place
  over whatever stood there; `MemoryBackend`, `FsBackend` (a sibling
  temp file renamed into place, each chunk written until every byte
  is down, a write that makes no progress a failure (r1-A); `open`
  through a file handle in 64 KiB pieces) and `OpfsBackend`
  (`createWritable` over an existing file, aborted on failure; a temp
  sibling and `FileSystemFileHandle.move()` for a fresh path, `move`
  for `rename` too; a platform without `move` cannot fill a fresh
  path whole and is refused before it is touched, `rename` over an
  existing file still a copy through its writable (r1-B);
  `File.stream()`) all have them, and `FsBackend` takes a `clock`
  that stamps written files, for tests that age a file by the clock
  they pin. The A04 `objectStoreSuite` runs over the folder store on
  `MemoryBackend` and `FsBackend`; a framework-free
  `folderObjectCases` runs over those and, in Chromium, over OPFS
  (DO-5), and `opfsCases` shows the platform without `move`.

- **`MemoryBackend` copies bytes**: a Node `Buffer` given to `write` or a
  first `append`, or handed back by `read`, was kept or returned as a
  view onto the same memory — `Buffer#slice` is not a copy — so writing
  into it afterwards changed the stored file without a write. Every
  backend's suite now checks with a view-slicing input. It also refuses,
  as a file system does, a write below a file or onto a directory,
  instead of taking either into its flat map.

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
