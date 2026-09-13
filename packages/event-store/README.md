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
over it, the event store and the object store over that, the SQLite
vault over both, and the portable snapshot: export, its validation
and its inspection, restore and import — the whole of it run in a
Chromium Worker as it is on Node, one snapshot exchanged between the
two.

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
together or not at all; a root the commit reuses rather than puts is
declared to the preparation with `reuse` and checked once more as it
publishes, since a read outside the lock may have found it damaged
between the root check and the transaction, and the commit then
fails with `DamagedObject` rather than accept an event over bytes
known damaged. `MemoryVault` is the two memory stores under
one runtime; `Runtime` builds the same over any two stores and the
transaction that publishes them, which every backend supplies.

Under the stores, the SQLite driver: `SqliteDriver` — one
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
vault publishes a commit's objects with its events, a throw from it
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

Over the same runtime, the object store: `SqliteObjectStore(db, {
maxObjectBytes, maxStagedBytes })` over the connection and writability
of an open handle. A put is hashed as it streams and cut into the
format's chunks — 1 MiB each, the last holding what remains — staged
as they arrive in a table of the connection's temporary database,
never the vault's file and where no read of the store looks. That
database is a file: both adapters set `temp_store` to `FILE` on a
writable connection — the wasm build would otherwise keep it in
memory, and the pool reserves handles for it — and the store gives it
a 2 MiB page cache, so what is held in memory is the chunk in hand
and that cache, whatever the object's size. What may be staged at
once across every preparation in flight is bounded too:
`maxStagedBytes`, 1 GiB unless given, and the put that would pass it
is refused with `StagingFull` before the chunk that would, nothing of
it staged, the others untouched. The CID is known at the end, checked
against the one `putObject` was given, and the chunks then move under
it in one `BEGIN IMMEDIATE` transaction with the `objects` row, so an
object is visible whole or not at all and a source that fails, one
over either bound or a digest that does not match leaves nothing
staged. An object already held and sound is one object still, its
bytes untouched; one known damaged is replaced whole. `prepare()` splits
the two for the vault's commit: a `SqlitePreparation` stages what is
put through it, counts it present to its own `has`, notes what the
commit declares `reuse`d, and is accepted by `publish()` inside the
transaction the commit lands in — the `publish` callback of
`SqliteEventStore.appendAll` — which first checks every reused
object against the damage known by then, refusing the transaction
with `DamagedObject`, unless the object is staged as well, which
repairs it; then `settle()`
once that has committed, which is when the damage of what it
repaired is cleared, a rollback keeping the old bytes and their
damage, and `discard()` in any case. `open` streams one chunk a
pull, rehashing on the way out, each chunk checked against the
layout the size gives the object — numbered from zero, the chunk
size each but the last, which holds what remains — and the read
after the last checks that no other chunk is stored under the CID
and that the bytes hash to it; `read` is the same walk into one
buffer, refused before allocation when the object is over
`maxBytes`. The size is read as its decimal text, so a stored
integer the platform cannot hand over exactly is the object's damage
rather than a failure of the read. What a read finds wrong — bytes
that do not hash to the CID, a chunk missing, short or surplus, a
chunk under an empty object, a size that is no count, a key that is
no CID — is damage known for the rest of the session: `has`,
`stat`, `open` and `read` of that CID fail with `DamagedObject`,
`list` fails on reaching it, `damaged()` lists it as `objects/<cid>`
(or by rowid, when the key is no CID) with what was wrong; nothing
is persisted, and a reopen finds it again by the read that meets it.
A write never waits for a reader: a repair or a collection pass
moves the CID's epoch, and a stream open on the old bytes fails at
its next chunk with `InterruptedRead` — not damage, not absence —
rather than read on into bytes of two generations. `collect(keep)`
checks every keep CID, then deletes every other object and its
chunks in one transaction, a damaged one among them, and reports the
CIDs removed in binary-CID order; a kept damaged object stays, its
damage still known. Over an inspector's handle every write is
refused with `ReadOnlyVault` before a source is read. The chunk size
is the format's and not a setting: a test that wants a chunk
boundary inside an object puts one of more than a mebibyte.
`objectStoreSuite` runs over it in memory and on files;
`test/v3/sqlite/objects.test.ts` adds what only a database shows —
the staging beside a read, the staging bound, a stream across a
repair, a key that is no CID, a process dying inside its acceptance
— and `test/v3/sqlite/object-cases.ts` what the two platforms'
SQLite must agree on, run on `node:sqlite` and in a Chromium Worker:
the chunk rows, a reopen, a preparation rolled back, damage of each
kind and its repair, collection under an open stream, the inspector,
and staging on the file under a cache that does not grow with the
object, measured where the platform reports what SQLite holds.

Over both, the vault: `SqliteVault(db, { now, maxObjectBytes,
maxStagedBytes })`, a `Runtime` — the writer lock, the `Vault` facade
application code gets, the held view, `locked`, `collect` and
`ingest` as the runtime in memory has them — whose commit publishes
as one transaction: the objects prepared under the lock while the
sources stream, the transaction opened only once every draft is
minted, the prepared objects and their repairs published inside it
ahead of the events and their positions, and the preparation settled
after the commit, so a throw anywhere before the `COMMIT` leaves no
object, no repair and no event. The keystore is the handle's over the
runtime's lock, and the runtime's local state is `vault.local`:
`options`, JSON by key, kept through every reopen and clearing;
`cache`, bytes by namespace and key, dropped whole in the transaction
of every commit or import that lands an event, an object or a repair
— what it was built from has changed under it — and when the identity
is reset; and `trace`, one entry a row in the order written, scanned
by type and position and pruned by age and count, sequence numbers
never reused, so retained entries appended later remain after an
earlier cursor — each in a `local_*` table made on its first write, so
a runtime that uses none writes none, and `clearCaches()` empties the
cache and the trace, the sequence continuing, and nothing else. An inspector's vault reads all of it and refuses every
write. The vault stops two ways, and `stopped` says which. Damage to
the history — found by a read, or by the survey the event store makes
before its first write and `stopped` asks for — refuses commit,
ingest and collection with `DamagedHistory`, collection because its
keep set is folded from that history, while reads, local state and
rewrap go on; the history is recovered by restoring a validated
snapshot into a new runtime. A `COMMIT` SQLite could not complete is
`UncertainCommit`, thrown by the driver's shared `Connection`, which
does no further work — every call after it fails the same way — until
it is closed: whether the transaction landed is unknown to it, and
only the recovery a reopen runs can tell, so the vault refuses
everything, reads included, and drafts it minted are not resubmitted
blindly. `close()` admits nothing more, waits for the operations
already admitted, then closes the database and with it ownership; a
stream still open fails at its next chunk. `openRuntime(driver, {
anchor, resetIdentity: true })` is the recovery from `ForkedAuthor`:
once every check has passed, one transaction gives the runtime a
fresh replica ID and generation and drops the cache, the events,
positions, objects, options and keystore staying and every token of
the old generation refused. `vaultSuite` in `test/v3/suite/` is what
any runtime must show through `Vault`, `VaultRuntime` and `Held` — a
commit whole or not at all, damage and its repair, collection under
open streams, the held view's ordering, rewrap under the lock, ingest
as yielded — run over the runtime in memory and over the SQLite vault
in memory and on files; `test/v3/sqlite/vault-cases.ts` is what the
two platforms' SQLite must agree on, run on `node:sqlite` and in a
Chromium Worker: the rows one commit leaves and a reopen finds, a
refused commit leaving nothing, the identity reset, the history
stopping writes, the local tables, a `COMMIT` that fails, ownership
across close; and `test/v3/sqlite/vault.test.ts` bundles a process
that commits through the vault and kills itself right after each of
the commit's statements in turn, reopening the file after each to
find the batch whole or not at all.

The portable snapshot. `exportVault(runtime, open, { heldRoots,
maxBytes })` builds one from any runtime — the SQLite vault, an
inspector's, the vault in memory — through the interfaces every
runtime presents, into the destination `open` gives: a function of
the platform's, `(mode) => openNodeSqlite(path, { mode })` or `(mode)
=> pool.open(name, mode)`, called once to `create` the target and
once, after the writer has closed, to reopen the file `readonly`.
Under the operation lock the cut is selected — first the events'
tally, their count and canonical bytes from what the store keeps
beside them, refused as `SnapshotTooLarge` past `maxBytes` before an
event is read; then the wrapper, every event in canonical order, and
`heldRoots`, the caller's fold of the roots the events hold, each
root's presence and size checked, refused as `IncompleteSnapshot`
when the history has damage or a held root is absent or known
damaged, and as `SnapshotTooLarge` when the events' bytes and the
held objects' sizes together pass `maxBytes`, before a chunk is read
— nothing made in any of these cases. A conflict on record is a local
diagnostic, not damage: the accepted value is exported and the
diagnostic is not. Then the destination is created, switched to a
rollback journal with `synchronous=FULL`, laid in one transaction as
a portable database with `ready = 0` — the five tables, the metadata,
the wrapper's bytes, every event — and filled object by object, each
streamed through the vault's own read, hashed again, cut into the
format's 1 MiB chunks and written 8 MiB at a time in transactions of
its own, then checked against the cut and set ready in one
transaction, and closed; the lock is released only then. Outside the
lock the file is reopened read-only and validated as a restore would
validate it — with no file bound: the file is the one the export just
built and closed, and its event and object payload is within
`maxBytes` when one was given — and what the export returns is what
validation found:
the events and their bytes, the objects and theirs. The file is a new
one, so no page of it ever held what is not in it: no control, no
position, no local table, no unheld object. A source that fails while
its bytes are copied is `IncompleteSnapshot` too, the destination
left unready for the caller to remove; the file's delivery — a path,
or `pool.exportFile(name)` — is the caller's, once the export has
returned, and a check for sidecars beside a path is the caller's too.
`openPortable(driver, { maxFileBytes })` bounds its input before
anything else is read: the file's size as its header states it, the
page count times the page size, which is all SQLite will read of it,
refused as `SnapshotTooLarge` past the bound, so every row, column,
chunk and check after it, the validation included, lies within what
the caller allowed. It now hands back, beside the metadata and the
wrapper, `vault`: the snapshot as a read-only `Vault` —
`PortableVault` — scanning the immutable event set in canonical order
from the five tables alone, its damage reported, its `conflicting`
always empty since no diagnostic travels, its objects under the
ordinary read and damage rules, and `changes` and `commit` refused
with `UnsupportedOperation`, neither consuming a source nor minting
anything; a closed snapshot refuses every read with `VaultClosed`.
A CHECK the file declares is SQL the file supplied: the handle runs
none of them, `integrity_check` included, and every value they would
have constrained is checked by the reader. `validatePortable(portable,
{ heldRoots })` is what a restore or an import runs on an open
snapshot before trusting a byte of it, in order: SQLite's
`foreign_key_check`; the chunks holding no more bytes than the
objects declare, read from record headers alone, before a chunk is
loaded; SQLite's `integrity_check`, which nothing is read past when
it fails; every
event row decoding to the event its columns name; every `objects` row
keyed by a CID with a size that is a count; the object set equal to
`heldRoots` folded from the snapshot's own events; and every object's
chunks read through — each chunk's length asked before its bytes, so
one longer than the layout gives it is refused unloaded — contiguous,
of the format's lengths, hashing to the CID, through a store of the
call's own, so what was wrong with an object is what is reported;
what SQLite itself cannot read is a problem like the others. Every
problem found is in `InvalidSnapshot.problems`. Whether the events'
known payloads are valid is the fold's to decide, in the layer that
knows them: what `heldRoots` throws is what the export or the
validation fails with. `test/v3/sqlite/export-cases.ts` runs on
`node:sqlite` and in a Chromium Worker: what a snapshot holds and
what never enters it, checked in the file's raw bytes; the refusals
before and after the destination is made, and the conflict that is
none; a commit, a collection pass and a rewrap waiting on the
export's lock and landing after without touching the file; the vault
in memory exporting into the same file; every way a snapshot that
opens still fails validation; a file past the bound refused as it is opened; the bound
counting the events, tallied before one is read; a chunk longer than
its layout never loaded; and a file whose own CHECK every row
violates, validated on its values. `test/v3/sqlite/export.test.ts`
adds what only a path shows: no sidecar beside the file whatever
journal the destination was created with, two readers holding it at
once, an inspector's export, a destination that is not fresh, and a
file torn under its schema.

Restore and import, both from a snapshot the caller has opened with
`openPortable` — bounding the file with `maxFileBytes` where it
should be — and closes afterwards. `restoreVault(source, open, {
heldRoots, anchor })` builds a new runtime from the snapshot's
values: the snapshot is validated in full and the credential's anchor
— given outright, or as the function that unlocks the snapshot's
wrapper and derives it — compared with the snapshot's own, nothing
made on a failure of either; then `open("create")` makes the
destination, laid in one transaction as a runtime with `ready = 0` —
the schema, the metadata, the wrapper adopted, a fresh replica ID and
store generation, every event under a fresh position in canonical
order — and filled object by object through the snapshot's own read,
rehashed and chunked as an export writes them; checked against what
validation counted and set ready in one transaction; and handed back
open, `{ runtime, events, eventBytes, objects, objectBytes }`, for
the host to build a `SqliteVault` over and reconstruct what the
events say is unfinished before it runs. No page of the source is
copied and no SQL of it run. A failure once the destination is made
closes it and leaves it unready, opening as nothing, for the caller
to remove; no seed is minted. `importVault(target, source, {
retainedRoots })` merges a snapshot of the same vault into any open
runtime — the SQLite vault, or the vault in memory, since it works
through `VaultRuntime` and `Held` — and returns `{ added, duplicates,
conflicts, objects, repaired }`. Its fold is a `RetainedRoots`, the
retention edge by edge — each event, each root of its own it still
retains — rather than the `HeldRoots` an export takes, because the
roots an import requires bytes for are those the *new* events retain
in the union, and a root one event released may be held by another
under the same CID: only the edge tells which event holds it;
`heldRootsOf(retainedRoots)` is the same fold as a `HeldRoots`, for
the export, the validation and the collection pass. Outside the
target's lock: an inspector is refused with `ReadOnlyVault` before
the source is read (`VaultRuntime.writable` is new for it); the
snapshot is validated in full; its anchor is compared with the
target's, `AnchorMismatch` for another vault's; and its events and
object listing are read into memory. Under the lock: a damaged
target history is `DamagedHistory`; each source event is classified
against what the target holds — a duplicate, a conflict the target
wins and reports, or new — and a new or conflicting event under the
target's own author is `ForkedAuthor`, the whole import refused with
nothing written, the recovery being an identity reset; the fold runs
on the target as it is and on the prospective union, held as a vault
in memory; every root a new event retains in the union, and every
root the union holds that the target did not, must have bytes in the
source or bytes the target holds sound as far as it knows — nothing
is rehashed — else `IncompleteImport` names each and nothing is
written; every union-held object the target lacks or knows damaged,
whose bytes the source has, is staged through the target's
preparation, verified as it streams — the source's bytes awaited
under the lock, but outside any transaction — even when no event is
new; a union-held root outside those requirements that the source
lacks stays as it is, absent or damaged. Then `Held.ingest(events,
stage)` — the `stage` callback is new, and `Stores.ingestion` with
it, the ingest counterpart of `transaction` — publishes the staged
objects and repairs with every new event and its position in one
transaction, dropping `local_cache` when anything landed. Every
target object the import reuses that the source could replace or the
union requires is declared `reuse`d to the preparation, so the
transaction checks it once more: a read outside the lock may have
found it damaged while the source streamed, and the publication then
refuses, the staging dropped, and the import plans again with that
damage known — the repair among the staged when the source has the
bytes, `IncompleteImport` when the root is required and it does not
— rather than accept an event over bytes known damaged. The target's
identity, wrapper, options and trace stay. The same snapshot again
adds nothing and, with nothing to repair and no conflict to record,
writes nothing. `test/v3/sqlite/import-cases.ts` runs on
`node:sqlite` and in a Chromium Worker: a restore's runtime checked
row by row and run on; its refusals before and after the destination
is made; an import's union, what it reports and keeps, the repeat
that writes nothing, and the vault in memory as a target; a fork from
a cloned runtime file, and the import after the identity reset; the
roots the union requires bytes for, crossed in both directions by a
fold with a contestable release, the root held before and after that
needs none, and the root a new event names but the fold released
beside the target's own reference to it, absent or damaged; what an
import fills and repairs, damage forgotten by a reopen and found
again, and the released root it does not revive; a reused object
found damaged while the source streams, repaired by the import
planned again or refusing it with nothing written; the source
validated before the lock, another vault's snapshot and an inspector
refused; and an import interrupted at every statement of its
transaction, or at its `COMMIT`, leaving the whole old union or the
whole new. `test/v3/sqlite/import.test.ts` adds a restore into a
destination of either journal.

The two platforms, side by side. The three conformance suites —
`eventStoreSuite`, `objectStoreSuite`, `vaultSuite` — run over the
wasm pool in the Chromium Worker as they run over `node:sqlite` in
memory and on files, through the same openers
(`test/v3/sqlite/suite-openers.ts`); the Worker's bundle gets the
`vitest` the suites import from `test/browser/vitest-stand-in.ts`,
whose `describe` and `it` collect the tests for the Worker to run one
at a time and whose `expect` is vitest's own matchers over chai, so a
suite asserts in the Worker exactly what it asserts under vitest, and
`test/v3/sqlite/browser-driver.test.ts` reports each collected test
as a case of its own. One portable snapshot crosses between them
(`test/v3/sqlite/exchange.ts`): a sample vault — text with control
characters and numbers of every JSON kind in the events' data, a
type outside ASCII, a second author's event, the empty object, one
across a chunk boundary and one of bytes that are no text — is
exported on Node, inspected there, sent to the Worker, and inspected
there to the same values: the metadata, the wrapper, what validation
counted, every event as scanned and every object's key, codec, size
and bytes as read; the Worker restores it, commits one more event
over one more object and exports again, and that file, sent back,
inspects on Node as it did in the Worker and imports into the sample
vault as exactly the one event and the one object. An object of 64
MiB streams through a commit, a read, an export and a restore on
both platforms under a source that reuses one buffer, with what the
platform holds sampled on the way: in the Worker SQLite's own count
(`sqlite3_status`), where the commit fills the wasm build's 16 MiB
page cache once and nothing grows after; on Node what JavaScript
holds once garbage is collected (the heap and the array buffers,
`--expose-gc` given to vitest's forks for the collection), flat
throughout — the resident set is not measured, since glibc keeps
what the transient mebibyte buffers were freed into. The bound is on
growth: none across the second half of the commit or of the read,
none from the commit to the restore, and less than half the object
in all.

The durability configuration on each platform, reported by the
driver case that checks it. On `node:sqlite`, foreign keys are
enforced by the binding's default, a created runtime runs in WAL
with `synchronous=NORMAL` — durable against a crash of the process,
consistent after a loss of power, the last transactions possibly
lost — and a portable snapshot is built in a rollback journal
(`journal_mode=DELETE`) with `synchronous=FULL`, so the file stands
alone; a restore's destination is a created runtime and runs as one.
In the Worker, foreign keys are enabled on every connection, and the
pool's databases run in a rollback journal with `synchronous=FULL`,
the wasm build's defaults over the access-handle pool, whose sync is
the handle's flush; a snapshot built there is in the same journal.
On both, the temporary database is on a file (`temp_store=FILE`),
and `journal_mode=OFF` or `MEMORY` and `synchronous=OFF` are never
set.

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
