# The Estoc event store, version 3

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — clean-break event and object model with SQLite as the sole
persistent vault and interchange format for one active writable Estoc runtime. The author model remains
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
| [event-store.md](event-store.md) | event and vault-store interfaces and their observable semantics |
| [dasl-objects.md](dasl-objects.md) | the pinned raw DASL CID, object and retention profile |
| [vault-sqlite.md](vault-sqlite.md) | the SQLite runtime, portable schema and recovery procedures |
| [vault-events.md](vault-events.md) | the meaning and folds of the vault's own event types |
| [distributed-delivery.md](distributed-delivery.md) | vault-first send, packaging, retry and end-to-end acknowledgment |
| [relationships.md](relationships.md) | Symmetric relationships, pinned resolution and early address-rotation policy |
| [replica-mediation.md](replica-mediation.md) | **deferred:** mediator fan-out and per-replica pickup acknowledgment |
| [vault-sync.md](vault-sync.md) | **deferred:** encrypted anti-entropy through an untrusted sync store |

Dependency runs downward. [dasl-objects.md](dasl-objects.md) defines the object layer used
here. [vault-sqlite.md](vault-sqlite.md) persists and exports this model. [vault-events.md](vault-events.md) defines
payloads above it. The delivery, mediation and sync protocols and the relationship profile use
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
- [8. Metadata, keystore and local state](#metadata-and-local-state)
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

A phase-1 vault is an immutable event set, retained objects and typed identity
metadata, persisted with one active local execution environment in SQLite:

```text
portable vault
    events       immutable facts, merged by `eventId`
    DASL objects  immutable content-addressed bytes
    metadata     immutable anchor/version and encrypted seed wrapper

local copy
    replica ID, store generation, accepted positions, locks, caches, traces and options
```

The portable values define the identity's recoverable state. Local execution
state and storage control are non-portable even though they share the database.
SQLite recovery determines the accepted view; staged input is never accepted
merely because its rows exist. [vault-sqlite.md](vault-sqlite.md) defines the
common schema, local control and construction of a portable snapshot. There is
no generic portable-file API or folder interchange.

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
3. **Folds are functions of the event set.** Ingest order, physical row order,
   replica order and transport order MUST NOT change a fold's result.
4. **Authorship is explicit.** The event's `author` identifies the
   writable local replica that created it. A database index or sync envelope
   MUST NOT supply or replace authorship.
5. **One active writer per author.** Two concurrent writable copies MUST
   NOT share one author ID. The store detects this condition when it can.
6. **Object references are explicit.** The event envelope lists every object
   root the event retains. A CID elsewhere in `data` is not a reference.
7. **Objects and references commit together.** A local `Vault.commit` verifies
   every referenced root and accepts its new objects and entire event batch in
   one SQLite transaction (section 10).
8. **Only DASL objects are collected.** Events, metadata and the seed wrapper
   are not garbage-collected through the object API.
9. **Caches are not correctness state.** Losing caches or resetting local
   identity MUST NOT lose a committed decision or message body. Ordinary cache
   clearing preserves storage control and author selection. Future replica
   mediation may add network registration, but phase 1 does not.
10. **SQLite is the persistent and interchange format.** Export and import
    preserve the event set, retained object bytes and typed identity metadata
    under section 11. The folder format is retired.
11. **Local change tokens are not synchronization cursors.** Phase 1 uses
    them only inside one store generation. Deferred `vault-sync/1.0` defines a
    separate network cursor model.
12. **One active writer in phase 1.** Event authorship distinguishes writable
    incarnations and detects accidental forks. A future full replica holding
    the same seed would be equally trusted; author IDs are not a security
    boundary.
13. **Successful commits are process-durable.** When an append, ingest, object
    acceptance or keystore replacement reports success, a later process restart
    over the same intact storage generation observes the complete committed
    value. Power-loss durability is a separate backend policy.
14. **Collection shares the vault writer lock.** Computing held roots and
    deleting objects cannot overlap a reference commit (section 10).

<a id="commit-and-durability-terminology"></a>

### 2.1 Commit and durability terminology

Successful resolution of an operation's promise confirms its value is
**accepted** or **committed**. The database transaction may already have
committed before confirmation reaches the caller; an unresolved or rejected
promise is not evidence of rollback.

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
| `at` | RFC 3339 UTC wall-clock reading taken by the appending store at the append |
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
on the event. An indexed database column confirms an author but never supplies one.

<a id="roots"></a>

### 3.2 `roots`

`roots` contains every root retained by that event. The list:

- MUST be present even when empty;
- MUST contain canonical CIDs accepted by the object profile in section 7;
- SHOULD contain no duplicate root;
- MUST be sufficient for a collector that does not understand `type`;
- MUST NOT include a CID that is merely mentioned as a name or evidence; and
- in a local commit, MUST name objects already accepted or verified for
  acceptance in that same transaction.

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
compare the RFC 8785 canonical bytes. Persistent and portable SQLite rows
store exactly those bytes in a BLOB, without a trailing LF;
[vault-sqlite.md section 5](vault-sqlite.md#events-and-change-tokens) requires
indexed columns to agree with the canonical value.

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

The store mints `eventId` and `at` as part of a local append.

`eventId` comes from a standard RFC 9562 UUIDv7 generator. This profile adds
no requirement of its own to that generator: how it fills `rand_a` and
`rand_b`, whether and how it counts within a millisecond, what it does when a
counter is full and what it does when the wall clock moves backwards are the
generator's, within RFC 9562. A generator that holds its embedded timestamp
across a rollback, or advances it to make room for another ID, is behaving as
RFC 9562 section 6.2 allows.

`at` is one integer Unix-millisecond wall-clock reading `t`, formatted as
`YYYY-MM-DDTHH:mm:ss.sssZ`. A sub-millisecond clock is truncated to the integer
millisecond. Leap-second spelling (`ss == 60`), omitted fractional seconds and
any precision other than three digits are rejected.

The UUID's `unix_ts_ms` and `at` are two observations of the same wall clock,
usually of the same millisecond, but nothing requires them to be equal: the
generator may have moved its timestamp, and the store reads the clock for `at`
on its own. `at` is the event's time; the embedded timestamp is the
generator's.

Separate appends and `appendAll` draw from one generator under the writer
lock of section 10. Monotonicity within a millisecond — IDs comparing in mint
order — is a property of the selected generator, which RFC 9562 section 6.2
describes how to obtain; it is not a conformance requirement of this profile.

If the wall clock moves backwards, a later local append uses the newly sampled,
possibly smaller, `t` for `at`; its `eventId` is still distinct from every ID
minted before, as RFC 9562 requires of the generator. This profile neither
clamps wall time nor introduces a hybrid logical clock. Canonical order
(section 4.3) is not a vault-wide append or causal order, and need not match
input order within one `appendAll`.

If the generator cannot produce an ID, the append or batch fails before any
part of it commits (sections 5.1 and 5.2).

Reader and ingest validation check canonical UUIDv7 syntax and canonical `at`
syntax independently. They MUST NOT compare the UUID's embedded timestamp with
`at`: the two are separate observations even for a locally appended event.

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
2. reads the wall clock once and formats it as `at` (section 4.2);
3. mints a UUIDv7 `eventId` from the generator of section 4.2;
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

- reads the wall clock once and assigns that one `at` to every event of the
  batch;
- mints one distinct UUIDv7 per draft, in input order, from the generator of
  section 4.2;
- returns events in input order; canonical order remains the tuple of section
  4.3 and need not match it;
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

`ingest` accepts events from a portable snapshot, another store or
`vault-sync/1.0`. It reads or stages its complete input before committing
anything needed for the fork check below.

For each valid incoming event:

- absent `eventId`: add it;
- same `eventId`, same content: count a duplicate and add nothing;
- same `eventId`, different content: keep the value already accepted by this
  store, report a conflict and add nothing.

Rejected envelopes are reported and never stored. A backend MUST NOT
partially reinterpret malformed input into an event. The new accepted events,
positions and projection update/invalidation commit in one transaction after
the complete fork check. When `ingest` resolves, every event counted in `added`
is process-durable under section 2.1. A pre-resolution process crash leaves
all or none of those new accepted events. Retrying is idempotent. Full-vault
import also includes object acceptance in that transaction under section 11.3.

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

For a fixed observed store state, `scan(filter)` MUST yield the same
events, in the same order, as applying that equality filter to the output
of `scan()`. A filter MUST NOT expose a rejected conflicting value.

<a id="changes"></a>

### 5.5 `changes`

`changes(filter, since)` returns a local frontier token and every matching
event this store gained after `since` and no later than the returned
token. Each event appears once. No order is promised.

A token is meaningful only to:

- the store generation that issued it; and
- the vault event set that issued it.

A store MUST reject a token it cannot place, including a token from
another generation or vault, a malformed encoding or a future position. The caller then discards the related cache and refolds
from `scan()`. SQLite positions, fixed scan cuts and the token encoding are
defined by [vault-sqlite.md section 5](vault-sqlite.md#events-and-change-tokens).

A token is not an authorization credential, replica cursor, Lamport
clock, vector clock or network synchronization token. A client MUST NOT
send it to another replica or to the sync store.

<a id="damage-and-conflicts"></a>

### 5.6 Damage and conflicts

**Damage** is storage material that cannot be decoded as a valid event or
DASL object, including disagreement between canonical event bytes and indexed
columns. It is reported with its location and excluded from diagnostic reads.
Event damage makes the event view incomplete and blocks mutation, GC and full
export; it MUST NOT silently shrink the accepted history. Structural SQLite
corruption fails the runtime. Object damage is isolated by CID and physical
version under [vault-sqlite.md section 6](vault-sqlite.md#objects-and-streams).

**Conflict** is different canonical content offered for an already accepted
`eventId`. The store keeps its existing value, reports the rejected input and
never overwrites either source. `conflicting()` reports conflicts observed in
the current runtime, with that same accepted value as `kept`; diagnostic
retention is local and may be cleared. The database admits only one accepted
row per ID. Duplicate accepted IDs caused by structural damage are not resolved
by inventing a row-order winner. Read filters cannot change the accepted value.

<a id="folds-and-local-caches"></a>

## 6. Folds and local caches

A fold:

- consumes events in any order;
- is deterministic over the accepted event set;
- does not depend on the current replica ID unless it is explicitly a
  local operational view rather than vault state; and
- can be rebuilt from `scan()`.

A cached fold records its projection version, local generation and complete
event frontier. Acceptance either updates it with its checkpoint or invalidates
it in the same transaction. Invalid or incompatible projections are rebuilt
before use. Incremental updates MUST equal folding the complete accepted set,
including late events and newly available evidence; arrival order is not a
fold order. Rebuild/publication rules are defined by
[vault-sqlite.md section 7](vault-sqlite.md#local-state-and-projections).

Caches belong under local state. They do not appear in snapshots,
exports or vault sync.

<a id="objectstore"></a>

## 7. ObjectStore

Object references are the event envelope's `roots` array (section 3.2).
Only the vault runtime computes `keep` under [vault-events.md section 12.3](vault-events.md#held-roots);
the object store reads no event type and application callers cannot supply a
keep set.

[dasl-objects.md](dasl-objects.md) defines `ObjectStore`, whole-resource identity,
verification-before-acceptance, collection and object damage.

<a id="metadata-and-local-state"></a>

## 8. Metadata, keystore and local state

<a id="metadata-and-keystore"></a>

### 8.1 Metadata and keystore

```ts
type VaultMetadata = Readonly<{
  version: 3;
  anchor: string;
}>;

type WrappedSeed = {
  version: 3;
  seedJwe: JsonObject;
};

interface KeystoreAccess {
  read(): Promise<WrappedSeed>;
  rewrap(next: WrappedSeed): Promise<void>;
}
```

`Vault.metadata` exposes immutable typed metadata. The unlocked runtime host
owns `KeystoreAccess`; `rewrap` is a privileged operation that validates a
replacement wrapper for the same seed/anchor before atomically replacing it.
The cryptographic check is part of the host operation, not a generic row-write
API. Reading returns a detached value and does not grant identity authority.
[vault-sqlite.md section 4](vault-sqlite.md#identity-and-keystore) defines exact
storage bytes, validation, rewrap, recovery and import policy.

There is no `FileStore`, arbitrary path API, unknown-file preservation or
generic mutable portable table. New authoritative application state uses
versioned events and referenced objects; the metadata and seed wrapper are the
specified identity singletons. Runtime callers cannot use a keystore write to
change the seed or anchor.

<a id="local-state"></a>

### 8.2 Local state

Local execution data includes options, caches, traces, retry timers and
transport bookkeeping. Runtime control additionally includes replica/generation
selection, event positions, object acceptance times and schema/initialization
state. Both are stored in the same SQLite database and excluded from portable
snapshots and synchronization.

Ordinary cache reset preserves control, options and the seed wrapper. An
explicit local-identity reset changes both IDs atomically and invalidates the
old generation's caches. Missing control is damage, not implicit creation.
Anything whose loss would lose a committed decision or message body belongs
in events/objects rather than a cache or local queue.

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
  readonly metadata: VaultMetadata;
  readonly events: Pick<EventStore, "scan" | "changes" | "damaged" | "conflicting">;
  readonly objects: Omit<ObjectStore, "putRaw" | "putObject" | "collect">;

  commit(objects: CommitObject[], drafts: Draft[]): Promise<Event[]>;
}
```

`ByteSource` is defined by [dasl-objects.md](dasl-objects.md). Each supplied object
names its expected raw CID. Preparation and private staged rows do not accept
it into `Vault.objects`. Application callers cannot perform standalone object
puts or supply a collector keep set. The runtime computes held roots under
[vault-events.md section 12.3](vault-events.md#held-roots).

`commit(objects, drafts)` holds the writer lock while validating drafts,
staging and verifying all supplied objects, checking every root (including
reused objects), and publishing one process-durable transaction. Each root
must identify a present accepted object or this operation's complete verified
candidate. New object mappings, the entire event batch, accepted frontier and
projection updates/invalidations commit together. A rollback or validation
failure accepts no new objects or events; private staging may remain. An
uncertain commit outcome halts the runtime until SQLite recovery establishes
the accepted state. A successful commit may accept unreferenced objects, which
then follow ordinary orphan grace.

`Vault.events` is read-only. Locally authored events with no new objects use
`commit([], drafts)` with the same validation and lock. Import/restore use
internal stage/accept operations within their own validated transaction; they
cannot publish objects through separately committed put calls first.

Phase 1 has one exclusive owner per physical runtime database across all
processes and workers. It brokers every live handle. A separate vault-wide
operation lock serializes semantic mutations, including events, objects,
keystore rewrap and local changes that affect an operation. Nested stores share
that lock and the enclosing final transaction. The operation lock may span
asynchronous preparation; a SQL write transaction MUST NOT span stream waits
or network effects. SQLite write serialization does not replace lifetime
ownership or procedure serialization.

Under the operation lock, object `open` checks presence and registers a
per-CID and physical-version latch before exposing a stream. The stream then
releases that lock and reads bounded chunks. It keeps its latch until EOF,
failure, cancellation or owner shutdown. Idle time never releases protection.
Two streams have independent latches. A repair uses a new immutable version;
a paused stream never switches physical versions or reads unprotected bytes.

Collection takes the same operation lock before computing held roots and holds
it through its deletion transaction. A keep set computed before the lock MUST
NOT be used. Collection skips a latched CID without waiting and may remove
other eligible objects. Stream lifetime does not hold the writer lock, except
when nested inside a full operation such as export which already owns that
lock for its complete boundary.

Independent live database readers are not supported in phase 1. A client uses
the owner's broker, waits or fails. With no owner, an inspector acquires the
same exclusive ownership before opening the runtime and holds it until all
reads end. A later writer waits or fails. Broker loss fails its streams; a
client MUST NOT fall back to direct database reads. Isolated immutable portable
snapshots can be read independently. Details are in
[vault-sqlite.md section 8](vault-sqlite.md#ownership-and-lifecycle).

`ingest` holds the operation lock from target-state fork/duplicate checks through
its final transaction. Import and export hold it over the full boundaries in
section 11. Receipt allocation and bootstrap integrity checks use this same
lock. The host configures stores with the current local replica; author
selection and local control are not writable fields of `Vault`.

<a id="interchange"></a>

## 11. Interchange

<a id="sqlite-round-trip"></a>

### 11.1 SQLite round trip

Every persistent vault MUST export and import the portable SQLite format in
[vault-sqlite.md](vault-sqlite.md). A conforming round trip preserves:

- every event's exact RFC 8785 canonical bytes and `eventId`;
- every currently held DASL object's exact bytes and CID;
- immutable metadata and the exported encrypted seed wrapper, except that
  import into an existing vault retains the target wrapper; and
- no source local state, control positions or staging.

SQLite pages, physical data IDs and runtime indexes are not portable identity.
There is no folder/JSONL interchange or opaque-file merge. `vault-sync/1.0`
remains a separate encrypted wire representation, not a SQLite-file upload.

<a id="export"></a>

### 11.2 Export

Export selects one consistent event/metadata/keystore/held-root cut and holds
section 10's writer lock through copying, verification and publication. It
writes every event and exactly the currently held object set to a new database
with the prescribed portable schema. Missing/damaged held bytes or an
incomplete event view fail complete export. Rewrap, erasure and GC wait.

The exporter copies an explicit table/column allowlist into a fresh database;
cloning the runtime and deleting local rows is not conforming. Local IDs,
options, caches, traces, control rows, staging, quarantine and unheld content
never enter the output. Every event BLOB is exactly `canonicalEventBytes(event)`
without a newline. The final standalone file needs no journal or runtime VFS
state and is reported successful only after output completes. Publication and
memory bounds are defined by
[vault-sqlite.md section 10](vault-sqlite.md#snapshot-and-export).

<a id="import-into-an-existing-vault"></a>

### 11.3 Import into an existing vault

Import accepts a complete stable portable SQLite source with the same vault
version and anchor as the target. It holds the writer lock from target-state
preflight through the final transaction. Full preflight:

1. validates the source schema, metadata, wrapper, events and object bytes;
2. checks canonical duplicate/conflict and own-author fork conditions;
3. computes the prospective accepted event union and held-root fold with
   erasure closure;
4. derives semantic projections, retaining valid conflicting facts rather
   than selecting a winner by arrival order; and
5. verifies every required root has sound bytes in source or target.

These are full-vault duties, not domain payload validation by the opaque
`EventStore.ingest` API. Receipt-conflict rules in
[vault-events.md section 10.2](vault-events.md#message-in) continue to apply.
A preflight may write private staging rows but MUST change no accepted state
on failure. The source remains stable throughout validation and use, is opened
with restricted read capabilities, and supplies no executable schema or
migration to the target.

After verification, one SQLite transaction accepts new/repaired required
objects and all new events, allocates positions and updates or invalidates
projections. It MUST NOT expose visible sub-batches. A process crash leaves the
complete old or complete new union after SQLite recovery. There is no folder
publication journal or partially applied accepted union for application code
to replay. Unpublished staging can be discarded; cache reset cannot publish it.
An uncertain final result halts ordinary work until reopen resolves it.

Import is idempotent. It preserves the target identity, wrapper, author and
generation and assigns its own physical IDs/positions. Only objects required
by the prospective union are newly accepted. An old source cannot revive an
erased message/root relation; another live reference to the CID may retain
those bytes. Missing non-erased held material fails complete import. Invalid
projections are rebuilt before any query, GC or worker relies on them.

Explicit partial event/object ingestion may diagnose missing data, including
for deferred sync, but MUST NOT be described as a complete portable import or
restore or enable work dependent on missing material. Exact source validation
and merge rules are in
[vault-sqlite.md sections 11](vault-sqlite.md#portable-source-validation) and
[12](vault-sqlite.md#restore-and-import).

<a id="restore-and-bootstrap"></a>

### 11.4 Restore and bootstrap

Restore reads a complete portable snapshot into a new SQLite runtime, validates
the recovery credential against its anchor, and adopts its seed wrapper. It
preserves historical authors but mints fresh local replica/generation IDs,
positions and acceptance times. A ready marker is published only after the
complete destination validates. Recovery reconstructs held roots and unfinished
committed work before normal operation.

An exact local move instead transfers the complete quiesced runtime and MAY
preserve its author/generation only when the source is permanently stopped.
A stale local copy restored after later source writes refreshes local identity
and invalidates checkpoints. The standalone-file and ownership conditions in
[vault-sqlite.md section 12.3](vault-sqlite.md#exact-local-move) apply.

Deferred `vault-sync/1.0` bootstrap reconstructs a fresh SQLite runtime from
verified immutable configuration, events and DASL objects using the seed and
sync locator. It creates a new seed wrapper and local context; it never copies
another runtime's database pages or local state.

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

SQLite is the sole persistent backend. Native and WASM drivers implement the
same schema and observable semantics in [vault-sqlite.md](vault-sqlite.md).
Memory implementations may run common semantic tests but cannot establish
persistence, restart or portable-file conformance. An additional filesystem,
IndexedDB or opaque path-to-bytes backend is not part of this version.

The implementation MUST document and verify:

- engine/driver/VFS versions and supported platforms;
- effective journal, synchronization and foreign-key settings;
- the mandatory process-durable success boundary and any stronger power-loss
  claim with its platform evidence;
- exclusive ownership, operation locking and brokered stream protection;
- orphan grace, staging/quarantine cleanup and collection transactions;
- exact integer/BLOB conversion, event/batch/object and temporary-space limits;
- backup construction and file-output memory bounds or enforced size limits; and
- close, halt, schema-upgrade and ambiguous-commit recovery behavior.

Core DDL and portable schema belong to the SQLite specification; application
indexes/projections must remain rebuildable and preserve canonical event bytes.
SQL statements and identifiers come from the implementation, values are bound
parameters, and portable input cannot provide executable SQL.

<a id="versioning"></a>

## 14. Versioning

`vault_meta.vault_version` covers the event envelope, object profile, key
derivation and vault-event semantics together. This document is version 3.
SQLite schema evolution is additionally versioned by `PRAGMA user_version`
under [vault-sqlite.md section 2](vault-sqlite.md#format-and-versions).

Version 3 is an unreleased draft. Its current schema supersedes earlier draft
spellings without a migration or read alias; for example, the event envelope
uses `eventId`. The compatibility rules below apply to published versions.

A version-3 reader MUST refuse another version before interpreting or
writing portable state. There is no migration requirement in this
document.

Within version 3, compatible changes are limited to:

- a new event type;
- an optional field in a known event payload whose absence has a fixed
  meaning; or
- an explicitly negotiated protocol capability.

Changing an existing field's meaning, event-envelope fields, ID format,
CID profile, key derivation or required fold rule requires a new vault version.
Portable schema changes require a new SQLite schema version; arbitrary tables
or columns cannot be added as opaque portable state.

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
10. <a id="es-10"></a> A portable SQLite export stores each event BLOB as exact RFC 8785 UTF-8
   without a trailing LF; re-import preserves those bytes and indexed fields.
11. <a id="es-11"></a> `changes()` returns a complete local delta and rejects another store
    generation's token.
12. <a id="es-12"></a> A token is never required for successful full reconciliation.
13. <a id="es-13"></a> Export and re-import preserve every canonical event byte, held object and
    typed metadata value, with the defined seed-wrapper import policy.
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
    every ID is distinct and the batch comes back in input order.
20. <a id="es-20"></a> After clock rollback, a local writer's `at` follows the newly sampled
    earlier millisecond and its `eventId` collides with nothing minted before;
    the UUID's embedded timestamp need not follow. A batch still shares one
    `at`.
21. <a id="es-21"></a> Ingest validates UUIDv7 and `at` independently and does not reject immutable
    history merely because their encoded timestamps differ.
22. <a id="es-22"></a> A failure to mint an ID fails the append or batch before any event in it
    commits; the store never accepts a proper subset.

<a id="import-collection-and-reader-protection-es-23-es-32"></a>

### Import, collection and reader protection (ES-23–ES-32)

23. <a id="es-23"></a> Concurrent erasure/GC cannot publish an export with a dangling held root;
    the selected cut remains protected or the export aborts before publication.
24. <a id="es-24"></a> Crash at each full-import boundary exposes the complete previous or new
    union after SQLite recovery. Clearing caches cannot accept staged rows or
    expose a partial union.
25. <a id="es-25"></a> Full import updates or invalidates projections in its final transaction;
    queries, workers and GC never consume an invalid projection.
26. <a id="es-26"></a> Import/export never carries runtime control or recovery data. Extra source
    tables and executable schema are rejected; an unpublished database or one
    requiring an external journal is not a complete portable snapshot.
27. <a id="es-27"></a> Within an active writer runtime, a paused object stream does not block
    another handle's commit or keystore rewrap. Collection skips its CID
    without waiting and can collect an unrelated eligible CID. Completion,
    failure and cancellation each release the latch so a later pass can
    collect the now-unkept object.
28. <a id="es-28"></a> Racing `open` with collection either obtains a protected complete object
    or returns null after deletion; it never exposes an unprotected stream.
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
31. <a id="es-31"></a> A client reads through the active owner's broker. Collection skips
    its protected object and may collect unrelated CIDs; broker loss fails its
    streams. An independent client cannot bypass ownership with a live SQL read.
32. <a id="es-32"></a> With no owner, an inspector takes exclusive ownership before opening
    a runtime object stream. A later writable open waits or fails until all
    inspection statements and streams end. Independent immutable portable
    snapshots can be read without owning the original runtime.
