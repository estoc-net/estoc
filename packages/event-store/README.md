# @estoc/event-store

The vault as an event store: the code form of
[`docs/event-store.md`](../../docs/event-store.md).

**Version 3 is being built beside this**, under `@estoc/event-store/v3`,
as the code form of the
[replica model](../../docs/replica-model/README.md): the
[event store](../../docs/replica-model/event-store.md), the
[DASL object profile](../../docs/replica-model/dasl-objects.md) and the
[SQLite vault](../../docs/replica-model/vault-sqlite.md). What is there
so far is the model, its reference in memory, and the SQLite driver the
persistent stores are written against; the stores themselves, and with
them export, restore and import, come next.

The event model: RFC 8785 canonical JSON and a strict parser; the
six-field envelope `eventId`/`at`/`author`/`type`/`roots`/`data` and its
validation, `roots` being raw DASL CIDs from `@estoc/dasl`; canonical
order; the `EventStore` interface; and minting — `at` from the clock,
`eventId` from `uuid`'s standard UUIDv7 generator. `MemoryEventStore` is
the reference the others are measured against, with `ForkedAuthor` and
`BadToken`, and `eventStoreSuite` in `test/v3/suite/` is the conformance
suite every version-3 store runs.

The object model: raw DASL objects hashed as they stream, whole-resource
identity however large, the `ObjectStore` interface, and
`MemoryObjectStore`, the first store — with `InvalidCid`,
`DigestMismatch`, `ObjectTooLarge` and `DamagedObject`, and
`objectStoreSuite`. A read rehashes on the way out and fails before it
completes when the bytes no longer spell their name; from then on the
object is known damaged — `has`, `stat`, `open` and `read` fail, `list`
fails on reaching it, absence is never how damage shows — until a put of
the same CID replaces it with verified bytes, or collection removes it.
`collect(keep)` deletes exactly the unkept, at once and whatever their
age: no orphan grace, no read latch; a stream open when its object is
collected or replaced completes with the bytes it opened on, or fails,
never truncates.

Over both, the vault: `Vault` — its immutable `metadata` (version 3 and
the anchor DID), events to read, objects to read, and `commit(objects,
drafts)`, the one way a local event is written, which refuses a supplied
object no draft names as a root before reading a byte and publishes its
objects and events together or not at all — and `VaultRuntime`, what a
host opens: `locked(op)`, the vault-wide writer lock, whose operation
works through `Held`, the same vault sharing the held lock, its
mutations run one at a time in the order issued: once the operation
has returned, the view accepts no further mutation, but what it
accepted still finishes before the lock is released, with reads
through the view good meanwhile, and once the last has finished the
view refuses every call;
`collect(keep)`, the keep set a function called only under the lock,
through a view that reads and refuses to mutate;
`ingest`; and `keystore`, the `KeystoreAccess` to the wrapped seed —
`read` a detached value, `rewrap` a replacement under the lock, the
check that it opens to the same seed being the unlocked host's.
A commit's objects are verified into a `Preparation` no read sees and
published in the transaction that appends its events, so the two land
together or not at all. `MemoryVault` is the two memory stores under
one runtime; `Runtime` builds the same over any two stores and the
transaction that publishes them, which every backend supplies.

Under the stores to come, the SQLite driver: `SqliteDriver` — one
synchronous connection, `prepare`d statements with positional
parameters (`run`, `get`, `all`, `iterate`), `exec`, and `transaction`,
which does not nest and never spans an `await` — and what a value must
be to cross it, decided once in `checkParams` for both adapters: text
without a NUL or an unpaired surrogate, an integer in the safe range,
any other finite number as a double, bytes (copied at both boundaries,
so neither side holds the other's buffer), or null; anything else, a
bigint or a boolean included, is `InvalidSqlValue` before the statement
runs, and a stored integer outside the safe range is `InvalidSqlValue`
on the read that meets it, never rounded. Stored text that is not text
— a NUL inside, invalid UTF-8, which only a foreign file or a cast in
SQL puts in a TEXT column — is `InvalidSqlValue` where the adapter can
see the bytes (wasm); `node:sqlite` hands text over already cut at a
NUL and repaired, so text of a file another party wrote is read as
`CAST(column AS BLOB)` and decoded with `decodeText`, which refuses
exactly that, on either platform. What SQLite itself refuses is
`SqliteError` with its result code on either platform. An open is
`create`, `readwrite` or `readonly`: a create needs a target nothing is
at (`DatabaseExists`), the others one that exists (`DatabaseMissing`),
and a writable open takes ownership — a second open of the same target,
in this process or another, is `DatabaseBusy` until the first closes;
a read-only open hardens the connection for a file another party wrote
(no writes, no extension loading, `trusted_schema` off) and excludes
writers for as long as it is open. After `close` every call is
`DatabaseClosed`.

Two adapters. `openNodeSqlite(path, { mode, journal? })` under
`@estoc/event-store/node` is `node:sqlite` (Node 22.13 or later; it
prints an ExperimentalWarning on first use): ownership is SQLite's
exclusive locking mode, taken by an empty immediate transaction so no
page is written before the vault is validated, and met by any other
connection as `SQLITE_BUSY` at its first statement; a create leaves the
file in WAL with `synchronous=NORMAL`, the runtime's configuration, or
with `journal: "delete"` in a rollback journal with `synchronous=FULL`,
the portable snapshot's, whose file must stand alone with
rollback-format headers; a read-only open of a rollback-journal file
keeps the shared lock its first read takes, so writers are excluded
while other readers are not, and a read-only open of a WAL file takes
the write lock as a writable open does — a WAL reader keeps no lock a
writer would meet — and forbids writes through `query_only`, letting
SQLite recover the WAL on open and checkpoint it on close.
`openSqlitePool({ directory })` under `@estoc/event-store/browser` is
`@sqlite.org/sqlite-wasm` over its OPFS access-handle pool, in a Worker
only: the pool owns one OPFS directory, `open(name, mode)` a database
in it (each stored as `<name>.sqlite`, so no name can spell the journal
SQLite keeps beside another; the pool grows as databases, their
journals and imports need handles), `exportFile`/`importFile` deliver
and take a complete database file, and ownership of the directory is a
Web Lock taken before the pool is installed and held until `close`, so
a second Worker of the origin is refused before it touches the
directory; the directory's one normalized spelling names both the lock
and the VFS, so two spellings contend and two directories never share
a pool, and a closed pool refuses every call. The driver cases in
`test/v3/sqlite/driver-cases.ts` run over both, Node on a file and in
memory and Chromium in a Worker; the pool's own cases are in
`test/browser/pool-cases.ts`.

Everything below is
version 2, which stays until the vault switches over.

What is here is the **model**, the **seam**, and the **folder**:

- the event — envelope (`eid`, `at`, `author`, `type`, `blobs`) plus
  an opaque `data` — its validation, canonical order (`at`, then
  `eid`, then `author`), structural equality, and the equality
  `Filter`;
- the three interfaces every vault store implements: `EventStore`
  (`append`, `ingest`, `scan`, `changes`), `BlobStore` (a block store
  of the `unixfs-v1-2025` profile with `collect` by age) and
  `FileStore`;
- `MemoryEventStore`, `MemoryBlobStore`, `MemoryFileStore` — the
  reference semantics, and what folds are tested on;
- the block functions a store's blob side is made of: `hashFile`,
  `checkBlock`, `readFile`, `reachable`;
- the `LocalEvent` shape a trace uses;
- the folder ([`docs/vault-folder.md`](../../docs/vault-folder.md)):
  `VaultBackend` — the bytes interface, with `MemoryBackend`,
  `OpfsBackend` and (from `@estoc/event-store/node`) `FsBackend` —
  and over it `FolderEventStore` (`devices/<dev>/<seg>.jsonl`),
  `FolderBlobStore` (`blobs/<cid>`, aged by modification time),
  `FolderFileStore` (every other path, by shape), the
  `FolderLocalEventStore` a trace is kept in, and `FolderVault`:
  `config.json` checked, `local/self.json` minted, `device.minted`
  announced, a store per extension, `dispose`.

No event type is known here — `device.minted` is the one name the
folder writes, because the format says the folder writes it. What an
event *means*, and the folds that turn a set of them into contacts
and threads, are `@estoc/vault`'s (`docs/vault-events.md`).
Interchange — `snapshot`, `exportVault`, `importVault`,
`restoreFolder`, and `zipFiles` / `filesFromZip` for the shape a
backup travels in — is here too (`docs/event-store.md` §10).

`test/suite/` holds the conformance suites — `storeSuite`,
`blobSuite`, and the backend cases — that every store and backend of
this package runs, so that a folder, a database and a map in memory
read and write the same set. The OPFS backend runs the backend cases
in a headless Chromium (`test/opfs.test.ts`); without one the cases
are skipped with a warning, and `ESTOC_BROWSER` names one.
