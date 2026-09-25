# The Estoc event store, version 4

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **phase 1; version-4 content-addressed events specified, implementation pending**. SQLite is the sole persistent vault and interchange
format for one active writable runtime. This specification defines observable
store semantics, not SQLite's implementation. Capitalized requirement words
have their BCP 14 meanings.

[dasl-objects.md](dasl-objects.md) defines object identity;
[vault-sqlite.md](vault-sqlite.md) owns storage, ownership and recovery procedures;
[vault-events.md](vault-events.md) owns application payloads and folds.
[Delivery](distributed-delivery.md) and [channel address policy](relationships.md) use
these primitives.

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
positions, options, caches and transient diagnostics do not travel with that state.
SQLite's committed view determines what is accepted; private preparation is
not acceptance.

The generic event store knows authors, not contacts, messages or channels.
The vault requires the local append author to equal its current `replica_id`.
A server-hosted full runtime has the same rules as an end-user runtime.

<a id="invariants"></a>

## 2. Invariants

Events are immutable and identified by the raw DASL CID of their canonical
envelope bytes. Merge is set union by event CID: identical bytes are one event,
and different bytes have different identities under the hash profile. An
**accepted event** is durably retained, not necessarily a trusted domain fact or
an application-admitted message. Folds depend on this event set, never arrival
or physical row order. An event reference names exact content; it cannot be
retargeted to another event with similar fields. Content addressing does not
authenticate the author or the supplied history.
Authorship is explicit; a replica ID is provenance, not a credential. Phase 1
has one active writable runtime, and two writable copies cannot share an author.

Only explicit event roots retain objects. Local objects and references commit
atomically. Collection removes only unheld objects, never events or identity
metadata, and shares the operation lock with commits. Losing caches cannot lose
a committed decision or message body. Portable interchange preserves the values
below; local change tokens never travel with portable state.

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

The portable event envelope has exactly five top-level fields. The API returns
those fields together with a derived `cid`, which is not part of the envelope:

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [field: string]: JsonValue };
type JsonObject = { [field: string]: JsonValue };
type EventCid = string & { readonly __eventCid: unique symbol };
type AuthorId = string & { readonly __authorId: unique symbol };

type EventEnvelope<D extends JsonObject = JsonObject> = {
  at: string;
  author: AuthorId;
  type: string;
  roots: Cid[];
  data: D;
};

type Event<D extends JsonObject = JsonObject> = EventEnvelope<D> & {
  cid: EventCid;
};
```

`cid` is a canonical raw DASL CID; `author` is a canonical lowercase UUIDv7.
`at` is the UTC wall-clock timestamp defined in section 4.2. `type` is nonempty; `roots` and
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

A local commit requires every root to name
[sound accepted bytes](dasl-objects.md#read-operations) or verified bytes accepted
in that same transaction. Fields such as `bodyCid` may repeat roots without
creating extra references. Erasure targets such as `dropCids` MUST NOT become
roots of the erasure event.

<a id="rfc-8785-canonical-json-and-equality"></a>

### 3.3 RFC 8785 canonical JSON and equality

```text
canonicalEventBytes(envelope) = UTF8(RFC8785(envelope))
eventCid(envelope) = rawCid(canonicalEventBytes(envelope))
```

All five envelope fields participate in byte equality. The derived `cid` is
excluded: extract the envelope only after validating the API record's exact
shape. Do not hash the full API record or silently discard unknown fields.
Use the [raw object profile](dasl-objects.md#object-identity) and maintained
JCS/CID/hash libraries rather than a second encoding or hash implementation.
Accept only I-JSON eligible for
RFC 8785: no duplicate member names, unpaired surrogates, non-finite numbers,
undefined values, bigint, cycles or host objects. Numbers use finite IEEE-754
binary64; values needing more precision use strings. Preserve strings exactly
without Unicode normalization. JCS sorts member names recursively, preserves
array order and uses its specified number serialization without whitespace.

Append and ingest validate before acceptance. Ingest may accept noncanonical
source JSON, but must detect duplicate members and compare/store canonical
bytes. Persistent and portable event BLOBs are exactly those bytes without a
newline. The event CID must match those bytes and indexed envelope columns
must agree with them; SQL JSON conversion or a generic
stable-stringify is not an alternative equality representation.

For this complete envelope:

```json
{
  "at": "2026-09-25T00:00:00.000Z",
  "author": "019b0000-0000-7000-8000-000000000001",
  "type": "example.note",
  "roots": [],
  "data": { "text": "hello" }
}
```

The event CID is
`bafkreigwmldn6qzody7iex3vwompw3zkdqihb5jzbpp3npvdod6rdnt5zi`.
Whitespace and object member order do not change it; a changed envelope value
does. The CID itself is not appended to these bytes.

<a id="envelope-validation"></a>

### 3.4 Envelope validation

Reject unless the envelope is a JSON object with exactly `at`, `author`,
`type`, `roots` and `data`; `author` is a canonical lowercase UUIDv7; `at` is a valid
Gregorian UTC instant in `YYYY-MM-DDTHH:mm:ss.sssZ`; `type` is nonempty; `roots`
is an array of canonical raw CIDs; `data` is an object; and the complete event
passes section 3.3. Seconds range from 00 through 59. Payload validation remains
above the generic store. Type brands alone cannot establish these checks.

An API `Event` has exactly those five fields plus `cid`. Validate its canonical
raw CID and require it to equal the envelope's computed CID before acceptance
or duplicate detection. A portable row's CID is checked in the same way. A
well-formed CID for other bytes is not a valid event. No event UUID, nonce or
other generated discriminator is added to the envelope.

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

### 4.2 Event CID and timestamp

Local appends assign the current author and sampled timestamp, then compute
the CID of the complete canonical envelope. Equal envelopes represent one
event, even when produced by separate append calls or repeated drafts in a
batch. A domain that must distinguish occurrences records that distinction in
its payload, such as a message ID or receipt ordinal. Hashing or validation
failure aborts the whole local batch before acceptance.

`at` is one integer Unix-millisecond wall-clock observation, truncating any
sub-millisecond precision and formatting it as `YYYY-MM-DDTHH:mm:ss.sssZ`.
A batch shares one reading. Leap-second spelling, missing fractions and other
fractional precision are rejected. After clock rollback, `at` follows the newly
sampled earlier time; it is not clamped or replaced with a logical clock.

An event CID contains no timestamp to compare with `at`. The author's UUID
identifies a writable incarnation, not the event's time.

A caller obtains event CIDs from returned events. Event CIDs carry no authority
or domain identity. Decisions needing causality use explicit references,
immutable IDs, tombstones or set semantics, not wall-clock latest-wins.

<a id="canonical-order"></a>

### 4.3 Canonical order

Canonical order is ascending `(at, cid)` using literal string comparison of
the timestamp and canonical lowercase base32 CID text. Compare CID text, not
decoded CID bytes; these orders need not agree. The fixed UTC millisecond form
makes timestamp lexical order equal represented instant order. This is
presentation order and the order for explicitly
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
  cid?: EventCid;
  author?: AuthorId;
  type?: string;
  data?: { [field: string]: JsonPrimitive | undefined };
};

type ChangeToken = string;
type Rejected = { value: unknown; error: string; source?: string };
type Damaged = { where: string; bytes?: Uint8Array; error: string };
type Ingested = {
  added: number;
  duplicates: number;
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
}
```

<a id="append"></a>

### 5.1 `append`

Validate the draft, read the clock, assign the current author and default
omitted roots to `[]`. A draft has only `type`, `data` and optional `roots`;
reject caller-supplied `cid`, `at`, `author` or any other field. Compute the
envelope's CID, retain it if new, and return the complete API event at section
2.1's success boundary. An identical retained event is returned without a new
row or position. Local vault callers use commit.

<a id="appendall"></a>

### 5.2 `appendAll`

Validate every draft before writing. Sample one `at` for the batch, assign the
current author and compute each envelope's CID. Deduplicate against both the
retained set and earlier drafts in this batch; accept all new events in one
transaction. Return one event per input draft in input order, including repeated
CIDs for identical envelopes. Return order need not be canonical order.
An empty batch writes nothing. Crash before resolution leaves all or none;
success survives process restart. No failed batch exposes an accepted subset.
Each new CID receives one position; an event-only duplicate batch writes nothing.
Local producers obtain event references from earlier commits; they do not assume
the CID of another draft in the same batch. The generic store leaves payload
reference validation to the owning schema.

<a id="ingest"></a>

### 5.3 `ingest`

Read or stage the full input and perform fork preflight before accepting any
new event. Validate each API event and its CID before duplicate detection.
Each previously unseen CID is retained and increments `added`; each repeat of
a retained or already staged event increments `duplicates`. Reject/report
malformed records or CID mismatches rather than reinterpreting them under a
replacement CID. Accept all new valid events and positions
in one transaction, updating or invalidating any caches. Retrying the same
input is idempotent. Full-vault import also publishes staged objects and repairs
atomically.

<a id="forked-author"></a>

#### Forked author

An incoming valid event with `author == store.author` whose CID is not already
present fails the entire operation with `ForkedAuthor`. To recover,
close the runtime, atomically select a fresh replica ID and generation under
ownership, reopen and retry ingest. Old events remain unchanged. This detects
accidental cloned histories, not malicious authorship by a shared-seed holder.

<a id="scan"></a>

### 5.4 `scan`

Yield every accepted event once, with its stored CID and parsed envelope, in
canonical order at one fixed cut. Normal scans and deltas return stored CIDs
without recomputing envelope hashes; verification boundaries are in
[section 5.6](#event-damage).

Filters are conjunctions of exact CID equality, author equality, type equality
and equality of specified top-level `data` fields to the supplied JSON primitive.
Validate a supplied `cid` as a canonical raw CID before querying; it matches at
most one event and does not bypass the other filters.
`undefined` adds no constraint; `null` matches only present JSON null. Missing,
boolean and number values cannot be conflated by SQL coercion. Filtering must
equal applying the filter to the same unfiltered cut. An exact CID lookup may
use an index; consumers still validate the referenced event's type and domain
prerequisites. Ranges, joins, full text and nested fields are outside this API.

<a id="changes"></a>

### 5.5 `changes`

Return a frontier token and every matching event accepted after `since` through
that frontier, once per CID, in no promised order. An already retained CID adds
no position and does not advance the frontier. Missing token starts at zero.
Late events with earlier timestamps still appear. An empty filtered result still
advances its token. Consume the complete result before checkpointing it.

A token is local to the issuing vault/generation. Reject malformed, unplaceable,
wrong-vault/generation and future tokens with `BadToken`; the caller discards
its related cache and refolds. Token encoding is private and never a wire
cursor or authorization credential. SQLite position rules are in
[SQ §5](vault-sqlite.md#events-and-change-tokens).

Portable snapshot inspection has no local change frontier. Every `changes`
call MUST reject with `UnsupportedOperation`, with or without a token; it MUST
NOT mint local IDs, positions or tokens. Use `scan` and `damaged`
to inspect the snapshot.

<a id="damage-and-conflicts"></a>
<a id="event-damage"></a>

### 5.6 Event damage

Damage includes invalid event bytes, a CID/bytes mismatch and disagreement
with indexed envelope columns. Verify CID/bytes correspondence before acceptance,
during full [portable source validation](vault-sqlite.md#portable-source-validation)
and on every `damaged()` call. `damaged()` checks all event rows, including their
canonical bytes and indexed columns. A normal scan is not a fresh integrity
check; ordinary reads still report any damage they encounter. Report its location
and exclude known-damaged values from scans. Event damage
makes the history incomplete and blocks mutation, GC and full export; structural
SQLite damage fails the runtime. In-place event repair is outside the phase-1
contract. Recovery uses a validated snapshot restored into a new runtime under
[SQ §12.1](vault-sqlite.md#restore). Object damage follows
[SQ §6](vault-sqlite.md#reads-damage-and-collection).

Malformed rejected input remains diagnostic data; it is not an accepted event.
Different events can contain conflicting semantic facts. Those conflicts belong
to domain folds and do not by themselves make the stored event bytes damaged.

<a id="folds-and-local-caches"></a>

## 6. Folds and local caches

Folds are deterministic functions of the accepted event set, independent of
arrival order and, except for explicitly local views, the current replica ID.
They can always be rebuilt from unfiltered `scan()`, retaining every event CID.
Start with direct folds. Caching and
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
type VaultMetadata = Readonly<{ version: 4; anchor: string }>;
type WrappedSeed = Readonly<{ version: 3; seedJwe: string }>;

interface KeystoreAccess {
  read(): Promise<WrappedSeed>;
  rewrap(next: WrappedSeed): Promise<void>;
}
```

The keystore wrapper version is independent of the vault version and remains 3.
Metadata is immutable. The unlocked host owns privileged rewrap and verifies
that the replacement opens to the same seed/anchor. Read returns a detached
value, not identity authority. `seedJwe` is a compact JWE string. Exact bytes
and recovery/import policy are defined only in [SQ §4](vault-sqlite.md#identity-and-keystore).

Authoritative application state uses versioned events and referenced objects.

<a id="local-state"></a>

### 8.2 Local state

Local execution data and control are not portable. Cache reset preserves local
identity/control, options and the wrapper; explicit identity reset changes both
IDs without changing history. Missing control is damage, not implicit creation.
[SQ §7](vault-sqlite.md#local-state-and-projections) owns the lifecycle rules.

<a id="vault-interface"></a>

## 9. Vault interface

```ts
type CommitObject = { cid: Cid; source: ByteSource };

interface Vault {
  readonly metadata: VaultMetadata;
  readonly events: Pick<EventStore, "scan" | "changes" | "damaged">;
  readonly objects: Omit<ObjectStore, "putRaw" | "putObject" | "collect">;
  commit(objects: CommitObject[], drafts: Draft[]): Promise<Event[]>;
}
```

For a writable runtime, `commit` validates known payloads, prepares/verifies
supplied objects and checks all roots, including reused ones. Every supplied
object must be referenced by at least one draft. A supplied object for a
known-damaged CID follows [DO §6.2](dasl-objects.md#putobject)'s verified replacement
rule. New objects, repairs, the entire event batch and local positions publish
in one transaction under the batch rules above. Validation failure or rollback
publishes no objects, repairs or events; private preparation may remain.
`commit([], drafts)` is the only local write path when no new objects are needed.
Use [import](#import-into-an-existing-vault) to fill or repair absent or
known-damaged objects retained by existing events without accepting new events.

Portable snapshot inspection returns a read-only `Vault`. Its `metadata` is the
snapshot's immutable metadata; `events` provides `scan` and `damaged`,
and `objects` provides `open`, `read`, `stat`, `has` and `list`
under their ordinary read and damage rules. `commit` and `events.changes` MUST
always reject with `UnsupportedOperation`, without consuming object sources or
minting local IDs, positions or tokens. No local `EventStore.author` is exposed
or invented; historical event authors remain unchanged.

The vault-wide operation lock serializes semantic mutations from preflight
through publication, including receipt allocation and GC's held-root decision.
Nested stores share that lock and the enclosing transaction. Lifetime ownership,
read cancellation and SQLite procedures belong to
[SQ](vault-sqlite.md#ownership-and-lifecycle). Nonblocking reads, live brokers
and online repair are not API guarantees.

An ambiguous outcome is not a safe instruction to resubmit drafts: a new commit
samples a new `at` and can produce different CIDs for the same drafts. Exact-byte
deduplication is not domain-operation idempotency. Recover the stable operation first
under [SQ §9.2](vault-sqlite.md#failure-and-recovery). Internal ingest, unlike a new
commit, preserves the complete envelopes and can deduplicate retries.

<a id="interchange"></a>

## 10. Interchange

<a id="sqlite-round-trip"></a>

### 10.1 SQLite round trip

Portable interchange preserves every canonical event byte and historical author,
every currently held object's CID/bytes, immutable metadata and the seed wrapper
at the export cut. Import into an existing vault retains its target wrapper.
Local IDs, positions, caches and staging never travel. Physical SQLite layout is
not identity.

<a id="export"></a>

### 10.2 Export

[SQ §10](vault-sqlite.md#snapshot-and-export) defines fresh portable construction
from a consistent event/wrapper/held-root cut. Missing held bytes fails complete
export. Release the operation lock once the standalone snapshot is built and
its destination writer is closed. Validate the final immutable file and deliver
it outside that lock, in that order. Success still requires completed output.

<a id="import-into-an-existing-vault"></a>

### 10.3 Import into an existing vault

[SQ §§11–12](vault-sqlite.md#portable-source-validation) define stable-source
validation and atomic same-anchor union. Validate source-only properties before
taking the target lock; perform target-dependent checks under it. Apply
CID validation/deduplication, own-author fork, known payload,
[receipt-integrity](vault-events.md#message-in) and erasure rules. Every root
retained by a newly accepted source event in the prospective union, and every
root held by the union but not by the target before import, must have verified
source bytes or [sound accepted target bytes](dasl-objects.md#read-operations);
otherwise abort before publication. Compute the target-before-import and
prospective-union [held-root folds](vault-events.md#held-roots) under the target
lock. This includes roots newly held because conflicting union evidence prevents
release, even when only existing target events retain them. A reference the
union fold does not hold requires no bytes.

Under [SQ §12.2](vault-sqlite.md#import), stage every union-held object that is
absent or known damaged in the target and has verified source bytes, even if
there are no new events. For union-held roots outside the byte requirements
above, missing or known-damaged target bytes do not block import when the source
lacks them; their state remains unchanged. Reusing target objects does not
rehash them.

One transaction publishes staged objects and repairs with all new events.
Preserve target identity, wrapper and local control. A failed preflight changes
no accepted state; crash recovery leaves the complete old or new union. Valid
conflicting semantic facts remain facts. An incomplete source is not a
successful complete import, and old source bytes do not revive an erased relation.

<a id="restore-and-bootstrap"></a>

### 10.4 Restore

[SQ §12](vault-sqlite.md#restore-and-import) defines verified restore into an unused
destination with fresh local IDs and reconstructed retention/pending state.
Domain dispatch authority is separate: restoring events never automatically
sends historical messages or effects under
[channels.md](channels.md#fixed-outbound-channel).
An exact move may preserve IDs only with a permanently stopped source; a stale
runtime recovery copy refreshes them. Missing required objects are incomplete
local data, never erasure.

<a id="backend-obligations"></a>

## 11. Backend obligations

SQLite is the only persistent backend; memory stores are semantic test references.
[SQ](vault-sqlite.md#commit-and-recovery) owns driver/durability, ownership, limits
and recovery requirements. Only claimed platforms must pass their real
persistence and large-object tests; memory or native tests do not establish
browser support.

<a id="versioning"></a>

## 12. Versioning

Vault version 4 covers envelope, object profile, key derivation and domain folds.
It adopts the five-field content-addressed event envelope and CID references,
the continuity integration and durable application admission. DID/key derivation,
deterministic domain-ID transcripts, the raw object profile and version-3 keystore
wrapper remain as defined here; the version bump does not rename their purpose strings.
The target runtime accepts only vault version 4 with SQLite schema version 2.
No migration or import/restore compatibility with earlier vaults is required.
SQLite schema versioning is separate. For published versions, compatible
additions are new event types, optional payload fields with a fixed absent
meaning, or negotiated capabilities. Changing existing
meaning, envelope/ID/CID formats, derivation or required folds needs a new vault
version. Changing portable schema needs a new SQLite schema version.

<a id="required-conformance-cases"></a>

## 13. Required conformance cases

Storage procedures are tested under [SQLite conformance](vault-sqlite.md#required-conformance-cases).

<a id="commit-validation-and-event-identity-es-1-es-7"></a>

### Commit, validation and identity (ES-1–ES-7)

1. <a id="es-1"></a> Append returns the five-field envelope plus its computed raw CID
    under the local author and survives restart.
2. <a id="es-2"></a> Pre-resolution crash leaves the whole event or none.
3. <a id="es-3"></a> A batch and its new objects commit entirely, with one timestamp.
4. <a id="es-4"></a> JCS-ineligible events fail before acceptance.
5. <a id="es-5"></a> Different JSON spellings with equal canonical bytes ingest as duplicates.
6. <a id="es-6"></a> Different canonical envelopes produce different events; equal
    bytes ingest once in either order. A supplied CID for other bytes is rejected
    before duplicate detection, even when that CID is already retained.
7. <a id="es-7"></a> Unseen valid current-author input aborts the whole ingest;
    identical retained events remain duplicates.

<a id="folds-scans-and-interchange-es-8-es-16"></a>

### Folds, scans and interchange (ES-8–ES-16)

8. <a id="es-8"></a> Shuffling/repartitioning events does not change folds.
9. <a id="es-9"></a> Scans have `(at, cid)` canonical order regardless of physical order;
    memory and SQLite use CID text order even where decoded-byte order differs.
    An exact CID filter yields at most one event, still conjoined with author,
    type and data filters; a CID absent from the event set yields none, and an
    invalid CID is rejected.
10. <a id="es-10"></a> Event BLOBs contain only the five envelope fields, round-trip
    exactly without LF, hash to their row CID and agree with indexed fields.
    Acceptance, full portable validation and `damaged()` detect CID/bytes mismatch;
    ordinary scans and deltas return stored CIDs without recomputing those hashes.
11. <a id="es-11"></a> Deltas are complete for their cut and reject wrong-generation tokens.
    Each new CID advances the token; exact-duplicate append or ingest allocates
    no position. Object-only repair still invalidates dependent projections.
12. <a id="es-12"></a> Full reconciliation needs no local token.
13. <a id="es-13"></a> Portable values round-trip under the defined wrapper import policy.
14. <a id="es-14"></a> Portable restore creates fresh local identity.
15. <a id="es-15"></a> No API interprets hardware or OS identifiers.
16. <a id="es-16"></a> Historical authors remain valid after retirement or restore.

<a id="time-ordering-and-durability-es-17-es-22"></a>

### Time and durability (ES-17–ES-22)

17. <a id="es-17"></a> Timestamps have the exact UTC millisecond grammar and lexical time order.
18. <a id="es-18"></a> Process durability is not presented as a power-loss guarantee.
19. <a id="es-19"></a> A large same-millisecond batch has one timestamp
    and one result per input in input order. Identical drafts return the same CID
    and add one row/position; different envelopes remain distinct.
20. <a id="es-20"></a> Clock rollback changes sampled `at`, not the batch timestamp
    rule. If a repeated draft recreates a retained envelope, it deduplicates.
21. <a id="es-21"></a> Event identity is the canonical envelope's raw CID, not a
    UUID. Reject extra envelope fields, noncanonical CIDs and mismatched digests;
    the author's UUID time is not compared with the event's `at`.
22. <a id="es-22"></a> Canonicalization or hashing failure commits no part of a batch.

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
    and the complete CID-addressed event set. Every `commit` and `changes` call fails
    with `UnsupportedOperation` without consuming sources or minting local IDs.
