# The `.estoc` folder, version 3

Status: **draft** — clean-break readable interchange format and reference
folder backend for the distributed Estoc vault.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

`event-store.md` defines the medium-independent event, blob and vault
interfaces. This document maps those interfaces to files. It defines no
event payload and never interprets `data`; event meanings and held-root
rules are `vault-events.md`'s.

The folder is both:

- the reference implementation of the store; and
- the human-readable interchange and backup format every other backend
  must render and read.

It is not the encrypted sync wire format. `vault-sync/1.0` deliberately
uses opaque encrypted objects instead.

## 1. Trust and portability

A portable Estoc vault is a directory containing `.estoc/`. A snapshot
is the portable part of that directory, commonly placed in a zip without
changing its internal paths.

The folder is designed for sovereignty rather than secrecy:

- events and ordinary blob blocks are readable plaintext;
- key names and identity metadata are readable;
- the vault seed is encrypted as `seedJwe`; and
- an encrypted backup wrapper, filesystem encryption or encrypted volume
  is outside this format.

A conforming application MUST state this boundary to the user. The
passphrase protects the ability to use the identity; by itself it does
not encrypt message history or attachments.

A `.estoc/` folder MUST NOT be uploaded as a mediator message or treated
as the `vault-sync/1.0` server representation.

A full vault runtime may use this format on an end-user machine or render it
from a server-side backend. A hosted implementation that holds the seed MUST
be able to export the complete portable vault in this format; its internal
database MUST NOT be the only recoverable representation.

Selected `did:web` document revisions are ordinary referenced blobs and
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
- JSONL segments use one compact UTF-8 JSON object per line;
- every complete JSONL record ends in `\n`; and
- blob files contain exact block bytes and have no text encoding.

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

  blobs/
    <cid>

  extensions/
    <ext>/
      events/
        <author>/
          <segment>.jsonl
      blobs/
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
blobs/
extensions/
local/
```

A malformed entry inside `events/`, `blobs/`, `extensions/` or `local/`
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
- used to decide whether a portable event or blob exists.

Deleting all of `local/` converts a folder into a portable copy. The next
writable open creates a new replica ID and store generation.

### 3.2 Extension stores

`extensions/<ext>/` serializes one extension event/blob store. `<ext>` is
a canonical UUIDv7 minted by `extension.installed`.

An extension directory contains only:

```text
events/<author>/<segment>.jsonl
blobs/<cid>
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

`keystore.json` is the portable representation of `@estoc/keystore` v3.
It contains:

- one passphrase-encrypted `seedJwe`; and
- a rebuildable cache of minted asymmetric key names.

A representative shape is:

```json
{
  "version": 3,
  "seedJwe": {
    "protected": "...",
    "iv": "...",
    "ciphertext": "...",
    "tag": "..."
  },
  "keys": [
    {
      "name": "anchor",
      "did": "did:key:z6Mk...",
      "createdAt": "2026-09-03T15:04:05.123Z"
    },
    {
      "name": "did/019b2a45-8381-793f-943c-f5d806fd5ca2/authentication/0",
      "did": "did:key:z6Mk...",
      "createdAt": "2026-09-03T15:05:00.000Z"
    },
    {
      "name": "did/019b2a45-8381-793f-943c-f5d806fd5ca2/key-agreement/0",
      "did": "did:key:z6LS...",
      "createdAt": "2026-09-03T15:05:00.000Z"
    }
  ]
}
```

The exact JWE fields and key-cache entry shape are owned by
`@estoc/keystore` v3. The folder reader MUST validate that shape before a
write-producing import.

The cache is not authority for whether a key belongs to the vault.
`vault-events.md` and the fixed reserved derivations are. On unlock, a
client MAY rebuild `keys` from:

- `anchor`;
- every `mediation.created.data.me.key`;
- every key name in `did.created`, `did.keyGenerationAdded` and the
  currently supported DID key-generation profile; and
- protocol-reserved key names such as the vault-sync account.

### 5.1 Import policy

For an import into an existing unlocked vault:

- the target's `seedJwe` is retained;
- the source seed, when unlocked, MUST derive the same anchor;
- `keys` is unioned by `name`;
- two entries with one name and different derived public keys are a
  fatal keystore conflict; and
- missing cache entries MAY be rebuilt rather than copied.

The local passphrase may differ between replicas. Equal vault identity
does not require byte-equal `seedJwe`.

### 5.2 Sync bootstrap

`vault-sync/1.0` does not upload `seedJwe`. A user bootstrapping from the
sync store supplies the vault seed by another trusted means and creates a
new local passphrase wrapping. The key cache is then rebuilt.

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

A reader decodes each complete JSONL line and validates the full event
envelope under `event-store.md`. It then requires the path author to
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
blobs/**
extensions/**
local/**
```

`FileStore.write` MUST refuse to create or overwrite a path in these
owned trees except through the operation that owns it.

### 7.2 No generic synchronized mutable state

Version 3 has no generic `state/` directory and no timestamp-based
file-level merge rule.

Correctness-critical state that must converge across replicas is an
event or referenced blob. High-churn state that belongs only to one
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
or, preferably, use events and blobs.

## 8. Segments

A segment is:

```text
<segment>.jsonl
```

where `<segment>` is a canonical lowercase UUIDv7.

Each complete line is one entire event followed by `\n`. A segment has
no header and no semantic metadata. Segment name, order, size and
boundary are not part of any event's identity.

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
decoded, deduplicated by `eid` and reserialized. Therefore the target may
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

## 9. Blob paths

Each block is one file:

```text
blobs/<cid>
```

or, for an extension:

```text
extensions/<ext>/blobs/<cid>
```

The filename is the canonical CIDv1 of the exact file bytes under the
`unixfs-v1-2025` profile:

- lowercase base32;
- sha2-256;
- codec `raw` or `dag-pb`.

The directory is flat. A backend may shard internally but MUST export
flat paths.

A block file is immutable by content. Repeating `put` for an existing
valid block MAY rewrite the same bytes solely to renew the local orphan
age used by collection.

A reader MUST verify filename against bytes before accepting a block. A
mismatch, invalid CID or invalid dag-pb profile node is damage. The
backend SHOULD move it out of the owned `blobs/` namespace before
continuing, so ordinary presence checks treat it as absent.

Writers store leaves before parents and blocks before an event reference.
A crash may leave unreferenced blocks. Collection later removes only
unreachable blocks older than the configured grace.

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

- `replica_id` is the event author and mediator pickup/ACK scope.
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

If the local `replica_id` is the target of a converged
`replica.retired` event, a conforming client MUST stop using it for new
appends and pickup, mint a new `replica_id` and `store_generation`, and
reopen. Historical events remain unchanged.

### 10.2 Owner directories

Each local owner may keep:

```text
options.json  non-rebuildable local configuration
cache/        rebuildable indexes and fold projections
trace/        local event-like diagnostic streams with explicit retention
```

The application owner is `local/agent/`. Extension owners use
`local/extensions/<ext>/`.

These directories have no portable merge semantics. A trace may use the
same six-field JSON shape for convenience, but it is not in the vault's
event set and may be pruned according to local retention.

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

When the append promise resolves, the event line is complete and visible
after a process restart. Whether it survives sudden power loss depends on
the backend's documented flush policy.

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
portable paths, but MUST NOT return event segments, blob blocks or
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
- every retained main block under `blobs/<cid>`;
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
6. validate every source block considered for copying; and
7. reject file/directory collisions.

Then it:

1. ingests main events;
2. computes held roots over the merged event set;
3. copies valid absent source blocks reachable from those roots;
4. keeps the target `config.json` and target seed wrapping;
5. unions the rebuildable key cache;
6. copies unknown portable paths only when absent;
7. imports allowed extension stores by the same rules; and
8. disposes extension stores the merged lifecycle says are purged.

`local/` is ignored and the target's local state is untouched.

Importing the same source repeatedly is a no-op after the first
successful union. A source containing bytes for a globally erased root
does not revive the erased message.

### 13.2 Restore into an empty backend

A restore accepts one valid version-3 snapshot and creates the portable
folder. It does not restore `local/`.

On first writable open, a new `replica_id` and `store_generation` are
minted. All historical event authors remain as written. Because mediation
and communication keys are vault-scoped, the new replica can derive and
resume them after unlock.

### 13.3 Exact local move

Moving the complete directory, `local/` included, preserves current
replica identity and local caches. It is conforming only when the source
copy is no longer writable. Copying it and leaving both sides active is a
fork; later ingest detects previously unseen events under the shared
author.

## 14. Synchronization boundary

The folder is not synchronized path-by-path. In particular, clients MUST
NOT:

- copy event segments as files between active replicas;
- use segment modification time as a cursor;
- merge `local/`;
- upload plaintext folders to a sync store; or
- overwrite a block without verifying its CID.

`vault-sync/1.0` exchanges encrypted immutable root, event and block
objects. A local sync client decodes them and calls the store interfaces.
Its correctness does not depend on segment layout.

## 15. Concurrency and crash behavior

One writable folder generation requires one logical writer lock. Typical
implementations use:

- a Web Lock for browser OPFS; or
- one daemon/process lock for a disk folder.

Multiple readers are allowed if the backend can provide complete-line
visibility.

Expected crash residue:

| crash point | permitted result |
| --- | --- |
| during blob write | invalid temporary file is ignored or quarantined |
| after block, before event | valid unreferenced orphan, later collectible |
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
9. An incomplete JSONL fragment is skipped and not fused with the next
   append.
10. An ingest writes only decoded events, never copied source segments.
11. Physical segment order does not affect `scan()`.
12. A blob filename/content mismatch is damage.
13. Export from a database and re-import to a folder preserves the event
    set and portable bytes.
14. Unknown top-level portable files round-trip and are absent-only on
    merge.
15. An unknown entry inside a structural root is reported as damage.
16. Extension stores use the same local author but separate event-ID
    sets.
17. Import ignores source `local/` even when a nonconforming archive
    contains it.
18. At-rest plaintext message content is not described as protected by
    the vault passphrase.
19. No mediator or sync operation consumes the folder as plaintext.
20. A hosted full runtime can export an equivalent complete portable folder;
    server-local database state is not the sole recoverable copy.
21. A selected `did:web` document revision is retained as a referenced blob
    and event, not as an authoritative mutable `did.json` path in the vault.
22. A thin-client cache is not accepted as a complete vault folder.
23. A retired replica's historical author directory remains readable.
