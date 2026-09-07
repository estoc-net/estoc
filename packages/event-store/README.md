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
through `backend.own` before any local state is made, `import/`
required empty, `local/replica.json` read or minted, the stores opened
as that replica. What comes back is a `Runtime`: `vault` for
application code, `locked`, `collect`, `ingest`, plus `local(owner)` —
`options.json`, `cache/` and trace streams under `local/<owner>/` —
`damaged()`, `portablePaths()` and `close()`, which refuses every new
operation, lets the accepted ones run out, fails the object streams
still alive and only then releases ownership; every handle taken
from the vault, local ones included, refuses after close.
`FolderReader.open(backend, { ownership })` is the read-only open:
events, files and object metadata to read, no `local/` created, no
write; object streams only with `ownership: "exclusive"` — the same
ownership a writer takes, so a writer waits or fails meanwhile — and
refused as unprotected without it, over an object store that moves
nothing. `backend.own(path)` is a pid file on disk, a Web Lock in
OPFS, a set in memory; a held name is `VaultOwned` at once, and waiting
is the host's. Unlocking the seed is not this package's: the caller
derives the anchor with `@estoc/keystore` and hands it in.
Interchange — snapshot, export, restore, import — comes next.
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
