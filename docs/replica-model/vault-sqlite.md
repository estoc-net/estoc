# The Estoc SQLite vault, version 3

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1**. SQLite is the sole persistent vault and portable
backup format. This replaces the unreleased folder draft, not the existing
implementation. No folder reader, conversion or dual writing is required.

The capitalized requirement words in this document have their BCP 14 meanings.
[event-store.md](event-store.md) owns the API and event semantics;
[dasl-objects.md](dasl-objects.md) owns CID identity and object verification;
[vault-events.md](vault-events.md) owns payloads, folds and held roots. This
file owns SQLite storage and recovery, not a second implementation of SQLite's
transaction or version-management machinery.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Sections |
| --- | --- |
| Implement storage | [Schema](#common-schema), [events](#events-and-change-tokens), [objects](#objects-and-streams), [commit](#commit-and-recovery) |
| Open a vault | [Identity](#identity-and-keystore), [local state](#local-state-and-projections), [ownership](#ownership-and-lifecycle) |
| Back up or recover | [Export](#snapshot-and-export), [validation](#portable-source-validation), [restore/import](#restore-and-import) |

<!-- reading-guide:end -->

<a id="trust-and-portability"></a>

## 1. Trust and portability

A runtime stores events, objects, metadata, the encrypted seed wrapper and
local state in one SQLite database. A portable snapshot is a fresh database
containing only the portable state in section 10. Native and browser drivers
MUST exchange that format without changing logical values or object bytes.
Journals, VFS resources and temporary storage are implementation details; a
copy of a live main database file is not a portable snapshot.

Events and retained content are plaintext. The passphrase protects only the
seed wrapper, not message history or attachments. Applications MUST explain
this boundary. A full runtime, including a hosted one, MUST offer complete
portable export and documented recovery independent of the running service.
A thin client's cache is not a full backup. Plaintext database files are not
mediator messages or the deferred sync protocol's wire format.

<a id="format-and-versions"></a>

## 2. Format and versions

Use SQLite's UTF-8 file format and:

```sql
PRAGMA application_id = 1163088963; -- 0x45535443, ESTC
PRAGMA user_version = 1;
```

`user_version` identifies the SQLite schema; `vault_meta.vault_version = 3`
identifies event, object, key and fold semantics. Reject unsupported versions
before application writes or payload interpretation. This unreleased draft
requires no migration from earlier drafts. Published schema changes require a
new schema version; semantic changes follow [ES §14](event-store.md#versioning).
Any supported migration is application-owned and commits schema and version
together. A failed migration cannot expose a partly upgraded normal runtime.

<a id="common-schema"></a>

## 3. Common schema

Runtime and portable databases use these five ordinary `STRICT` tables:

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

CREATE TABLE objects (
  cid  TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0)
) STRICT;

CREATE TABLE object_chunks (
  cid      TEXT COLLATE BINARY NOT NULL REFERENCES objects(cid) ON DELETE CASCADE,
  chunk_no INTEGER NOT NULL CHECK (chunk_no >= 0),
  bytes    BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),
  PRIMARY KEY (cid, chunk_no)
) STRICT;
```

A ready database has exactly one metadata row and one keystore row. `ready = 0`
is unpublished construction and MUST NOT open as a normal runtime or portable
input. `ready = 1` does not replace validation. Runtime databases additionally
have section 5's control tables and MAY have application-owned local tables and
indexes. Extra tables cannot hold authoritative portable application state.

Portable databases have `kind = 'portable'` and only the five common tables and
their constraint-created indexes. Query-performance indexes are runtime details,
not backup requirements. Table/column names, types, keys and relationships are
fixed; SQL spelling is not. Input values still require application validation.
Drivers MUST preserve valid Unicode, BLOB bytes and integers exactly, refusing
out-of-range values rather than rounding them.

<a id="identity-and-keystore"></a>

## 4. Identity and keystore

The metadata anchor, format and vault version are immutable. Before application
writes or identity use, unlock or obtain the seed, derive its fixed `anchor`
key and require the resulting DID to equal `vault_meta.anchor`.

`seed_jwe` stores the exact UTF-8 bytes of the **compact JWE string** produced
by `@estoc/keystore` version 3, without JSON quoting or a trailing newline.
The API value is `{ version: 3, seedJwe: string }`. Validate the package's JWE
profile; do not convert it to a different JOSE serialization. The vault stores
no key registry. Derive keys by their exact portable names after unlock; keep
the plaintext seed, private keys and derivation caches out of persistent state.
Release in-memory secrets on lock or process exit.

<a id="rewrap-and-import-policy"></a>

### 4.1 Rewrap and import policy

Rewrap verifies that the replacement wrapper unlocks to the same seed/anchor,
then replaces it in one serialized transaction. Restore adopts the snapshot's
wrapper. Import into an unlocked same-anchor vault retains the target wrapper;
it validates source wrapper shape without requiring the source passphrase.
If the source seed is unlocked, its derived anchor must also match. Anchor
equality is an identity consistency check, not authentication of supplied history.

<a id="recovery-material-and-product-requirement"></a>

### 4.2 Recovery material

Before describing a vault as recoverable, the application MUST verify an
independent recovery path: a documented integrity-protected offline seed export,
or a complete snapshot plus a separately retained credential. Verification
unlocks that material in isolation and derives the exact anchor. Seed-only
recovery restores identity, not history; phase-1 history recovery needs a
snapshot. Onboarding exposes recovery status. A sync store is not a seed backup.

<a id="events-and-change-tokens"></a>

## 5. Events and change tokens

`events.canonical` is exactly `canonicalEventBytes(event)`, without a newline;
the other columns MUST equal the corresponding envelope fields. Accepted events
are never updated or deleted. Duplicate/conflict and current-author fork checks
follow [ES §5](event-store.md#eventstore).

Runtime-only control:

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
```

There is one control row; both IDs are canonical lowercase UUIDv7. Every accepted
event has one position. Acceptance allocates positions above `last_seq` and
advances it in the same transaction. Empty/duplicate-only writes do not advance
it. Positions remain fixed within a generation; `last_seq` is their maximum or
zero for an empty store. Missing/inconsistent control is damage, not creation.

Scans and deltas capture a fixed upper position; later accepts cannot change
that result. Scans use canonical order, not position order. Tokens identify the
vault, local generation and complete delta frontier. Their encoding and the
query/pagination strategy are implementation details. Reject malformed,
wrong-vault/generation and future tokens. An empty filtered delta still advances
the frontier; a consumer checkpoints only after consuming the complete result.
Positions/tokens never travel in portable state or become sync cursors.

<a id="objects-and-streams"></a>

## 6. Objects and streams

One `objects` row and its ordered chunks represent the exact resource under a
raw CID. Chunks are contiguous from zero, 1 MiB each except a final nonempty
chunk of at most 1 MiB. Empty objects have size zero and no chunks. Chunk lengths
sum to `size`; concatenation hashes to the CID. There are no physical-version
IDs, acceptance clocks or separately addressed chunks. Historical event roots
have no foreign key to objects: erased references can outlive collected bytes.

<a id="staging-and-acceptance"></a>

### 6.1 Preparation and acceptance

Consume and hash sources with bounded buffers before publication. Large inputs
may use private temporary files or staging tables; their layout is not part of
this format. Public reads and folds MUST NOT see preparation as accepted data.
Copy verified bytes into the common object tables in the transaction that
accepts their references. A full `Vault.commit` rejects a supplied object not
referenced by any of its drafts; no orphan-grace workflow is required.

<a id="reads-damage-and-collection"></a>

### 6.2 Reads and maintenance

A read either returns complete unchanged bytes or explicitly fails/cancels;
maintenance MUST NOT turn it into a successful truncated or mixed read. A runtime
MAY serialize reads with writes. Before repair or GC changes bytes, prevent new
reads and let affected reads finish or explicitly cancel them. Nonblocking
writers, indefinitely paused streams and seamless online repair are not required.
SQLite read transactions may be used where supported; no application latch or
physical-version protocol is prescribed.

Missing chunks, wrong lengths and hash mismatches are reported as damage, never
policy erasure or success. Damaged objects cannot satisfy new reads or work
requiring sound content until verified repair. Repair may run in maintenance
mode and replaces the complete object's bytes in one transaction after readers
are quiesced. Persistent quarantine is not required. Structural database damage
fails the runtime; event damage blocks mutation, GC and full export rather than
silently shrinking history.

GC holds the operation lock from computing current held roots through deleting
unheld objects and their chunks in one transaction. No acceptance timestamps or
minimum orphan age are needed. Unpublished temporary data may be discarded when
no operation uses it. Collection promises logical removal, not file shrinkage
or forensic erasure. Never remove accepted data merely because a promise failed.

<a id="local-state-and-projections"></a>

## 7. Local state and projections

Local IDs, positions, preferences, diagnostics, staging and projections are not
portable. Normal reopen and cache clearing preserve identity/control and the
keystore. Restore creates fresh replica/generation IDs. An explicit identity
reset closes the runtime and atomically replaces both IDs under ownership,
retaining events/objects and invalidating generation-bound caches.

Start with direct folds of committed events. Cached or incremental projections
are optional. If used, they must equal the pure fold and be updated with their
checkpoint or invalidated in the accepting transaction. Rebuild before use;
no background rebuild, prescribed cache schema or incremental algorithm is
required. Cached previews obey their source content's erasure policy.

<a id="ownership-and-lifecycle"></a>

## 8. Ownership and lifecycle

One runtime owns a physical database, including recovery and all its handles.
Ownership must exclude a second process/worker addressing the same database;
rejecting that open is sufficient. Cross-process read brokers and independent
live SQL readers are not required; clients cannot bypass ownership. An offline
inspector takes ownership too;
an immutable portable snapshot can be read separately.

Within the owner, one operation lock serializes semantic mutations, including
receipt allocation and GC. SQLite transactions provide atomic publication;
they do not stop two application runtimes from performing duplicate network
work. The ownership mechanism is platform-specific, not another storage format.

<a id="create-open-and-close"></a>

### 8.1 Create, open and close

Create requires an unused destination and validated seed/anchor/wrapper. It
publishes complete metadata and fresh control as `ready = 1` in one transaction.
Open never creates a missing vault: acquire ownership, let SQLite recover its
journal, validate format/schema and `kind = 'runtime', ready = 1`, then verify
the unlocked seed's anchor before application writes. Validate control and
reconstruct committed retention and unfinished work under
[VE §13.1](vault-events.md#open-the-writable-full-runtime) before GC or workers.

An inspector makes no application writes or new local IDs. If read-only access
cannot perform needed journal recovery, fail rather than discard the journal.
Close stops admission, finishes or safely cancels work/streams and closes all
database handles before releasing ownership. Old handles cannot continue after
close. Do not release ownership while an operation still uses the database.

<a id="commit-and-recovery"></a>

## 9. Commit and recovery

Use SQLite transactions and journal recovery, not an application publication
journal. The driver must meet [ES §2.1](event-store.md#commit-and-durability-terminology),
enable foreign keys and use a recoverable journal/durability configuration.
Document and test the effective configuration on each supported platform;
`journal_mode=OFF/MEMORY` and `synchronous=OFF` are not runtime policies.
No particular VFS, WAL mode or stronger power-loss guarantee is mandated.

<a id="atomic-vault-commit"></a>

### 9.1 Atomic commit

Under the operation lock, validate drafts and prepare objects, assign events
under ES's batch rules, and require every root to have sound accepted or prepared
bytes. One transaction accepts all supplied objects, the whole event batch and
positions, and updates/invalidates any affected caches. Resolve after commit.
Do not compose independently committed puts and appends. A rollback accepts
nothing new. Do not hold a write transaction across network or source-stream
waits; copying prepared local data may occur within the final transaction.

<a id="failure-and-recovery"></a>

### 9.2 Failure and recovery

After interruption, SQLite recovers the complete old or new transaction. Discard
only unpublished leftovers. Disk-full, I/O and corruption errors must surface;
they are not missing-data results. On an uncertain commit outcome, stop further
work and reopen to recover the accepted view before proceeding.

Existing event IDs make ingest/import retries idempotent. A `Vault.commit`
caller may not have received its minted IDs: do not blindly retry those drafts.
First reconcile the operation using its stable domain/message ID and committed
events. Transaction atomicity does not itself guarantee exactly-once execution.

<a id="snapshot-and-export"></a>

## 10. Snapshot and export

Export includes immutable metadata, the selected seed wrapper, every accepted
event and exactly the held objects for that event cut. Unknown valid event types
retain their roots. Missing/damaged held bytes or incomplete history fails export.
Local tables, control, unheld content and temporary data are excluded.

Hold the operation lock while building and verifying a fresh destination with
the common schema, `kind = 'portable'` and initially `ready = 0`. Copy only the
allowed logical values; verify canonical events and object hashes. Do not clone
the runtime then delete unwanted rows: excluded bytes may remain in free pages.
SQLite's backup API is suitable for whole-runtime recovery copies, not this
portable-state selection.

Validate the destination, set ready, finish journal/checkpoint work and close it
as a standalone main file with rollback-format headers and no required sidecars.
Then release the live vault lock **before** delivering that immutable file.
Success requires completed output; cancellation/truncation is a delivery failure,
not permission to omit content. Object I/O and output need bounded memory or an
explicit enforced total-backup limit before allocation.

<a id="portable-source-validation"></a>

## 11. Portable source validation

Use a stable source for the entire validation and copy: an isolated immutable
file or a protected source read transaction. Open it read-only, disable extension
loading and use untrusted-schema handling (`trusted_schema=OFF` or equivalent).
Inspect schema before querying its
application data or running integrity checks; execute no source-supplied SQL,
views, triggers, migrations or extensions.

Require supported header/encoding/versions, a complete standalone file, the
common ordinary tables and only their allowed columns/keys/indexes, valid
metadata/wrapper, successful SQLite integrity and foreign-key checks, exact
canonical event bytes and matching columns, valid known payloads, and locally
verified object lengths/chunks/hashes. The object set must equal the held-root
fold of all source events. Reject extra tables or executable schema objects;
validate values rather than trusting source constraints. Bound input size and
validation work and report limits explicitly, never partial success.

Runtime databases, unpublished files and incomplete snapshots are not portable
restore/import inputs. Validation establishes integrity, not who selected or
authored the history. Valid conflicting semantic facts remain facts.

<a id="restore-and-import"></a>

## 12. Restore and import

<a id="restore"></a>

### 12.1 Restore

Validate a complete source and its recovery credential/anchor. Build a new
runtime in an unused destination using application-owned DDL, adopting the
wrapper and preserving every event ID, author, canonical byte and required
object. Assign fresh replica/generation IDs and local positions. Keep it unready
until integrity/completeness checks pass; publish readiness in one transaction.
Open then reconstructs retention and unfinished work before enabling workers.
A failed construction is not an empty vault and cannot silently mint another seed.

<a id="import"></a>

### 12.2 Import

Validate and pin the complete source **before taking the target operation lock**.
Then, under that lock, require a ready unlocked target with equal version/anchor,
apply target duplicate/conflict and `ForkedAuthor` checks, and compute the
prospective union and held roots with erasure closure. The target wins event-ID
content conflicts, which are reported; distinct valid facts remain in the union.
Require sound bytes for every union root in source or target. Stage required
absent/damaged objects without publishing them; quiesce reads before repair.

One transaction accepts the required objects, all new events and positions, and
updates/invalidates any caches. No visible sub-batches. Preflight failure changes
no accepted state; crash recovery yields the complete old or new union. Preserve
target metadata, wrapper and local IDs. Repeated import is idempotent and cannot
revive an erased relation just because the source has old bytes. Partial sync
ingestion is a separate facility, not a complete portable import.

<a id="exact-local-move"></a>

### 12.3 Exact local move

A move may preserve local IDs only after the source is permanently stopped and
the complete runtime is closed/recovered into a standalone transferable database.
Destination ownership excludes old handles. A stale recovery copy restored after
later source writes must refresh both IDs and invalidate checkpoints. Portable
restore always uses fresh IDs; two writable clones are not an exact move.

<a id="transfer-and-deferred-synchronization"></a>

## 13. Deferred synchronization

Phase 1 uses portable export/import/restore or an exact move. Deferred
`vault-sync/1.0` exchanges encrypted immutable configuration, events and whole
DASL objects, not SQLite pages, chunks, positions, local state or `seedJwe`.
Seed-and-locator bootstrap builds a fresh runtime and seed wrapper.

<a id="required-conformance-cases"></a>

## 14. Required conformance cases

Test observable correctness, not a particular broker, cache or stream-latch
implementation. Case IDs retain their subjects; superseded concurrency and
physical-version guarantees are recorded in the suite's section history.

<a id="schema-and-identity"></a>

### Schema and identity (SQ-1–SQ-9)

1. <a id="sq-1"></a> Native/browser drivers exchange identical portable logical values.
2. <a id="sq-2"></a> Unsupported versions, folder inputs and extra portable schema fail.
3. <a id="sq-3"></a> Create refuses existing destinations; open never implicitly creates.
4. <a id="sq-4"></a> Wrong seed/anchor fails before application writes.
5. <a id="sq-5"></a> Rewrap interruption leaves the complete old or new wrapper.
6. <a id="sq-6"></a> Reopen preserves local IDs; restore renews them; malformed control fails.
7. <a id="sq-7"></a> Cache clearing preserves identity/data; no private keys are persisted.
8. <a id="sq-8"></a> Independent recovery material derives the same anchor after runtime loss.
9. <a id="sq-9"></a> A supported migration is atomic and never executes source instructions.

<a id="events-and-transactions"></a>

### Events and transactions (SQ-10–SQ-18)

10. <a id="sq-10"></a> Canonical event bytes and indexed fields agree; invalid events fail.
11. <a id="sq-11"></a> Conflicts preserve target rows; a current-author fork aborts import.
12. <a id="sq-12"></a> Large batches preserve ES timestamp/ID/order and atomicity rules.
13. <a id="sq-13"></a> Process/worker termination never exposes a partial accepted commit.
14. <a id="sq-14"></a> Late events appear in deltas; empty filtered deltas advance tokens.
15. <a id="sq-15"></a> Driver integers round-trip exactly or fail before acceptance.
16. <a id="sq-16"></a> Scans/deltas use a fixed cut and exact primitive filter semantics.
17. <a id="sq-17"></a> Direct folds and any optional caches agree after imports and erasures.
18. <a id="sq-18"></a> Uncertain commit stops work; recovery reconciles before any retry.

<a id="objects-and-ownership"></a>

### Objects and ownership (SQ-19–SQ-28)

19. <a id="sq-19"></a> Empty and arbitrarily chunked inputs preserve exact CIDs and bytes.
20. <a id="sq-20"></a> Missing chunks, wrong sizes/hashes and exceeded limits fail explicitly.
21. <a id="sq-21"></a> Preparation is invisible; unused supplied objects fail full commit.
22. <a id="sq-22"></a> Repair waits for or cancels affected readers before replacing bytes.
23. <a id="sq-23"></a> GC preserves held roots and atomically deletes selected unheld objects.
24. <a id="sq-24"></a> Each read completes unchanged or explicitly fails/cancels during maintenance.
25. <a id="sq-25"></a> A failed lazy hash or interrupted read never reports successful completion.
26. <a id="sq-26"></a> A second owner is excluded, including during offline inspection.
27. <a id="sq-27"></a> Close stops old handles and ends database access before releasing ownership.
28. <a id="sq-28"></a> Storage/event damage never becomes an empty complete vault.

<a id="backup-import-and-restore"></a>

### Backup, import and restore (SQ-29–SQ-40)

29. <a id="sq-29"></a> Export contains every event and exactly held objects at its selected cut.
30. <a id="sq-30"></a> Excluded local/unheld sentinel bytes never enter the fresh portable file.
31. <a id="sq-31"></a> Rewrap/erase/GC cannot mix the export cut; delivery holds no live vault lock.
32. <a id="sq-32"></a> Output opens without sidecars; incomplete/cancelled output is not success.
33. <a id="sq-33"></a> Stable-source validation rejects hostile schema and malformed values.
34. <a id="sq-34"></a> Restore unlocks the real keystore wrapper and resumes work with fresh IDs.
35. <a id="sq-35"></a> Import preserves target wrapper/IDs, reports conflicts and is idempotent.
36. <a id="sq-36"></a> Missing prospective roots or a fork aborts without semantic writes.
37. <a id="sq-37"></a> Maintenance import repairs damaged objects without reviving erasures.
38. <a id="sq-38"></a> Interrupted construction is unpublished or complete, never implicit creation.
39. <a id="sq-39"></a> Exact move requires a stopped source; stale copies refresh local identity.
40. <a id="sq-40"></a> Large-object and output limits are exercised on each supported platform.
