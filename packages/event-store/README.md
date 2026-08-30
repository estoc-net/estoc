# @estoc/event-store

The vault as an event store: the code form of
[`docs/event-store.md`](../../docs/event-store.md).

What is here is the **model** and the **seam**, with nothing behind
it but memory:

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
- the `LocalEvent` shape a trace uses.

No event type is known here. What an event *means*, and the folds
that turn a set of them into contacts and threads, are
`@estoc/vault`'s (`docs/vault-events.md`). The folder serialization
(`docs/vault-folder.md`) is the next thing to land in this package.

`test/suite/` holds the conformance suites — `storeSuite`,
`blobSuite` — that every store of this package runs, so that a
folder, a database and a map in memory read and write the same set.
