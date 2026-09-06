# The Estoc event store, version 3

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — clean-break event, object and interchange model
for one active writable Estoc vault runtime. The author model remains
replication-ready, while network replica synchronization is deferred.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

This is one of eight documents in the protocol suite. Six define the phase-1
vault and delivery system; [replica-mediation.md](replica-mediation.md) and [vault-sync.md](vault-sync.md) are
deferred extensions:

| document | defines |
| --- | --- |
| [event-store.md](event-store.md) | the medium-independent event and vault-store interfaces |
| [dasl-objects.md](dasl-objects.md) | the pinned raw DASL CID, object and retention profile |
| [vault-folder.md](vault-folder.md) | the readable `.estoc/` interchange serialization |
| [vault-events.md](vault-events.md) | the meaning and folds of the vault's own event types |
| [distributed-delivery.md](distributed-delivery.md) | vault-first send, packaging, retry and end-to-end acknowledgment |
| [relationships.md](relationships.md) | Symmetric relationships, pinned resolution and early address-rotation policy |
| [replica-mediation.md](replica-mediation.md) | **deferred:** mediator fan-out and per-replica pickup acknowledgment |
| [vault-sync.md](vault-sync.md) | **deferred:** encrypted anti-entropy through an untrusted sync store |

Dependency runs downward. [dasl-objects.md](dasl-objects.md) defines the object layer used
here. [vault-folder.md](vault-folder.md) serializes this model. [vault-events.md](vault-events.md) defines
payloads above it. The delivery, relationship, mediation and sync profiles use
the event and object primitives but do not change their meaning.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Implement a backend | [Envelope](#the-event) → [EventStore](#eventstore) → [Vault](#vault-interface) → [Backend obligations](#backend-obligations) |
| Understand commit guarantees | [Durability terminology](#commit-and-durability-terminology) → [Atomic append](#appendall) → [Writer lock and commit](#vault-interface) |
| Transfer or recover a vault | [Interchange](#interchange) → [Synchronization boundary](#synchronization-boundary) |

<details>
<summary>Contents</summary>

- [1. Scope](#scope)
- [2. Invariants](#invariants)
- [3. The event](#the-event)
- [4. Identity, authorship, time and order](#identity-authorship-time-and-order)
- [5. EventStore](#eventstore)
- [6. Folds and local caches](#folds-and-local-caches)
- [7. ObjectStore](#objectstore)
- [8. Portable files and local state](#portable-files-and-local-state)
- [9. Deferred extension stores](#deferred-extension-stores)
- [10. Vault interface](#vault-interface)
- [11. Interchange](#interchange)
- [12. Synchronization boundary](#synchronization-boundary)
- [13. Backend obligations](#backend-obligations)
- [14. Versioning](#versioning)
- [15. Required conformance cases](#required-conformance-cases)

</details>
<!-- reading-guide:end -->

<a id="scope"></a>

## 1. Scope

A phase-1 vault is three portable sets and one active local execution
environment:

```text
portable vault
    events       immutable facts, merged by `eventId`
    DASL objects  immutable content-addressed bytes
    files        singleton and opaque portable files

local copy
    replica ID, store generation, locks, caches, traces and options
```

The portable sets define the identity's recoverable state. Local state is
not part of the vault, is never synchronized, and is omitted from every
portable snapshot. Backend import staging and publication-recovery metadata
are also non-portable; the reference folder reserves `import/` for them under
[vault-folder.md section 3](vault-folder.md#layout). They are recovered before normal access and are
not opaque portable files or deletable local caches.

The store does not know contacts, messages, public DIDs, mediators or
replicas as domain objects. It knows only event authors. The vault layer
requires the author used for local appends to equal the current local
`replica_id`.

A writable vault runtime may execute in an end-user application or on a
server. The event store assigns no authority based on process location and
has no special web-host author type.

<a id="invariants"></a>

## 2. Invariants

Every conforming implementation preserves the following rules.

1. **Events are immutable.** An event is appended or ingested whole. No
   operation edits or deletes one.
2. **Merge is set union by event ID.** The same `eventId` with identical RFC 8785
   canonical event bytes is a duplicate. The same `eventId` with different content
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
7. **Objects precede references.** A local `Vault.commit` accepts new objects
   and verifies every referenced root before appending its events (section 10).
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
14. **Collection shares the vault writer lock.** Computing held roots and
    unlinking objects cannot overlap a reference commit (section 10).

<a id="commit-and-durability-terminology"></a>

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

<a id="the-event"></a>

## 3. The event

An event is a JSON object with exactly six top-level fields:

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [field: string]: JsonValue };
type JsonObject = { [field: string]: JsonValue };
// Cid is the validated type defined by dasl-objects.md section 6.
type EventId = string & { readonly __eventId: unique symbol };
type AuthorId = string & { readonly __authorId: unique symbol };

type Event<D extends JsonObject = JsonObject> = {
  eventId: EventId;
  at: string;
  author: AuthorId;
  type: string;
  roots: Cid[];
  data: D;
};
```

| field | meaning |
| --- | --- |
| `eventId` | canonical UUIDv7, minted by the appending store; event identity and deduplication key |
| `at` | RFC 3339 UTC timestamp obtained with the `eventId` |
| `author` | canonical UUIDv7 identifying the local replica that appended the event |
| `type` | non-empty event-type string |
| `roots` | complete list of retained object roots, always present, `[]` when none |
| `data` | type-specific JSON object, always present, `{}` when empty |

`EventId`, `AuthorId` and `Cid` are distinct validated API types that serialize
as plain strings. Type brands do not replace format validation or add fields
to the event. The generic store does not interpret domain-specific identifiers
in `data`; [vault-events.md section 3.5](vault-events.md#identifier-and-reference-vocabulary) owns their names and types. In a vault,
the author value is the local replica ID under section 4.1.

Example:

```json
{
  "eventId": "019b2a46-8b36-75c6-a74b-81a2aa5fb407",
  "at": "2026-09-03T15:04:05.123Z",
  "author": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
  "type": "contact.petname",
  "roots": [],
  "data": {
    "contactId": "019b2a45-8381-793f-943c-f5d806fd5ca2",
    "name": "Alice"
  }
}
```

<a id="data"></a>

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

<a id="roots"></a>

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
`bodyCid`, `attachmentCids` or `envelopeCid`. Repetition does not create another
reference. A type such as `message.erased` may name roots to release in
`data.dropCids`; those roots MUST NOT appear in that event's `roots`.

<a id="rfc-8785-canonical-json-and-equality"></a>

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
section 11 and [vault-folder.md](vault-folder.md) require each JSONL event record itself to be
the canonical bytes followed by one LF.

<a id="envelope-validation"></a>

### 3.4 Envelope validation

On append and ingest, the store MUST reject an event unless:

- the value is a JSON object;
- the top-level member set is exactly
  `eventId`, `at`, `author`, `type`, `roots`, `data`;
- `eventId` is a canonical lowercase UUIDv7;
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

<a id="identity-authorship-time-and-order"></a>

## 4. Identity, authorship, time and order

<a id="author"></a>

### 4.1 Author

`author` is the current local replica ID at append time. It names one
writable incarnation of a vault, not hardware, an operating-system
installation, a person or an authorization key.

A newly created writable copy mints a fresh canonical UUIDv7 author. A
portable snapshot omits the current local author selection, so opening a
restored copy also mints a fresh one. An exact physical move MAY preserve
the author only when no second writer remains.

No author- or replica-creation event is required. The existence of an
author is evident from its events. Optional replica labels and retirement
policy are deferred `replica.*` events defined in [replica-mediation.md section 5.8](replica-mediation.md#portable-replica-events); phase 1 defines none.

<a id="event-id-and-timestamp"></a>

### 4.2 Event ID and timestamp

The store mints `eventId` and `at` as part of a local append. It obtains one
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
`eventId`/`at` writer contract. If its chosen generation strategy cannot produce the
requested unique IDs for that timestamp, it MUST fail before committing the
append or batch.

If the wall clock moves backwards, a later local append uses the newly sampled,
possibly smaller, `t` for both `eventId` and `at`. The generator still MUST avoid a
UUID collision, including when rollback revisits a previously used millisecond.
The mint-order guarantee does not span a rollback or runtime restart. This
profile neither clamps wall time nor introduces a hybrid logical clock.
Canonical order matches input order within one `appendAll`, but is not a
vault-wide append or causal order.

Reader and ingest validation check canonical UUIDv7 syntax and canonical `at`
syntax independently. They MUST NOT compare the UUID's embedded timestamp with
`at`; equality of those values is a writer-generation contract for locally
appended events, not an acceptance rule for imported immutable history.

An `eventId` is trusted to be globally unique. It encodes no subject,
contact, message, author or permission. A caller that needs the minted
ID obtains it from the returned event.

`at` is a wall-clock observation. It may be wrong or move backwards. A
protocol decision whose correctness cannot tolerate timestamp ordering
MUST use explicit references, immutable IDs, tombstones or set semantics
rather than relying on latest-wins.

<a id="canonical-order"></a>

### 4.3 Canonical order

Whenever a fold or `scan()` requires one total order, events are ordered
ascending by:

```text
(at, eventId, author)
```

String comparison uses the literal field values. Because every accepted `at`
uses the same UTC form and millisecond precision, this lexical comparison also
orders accepted timestamps by their represented instant. Event equality and
persistence use RFC 8785 canonical bytes. Since `eventId` is expected to be unique,
`author` is normally only a defensive final component.

Canonical order is for presentation and explicitly declared
latest-wins fields. It does not express causality, insertion order or
network order.

<a id="other-ids"></a>

### 4.4 Other IDs

The event store does not validate IDs inside `data`. Vault event types
may use:

- UUIDv7 for locally minted entities and operations;
- UUIDv5 for deterministic cross-replica idempotency; and
- protocol-defined strings such as DIDComm message IDs.

Event IDs, encrypted package IDs and mediator delivery IDs have separate
roles. Outbound message IDs follow [vault-events.md section 9.1](vault-events.md#ids); inbound
observation and wire IDs follow [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity).

<a id="eventstore"></a>

## 5. EventStore

`EventStore` is the backend interface. Its `append`, `appendAll` and `ingest`
methods are internal to `Vault.commit` and validated import/restore, just like
the object-store put primitives. Application callers receive only the read
interface through `Vault.events` in section 10.

```ts
type Draft<D extends JsonObject = JsonObject> = {
  type: string;
  roots?: Cid[];
  data: D;
};

type Filter = {
  author?: AuthorId;
  type?: string;
  data?: { [field: string]: JsonPrimitive | undefined };
};

type ChangeToken = string;

type Conflict = {
  eventId: EventId;
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
  readonly author: AuthorId;

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

A store MAY expose additional backend diagnostics, transactions or indexes to
its runtime. Portable application code uses the section-10 vault interface.

<a id="append"></a>

### 5.1 `append`

`append(draft)`:

1. validates that `draft.type`, `draft.roots` and `draft.data` can form a
   valid event;
2. obtains one clock reading;
3. mints a UUIDv7 `eventId` and RFC 3339 UTC `at` from it;
4. sets `author` to the store's current author;
5. treats omitted `roots` as `[]`; and
6. writes and returns the complete event.

If the process terminates before the returned promise resolves, a restart MAY
observe the complete event or no event, but never a partial accepted event.
When the promise resolves, the event is committed under section 2.1 and every
later process restart MUST observe the complete event. Stable-media survival
across sudden power loss requires the backend's separately documented flush or
`fsync` boundary.

Appends use the vault-wide writer lock in section 10, including calls from
concurrent handles and workers in the same runtime.

<a id="appendall"></a>

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

<a id="ingest"></a>

### 5.3 `ingest`

`ingest` accepts events from a snapshot, another backend or
`vault-sync/1.0`. It reads or stages its complete input before committing
anything needed for the fork check below.

For each valid incoming event:

- absent `eventId`: add it;
- same `eventId`, same content: count a duplicate and add nothing;
- same `eventId`, different content: keep the value already accepted by this
  store, report a conflict and add nothing.

Rejected envelopes are reported and never stored. A backend MUST NOT
partially reinterpret a malformed line into an event. When `ingest` resolves,
every event counted in `added` is process-durable under section 2.1. An
implementation that commits ingest in internal batches may expose a subset of
whole events after a pre-resolution process crash; retrying the same input is
idempotent and completes the union.

<a id="forked-author"></a>

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

<a id="scan"></a>

### 5.4 `scan`

`scan(filter)` yields one accepted event per `eventId`, in canonical order.
Returned objects MUST parse from the accepted RFC 8785 canonical event bytes.
The filter is equality only:

- `author` equals the requested author;
- `type` equals the requested type; and
- every specified top-level field of `data` has the same RFC 8785 canonical
  JSON value as the requested JSON primitive.

`undefined` means no constraint. `null` matches a present JSON null.
There are no range, join, full-text or nested-field semantics in this
interface. Such views are folds and indexes above the store.

<a id="changes"></a>

### 5.5 `changes`

`changes(filter, since)` returns a local frontier token and every matching
event this store gained after `since` and no later than the returned
token. Each event appears once. No order is promised.

A token is meaningful only to:

- the store generation that issued it; and
- the vault event set that issued it.

A store MUST reject a token it cannot place, including a token from
another generation or vault, a truncated segment set or a
future position. The caller then discards the related cache and refolds
from `scan()`.

A token is not an authorization credential, replica cursor, Lamport
clock, vector clock or network synchronization token. A client MUST NOT
send it to another replica or to the sync store.

<a id="damage-and-conflicts"></a>

### 5.6 Damage and conflicts

**Damage** is storage material that cannot be decoded as a valid event or
DASL object. It is reported with its location and excluded from normal reads.
A backend MAY quarantine damaged bytes but MUST NOT present them as a
valid event or missing-by-policy object.

**Conflict** is more than one JSON content for one `eventId`. The store never
creates one through `append` or `ingest`; a folder can contain one after
a manual edit or copied segment. Each backend MUST define a stable local
tie-break for reads and report every discarded content. The tie-break is
not a claim that the selected content is correct.

<a id="folds-and-local-caches"></a>

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

<a id="objectstore"></a>

## 7. ObjectStore

Object references are the event envelope's `roots` array (section 3.2).
Only the vault runtime computes `keep` under [vault-events.md section 12.3](vault-events.md#held-roots);
the object store reads no event type and application callers cannot supply a
keep set.

[dasl-objects.md](dasl-objects.md) defines `ObjectStore`, whole-resource identity,
write-before-reference, collection and object damage.

<a id="portable-files-and-local-state"></a>

## 8. Portable files and local state

<a id="filestore"></a>

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
excluded. [vault-folder.md](vault-folder.md) defines reserved paths and singleton merge
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

<a id="local-state"></a>

### 8.2 Local state

Local state includes:

- current replica ID;
- store generation;
- process and browser locks;
- fold caches and indexes;
- mediator sockets and pickup cursors;
- retry timers;
- local options;
- traces and retention configuration.

It is not exposed through `FileStore`, not present in a snapshot, and not
merged or synchronized. Anything whose loss would violate a committed
user decision is in the wrong place.

<a id="deferred-extension-stores"></a>

## 9. Deferred extension stores

Extension stores are deferred alongside replica mediation and vault sync.
Phase 1 defines no extension-store API, lifecycle or portable layout.

<a id="vault-interface"></a>

## 10. Vault interface

```ts
type CommitObject = {
  cid: Cid;
  source: ByteSource;
};

interface Vault {
  readonly events: Pick<EventStore, "scan" | "changes" | "damaged" | "conflicting">;
  readonly objects: Omit<ObjectStore, "putRaw" | "putObject" | "collect">;
  readonly files: FileStore;

  commit(objects: CommitObject[], drafts: Draft[]): Promise<Event[]>;
}
```

`ByteSource` is defined by [dasl-objects.md](dasl-objects.md). Each supplied object names its
expected raw CID; preparing a source in private temporary storage does not
accept it into the portable object store.

The object put primitives are backend-internal to `commit` and the validated
import/restore paths. They are not exposed through `Vault.objects` for
standalone application writes. Application preparation uses private temporary
storage; accepting new objects and their local event references uses `commit`.
`collect(keep)` is also backend-internal. The vault runtime computes the
held-root set under [vault-events.md section 12.3](vault-events.md#held-roots) and invokes collection within
the locked boundary below; application callers cannot supply a keep set.

`commit(objects, drafts)` holds the writer lock while validating all drafts,
accepting supplied objects under `ObjectStore.putObject`'s rules, requiring
every draft root (including reused objects) to identify a present accepted
object, and appending and returning one process-durable batch under section 5.2.

Object acceptance or root-check failure appends no events. Accepted objects
may remain after failure or crash under [dasl-objects.md](dasl-objects.md)'s orphan-grace policy;
the event batch still obeys section 5.2's all-or-nothing rule.

`Vault.events` exposes reads only; it has no `append`, `appendAll` or `ingest`
method. Locally authored events with no new objects use `commit([], drafts)`
with the same payload validation, root checks and lock. Import/restore uses
the internal ingest primitive only within its validated publication boundary.

Phase 1 MUST serialize operations over one writable vault generation with one
vault-wide writer lock, across all handles and workers. The lock covers all
event, object and portable-file mutations. Nested store calls share the
enclosing operation's lock. A backend MAY use a transaction that provides the
same serialization.

Within an active writer runtime, object reads use a per-CID read latch shared
across every handle, worker and process accessing the same physical object
namespace, including read-only handles. Distinct local store-generation tokens
do not separate protection for shared bytes. `open` briefly takes the writer
lock to check object presence and register the latch before exposing a stream,
then releases that lock. A backend may broker this operation through the active
writer process; a read-only handle still participates in the same lock and
latch registry.

The latch remains until stream completion, failure or cancellation and is
released on each of those paths. A CID remains latched while any of its reads
is active. `read` uses the same protection. Abandonment without cancellation
is a caller defect: an idle or unreachable stream's latch MUST NOT time out.
It persists until one of the release paths above or the process owning that
stream exits. A process exit releases only its own latches; other processes'
live streams remain protected or fail closed; they never continue unlatched.
A slow or abandoned consumer in an active writer runtime therefore retains
only the opened object's bytes; it MUST NOT hold that runtime's writer lock
for the stream's lifetime. Reads nested inside a commit, import or export
share its existing lock without shortening that operation's required boundary.

A read-only stream opened before any writer starts needs the same protection
against a later collector. It MUST either participate in a cross-process latch
registry honored by future writers, or acquire the backend's vault
ownership before checking presence and opening bytes, holding that ownership
until all streams it protects end. This ownership is shared among readers,
exclusive against a writer, and excludes a writable open including its recovery
and collection. It is distinct from an active runtime's
operation lock. A later writable open waits or fails until ownership is
released. Completion, failure, cancellation and owner-process exit release
protection as above; idle time does not. Merely observing that no writer is
running is insufficient. [vault-folder.md section 15](vault-folder.md#concurrency-and-crash-behavior) defines the disk-folder
case without creating local state from a read-only open.

`ingest` holds the runtime's operation lock from its target-state fork and
duplicate checks through event acceptance. Collection acquires it before
computing the current held-root set and holds it through physical unlink;
a keep set computed before acquiring the lock MUST NOT be used.
Collection MUST skip a CID with an active read latch
without waiting for its reader; other eligible CIDs may be unlinked in that
pass. Latch registration and the collector's latch check/unlink are serialized
by the writer lock. Latches are local read protection, not portable retention
references; when the last latch is released, normal collection rules apply.
A backend unable to coordinate a concurrent reader with that namespace's
collector MUST refuse the live object read; it may serve an isolated immutable
snapshot instead. Complete-line event visibility alone is insufficient.
Full import and export hold the writer lock across the boundaries
defined in sections 11.2 and 11.3. Existing rules for serialized receipt
allocation and bootstrap integrity checks use this same lock.

The current replica and other local state are intentionally absent from
`Vault`. A host opens a vault backend with a local replica context and
obtains stores already configured with that author.

<a id="interchange"></a>

## 11. Interchange

<a id="folder-round-trip"></a>

### 11.1 Folder round trip

Every backend MUST export a version-3 `.estoc/` folder and import one.
For any conforming vault:

- every event returns with identical RFC 8785 canonical bytes and `eventId`;
- every retained DASL object returns byte-for-byte under the same CID;
- every portable file returns byte-for-byte unless its documented
  singleton merge policy applies; and
- local state does not travel.

The folder is the readable sovereignty format. `vault-sync/1.0` is a
separate encrypted wire representation and is not a folder export.

<a id="export"></a>

### 11.2 Export

Export writes the complete portable vault:

- all events;
- all retained DASL objects;
- all portable files; and
- no local state or backend import staging/recovery metadata.

Every complete event record in a segment is exactly
`canonicalEventBytes(event)` followed by byte `0x0A`. A writer MUST NOT pretty
print an event or preserve non-canonical imported member order. Segment
boundaries and names are serialization details. Two exports of the same event
set need not have the same segment files.

An export MUST select one consistent portable-state cut: the event set,
portable-file contents and exact held roots.
The exporter MUST hold the section-10 writer lock from selecting that cut
through copying, verification and publication. Erasure, collection and portable
file writes therefore wait for completion or abort. The destination remains
unpublished until every required object and file validates. Missing or damaged
non-erased content makes the export incomplete; it MUST NOT be reported as a
successful complete snapshot.

<a id="import-into-an-existing-vault"></a>

### 11.3 Import into an existing vault

Import is allowed only when source and target have the same format
version and anchor identity. It performs a complete preflight before the
first semantic write:

1. validate the folder structure and singleton shapes;
2. decode and validate every source event envelope;
3. compute fork checks for the event store;
4. compute the prospective merged event set and held-root fold, applying
   erasure rules;
5. derive vault-level semantic projections, preserving valid conflicting
   facts rather than choosing a winner by arrival order; and
6. verify every object to be copied and require every prospective non-erased
   held root to have valid bytes in the source or target.

The importer applies the receipt-conflict rules in [vault-events.md section 10.2](vault-events.md#message-in). Existing `ForkedAuthor`, envelope, identity and object-integrity checks
still apply.

These are full-vault importer duties, not payload validation by the opaque
`EventStore.ingest` API. A preflight failure writes nothing. Import MUST hold
the section-10 writer lock from target-state preflight through publication,
including object acceptance and ingest.

After preflight, import:

1. stages the prospective event union;
2. accepts the required absent objects before publishing their importing
   references;
3. applies singleton and opaque-file policies to the staged view; and
4. verifies the prospective held-root requirements and publishes the complete
   merged view.

The backend MUST use a staged-generation publication boundary or an equivalent
recoverable import barrier. A crash leaves either the previous usable view or
an explicitly incomplete import; ordinary workers and GC MUST NOT act on a
partial event union as if it were the completed import. A correctness-critical
barrier MUST survive restart and deletion of `local/`, identify the intended
import, and carry enough recovery information to finish or safely roll back.
It is backend recovery metadata, not a new vault-domain event. The reference
folder keeps it under the reserved, non-portable `import/` root defined by
[vault-folder.md section 3](vault-folder.md#layout). A backend unable to provide such a barrier MUST
keep the generation unpublished instead. Import and export MUST exclude this
metadata, not carry it as opaque portable files or execute a source's recovery
journal as instructions for the target. An incomplete source must be recovered
or read through a verified complete published generation before full import.

A completed full import requires all non-erased held objects. An explicitly
requested partial-data import MAY expose missing-material diagnostics, but
MUST NOT be described as a complete restore or enable work that needs missing
material. Recovery reconstructs committed retention before enabling collection.
The writer lock does not replace the recoverable publication boundary.

The operation is idempotent. It decodes and ingests events rather than copying
segments as opaque files. Source bytes do not revive an erased message/root
relation; another independently live reference to the same CID may still retain
those bytes. Target identity, seed wrapping and local author selection are
unchanged. Rebuildable indexes are refreshed from the published union before
ordinary work resumes.

<a id="restore-and-bootstrap"></a>

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

<a id="synchronization-boundary"></a>

## 12. Synchronization boundary

Replica synchronization is immutable anti-entropy:

```text
remote object absent locally -> verify and putObject
remote event absent locally  -> validate and ingest
same eventId, same content    -> duplicate
same eventId, different content -> conflict
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

<a id="backend-obligations"></a>

## 13. Backend obligations

A folder, SQL database, IndexedDB store or in-memory test store may all
conform. A backend chooses its own indexes and physical transactions but
MUST provide the same accepted event set and the same observable
semantics.

A database commonly uses:

```sql
CREATE TABLE events (
  seq       INTEGER PRIMARY KEY,
  eventId   TEXT NOT NULL UNIQUE,
  at        TEXT NOT NULL,
  author    TEXT NOT NULL,
  type      TEXT NOT NULL,
  roots     TEXT NOT NULL,
  data      TEXT NOT NULL,
  canonical BLOB NOT NULL
);

CREATE INDEX events_canonical ON events (at, eventId, author);
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
- implementation of the section-10 writer lock;
- per-CID latch registration and collection exclusion across processes,
  including read-only handles, stream cancellation and owner-process exit;
- protection of streams opened without an active writer and how a later
  writable open joins or waits for that protection;
- maximum event, batch and object sizes; and
- locking requirements for concurrent handles.

<a id="versioning"></a>

## 14. Versioning

`config.json.version` covers the event envelope, folder layout,
singleton meanings and vault-event semantics together. This document is
version 3.

Version 3 is an unreleased draft. Its current schema supersedes earlier draft
spellings without a migration or read alias; for example, the event envelope
uses `eventId`. The compatibility rules below apply to published versions.

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

<a id="required-conformance-cases"></a>

## 15. Required conformance cases

A conforming implementation MUST pass at least these cases:


<a id="commit-validation-and-event-identity-es-1-es-7"></a>

### Commit, validation and event identity (ES-1–ES-7)

1. <a id="es-1"></a> `append` returns a six-field event with `author` equal to the current
   replica ID; after successful resolution, immediate process termination and
   reopen still observes the complete event.
2. <a id="es-2"></a> A process crash before `append` resolves may leave the complete event or no
   event, never a partial accepted event.
3. <a id="es-3"></a> `commit` and its internal `appendAll` primitive append all events or none,
   give every event one timestamp, and remain complete with required objects after successful
   resolution and process restart.
4. <a id="es-4"></a> A JCS-ineligible event, including duplicate member names, an unpaired
   surrogate or a non-I-JSON number, is rejected before acceptance.
5. <a id="es-5"></a> Two source serializations with different member order or whitespace but
   equal RFC 8785 output ingest as one event.
6. <a id="es-6"></a> The same `eventId` with different RFC 8785 canonical bytes reports a conflict
   and does not overwrite either value.
7. <a id="es-7"></a> Ingesting a previously unseen event authored by the current local author
   fails with `ForkedAuthor` before adding anything.

<a id="folds-scans-and-interchange-es-8-es-16"></a>

### Folds, scans and interchange (ES-8–ES-16)

8. <a id="es-8"></a> Shuffling and repartitioning one event set does not change a fold.
9. <a id="es-9"></a> `scan()` returns canonical event order independently of physical order.
10. <a id="es-10"></a> A folder export emits each JSONL event as exact RFC 8785 UTF-8 followed by
   one LF; re-import preserves those canonical bytes.
11. <a id="es-11"></a> `changes()` returns a complete local delta and rejects another store
    generation's token.
12. <a id="es-12"></a> A token is never required for successful full reconciliation.
13. <a id="es-13"></a> Export and re-import preserve every portable byte.
14. <a id="es-14"></a> Restore omits local state and mints a fresh replica ID.
15. <a id="es-15"></a> No API interprets a hardware or operating-system identifier.
16. <a id="es-16"></a> Events produced by a retired replica remain valid immutable history.

<a id="time-ordering-and-durability-es-17-es-22"></a>

### Time, ordering and durability (ES-17–ES-22)

17. <a id="es-17"></a> Accepted timestamps use exactly `YYYY-MM-DDTHH:mm:ss.sssZ`; omitted or
    other fractional precision and leap-second spelling are rejected, and
    lexical order matches represented millisecond order.
18. <a id="es-18"></a> Process-durable success is distinguished from the backend's separately
    documented sudden-power-loss boundary.
19. <a id="es-19"></a> More than 4096 events may be appended in one same-millisecond `appendAll`;
    IDs are distinct, embed the unchanged sample and sort in input order.
    Back-to-back separate appends with the same sample also sort in mint order.
20. <a id="es-20"></a> After clock rollback, a local writer uses the newly sampled earlier
    millisecond in both `eventId` and `at` while avoiding collision. No mint-order
    guarantee spans rollback or restart; a batch still uses one common sample.
21. <a id="es-21"></a> Ingest validates UUIDv7 and `at` independently and does not reject immutable
    history merely because their encoded timestamps differ.
22. <a id="es-22"></a> Counter exhaustion fails before any event in the append or batch commits;
    it neither wraps the counter nor advances only the UUID timestamp.

<a id="import-collection-and-reader-protection-es-23-es-32"></a>

### Import, collection and reader protection (ES-23–ES-32)

23. <a id="es-23"></a> Concurrent erasure/GC cannot publish an export with a dangling held root;
    the selected cut remains protected or the export aborts before publication.
24. <a id="es-24"></a> Crash at each full-import boundary exposes either the previous usable view
    or a recoverably incomplete import, never an apparently complete partial
    union. Deleting `local/` does not bypass that publication boundary.
25. <a id="es-25"></a> Full import recomputes rebuildable indexes from the published event union
    before ordinary work resumes.
26. <a id="es-26"></a> Import/export never includes backend recovery metadata as portable files.
    Source recovery journals are not executed on the target, and omitting a
    journal cannot turn an incomplete source into a complete snapshot.
27. <a id="es-27"></a> Within an active writer runtime, a paused object stream does not block
    another handle's commit or portable-file write. Collection skips its CID
    without waiting and can collect an unrelated eligible CID. Completion,
    failure and cancellation each release the latch so a later pass can
    collect the now-unkept object.
28. <a id="es-28"></a> Racing `open` with collection either obtains a protected complete object
    or returns null after unlink; it never exposes an unprotected stream.
    When two streams read the same CID, ending one does not release the other's
    protection.
29. <a id="es-29"></a> `Vault.events` exposes only `scan`, `changes`, `damaged` and `conflicting`;
    callers cannot append or ingest through it. All local event writes,
    including those with no new objects, use `Vault.commit`.
    `Vault.objects` exposes no standalone put or collection operation.
    Application object preparation stays private until `commit` accepts it
    with its references;
    validated import/restore uses the internal object primitives. Only the
    vault runtime passes the held-root set computed under the writer lock to
    the internal collector.
30. <a id="es-30"></a> An abandoned, uncancelled stream remains latched across idle periods and
    collection passes. A still-reachable paused stream can resume to completion
    without losing protection; elapsed time alone never releases its latch.
31. <a id="es-31"></a> A read-only process opens an object while the writer process remains active.
    Collection skips that object and can collect another eligible CID. Exiting
    one reader process releases only its latches; another process's stream on
    the same CID stays protected. A backend without this coordination refuses
    live concurrent object reads rather than exposing an unprotected stream.
32. <a id="es-32"></a> A read-only process opens and pauses an object stream before any writer
    starts. A later writable open either joins its existing cross-process
    protection or waits/fails behind its shared reader ownership. There is no
    interval in which collection can unlink the stream's bytes. Two readers
    can hold shared ownership concurrently; releasing one stream or reader
    does not release another's protection. After the last
    stream ends, a writer can open and collect an otherwise eligible object.
