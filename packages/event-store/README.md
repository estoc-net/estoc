# @estoc/event-store

The vault as an event store: the code form of
[`docs/event-store.md`](../../docs/event-store.md).

**Version 3 is being built beside this**, under `@estoc/event-store/v3`,
as the code form of the
[replica model](../../docs/replica-model/README.md): the
[event store](../../docs/replica-model/event-store.md), the
[DASL object profile](../../docs/replica-model/dasl-objects.md) and the
[SQLite vault](../../docs/replica-model/vault-sqlite.md). What is there
so far is the model, its reference in memory, the SQLite driver the
persistent stores are written against, the vault's schema and opening
over it, and the event store over that; the object store, and with it
the SQLite vault, export, restore and import, come next.

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
rollback-format headers; a read-only open forbids writes through
`query_only` and keeps the lock its first read leaves it with — on a
rollback-journal file the shared lock, so writers are excluded while
other readers are not; on a WAL file the exclusive lock, since a WAL
reader keeps no lock a writer would meet — letting SQLite recover the
WAL on open and checkpoint it on close. Every handle is SQLite's own:
a descriptor opened beside SQLite's and closed would take the
process's locks on the file with it.
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

Over the driver, the vault's schema and its opening. `createTables`
makes the five common tables — `vault_meta`, `keystore`, `events`,
`objects`, `object_chunks`, all `STRICT` — and, for a runtime, the two
control tables `store_state` and `event_positions`; `checkSchema`
checks a database holds exactly that, structurally, through SQLite's
own pragmas — names, columns, types, primary and unique keys with their
collation and direction, references with both their actions, no table
`WITHOUT ROWID` — and,
since no pragma reports a column's collation, by comparing through
each text column that it collates byte for byte; the SQL the tables
were spelled with is not what is checked, and the schema's names are
read as their stored bytes and decoded, since a snapshot is a file
another party wrote. A portable snapshot may have nothing beside the
five tables and the indexes their constraints made; a runtime may add
indexes, `local_*` tables and `ANALYZE` statistics; a view or a
trigger is refused in either, and a table named like an inherited
property of an object is an extra table like any other.
`createRuntime(driver, { metadata, wrapped })` fills the empty database
a `create` opened — application ID `ESTC`, schema version 1, the
tables, the metadata, the wrapped seed as the UTF-8 of its compact JWE,
fresh `replica_id` and `store_generation` — in one transaction,
published ready, and hands the runtime back open. `openRuntime(driver,
{ anchor })` checks a `readwrite` driver's database in order — the
file's application ID, text encoding and schema version; the metadata,
so a snapshot or an unready file is told apart before its tables are;
the schema; the wrapped seed; then the anchor, given outright or
derived by a function that unlocks the wrapper the vault holds,
against the vault's (`AnchorMismatch`); then the control, whose row is
the one keyed 1, whose replica ID and generation are canonical
UUIDv7s, and whose `last_seq` and positions, all positive, account for
every event (`DamagedControl` otherwise, and nothing is made up in
their place) — and writes nothing. The text encoding is read from
`PRAGMA encoding` where SQLite was built with UTF-16 support and from
the file's header through `sqlite_dbpage` where it was not, as the
wasm build is — every schema name is first read as bytes and refused
where it has a NUL, is not UTF-8 or is `sqlite_dbpage` in any case,
which only `writable_schema` allows, before that read and on every
platform; a platform with neither is refused a file it did not
write. The metadata and keystore rows are likewise the one keyed 1
each: the file's own constraints are not trusted to have kept it so.
`openInspector(driver)` applies the same checks without the seed on a
connection set to refuse every write; it takes only a `readwrite`
driver, the one mode that owns the file outright on every platform,
since a `readonly` driver may share a rollback-journal file with other
readers and a runtime's inspector must not. `openPortable(driver)`
takes a `readonly` driver — no writes, no extensions, an untrusted
schema — and checks the file's identity and its rollback-format
headers, then the schema, then the two rows that say what it is,
reading nothing else; whether its events and objects are what they
claim is the validation to come. The wrapped seed is checked against
the keystore package's profile as far as it can be without the
passphrase — `PBES2-HS512+A256KW` over `A256GCM`, an iteration count
the package would accept, a salt of at least 8 bytes, nothing else in
the protected header, and segments of the lengths a wrapped 256-bit key,
a 96-bit nonce, a 32-byte seed and a 128-bit tag have — not just the
shape of a compact JWE. Each open returns a handle with the driver,
the metadata, for a runtime the local IDs and `keystore(locked)` —
`read` any time, `rewrap` one transaction under the lock the caller
runs it in, no statement held past either — and `close`, after which
every call is `VaultClosed`; a create or open that fails, for any
reason, closes the driver it was given, so ownership never stays with
a handle nobody can use. Everything a file must show is a `NotAVault`
naming what it did not. The open cases in
`test/v3/sqlite/open-cases.ts` run over both platforms, Node on files
and Chromium in a Worker, a UTF-16 file among their inputs.

Over an open runtime, the event store: `SqliteEventStore(db, { now })`
over the connection, author, generation and writability an open handed
back. An append is one `BEGIN IMMEDIATE` transaction on the runtime's
own connection — the events as their canonical bytes beside the four
columns that index them, a position each above `last_seq`, `last_seq`
advanced by as many — so a batch lands whole or not at all and two
writes never interleave; `appendAll(drafts, publish)` runs `publish`
inside that transaction, before the events, which is how the SQLite
vault will publish a commit's objects with its events, a throw from it
rolling back what it wrote. A batch is validated index by index, so a
hole in a sparse array is refused like any value that is not a draft.
`ingest` reads its whole input first,
outside any transaction, then classifies each input against what is
held — duplicate by canonical bytes, conflict, new — checks for a fork
and accepts, in one transaction; the values it rejected are recorded
once each in the runtime's `local_conflicts` table, which
`conflicting()` reads back with the accepted value as `kept` and
`clearConflicts()` empties. `scan` orders in SQL by `(at, event_id,
author)` and reads every row before the first yield, one cut; `author`
and `type` narrow the rows in SQL, bound as bytes cast to text so that
a NUL in a type is stored and compared as itself, and the whole filter
is then applied in code to the parsed event, exact primitive equality,
so a match is exactly what the filter says. `changes` joins the
positions: a token is `{ generation, seq }`, the store generation and
the position accepted last, valid across reopens for as long as the
generation stands, and a malformed token, another generation's or a
position past the last is `BadToken`. Every row read is decoded the
same way — parsed strictly, validated, re-canonicalized and compared
byte for byte, its four columns compared with the event's fields, the
text columns read as stored bytes — and one that fails is damage: left
out of every scan and delta, listed by `damaged()` as
`events/<event_id>` (or the rowid, when the ID itself does not decode)
with its bytes and what was wrong. Damage makes the history
incomplete, and the store then accepts no write: every read remembers
the damage it meets, a store surveys every row once before its first
write, and from either `append`, `appendAll` — its `publish` never
run — and `ingest` refuse with `DamagedHistory` until a validated
snapshot is restored into a new runtime. Over an inspector's handle
the store reads and refuses every write with `ReadOnlyVault` before it
reads a source. `eventStoreSuite` runs over it in memory and on files;
`test/v3/sqlite/events.test.ts` adds what only a database shows — the
rows, the positions, a reopen, damage, the inspector, a process dying
inside its transaction — and `test/v3/sqlite/event-cases.ts` what the
two platforms' SQLite must agree on, run on `node:sqlite` and in a
Chromium Worker: a NUL in a type, damage stopping writes across a
reopen, a sparse batch.

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
