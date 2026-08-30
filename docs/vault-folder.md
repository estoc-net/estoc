# The `.estoc` folder, version 2 — draft

Status: **draft**, 2026-08-29. Not implemented; nothing writes it yet.
Version 1 (`vault-format.md`) stays the contract until this document is
frozen. There is no migration: a version-2 reader refuses a version-1
folder (§10), and a version-1 vault is used by a version-1 reader or
started over.

The second of three documents. `event-store.md` says what a vault is to
a program — the event, the store, interchange. This document is that store
spelled as files: one log per device, the mapping between a path and an
event in both directions (which is short), and how the reference store
reads, appends and merges on a file system. It is also the
**interchange format**: what a backup is, what any store must be able to render and
read (`event-store.md` §7). It defines no event type and never reads
`data`; the types it carries are `vault-events.md`'s.

## 0. On disk, what changes

Version 1 kept three kinds of file — records, logs, singletons — and let
a record (`contacts/<cid>.json`) be the truth about who a message
belongs to. Version 2 keeps logs, singletons, and content-addressed
blobs; nothing is a record. There is one log per device, under the
device that wrote it; a merge is one pass that reads another copy and
appends what is new, under the device that wrote it; what an event is
about is in the line's `data`, not in a path.
What is this copy's alone — which device it is, its caches, its traces
— lives under `local/` and is never in a backup. A log line carries a
message's skeleton; its body is a blob beside it, and erasing is
unlinking blobs, never log lines.

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
   A merge never copies a segment: it reads the other copy's lines and
   appends the ones it lacks.
3. **Nothing under `devices/` is ever unlinked.** Not a line, not a
   segment, not a directory. The only thing ever unlinked is a blob —
   and, under `local/`, what was never part of the vault.
4. **A path says the author and nothing more.** What an event is about
   is a field of the line's `data` (`event-store.md` §3); a segment name says
   nothing about the events in it (§5); no name encodes whose anything
   is. Path rules as v1 §3.

## 3. Layout

```
.estoc/
  config.json                                singleton — format/version, anchor; immutable
  keystore.json                              singleton — @estoc/keystore v3, unchanged
  blobs/<hash>                               content-addressed bytes — message bodies, attachments; global; the one place anything is unlinked
  devices/<dev>/<seg>.jsonl                  everything device <dev> wrote: one log, every event a line
  state/                                     reserved, as v1 §6.7
  local/                                     this copy's own; never in a snapshot, never merged; §6.4
    self.json                                which <dev> this copy writes as
    options.json                             device options: trace retention
    cache/                                   rebuildable folds
    trace/<stream>/<seg>.jsonl               device observations with retention; as v1 §6.10
```

Gone from v1: `contacts/<cid>.json`, `invitations/`, `messages/`,
`deliveries/`, `config.mediation`, and top-level `cache/` and `trace/`
(moved under `local/`). There is no per-device file (a device
announces itself with an event, `vault-events.md` §5) and no directory
per contact or per channel: what an event is about is a field of its
`data`, and a reader reads the whole log anyway (§8.1).

## 4. Folder ↔ store

```
locate(event)          → "devices/<author>/"
decodeEvent(path, line) → the event, with its envelope validated and line.author checked against <dev> in path
```

`locate` is store → folder: where an event is written, and where an
export renders it. `decodeEvent` is folder → store: what a line under
a path *is* — parsed, its envelope checked (`event-store.md` §3 rule
3), its `author` held against the directory. There is nothing else to
map:

- **The line is the event.** One JSON object per line — the envelope
  and `data`, nothing elided and nothing reinjected. A line apart from
  its path — in a report, a grep, a copy — says everything about
  itself, including who wrote it.
- **The path checks the line.** A line whose `author` is not the `dev`
  of the directory it sits in is refused as damaged (§8.5); the
  directory never supplies the author, it confirms it.
- **Every directory under `devices/` that holds segments is a device.**
  A name that is not a device id (six lowercase base32 characters,
  `event-store.md` §4), or anything under it that is not a segment, is
  not part of the event set; it is a file (§8.6), carried as v1 §8
  carries unknown paths.
- **A segment is not part of an event's identity** (§5).

The mapping is this short on purpose. A directory per subject — per
contact, per channel — would serve no reader (§8.1) and no merge
(§8.3), and would cost a segment per channel per device on every
merge (§12).

## 5. Segments

`<seg>` is a uuidv7; a segment is `<seg>.jsonl`, one event per line,
under `devices/<author>/`.

- **The writer's segments.** A device appends to the newest segment it
  minted, or mints a fresh one; rotation is the writer's own policy. A
  first append heals a segment that does not end in a newline by
  terminating the fragment before writing; the fragment is a damaged
  line (§8.5).
- **The importer's segments.** A merge that brings in another device's
  events writes them into a segment *this* vault mints under that
  device's directory (rule 2, §8.3) — never into a segment the device
  wrote, never into one a previous import wrote. Such a segment holds
  its events in the order they came, which is no order at all.
- **No segment is assumed ordered.** `at` is a wall clock and steps
  back; an importer's segment is in arrival order. A reader collects
  and sorts (§8.1); it never merges segments as sorted streams.
- **A segment says nothing about the event in it**, and a program never
  sees one. It is not state: a merge reads lines, never segments
  (§8.3), so how a writer chunks its log is its own affair, and an
  export may chunk an author's events differently every time (§9.2).
  A reader unions by `eid` whatever the chunking.
- **A device's log is the union** of its segments, wherever they were
  minted, and a reader unions them by `eid`.

## 6. Singletons

To the store these are files (`FileStore`, `event-store.md` §6); a
singleton is a file that is one per vault and has a merge policy of
its own. Each states that policy here; `event-store.md` §7.3 applies
them in the order events → blobs → files.

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
union of `keys[]`. Rebuildable regardless from every device's log
(`vault-events.md` §2).

### 6.3 `state/`

Reserved, as v1 §6.7; merged as there.

### 6.4 `local/` — this copy's own

Everything that is true of *this copy on this machine* and of nothing
else. Never in a snapshot, never merged, never read by another device.

```jsonc
// local/self.json
{ "dev": "k7q3ma", "instance": "01991c2e-…" }
// local/options.json — shape owned by the implementation; e.g.
{ "trace": { "wire": { "keep": "P30D", "cap": 33554432 } } }
```

- `self.json` is the pointer every write, every merge, and every fold
  that depends on the asking device needs: which `devices/<dev>/` is
  mine; it is `self` on the store (`event-store.md` §5). `instance` is
  minted with it — a random id, a uuid will do — and is what this
  store's change tokens name (§8.4), so a cache folded under another
  device, or under this device before a restore re-minted it, is
  rejected rather than applied. Missing means "first open on this
  copy": mint both (`event-store.md` §4), write the file, go on. Then,
  on **every** open, not only the first: if `devices/<dev>/` holds no
  `device.minted` (`vault-events.md` §5), append one. A crash between
  writing `self.json` and the first append leaves exactly that gap,
  and the check is idempotent.
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

`hash` = sha256 of the bytes, lowercase hex; one flat directory,
always: the interchange format has one layout, so a zip is readable without
probing. A backend that wants sharding does it below `VaultBackend`
and renders flat. Immutable, merged by union, deduplicated by
construction, and the one directory outside `devices/` that every
device writes to — safely, because a content address has no author.
The store names a blob by hashing its bytes (`event-store.md` §6);
a blob's name is checked against its bytes on import (§9.3), and a
mismatch is damage, not copied.

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

`scan(filter)` reads every segment under `devices/*/` — under
`devices/<author>/` alone when the filter names an author — parses
each line, checks its `author` against the directory (rule 2), skips
damaged lines into `damaged()`, dedups by `eid` (§8.5), keeps the lines
whose fields equal the filter's, sorts into canonical order
(`event-store.md` §4), and yields. There is no reading less than a
device's whole log; a filter narrows the answer, not the work.

### 8.2 Appending

As `SegmentedLog` today: the line goes to the newest segment this store
minted under `devices/<self>/`, or a fresh `<uuidv7>.jsonl`, healing a
fragment first (§5). Appends are serialised per store instance, because
`VaultBackend.append` is size-then-write. The line written is the event,
whole (§4). Whole-line durability across a process crash is what the
backend gives; neither Node `fs` nor OPFS `fsync`s on append today
(`event-store.md` §5.1).

### 8.3 Ingesting

One pass, reading first. The store reads its input whole and, before
writing anything, checks every incoming event whose `author` is `self`
(`local/self.json`): one already here with the same content is a
duplicate; one not here, or here with other content, stops the call
with nothing written and is reported as a forked self
(`event-store.md` §5.2) — two writers have shared this `dev`, and the
remedy is to mint a fresh one (§6.4) and import again.

Then, for each incoming event: validate; if the `eid` is already under
`devices/<author>/`, compare (`event-store.md` §3) and count it
duplicate or conflict; otherwise append the line to a segment under
`devices/<author>/` that **this store minted for this `ingest` call**
(§5): one segment per author per call. So a merged folder may hold,
under `devices/x/`, both `0198…a.jsonl` written by `x` and
`0198…b.jsonl` written here from what `x` wrote. Both contain only
events authored by `x`; readers union by `eid`, so nothing is doubled.

**There is no file-level shortcut.** An earlier draft let an import
copy whole segments when the source was itself a folder — a device
directory absent here, a segment absent here, the longer of two
prefix-related segments — and it is withdrawn. A copied segment is not
read, so it could carry an `eid` already ingested here by another
route; the reader's tie-break (§8.5) could then prefer the copy over
what this store had, which `ingest` promises never to do; and `changes`
(§8.4) would replay bytes that were not new. What the copy saved was a
parse of the other copy, which `scan` pays on every open. The one copy
that remains is a restore into an empty backend (§9.4).

### 8.4 Changes

The token is the store's `instance` (§6.4) and its segment table:
every `<seg>.jsonl` under `devices/*/`, by path, with its byte length,
taken when `changes` is called (one walk, one `size` per segment).
`events` reads each segment from the length `since` names for it (zero
if `since` does not name it) to the length `token` names, in path order
and then file order, and decodes every whole line (§4). A token naming
another instance, or a segment that is now shorter or absent, is one
this store did not issue, and the call is rejected. Because a segment
only grows, is appended to by one writer, and every line under
`devices/` was either appended by `self` or ingested after a check
against everything here (§8.3), the bytes between two lengths are
exactly the events that arrived between the two calls, and none of
them was already here.

### 8.5 Damage and conflict

A **damaged line** is bytes in a segment that do not parse as a JSON
object, or parse to one that fails the envelope (`event-store.md` §3
rule 3): a fragment from a crash, an edit, a line whose `author` is not
its directory. Reported as `DamagedLine` (where, the text, the error),
never stored, never counted, never fused with the next line.

A **conflict** is one `eid` with two contents, which a folder comes to
hold only by hand — a segment dropped in with a file manager, an edit
— never through the store, which checks before it writes (§8.3). The
reader keeps the line from the segment whose path sorts first, and
within a segment the first; yields that one; reports the others in
`conflicting()`. The rule exists so that every reader of one folder
agrees, and so that a hand-merged folder is still readable; it is not
a judgement about which is right.

### 8.6 The rest

`FileStore` is the backend's read/write/list over every path in the
snapshot that is not a segment or a blob — not
`devices/<dev>/<seg>.jsonl` with `dev` a device id and `seg` a uuidv7,
not `blobs/<hash>` with `hash` sixty-four lowercase hex characters.
The test is the shape of the path, not its prefix: a path under
`devices/` or `blobs/` that is not shaped like that is a file, carried
and never read, so that it survives a trip through a store that is not
a folder (§11). `local/` is the folder store's own (self, options,
cache, trace) and is neither an event nor a file in this sense: it is
never listed, never exported.

## 9. Snapshot, export, import

### 9.1 Snapshot

Everything under `.estoc/` except `local/`. A folder store's snapshot
is a copy; the zip a backup carries is this tree.

### 9.2 Export

A store that is not a folder renders one: each event to
`devices/<author>/<seg>.jsonl`, in segments the export mints as it
goes — one per author is enough, in any order — one line each; blobs
to `blobs/<hash>`, flat; every path in `FileStore` in place; no `local/`.
Nothing about the chunking is remembered: a reader of the export unions
by `eid` and assumes no order (§5, `event-store.md` §7.2).

### 9.3 Import

Three kinds of thing, in this order (`event-store.md` §7.3):

1. **Events.** Decode every line of every segment under `devices/*/`
   (§4) and `ingest` the result (§8.3), `self`'s lines included: a forked
   self stops the import before anything is written. A device
   directory that arrives without its `device.minted` is read — its
   events are still that device's — and reported as incomplete.
2. **Blobs**, after the events: a blob absent here and present there
   is copied iff it is not collectable over the merged event set
   (`vault-events.md` §8.3) and its bytes hash to its name; one that
   does not is damage in the source, reported, not copied. An erased
   blob never comes back.
3. **Files**, each by its own policy (§6): `config.json` identical or
   refused; `keystore.json` unioned; `state/` as v1; any other path
   copied when absent, never overwritten; `local/` is not in the
   snapshot and is not touched.

### 9.4 Restore

Into an empty backend, a folder store copies the snapshot as it is,
`config.json` written last: the snapshot is this tree, and a copy of it
is a conforming folder — the one whole-file copy that survives §8.3,
safe because there is nothing here for it to double. A store that is
not a folder ingests it (§9.3). There is no `local/`, so the first open
mints a `dev` and an `instance` (§6.4) and the imported
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
sharing one `dev` is a bug, not a merge: it shows up when either
imports the other — events of `self` it never wrote (§8.3) — as one
`eid` with two contents (§8.5), or as a second `device.minted` under
one `dev` (`vault-events.md` §5), and the remedy is for one of them to
mint its own.

A backup is still a move, not a sync, but the folder no longer stands
in the way of one: a sync is "ingest what the other device holds that I
lack, and the blobs those events name", and nothing here should have
to change for it. What a deletion leaves on disk, and why, is
`vault-events.md` §10.

## 12. Open

- **Ingest segment granularity.** One segment per device per `ingest`
  call (§8.3): many small merges leave many small files, one per
  device each time. Compacting a store's own ingest segments would be
  the obvious answer — nothing reads by segment any more, so it would
  break nothing — and is forbidden as rule 3 is worded; whether the
  rule should distinguish a segment the store minted for ingest from
  one a device wrote is a question for when the file count is felt. It
  is a smaller question than it was: a segment per device per merge,
  not per channel.
- **`fsync`** (§8.2): whether `FsBackend` should sync per append so the
  daemon can claim power-loss durability.
- **Reading by hand.** A backup is one JSONL per device; finding one
  conversation in it is `grep` for its `peerKey`. Whether a folder
  store should also keep a per-channel index under `local/cache/`
  for its own reads is `event-store.md` §10, not the format's.
