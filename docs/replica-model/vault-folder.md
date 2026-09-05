# The `.estoc` folder, version 3

Status: **draft, phase 1** — clean-break readable interchange format and
reference folder backend for one active writable Estoc vault runtime. Deferred
replication does not change this portable format.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

`event-store.md` defines the medium-independent event and vault interfaces.
`dasl-objects.md` defines the portable object profile. This document maps
those interfaces to files. It defines no event payload and never interprets
`data`; event meanings and held-root rules are `vault-events.md`'s.

The folder is both:

- the reference implementation of the store; and
- the human-readable interchange and backup format every other backend
  must render and read.

It is not a network sync wire format. Deferred `vault-sync/1.0` deliberately
uses opaque encrypted objects instead.

## 1. Trust and portability

A portable Estoc vault is a directory containing `.estoc/`. A snapshot
is the portable part of that directory, commonly placed in a zip without
changing its internal paths.

The folder is designed for sovereignty rather than secrecy:

- events and ordinary DASL objects are readable plaintext;
- key names and identity metadata are readable;
- the vault seed is encrypted as `seedJwe`; and
- an encrypted backup wrapper, filesystem encryption or encrypted volume
  is outside this format.

A conforming application MUST state this boundary to the user. The
passphrase protects the ability to use the identity; by itself it does
not encrypt message history or attachments.

A `.estoc/` folder MUST NOT be uploaded as a mediator message or treated as a
network-server representation. Deferred `vault-sync/1.0` uses another,
client-encrypted representation.

A full vault runtime may use this format on an end-user machine or render it
from a server-side backend. A hosted implementation that holds the seed MUST
be able to export the complete portable vault in this format; its internal
database MUST NOT be the only recoverable representation.

Selected `did:web` document revisions are ordinary referenced objects and
vault events. The published `did.json` resource is a deployment projection,
not a new authoritative file inside `.estoc/`.

A remote thin client that does not hold the seed and full portable state is
not a vault folder backend. Its command queue and projection cache belong to
client-local storage outside this format.

## 2. Path and byte rules

All paths in this document are relative to the vault root and use `/` as
the separator.

A conforming path:

- is UTF-8;
- contains no NUL;
- contains no backslash;
- is not absolute;
- contains no empty, `.` or `..` component; and
- is compared by Unicode code point without platform case folding.

Writers SHOULD use ASCII for structural and generated names. Readers
MUST NOT normalize path components before validation.

Text conventions:

- JSON files are UTF-8, pretty-printed, and end in `\n`;
- JSONL segments use one RFC 8785 canonical UTF-8 event object per line;
- every complete JSONL record is exactly `canonicalEventBytes(event)` followed
  by `\n`; and
- object files contain exact portable object bytes and have no text encoding.

A reader MUST reject a tree in which one path is both a file and a
directory.

## 3. Layout

```text
.estoc/
  config.json
  keystore.json

  events/
    <author>/
      <segment>.jsonl

  objects/
    <cid>

  extensions/
    <ext>/
      events/
        <author>/
          <segment>.jsonl
      objects/
        <cid>

  local/
    replica.json
    agent/
      options.json
      cache/
      trace/
        <segment>.jsonl
    extensions/
      <ext>/
        options.json
        cache/
        trace/
          <segment>.jsonl

  <opaque portable paths defined by this or a future version>
```

There is no per-host directory or record, and no directory per contact,
channel, conversation or message.

The structural roots are:

```text
config.json
keystore.json
events/
objects/
extensions/
local/
```

A malformed entry inside `events/`, `objects/`, `extensions/` or `local/`
is damage, not an opaque portable file. Unknown top-level paths outside
these roots are portable opaque files as described in section 7.3.

### 3.1 Portable and local halves

Everything except `local/` is portable state. It may appear in a
snapshot, export or folder import.

`local/` belongs only to one writable copy. It is never:

- included in a portable snapshot;
- imported into another copy;
- synchronized;
- exposed through `FileStore`; or
- used to decide whether a portable event or object exists.

Deleting all of `local/` converts a folder into a portable copy. The next
writable open creates a new replica ID and store generation.

### 3.2 Extension stores

`extensions/<ext>/` serializes one extension event/object store. `<ext>` is
a canonical UUIDv7 minted by `extension.installed`.

An extension directory contains only:

```text
events/<author>/<segment>.jsonl
objects/<cid>
```

It has no independent `config.json`, `keystore.json`, `local/` or nested
`extensions/`. Its local options, cache and trace are under
`local/extensions/<ext>/`.

An empty directory is not a store. It need not survive export and is not
returned by `Vault.extensions()`.

## 4. `config.json`

```json
{
  "format": "estoc",
  "version": 3,
  "identity": {
    "anchor": {
      "key": "anchor",
      "did": "did:key:z6Mk..."
    }
  }
}
```

The member set is closed in version 3. A reader MUST reject an unknown or
missing member.

- `format` MUST be `estoc`.
- `version` MUST be the integer `3`.
- `identity.anchor.key` MUST be `anchor`.
- `identity.anchor.did` MUST be the DID derived from the unlocked vault
  seed under the fixed anchor derivation.

`config.json` is immutable after vault creation. A writable open with an
unlocked seed MUST derive the anchor and compare it before permitting any
identity operation.

Two folders represent the same vault identity exactly when their anchor
DIDs are equal. An import into an existing vault requires both version
and anchor equality.

## 5. `keystore.json`

`keystore.json` is the portable encrypted wrapper for the one vault seed. It
contains no derived-key registry or portable key cache.

A representative shape is:

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

The exact JWE profile is owned by `@estoc/keystore` version 3. A folder reader
MUST validate that shape before any write-producing open or import.

All asymmetric key names are determined by fixed protocol names and portable
vault events. After unlock, a runtime derives a requested key directly from
the seed and its exact key name. It MUST NOT depend on a portable list of keys
that happened to be minted on another replica.

The version-3 keystore model has no persistent derived-key cache. A runtime
MAY retain an already derived key object only in process memory for the active
unlocked session. It MUST release that object on lock or process exit and MUST
NOT write derived private keys, a key registry or a derivation cache anywhere
under `.estoc/`, including `local/`. Every later session derives requested
keys again from the seed and exact portable key name.

### 5.1 Import policy

For import into an existing unlocked vault:

- the target's `seedJwe` is retained;
- the source seed, when unlocked, MUST derive the same anchor DID;
- no derived-key cache is merged; and
- an anchor mismatch is fatal before any semantic write.

The local passphrase or platform wrapping may differ between replicas. Equal
vault identity does not require byte-equal `seedJwe`.

### 5.2 Sync bootstrap (deferred)

Deferred `vault-sync/1.0` does not upload `seedJwe`. A future user
bootstrapping from a sync store would supply the vault seed by another trusted
means and write a new local passphrase or platform wrapping. Phase-1 recovery
uses the readable folder or snapshot plus independent recovery material.

### 5.3 Recovery material and product requirement

The vault seed is the only cryptographic root from which the anchor,
communication keys, mediation accounts and any future sync-account credentials
can be recovered. Network synchronization is not a seed backup. Loss of every usable
seed copy makes encrypted sync objects and identity keys unrecoverable.

A user-facing implementation MUST NOT describe a vault as recoverable until
it has offered and verified at least one recovery path independent of the
active runtime. A conforming path is either:

- an offline export of the seed using a documented, integrity-protected
  representation; or
- a complete portable snapshot whose seed wrapper can be opened with a
  separately retained passphrase or recovery credential.

Verification MUST occur in an isolated check that opens the recovery material
and derives exactly the anchor DID in `config.json`. Merely observing that a
file download completed is not recovery verification.

The product MUST make this requirement part of creation/onboarding and expose
current recovery status. A release relying on the single-seed model MUST test
loss of every active runtime followed by restoration from the documented
recovery material.

## 6. Event paths

The mapping is:

```text
locate(event) = events/<event.author>/
```

For an extension store:

```text
locate(ext, event) = extensions/<ext>/events/<event.author>/
```

`<author>` MUST be the canonical lowercase UUIDv7 in the event's
`author` field.

A reader requires each complete JSONL line, excluding its final LF, to
be exactly `canonicalEventBytes(event)` under RFC 8785, then validates the full
event envelope under `event-store.md`. It then requires the path author to
equal the line's `author`. The path confirms authorship; it never
supplies it.

A line remains self-describing when copied out of its folder. Nothing in
the event payload is recovered from the path.

## 7. Portable opaque files

### 7.1 Owned paths

The folder backend owns all paths matching:

```text
config.json
keystore.json
events/**
objects/**
extensions/**
local/**
```

`FileStore.write` MUST refuse to create or overwrite a path in these
owned trees except through the operation that owns it.

### 7.2 No generic synchronized mutable state

Version 3 has no generic `state/` directory and no timestamp-based
file-level merge rule.

Correctness-critical state that must converge across replicas is an
event or referenced object. High-churn state that belongs only to one
local copy goes under `local/`. A future portable mutable file type must
have its own versioned merge law; there is no fallback latest-wins rule.

### 7.3 Unknown top-level paths

A top-level path not reserved above is an opaque portable file or
directory. A conforming round trip preserves its bytes and relative
paths.

On import into an existing vault, an unknown path is copied only when
absent. An existing target path is never overwritten. A collision in
which one side has a file and the other a directory is a preflight error.

`vault-sync/1.0` version 1.0 does not synchronize these paths. A feature
that requires them on every replica must define an encrypted sync object
or, preferably, use events and objects.

## 8. Segments

A segment is:

```text
<segment>.jsonl
```

where `<segment>` is a canonical lowercase UUIDv7.

Each complete line is exactly `canonicalEventBytes(event)` under RFC 8785
followed by `\n`. A segment has no header and no semantic metadata. Segment
name, order, size and boundary are not part of any event's identity.

### 8.1 Local append segments

A local append writes only under:

```text
events/<current replica_id>/
```

or the corresponding extension path.

A writer MAY append to its newest writable segment or rotate to a fresh
one. It MUST serialize appends within one folder generation.

Before appending to a segment that does not end in `\n`, the writer MUST
terminate or quarantine the existing fragment so it cannot be fused with
the next event. The fragment remains reportable damage.

`appendAll` SHOULD use a fresh segment written atomically and renamed
into place, so a process restart observes the complete batch or none of
it.

### 8.2 Ingest segments

After complete validation and fork preflight, one `ingest` call writes
new events into fresh segments minted by the target store. It SHOULD use
at most one fresh segment per incoming author for that call.

It MUST NOT copy a source segment as an opaque file. Source events are
decoded, duplicate-member checked, deduplicated by `eid` using RFC 8785
canonical bytes and reserialized canonically. Therefore the target may
contain several segments under one author, some originally appended by
that author and some created while other stores ingested its events.

All lines under one author directory still carry that author.

### 8.3 No physical ordering guarantee

Segments are not sorted streams:

- wall clocks move backwards;
- imported events arrive in arbitrary order; and
- segment traversal order is backend-specific.

`scan()` reads, deduplicates and sorts events into canonical order. A
reader MUST NOT infer order from segment name, directory order or line
position.

## 9. DASL object paths

Each accepted portable object is one file:

```text
objects/<canonical-dasl-cid>
```

or, for an extension:

```text
extensions/<ext>/objects/<canonical-dasl-cid>
```

The filename MUST be the canonical DASL CID of the exact complete file bytes
under `dasl-objects.md`:

- CIDv1;
- lowercase base32 without padding;
- SHA-256;
- codec `raw` or DRISL; and
- no CIDv0, DAG-PB (including UnixFS metadata nodes), or BDASL.

The directory is flat. A backend may shard or split an object into private
extents internally, but export MUST reconstruct one complete file at the flat
portable path. No portable chunk or extent directory exists.

For a raw CID, the file contains the exact resource bytes. For a DRISL CID, the
file contains one exact canonical DRISL object. A reader MUST verify filename,
digest and codec-specific conformance before accepting the object. Acceptance
means import or first entry into the owned `objects/` namespace. A later
`open` of an accepted object follows `dasl-objects.md` section 6.4.

A filename/content mismatch, malformed CID, non-canonical DRISL encoding,
truncation or trailing DRISL bytes is damage. The backend SHOULD move damaged
material out of the owned `objects/` namespace before continuing, so ordinary
presence checks treat it as absent.

A portable object is immutable by content. Successful acceptance is
process-durable under `event-store.md` section 2.1. Repeating acceptance for an
existing valid CID is idempotent and MAY renew local orphan age as an
optimization.

Writers accept complete objects before an event reference and protect them from
collection until the reference commits or aborts. A crash may leave a valid
unreferenced object. Collection later removes only exact unheld, unpinned
objects older than the configured grace; it does not traverse DRISL links or
rely on grace in place of commit/GC coordination.

## 10. `local/`

`local/` contains state of this writable copy only.

### 10.1 `local/replica.json`

```json
{
  "replica_id": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
  "store_generation": "019b2a43-5c8d-75a0-bf82-b2a61a4ce099"
}
```

Both values are canonical lowercase UUIDv7.

- `replica_id` is the event author. Deferred replica mediation may later reuse
  it as a pickup/ACK scope, but phase 1 never sends it to a mediator.
- `store_generation` names this local physical event-store generation in
  change tokens and cache metadata.

Neither value is a hardware or operating-system identifier. Neither is
an authorization secret.

When the whole file is absent on first writable open, the runtime MUST mint
both values and durably write the file before exposing append or pickup
operations. A partially present, malformed or internally inconsistent
file is damage and MUST NOT be silently repaired by retaining one field.

Deleting `local/` intentionally creates a new replica on next open.
Preserving `local/` preserves the replica identity and is safe only for
an exact move with no concurrent old writer.

No `replica.created` event is appended.

Phase 1 has no mediator-side replica registry, so a mediator never retires
this ID. `replica.retired` and network-driven re-incarnation are reserved for
the deferred replica-mediation profile. Local restore and exact-move behavior
are defined below. Events already authored by an old ID are never rewritten.

### 10.2 Owner directories

Each local owner may keep:

```text
options.json  non-rebuildable local configuration
cache/        rebuildable indexes and fold projections
trace/        local event-like diagnostic streams with explicit retention
```

The application owner is `local/agent/`. Extension owners use
`local/extensions/<ext>/`.

These directories have no portable merge semantics. `cache/` may contain
indexes and fold projections but MUST NOT contain derived private keys or a
keystore registry. A trace may use the same six-field JSON shape for
convenience, but it is not in the vault's event set and may be pruned according
to local retention.

### 10.3 Change tokens

The folder backend's change token names at least:

- `store_generation`;
- which store issued it, main or one extension;
- every segment path visible at the frontier; and
- the byte length accepted from each segment.

A token is rejected if:

- its generation or store differs;
- a named segment is missing or shorter;
- a recorded byte position is not a complete-line boundary; or
- its shape is not recognized.

Hand-editing bytes without changing length can evade this structural
check; deleting local caches is the recovery for any manual edit.

## 11. Reference folder backend

### 11.1 Open

A read-only open:

1. validates path shape;
2. reads and validates `config.json`;
3. validates structural roots as needed; and
4. does not create `local/`.

A writable open additionally:

1. validates `keystore.json`;
2. unlocks or obtains the seed;
3. verifies the derived anchor;
4. creates or validates `local/replica.json`;
5. acquires the folder's single-writer lock; and
6. opens the main and extension stores with
   `author = replica_id`.

Before running extensions, the application folds extension lifecycle and
applies every pending purge.

### 11.2 Scan

`scan(filter)`:

1. walks every segment in `events/*/`, restricted to one author
   directory when the filter specifies `author`;
2. reads complete lines;
3. validates envelope and path-author equality;
4. records damaged lines;
5. deduplicates by `eid` and records conflicts;
6. applies the equality filter;
7. sorts by `(at, eid, author)`; and
8. yields accepted events.

A filter reduces output, not necessarily I/O. Local indexes may optimize
this without changing results.

### 11.3 Append

A local append writes only to the current replica's author directory.
The backend MUST reject an attempt to provide or override `eid`, `at` or
`author` through the draft API.

If the process terminates before the append promise resolves, reopen may see
the complete line or no accepted line, never a partial accepted event. When the
promise resolves, the line is process-durable and every later process restart
MUST observe it. Sudden power-loss survival depends on the backend's documented
flush policy.

### 11.4 Ingest

The backend first reads or stages all incoming events, validates them,
checks duplicates/conflicts and performs the `ForkedAuthor` preflight
against `local/replica.json.replica_id`.

Only then does it write fresh ingest segments. A validation or fork
failure before this point writes nothing.

The operation is idempotent. Repeating it may rescan input but adds no
second copy by `eid`.

### 11.5 Damage and conflict

A damaged line is:

- an incomplete final fragment;
- invalid UTF-8;
- invalid JSON;
- a non-object;
- an invalid event envelope; or
- an event whose `author` differs from the path author.

It is skipped and reported, never joined with a following line.

If manual file operations place different contents under one `eid`, the
folder reader keeps the content from the lexicographically first segment
path and, within one segment, the first line offset. It reports every
other content. This deterministic local choice is not conflict
resolution at the vault level.

### 11.6 Portable FileStore

`FileStore.list()` returns `config.json`, `keystore.json` and opaque
portable paths, but MUST NOT return event segments, DASL objects or
anything under `local/`.

`FileStore.write()` obeys singleton and unknown-file rules and refuses
structural paths.

## 12. Snapshot and export

### 12.1 Snapshot

A folder snapshot contains every portable file under `.estoc/` and omits
`local/` completely.

A snapshot may include an extension store that has a converged
`extension.purged` event but has not yet been physically disposed. An
importing or restored application applies the lifecycle fold before the
extension can run.

### 12.2 Export from another backend

A non-folder backend renders:

- `config.json` and `keystore.json`;
- one complete line per main event under `events/<author>/`;
- every retained main DASL object under `objects/<cid>`;
- each extension store under `extensions/<ext>/`; and
- opaque portable files in their paths.

The exporter chooses fresh segment IDs and boundaries. One segment per
author is sufficient. It MUST NOT create `local/`.

The result must round-trip through the folder reader to the same event
and byte sets.

## 13. Import and restore

### 13.1 Import into an existing vault

Before writing, the importer MUST:

1. require version 3;
2. require the same anchor DID;
3. validate `keystore.json` shape and seed identity;
4. validate every event and path-author relation;
5. preflight forked-current-author conditions in the main and all
   applicable extension stores;
6. validate every source DASL object considered for copying; and
7. reject file/directory collisions.

Then it:

1. ingests main events;
2. computes held roots over the merged event set;
3. copies valid absent source objects whose exact CIDs are in those roots;
4. keeps the target `config.json` and target seed wrapping;
5. copies unknown portable paths only when absent;
6. imports allowed extension stores by the same rules; and
7. disposes extension stores the merged lifecycle says are purged.

`local/` is ignored and the target's local state is untouched.

Importing the same source repeatedly is a no-op after the first
successful union. A source containing bytes for a globally erased root
does not revive the erased message.

### 13.2 Restore into an empty backend

A restore accepts one valid version-3 snapshot and creates the portable
folder. It does not restore `local/`.

On first writable open, a new `replica_id` and `store_generation` are minted.
All historical event authors remain as written. Because mediation and
communication keys are vault-scoped, the new active runtime can derive and
resume them after unlock using ordinary account-scoped mediation and pickup.

### 13.3 Exact local move

Moving the complete directory, `local/` included, preserves current
replica identity and local caches. It is conforming only when the source
copy is no longer writable. Copying it and leaving both sides active is a
fork; later ingest detects previously unseen events under the shared
author.

## 14. Transfer and deferred synchronization boundary

The folder is never merged path-by-path between writable copies. In
particular, tools MUST NOT:

- copy event segments as opaque conflict resolution;
- use segment modification time as a cursor;
- merge `local/`;
- upload plaintext folders to an untrusted server; or
- overwrite an object without verifying its CID and profile.

Phase 1 transfers a vault by verified snapshot/export/import or an exact local
move. Deferred `vault-sync/1.0` may later exchange encrypted immutable root,
event and DASL objects without changing this folder format.

## 15. Concurrency and crash behavior

One writable folder generation requires one logical writer lock. Typical
implementations use:

- a Web Lock for browser OPFS; or
- one daemon/process lock for a disk folder.

Multiple readers are allowed if the backend can provide complete-line
visibility.

The writer lock or an equivalent backend transaction also forms the reference
commit/collection coordination domain. From object acceptance through event
commit, a pending-reference guard protects each to-be-referenced object. A
collector MUST hold an excluding lock through held-root snapshot and unlink, or
revalidate the event frontier and pending guards atomically before every
unlink. A fixed orphan grace period alone is insufficient.

Expected crash residue:

| crash point | permitted result |
| --- | --- |
| during object write | invalid temporary file is ignored or quarantined |
| after object, before event | valid unreferenced object orphan, later collectible |
| during one appended line | damaged final fragment, skipped and reported |
| during `appendAll` fresh-segment write | temporary or absent segment, never a partial accepted batch |
| after inbound event, before mediator ACK | redelivery; semantic duplicate after fold |
| after export, before archive completion | incomplete archive rejected on read |

A backend that claims power-loss durability MUST flush directory and file
metadata as required by its platform.

## 16. Versioning and boundaries

The folder version is the integer in `config.json`. A version-3 reader
MUST refuse every other version before writing or interpreting event
payloads. This specification requires no migration path.

Within version 3, unknown event types are preserved because their
envelopes are valid. Unknown top-level portable paths are preserved as
opaque files. Unknown members in structural JSON files or known event
types are not automatically forward-compatible; their defining
specification decides whether they are optional.

The following require a new folder/vault version:

- changing the event envelope;
- changing author or segment ID grammar;
- moving structural roots;
- changing anchor or key derivation;
- changing singleton merge meaning;
- adding a generic mutable portable-file merge rule; or
- making `local/` portable.

## 17. Required conformance cases

1. A newly created folder stores events under `events/<uuidv7>/`.
2. The path author and event `author` must match.
3. A portable snapshot contains no `local/` member.
4. Restoring a snapshot mints a new replica ID and store generation.
5. Moving the complete folder preserves them only when no old writer
   remains.
6. A malformed `local/replica.json` is rejected rather than partially
   repaired.
7. No replica-creation event is required on open.
8. `state/` has no reserved LWW behavior in version 3.
9. Every stored JSONL record excluding its LF is byte-equal to
   `canonicalEventBytes(event)`; merely compact non-canonical JSON is
   rejected or canonicalized before storage.
10. An incomplete JSONL fragment is skipped and not fused with the next
   append.
11. An ingest writes only decoded events, never copied source segments.
12. Physical segment order does not affect `scan()`.
13. An object filename/content mismatch or non-canonical DRISL encoding is damage.
14. Export from a database and re-import to a folder preserves the event
    set and portable bytes.
15. Unknown top-level portable files round-trip and are absent-only on
    merge.
16. An unknown entry inside a structural root is reported as damage.
17. Extension stores use the same local author but separate event-ID
    sets.
18. Import ignores source `local/` even when a nonconforming archive
    contains it.
19. At-rest plaintext message content is not described as protected by
    the vault passphrase.
20. No mediator or sync operation consumes the folder as plaintext.
21. A hosted full runtime can export an equivalent complete portable folder;
    server-local database state is not the sole recoverable copy.
22. A selected `did:web` document revision is retained as a referenced object
    and event, not as an authoritative mutable `did.json` path in the vault.
23. A thin-client cache is not accepted as a complete vault folder.
24. Historical author directories remain readable after restore or exact
    move; phase 1 defines no mediator-driven author retirement.
25. No persistent derived-key registry or key cache exists in `keystore.json`,
    `local/` or another vault path; an unlocked runtime derives keys by exact
    name from the seed.
26. Deferred vault sync is not presented as recovery material because it does
    not contain `seedJwe` or the seed.
27. Before recovery is marked complete, an independent seed or complete
    snapshot path is tested by deriving the exact anchor DID.
28. A large raw object is exported as one exact `objects/<cid>` byte stream
    even when the backend stores private extents.
29. No folder path exposes DAG-PB UnixFS metadata nodes, portable chunks or
    transport segments.
30. Collection does not retain or fetch a DRISL-linked object unless its CID is
    explicitly in the held-root set.
31. Phase 1 never sends `replica_id` to a mediator and does not require
    `vault-sync/1.0`.
32. Filename, digest and codec-specific validation completes before import or
    first entry into the owned `objects/` namespace; a later `open` follows the
    verified-stream completion rules in `dasl-objects.md` section 6.4.
33. A successful folder append or first object acceptance survives immediate
    process restart; sudden-power-loss safety remains a separately documented
    flush boundary.
34. Collection cannot unlink an object referenced by an event committed after
    the collector's initial held-root snapshot, nor one protected by a pending
    reference guard.
