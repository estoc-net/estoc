# The Estoc SQLite vault, version 3

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — SQLite is the sole persistent vault and portable
backup format. This replaces the unreleased version-3 folder format; it does
not assert that the SQLite implementation is complete.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

[event-store.md](event-store.md) owns event identity, store interfaces and
observable commit semantics. [dasl-objects.md](dasl-objects.md) owns raw CID
identity and object retention. This document defines their SQLite representation,
runtime lifecycle and interchange. Event payloads, folds and the exact held-root
set remain defined by [vault-events.md](vault-events.md).

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Implement storage | [Format](#format-and-versions) → [Schema](#common-schema) → [Events](#events-and-change-tokens) → [Objects](#objects-and-streams) → [Commit](#commit-and-recovery) |
| Open a vault | [Identity and keystore](#identity-and-keystore) → [Ownership](#ownership-and-lifecycle) → [Local state](#local-state-and-projections) |
| Transfer or recover a vault | [Recovery material](#recovery-material-and-product-requirement) → [Export](#snapshot-and-export) → [Source validation](#portable-source-validation) → [Restore and import](#restore-and-import) |

<details>
<summary>Contents</summary>

- [1. Trust and portability](#trust-and-portability)
- [2. Format and versions](#format-and-versions)
- [3. Common schema](#common-schema)
- [4. Identity and keystore](#identity-and-keystore)
- [5. Events and change tokens](#events-and-change-tokens)
- [6. Objects and streams](#objects-and-streams)
- [7. Local state and projections](#local-state-and-projections)
- [8. Ownership and lifecycle](#ownership-and-lifecycle)
- [9. Commit and recovery](#commit-and-recovery)
- [10. Snapshot and export](#snapshot-and-export)
- [11. Portable source validation](#portable-source-validation)
- [12. Restore and import](#restore-and-import)
- [13. Transfer and deferred synchronization](#transfer-and-deferred-synchronization)
- [14. Required conformance cases](#required-conformance-cases)

</details>
<!-- reading-guide:end -->

<a id="trust-and-portability"></a>

## 1. Trust and portability

One vault runtime stores events, object bytes, metadata, the encrypted seed
wrapper and local state in one SQLite database, conventionally `vault.sqlite`.
A portable snapshot is a newly built SQLite database containing only the
portable state selected below. These are two lifecycle states of one format,
not two storage backends. Node and browser runtimes MUST read and produce the
same portable schema and logical values.

There is no folder backend, JSONL interchange, external object directory,
general portable-file store or required ZIP container. Memory stores MAY serve
as test references; they are not another persistent format. Old folder vaults
MUST be refused as unsupported inputs. This unreleased format requires no folder
conversion, compatibility reader or dual writing.

SQLite journals, VFS files, ownership coordination and temporary databases are
implementation-managed resources. The single-database rule does not mean these
resources may be deleted while needed. In particular, a main database file
copied out of a live runtime is not a portable snapshot.

Events, identity metadata and retained content are plaintext within the
database. Only the seed is protected by `seedJwe`; the passphrase does not
encrypt message history or attachments. A conforming application MUST state
this boundary. Filesystem encryption or an encrypted backup wrapper is outside
this format.

A full runtime, including a hosted runtime holding the seed, MUST provide a
complete portable SQLite export independent of that running service. The user
must be able to recover from it using documented tools and the recovery
credential. A remote thin client's queue and projection cache are not a full
vault or a complete backup. SQLite files MUST NOT be uploaded as plaintext
mediator messages or as the deferred sync protocol's wire representation.

<a id="format-and-versions"></a>

## 2. Format and versions

The database uses SQLite's file format with UTF-8 text encoding and these header
values:

```sql
PRAGMA application_id = 1163088963;
PRAGMA user_version = 1;
```

`application_id` is `0x45535443` (`ESTC`). `user_version` identifies this SQLite
schema, independently of `vault_meta.vault_version`, which is `3` and covers
the event, object, key and application semantics. A filename is not format
identification. A reader MUST validate both versions and the schema; a SQLite
header or the integer `3` alone is insufficient.

The schema below is normative. Table and column names, column order, declared
types, constraints and collations are fixed. SQL whitespace and equivalent
identifier quoting are not part of the format. All tables are ordinary
`STRICT` tables, not views or virtual tables. A supported engine MUST implement
these features. [SQLite STRICT tables](https://www.sqlite.org/stricttables.html)
describes the engine's type checks; application validation remains required.

Unknown application IDs, vault versions or schema versions MUST be refused
before application writes or payload interpretation. SQLite's own journal
recovery on a runtime database is distinguished from application migration.
Upgrades execute only migrations bundled with the application, under exclusive
ownership, and publish the schema and version together in a transaction.
A destructive upgrade requires a verified local recovery copy first. A failed
upgrade MUST leave a supported old state or an explicitly unusable destination,
never a partially upgraded normal runtime. Source databases supply data, never
migration instructions.

The current version-3 specifications are unreleased drafts. They supersede
earlier draft layouts without read aliases or migration obligations. For a
published format, changing the portable schema requires a new `user_version`;
changing event, CID, anchor derivation or fold meaning additionally requires a
new vault version. Adding an event type or a payload field is compatible only
under [event-store.md section 14](event-store.md#versioning). Unknown tables are
not a portable extension mechanism.

<a id="common-schema"></a>

## 3. Common schema

Both runtime and portable databases contain these six tables and three explicit
indexes, including the tables for object bytes:

```sql
CREATE TABLE vault_meta (
  singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
  format        TEXT NOT NULL CHECK (format = 'estoc-sqlite'),
  vault_version INTEGER NOT NULL CHECK (vault_version = 3),
  kind          TEXT NOT NULL CHECK (kind IN ('runtime', 'portable')),
  ready         INTEGER NOT NULL CHECK (ready IN (0, 1)),
  anchor        TEXT NOT NULL
) STRICT;

CREATE TABLE keystore (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version   INTEGER NOT NULL CHECK (version = 3),
  seed_jwe  BLOB NOT NULL
) STRICT;

CREATE TABLE events (
  event_id  TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  at        TEXT COLLATE BINARY NOT NULL,
  author    TEXT COLLATE BINARY NOT NULL,
  type      TEXT COLLATE BINARY NOT NULL,
  canonical BLOB NOT NULL
) STRICT;

CREATE INDEX events_order ON events(at, event_id, author);
CREATE INDEX events_type_order ON events(type, at, event_id, author);
CREATE INDEX events_author_order ON events(author, at, event_id);

CREATE TABLE object_data (
  data_id INTEGER PRIMARY KEY,
  size    INTEGER NOT NULL CHECK (size >= 0),
  state   TEXT NOT NULL CHECK (state IN ('staging', 'verified', 'quarantined'))
) STRICT;

CREATE TABLE object_chunks (
  data_id  INTEGER NOT NULL REFERENCES object_data(data_id) ON DELETE CASCADE,
  chunk_no INTEGER NOT NULL CHECK (chunk_no >= 0),
  bytes    BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),
  PRIMARY KEY (data_id, chunk_no)
) STRICT;

CREATE TABLE objects (
  cid     TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  data_id INTEGER NOT NULL UNIQUE REFERENCES object_data(data_id)
) STRICT;
```

A ready database has exactly one `vault_meta` row and one `keystore` row.
`anchor` is the exact DID derived from the vault seed's fixed `anchor` key.
`ready = 0` means an unpublished construction; normal open, import and restore
MUST refuse it. `ready = 1` is a publication condition, not proof that the bytes
are sound or authenticated. Validation below still applies.

Runtime databases have `kind = 'runtime'` and the control tables in section 5.
They MAY add application-owned `local_*`, `projection_*`, `staging_*` and
`diagnostic_*` tables and ordinary indexes, whose schema and migrations are
bundled with the application. They MUST NOT change the common tables' meanings
or store additional authoritative portable state in those tables. This profile
uses no triggers, views, generated columns, virtual tables or SQL extensions.

Portable databases have `kind = 'portable'`. They contain only the six common
tables, their constraint-created SQLite indexes and the three explicit indexes
above. They contain no runtime control or extra application tables, even empty
ones, and no SQLite statistics tables. Every `object_data` row is `verified`
and referenced by exactly one `objects` row; no unreferenced chunks exist.
Physical page layout, rowids and `data_id` values do not define logical identity.
Export assigns fresh `data_id` values rather than copying runtime allocations.

All text MUST be valid Unicode without unpaired surrogates and use the declared
binary collation. Event IDs, timestamps, authors and CIDs have the stricter
canonical grammars of their defining profiles. The reader checks actual stored
types and values; constraints do not replace validation of an input database.
Drivers MUST preserve BLOB bytes and signed 64-bit integers exactly. Values that
cannot be represented precisely as a JavaScript number use bigint or canonical
decimal strings across the driver boundary, never rounding.

<a id="identity-and-keystore"></a>

## 4. Identity and keystore

`vault_meta.anchor`, `format` and `vault_version` are immutable after creation.
Two vaults have the same identity exactly when their anchors are equal. The
host MUST unlock or obtain the seed, derive the fixed anchor DID and compare it
before exposing identity operations or making application writes on open.

`keystore.version` and `keystore.seed_jwe` represent the version-3 encrypted
seed wrapper. `seed_jwe` is the exact RFC 8785 UTF-8 encoding of the `seedJwe`
JSON object, with no trailing LF. The complete logical value is:

```json
{
  "version": 3,
  "seedJwe": {
    "protected": "...",
    "iv": "...",
    "ciphertext": "...",
    "tag": "..."
  }
}
```

The exact JWE shape and cryptographic profile belong to `@estoc/keystore`
version 3. Readers MUST validate that shape and canonical encoding. A diagnostic
read can obtain the encrypted wrapper before unlock. It does not confer
permission to use the identity.

There is no persistent derived-key registry or cache. Each unlocked session
derives requested private keys from the seed and exact portable key names.
An in-memory key cache MUST be released on lock or process exit. Plaintext seed,
derived private keys and derivation caches MUST NOT be written to any database
table, diagnostic, staging row or SQLite-bound value.

<a id="rewrap-and-import-policy"></a>

### 4.1 Rewrap and import policy

Changing the passphrase generates a new wrapper for the same unlocked seed.
The host holds the vault writer lock, validates the new wrapper by unlocking it
and deriving the same anchor, then replaces the keystore row in one transaction.
Cryptographic work happens before that short transaction. A process interruption
leaves the complete old or new wrapper; it never changes the anchor or creates
a new seed. Export takes this same lock so its selected wrapper stays fixed.

Restore adopts the snapshot's wrapper. Import into an existing vault retains
the target wrapper and checks the source wrapper's shape; it does not require
the two wrappers to be byte-equal or require the source passphrase. If the source
seed is unlocked, it MUST derive that same anchor. Anchor equality is a format
and identity consistency check, not authentication of a supplied snapshot.

<a id="recovery-material-and-product-requirement"></a>

### 4.2 Recovery material and product requirement

The seed is the cryptographic root for the anchor, communication keys, mediation
accounts and deferred sync credentials. A sync store does not back up the seed.
Losing every usable seed copy makes those identity keys unrecoverable.

A user-facing implementation MUST offer and verify a recovery path independent
of the active runtime before describing the vault as recoverable. The path is
either a documented, integrity-protected offline seed export or a complete
portable SQLite snapshot whose wrapper can be opened using a separately retained
credential. Verification MUST open the recovery material in an isolated check
and derive exactly `vault_meta.anchor`; a completed download alone is not proof.

Creation/onboarding MUST expose recovery status. A release relying on the single
seed MUST test loss of every active runtime followed by restoration through its
documented recovery path. Seed-only recovery restores identity; recovering vault
history in phase 1 also requires a complete snapshot.

<a id="events-and-change-tokens"></a>

## 5. Events and change tokens

`events.canonical` is exactly `canonicalEventBytes(event)`, without an LF.
Parsing rejects duplicate JSON members, invalid I-JSON and invalid envelopes.
Every indexed column MUST equal its corresponding field in those bytes.
The canonical BLOB is authoritative; SQL JSON conversion MUST NOT substitute
another equality representation. Source rows with noncanonical bytes or
mismatched columns are damaged input, not a request to repair them on import.

Accepted events are never updated or deleted. The unique `event_id` prevents
two accepted values. An identical incoming value is a duplicate; different
canonical bytes report a conflict and leave the target value unchanged.
`INSERT OR REPLACE` MUST NOT overwrite an accepted event. Import applies the
current-author fork check before accepting any input. Rejected values may be
kept as local diagnostics but never become another accepted event.

Runtime databases additionally contain:

```sql
CREATE TABLE store_state (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  replica_id       TEXT NOT NULL,
  store_generation TEXT NOT NULL,
  last_seq         INTEGER NOT NULL CHECK (last_seq >= 0)
) STRICT;

CREATE TABLE event_positions (
  accepted_seq INTEGER PRIMARY KEY CHECK (accepted_seq > 0),
  event_id     TEXT NOT NULL UNIQUE REFERENCES events(event_id)
) STRICT;

CREATE TABLE object_acceptance (
  cid            TEXT PRIMARY KEY NOT NULL REFERENCES objects(cid) ON DELETE CASCADE,
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0)
) STRICT;
```

There is exactly one `store_state` row. Both IDs are canonical lowercase UUIDv7.
Every accepted event has exactly one position and every accepted object has one
acceptance row. Each final event transaction allocates increasing positions
above `last_seq` and advances it to the greatest allocated value. Empty and
duplicate-only writes do not advance it. Positions never change within a
generation. `last_seq` equals the greatest accepted position, or zero when
there are no events. A missing position or inconsistent frontier is damage.
Allocation beyond the signed 64-bit range fails before acceptance.

`scan()` briefly takes the operation lock to capture `last_seq`, then reads only
positions at or below that cut, yielding canonical `(at, eventId, author)` order.
Keyset pagination over immutable rows permits bounded batches without holding a
SQL transaction across consumer waits. Every filtered scan equals filtering the
same unfiltered cut. `Filter.data` retains JSON primitive equality, including the
difference between missing, null, boolean and number; SQL coercions cannot change
it. A driver may apply that part of the filter in application code.

`changes()` similarly captures a fixed upper position. It returns all matching
accepted rows after the supplied position through that upper bound. Late-arriving
events with earlier `at` are still included. Its output token advances even if
the filter matches nothing. Consumers must finish that result before using its
token as the checkpoint for a complete delta.

The token is unpadded base64url of the RFC 8785 UTF-8 encoding of this closed
object, using exact field names:

```json
{"anchor":"did:key:z6Mk...","storeGeneration":"019b2a43-5c8d-75a0-bf82-b2a61a4ce099","through":"0","version":1}
```

`through` is the decimal position, `0` or a nonzero digit followed by digits,
bounded by `last_seq`; it is parsed exactly, not through an imprecise number.
The decoder validates the canonical encoding, member set, anchor, generation
and position. Another vault/generation, an unknown token version or a future
position fails with `BadToken`. Missing token means position zero. A token is
local cache bookkeeping and MUST NOT become a wire cursor or event ordering rule.
Positions are rebuilt in canonical order on restore and are never exported.

Event-row damage is reported by location and excluded from diagnostic scans.
The runtime MUST mark its event view incomplete and block mutation, GC and full
export on discovering such damage, rather than silently treating lost history
as an empty or smaller valid vault. Structural SQLite corruption fails the
runtime. Portable source validation rejects either kind of damage.

<a id="objects-and-streams"></a>

## 6. Objects and streams

`objects.cid` is the canonical raw DASL CID of the complete byte sequence in the
referenced `object_data` and `object_chunks` rows. There is no external object
file. `data_id` identifies an immutable physical content version, not a portable
CID; it is never put in an event or protocol message.

Every accepted mapping MUST point to a `verified` data row. Historical event
roots have no foreign key requiring a current object mapping: an erasure may
legitimately leave an immutable event referring to already collected bytes.

Chunks start at `chunk_no = 0` and have contiguous increasing numbers. Each
chunk except the last is exactly 1 MiB; the final chunk has 1 through 1 MiB
bytes. An empty object has `size = 0` and no chunks. The sum of chunk lengths
equals `size`; concatenating them in number order yields the exact resource
bytes. Runtime and portable databases use these same rules. Rechunking a source
stream does not change its CID. A chunk has no separate content identity.

<a id="staging-and-acceptance"></a>

### 6.1 Staging and acceptance

Allocate a fresh `data_id` in `staging` state. Consume an arbitrarily chunked
finite input with bounded buffers, incrementally hash it and write normalized
chunks in short transactions. Staging size may track progress but is not an
accepted object's size. After EOF, verify the chunk sequence, complete length
and expected CID. Validation failure publishes nothing.

Acceptance changes that data row to `verified`, inserts or repairs its `objects`
mapping and records acceptance time in one transaction. In `Vault.commit` this
is the same transaction as the entire event batch. Until it commits, `has`,
`stat`, `list`, `open`, folds and export MUST NOT see the staged data. A verified
but unreferenced physical version is not independently an accepted object.

Repeated acceptance of a sound CID is idempotent. A repair uses a new `data_id`
and swaps the mapping; it never overwrites chunks a reader may still be using.
All accepted lengths MUST fit the API's documented exact integer bounds.
Object size, source chunk size and available disk space are checked without
requiring a whole-object buffer.

<a id="reads-damage-and-collection"></a>

### 6.2 Reads, damage and collection

Under the operation lock, `open` resolves the current accepted mapping and
registers a latch for both the CID and that `data_id`. It then reads bounded
chunk batches without retaining the writer lock or a SQL transaction for the
stream's lifetime. A stream never switches to a repaired version partway
through. `read(maxBytes)` checks its bound before allocating. `list()` captures
a fixed CID list; it is not a latch on every listed object.

Completion, error, cancellation and owner shutdown release the corresponding
latch. Idle time does not. Each stream is protected independently. Brokered
streams fail if their owner is lost; a client cannot continue by reading the
database directly. These rules also govern streams started before any writable
runtime, under section 8's exclusive inspection ownership.

Missing chunks, wrong length or a digest mismatch are damage. A read that
rehashes lazily MUST fail before successful completion on mismatch. Quarantine
removes the CID mapping and acceptance row and marks that physical version
`quarantined` in one transaction, conditional on the mapping still naming the
damaged `data_id`. A concurrent repair therefore survives. Existing streams
retain their version until they fail or end; quarantined bytes never satisfy a
new presence check. Diagnostics distinguish damage from policy erasure.
Read-only inspection reports damage and excludes that version for its session
without writing quarantine state; repair or a later writable owner performs
the persistent transition.

Collection acquires the writer lock before folding held roots and holds it
through deletion. It skips held, young and latched CIDs without waiting for a
reader. For each eligible CID it deletes the mapping, acceptance metadata and
unlatched physical data/chunks in one transaction. Unreferenced staging or
quarantined versions are cleaned only when no operation or reader uses them.
Cleanup MUST NOT infer that a failed promise means a committed mapping is absent.

Orphan grace uses local `accepted_at_ms`, sampled at successful acceptance,
and a documented nonnegative duration. A clock rollback gives an age of zero,
not a negative-age underflow. Reacceptance MAY renew this time. Restore creates
new acceptance times; export copies none. Grace applies to accepted unheld
objects, such as a successful commit with no referencing drafts; staged bytes
do not need grace to protect a later acceptance.

Collection's removal report means bytes have become unavailable through the
store. It does not promise immediate database-file shrinkage or forensic
erasure. Freed pages can be reused; file compaction is separate maintenance.
A fresh portable database excludes those pages entirely.
[SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html) explains free-page
reuse and deleted-content remnants.

<a id="local-state-and-projections"></a>

## 7. Local state and projections

Persistence in one database does not make all its data portable:

| Class | Contents | Reset and export |
| --- | --- | --- |
| Authoritative portable state | Metadata, encrypted seed wrapper, events and currently held objects | Export exact logical values and bytes |
| Runtime control | Replica/generation selection, accepted positions and times, initialization and schema state, unpublished operations | Preserve on reopen; reconstruct on restore; never copy into export |
| Local options and diagnostics | Preferences, retry scheduling, sockets' bookkeeping, traces | Explicit local retention/reset; never export |
| Rebuildable projections | Cached folds, indexes, query state and checkpoints | May discard and rebuild; never export |

Ordinary `clearCaches` clears caches and their checkpoints, not the replica,
generation, acceptance metadata, keystore or options. Trace retention removes
rows and reports rows/bytes; it has no segment-count semantics. An explicit
local-identity reset closes the runtime, retains events and objects, atomically
replaces both local IDs, invalidates all generation-bound caches and reopens.
The reset performs that control transaction under exclusive ownership after
validating the recovered committed view; no other runtime may use the database
during the reset. Event positions and acceptance times need not change.
Normal reopen preserves the IDs. Missing or malformed control rows are damage,
not a cue to mint one missing field or silently create another vault.

A projection is valid only for its declared projection version, generation and
accepted-event frontier. Every acceptance path MUST update affected projections
with their checkpoint in the final event transaction, or mark them invalid in
that transaction. Invalid projections cannot serve queries, held-root decisions
or unfinished-work scheduling until rebuilt from a consistent event cut.

Incremental computation MUST equal the pure fold for the entire accepted set,
including older timestamps, duplicates, erasures and later-arriving evidence.
Rebuilding captures a fixed frontier and installs its result only if the
corresponding version and frontier still apply, or after catching up under the
writer lock. Event data remains authoritative. Cached content previews obey the
same erasure/read policy as their source objects.

<a id="ownership-and-lifecycle"></a>

## 8. Ownership and lifecycle

One owner controls a physical runtime database for its entire open lifetime,
including recovery, all read/write handles, streams and shutdown. Ownership
MUST coordinate processes, workers, realms and aliases of that same database.
SQLite write serialization alone is insufficient: two owners could both perform
network effects between transactions.

Other clients use that owner's broker, wait or fail. An independent inspector
with no owner acquires the same exclusive ownership before opening a runtime
database and holds it through all statements and streams. A writer waits or
fails until it releases ownership. Phase 1 does not support shared independent
live database readers. A portable immutable snapshot can be inspected separately.

Node may use daemon/process ownership; browsers may use a Web Lock and a worker
that owns the SQLite WASM connection. Both MUST demonstrate process/worker
termination recovery and exclusion of a later owner. VFS-managed names or pools
are runtime details, not another portable layout. Platform support and capacity
limits must be documented and tested on the claimed platform; Node results do
not establish browser durability or streaming support.
[SQLite WASM persistence](https://www.sqlite.org/wasm/doc/trunk/persistence.md)
describes the available VFS capabilities and their constraints.

<a id="create-open-and-close"></a>

### 8.1 Create, open and close

Create and open are separate operations. Create requires an unused destination
and validated seed, anchor and wrapper; it never overwrites an existing file or
an incomplete database. It installs the schema and initialization state under
ownership and publishes the complete metadata, wrapper and fresh local control
as `ready = 1` in one transaction. A failure leaves no usable vault or one
complete created vault; it cannot generate another seed by retrying open.

Open acquires ownership before accessing a runtime database. It lets SQLite
recover its own journal, checks format/schema and `kind = 'runtime', ready = 1`,
validates metadata and wrapper, then verifies the unlocked seed's anchor.
Only SQLite's required journal recovery may write before this identity check;
application migrations, staging cleanup and other application writes wait.
Control rows must then validate. Unpublished leftovers may be cleaned without
changing the accepted view. The host reconstructs committed retention and
unfinished work before enabling GC or network workers under
[vault-events.md section 13.1](vault-events.md#open-the-writable-full-runtime).

An inspection open creates no application state and never mints local IDs.
If SQLite needs journal recovery that a read-only connection cannot perform,
inspection fails with a recovery-required diagnostic. It does not delete the
journal or label its unrecovered contents complete. An unsupported engine,
missing database or structural corruption is an error, never an empty store.

Close refuses new work, drains previously admitted operations, ends remaining
streams/statements and closes SQLite before releasing ownership. Saved handles
refuse use after close. Concurrent close calls share completion. Halt, used for
an uncertain publication or corrupted state, also prevents already queued but
unstarted work from proceeding. Cleanup cannot release ownership while an old
operation may still access the database. Owner loss terminates its brokered
streams; a later owner does not inherit their latches.

<a id="commit-and-recovery"></a>

## 9. Commit and recovery

The runtime operation lock serializes complete semantic operations and may span
asynchronous staging or verification. SQL transactions are separate, short
publication boundaries and MUST NOT remain open across source-stream waits,
network activity or consumer backpressure. Nested stores share the operation
lock and the enclosing final transaction.

The engine/VFS configuration MUST provide
[event-store.md section 2.1](event-store.md#commit-and-durability-terminology)'s
process-durable success boundary. Persistent connections MUST enable foreign
keys, use a recoverable journal mode and set `synchronous` to `FULL` or `EXTRA`.
The implementation MUST read back effective settings and refuse unsupported
configurations. `OFF`/`MEMORY` journal modes and `synchronous=OFF` are not
conforming runtime policies. Journal/VFS choice is a driver detail, not another
vault format. Stronger power-loss claims require a documented and tested
platform boundary. [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)
and [PRAGMA settings](https://www.sqlite.org/pragma.html) describe the engine's
guarantees and filesystem assumptions.

<a id="atomic-vault-commit"></a>

### 9.1 Atomic vault commit

Under the operation lock, `Vault.commit(objects, drafts)`:

1. validates every draft and supplied CID, samples the batch timestamp and mints
   all event IDs under the event-store rules;
2. stages and verifies supplied object streams without publishing them;
3. requires every draft root to name an already accepted object or a complete
   verified candidate in this operation; and
4. in one SQLite transaction, accepts the required object mappings, writes the
   entire event batch and positions, advances `last_seq`, and updates or
   invalidates projections.

The operation resolves only after that transaction commits. A failed validation
or rollback accepts no new events or objects; unreachable staging may remain.
Before promise resolution a crash may leave the entire new commit or none of
it, never only its new objects or only a subset of its events. Successful
unreferenced object acceptance remains legal and follows orphan grace.

The internal standalone `putRaw`/`putObject` operations accept an object in
their own final transaction. Internal standalone `appendAll`/`ingest` similarly
accept their complete result in one transaction. A full vault MUST NOT compose
independently committed puts and appends to implement `Vault.commit` or import.

<a id="failure-and-recovery"></a>

### 9.2 Failure and recovery

SQLite's transaction journal establishes whether the final publication happened;
there is no application folder journal or per-file replay procedure. Reopen
recovers the committed view before ordinary workers or GC run. Unpublished
staging rows may be discarded, including after a process dies without executing
cleanup. Cache reset cannot publish staged objects or undo a committed union.

An ambiguous commit result makes the runtime halt and reopen to discover the
database's outcome. A rejected promise is not evidence of rollback. Cleanup
MUST NOT remove data referenced by the recovered accepted view. Retrying uses
event IDs and CID equality; procedures rederive unfinished work from events.
`BUSY` may be retried at documented safe boundaries with a finite bound; disk
full, I/O and corruption errors MUST NOT become missing-data results or endless
retry loops.

| Interruption | Permitted recovered state |
| --- | --- |
| During object staging | Previous accepted view; invisible partial staging |
| During final vault commit | Complete previous view or complete new objects/events |
| During import publication | Complete previous union or complete new union |
| During collection | Entire selected deletion transaction or none |
| During rewrap | Complete old wrapper or complete new wrapper |
| During create/restore/export construction | Unpublished destination or complete validated published database |
| After durable inbound commit, before pickup ACK | Committed receipt; redelivery handled by the existing semantic rules |

<a id="snapshot-and-export"></a>

## 10. Snapshot and export

A portable export contains exactly:

- immutable vault metadata and the selected encrypted seed wrapper;
- every accepted event, with its exact canonical bytes and historical author;
- each object in the held-root set of that event cut, with its exact bytes; and
- the common schema and portable publication marker.

It excludes accepted but unheld objects, erased unheld content, local options,
identities, positions, acceptance times, caches, traces, projections, staging,
quarantine and runtime recovery metadata. Unknown valid event types retain
their roots as required by the fold. A still-live independent reference to an
otherwise erased CID retains the same bytes.

Export holds the writer lock from selecting the event/keystore/held-root cut
through copying, verification and publication. Rewrap, erasure, collection and
other mutations wait. Missing or damaged held content, or an incomplete event
view, makes a complete export fail. The exporter cannot select events at one
point and read a later wrapper or retention set.

Build a new empty SQLite destination using only the common DDL. Copy validated
values by an explicit table-and-column allowlist. Reconstruct object rows with
fresh `data_id` values while streaming and verifying the complete bytes; use
`kind = 'portable', ready = 0` until every required value validates. Do not
clone the runtime database and then delete unwanted tables or rows: that may
leave private bytes in free pages. SQLite's whole-database
[backup API](https://www.sqlite.org/backup.html) is a local recovery-copy tool,
not this portable-state selection procedure.

The destination MUST pass section 11's structural, byte and completeness
validation, except for its still-unpublished `ready` value. Then set `ready = 1`
in the final transaction, finish any checkpoint/journal work and close it into
a standalone database. The resulting main file MUST contain all committed pages
and require no external journal, WAL, shared-memory file or runtime VFS metadata.
Portable files use rollback-format read/write header versions. Only after the
destination is complete and its output has completed successfully may export
report success. A cancelled/truncated output is not a successful snapshot.

Database construction, object IO and file output MUST have documented memory and
space bounds. A streaming wrapper around a driver that first allocates the
entire database does not satisfy bounded-memory export. A platform unable to
stream the final file MUST advertise and enforce a measured total-backup size
limit before allocation; it MUST NOT silently omit attachments. Node/browser
round trips include large objects and completion/cancellation at the output
boundary, not just SQL row-copy tests.

<a id="portable-source-validation"></a>

## 11. Portable source validation

Restore and import read an isolated immutable source, or retain a read
transaction protecting one source version for the entire validation and copy.
The source cannot change between validation and use. This source-only read
transaction is the exception to section 9's short-transaction rule; it never
occupies the target connection or the live runtime's SQL writer transaction.

Open the source read-only with extension loading disabled and untrusted schema
handling (`trusted_schema=OFF` or equivalent) before querying application data.
Use only application-owned SQL and bound values; never execute SQL, migrations,
triggers or views supplied by the source. Enforce resource limits and reject
extra executable schema objects rather than adopting them into the runtime.
[SQLite guidance for untrusted databases](https://www.sqlite.org/security.html)
describes these engine controls.

Validation requires:

1. the SQLite header, encoding, application ID and versions above; the complete
   file length agrees with its page count, and no journal or WAL is needed;
2. a successful `PRAGMA integrity_check` and empty `PRAGMA foreign_key_check`,
   followed by an exact structural check of the common schema, including
   ordinary-table kinds, columns, constraints, collations and allowed indexes;
3. one `vault_meta` row with `kind = 'portable', ready = 1`, one valid keystore
   row and valid immutable metadata;
4. every event's strict envelope, canonical BLOB and column equality; no
   duplicate or conflicting accepted event ID;
5. canonical raw CIDs, one complete verified physical version per object,
   contiguous normalized chunks, exact lengths and locally verified digests;
6. no orphan data/chunks, nonportable or unknown table, schema object or column;
   and
7. the held-root fold of the complete source event set, with the source object
   CID set exactly equal to that fold's required set.

The importer also applies known payload/integrity validation from the semantic
suite; valid conflicting facts remain facts and are not rejected merely for
their semantic conflict. Source schema expressions are not a substitute for
checking actual values. Limits apply to file/page count, rows, event/wrapper
bytes, object size, total staged bytes and validation work. Unsupported limits
produce an explicit incomplete/too-large error, not a successful partial backup.

A normal runtime database, an unpublished portable database, or a source with
missing held objects is not a portable import/restore input. An explicit partial
event/object ingestion facility, including deferred sync, cannot label such a
source a complete snapshot. The format supplies integrity checks, not proof of
who authored or selected the supplied history.

<a id="restore-and-import"></a>

## 12. Restore and import

<a id="restore"></a>

### 12.1 Restore

Restore takes one complete validated portable snapshot and an unused destination.
It acquires destination ownership, creates the application-owned schema and
stages validated source values into a new runtime database. It never operates
in place on the supplied snapshot or copies its SQLite schema as executable
instructions. The source wrapper is adopted; the supplied recovery credential
must unlock it and derive the same anchor before destination publication.

The destination remains `ready = 0` while it is constructed. It preserves every
event ID, author and canonical byte and every required CID/byte sequence, while
assigning fresh physical data IDs, acceptance times, `replica_id` and
`store_generation`. Event positions are assigned in canonical order. Historical
event authors are not rewritten. Source local state never exists in this input.

Only after final target integrity and held-root checks does one transaction set
the complete runtime ready. On open, the runtime reconstructs retention and
unfinished committed work before GC, new input or network actions. A failure
leaves an unpublished destination or a complete restored runtime; reopening an
unfinished destination fails explicitly and never silently creates another seed.

<a id="import"></a>

### 12.2 Import into an existing vault

Import merges a complete portable snapshot into an unlocked ready runtime with
the same vault version and anchor. It preserves the target identity, seed
wrapper, author and generation. Under the writer lock from target preflight
through publication:

1. validate the complete stable source and target metadata;
2. apply canonical duplicate/conflict and `ForkedAuthor` checks against the
   target event set; a target value wins an event-ID content conflict and is
   reported, while distinct valid events remain in the prospective union;
3. derive the union's semantic projections and exact held roots with erasure
   closure; verify that every required root has sound bytes in source or target;
4. stage only the required absent or damaged target objects and new events,
   without exposing accepted objects, events or partially updated projections;
   and
5. in one SQLite transaction, accept the staged object mappings, every new
   event and position, the new frontier and projection updates or invalidations.

Preflight may write private staging rows, but a preflight failure changes no
accepted state. Verification of the prospective union completes before the
final transaction. Bytes already staged and hashed under the operation's
exclusive ownership need not be hashed a second time merely for publication.
Normal read integrity checking still applies.

The final transaction MUST NOT be divided into visible sub-batches. A crash
leaves the complete previous view or the complete new union after SQLite
recovery. There is no in-place partial import requiring application journal
replay. Workers and GC resume only after required projections are valid, or
after deriving their answers directly from the committed events.

Repeated import is idempotent. Import does not copy source local control,
keystore replacement, acceptance times or physical row IDs. Bytes present only
for an erased/unheld source relation do not revive it; only the prospective
held-root set permits new object acceptance. Missing non-erased material aborts
complete import. Commit-result ambiguity follows section 9.2.

<a id="exact-local-move"></a>

### 12.3 Exact local move

An exact move transfers a complete runtime, including local control, after
quiescing it and closing/checkpointing the database into a verified standalone
file. The source MUST remain permanently stopped. Destination ownership must
exclude every old handle before preserving its author/generation. A browser
VFS may provide an equivalent complete logical-database transfer; copying one
arbitrary pool file is insufficient.

A crash-recovery copy that needs journals must instead be recovered as a whole
under ownership before such a move. A point-in-time copy restored after later
source writes uses fresh author/generation and invalidates local checkpoints;
it cannot be called an exact continuation. Portable restore always creates
fresh local IDs. Keeping two writable clones is a fork, not a supported mode.

<a id="transfer-and-deferred-synchronization"></a>

## 13. Transfer and deferred synchronization

Phase 1 transfers vault state only by validated portable SQLite export/import/
restore or an exact local move. Database pages, journal positions, rowids,
accepted sequence numbers and chunk IDs MUST NOT be used as sync objects or
replication cursors.

Deferred `vault-sync/1.0` exchanges encrypted immutable configuration, events and
whole-resource DASL objects. It does not upload the SQLite file, local control,
`seedJwe` or database chunks as separate objects. Bootstrap from the seed and
locator reconstructs a fresh SQLite runtime and a new seed wrapper. It neither
restores the source's local identity nor introduces another persistent format.

<a id="required-conformance-cases"></a>

## 14. Required conformance cases

These SQLite cases use the `SQ` prefix. Retired folder cases are not aliases
for them. Event, object and vault-domain conformance also applies.

<a id="schema-and-identity"></a>

### Schema and identity (SQ-1–SQ-9)

1. <a id="sq-1"></a> Node and browser create the same common SQLite schema and exchange
   portable databases with identical event, object and wrapper values.
2. <a id="sq-2"></a> Wrong application ID, vault/schema version, unsupported folder input,
   unknown portable table or altered column/constraint is rejected before writes.
3. <a id="sq-3"></a> Create refuses a nonempty destination; open never turns a missing,
   damaged or unpublished database into a new seed or empty valid vault.
4. <a id="sq-4"></a> Unlock derives the stored anchor before application mutation;
   mismatched seed/wrapper fails without initializing local state.
5. <a id="sq-5"></a> Rewrap interruption preserves the entire old or new wrapper;
   metadata, event IDs and local identity stay unchanged.
6. <a id="sq-6"></a> Reopen preserves both local IDs; restore replaces both while keeping
   every historical author; malformed control rows fail instead of partial repair.
7. <a id="sq-7"></a> Clearing caches/projections preserves options, identity, keystore and
   accepted data; no private key or derived-key registry is persisted.
8. <a id="sq-8"></a> Recovery verification unlocks independent material and derives the
   exact anchor after simulated loss of every active runtime.
9. <a id="sq-9"></a> A schema upgrade interruption leaves schema and version consistent;
   no source-supplied migration, trigger, view or extension is executed.

<a id="events-and-transactions"></a>

### Events and transactions (SQ-10–SQ-18)

10. <a id="sq-10"></a> Canonical BLOB and indexed columns must agree; invalid JSON,
    duplicate member names and noncanonical bytes cannot enter an accepted row.
11. <a id="sq-11"></a> Duplicate and conflicting event IDs preserve the target row;
    unseen own-author input aborts the complete ingest/import before acceptance.
12. <a id="sq-12"></a> A batch larger than 4096 events retains the timestamp, ID and
    returned-order guarantees, and commits with its new objects entirely or not at all.
13. <a id="sq-13"></a> Real process/worker termination during staging and each final
    transaction boundary leaves no partly accepted object, batch or import union.
14. <a id="sq-14"></a> Late events with older timestamps appear in `changes`; empty filtered
    deltas advance the token; generation, future-position and malformed tokens fail.
15. <a id="sq-15"></a> Position values above JavaScript's safe-integer range round-trip
    exactly across both drivers; signed 64-bit exhaustion fails without acceptance.
16. <a id="sq-16"></a> Paginated scans and deltas capture a fixed frontier despite later
    commits; primitive filters equal filtering the same unfiltered event set.
17. <a id="sq-17"></a> Every commit/import updates or invalidates projections atomically;
    reordered input, late evidence, rebuild races and erasure match the pure fold.
18. <a id="sq-18"></a> An uncertain commit halts queued work; reopen discovers old or new
    state and cleanup never deletes data referenced by a recovered commit.

<a id="objects-and-ownership"></a>

### Objects and ownership (SQ-19–SQ-28)

19. <a id="sq-19"></a> Empty, one-byte, multi-chunk and arbitrarily chunked inputs retain
    exact raw CIDs; chunks are contiguous and bounded, with the declared total size.
20. <a id="sq-20"></a> Missing/reordered chunks, wrong length and wrong hash fail acceptance;
    oversized source chunks are normalized with bounded buffers.
21. <a id="sq-21"></a> Staging is absent from all public reads, held-root folds and exports;
    aborted staging is recoverable without publishing a CID.
22. <a id="sq-22"></a> A slow object stream pins its physical version without blocking a
    separate commit; repair swaps versions and quarantine cannot remove the repair.
23. <a id="sq-23"></a> GC skips held, young and latched CIDs without waiting; it atomically
    removes an eligible mapping and bytes, including across real process termination.
24. <a id="sq-24"></a> Two reads of one CID retain independent latches; EOF, error, cancel
    and owner shutdown release only their protection; idle time never releases one.
25. <a id="sq-25"></a> A reader racing GC sees protected complete bytes or absence;
    a failed lazy hash never ends as a verified successful stream.
26. <a id="sq-26"></a> Two processes/workers/realms addressing one database cannot own it
    together; a prior independent inspection blocks later writable open.
27. <a id="sq-27"></a> Close drains admitted work and ends streams before ownership release;
    saved handles fail, and an owner crash fails brokered client streams.
28. <a id="sq-28"></a> Disk-full, I/O, corrupt schema and event damage are explicit errors;
    journal recovery and cache reset never turn them into an empty complete vault.

<a id="backup-import-and-restore"></a>

### Backup, import and restore (SQ-29–SQ-40)

29. <a id="sq-29"></a> Export contains all events, the selected wrapper and exactly held
    objects; shared live references remain and unheld/erased objects are excluded.
30. <a id="sq-30"></a> Local/staging/quarantine sentinel bytes, including deleted-page
    residue in the source, never appear in a newly constructed portable file.
31. <a id="sq-31"></a> Concurrent rewrap, erase or GC cannot mix an export's selected cut;
    missing/damaged held content aborts publication.
32. <a id="sq-32"></a> A completed export opens standalone without WAL/journal/VFS metadata;
    truncated, cancelled, unpublished and source-dependent outputs fail validation.
33. <a id="sq-33"></a> Restore/import hold one immutable source view and reject hostile
    schema objects and malformed rows without executing source-controlled SQL.
34. <a id="sq-34"></a> Restore verifies the recovery credential's anchor, creates fresh
    local IDs/positions/times and resumes committed work without local queues.
35. <a id="sq-35"></a> Import retains the target wrapper and IDs, reports event conflicts,
    preserves valid semantic conflicts, and is idempotent on repeated input.
36. <a id="sq-36"></a> Import computes prospective held roots before acceptance; missing
    required bytes or a fork leaves zero semantic changes despite private staging.
37. <a id="sq-37"></a> Import can repair a damaged required target object; old source bytes
    cannot revive an erased relation or expose an event-only partial union.
38. <a id="sq-38"></a> An interrupted create/restore/export remains unpublished or complete;
    retry does not overwrite an existing destination or silently replace its seed.
39. <a id="sq-39"></a> Exact move requires a stopped source and complete standalone runtime;
    restoring an older local copy refreshes local IDs and invalidates checkpoints.
40. <a id="sq-40"></a> Cross-platform backup/restore with large attachments measures bounded
    object IO and the whole output path; enforced download limits are explicit,
    and skipped browser validation is not reported as passing.
