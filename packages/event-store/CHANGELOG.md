# Changelog

## Unreleased

- **The portable snapshot: export, validation, inspection.**
  `exportVault(runtime, open, { heldRoots, maxBytes })` in
  `@estoc/event-store/v3` builds a portable snapshot of any runtime —
  the SQLite vault, an inspector's, the vault in memory — into the
  destination `open` gives (`(mode) => openNodeSqlite(path, { mode })`,
  `(mode) => pool.open(name, mode)`): under the operation lock the
  cut is selected — the events' tally first, from what the store
  keeps beside them, refused as the new `SnapshotTooLarge` past
  `maxBytes` before an event is read; then the wrapper, every event,
  the caller's `heldRoots` fold with each root present and sound,
  refused as `IncompleteSnapshot` on damage or a root absent or known
  damaged, or as `SnapshotTooLarge` when the events' bytes and the
  objects' sizes together pass `maxBytes`, before a chunk is read —
  nothing made; a conflict on record is a diagnostic, not damage, and
  does not refuse the export. The destination is then created, put in a rollback
  journal with `synchronous=FULL`, laid as a portable database with
  `ready = 0` in one transaction, filled object by object streamed
  through the vault's read, rehashed and chunked, 8 MiB a transaction,
  checked against the cut, set ready and closed, and only then is the
  lock released; outside it the file is reopened read-only and
  validated with no file bound — the file is the one the export just
  built and closed, its event and object payload within `maxBytes`
  when one was given — and what validation found — `{ events, eventBytes,
  objects, objectBytes }` — is returned. A source failing mid-copy is
  `IncompleteSnapshot`, the destination left unready.
  `openPortable(driver, { maxFileBytes })` bounds its input before
  anything else is read — the page count times the page size, all
  SQLite will read of the file — refusing `SnapshotTooLarge` past it,
  so everything after, validation included, lies within the bound; it
  now hands back `vault` too, the snapshot as
  a read-only `Vault` (`PortableVault`): canonical scans from the
  five tables, damage reported, `conflicting` empty, objects under
  their read and damage rules, `changes` and `commit`
  `UnsupportedOperation`, every read `VaultClosed` once closed; the
  handle runs no CHECK the file declares (`ignore_check_constraints`),
  `integrity_check` included. `validatePortable(portable, { heldRoots })`
  runs, in order, `foreign_key_check`; the chunks holding no more
  bytes than the objects declare, from record headers alone; `integrity_check`;
  every event row's decoding; every `objects` row's key and size; the
  object set against `heldRoots` of the snapshot's events; and every
  object's chunks read through and rehashed, and throws
  `InvalidSnapshot` naming every problem, a SQLite or driver refusal
  among them. The object store asks a chunk's length before its bytes,
  so a chunk longer than the layout gives it is refused unloaded.
  `HeldRoots`, `(vault: Vault) => Iterable<Cid>`, is the fold's type,
  usable as a `KeepUnderLock`; known-payload validation is the fold's.
  `EventStore.tally()` — `{ events, bytes }`, the rows counted and
  their canonical bytes summed with no event loaded — is new on both
  stores and on `Held`, for the export's bound: SQLite sums the
  column's lengths, the store in memory keeps a running total moved
  as each event is accepted, so neither allocates to answer.
  The event store's row decoding, filter SQL and column list are
  exported from its module for the portable reader (`decodeEventRow`,
  `readEventRows`, `eventFilterSql`, `EVENT_COLUMNS`).
  `test/v3/sqlite/export-cases.ts` runs on `node:sqlite` and in a
  Chromium Worker; `test/v3/sqlite/export.test.ts` adds what only a
  path shows.
- **The SQLite vault.** `SqliteVault` in `@estoc/event-store/v3`, a
  `Runtime` over an open runtime's `SqliteEventStore` and
  `SqliteObjectStore`: a commit's objects prepared under the writer
  lock while their sources stream, then published with their repairs,
  the events and the positions in the one `BEGIN IMMEDIATE`
  transaction of `appendAll`, the preparation settled after it, so
  nothing lands unless everything does; the keystore over the lock;
  `close()` admitting nothing more, waiting for what was admitted,
  then closing the database and ownership. `vault.local` is the
  runtime's own state in `local_*` tables made on first write:
  `options` (JSON by key), `cache` (bytes by namespace and key) and
  `trace` (entries in order, scanned by type and position, pruned by
  age and count), with `clearCaches()` emptying the cache and the
  trace only. The vault stops on damage to the history — commit,
  ingest and collection refused with `DamagedHistory`, collection
  because its keep set is folded from that history, reads and local
  state going on — and on a commit of unknown outcome: a `COMMIT`
  SQLite could not complete is the new `UncertainCommit`, after which
  the driver's `Connection` refuses every call until closed
  (`driver.uncertain` says so) and the vault with it, reads included,
  until a reopen recovers what landed; `stopped` says which.
  `openRuntime` takes `resetIdentity: true`, the recovery from
  `ForkedAuthor`: after every check, one transaction gives the
  runtime a fresh replica ID and generation and drops the cache, the
  history and options untouched. `SqliteEventStore.requireSound()` is
  public, for the vault's collection. The vault tests that hold for
  any runtime move from `test/v3/vault.test.ts` into `vaultSuite`
  (`test/v3/suite/vault-suite.ts`), run over the runtime in memory
  and the SQLite vault in memory and on files; `vault-cases.ts` runs
  on `node:sqlite` and in Chromium, and `vault.test.ts` kills a
  committing process after each of its statements in turn.
- **The SQLite object store.** `SqliteObjectStore` in
  `@estoc/event-store/v3`, over an open runtime's connection and
  writability: a put hashed as it streams and cut into the format's
  1 MiB chunks, staged in the connection's temporary database where
  no read sees them — a file on both platforms, `temp_store` set to
  `FILE` by both adapters and the wasm pool keeping, for every
  connection open, the handles its journals and temporary files will
  take, so no open or import in between takes them — under a 2 MiB
  page cache, so memory does not grow with the object
  — within `maxStagedBytes` across every preparation in flight, the
  put past it refused with the new `StagingFull` and nothing of it
  staged; accepted in one `BEGIN IMMEDIATE` transaction that moves
  the chunks under the CID with the `objects` row; a sound object
  already held left untouched, a known damaged one replaced whole;
  `prepare()` giving the vault's commit a
  `SqlitePreparation` — `putObject` and `has` as the `Preparation`
  interface has them, `publish()` inside the commit's transaction,
  `settle()` after it has committed to clear the damage of what it
  repaired, `discard()` to drop what is still staged; `open`
  streaming one chunk a pull, each checked against the layout the
  size gives the object, and verifying after the last that no other
  chunk is stored and the bytes hash to the CID, `read` the same walk
  into one buffer bounded before allocation, the size read as text so
  an integer past the safe range is damage rather than a failed read;
  damage of every kind a read can find — a wrong digest, a chunk
  missing, short or surplus, a chunk under an empty object, a size
  that is no count, a key that is no CID — known for the session,
  refusing `has`, `stat`,
  `open`, `read` and `list` with `DamagedObject` and listed by
  `damaged()`; a repair or a collection pass moving the CID's epoch
  so a stream open on the old bytes fails at its next chunk with the
  new `InterruptedRead` rather than read bytes of two generations;
  `collect` one transaction over the exact keep set, a damaged
  unheld object deleted with the rest and a kept one retained with
  its damage; every write refused with `ReadOnlyVault` over an
  inspector. The chunk size is the format's, not a setting. The
  conformance suite runs over it in memory and on files, and
  `test/v3/sqlite/object-cases.ts` runs on `node:sqlite` and in a
  Chromium Worker. The `Packer` the memory store cut extents with is
  now exported from the object model, handing each extent over as it
  seals, and both stores use it.
- **The SQLite event store.** `SqliteEventStore` in
  `@estoc/event-store/v3`, over an open runtime's connection, author,
  generation and writability: `append`/`appendAll` one `BEGIN
  IMMEDIATE` transaction writing canonical bytes, indexed columns,
  positions and `last_seq` together, with an optional `publish`
  callback run inside it for the vault's commit; `ingest` reading its
  input in full before one transaction that classifies, checks for a
  fork and accepts, recording rejected values once each in the local
  `local_conflicts` table for `conflicting()`, and `clearConflicts()`
  to empty it; `scan` in canonical order over one cut with the
  envelope filter in SQL and the `data` filter in code; `changes`
  over positions with a `{ generation, seq }` token that survives a
  reopen and refuses malformed, foreign-generation and future ones;
  every row decoded strictly, re-canonicalized and compared with its
  columns, damage left out of reads and listed by `damaged()` with
  its place and bytes, and once met — by any read, or by the survey a
  store makes before its first write — every write refused with the
  new `DamagedHistory`, `publish` included, until a validated snapshot
  is restored; a type holding a NUL stored and compared as bytes cast
  to text, read back through the new `decodeUtf8`; writes refused with
  `ReadOnlyVault` over an inspector. The conformance suite runs over
  it in memory and on files, and `test/v3/sqlite/event-cases.ts` runs
  on `node:sqlite` and in a Chromium Worker. Every batch entry —
  `appendAll` here and in memory, `Vault.commit`'s drafts and objects
  — is validated index by index, so a hole in a sparse array is
  refused. `checkSchema` refuses a table made `WITHOUT ROWID`.
- **The SQLite vault's schema, and how it is created and opened.** In
  `@estoc/event-store/v3`: `createTables` and `checkSchema`, the five
  common `STRICT` tables plus a runtime's two control tables, checked
  structurally through SQLite's pragmas — columns, types, keys with
  collation and direction, references with both actions — and each text
  column probed to collate byte for byte, with the schema's names read
  as stored bytes and the whitelist a map, so a table named like an
  inherited property is refused like any other; `createRuntime`
  publishing schema, metadata, wrapped seed and fresh local IDs in one
  transaction; `openRuntime` checking header, metadata, schema,
  wrapper, anchor (given, or derived by the caller's unlock) and
  control in that order and writing nothing, the text encoding read
  from `PRAGMA encoding` or, on a build without UTF-16 such as the
  wasm one, from the file header through `sqlite_dbpage` — every
  schema name read as bytes first and a file refused where one has a
  NUL, is not UTF-8 or is `sqlite_dbpage` in any case, before that
  read and on every platform — the singleton rows required to be the ones keyed 1, positions required
  positive; `openInspector` doing the same without the seed on a
  connection set to refuse every write, taking only a `readwrite`
  driver so it owns the file on every platform; `openPortable`
  checking a read-only snapshot's identity, rollback-format headers,
  schema and metadata rows and nothing else. `checkWrappedSeed` now
  checks the keystore package's JWE profile — algorithms, iteration
  bound, salt, header parameters, segment lengths — not just the
  shape. Handles carry the driver, the metadata, the local IDs and
  `keystore(locked)`, whose `rewrap` is one transaction under the
  caller's lock and which holds no statement past a call; a failed
  open closes its driver. New error `DamagedControl`, for local
  control that is missing or does not account for the events;
  `APPLICATION_ID` and `SCHEMA_VERSION` exported. The open cases run
  on Node and in Chromium. New dev dependency `@estoc/keystore`, for
  a wrapper fixture the package itself sealed.
- **The SQLite driver, under the version-3 stores to come.** `SqliteDriver`
  in `@estoc/event-store/v3` — one synchronous connection, `exec`,
  `prepare` to a `SqliteStatement` (`run`, `get`, `all`, `iterate`,
  `finalize`), `transaction(mode, body)` that does not nest, `close` —
  with the value rules both adapters share: `checkParams` admits text
  without a NUL or an unpaired surrogate, safe integers, finite doubles,
  bytes and null, copies bytes at both boundaries, and refuses the rest
  as `InvalidSqlValue` before the statement runs; a stored integer
  outside the safe range is `InvalidSqlValue` on read, never rounded,
  and so is stored text with a NUL or invalid UTF-8 where the adapter
  sees the bytes (wasm), with `decodeText` for reading a foreign file's
  text as `CAST(column AS BLOB)` on either platform; what SQLite refuses
  is `SqliteError` with its result code. Opens are
  `create`/`readwrite`/`readonly` with `DatabaseExists`,
  `DatabaseMissing`, `DatabaseBusy` and, after close, `DatabaseClosed`;
  a `readonly` open excludes writers while it is open. `openNodeSqlite`
  in `@estoc/event-store/node` is `node:sqlite` (Node 22.13+), ownership
  by SQLite's exclusive locking mode with no descriptor opened beside
  SQLite's, a read-only open of a WAL file owning the file outright
  under `query_only`; `openSqlitePool` in the
  new `@estoc/event-store/browser` is `@sqlite.org/sqlite-wasm` over its
  OPFS access-handle pool in a Worker, ownership of the directory by a
  Web Lock keyed by the directory's normalized spelling, databases
  stored as `<name>.sqlite` so no name spells another's journal, a pool
  that grows for opens and imports alike — one at a time, so two
  started together never take one name or count one spare handle twice
  — and refuses every call once closed, with `exportFile`/`importFile`
  for the portable snapshot to come. `Connection`,
  `RawConnection`/`RawStatement`, `checkParams`, `decodeText`,
  `exactInteger` and `ownBytes` are exported for a third adapter. New
  dependency `@sqlite.org/sqlite-wasm`.
- **v3 aligned with the SQLite specification; the folder vault retired.**
  The replica model's storage moved from a folder to one SQLite file
  (`docs/replica-model/vault-sqlite.md`; `vault-folder.md` is gone), and
  what was built for the folder goes with it: `FolderEventStore`,
  `FolderObjectStore`, `FolderVault`, `FolderReader`, the folder layout,
  segments, replica file and local stores, `exportVault`/`restoreFolder`/
  `importFolder` and the barrier under `import/`, the pid-file ownership
  protocol, and the `open`/`create`/`rename`/`own` members the
  `VaultBackend` had grown for them (`VaultOwned` and `Ownership` too);
  `FileStore`, `checkPath` and `MemoryFileStore`, since the model has no
  portable files any more; `LatchRegistry`, since the model has no read
  latch. The SQLite vault is written next, in `src/v3/sqlite/`; until
  then `@estoc/event-store/v3` is the model and its reference in memory.
  What stays changed to match: `ObjectStore.collect` returns
  `{ removed }` — the exact unkept set, deleted at once, no orphan grace,
  no `young`; a read that finds an object's bytes not to hash to its CID
  makes it known damaged for the session — `has`, `stat`, `open` and
  `read` fail with `DamagedObject`, `list` fails on reaching it — until
  `putObject`/`putRaw` replace it with verified bytes or collection
  removes it (a sound object already held is idempotent, its bytes
  untouched); `Vault` gained `metadata` and lost `files`; `commit`
  refuses a supplied object no draft names as a root
  (`UnreferencedObject`) before reading a byte, fixes the batch it
  checked before reading it, and publishes its objects and events
  together or not at all: they are verified into a `Preparation` no
  read sees — not `has`, `stat` or `list` — and published in the one
  transaction that appends the events, a failure undoing only that
  commit's own preparation; `Stores.transaction` is required, and
  `Runtime` refuses stores without it; `MemoryObjectStore.prepare`
  is new and its `transaction` gone; `MemoryEventStore.appendAll`
  takes an optional `publish` step that lands with the batch; the
  mutations an operation issues through `Held` — `commit`, `ingest`,
  `collect` — run one at a time in the order issued, so a commit
  issued while a collection pass computes its keep set lands after the
  pass; once the operation has returned, a `Held` accepts no further
  mutation (`UnsupportedOperation`), but a mutation it accepted and the
  operation did not wait for still finishes before the lock is
  released, and reads through the view — a queued collection pass
  computing its keep set — stay good until it has; once the last has
  finished, a `Held` kept past its operation refuses every call —
  mutation, `open`, nested `locked`, read (`UnsupportedOperation`) —
  since it is no longer inside the lock nor the runtime's guard; the
  view a keep callback gets refuses a
  mutation before touching its source rather than wait on the pass
  itself; `WriterLock.idle` is new;
  `VaultRuntime` gained `metadata` and
  `keystore`, a `KeystoreAccess` whose `rewrap` runs under the writer
  lock; `Runtime` takes an options object; `MemoryVault` takes
  `metadata` and an optional `wrapped` seed; `VaultMetadata`,
  `WrappedSeed`, `checkMetadata` and `checkWrappedSeed` are new;
  `UnsupportedOperation` is new, for the read-only snapshot view to
  come; `DamagedLayout`, `PendingImport`, `Unprotected` and
  `UnsettledRead` are gone. The entries below that describe the folder
  (A06–A10) are history: what they added is no longer in the package.

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
  whatever its length or clock tick — and reads as absent from
  then on (§6.3, §8.2, DO-13, DO-16, VF-13). An object's orphan age
  counts from its acceptance, recorded as the modification time of a
  stamp file `local/accepted/objects/<cid>` written once the move into
  `objects/` has completed — any earlier stamp of the CID removed
  before the move — and rewritten by repeating acceptance (§9): not
  the object file's own time, which a backend sets at the last chunk,
  however long the source then idled or the move took;
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
  is down, a write that makes no progress a failure; `open`
  through a file handle in 64 KiB pieces) and `OpfsBackend`
  (`createWritable` over an existing file, aborted on failure; a temp
  sibling and `FileSystemFileHandle.move()` for a fresh path, `move`
  for `rename` too; a platform without `move` cannot fill a fresh
  path whole and is refused before it is touched, `rename` over an
  existing file still a copy through its writable;
  `File.stream()`) all have them, and `FsBackend` takes a `clock`
  that stamps written files, for tests that age a file by the clock
  they pin. The A04 `objectStoreSuite` runs over the folder store on
  `MemoryBackend` and `FsBackend`; a framework-free
  `folderObjectCases` runs over those and, in Chromium, over OPFS
  (DO-5), and `opfsCases` shows the platform without `move`.

- **The folder vault** (v3 A08). `FolderVault` under
  `@estoc/event-store/v3`, the vault of vault-folder.md §11.1 and §15
  over the three folder stores. `FolderVault.openWritable(backend, {
  anchor })` reads `config.json` under its closed member set — format
  `estoc`, the integer 3, `identity.anchor.{key,did}` and nothing
  else, another version refused in words that name the one this
  reader opens (§4, §16) — checks `keystore.json` by shape, `{ version:
  3, seedJwe }` and nothing else, a derived-key cache refused (§5,
  VF-24), compares the anchor DID the caller derived from the unlocked
  seed with the config's (`AnchorMismatch`), takes writer-exclusive
  ownership through the backend before creating any local state,
  refuses while anything stands under `import/` (`PendingImport`,
  VF-40), reads or mints `local/replica.json`, and opens the event
  store as that replica (VF-1, VF-4, VF-5, VF-6, VF-7, ES-14).
  `FolderVault.create` checks the keystore and the anchor — by the
  same parser an open uses — before anything is taken or
  written, requires the folder empty of everything but ownership's own
  files, before and again after ownership is taken, so a seed wrapper,
  a segment, recovery state, an opaque file or leftover local state is
  refused with every byte left as it was, then writes
  `keystore.json` and `config.json`. `close` refuses every new
  operation, lets the accepted ones run out — the writer lock's, and
  each local owner's — fails every object stream still alive with
  `VaultClosed`, releasing its latch, and only then releases ownership;
  nothing that changes the folder runs in a store turn
  after the close — a quarantine a damaged stream queued behind it
  does nothing, `verify` is refused — so the folder is the next
  owner's alone once close has returned; every local owner,
  cache and trace handle checks the vault's guard on each call. `FolderReader.open` is the
  read-only open: no `local/` created, `files.write` refused as
  `ReadOnlyVault`, object streams served only with `ownership:
  "exclusive"` and otherwise refused as `Unprotected` (§15), over an
  object store that puts nothing, collects nothing and moves nothing —
  a file found not to spell its name is reported and dropped from the
  reader's view, never quarantined. `local(owner)` is this
  copy's `options.json`, `cache/` and trace streams under
  `local/<owner>/` (§10.2), ported from version 2 with `eventId` for
  `eid`, trace lines canonical JSON read by the strict parser and
  segments named at the store's clock. `FolderFileStore` reads
  `config.json`, `keystore.json` and opaque paths, writes opaque paths
  only, and lists nothing under `local/` or `import/` (§11.6, VF-39).
  `damaged()` reports what every structural root holds that the layout
  does not define (VF-16).
  The `VaultBackend` gained `own(path)`: ownership of a name, exclusive
  against every holder in every process reaching the folder, refused
  at once as `VaultOwned` — `FsBackend` a pid file holding `<pid>
  <thread> <origin> <token>` (`src/node/ownership.ts`), created whole
  by claim file and hard link, read back, a live holder refused — a
  record is judged live from the disk alone, by no memory of the
  module's, since a copy in another realm of the thread shares none:
  live while the process it names is, a Node worker's
  included, since workers share a pid and differ in thread id, and a
  worker's record outlives the worker until its process exits; one
  naming this very thread is live while its origin — the millisecond
  the process began, `performance.timeOrigin`, the same in every
  realm and copy — is this incarnation's, and a previous
  incarnation's otherwise, stale; so two takes in one
  thread cannot both pass, whichever copy each came through. Nothing
  is removed from the name after a read: a
  stale file — dead, a previous incarnation, empty, garbage — is
  taken off it only by moving it aside under a marker and judging
  what moved, a live holder's file moved by mistake given its name
  back; a take that is over is withdrawn — a holder releasing, a
  taker giving up a name taken beside a marker or moved off it by a
  mover's mistake, or failing at any point after its line reached the
  name — under a notice of the withdrawal beside the name: every copy
  of its line in sight, at the name, under a marker, in the claim a
  failed take left, is gathered as a `gone` copy of the take, pass
  after pass, and the copies are dropped, and the notice with them,
  only once they are all the links the file's inode has — a count
  that is exact whatever moves between two looks, where no order of
  looking at the name and the markers could be, since a restore
  moves a line one way and a reclaim the other. A restore that meets
  the notice hands the line over instead of giving it the name — from
  its marker before the link, off the name again after — and never
  drops a copy that could be the last; a pass that finds the line
  nowhere looks at the markers once more before believing it taken by
  hand, since after the notice a line leaves the name only for a
  marker and a marker only for a copy in the withdrawal's hands. So no
  restore can leave the line at the name with nothing to release it,
  however it interleaves with the withdrawal; every try is a new line
  with its own token, so a restore still expecting the old one can
  never mistake the next for it, and a failed take leaves nothing that
  bars the next. Where the disk has no hard links — a USB stick, a
  network mount — a take is an exclusive create and a restore a
  rename, which takes the marker away in the instant the line reaches
  the name; a restore whose marker is gone by the time it moves has
  nothing left to restore.
  A restore that cannot give a moved holder its name
  back within its budget — a taker stalled between its take and its
  look — leaves the marker standing and fails the mover's take, so
  the moved holder's record bars every taker until a later sweep
  completes it; a stale taker's file at the name is taken off it by
  the restore the same way, and a marker gone from under it is done;
  `OpfsBackend` a Web Lock named for
  the one path from the origin's storage root to the name, so one place
  reached through two handles and bases is one lock, and a
  directory the storage root cannot place refused; `MemoryBackend` a
  set. `Runtime` takes a `guard` run as each operation asks for the
  lock.

- **Interchange** (v3 A09). `exportVault(runtime, into, { heldRoots })`
  writes any runtime's vault — in memory or over a folder — as a
  portable folder into an empty backend, under the writer lock from
  selecting the cut to publication: every event rendered afresh as
  canonical bytes, one segment per author; every portable file; every
  present object through the store's verified stream; `config.json`
  and `keystore.json` checked as a restore would; and the held roots,
  computed by the fold handed in under that same lock, each required
  present and sound, or the export aborts unpublished.
  `restoreFolder(from, into, { heldRoots })` reads a portable folder
  into an empty backend, the portable half only — never `local/`,
  never `import/`, a source with anything under `import/` refused as
  `PendingImport` — validated whole before a byte is written: config,
  keystore shape, every structural root holding only what the layout
  defines, every segment line under its author, no conflict, every
  held root of that event set among the source's objects; objects are
  verified as they stream. Both own the destination while laying it
  down and publish by writing `config.json` last; a failure withdraws
  what the run wrote, its publication first, and leaves everything
  standing when the publication cannot be withdrawn; a destination
  another laying filled between the check and ownership is refused
  untouched. `MemoryVault` takes `config` and `keystore` so that a
  vault in memory can be exported. New errors `IncompleteSnapshot` and
  `InvalidSnapshot`.

- **Import into an existing vault, and the barrier under `import/`**
  (v3 A10). `importFolder(vault, from, { heldRoots })` merges a portable
  folder of the same vault — the same anchor, or `AnchorMismatch` —
  into an open `FolderVault`, under its writer lock from the first look
  at the target to publication. Everything is decided before a byte is
  written: the source read and validated as a restore reads it; the
  target's event set required whole; every source event a duplicate,
  a conflict — the target's kept and the source's reported — or new,
  unless its author is this replica's, which is `ForkedAuthor` and
  writes nothing; the held roots of the merged set computed by the
  fold, each required to have sound bytes in the target already —
  read whole and rehashed in the preflight, nothing moved — or among
  the source's objects, which are the objects copied and the only
  ones, a copy landing over a target file that no longer spells its
  name; a source file copied when the target has nothing at its path,
  left when the target has a file there, and refused when it would
  land on a directory — an empty one on disk too, which the parent's
  listing shows — or under a file of the target, as is an object that
  would land on a directory; the target's config and keystore never
  touched; a root with sound bytes nowhere, or a collision, is
  `IncompleteImport`. The writes go through the barrier: every item
  — one fresh segment per incoming author, each object verified as it
  streams, each file — staged under `import/<uuidv7>/staged/` at the
  path it will have; then `journal.json` written beside them naming
  them all; then each moved to its place, objects before the segments
  that name them; then the journal and the directory removed. The
  moves run in the event store's turn
  (`FolderEventStore.publishing`): a read of the runtime that arrives
  meanwhile waits and sees the union whole, never half; and in the
  object store's (`FolderObjectStore.publishing`), so that a
  quarantine which rehashed the target's damaged file before the
  repair landed moves aside the damaged bytes, never the repair. A
  `FolderReader` without ownership shares the folder with whatever
  writer holds it: its event store (`shared: true`) answers a read
  only once it is shown to be a view the folder was in at one moment
  with no import being published — `import/` empty after the read,
  and a listing taken then naming the same segments at the lengths
  the read found and the same entries beside them that are not
  segments, which suffices since no segment is ever removed or
  shortened — reading again while it is not and refusing as
  `UnsettledRead`, new, after four tries, its `detail` naming what
  stood in the way; a segment's unfinished write beside its place —
  the sibling `tempName` names — is never such a view, since the
  reader cannot tell the writer's in progress from what a crash left,
  so it is read past and then refused, and only a store with
  ownership reports it as damage — a directory under such a name is
  not one, since a backend writes the sibling as a file, and either
  store reports it as damage; an import in progress is
  `PendingImport`. A `FolderReader` with ownership looks at `import/`
  once it holds the folder, so a writer that failed an import and
  released meanwhile cannot leave it the segments that landed to
  serve as the whole. A writable open, once it holds ownership and
  before any store opens, finishes an import whose journal it finds —
  items still staged moved, ones already at their place left — and
  rolls back staging that never reached a journal, whatever became of
  `local/` meanwhile, the sibling a backend was writing a staged item
  or the journal to when the process died included; a read-only open
  takes up neither and reports both as `PendingImport`. Whatever
  under `import/` is not exactly a shape this version leaves — a file
  at the top, a directory not named by a UUIDv7, a journal that does
  not parse or names paths of another shape, a journal that is a
  directory, a file or directory beside the journal and `staged/`, a
  staged file or directory on the way to nothing the journal names
  or, without a journal, to no publishable path, an unfinished write
  beside a journal that stands, an item found neither staged nor
  published — blocks the writable open as `PendingImport`, with
  `detail` saying what, and nothing under `import/` touched; the
  journal is read with noncharacters allowed, since a portable file's
  name may hold one. `FsBackend` and `OpfsBackend` name the sibling
  they write a whole file to through `tempName`, and
  `unfinishedWriteOf` reads the name back.
  A failure before the journal withdraws the staging; a journal write
  that fails is taken to have landed unless the staging can then be
  removed whole; one after the journal leaves the import the next
  open's to finish and halts the runtime — `FolderVault.halt()`, new:
  every operation queued for the writer lock is refused as its turn
  comes, every read that takes no lock is refused, then the vault
  closes and releases ownership — so that no collection pass or fold
  already waiting runs over the union half published. For that
  `Runtime`'s guard is asked again as an operation takes the lock and
  by each lock-free read, and `FolderEventStore` takes a `guard`
  asked as each read takes its turn. Importing the same folder again
  adds nothing and writes nothing. `parseStrict` takes
  `{ noncharacters: true }`. `VaultBackend.remove`
  now removes an empty directory too, and refuses one with entries —
  `FsBackend` by `rmdir`, `OpfsBackend` as `removeEntry` always did,
  `MemoryBackend` by the files under the name — so a finished import
  leaves no directory behind. `FolderVault.backend` is public; the
  folder's shared checks (`OWNER_FILE`, `checkEmpty`, `layoutDamage`)
  moved to `folder/roots.ts`.

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
