# @estoc/event-store

The vault as an event store: the code form of
[`docs/event-store.md`](../../docs/event-store.md).

**Version 3 is being built beside this**, under `@estoc/event-store/v3`,
as the code form of
[`docs/replica-model/event-store.md`](../../docs/replica-model/event-store.md):
so far the RFC 8785 canonical JSON and strict parser (§3.3), the
six-field envelope `eventId`/`at`/`author`/`type`/`roots`/`data` and
its validation (§3.4, roots being raw DASL CIDs from `@estoc/dasl`),
canonical order (§4.3), the `EventStore` interface (§5) and minting —
`at` from the clock, `eventId` from `uuid`'s standard UUIDv7 generator
(§4.2); and the first store, `MemoryEventStore`, the reference the
others are measured against — with `ForkedAuthor` and `BadToken`, and
`test/v3/suite/`, the conformance suite every version-3 store runs.
Beside it the object model of
[`docs/replica-model/dasl-objects.md`](../../docs/replica-model/dasl-objects.md):
raw DASL objects hashed as they stream (§4–5), the `ObjectStore`
interface (§6), the per-CID read latch of event-store.md §10 as
`LatchRegistry`, and `MemoryObjectStore`, the first store — with
`InvalidCid`, `DigestMismatch`, `ObjectTooLarge` and `DamagedObject`,
and `objectStoreSuite`, which the folder store runs next. Over both,
the vault (§10): `Vault` — events to read, objects to read, portable
files, and `commit(objects, drafts)`, the one way a local event is
written — and `VaultRuntime`, what a host opens: `locked(op)`, the
vault-wide writer lock, whose operation works through `Held`, the
same vault sharing the held lock; `collect(keep)`, the keep set a
function called only under the lock; and `ingest`. `MemoryVault` is
the three memory stores under one runtime; `Runtime` builds the same
over any three. Portable files (§8.1) are `FileStore`, `checkPath`
and `MemoryFileStore`. And the folder of
[`docs/replica-model/vault-folder.md`](../../docs/replica-model/vault-folder.md),
so far its events and objects: the layout (§3) as `kindOf(path)` — config,
keystore, segment, object, import, local, damage, or opaque — with the
root names beside it; segment lines (§6, §8) as `decodeLine`,
`decodeSegment` and `encodeLines`, a line being exactly
`canonicalEventBytes(event)` and an LF, everything else damage by
position; `local/replica.json` (§10.1) as `openReplica`, which reads
the replica identity or mints and writes it, refusing a partial or
malformed file as `DamagedReplica`; and `FolderEventStore` over the
version-2 `VaultBackend` (`MemoryBackend`, `OpfsBackend`, `FsBackend`),
which writes only under `events/<replica_id>/` — an append to its
newest LF-terminated segment, a fresh segment after a fragment or for
a batch, one fresh segment per author on `ingest` — and reads every
segment whatever the filter, keeping the first content per `eventId`
by path then line and reporting the rest, with change tokens naming
the store generation and every segment's accepted length (§10.3).
A file
standing where `events/` belongs is reported by every read and refuses
every write as `DamagedLayout`. Beside it `FolderObjectStore` (§9,
dasl-objects.md §10): one file per object, `objects/<cid>`, exactly
its bytes; a put streams into a staging file under `local/`, hashing
as it goes, and moves it into `objects/` only once the whole stream has
matched; a read streams the file back rehashing, and a file that no
longer spells its name fails the stream, goes aside to
`local/damaged/objects/` — if a fresh look at its bytes still says so,
so a put that healed it meanwhile stands — and is absent from then on;
an object's orphan age counts from its acceptance, recorded as the
modification time of a stamp file `local/accepted/objects/<cid>`
written once the move has completed; `collect` unlinks the unkept, unlatched objects
past grace with their stamps and sweeps abandoned staging;
`damaged()` reports what stands in `objects/` that is not an object
path, `verify()` reads every object and moves the mismatched aside.
For that the `VaultBackend` gained `open` (a file as a stream),
`create` (a file from a stream, visible only whole — nothing at a
fresh path until the source has ended) and `rename` (into place, over
what was there), in all three backends; OPFS needs
`FileSystemFileHandle.move()` for a fresh path and refuses one without
it. Over the three, `FolderVault` (§11.1, §15): `FolderVault.create(backend,
{ anchor, keystore })` lays a vault in an empty folder — the keystore
checked by shape, the anchor by the config parser, ownership taken
first, then `keystore.json`, then `config.json`; a folder that holds
anything but ownership's own files is refused with nothing written —
and `FolderVault.openWritable(backend, { anchor })` opens one: `config.json`
under its closed member set (another version refused in words a user
can read), `keystore.json` by shape, the anchor DID the caller derived
from the unlocked seed compared with the config's, ownership taken
through `backend.own` before any local state is made, the import
`import/` records finished or rolled back — one it does not understand
refused as `PendingImport` — `local/replica.json` read or minted, the
stores opened as that replica. What comes back is a `Runtime`: `vault` for
application code, `locked`, `collect`, `ingest`, plus `local(owner)` —
`options.json`, `cache/` and trace streams under `local/<owner>/` —
`damaged()` and `close()`, which refuses every new
operation, lets the accepted ones run out, fails the object streams
still alive, and only then releases ownership — nothing of the old
runtime touches the folder after that; every handle taken from the
vault, local ones included, refuses after close.
`FolderReader.open(backend, { ownership })` is the read-only open:
events, files and object metadata to read, no `local/` created, no
write; object streams only with `ownership: "exclusive"` — the same
ownership a writer takes, so a writer waits or fails meanwhile — and
refused as unprotected without it, over an object store that moves
nothing. `backend.own(path)` is a pid file on disk — `<pid> <thread>
<origin> <token>`, live while the process it names is — a Node
worker's as much as another process's, and a worker's record outlives
the worker until its process exits — or, naming this very thread,
while the origin is this incarnation of the process's, so the disk
alone says who holds it, whatever copy of the module in whatever
realm asks; nothing is removed from the name after a read, only moved
aside and judged by what moved, and a take that is over — released,
given up, or failed — gathers every copy of its record, and drops them
only once the file's link count says no copy stands elsewhere, so a
reclaim in flight can never put a released record back, the next take
a new record; a disk without hard links, a USB stick, gets the same by
exclusive create and rename — a Web Lock in OPFS, a set in memory;
a held name is `VaultOwned` at once, and waiting is the host's. Unlocking the seed is not this package's: the caller
derives the anchor with `@estoc/keystore` and hands it in.
Interchange (§11): `exportVault(runtime, into, { heldRoots })` writes
any runtime's vault — in memory or over a folder — as a portable
folder into an empty backend, under the writer lock from selecting
the cut to publication: every event rendered afresh as canonical
bytes, one segment per author; every portable file; every present
object through the store's verified stream; `config.json` and
`keystore.json` checked as a restore would; and the held roots,
computed by the fold handed in under that same lock, each required
present and sound, or the export aborts unpublished. `restoreFolder(
from, into, { heldRoots })` reads a portable folder into an empty
backend, the portable half only — never `local/`, never `import/`,
and a source with anything under `import/` refused as `PendingImport`
— validated whole before a byte is written: config, keystore shape,
every structural root holding only what the layout defines, every
segment line under its author, no conflict, and every held root of
that event set, as the fold computes it, among the source's objects;
objects are verified as they stream. Both own the destination while
laying it down, as `create` does, and publish by writing `config.json`
last; a failure withdraws what the run wrote, its publication first,
so what an interrupted run leaves is not a vault, and when the
publication cannot be withdrawn everything is left standing, since it
was all written before it. A destination another laying filled between
the check and ownership is refused and left untouched.
`importFolder(vault, from, { heldRoots })` merges a portable folder of
the same vault — the same anchor — into an open folder vault, under
its writer lock from the first look at the target to publication,
everything decided before a byte is written: the source validated as a
restore validates it; each of its events a duplicate, a conflict the
target wins and reports, or new — this replica's own author over an
event it did not write is `ForkedAuthor`; the held roots of the merged
set computed by the fold, each required to have sound bytes in the
target — read whole and rehashed, nothing moved — or among the
source's objects, which are the only objects copied, a copy landing
over a target file that no longer spells its name; a source file
copied only where the target has nothing, left where the target has a
file, and refused where it would land on a directory — an empty one
on disk included — or under a file; the target's config and keystore
never touched. The writes go through the barrier under
`import/<uuidv7>/`: every item staged at the path it will have, then a
journal naming them all, then each moved to its place — objects before
the segments that name them — then the journal and the directory gone.
The moves run in the event store's turn, so a read of the runtime that
arrives meanwhile waits and sees the union whole, and in the object
store's, so a quarantine that rehashed the target's damaged file
before the repair landed cannot move the repair aside. A
`FolderReader` without ownership shares the folder with whatever
writer holds it, and answers a read of the events only once it is
shown to be a view the folder was in at one moment with no import
being published — `import/` empty after the read, and a listing taken
then naming the same segments at the lengths the read found and the
same entries beside them, which suffices since no segment is ever
removed or shortened — reading again while it is not, and refusing as
`UnsettledRead` after four tries; a segment's unfinished write beside
its place is never such a view, since the reader cannot tell the
writer's in progress from what a crash left, so it is read past and
then refused naming it, and only a reader with ownership reports it as
damage — a directory under such a name is not one, since a backend
writes the sibling as a file, and is reported as damage by either
reader; an import in progress is `PendingImport`. A reader with
ownership looks at `import/` once it holds the folder, so a writer
that failed an import and released cannot leave it the segments that
landed to serve as the whole. A writable open
finishes an import whose journal it finds and rolls back staging that
never reached one — the sibling a backend was writing a staged item,
or the journal, to when the process died included, named as
`tempName` names it — before any store opens and whatever became of
`local/`; a read-only open takes up neither and reports both;
anything under `import/` that is not exactly a shape this version
leaves — a journal that is a directory, a directory or a file beside
the staging, staging on the way to nothing the journal names, an
unfinished write beside a journal that stands — blocks the writable
open, untouched, as `PendingImport` saying what it found. A failure after the journal — or a journal write that
failed when the staging cannot then be removed, since the file may
stand — halts the runtime, `FolderVault.halt()`: what was queued for
the lock is refused as its turn comes, every read is refused, and
ownership is released, so that nothing of this runtime folds or
collects over the union half published and the next open finishes
the import. The zip form comes next.
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
