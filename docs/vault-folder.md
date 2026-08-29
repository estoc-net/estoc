# The `.estoc` folder, version 2 — draft

Status: **draft**, 2026-08-29. Not implemented; nothing writes it yet.
Version 1 (`vault-format.md`) stays the contract until this document is
frozen. There is no migration: a version-2 reader refuses a version-1
folder (§10), and a version-1 vault is used by a version-1 reader or
started over.

The second of three documents. `event-store.md` says what a vault is to
a program — the event, the store, exchange. This document is that store
spelled as files: the tree, the mapping between a path and an event's
fields in both directions, and how the reference store reads, appends
and merges on a file system. It is also the **exchange form**: what a
backup is, what any store must be able to render and read
(`event-store.md` §7). It defines no event type and reads no payload;
the types it carries are `vault-events.md`'s.

## 0. On disk, what changes

Version 1 kept three kinds of file — records, logs, singletons — and let
a record (`contacts/<cid>.json`) be the truth about who a message
belongs to. Version 2 keeps logs, singletons, and content-addressed
blobs; nothing is a record. Every log lives under the device that
authored it, so another copy of the vault is merged by copying
directories. What is this copy's alone — which device it is, its caches,
its traces — lives under `local/` and is never in a backup. A log line
carries a message's skeleton; its body is a blob beside it, and erasing
is unlinking blobs, never log lines. Message logs are partitioned by
key pairs, not by contact, and key names carry no contact.

## 1. What a vault is

Unchanged from v1 §1: a directory, `.estoc/` is the machine's half, a
backup is the zip.

## 2. Rules of the folder

The principles of `event-store.md` §2 as they land on a file system.

1. **Three kinds of file, none of them a record.** A **log** — events,
   append-only JSONL in segments, merged by union; a **singleton** — one
   per vault, kept by its own policy on merge (§6); a **blob** — bytes
   named by their hash, merged by union, the only kind ever unlinked
   (§7).
2. **Every event under `devices/<dev>/` was authored by device `dev`.**
   The directory and the line's `author` field say the same thing, and
   a reader refuses a line where they differ. A device appends only to
   segments it minted, under its own directory. A segment is edited or
   truncated by nobody but its writer. A merge may *add* segments under
   any device's directory, holding only that device's events (§8.3):
   under `devices/x/` there may be a segment `x` wrote and one this
   vault minted from what `x` wrote, and a reader unions them by `eid`.
   Two same-named segments that are not prefix-related are two writers
   sharing one `dev` (§11).
3. **Nothing under `devices/` is ever unlinked.** Not a line, not a
   segment, not a directory. The only thing ever unlinked is a blob —
   and, under `local/`, what was never part of the vault.
4. **A path is a locator and nothing more.** Every directory level is
   one field of the event's locator (§4); a segment name says nothing
   about the events in it (§5); no name encodes whose anything is. Path
   rules as v1 §3.

## 3. Layout

```
.estoc/
  config.json                                singleton — format/version, anchor; immutable
  keystore.json                              singleton — @estoc/keystore v3, unchanged
  blobs/<hash>                               content-addressed bytes — message bodies, attachments; global; the one place anything is unlinked
  devices/<dev>/                             everything device <dev> wrote
    me/<seg>.jsonl                           scope me       — that this device exists; its decisions about the identity; what its mediator answered
    contacts/<cid>/<seg>.jsonl               scope contact  — decisions about one contact
    parts/<myKey>/<peerKey>/<seg>.jsonl      scope part     — observations in one partition: skeletons, deliveries, resolutions
  state/                                     reserved, as v1 §6.7
  local/                                     this copy's own; never in a snapshot, never merged; §6.4
    self.json                                which <dev> this copy writes as
    options.json                             device options: trace retention
    cache/                                   rebuildable folds
    trace/<stream>/<seg>.jsonl               device observations with retention; as v1 §6.10
```

Gone from v1: `contacts/<cid>.json`, `invitations/`, `messages/`,
`deliveries/`, `config.mediation`, and top-level `cache/` and `trace/`
(moved under `local/`). Gone from the draft before this: a per-device
`device.json`; a device announces itself with an event
(`vault-events.md` §5).

## 4. Folder ↔ store

The tree is the locator of `event-store.md` §3, spelled as a path. Two
pure functions:

```
locate(event)          → "devices/<author>/me/"
                       | "devices/<author>/contacts/<cid>/"
                       | "devices/<author>/parts/<myKey>/<peerKey>/"

place(path, line)      → event      (the path gives the locator; the line gives the rest)
```

`locate` is store → folder: where an event is written, and where an
export renders it. `place` is folder → store: what a line under a path
*is*. Everything else in this document is built from these two.

- **On disk, the line omits the locator below `author`.** A line under
  `devices/k7q3ma/parts/did/0198…/abc…/` does not repeat `scope`,
  `myKey`, `peerKey`; `place` reinjects them. It does carry `author`:
  six characters, the one field a line must be able to say for itself
  once it is apart from its path (in a report, a grep, a copy), and the
  one that checks the path (rule 2). So a line is
  `{ eid, author, at, type, ...payload }`, and the examples in
  `vault-events.md` are lines.
- **The rest of the locator is recoverable from the path alone.**
  `myKey` is a key name and has slashes of its own (`did/0198…`,
  `mediation/0198…/me`); `peerKey` is always the last directory under
  `parts/`, and everything between `parts/` and it is `myKey`.
- **In memory, the event is whole.** Anything above the folder store
  sees the full object and never a path.
- **The mapping is total and injective on locators.** Every valid
  locator has exactly one directory, and every directory under
  `devices/<author>/` that holds segments parses to exactly one
  locator. A directory that does not parse is not part of the event
  set; a reader reports it and carries it (§11), as v1 §8 does with
  unknown paths.
- **A segment is not part of an event's identity** (§5).

## 5. Segments

`<seg>` is a uuidv7; a segment is `<seg>.jsonl`, one event per line,
under the directory `locate` gives.

- **The writer's segments.** A device appends to the newest segment it
  minted under a directory, or mints a fresh one; rotation is the
  writer's own policy. A first append heals a segment that does not end
  in a newline by terminating the fragment before writing; the fragment
  is a damaged line (§8.5).
- **The importer's segments.** A merge that brings in another device's
  events writes them into a segment *this* vault mints under that
  device's directory (rule 2, §8.3) — never into a segment the device
  wrote, never into one a previous import wrote. Such a segment holds
  its events in the order they came, which is no order at all.
- **No segment is assumed ordered.** `at` is a wall clock and steps
  back; an importer's segment is in arrival order. A reader collects
  and sorts (§8.1); it never merges segments as sorted streams.
- **A segment says nothing about the event in it**, and a program never
  sees one. It is part of the *folder's* state: the merge works by
  segment, so a segment is assigned once and grows only at its end
  (rule 2). A store that is not a folder has to remember which segment
  each event would be rendered into (`event-store.md` §7.2), for the
  same reason.
- **A log's segments are the union** of `devices/*/<log path>/<seg>.jsonl`
  across every device, and a reader unions them by `eid`.

## 6. Singletons

Each singleton states its own merge policy here; `event-store.md` §7.3
applies them in the order events → blobs → files.

### 6.1 `config.json`

```jsonc
{
  "format": "estoc",
  "version": 2,
  "identity": { "anchor": { "key": "anchor", "did": "did:key:z6Mk…" } }
}
```

Only what was fixed the moment the vault was created, and never
changes: the format, and the anchor that says which identity this is.
Nothing a person can edit lives here (v1's `label` is an event,
`vault-events.md` §5). Merge: must be identical on both sides — the
anchor check is what makes it a merge at all (v1 §7); a differing
`version` is refused (§10). Restore writes it last.

### 6.2 `keystore.json`

As v1 §6.2: `@estoc/keystore` v3, and `keys[]` stays a cache. Merge:
union of `keys[]`. Rebuildable regardless from every device's `me/`
(`vault-events.md` §2).

### 6.3 `state/`

Reserved, as v1 §6.7; merged as there.

### 6.4 `local/` — this copy's own

Everything that is true of *this copy on this machine* and of nothing
else. Never in a snapshot, never merged, never read by another device.

```jsonc
// local/self.json
{ "dev": "k7q3ma" }
// local/options.json — shape owned by the implementation; e.g.
{ "trace": { "wire": { "keep": "P30D", "cap": 33554432 } } }
```

- `self.json` is the pointer every write, every merge, and every fold
  that depends on the asking device needs: which `devices/<dev>/` is
  mine; it is `self` on the store (`event-store.md` §5). Missing means
  "first open on this copy": mint a `dev` (`event-store.md` §4), write
  it, append `device.minted` under `devices/<dev>/me/`
  (`vault-events.md` §5), go on.
- `options.json` holds device options — v1 §6.10 said a retention
  policy is never written into the vault; `local/` is not the vault in
  the sense that matters (it is not what a backup carries), so the
  policy has a file without becoming a fact.
- `cache/` holds folds with the change token each was folded to
  (`event-store.md` §7.4). Deleting it is always safe.
- `trace/` as v1 §6.10: this device's, not rebuildable, not exchanged.
- Two processes sharing one `local/` share one `dev` and must serialise
  as v1 §9 requires (Web Lock, file lock).

Any other path a reader meets and does not understand is carried, never
read, never overwritten (§11).

## 7. Blobs — `blobs/<hash>`

`hash` = sha256 of the bytes, lowercase hex; sharded
`blobs/<hash[0:2]>/<hash>` on backends that want it. Immutable, merged
by union, deduplicated by construction, and the one directory outside
`devices/` that every device writes to — safely, because a content
address has no author.

A blob is written **before** the line that names it (`event-store.md`
§6); a crash between the two leaves an orphan, harmless, swept by the
next collection. What a blob's absence means — erased, or missing — is
read from the events (`vault-events.md` §8.2); the folder only reports
that it is not there.

## 8. The folder store

The reference `EventStore`, over `VaultBackend`, the bytes interface
that exists today (read, write, append, remove, size, list, dirs). It
knows the tree; nothing above it does.

### 8.1 Reading

`scan(filter)` walks the directories `locate` would produce for the
filter (a fully specified locator is one directory; a partial one is a
`walk` from the deepest fixed prefix), reads every `<seg>.jsonl`, parses
each line, reinjects the locator from the path (`place`), refuses a
line whose `author` is not its directory (rule 2), skips damaged lines
into `damaged()`, collects, dedups by `eid` (§8.5), sorts into canonical
order (`event-store.md` §4), and yields.

### 8.2 Appending

Per directory, as `SegmentedLog` today: the line goes to the newest
segment this store minted under `locate(event)` (which is under
`devices/<self>/`), or a fresh `<uuidv7>.jsonl`, healing a fragment
first (§5). Appends are serialised per store instance, because
`VaultBackend.append` is size-then-write. The line written is the event
minus its locator below `author` (§4). Whole-line durability across a
process crash is what the backend gives; neither Node `fs` nor OPFS
`fsync`s on append today (`event-store.md` §5.1).

### 8.3 Ingesting

For each incoming event: validate; if the `eid` is already under
`devices/<author>/`, compare and count it duplicate or conflict;
otherwise append the line to a segment under `locate(event)` that
**this store minted for this `ingest` call** (§5). So a merged folder
may hold, under `devices/x/parts/…/`, both `0198…a.jsonl` written by
`x` and `0198…b.jsonl` written here from what `x` wrote. Both contain
only events authored by `x`; readers union by `eid`, so nothing is
doubled.

**Fast path.** When the source is itself a folder (a backup zip, another
`.estoc/` directory), the store may copy whole segments instead:

- `devices/<x>/` for every `x` not present here: copied whole;
- `devices/<x>/` present on both sides: any missing segment copied;
  for two segments sharing a name, one must be a prefix of the other
  (rule 2) and the longer is kept. A pair that is neither is two
  writers sharing one `dev`: the import stops and reports it rather
  than choosing;
- `devices/<self>/` (`self` from `local/self.json`) is never touched
  by an import.

This is only an optimisation of `ingest`: the event set that results is
the same as ingesting line by line. The copy does not read what it
copies, so a conflict it brings in — one `eid`, two contents — is met by
the next reader (§8.5) rather than by the import; a store that only ever
ingests through the interface is conformant and reports it at import
instead.

### 8.4 Changes

The token is the store's segment table: every `<seg>.jsonl` under
`devices/*/`, by path, with its byte length, taken when `changes` is
called (one walk, one `size` per segment). `events` reads each segment
from the length `since` names for it (zero if `since` does not name it)
to the length `token` names, in path order and then file order, and
`place`s every whole line; a segment `since` names that is now shorter
or absent is a token this store did not issue, and the call is
rejected. Because a segment only grows and is only ever appended to by
one writer, the bytes between two lengths are exactly the lines that
arrived between the two calls.

### 8.5 Damage and conflict

A **damaged line** is bytes in a segment that do not parse as a JSON
object, or parse to one that fails the envelope (`event-store.md` §3
rule 3): a fragment from a crash, an edit, a line whose `author` is not
its directory. Reported as `DamagedLine` (where, the text, the error),
never stored, never counted, never fused with the next line.

A **conflict** is one `eid` with two contents, which a folder can come
to hold through the fast path. The reader keeps the line from the
segment whose path sorts first, and within a segment the first; yields
that one; reports the others in `conflicting()`. The rule exists so that
every reader of one folder agrees; it is not a judgement about which is
right.

### 8.6 The rest

`Files` is the backend's read/write/list over every path in the
snapshot that is not under `devices/*/` or `blobs/`. `local/` is the
folder store's own (self, options, cache, trace) and is neither an
event nor a file in this sense: it is never listed, never exported.

## 9. Snapshot, export, import

### 9.1 Snapshot

Everything under `.estoc/` except `local/`. A folder store's snapshot
is a copy; the zip a backup carries is this tree.

### 9.2 Export

A store that is not a folder renders one: each event to
`locate(event)/<seg>.jsonl`, where `<seg>` is the segment the store
assigned it, minus its locator below `author`, one line each, in the
order they arrived within the segment; blobs to `blobs/<hash>`; every
path in `Files` in place; no `local/`. Because a segment is assigned
once and grows only at its end, two exports of one store are
prefix-related file by file, which is what §8.3 requires of two copies
of one device (`event-store.md` §7.2).

### 9.3 Import

Three kinds of thing, in this order (`event-store.md` §7.3):

1. **Events.** `place` every line of every segment under `devices/*/`
   and `ingest` the result, or take the fast path of §8.3. A device
   directory that arrives without its `device.minted` is read — its
   events are still that device's — and reported as incomplete.
2. **Blobs**, after the events: a blob absent here and present there
   is copied iff it is not collectable over the merged event set
   (`vault-events.md` §8.3). An erased blob never comes back.
3. **Files**, each by its own policy (§6): `config.json` identical or
   refused; `keystore.json` unioned; `state/` as v1; any other path
   copied when absent, never overwritten; `local/` is not in the
   snapshot and is not touched.

### 9.4 Restore

Import into an empty backend, `config.json` written last. There is no
`local/`, so the first open mints a `dev` (§6.4) and the imported
directories stay as history — including the old device's mediation,
visible until the person retires it (`vault-events.md` §7.3). What the
application then does with the merged set — `held` on every outbound
not `sent` — is `vault-events.md` §10.

## 10. Version 1

There is no migration. A version-2 reader that opens a directory whose
`config.version` is 1 refuses it and says so: nothing is read past
`config.json`, nothing is written, nothing is renamed. A version-1 vault
is used by a version-1 reader or started over. Which v1 key names no
longer exist is `vault-events.md` §11.

## 11. Versioning, robustness, boundaries

As v1 §8–§10, with `config.version` = 2. Unknown paths are carried, not
read, and never overwritten. One writer per device directory (rule 2)
replaces "one writer per vault" as the format-level rule; the
application still serialises writers on one directory. Two processes
sharing one `dev` is a bug, not a merge: it shows up as non-prefix
segments (§8.3), one `eid` with two contents (§8.5), or a second
`device.minted` under one `dev` (`vault-events.md` §5), and the remedy
is for one of them to mint its own.

A backup is still a move, not a sync, but the folder no longer stands
in the way of one: a sync is "copy the other devices' directories and
the blobs they reference", and nothing here should have to change for
it. What a deletion leaves on disk, and why, is `vault-events.md` §10.

## 12. Open

- **Ingest segment granularity.** One segment per directory per
  `ingest` call (§8.3) means many small merges leave many small files.
  Compacting a store's own ingest segments would be the obvious answer
  and is forbidden as rule 3 is worded; whether the rule should
  distinguish a segment the store minted for ingest from one a device
  wrote is a question for when the file count is felt.
- **`fsync`** (§8.2): whether `FsBackend` should sync per append so the
  daemon can claim power-loss durability.
- **Sharding** `blobs/` (§7): a backend's choice today; whether the
  exchange form should fix one layout so a zip is readable without
  probing.
