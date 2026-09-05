# The Estoc event store, version 3

Status: **draft, phase 1** — clean-break event, object and interchange model
for one active writable Estoc vault runtime. The author model remains
replication-ready, while network replica synchronization is deferred.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

This is one of eight documents in the protocol suite. Six define the phase-1
vault and delivery system; `replica-mediation.md` and `vault-sync.md` are
deferred extensions:

| document | defines |
| --- | --- |
| `event-store.md` | the medium-independent event and vault-store interfaces |
| `dasl-objects.md` | the pinned DASL CID, object, retention and CAR profile |
| `vault-folder.md` | the readable `.estoc/` interchange serialization |
| `vault-events.md` | the meaning and folds of the vault's own event types |
| `distributed-delivery.md` | vault-first send, packaging, retry and end-to-end acknowledgment |
| `rendezvous.md` | method-neutral rendezvous, Peer-DID default, optional Web facade and pairwise handoff |
| `replica-mediation.md` | **deferred:** mediator fan-out and per-replica pickup acknowledgment |
| `vault-sync.md` | **deferred:** encrypted anti-entropy through an untrusted sync store |

Dependency runs downward. `dasl-objects.md` defines the object layer used
here. `vault-folder.md` serializes this model. `vault-events.md` defines
payloads above it. The delivery, rendezvous, mediation and sync protocols use
the event and object primitives but do not change their meaning.

## 1. Scope

A phase-1 vault is three portable sets and one active local execution
environment:

```text
portable vault
    events       immutable facts, merged by `eid`
    DASL objects  immutable content-addressed bytes
    files        singleton and opaque portable files

local copy
    replica ID, store generation, locks, caches, traces and options
```

The portable sets define the identity's recoverable state. Local state is
not part of the vault, is never synchronized, and is omitted from every
portable snapshot. Backend import staging and publication-recovery metadata
are also non-portable; the reference folder reserves `import/` for them under
`vault-folder.md` section 3. They are recovered before normal access and are
not opaque portable files or deletable local caches.

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
2. **Merge is set union by event ID.** The same `eid` with identical RFC 8785
   canonical event bytes is a duplicate. The same `eid` with different content
   is a conflict and MUST NOT overwrite either store's accepted value.
3. **Folds are functions of the event set.** Ingest order, segment order,
   replica order and transport order MUST NOT change a fold's result.
4. **Authorship is explicit.** The event's `author` identifies the
   writable local replica that created it. A path, database row or sync
   envelope MUST NOT supply or replace authorship.
5. **One active writer per author.** Two concurrent writable copies MUST
   NOT share one author ID. The store detects this condition when it can.
6. **Object references are explicit.** The event envelope lists every object
   root the event retains. A CID elsewhere in `data` is not a reference.
7. **Objects precede references.** A producer writes and validates every
   referenced DASL object before appending an event that makes it recoverable
   state.
8. **Only DASL objects are collected.** Events and portable files are not
   garbage-collected through the object API.
9. **Local state is not correctness state.** Losing `local/` may require
   minting a new local author and rebuilding caches, but MUST NOT lose a
   committed user decision or message body. Future replica-mediation may add
   network registration, but phase 1 does not.
10. **The folder is the interchange format.** Every backend MUST be able
    to export and import the version-3 folder without changing the event
    set or portable bytes.
11. **Local change tokens are not synchronization cursors.** Phase 1 uses
    them only inside one store generation. Deferred `vault-sync/1.0` defines a
    separate network cursor model.
12. **One active writer in phase 1.** Event authorship distinguishes writable
    incarnations and detects accidental forks. A future full replica holding
    the same seed would be equally trusted; author IDs are not a security
    boundary.
13. **Successful commits are process-durable.** When an append, ingest, object
    acceptance or portable-file write reports success, a later process restart
    over the same intact storage generation observes the complete committed
    value. Power-loss durability is a separate backend policy.
14. **Collection is coordinated with reference commits.** An object cannot be
    unlinked while it is retained by a committed event or while an in-flight
    operation may still commit a reference to it.

### 2.1 Commit and durability terminology

A value is **accepted** or **committed** only after the operation's promise
resolves successfully.

- If the process terminates before resolution, a restart MAY observe the
  complete value or no value, but MUST NOT observe a partially accepted value.
- After successful resolution, every later process restart over the same
  intact storage generation MUST observe the complete value.
- Sudden power loss, storage-device failure and loss of volatile operating-system
  caches are outside this minimum. A backend that offers stronger stable-media
  durability MUST document the required flush or `fsync` policy and the point
  at which that stronger guarantee is reached.

Unless another section explicitly says otherwise, the words **durable** and
**durably committed** in the phase-1 protocol suite mean this process-durable
success boundary. A product MUST NOT claim power-loss-safe receipt merely from
this minimum contract.

## 3. The event

An event is a JSON object with exactly six top-level fields:

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [field: string]: JsonValue };
type JsonObject = { [field: string]: JsonValue };
type Cid = string;

type Event<D extends JsonObject = JsonObject> = {
  eid: string;
  at: string;
  author: string;
  type: string;
  roots: Cid[];
  data: D;
};
```

| field | meaning |
| --- | --- |
| `eid` | canonical UUIDv7, minted by the appending store; event identity and deduplication key |
| `at` | RFC 3339 UTC timestamp obtained with the `eid` |
| `author` | canonical UUIDv7 identifying the local replica that appended the event |
| `type` | non-empty event-type string |
| `roots` | complete list of retained object roots, always present, `[]` when none |
| `data` | type-specific JSON object, always present, `{}` when empty |

Example:

```json
{
  "eid": "019b2a46-8b36-75c6-a74b-81a2aa5fb407",
  "at": "2026-09-03T15:04:05.123Z",
  "author": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
  "type": "contact.petname",
  "roots": [],
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

### 3.2 `roots`

`roots` contains every root retained by that event. The list:

- MUST be present even when empty;
- MUST contain canonical CIDs accepted by the object profile in section 7;
- SHOULD contain no duplicate root;
- MUST be sufficient for a collector that does not understand `type`;
- MUST NOT include a CID that is merely mentioned as a name or evidence;
  and
- MUST be written only after the referenced objects have been accepted by
  the local object store.

A type may repeat the roots in `data` under semantic names such as
`body`, `attachments` or `envelope`. Repetition does not create another
reference. A type such as `message.erased` may name roots to release in
`data.drop`; those roots MUST NOT appear in that event's `roots`.

### 3.3 RFC 8785 canonical JSON and equality

Every event MUST be valid input to the JSON Canonicalization Scheme (JCS) in
RFC 8785. In particular, event JSON is restricted to I-JSON:

- an object MUST NOT contain duplicate member names;
- strings MUST contain valid Unicode and MUST NOT contain an unpaired
  surrogate;
- numbers MUST be finite IEEE-754 binary64 values; values requiring greater
  integer or decimal precision MUST be encoded as strings;
- `undefined`, bigint, cycles, host objects and implementation-specific values
  are forbidden; and
- parsed string data is preserved exactly; Unicode normalization is not
  performed.

Define the canonical event bytes as:

```text
canonicalEventBytes(event) = UTF8(RFC8785(event))
```

The RFC 8785 serialization recursively sorts object member names, preserves
array order, emits the specified ECMAScript number representation and emits no
insignificant whitespace. These bytes are the sole content-equality
representation for events.

Two events have the same content exactly when their
`canonicalEventBytes` are byte-for-byte equal. The comparison includes all six
top-level fields. A backend MUST NOT substitute parser-specific structural
equality, source-text equality, locale sorting or a non-JCS stable-stringify
algorithm.

`append`, `appendAll` and `ingest` MUST validate JCS eligibility before an
event becomes accepted. `ingest` MAY receive non-canonical source JSON, but it
MUST parse with duplicate-name detection, reject invalid I-JSON and store or
compare the RFC 8785 canonical bytes. Folder serialization is stricter:
section 11 and `vault-folder.md` require each JSONL event record itself to be
the canonical bytes followed by one LF.

### 3.4 Envelope validation

On append and ingest, the store MUST reject an event unless:

- the value is a JSON object;
- the top-level member set is exactly
  `eid`, `at`, `author`, `type`, `roots`, `data`;
- `eid` is a canonical lowercase UUIDv7;
- `at` is a valid Gregorian UTC instant in the exact canonical form
  `YYYY-MM-DDTHH:mm:ss.sssZ`, with exactly three fractional digits and seconds
  from `00` through `59`;
- `author` is a canonical lowercase UUIDv7;
- `type` is a non-empty string;
- `roots` is an array of canonical profile CIDs;
- `data` is a JSON object; and
- the complete event is valid I-JSON and can be serialized by RFC 8785.

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

The store mints `eid` and `at` as part of a local append. It obtains one
integer Unix-millisecond clock reading `t`, embeds exactly `t` in the UUIDv7
`unix_ts_ms` field, and formats the same `t` as
`YYYY-MM-DDTHH:mm:ss.sssZ`. A sub-millisecond clock is truncated to the integer
millisecond before both values are produced. Leap-second spelling (`ss == 60`),
omitted fractional seconds and any precision other than three digits are
rejected.

The writer MUST serialize UUIDv7 allocation. Within one writer runtime, during
an interval without clock rollback, IDs minted with equal `t` MUST compare in
mint order. Separate appends and `appendAll` share this allocator state;
independently randomizing ordering-significant bits for each ID is insufficient.

The generator MUST follow RFC 9562. Section 6.2 method 1 or method 2 counters,
including a counter spanning `rand_a` and part of `rand_b`, MAY be used. This
profile assigns no fixed counter layout and MUST NOT be implemented with an
assumed 4096-event limit. Counter exhaustion MUST NOT wrap or produce an
out-of-order ID; allocation must fail before any part of the append or batch
commits.

Repeated generation within one millisecond, including an `appendAll` containing
more than 4096 events, MUST produce distinct UUIDs while preserving the sampled
`t` in every UUID. A generator MUST NOT advance the embedded UUID timestamp
merely to create room for another ID because that would break the local
`eid`/`at` writer contract. If its chosen generation strategy cannot produce the
requested unique IDs for that timestamp, it MUST fail before committing the
append or batch.

If the wall clock moves backwards, a later local append uses the newly sampled,
possibly smaller, `t` for both `eid` and `at`. The generator still MUST avoid a
UUID collision, including when rollback revisits a previously used millisecond.
The mint-order guarantee does not span a rollback or runtime restart. This
profile neither clamps wall time nor introduces a hybrid logical clock.
Canonical order matches input order within one `appendAll`, but is not a
vault-wide append or causal order.

Reader and ingest validation check canonical UUIDv7 syntax and canonical `at`
syntax independently. They MUST NOT compare the UUID's embedded timestamp with
`at`; equality of those values is a writer-generation contract for locally
appended events, not an acceptance rule for imported immutable history.

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

String comparison uses the literal field values. Because every accepted `at`
uses the same UTC form and millisecond precision, this lexical comparison also
orders accepted timestamps by their represented instant. Event equality and
persistence use RFC 8785 canonical bytes. Since `eid` is expected to be unique,
`author` is normally only a defensive final component.

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
type Draft<D extends JsonObject = JsonObject> = {
  type: string;
  roots?: Cid[];
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

1. validates that `draft.type`, `draft.roots` and `draft.data` can form a
   valid event;
2. obtains one clock reading;
3. mints a UUIDv7 `eid` and RFC 3339 UTC `at` from it;
4. sets `author` to the store's current author;
5. treats omitted `roots` as `[]`; and
6. writes and returns the complete event.

If the process terminates before the returned promise resolves, a restart MAY
observe the complete event or no event, but never a partial accepted event.
When the promise resolves, the event is committed under section 2.1 and every
later process restart MUST observe the complete event. Stable-media survival
across sudden power loss requires the backend's separately documented flush or
`fsync` boundary.

Appends through one store handle are serialized. Concurrent handles over
one writable serialization require an external lock supplied by the
backend or host application.

### 5.2 `appendAll`

`appendAll` is one all-or-nothing logical append. It MUST validate every
draft before writing any event. It then:

- obtains one common integer-millisecond clock sample and assigns the matching
  common `at`;
- mints one distinct UUIDv7 per draft in input order, each embedding that same
  sampled millisecond and obeying section 4.2's monotonic allocation rule;
- returns events in input order, which is also this batch's canonical order;
- assigns the current author to every event; and
- commits the entire batch at one process-durable success boundary.

If the process terminates before resolution, a restart may observe the complete
batch or no batch, but MUST NOT observe a proper subset as accepted. After
resolution, every later process restart observes the entire batch.

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
partially reinterpret a malformed line into an event. When `ingest` resolves,
every event counted in `added` is process-durable under section 2.1. An
implementation that commits ingest in internal batches may expose a subset of
whole events after a pre-resolution process crash; retrying the same input is
idempotent and completes the union.

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
Returned objects MUST parse from the accepted RFC 8785 canonical event bytes.
The filter is equality only:

- `author` equals the requested author;
- `type` equals the requested type; and
- every specified top-level field of `data` has the same RFC 8785 canonical
  JSON value as the requested JSON primitive.

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
DASL object. It is reported with its location and excluded from normal reads.
A backend MAY quarantine damaged bytes but MUST NOT present them as a
valid event or missing-by-policy object.

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

## 7. ObjectStore

The vault object store implements `dasl-objects.md`. It accepts only canonical
DASL CIDs using CIDv1, lowercase base32, SHA-256 and either the `raw` or DRISL
codec. Portable UnixFS DAG layouts, DAG-PB, CIDv0 and BDASL are not part
of version 3; raw objects remain valid regardless of how identical bytes were
produced.

```ts
declare const drislLinkBrand: unique symbol;

type DrislLink = {
  readonly [drislLinkBrand]: true;
  readonly cid: Cid;
};

type DrislValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | Uint8Array
  | DrislLink
  | readonly DrislValue[]
  | ReadonlyMap<string, DrislValue>;

type ByteSource =
  | Uint8Array
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;

type ObjectInfo = {
  cid: Cid;
  codec: "raw" | "drisl";
  size: number;
};

interface ObjectStore {
  putRaw(source: ByteSource): Promise<ObjectInfo>;
  putDrisl(value: DrislValue): Promise<ObjectInfo>;
  putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo>;

  open(cid: Cid): Promise<ReadableStream<Uint8Array> | null>;
  read(cid: Cid, maxBytes: number): Promise<Uint8Array | null>;
  readDrisl(cid: Cid, maxBytes: number): Promise<DrislValue | null>;

  stat(cid: Cid): Promise<ObjectInfo | null>;
  has(cid: Cid): Promise<boolean>;
  list(): AsyncIterable<Cid>;

  collect(keep: Iterable<Cid>): Promise<{
    unlinked: Cid[];
    young: Cid[];
  }>;
}
```

### 7.1 Whole-resource identity

A raw object CID identifies the complete exact byte sequence, regardless of
size. A DRISL CID identifies one complete canonical DRISL object. Portable
large objects are not represented as chunk DAGs.

A backend MAY store one portable object in private extents, and a transport MAY
send it in private segments, but those pieces have no portable CID. Changing
extent or segment size MUST NOT change the object CID or exported bytes.

`putRaw` computes a raw DASL CID while consuming a finite stream.
`putDrisl` canonicalizes and validates one bounded DRISL value.
`putObject` verifies exact encoded bytes against an expected CID and publishes
nothing until all hash and codec checks succeed.

### 7.2 Write ordering

A producer process-durably accepts every object in an event's `roots` before
appending that event. From the first successful object acceptance until the
referencing event commits or the operation aborts, the producer MUST protect
the object against collection with a vault-level exclusion, temporary pin,
transaction or an equivalent retention guard. A process crash can therefore
leave an unreferenced object, but a successful event append does not depend on
bytes that were never accepted locally.

A transactional backend MAY commit objects and the event together when the
externally visible result preserves the same invariant. An orphan grace period
is crash cleanup policy; it is not a substitute for protecting a live
write-before-reference operation.

### 7.3 Missing and damaged objects

The object store reports presence, validated codec/size and damage. The
semantic layer decides whether an absent object means:

- globally erased by a vault event;
- missing or corrupt local data; or
- not yet fetched under an explicitly partial local view.

A CID/content mismatch or non-conforming DRISL encoding is damage. A damaged
object is treated as absent after being reported or quarantined.

### 7.4 Explicit roots and collection

Only exact CIDs in the semantic layer's held-root set are retained.
`collect(keep)` MUST NOT recursively follow DRISL Tag 42 links. A linked object
that must remain available is listed explicitly in an event's `roots`.

The local-vault invariant is:

> Collection MUST NOT delete an object retained by any committed event and
> MUST NOT delete an object protected by an in-flight reference commit.

An orphan grace period may delay cleanup of abandoned accepted objects, but no
fixed grace interval can establish this invariant by itself. Repeating a
successful `putRaw`, `putDrisl` or `putObject` MAY renew orphan age only as a
storage-policy optimization.

The caller and backend MUST coordinate the interval from held-root snapshot to
physical unlink with event commits and pending-reference guards. A pending-
reference guard is owned by one running writer/recovery generation and has no
portable lifetime. After process restart, the backend MUST first recover the
complete committed event set and reconstruct its held-root set, then classify
all guards owned by the previous runtime as abandoned, and only then enable
collection. Clearing an abandoned guard does not make its object an orphan when
a recovered committed event still retains that object. If no recovered event
retains it, the object is ordinary abandoned pre-reference data and becomes
eligible only under the documented orphan-grace rule.

A conforming implementation does one of the following, or an equivalent
operation:

1. holds a vault-level exclusion from the complete committed-event snapshot
   through unlink;
2. commits event references, pins and collection in one database transaction;
   or
3. immediately before each unlink, atomically revalidates both the committed
   event frontier and pending pins, abandoning or recomputing the sweep when
   either changed.

A stale `keep` snapshot MUST NOT authorize deletion after a new reference has
committed. Collection is also serialized with object acceptance and reads. Only
the application computes `keep`, using `vault-events.md`; the object store reads
no event type.

## 8. Portable files and local state

### 8.1 FileStore

```ts
interface FileStore {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<string[]>;
}
```

Portable files are the portable part of the interchange format other than
event segments and DASL objects. Local and backend recovery metadata are
excluded. `vault-folder.md` defines reserved paths and singleton merge
policies.

A `FileStore` path MUST NOT address:

- an event segment;
- a DASL object;
- `local/` or backend import-recovery metadata under `import/`;
- an owned structural directory; or
- a path that would make one name both a file and a directory.

Version-3 correctness-critical mutable state MUST be an event or object,
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
  objects: ObjectStore;
}
```

The extension store:

- uses the same current local author as the main vault store;
- has a separate event-ID set and separate object-retention fold;
- is exported and synchronized under its extension ID;
- has no nested extensions, independent seed or independent identity;
- keeps its non-portable state under local extension state; and
- is disposed as one unit after the vault's extension lifecycle fold says
  it is purged.

An extension event ID may equal a main-vault event ID without conflict
because they belong to different sets. Within one extension store, the
normal `eid` rules apply.

Disposal deletes the extension's event/object store and its local state,
invalidates every outstanding handle, and prevents the same process from
silently recreating it. The vault event that requested purge remains in
the main event set.

## 10. Vault interface

```ts
interface Vault {
  readonly events: EventStore;
  readonly objects: ObjectStore;
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

- every event returns with identical RFC 8785 canonical bytes and `eid`;
- every retained DASL object returns byte-for-byte under the same CID;
- every portable file returns byte-for-byte unless its documented
  singleton merge policy applies; and
- local state does not travel.

The folder is the readable sovereignty format. `vault-sync/1.0` is a
separate encrypted wire representation and is not a folder export.

### 11.2 Export

Export writes the complete portable vault:

- all main events;
- all retained main DASL objects;
- all portable files;
- every non-disposed extension event and object store; and
- no local state or backend import staging/recovery metadata.

Every complete event record in a segment is exactly
`canonicalEventBytes(event)` followed by byte `0x0A`. A writer MUST NOT pretty
print an event or preserve non-canonical imported member order. Segment
boundaries and names are serialization details. Two exports of the same event
set need not have the same segment files.

An export MUST select one consistent portable-state cut: the main and extension
event sets, extension lifecycle, portable-file contents and exact held roots.
An event scan and an unrelated later object listing do not establish a cut.
The exporter MUST protect the cut's required objects from collection until
copying and verification finish, using snapshot pins, a transaction, or a
quiescence lock. Mutable portable files MUST come from the same cut.

Erasure and export MUST be serialized, or a concurrent erasure MUST invalidate
and abort the export before publication. A snapshot pin is not authority to
revive erased content. The destination remains unpublished until every required
object and file validates. Missing or damaged non-erased content makes the
export incomplete; it MUST NOT be reported as a successful complete snapshot.
Temporary protection is released on completion or abort under the normal
recovery rules. A phase-1 backend MAY quiesce the vault for the whole operation.

### 11.3 Import into an existing vault

Import is allowed only when source and target have the same format
version and anchor identity. It performs a complete preflight before the
first semantic write:

1. validate the folder structure and singleton shapes;
2. decode and validate every source event envelope;
3. compute fork checks for the main store and every extension store that
   may be imported;
4. compute the prospective merged event sets and held-root folds, applying
   erasure and extension-purge rules;
5. derive vault-level semantic projections, preserving valid conflicting
   facts rather than choosing a winner by arrival order; and
6. verify every object to be copied and require every prospective non-erased
   held root to have valid bytes in the source or target.

Receipt-ordinal reuse is not a full-import preflight failure. Distinct authors
may share an ordinal; same-author receipt-pair conflicts remain visible vault
projections under `vault-events.md` section 10.2. The importer preserves the
event union and limits only work affected by a projected conflict. Existing
`ForkedAuthor`, envelope, identity and object-integrity checks still apply.

These are full-vault importer duties, not payload validation by the opaque
`EventStore.ingest` API. A preflight failure writes nothing. Preflight and
publication MUST be serialized with competing vault mutations, or atomically
revalidated against the same target frontier before publication.

After preflight, import:

1. stages the prospective main and allowed extension event sets;
2. accepts the required absent objects with pending-reference protection before
   publishing their importing references;
3. applies singleton and opaque-file policies to the staged view;
4. excludes purged extension stores and schedules any remaining disposal; and
5. verifies the prospective held-root requirements and publishes the complete
   merged view.

The backend MUST use a staged-generation publication boundary or an equivalent
recoverable import barrier. A crash leaves either the previous usable view or
an explicitly incomplete import; ordinary workers and GC MUST NOT act on a
partial event union as if it were the completed import. A correctness-critical
barrier MUST survive restart and deletion of `local/`, identify the intended
import, and carry enough recovery information to finish or safely roll back.
It is backend recovery metadata, not a new vault-domain event. The reference
folder keeps it under the reserved, non-portable `import/` root defined by
`vault-folder.md` section 3. A backend unable to provide such a barrier MUST
keep the generation unpublished instead. Import and export MUST exclude this
metadata, not carry it as opaque portable files or execute a source's recovery
journal as instructions for the target. An incomplete source must be recovered
or read through a verified complete published generation before full import.

A completed full import requires all non-erased held objects. An explicitly
requested partial-data import MAY expose missing-material diagnostics, but
MUST NOT be described as a complete restore or enable work that needs missing
material. Recovery reconstructs committed retention before releasing abandoned
guards or enabling collection. This contract requires no giant transaction;
a phase-1 backend MAY keep the vault quiescent while staging and publishing.

The operation is idempotent. It decodes and ingests events rather than copying
segments as opaque files. Source bytes do not revive an erased message/root
relation; another independently live reference to the same CID may still retain
those bytes. Target identity, seed wrapping and local author selection are
unchanged. Rebuildable indexes, including the receipt-ordinal high-water mark,
are refreshed from the published union before ordinary work resumes.

### 11.4 Restore and bootstrap

A restore reads a folder into an empty backend. It writes portable state
only. On first writable open, the host mints a new local replica ID and
store generation.

A folder copied together with `local/` is an exact local move, not a
portable snapshot. Preserving its replica ID is safe only when the old
writer no longer exists.

`vault-sync/1.0` additionally supports bootstrap of the version-3 core
vault from the vault seed and sync-store locator. That protocol reconstructs
the immutable root, event and DASL objects; the new local copy then creates
its own passphrase wrapping and local replica context. Opaque portable files
not represented by a versioned sync object remain folder-interchange data
and are not reconstructed by this bootstrap.

## 12. Synchronization boundary

Replica synchronization is immutable anti-entropy:

```text
remote object absent locally -> verify and putObject
remote event absent locally  -> validate and ingest
same eid, same content        -> duplicate
same eid, different content   -> conflict
```

`vault-sync/1.0` encrypts these objects before an untrusted server sees
them. It uses opaque object IDs and full inventory as the correctness
fallback.

A sync client SHOULD publish referenced objects before publishing an
event and SHOULD fetch required objects before ingesting an event. A
temporary missing object is surfaced as incomplete local data, never as an
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
  roots    TEXT NOT NULL,
  data     TEXT NOT NULL,
  canonical BLOB NOT NULL
);

CREATE INDEX events_canonical ON events (at, eid, author);
CREATE INDEX events_author ON events (author);
CREATE INDEX events_type ON events (type);
```

`canonical` is the RFC 8785 UTF-8 event representation used for equality,
conflict checks and export. A backend MAY instead reconstruct it from validated
columns, but the result MUST be byte-identical. `seq` is local insertion order
used by a local change token. It is not
part of the event and MUST NOT affect a fold or export.

A backend MUST implement the mandatory process-durable success boundary in
section 2.1 and document:

- its stronger power-loss durability and flush policy, if any;
- orphan grace for abandoned objects;
- the lock, transaction, pin or frontier-revalidation mechanism used to
  coordinate collection with event reference commits;
- maximum event, batch and object sizes; and
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
   replica ID; after successful resolution, immediate process termination and
   reopen still observes the complete event.
2. A process crash before `append` resolves may leave the complete event or no
   event, never a partial accepted event.
3. `appendAll` is all-or-nothing, gives every event one timestamp, and remains
   complete after successful resolution and process restart.
4. A JCS-ineligible event, including duplicate member names, an unpaired
   surrogate or a non-I-JSON number, is rejected before acceptance.
5. Two source serializations with different member order or whitespace but
   equal RFC 8785 output ingest as one event.
6. The same `eid` with different RFC 8785 canonical bytes reports a conflict
   and does not overwrite either value.
7. Ingesting a previously unseen event authored by the current local author
   fails with `ForkedAuthor` before adding anything.
8. Shuffling and repartitioning one event set does not change a fold.
9. `scan()` returns canonical event order independently of physical order.
10. A folder export emits each JSONL event as exact RFC 8785 UTF-8 followed by
   one LF; re-import preserves those canonical bytes.
11. `changes()` returns a complete local delta and rejects another store
    generation's token.
12. A token is never required for successful full reconciliation.
13. `putObject` rejects a CID/content mismatch and non-canonical DRISL.
14. A crash after object acceptance but before event append leaves only a
    collectable orphan.
15. Collection never removes an exact object in the held-root set and never
    follows an unlisted DRISL link.
16. Export and re-import preserve every portable byte.
17. Restore omits local state and mints a fresh replica ID.
18. Main and extension stores with the same event ID do not conflict.
19. Disposing an extension invalidates all handles and does not remove the
    main-vault purge event.
20. No API interprets a hardware or operating-system identifier.
21. Events produced by a retired replica remain valid immutable history.
22. Accepted timestamps use exactly `YYYY-MM-DDTHH:mm:ss.sssZ`; omitted or
    other fractional precision and leap-second spelling are rejected, and
    lexical order matches represented millisecond order.
23. A collector that snapshots roots before a new event commit cannot unlink
    the newly referenced object; lock, transaction, pin or frontier
    revalidation detects the race.
24. Process-durable success is distinguished from the backend's separately
    documented sudden-power-loss boundary.
25. More than 4096 events may be appended in one same-millisecond `appendAll`;
    IDs are distinct, embed the unchanged sample and sort in input order.
    Back-to-back separate appends with the same sample also sort in mint order.
26. After clock rollback, a local writer uses the newly sampled earlier
    millisecond in both `eid` and `at` while avoiding collision. No mint-order
    guarantee spans rollback or restart; a batch still uses one common sample.
27. Ingest validates UUIDv7 and `at` independently and does not reject immutable
    history merely because their encoded timestamps differ.
28. After restart, committed-event retention is reconstructed before abandoned
    pending-reference guards are cleared and before collection runs. A crash
    before event commit leaves an orphan after recovery; a crash after event
    commit but before guard cleanup leaves a held object.
29. Counter exhaustion fails before any event in the append or batch commits;
    it neither wraps the counter nor advances only the UUID timestamp.
30. Concurrent erasure/GC cannot publish an export with a dangling held root;
    the selected cut remains protected or the export aborts before publication.
31. Crash at each full-import boundary exposes either the previous usable view
    or a recoverably incomplete import, never an apparently complete partial
    union. Deleting `local/` does not bypass that publication boundary.
32. Full import preserves distinct-author observations sharing an ordinal and
    exposes same-author receipt-pair conflicts as projections, not preflight
    failures. It recomputes the high-water mark from the accepted event union.
33. Import/export never includes backend recovery metadata as portable files.
    Source recovery journals are not executed on the target, and omitting a
    journal cannot turn an incomplete source into a complete snapshot.
