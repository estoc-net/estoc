# The Estoc event store, version 3

Status: **draft** — clean-break event, blob and interchange model for a
replicated Estoc vault.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

This is one of seven documents that define the distributed vault:

| document | defines |
| --- | --- |
| `event-store.md` | the medium-independent event, blob and vault-store interfaces |
| `vault-folder.md` | the readable `.estoc/` interchange serialization |
| `vault-events.md` | the meaning and folds of the vault's own event types |
| `distributed-delivery.md` | vault-first send, packaging, retry and end-to-end acknowledgment |
| `rendezvous.md` | public `did:web` discovery and contact-scoped handoff to pairwise `did:peer:4` |
| `replica-mediation.md` | method-neutral mediator fan-out and per-replica pickup acknowledgment |
| `vault-sync.md` | encrypted anti-entropy through an untrusted sync store |

Dependency runs downward. `vault-folder.md` serializes the model here.
`vault-events.md` defines payloads above it. The delivery, rendezvous, mediation and sync protocols use the event and
blob primitives but do not change their meaning.

## 1. Scope

A vault is three portable sets and one local execution environment:

```text
portable vault
    events       immutable facts, merged by `eid`
    blob blocks  immutable content-addressed bytes
    files        singleton and opaque portable files

local copy
    replica ID, store generation, locks, caches, traces and options
```

The portable sets define the identity's recoverable state. Local state is
not part of the vault, is never synchronized, and is omitted from every
portable snapshot.

The store does not know contacts, messages, public DIDs, mediators or
replicas as domain objects. It knows only event authors. The vault layer
requires the author used for local appends to equal the current local
`replica_id`.

A writable vault runtime may execute in an end-user application or on a
server. The event store assigns no authority based on process location and
has no special web-host author type.

## 2. Invariants

Every conforming implementation preserves the following rules.

1. **Events are immutable.** An event is appended or ingested whole. No
   operation edits or deletes one.
2. **Merge is set union by event ID.** The same `eid` and same JSON
   content is a duplicate. The same `eid` and different content is a
   conflict and MUST NOT overwrite either store's accepted value.
3. **Folds are functions of the event set.** Ingest order, segment order,
   replica order and transport order MUST NOT change a fold's result.
4. **Authorship is explicit.** The event's `author` identifies the
   writable local replica that created it. A path, database row or sync
   envelope MUST NOT supply or replace authorship.
5. **One active writer per author.** Two concurrent writable copies MUST
   NOT share one author ID. The store detects this condition when it can.
6. **Blob references are explicit.** The event envelope lists every blob
   root the event retains. A CID elsewhere in `data` is not a reference.
7. **Blocks precede references.** A producer writes and validates blob
   blocks before appending an event that makes them recoverable state.
8. **Only blob blocks are collected.** Events and portable files are not
   garbage-collected through the blob API.
9. **Local state is not correctness state.** Losing `local/` may require
   rebuilding caches and registering a new replica, but MUST NOT lose a
   committed user decision or message body.
10. **The folder is the interchange format.** Every backend MUST be able
    to export and import the version-3 folder without changing the event
    set or portable bytes.
11. **Local change tokens are not synchronization cursors.** Replica
    synchronization is `vault-sync/1.0`, not `changes()`.
12. **A complete full replica is fully trusted.** Event authorship
    distinguishes writers and detects accidental forks. It is not a
    security boundary against another holder of the shared vault seed.

## 3. The event

An event is a JSON object with exactly six top-level fields:

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [field: string]: JsonValue };
type JsonObject = { [field: string]: JsonValue };

type Event<D extends JsonObject = JsonObject> = {
  eid: string;
  at: string;
  author: string;
  type: string;
  blobs: string[];
  data: D;
};
```

| field | meaning |
| --- | --- |
| `eid` | canonical UUIDv7, minted by the appending store; event identity and deduplication key |
| `at` | RFC 3339 UTC timestamp obtained with the `eid` |
| `author` | canonical UUIDv7 identifying the local replica that appended the event |
| `type` | non-empty event-type string |
| `blobs` | complete list of retained blob roots, always present, `[]` when none |
| `data` | type-specific JSON object, always present, `{}` when empty |

Example:

```json
{
  "eid": "019b2a46-8b36-75c6-a74b-81a2aa5fb407",
  "at": "2026-09-03T15:04:05.123Z",
  "author": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
  "type": "contact.petname",
  "blobs": [],
  "data": {
    "cid": "019b2a45-8381-793f-943c-f5d806fd5ca2",
    "name": "Alice"
  }
}
```

### 3.1 `data`

`data` is opaque to the event store. The store MUST NOT use event-type
knowledge to validate, index, merge or collect it. A layer above the
store validates known payloads before append and after ingest.

The payload is nested so a future event-envelope version can add a
field without colliding with an existing type's payload. Version 3
nevertheless rejects unknown top-level fields; changing the envelope is
a vault-format version change.

Everything needed to understand an event apart from storage location is
on the event. A folder path confirms an author but never supplies one.

### 3.2 `blobs`

`blobs` contains every root retained by that event. The list:

- MUST be present even when empty;
- MUST contain canonical CIDs accepted by the blob profile in section 7;
- SHOULD contain no duplicate root;
- MUST be sufficient for a collector that does not understand `type`;
- MUST NOT include a CID that is merely mentioned as a name or evidence;
  and
- MUST be written only after the referenced blocks have been accepted by
  the local blob store.

A type may repeat the roots in `data` under semantic names such as
`body`, `attachments` or `envelope`. Repetition does not create another
reference. A type such as `message.erased` may name roots to release in
`data.drop`; those roots MUST NOT appear in that event's `blobs`.

### 3.3 JSON and equality

An event must survive JSON serialization without semantic change. It
MUST contain no `undefined`, bigint, non-finite number, cycle, host
object or implementation-specific value.

Two events have the same content when they are structurally equal as
JSON:

- object member order and insignificant whitespace do not matter;
- arrays are ordered;
- strings are compared by Unicode scalar value sequence;
- numbers are compared by their JSON numeric value; and
- all six top-level fields participate.

A backend MAY compare canonical RFC 8785 encodings to implement this
rule.

### 3.4 Envelope validation

On append and ingest, the store MUST reject an event unless:

- the value is a JSON object;
- the top-level member set is exactly
  `eid`, `at`, `author`, `type`, `blobs`, `data`;
- `eid` is a canonical lowercase UUIDv7;
- `at` is a valid RFC 3339 UTC timestamp using `Z`;
- `author` is a canonical lowercase UUIDv7;
- `type` is a non-empty string;
- `blobs` is an array of canonical profile CIDs; and
- `data` is a JSON object.

The store validates no payload field. A known-type validator above the
store MUST quarantine or surface an invalid payload; it MUST NOT silently
reinterpret it.

## 4. Identity, authorship, time and order

### 4.1 Author

`author` is the current local replica ID at append time. It names one
writable incarnation of a vault, not hardware, an operating-system
installation, a person or an authorization key.

A newly created writable copy mints a fresh canonical UUIDv7 author. A
portable snapshot omits the current local author selection, so opening a
restored copy also mints a fresh one. An exact physical move MAY preserve
the author only when no second writer remains.

The same local author is used by the vault's main event store and every
extension event store opened by that local copy.

No author- or replica-creation event is required. The existence of an
author is evident from its events. Optional replica labels and
retirement policy are vault events defined in `vault-events.md`.

### 4.2 Event ID and timestamp

The store mints `eid` and `at` as part of append. The UUIDv7 timestamp
and `at` SHOULD come from the same clock reading.

An `eid` is trusted to be globally unique. It encodes no subject,
contact, message, author or permission. A caller that needs the minted
ID obtains it from the returned event.

`at` is a wall-clock observation. It may be wrong or move backwards. A
protocol decision whose correctness cannot tolerate timestamp ordering
MUST use explicit references, immutable IDs, tombstones or set semantics
rather than relying on latest-wins.

### 4.3 Canonical order

Whenever a fold or `scan()` requires one total order, events are ordered
ascending by:

```text
(at, eid, author)
```

String comparison uses the canonical serialized forms. Since `eid` is
expected to be unique, `author` is normally only a defensive final
component.

Canonical order is for presentation and explicitly declared
latest-wins fields. It does not express causality, insertion order or
network order.

### 4.4 Other IDs

The event store does not validate IDs inside `data`. Vault event types
may use:

- UUIDv7 for locally minted entities and operations;
- UUIDv5 for deterministic cross-replica idempotency; and
- protocol-defined strings such as DIDComm message IDs.

The event ID, vault message ID, DIDComm wire ID, encrypted package ID
and mediator delivery ID are distinct namespaces.

## 5. EventStore

```ts
type Cid = string;

type Draft<D extends JsonObject = JsonObject> = {
  type: string;
  blobs?: Cid[];
  data: D;
};

type Filter = {
  author?: string;
  type?: string;
  data?: { [field: string]: JsonPrimitive | undefined };
};

type ChangeToken = string;

type Conflict = {
  eid: string;
  kept: Event;
  rejected: Event;
  source?: string;
};

type Rejected = {
  value: unknown;
  error: string;
  source?: string;
};

type Damaged = {
  where: string;
  bytes?: Uint8Array;
  error: string;
};

type Ingested = {
  added: number;
  duplicates: number;
  conflicts: Conflict[];
  rejected: Rejected[];
};

interface EventStore {
  /** Author assigned to every locally appended event. */
  readonly author: string;

  append(draft: Draft): Promise<Event>;
  appendAll(drafts: Draft[]): Promise<Event[]>;

  ingest(events: AsyncIterable<Event>): Promise<Ingested>;

  scan(filter?: Filter): AsyncIterable<Event>;

  changes(
    filter?: Filter,
    since?: ChangeToken
  ): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }>;

  damaged(): Promise<Damaged[]>;
  conflicting(): Promise<Conflict[]>;
}
```

A store MAY expose additional backend diagnostics, transactions or
indexes. Portable code MUST depend only on the interface above.

### 5.1 `append`

`append(draft)`:

1. validates that `draft.type`, `draft.blobs` and `draft.data` can form a
   valid event;
2. obtains one clock reading;
3. mints a UUIDv7 `eid` and RFC 3339 UTC `at` from it;
4. sets `author` to the store's current author;
5. treats omitted `blobs` as `[]`; and
6. writes and returns the complete event.

When the returned promise resolves, a process restart MUST observe the
whole event or none of it. A backend MAY separately document stronger
power-loss durability such as `fsync`.

Appends through one store handle are serialized. Concurrent handles over
one writable serialization require an external lock supplied by the
backend or host application.

### 5.2 `appendAll`

`appendAll` is one all-or-nothing logical append. It MUST validate every
draft before writing any event. It then:

- assigns one common `at`;
- mints UUIDv7 event IDs in input order;
- assigns the current author to every event; and
- makes the entire batch visible together after a process restart.

The operation is used when a procedure must not leave only part of a
set of decisions, for example contact deletion tombstones and their
known erasures.

An empty input returns an empty array and writes nothing.

### 5.3 `ingest`

`ingest` accepts events from a snapshot, another backend or
`vault-sync/1.0`. It reads or stages its complete input before committing
anything needed for the fork check below.

For each valid incoming event:

- absent `eid`: add it;
- same `eid`, same content: count a duplicate and add nothing;
- same `eid`, different content: keep the value already accepted by this
  store, report a conflict and add nothing.

Rejected envelopes are reported and never stored. A backend MUST NOT
partially reinterpret a malformed line into an event.

#### Forked author

If an incoming event has `author == store.author` and is not already
present with identical content, the writable local author has forked:
two copies wrote or retained different histories under one replica ID.
The store MUST fail with `ForkedAuthor` before adding any incoming event.

The recovery is operational:

1. close the writable store;
2. mint a fresh local replica ID and store generation;
3. reopen with the new author; and
4. repeat ingest.

Existing events under the old author remain immutable history. This rule
detects accidental cloned local state. It does not authenticate an author
against a malicious holder of the shared seed.

### 5.4 `scan`

`scan(filter)` yields one accepted event per `eid`, in canonical order.
The filter is equality only:

- `author` equals the requested author;
- `type` equals the requested type; and
- every specified top-level field of `data` equals the requested JSON
  primitive.

`undefined` means no constraint. `null` matches a present JSON null.
There are no range, join, full-text or nested-field semantics in this
interface. Such views are folds and indexes above the store.

### 5.5 `changes`

`changes(filter, since)` returns a local frontier token and every matching
event this store gained after `since` and no later than the returned
token. Each event appears once. No order is promised.

A token is meaningful only to:

- the store generation that issued it; and
- the particular event set, main vault or one extension store, that
  issued it.

A store MUST reject a token it cannot place, including a token from
another generation, another extension, a truncated segment set or a
future position. The caller then discards the related cache and refolds
from `scan()`.

A token is not an authorization credential, replica cursor, Lamport
clock, vector clock or network synchronization token. A client MUST NOT
send it to another replica or to the sync store.

### 5.6 Damage and conflicts

**Damage** is storage material that cannot be decoded as a valid event or
block. It is reported with its location and excluded from normal reads.
A backend MAY quarantine damaged bytes but MUST NOT present them as a
valid event or missing-by-policy blob.

**Conflict** is more than one JSON content for one `eid`. The store never
creates one through `append` or `ingest`; a folder can contain one after
a manual edit or copied segment. Each backend MUST define a stable local
tie-break for reads and report every discarded content. The tie-break is
not a claim that the selected content is correct.

## 6. Folds and local caches

A fold:

- consumes events in any order;
- is deterministic over the accepted event set;
- does not depend on the current replica ID unless it is explicitly a
  local operational view rather than vault state; and
- can be rebuilt from `scan()`.

A cached fold stores its projection and the local `ChangeToken` to which
it was advanced. On open it applies `changes()` and advances. If the
token is rejected or a consistency check fails, it discards the cache
and refolds.

Caches belong under local state. They do not appear in snapshots,
exports or vault sync.

## 7. BlobStore

The vault's blob store is a block store for the `unixfs-v1-2025`
profile used by `@estoc/folder-object`.

```ts
interface BlobStore {
  put(bytes: Uint8Array): Promise<Cid>;
  get(root: Cid): Promise<Uint8Array | null>;

  putBlock(cid: Cid, bytes: Uint8Array): Promise<void>;
  getBlock(cid: Cid): Promise<Uint8Array | null>;
  has(cid: Cid): Promise<boolean>;
  list(): Promise<Cid[]>;

  collect(keep: Cid[]): Promise<{
    unlinked: Cid[];
    young: Cid[];
  }>;
}
```

### 7.1 Profile and names

A block name is a canonical lowercase base32 CIDv1 using sha2-256 and
one of:

- `raw`, for bare blocks no larger than 1 MiB; or
- `dag-pb`, for nodes in the fixed UnixFS profile.

A file no larger than 1 MiB is one raw block. Larger files use raw 1 MiB
chunks and the profile's deterministic balanced dag-pb layout. A
received object may be a directory or HAMT tree within the same profile.

`put(bytes)` computes the profile representation and returns its root.
`putBlock(cid, bytes)` MUST verify both the hash and, for dag-pb, the
profile shape before accepting the block. A caller cannot assign an
arbitrary CID to bytes.

`get(root)` returns reconstructed file bytes, returns `null` when the
root or a required child is absent, and rejects a root that is not a
file. Object-tree traversal uses `getBlock` through the object layer.

### 7.2 Write ordering

A producer writes leaves before parents and every required block before
the event whose `blobs` retains the root. A process crash can therefore
leave unreferenced blocks, but a successful event append does not depend
on bytes that were never accepted locally.

A transactional backend MAY commit blocks and event together.

### 7.3 Missing and damaged blocks

The blob store reports only presence and damage. The semantic layer
decides whether an absent block means:

- globally erased by a vault event;
- missing or corrupt local data; or
- not yet fetched for a type that explicitly permits a partial tree.

A damaged block is treated as absent after being reported or
quarantined.

### 7.4 Collection

`collect(keep)` walks every root in `keep`, retains every reachable block,
and may unlink an unreachable block only after the backend's orphan
grace period.

The grace protects a block written shortly before the event that will
reference it. Repeating `put` or `putBlock` for an existing valid block
MUST renew its local age.

Collection is serialized with block reads and writes. It MUST NOT race a
`put` in the same store generation. Only the application computes
`keep`, using `vault-events.md`; the blob store reads no event type.

## 8. Portable files and local state

### 8.1 FileStore

```ts
interface FileStore {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<string[]>;
}
```

Portable files are everything in the interchange format that is neither
an event segment nor a blob block. `vault-folder.md` defines reserved
paths and singleton merge policies.

A `FileStore` path MUST NOT address:

- an event segment;
- a blob block;
- `local/`;
- an owned structural directory; or
- a path that would make one name both a file and a directory.

Version-3 correctness-critical mutable state MUST be an event or blob,
not an arbitrary portable file. Unknown portable files are carried for
forward compatibility but are not interpreted or synchronized by
`vault-sync/1.0` unless another protocol defines them.

### 8.2 Local state

Local state includes:

- current replica ID;
- store generation;
- process and browser locks;
- fold caches and indexes;
- mediator sockets and pickup cursors;
- retry timers;
- local options;
- traces and retention configuration; and
- extension-local caches, traces and options.

It is not exposed through `FileStore`, not present in a snapshot, and not
merged or synchronized. Anything whose loss would violate a committed
user decision is in the wrong place.

## 9. Extension stores

An installed extension may keep portable identity state in its own:

```ts
interface ExtensionStore {
  events: EventStore;
  blobs: BlobStore;
}
```

The extension store:

- uses the same current local author as the main vault store;
- has a separate event-ID set and separate blob-retention fold;
- is exported and synchronized under its extension ID;
- has no nested extensions, independent seed or independent identity;
- keeps its non-portable state under local extension state; and
- is disposed as one unit after the vault's extension lifecycle fold says
  it is purged.

An extension event ID may equal a main-vault event ID without conflict
because they belong to different sets. Within one extension store, the
normal `eid` rules apply.

Disposal deletes the extension's event/blob store and its local state,
invalidates every outstanding handle, and prevents the same process from
silently recreating it. The vault event that requested purge remains in
the main event set.

## 10. Vault interface

```ts
interface Vault {
  readonly events: EventStore;
  readonly blobs: BlobStore;
  readonly files: FileStore;

  extension(ext: string): ExtensionStore;
  extensions(): Promise<string[]>;
  dispose(ext: string): Promise<void>;
}
```

`extensions()` returns extension IDs for which portable bytes currently
exist. Whether an ID is allowed to run or be opened is decided by the
extension lifecycle fold above this interface.

The current replica and other local state are intentionally absent from
`Vault`. A host opens a vault backend with a local replica context and
obtains stores already configured with that author.

## 11. Interchange

### 11.1 Folder round trip

Every backend MUST export a version-3 `.estoc/` folder and import one.
For any conforming vault:

- every event returns with identical JSON content and `eid`;
- every retained blob block returns byte-for-byte under the same CID;
- every portable file returns byte-for-byte unless its documented
  singleton merge policy applies; and
- local state does not travel.

The folder is the readable sovereignty format. `vault-sync/1.0` is a
separate encrypted wire representation and is not a folder export.

### 11.2 Export

Export writes the complete portable vault:

- all main events;
- all retained main blob blocks;
- all portable files;
- every non-disposed extension event and blob store; and
- no local state.

Segment boundaries and names are serialization details. Two exports of
the same event set need not have the same segment files.

### 11.3 Import into an existing vault

Import is allowed only when source and target have the same format
version and anchor identity. It performs a complete preflight before the
first semantic write:

1. validate the folder structure and singleton shapes;
2. decode and validate every source event envelope;
3. compute fork checks for the main store and every extension store that
   may be imported;
4. verify every source block that may be copied; and
5. determine extension stores already purged by the merged main event
   set.

A preflight failure writes nothing.

After preflight, import:

1. ingests main events by `eid`;
2. copies valid source blocks required by the merged held-root fold and
   absent from the target;
3. applies singleton and opaque-file policies;
4. imports each allowed extension's events and blocks; and
5. applies pending extension disposal.

The operation is idempotent. It never copies an event segment as an
opaque file; it decodes and ingests events. An erased root is not revived
merely because source bytes still exist.

Local state, including the target replica ID, is untouched.

### 11.4 Restore and bootstrap

A restore reads a folder into an empty backend. It writes portable state
only. On first writable open, the host mints a new local replica ID and
store generation.

A folder copied together with `local/` is an exact local move, not a
portable snapshot. Preserving its replica ID is safe only when the old
writer no longer exists.

`vault-sync/1.0` additionally supports bootstrap of the version-3 core
vault from the vault seed and sync-store locator. That protocol reconstructs
the immutable root, event and block objects; the new local copy then creates
its own passphrase wrapping and local replica context. Opaque portable files
not represented by a versioned sync object remain folder-interchange data
and are not reconstructed by this bootstrap.

## 12. Synchronization boundary

Replica synchronization is immutable anti-entropy:

```text
remote block absent locally  -> verify and putBlock
remote event absent locally  -> validate and ingest
same eid, same content        -> duplicate
same eid, different content   -> conflict
```

`vault-sync/1.0` encrypts these objects before an untrusted server sees
them. It uses opaque object IDs and full inventory as the correctness
fallback.

A sync client SHOULD publish referenced blocks before publishing an
event and SHOULD fetch required blocks before ingesting an event. A
temporary missing block is surfaced as incomplete local data, never as an
erase.

No synchronization correctness depends on `changes()`, a server push,
one replica staying online or a mutable local queue.

## 13. Backend obligations

A folder, SQL database, IndexedDB store or in-memory test store may all
conform. A backend chooses its own indexes and physical transactions but
MUST provide the same accepted event set and the same observable
semantics.

A database commonly uses:

```sql
CREATE TABLE events (
  seq      INTEGER PRIMARY KEY,
  eid      TEXT NOT NULL UNIQUE,
  at       TEXT NOT NULL,
  author   TEXT NOT NULL,
  type     TEXT NOT NULL,
  blobs    TEXT NOT NULL,
  data     TEXT NOT NULL
);

CREATE INDEX events_canonical ON events (at, eid, author);
CREATE INDEX events_author ON events (author);
CREATE INDEX events_type ON events (type);
```

`seq` is local insertion order used by a local change token. It is not
part of the event and MUST NOT affect a fold or export.

A backend MUST document:

- process-crash durability;
- power-loss durability;
- orphan grace for blob collection;
- maximum event, batch and blob sizes; and
- locking requirements for concurrent handles.

## 14. Versioning

`config.json.version` covers the event envelope, folder layout,
singleton meanings and vault-event semantics together. This document is
version 3.

A version-3 reader MUST refuse another version before interpreting or
writing portable state. There is no migration requirement in this
document.

Within version 3, compatible changes are limited to:

- a new event type;
- an optional field in a known event payload whose absence has a fixed
  meaning;
- a new top-level opaque portable file outside reserved structural
  directories; or
- an explicitly negotiated protocol capability.

Changing an existing field's meaning, event-envelope fields, ID format,
folder path grammar, key derivation or required fold rule requires a new
vault version.

## 15. Required conformance cases

A conforming implementation MUST pass at least these cases:

1. `append` returns a six-field event with `author` equal to the current
   replica ID.
2. `appendAll` is all-or-nothing and gives every event one timestamp.
3. Ingesting the same event twice produces one stored event.
4. Ingesting a different content under an existing `eid` reports a
   conflict and does not overwrite.
5. Ingesting a previously unseen event authored by the current local
   author fails with `ForkedAuthor` before adding anything.
6. Shuffling and repartitioning one event set does not change a fold.
7. `scan()` returns canonical order independently of physical order.
8. `changes()` returns a complete local delta and rejects another store
   generation's token.
9. A token is never required for successful full reconciliation.
10. `putBlock` rejects a CID/content mismatch.
11. A crash after block write but before event append leaves only a
    collectable orphan.
12. Collection never removes a block reachable from a held root.
13. Export and re-import preserve every event and portable byte.
14. Restore omits local state and mints a fresh replica ID.
15. Main and extension stores with the same event ID do not conflict.
16. Disposing an extension invalidates all handles and does not remove
    the main-vault purge event.
17. No API interprets a hardware or operating-system identifier.
18. Events produced by a retired replica remain valid immutable history.
