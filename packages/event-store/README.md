# @estoc/event-store

The vault as an event store: the code form of
[`docs/event-store.md`](../../docs/event-store.md).

**Version 3 is being built beside this**, under `@estoc/event-store/v3`,
as the code form of the
[replica model](../../docs/replica-model/README.md): the
[event store](../../docs/replica-model/event-store.md), the
[DASL object profile](../../docs/replica-model/dasl-objects.md) and the
[SQLite vault](../../docs/replica-model/vault-sqlite.md). What is there
so far is the model and its reference in memory; the SQLite vault, and
with it export, restore and import, come next.

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
mutations run one at a time in the order issued and finished before
the lock is released, the view refusing them once the operation ended;
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
