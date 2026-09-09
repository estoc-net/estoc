# The Estoc event store, version 3

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1**. SQLite is the sole persistent vault and interchange
format for one active writable runtime. Network replica synchronization is
deferred. This specification defines observable store semantics, not SQLite's
implementation. Capitalized requirement words have their BCP 14 meanings.

[dasl-objects.md](dasl-objects.md) defines object identity;
[vault-sqlite.md](vault-sqlite.md) owns storage, ownership and recovery procedures;
[vault-events.md](vault-events.md) owns application payloads and folds.
[Delivery](distributed-delivery.md) and [relationships](relationships.md) use
these primitives. [Replica mediation](replica-mediation.md) and
[vault sync](vault-sync.md) are deferred extensions.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Sections |
| --- | --- |
| Implement stores | [Envelope](#the-event), [identity/order](#identity-authorship-time-and-order), [EventStore](#eventstore), [Vault](#vault-interface) |
| Understand guarantees | [Durability](#commit-and-durability-terminology), [atomic append](#appendall), [SQLite procedures](vault-sqlite.md#commit-and-recovery) |
| Back up or recover | [Interchange](#interchange), [SQLite backup/restore](vault-sqlite.md#snapshot-and-export) |

<!-- reading-guide:end -->

<a id="scope"></a>

## 1. Scope

Portable vault state consists of immutable events, retained content-addressed
objects, immutable identity metadata and an encrypted seed wrapper. Local IDs,
positions, options, caches and diagnostics do not travel with that state.
SQLite's committed view determines what is accepted; private preparation is
not acceptance. There is no folder interchange or generic portable-file API.

The generic event store knows authors, not contacts, messages or relationships.
The vault requires the local append author to equal its current `replica_id`.
A server-hosted full runtime has the same rules as an end-user runtime.

<a id="invariants"></a>

## 2. Invariants

Events are immutable and merged by `eventId` using canonical-byte equality.
Folds depend on the accepted event set, never arrival or physical row order.
Authorship is explicit; a replica ID is provenance, not a credential. Phase 1
has one active writable runtime, and two writable copies cannot share an author.

Only explicit event roots retain objects. Local objects and references commit
atomically. Collection removes only unheld objects, never events or identity
metadata, and shares the operation lock with commits. Losing caches cannot lose
a committed decision or message body. Portable interchange preserves the values
below; local change tokens are not synchronization cursors.

<a id="commit-and-durability-terminology"></a>

### 2.1 Commit and durability terminology

Successful promise resolution confirms acceptance. A transaction may commit
before the caller receives confirmation; an unresolved or rejected promise is
not proof of rollback. Before resolution, a process crash may leave the complete
operation or none, never a partial accepted operation. After success, restarting
over the same intact storage generation MUST observe the complete committed
value, unless subsequently removed by an authorized operation such as object GC.

This is the suite's **process-durable** boundary. Sudden power loss, device
failure and loss of operating-system caches are separate platform guarantees.
A product claiming stronger durability must document and test that boundary;
this minimum alone is not a power-loss-safe receipt claim.

<a id="the-event"></a>

## 3. The event

An event has exactly six top-level fields:

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [field: string]: JsonValue };
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

`eventId` and `author` are canonical lowercase UUIDv7 strings. `at` is the UTC
wall-clock timestamp defined in section 4.2. `type` is nonempty; `roots` and
`data` are always present, with `[]` and `{}` permitted. `Cid` is defined in
[DO §6](dasl-objects.md#objectstore). These validated types serialize as strings;
brands do not replace validation. Domain identifiers belong to
[VE §3.5](vault-events.md#identifier-and-reference-vocabulary).

<a id="data"></a>

### 3.1 `data`

`data` is opaque to the generic store. It MUST NOT use event-type knowledge to
validate, index, merge or collect it. The vault layer validates known payloads before
append and after ingest; invalid payloads are surfaced, not reinterpreted.
Everything needed to understand an event is in its envelope and payload, not its
storage location. Unknown top-level envelope fields are rejected.

<a id="roots"></a>

### 3.2 `roots`

Every root is a canonical profile CID and an explicit retention reference.
Duplicates SHOULD be omitted. A CID merely mentioned in `data` or inside an
object is not a root. Known types list all objects they retain; unknown types
retain all their listed roots without content traversal.

A local commit requires every root to name sound accepted bytes or verified
bytes accepted in that same transaction. Fields such as `bodyCid` may repeat
roots without creating extra references. Erasure targets such as `dropCids`
MUST NOT become roots of the erasure event.

<a id="rfc-8785-canonical-json-and-equality"></a>

### 3.3 RFC 8785 canonical JSON and equality

```text
canonicalEventBytes(event) = UTF8(RFC8785(event))
```

All six fields participate in byte equality. Accept only I-JSON eligible for
RFC 8785: no duplicate member names, unpaired surrogates, non-finite numbers,
undefined values, bigint, cycles or host objects. Numbers use finite IEEE-754
binary64; values needing more precision use strings. Preserve strings exactly
without Unicode normalization. JCS sorts member names recursively, preserves
array order and uses its specified number serialization without whitespace.

Append and ingest validate before acceptance. Ingest may accept noncanonical
source JSON, but must detect duplicate members and compare/store canonical
bytes. Persistent and portable event BLOBs are exactly those bytes without a
newline. Indexed columns must agree with them; SQL JSON conversion or a generic
stable-stringify is not an alternative equality representation.

<a id="envelope-validation"></a>

### 3.4 Envelope validation

Reject unless the input is a JSON object with exactly `eventId`, `at`, `author`,
`type`, `roots` and `data`; IDs are canonical lowercase UUIDv7; `at` is a valid
Gregorian UTC instant in `YYYY-MM-DDTHH:mm:ss.sssZ`; `type` is nonempty; `roots`
is an array of canonical raw CIDs; `data` is an object; and the complete event
passes section 3.3. Seconds range from 00 through 59. Payload validation remains
above the generic store. Type brands alone cannot establish these checks.

<a id="identity-authorship-time-and-order"></a>

## 4. Identity, authorship, time and order

<a id="author"></a>

### 4.1 Author

`author` identifies a writable incarnation, not hardware, a person or an
execution-host key. Creation and portable restore mint a fresh author. Normal
reopen preserves it; an exact move may preserve it only with the old writer
permanently stopped. Historical authors are never rewritten. Phase 1 needs no
replica-creation event or mediator replica registration.

<a id="event-id-and-timestamp"></a>

### 4.2 Event ID and timestamp

Local appends mint `eventId` with a standard RFC 9562 UUIDv7 generator. Generator
counter layout, monotonicity and rollback handling are not additional Estoc
requirements. Appends share one generator under the operation lock. Failure to
mint any ID fails the whole batch before acceptance.

`at` is one integer Unix-millisecond wall-clock observation, truncating any
sub-millisecond precision and formatting it as `YYYY-MM-DDTHH:mm:ss.sssZ`.
A batch shares one reading. Leap-second spelling, missing fractions and other
fractional precision are rejected. After clock rollback, `at` follows the newly
sampled earlier time; it is not clamped or replaced with a logical clock.

The UUID's embedded time and `at` are independent observations. Readers MUST
NOT compare them or reject history because they differ. The generator may hold
or advance its own timestamp under RFC 9562. No 4096-events-per-millisecond
limit is imposed by this profile; generated IDs must remain distinct.

A caller obtains event IDs from returned events. Event IDs carry no authority
or domain identity. Decisions needing causality use explicit references,
immutable IDs, tombstones or set semantics, not wall-clock latest-wins.

<a id="canonical-order"></a>

### 4.3 Canonical order

Canonical order is ascending `(at, eventId, author)` using literal string
comparison. The fixed UTC millisecond form makes timestamp lexical order equal
represented instant order. `eventId` is globally unique; author is a defensive
final component. This is presentation order and the order for explicitly
specified latest-wins fields, not arrival order, causality or necessarily batch
input order.

<a id="other-ids"></a>

### 4.4 Other IDs

Domain payloads may use UUIDv7 entity/operation IDs, deterministic UUIDv5 IDs or
protocol-defined strings. The generic store does not validate those fields.
Outbound IDs follow [VE §9.1](vault-events.md#ids); inbound observation, wire and
execution identities follow [DD §9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity).

<a id="eventstore"></a>

## 5. EventStore

This is the internal backend interface. Application callers receive only the
read subset through `Vault.events`.

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
type Conflict = { eventId: EventId; kept: Event; rejected: Event; source?: string };
type Rejected = { value: unknown; error: string; source?: string };
type Damaged = { where: string; bytes?: Uint8Array; error: string };
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

<a id="append"></a>

### 5.1 `append`

Validate the draft, read the clock, mint an event ID, assign the current author
and default omitted roots to `[]`. Reject caller-supplied `eventId`, `at` or
`author`; they cannot override generated envelope fields. Write and return the
complete event at section 2.1's success boundary. Local vault callers use commit.

<a id="appendall"></a>

### 5.2 `appendAll`

Validate every draft before writing. Sample one `at` for the batch, mint distinct
IDs in input order, assign the current author, and accept all events in one
transaction. Return events in input order, which need not be canonical order.
An empty batch writes nothing. Crash before resolution leaves all or none;
success survives process restart. No failed batch exposes an accepted subset.

<a id="ingest"></a>

### 5.3 `ingest`

Read or stage the full input and perform fork preflight before accepting any
new event. An absent ID is added; the same ID with identical canonical bytes
counts as a duplicate; a different value for an accepted ID reports a conflict
without overwriting either source. Reject/report malformed envelopes rather
than partially reinterpreting them. Accept all new valid events and positions
in one transaction, updating or invalidating any caches. Retrying the same
input is idempotent. Full-vault import also accepts required objects atomically.

<a id="forked-author"></a>

#### Forked author

An incoming event with `author == store.author` that is not already present
with identical bytes fails the entire operation with `ForkedAuthor`. To recover,
close the runtime, atomically select a fresh replica ID and generation under
ownership, reopen and retry ingest. Old events remain unchanged. This detects
accidental cloned histories, not malicious authorship by a shared-seed holder.

<a id="scan"></a>

### 5.4 `scan`

Yield one event per accepted ID, parsed from canonical bytes, in canonical order
at one fixed cut. Filters are conjunctions of author equality, type equality
and equality of specified top-level `data` fields to the supplied JSON primitive.
`undefined` adds no constraint; `null` matches only present JSON null. Missing,
boolean and number values cannot be conflated by SQL coercion. Filtering must
equal applying the filter to the same unfiltered cut; it cannot expose rejected
conflicts. Ranges, joins, full text and nested fields are outside this API.

<a id="changes"></a>

### 5.5 `changes`

Return a frontier token and every matching event accepted after `since` through
that frontier, once each, in no promised order. Missing token starts at zero.
Late events with earlier timestamps still appear. An empty filtered result still
advances its token. Consume the complete result before checkpointing it.

A token is local to the issuing vault/generation. Reject malformed, unplaceable,
wrong-vault/generation and future tokens with `BadToken`; the caller discards
its related cache and refolds. Token encoding is private and never a wire
cursor or authorization credential. SQLite position rules are in
[SQ §5](vault-sqlite.md#events-and-change-tokens).

Portable snapshot inspection has no local change frontier. Every `changes`
call MUST reject with `UnsupportedOperation`, with or without a token; it MUST
NOT mint local IDs, positions or tokens. Use `scan`, `damaged` and `conflicting`
to inspect the snapshot.

<a id="damage-and-conflicts"></a>

### 5.6 Damage and conflicts

Damage includes invalid event bytes and disagreement with indexed columns.
Report location and exclude damaged values from diagnostic scans. Event damage
makes the history incomplete and blocks mutation, GC and full export; structural
SQLite damage fails the runtime. In-place event repair is outside the phase-1
contract. Recovery uses a validated snapshot restored into a new runtime under
[SQ §12.1](vault-sqlite.md#restore). Object damage follows
[SQ §6](vault-sqlite.md#reads-damage-and-collection).

`conflicting()` reports observed rejected values with the accepted value as
`kept`. This diagnostic history is local and may be cleared. Portable snapshot
inspection always returns an empty array from `conflicting()` because rejected
values and their diagnostic history are not exported. Never use row order
or a read filter to pick another accepted value, including after structural
damage. A conflict is not permission to overwrite an accepted event.

<a id="folds-and-local-caches"></a>

## 6. Folds and local caches

Folds are deterministic functions of the accepted event set, independent of
arrival order and, except for explicitly local views, the current replica ID.
They can always be rebuilt from `scan()`. Start with direct folds. Caching and
incremental updates are optional; correctness and invalidation requirements
are in [SQ §7](vault-sqlite.md#local-state-and-projections).

<a id="objectstore"></a>

## 7. ObjectStore

[dasl-objects.md](dasl-objects.md) owns the object API, raw identity, verification
and collection semantics. Only the vault runtime computes held roots under
[VE §12.3](vault-events.md#held-roots); callers cannot supply a keep set.

<a id="metadata-and-local-state"></a>

## 8. Metadata, keystore and local state

<a id="metadata-and-keystore"></a>

### 8.1 Metadata and keystore

```ts
type VaultMetadata = Readonly<{ version: 3; anchor: string }>;
type WrappedSeed = Readonly<{ version: 3; seedJwe: string }>;

interface KeystoreAccess {
  read(): Promise<WrappedSeed>;
  rewrap(next: WrappedSeed): Promise<void>;
}
```

Metadata is immutable. The unlocked host owns privileged rewrap and verifies
that the replacement opens to the same seed/anchor. Read returns a detached
value, not identity authority. `seedJwe` is the existing keystore package's
compact JWE string, not a new JSON JWE object. Exact bytes and recovery/import
policy are defined only in [SQ §4](vault-sqlite.md#identity-and-keystore).

There is no generic FileStore or mutable portable-table API. New authoritative
application state uses versioned events and referenced objects.

<a id="local-state"></a>

### 8.2 Local state

Local execution data and control are not portable. Cache reset preserves local
identity/control, options and the wrapper; explicit identity reset changes both
IDs without changing history. Missing control is damage, not implicit creation.
[SQ §7](vault-sqlite.md#local-state-and-projections) owns the lifecycle rules.

<a id="deferred-extension-stores"></a>

## 9. Deferred extension stores

Phase 1 defines no extension-store API, lifecycle or portable layout.

<a id="vault-interface"></a>

## 10. Vault interface

```ts
type CommitObject = { cid: Cid; source: ByteSource };

interface Vault {
  readonly metadata: VaultMetadata;
  readonly events: Pick<EventStore, "scan" | "changes" | "damaged" | "conflicting">;
  readonly objects: Omit<ObjectStore, "putRaw" | "putObject" | "collect">;
  commit(objects: CommitObject[], drafts: Draft[]): Promise<Event[]>;
}
```

Portable snapshot inspection returns a read-only `Vault`. Its `metadata` is the
snapshot's immutable metadata; `events` provides `scan`, `damaged` and
`conflicting`, and `objects` provides `open`, `read`, `stat`, `has` and `list`
under their ordinary read and damage rules. `commit` and `events.changes` MUST
always reject with `UnsupportedOperation`, without consuming object sources or
minting local IDs, positions or tokens. No local `EventStore.author` is exposed
or invented; historical event authors remain unchanged.

For a writable runtime, `commit` validates known payloads, prepares/verifies
supplied objects and checks all roots, including reused ones. Every supplied
object must be referenced by at least one draft. New objects, the entire event
batch and local positions accept in one transaction under the batch rules above.
Validation failure or rollback accepts neither new objects nor events; private
preparation may remain.
`commit([], drafts)` is the only local write path when no new objects are needed.

The vault-wide operation lock serializes semantic mutations from preflight
through publication, including receipt allocation and GC's held-root decision.
Nested stores share that lock and the enclosing transaction. Lifetime ownership,
read cancellation and SQLite procedures belong to
[SQ](vault-sqlite.md#ownership-and-lifecycle). Nonblocking reads, live brokers
and online repair are not API guarantees.

An ambiguous outcome is not a safe instruction to resubmit drafts: commit mints
new IDs on each call. Recover and reconcile the stable domain operation first
under [SQ §9.2](vault-sqlite.md#failure-and-recovery). Internal ingest, unlike a new
commit, carries existing IDs and can deduplicate retries.

<a id="interchange"></a>

## 11. Interchange

<a id="sqlite-round-trip"></a>

### 11.1 SQLite round trip

Portable interchange preserves every canonical event byte and historical author,
every currently held object's CID/bytes, immutable metadata and the seed wrapper
at the export cut. Import into an existing vault retains its target wrapper.
Local IDs, positions, caches and staging never travel. Physical SQLite layout is
not identity.

<a id="export"></a>

### 11.2 Export

[SQ §10](vault-sqlite.md#snapshot-and-export) defines fresh portable construction
from a consistent event/wrapper/held-root cut. Missing held bytes fails complete
export. Release the operation lock once the standalone snapshot is built and
verified, before file delivery. Success still requires completed output.

<a id="import-into-an-existing-vault"></a>

### 11.3 Import into an existing vault

[SQ §§11–12](vault-sqlite.md#portable-source-validation) define stable-source
validation and atomic same-anchor union. Validate source-only properties before
taking the target lock; perform target-dependent checks under it. Apply
canonical duplicate/conflict, own-author fork, known payload,
[receipt-integrity](vault-events.md#message-in) and erasure rules. Required union
roots must have sound bytes in source or target.

One transaction publishes required objects and all new events. Preserve target
identity, wrapper and local control. A failed preflight changes no accepted state;
crash recovery leaves the complete old or new union. Valid conflicting semantic
facts remain facts. Missing data or partial sync ingestion is not a successful
complete import, and old source bytes do not revive an erased relation.

<a id="restore-and-bootstrap"></a>

### 11.4 Restore and bootstrap

[SQ §12](vault-sqlite.md#restore-and-import) defines verified restore into an unused
destination with fresh local IDs and reconstructed retention/unfinished work.
An exact move may preserve IDs only with a permanently stopped source; a stale
runtime recovery copy refreshes them. Deferred seed-and-locator sync bootstrap
creates a fresh runtime and wrapper, never copies source local control.

<a id="synchronization-boundary"></a>

## 12. Synchronization boundary

Phase 1 does not require replica mediation or vault sync. Deferred sync moves
immutable events and whole DASL objects through its encrypted protocol, not
SQLite pages or local tokens. Full reconciliation cannot depend on `changes()`,
server push, one replica staying online or a mutable local queue. Missing
required objects are incomplete local data, never erasure.

<a id="backend-obligations"></a>

## 13. Backend obligations

SQLite is the only persistent backend; memory stores are semantic test references.
[SQ](vault-sqlite.md#commit-and-recovery) owns driver/durability, ownership, limits
and recovery requirements. Only claimed platforms must pass their real
persistence and large-object tests; memory or native tests do not establish
browser support.

<a id="versioning"></a>

## 14. Versioning

Vault version 3 covers envelope, object profile, key derivation and domain folds.
SQLite schema versioning is separate. These unreleased drafts supersede older
draft layouts without read aliases or migration obligations. For published
versions, compatible additions are new event types, optional payload fields
with a fixed absent meaning, or negotiated capabilities. Changing existing
meaning, envelope/ID/CID formats, derivation or required folds needs a new vault
version. Changing portable schema needs a new SQLite schema version.

<a id="required-conformance-cases"></a>

## 15. Required conformance cases

Cases retain their subjects; the suite history records relaxed reader guarantees.
Storage procedures are tested under SQ rather than redefined here.

<a id="commit-validation-and-event-identity-es-1-es-7"></a>

### Commit, validation and identity (ES-1–ES-7)

1. <a id="es-1"></a> Append returns the six-field event under the local author and survives restart.
2. <a id="es-2"></a> Pre-resolution crash leaves the whole event or none.
3. <a id="es-3"></a> A batch and its new objects commit entirely, with one timestamp.
4. <a id="es-4"></a> JCS-ineligible events fail before acceptance.
5. <a id="es-5"></a> Different JSON spellings with equal canonical bytes ingest as duplicates.
6. <a id="es-6"></a> Conflicting bytes for an accepted ID never overwrite its value.
7. <a id="es-7"></a> Unseen or conflicting current-author input aborts the whole ingest.

<a id="folds-scans-and-interchange-es-8-es-16"></a>

### Folds, scans and interchange (ES-8–ES-16)

8. <a id="es-8"></a> Shuffling/repartitioning events does not change folds.
9. <a id="es-9"></a> Scans have canonical order regardless of physical order.
10. <a id="es-10"></a> Event BLOBs round-trip exactly without LF and agree with indexed fields.
11. <a id="es-11"></a> Deltas are complete for their cut and reject wrong-generation tokens.
12. <a id="es-12"></a> Full reconciliation needs no local token.
13. <a id="es-13"></a> Portable values round-trip under the defined wrapper import policy.
14. <a id="es-14"></a> Portable restore creates fresh local identity.
15. <a id="es-15"></a> No API interprets hardware or OS identifiers.
16. <a id="es-16"></a> Historical authors remain valid after retirement or restore.

<a id="time-ordering-and-durability-es-17-es-22"></a>

### Time and durability (ES-17–ES-22)

17. <a id="es-17"></a> Timestamps have the exact UTC millisecond grammar and lexical time order.
18. <a id="es-18"></a> Process durability is not presented as a power-loss guarantee.
19. <a id="es-19"></a> A same-millisecond batch over 4096 events has distinct IDs and input-order results.
20. <a id="es-20"></a> Clock rollback changes sampled `at`, not ID uniqueness or the batch timestamp rule.
21. <a id="es-21"></a> UUID time and `at` are validated independently.
22. <a id="es-22"></a> ID-generator failure commits no part of a batch.

<a id="import-collection-and-reader-protection-es-23-es-32"></a>

### Import, collection and readers (ES-23–ES-32)

23. <a id="es-23"></a> Export cannot mix cuts or publish missing held objects.
24. <a id="es-24"></a> Import recovery exposes the whole old or new union, not staging.
25. <a id="es-25"></a> Any cached projections are updated/invalidated atomically and not used stale.
26. <a id="es-26"></a> Runtime/local data and executable schema never travel as portable state.
27. <a id="es-27"></a> Commits and maintenance may explicitly cancel readers; their bytes never silently change.
28. <a id="es-28"></a> Read/GC races yield complete bytes, absence or an explicit error, never partial success.
29. <a id="es-29"></a> Public stores expose no append/ingest/put/collect bypass; unused commit objects fail.
30. <a id="es-30"></a> A cancelled paused reader cannot resume as a successful unprotected read.
31. <a id="es-31"></a> Independent clients cannot bypass runtime ownership; a broker is optional.
32. <a id="es-32"></a> Offline inspection excludes a later writer; separate immutable snapshots need no live owner.
    Portable inspection exposes the read-only `Vault` members, no local author,
    and an empty `conflicting()` result. Every `commit` and `changes` call fails
    with `UnsupportedOperation` without consuming sources or minting local IDs.
