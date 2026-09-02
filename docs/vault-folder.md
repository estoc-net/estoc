# The `.estoc` folder, version 3 — draft

Status: **draft** — version 3, 2026-09-02: the vault holds no keys and
no local state; both are the device's (`device.md`). Version 2
(`@estoc/event-store`'s folder store, implemented 2026-09-01, drafted
2026-08-30) differs by §1, §6.2, §7, §10 and §11, and by nothing else.

The second of three documents. `event-store.md` says what a vault is
to a program — the event, the store, interchange. This document is
that store spelled as files: one log per device, the mapping between a
path and an event in both directions, and how the reference store
reads, appends and merges on a file system. It is also the
**interchange format**: what a backup is, and what any store must be
able to render and read (`event-store.md` §10). It defines no event
type and never reads `data`; the types it carries are
`vault-events.md`'s, and where a file operation depends on one — which
blobs an import copies, which extension stores it drops — the folder
asks a fold and applies the answer.

## 1. What a vault is

A vault is a directory. The directory **is** the format: a backup is
the directory zipped, a restore is the zip unpacked, and any client
that can read files can read a vault. Nothing about an identity's
*record* lives anywhere else; its keys live in its devices
(`device.md`), and none of them is here.

The directory has two halves. `.estoc/` is the machine's: identity,
events, blobs. Whatever surrounds it is the person's — documents to
publish, one day — and is not specified here. In the browser the vault
root is the origin's OPFS root, where `.estoc/` sits beside the
device's own directory (`device.md` §2); the passphrase-unlocked seed
cached in IndexedDB is the device's, not part of the vault.

Paths are `/`-separated, relative to the vault root, ASCII with no
backslash, with no `.` or `..` segments. Text files are UTF-8; JSON files are
pretty-printed with a trailing newline; JSONL lines are compact JSON
terminated by `\n`.

## 2. Rules of the folder

The principles of `event-store.md` §1 as they land on a file system.

1. **Three kinds of file, none of them a record.** A **log** — events,
   append-only JSONL in segments, merged by union; a **singleton** —
   one per vault, kept by its own policy on merge (§6); a **blob** — a
   block named by its CID, merged by union, the only kind ever
   unlinked (§8). Nothing is rewritten in place.
2. **Every event under `devices/<dev>/` was authored by device `dev`.**
   The directory and the line's `author` field say the same thing, and
   a reader refuses a line where they differ. A device appends only to
   segments it minted, under its own directory. A segment is edited or
   truncated by nobody but its writer. A merge may *add* segments under
   any device's directory, holding only that device's events (§9.3):
   under `devices/x/` there may be a segment `x` wrote and one this
   vault minted from what `x` wrote, and a reader unions them by
   `eid`. A merge never copies a segment: it reads the other copy's
   lines and appends the ones it lacks.
3. **Nothing under `devices/` is ever unlinked.** Not a line, not a
   segment, not a directory. The only thing ever unlinked is a blob.
4. **A path says the author and nothing more.** What an event is about
   is a field of the line's `data` (`event-store.md` §2.1); a segment
   name says nothing about the events in it (§5); no name encodes
   whose anything is.

## 3. Layout

```
.estoc/
  config.json                    singleton — format/version, anchor; immutable
  blobs/<cid>                    content-addressed blocks — message bodies, attachments, received objects; the one place anything is unlinked
  devices/<dev>/<seg>.jsonl      everything device <dev> wrote: one log, every event a line
  state/                         reserved; §6.3
  extensions/<ext>/              an extension's own store: this tree again, less config; §3.1
    devices/<dev>/<seg>.jsonl
    blobs/<cid>
```

Nothing here is a secret and nothing here is one copy's own: the keys
and the local state are the device's (§7, `device.md`), and the two
paths version 2 kept them at, `keystore.json` and `local/`, are
reserved and refused (§6.2, §7).

There is no per-device file — a device announces itself with an event
(`vault-events.md` §5) — and no directory per contact or per channel:
what an event is about is a field of its `data`, and a reader reads
the whole log anyway (§9.1). A directory per subject would serve no
reader and no merge, and would cost a segment per subject per device
on every merge.

### 3.1 `extensions/<ext>/`

An extension's store (`event-store.md` §8) is this tree again, under
its `ext`: `devices/<dev>/<seg>.jsonl` and `blobs/<cid>`, by every
rule of §4, §5, §8 and §9 — one writer per device directory, segments
named uuidv7, blobs flat — and nothing else: no `config.json` (the
identity is the vault's), no local state (an extension's is the
device's, `device.md` §5), and no `extensions/` of its own. `ext` is the uuidv7 that
`extension.installed` minted (`vault-events.md` §5); a directory under
`extensions/` not named like one is a file (§9.6). A folder store
opens one store per such directory, and a reader with a text editor
reads it as it reads the vault: the lines are the events, whatever the
extension meant by them.

The directory comes into being with the first line or block written
through the handle `extension(ext)` hands out (`event-store.md` §9);
nothing makes an empty one, and an `extensions/<ext>/` with no segment
and no blob is nothing — not a store, not listed by `extensions()`,
not in a snapshot (§10.1 walks files) — so the backend need not know
what an empty directory is. Whether an `ext` may be opened at all is
the lifecycle fold's answer, asked by the application above; the
folder reads no type.

`dispose(ext)` removes every file under `extensions/<ext>/` — and,
called through the device, the extension's local state, which mirrors
this path so that the one removal is one rule (`device.md` §6) — in
the store's serialisation (§9.2): after every
operation that has taken its turn there, reads included, and before
any other takes one. An operation still preparing outside it — an
`ingest` reading its input, a `put` hashing its bytes — has touched
nothing, and is refused (`Disposed`) when its turn comes, so that a
disposal never waits on a caller's input. Every handle to the store is
dead from the call on (`Disposed`), as is `extension(ext)` for that
`ext` for the rest of this instance's life. The application calls it
when the fold over the vault's set says the extension is purged
(`vault-events.md` §7.3); the folder does not read `extension.purged`,
and does not remember what it removed past this instance: a later
write to the same `ext` is the application contradicting its fold.
Nothing else in the tree is ever removed whole.

## 4. Folder ↔ store

```
locate(event)           → "devices/<author>/"
decodeEvent(path, line) → the event, with its envelope validated and line.author checked against <dev> in path
```

`locate` is store → folder: where an event is written, and where an
export renders it. `decodeEvent` is folder → store: what a line under
a path *is* — parsed, its envelope checked (`event-store.md` §2.4),
its `author` held against the directory. There is nothing else to map:

- **The line is the event.** One JSON object per line — the envelope
  and `data`, nothing elided and nothing reinjected. A line apart from
  its path — in a report, a grep, a copy — says everything about
  itself, including who wrote it.
- **The path checks the line.** A line whose `author` is not the `dev`
  of the directory it sits in is refused as damaged (§9.5); the
  directory never supplies the author, it confirms it.
- **Every directory under `devices/` that holds segments is a device.**
  A name that is not a device id (six lowercase base32 characters,
  `event-store.md` §3), or anything under it that is not a segment, is
  not part of the event set; it is a file, carried as any unknown path
  is (§6.4).
- **A segment is not part of an event's identity** (§5).

## 5. Segments

`<seg>` is a uuidv7; a segment is `<seg>.jsonl`, one event per line,
under `devices/<author>/`.

- **The writer's segments.** A device appends to the newest segment it
  minted, or mints a fresh one; rotation is the writer's own policy. A
  first append heals a segment that does not end in a newline by
  terminating the fragment before writing; the fragment is a damaged
  line (§9.5).
- **The importer's segments.** A merge that brings in another device's
  events writes them into a segment *this* vault mints under that
  device's directory (rule 2, §9.3) — never into a segment the device
  wrote, never into one a previous import wrote. Such a segment holds
  its events in the order they came, which is no order at all.
- **No segment is assumed ordered.** `at` is a wall clock and steps
  back; an importer's segment is in whatever order the events came. A
  reader collects and sorts (§9.1); it never merges segments as sorted
  streams.
- **A segment says nothing about the events in it**, and a program
  never sees one. It is not state: a merge reads lines, never segments
  (§9.3), so how a writer chunks its log is its own affair, and an
  export may chunk an author's events differently every time (§10.2).
  A reader unions by `eid` whatever the chunking.
- **A device's log is the union** of its segments, wherever they were
  minted.

## 6. Singletons and other files

To the store these are files (`FileStore`, `event-store.md` §6); a
singleton is a file that is one per vault and has a merge policy of
its own. Each states that policy here; `event-store.md` §10.3 applies
them after events and blobs.

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
Nothing a person can edit lives here — the identity's label and a
device's mediation are events (`vault-events.md` §5). Merge: must be
identical on both sides — the anchor check is what makes it a merge at
all — and a differing `version` is refused (§11). Restore writes it
last.

### 6.2 `keystore.json` — not here

Version 2 kept the identity's one seed at this path, sealed under a
passphrase, with a cache of the names derived from it, and an import
unioned the cache. Version 3 has no seed to keep: every key is a
device's, in that device's keystore (`device.md` §4), and the vault
records of a key its name, its public DID and which device minted it —
all in events (`vault-events.md` §2), none in a file. The path is
**reserved and refused**: `write` refuses it (§9.6), an import that
finds one on either side refuses before writing anything (§10.3), and
a snapshot cannot contain one. It is the one path a reader must not
carry along as unknown (§6.4), because what a version-2 file at it held
was a secret, and carrying it would put a seed in a backup.

### 6.3 `state/`

Reserved for high-churn, per-person, mutable state — read cursors,
drafts, anything written on every glance — which would swamp the log
as events. Rules fixed now, shape later: small JSON files keyed by
what they are about (a `cid`, a `thid`); they travel with the vault;
they merge per key by their own timestamp, newest wins. Until the
shape exists an importer treats `state/` as any path it has no rule
for (§6.4).

### 6.4 Unknown paths

Any other path a reader meets and does not understand — the reserved
`keystore.json` and `local/` excepted (§6.2, §7) — is carried: copied
when absent, never read, never overwritten (§11). This includes
a path under `devices/` or `blobs/` that is not shaped like a segment
or a blob (§9.6), so that a path a later version defines survives a
reader that does not know it.

## 7. What is not here — the device

Everything that is true of *this copy on this machine* and of nothing
else (`event-store.md` §7) — which device this copy writes as, the keys
it holds, its options, its caches, its trace — is the **device's**,
kept in a directory of its own that points at this folder and is
defined in `device.md`. Version 2 kept it under `local/` here, excepted
from every snapshot, export and merge; version 3 keeps nothing here
that needs excepting, so the folder is the snapshot (§10.1) and there
is no path in it a backup leaves out.

What the folder needs from the device it takes at open (`device.md`
§6): `self`, the `dev` it writes under, and `instance`, which its
change tokens name (§9.4). A device that opens this folder and finds no
`device.minted` of its own under `devices/<self>/` appends one, on
every open, idempotently — that is how a device joins a vault, and how
a restored folder gains its new device (§10.4). Two devices may open
one folder (`device.md` §2), each writing its own directory; two
*processes* of one device is the bug of §11, and the lock that prevents
it is the device's.

`local/` is reserved and refused as `keystore.json` is (§6.2, §9.6,
§10.3): a folder holding one is a version-2 folder's leftover, and what
was under it was never part of the vault.

## 8. Blobs — `blobs/<cid>`

One file per block of the `unixfs-v1-2025` profile (`event-store.md`
§5.1), named by its CID: CIDv1, sha-256, codec `raw` or `dag-pb`,
base32 lower — fifty-nine characters, `bafkrei…` for a raw block and
`bafybei…` for a dag-pb node. The file's bytes are the block's, as
they hash: a raw block is the bare bytes, a dag-pb node its encoded
form. A file of at most 1 MiB is one raw block; a larger one is its
raw 1 MiB chunks and a dag-pb root, each a file here; a received
object is every block of its tree, each a file here. One flat
directory, always: the interchange format has one layout, so a zip is
readable without probing. A backend that wants sharding does it below
`VaultBackend` and renders flat. Immutable, merged by union,
deduplicated by construction, and the one directory outside `devices/`
that every device writes to — safely, because a content address has
no author. The store names a block by hashing its bytes; a block's
name is checked against its bytes on import (§10.3), and a mismatch,
or a name that is not a profile block's, is damage, not copied.

A blob is written **before** the line that names it, leaves before
root (`event-store.md` §5.2); a crash between the writes leaves
orphans, harmless, unlinked by `collect` once they are older than the
grace (`event-store.md` §5.3, `vault-events.md` §8.3). The folder's
age of a block is its file's modification time
(`VaultBackend.modified`), the local clock's, which an import does not
carry over; a `put` or `putBlock` of a block already on disk rewrites
the file with the same bytes so that the time is renewed, as
`event-store.md` §5.3 requires. `collect` walks `blobs/` once, keeps
what `keep` reaches, and removes the rest that is old enough; it runs
under the same per-instance serialisation as the store's appends
(§9.2), never beside a `put`. A block the folder finds damaged (§10.3)
is moved aside, out of `blobs/` and out of the vault, into the
device's `damaged/` (`device.md` §2), and is from then on absent. What a
block's absence means — erased, missing, or not yet fetched — is read
from the events (`vault-events.md` §8.2); the folder only reports that
it is not there.

## 9. The folder store

The reference `EventStore`, over `VaultBackend` — the bytes interface:
read, write, append, remove, size, list, dirs, and `modified`, for a
block's age (§8). It knows the tree; nothing above it does.

### 9.1 Reading

`scan(filter)` reads every segment under `devices/*/` — under
`devices/<author>/` alone when the filter names an author — parses
each line, checks its `author` against the directory (rule 2), skips
damaged lines into `damaged()`, dedups by `eid` (§9.5), keeps the
lines whose fields equal the filter's, sorts into canonical order
(`event-store.md` §3), and yields. There is no reading less than a
device's whole log; a filter narrows the answer, not the work.

### 9.2 Appending

The line goes to the newest segment this store minted under
`devices/<self>/`, or a fresh `<uuidv7>.jsonl`, healing a fragment
first (§5). Appends are serialised per store instance, because
`VaultBackend.append` is size-then-write. The line written is the
event, whole (§4). Whole-line durability across a process crash is
what the backend gives; neither Node `fs` nor OPFS `fsync`s on append
(`event-store.md` §4.1).

A batch (`appendAll`, `event-store.md` §4.1) is not appended. The
store mints a fresh segment and hands the whole batch to
`VaultBackend.write`: a whole-file write is atomic across a process
crash, so the segment is there entire or not at all — between two
appends there is a gap for a crash to land in; inside one write there
is none the process can make. The fresh segment is the newest this
store minted, so it is the open segment from then on.

### 9.3 Ingesting

One pass, reading first. The store reads its input whole and, before
writing anything, checks every incoming event whose `author` is `self` (`device.md`
§3): one already here with the same content is a
duplicate; one not here, or here with other content, stops the call
with nothing written and is reported as a forked self
(`event-store.md` §4.2) — two writers have shared this `dev`, and the
remedy is a fresh device (`device.md` §7) and importing again.

Then, for each incoming event: validate; if the `eid` is already under
`devices/<author>/`, compare (`event-store.md` §2.3) and count it
duplicate or conflict; otherwise append the line to a segment under
`devices/<author>/` that **this store minted for this `ingest` call**
(§5): one segment per author per call. So a merged folder may hold,
under `devices/x/`, both `0198…a.jsonl` written by `x` and
`0198…b.jsonl` written here from what `x` wrote. Both contain only
events authored by `x`; readers union by `eid`, so nothing is doubled.

A folder never copies another folder's segment, however tempting when
both sides are folders (`event-store.md` §10.3): a copied segment is
not read, so it could carry an `eid` already here by another route,
the reader's tie-break (§9.5) could then prefer the copy over what
this store had, and `changes` (§9.4) would replay bytes that were not
new. The one whole-file copy is a restore into an empty backend
(§10.4).

### 9.4 Changes

The token is the device's `instance` (`device.md` §3), which store — the vault's, or
an `ext` (§3.1) — and that store's segment table: every `<seg>.jsonl`
under its `devices/*/`, by path, with its byte length, taken when
`changes` is called (one walk, one `size` per segment). `events` reads
each segment from the length `since` names for it (zero if `since`
does not name it) to the length `token` names, and decodes every whole
line (§4), in whatever order the walk finds them — `event-store.md`
§4.4 promises none, and a folder could not keep the order events were
gained in across authors without a ledger it does not have. A token
naming another instance or another store, or a segment that is now
shorter or absent, is one this store did not issue, and the call is
rejected. Because a segment only grows, is appended to by one writer,
and every line under `devices/` was either appended by `self` or
ingested after a check against everything here (§9.3), the bytes
between two lengths are exactly the events that arrived between the
two calls, and none of them was already here.

### 9.5 Damage and conflict

A **damaged line** is bytes in a segment that do not parse as a JSON
object, or parse to one that fails the envelope (`event-store.md`
§2.4): a fragment from a crash, an edit, a line whose `author` is not
its directory. Reported as `DamagedLine` (where, the text, the error),
never stored, never counted, never fused with the next line.

A **conflict** is one `eid` with two contents, which a folder comes to
hold only by hand — a segment dropped in with a file manager, an edit
— never through the store, which checks before it writes (§9.3). The
reader keeps the line from the segment whose path sorts first, and
within a segment the first; yields that one; reports the others in
`conflicting()`. The rule exists so that every reader of one folder
agrees, and so that a hand-merged folder is still readable; it is not
a judgement about which is right.

### 9.6 Files

`FileStore` is the backend's read/write/list over every path in the
snapshot that is not a segment or a blob — not
`devices/<dev>/<seg>.jsonl` with `dev` a device id and `seg` a uuidv7,
not `blobs/<cid>` with `cid` a fifty-nine character base32-lower CIDv1
(§8). The test is the shape of the path, not its prefix: a path under
`devices/` or `blobs/` that is not shaped like that is a file, carried
and never read (§6.4), so that it survives a trip through a store that
is not a folder. The same test applies under `extensions/<ext>/`
(§3.1): a segment or a blob there is the extension store's, and
anything else there is a file. `keystore.json` and `local/` are
neither: reserved paths, refused (§6.2, §7).

`write` refuses what is not a file's path (`event-store.md` §6): a
segment's or a blob's shape, the reserved `keystore.json` and `local/`
(§6.2, §7), a directory the layout owns — `devices`, `devices/<dev>`,
`blobs`, `extensions`, `extensions/<ext>` and the `devices`,
`devices/<dev>` and `blobs` under it — and
a path that with what the folder holds would make a file and a
directory of one name. A folder that holds such a path anyway was not
written by a store, and an import (§10.3) refuses it before writing.

## 10. Snapshot, export, import, restore

### 10.1 Snapshot

Everything under `.estoc/`, without exception — the folder is the
snapshot: every file, `extensions/` included, so an `extensions/<ext>/`
with nothing in it is not in it (§3.1). A folder store's snapshot is a
copy; the zip a backup carries is this tree, and carries no key of the
identity (§7): it is the record, and whoever opens it is a device of
their own (§10.4). A purged extension store still on disk — the application
has not yet applied the fold (§3.1) — travels with it and is dropped
by whoever imports it (§10.3).

### 10.2 Export

A store that is not a folder renders one: each event to
`devices/<author>/<seg>.jsonl`, in segments the export mints as it
goes — one per author is enough, in any order — one line each; blobs
to `blobs/<cid>`, flat; every path in `FileStore` in place; each
extension store the same way under `extensions/<ext>/` (§3.1).
Nothing about the chunking is remembered: a reader of the
export unions by `eid` and assumes no order (§5, `event-store.md`
§10.2).

### 10.3 Import

The algorithm is `event-store.md` §10.3 — preflight, then events,
blobs, files, then each extension store — and is not restated here;
this is what each step is on a folder.

- **Preflight** reads `config.json` first: not version 3 (§11), a
  format or anchor that differs from this folder's (§6.1), or a
  `keystore.json` or `local/` on either side (§6.2, §7), refuses the
  import before a line is decoded. Then every line of every segment
  under `devices/*/` and `extensions/*/devices/*/` is decoded (§4) —
  the whole source, so that the forked-self check runs over every set
  the import will write before anything is written.
- **Events** are `ingest` (§9.3), `self`'s lines included. A device
  directory that arrives without its `device.minted` is read and
  reported as incomplete.
- **Blobs** are the files under `blobs/`. One absent here — a file
  here that fails the block check (`event-store.md` §5.1) is moved
  aside and is absent, so a source that has it sound repairs it — is
  copied when `event-store.md` §10.3 says so, and only when it passes
  the check (§8); one that does not is damage in the source, reported,
  not copied.
- **Files**: `config.json` is not touched, having been checked;
  `state/` and any other path copied when absent, never overwritten
  (§6.3, §6.4).
- **Extension stores** are the directories under `extensions/` named
  like an `ext` (§3.1), each into the store of the same `ext` here,
  which comes into being with the first line written if this copy had
  none. One the fold over the merged vault set says is purged is not
  read, and the application then disposes of any such store still on
  disk (§3.1); one no `extension.installed` accounts for is read and
  reported.

### 10.4 Restore

Into an empty backend, a folder store copies the snapshot as it is,
`config.json` written last: the snapshot is this tree, and a copy of
it is a conforming folder — the one whole-file copy that survives
§9.3, safe because there is nothing here for it to double. A store
that is not a folder ingests it (§10.3). Empty means nothing at
`.estoc`. The device that opens the copy is whichever device was
pointed at it (`device.md` §7) — one just born for it, or one whose
folder was lost — and its first open appends its `device.minted` (§7);
a cache that device kept under an earlier vault is its own affair
(`device.md` §3). The imported directories stay as history, the old
devices' mediations included, visible until the person retires them
(`vault-events.md` §7.3); their keys did not come, because the old
devices hold them or they are gone. The copy may carry a purged
extension store the source had not yet disposed of (§10.1), and this
device has no memory of it, so the first open folds the extension
lifecycle and applies every pending `dispose` before any extension is
opened or run (`event-store.md` §8) — the application's first act on
any open, not only after a restore. What the application then does
with the merged set — `held` on the old devices' outbound not `sent` —
is `vault-events.md` §10.

## 11. Versioning, robustness, boundaries

- **Version.** `config.version` is the version of the whole vault;
  this document is version 3. A reader refuses any other version:
  nothing is read past `config.json`, nothing is written, nothing is
  renamed. There is no migration from an earlier version; a vault of
  one is used by a reader of that version or started over (§12, for
  the one question version 2 leaves). The derivation label of a
  device's `seed` keys (`estoc/v3`, `device.md` §4.1) is the key
  scheme's version, not the folder's; changing it would change every
  DID, which would be a vault version change too. The device's own
  versions (`device.md` §9) are not the folder's. No line-level
  version field: `config.version` covers every file.
- **Within a version** change is additive: a new event type, a new
  field of `data`, a new kind of file. A field's meaning never
  changes. Unknown paths are carried, not read, never overwritten
  (§6.4); an event of an unknown type is an event like any other.
  Anything else is the next version.
- **Writers.** One writer per device directory is the format-level
  rule (rule 2); the device serialises its own processes (`device.md`
  §6: a Web Lock in the browser, a lock file on disk), and two devices
  on one folder are two writers that need no lock between them. Two
  processes sharing one `dev` is a bug, not a merge: it shows up when
  either imports the other — events of `self` it never wrote (§9.3) —
  as one `eid` with two contents (§9.5), or as a second
  `device.minted` under one `dev` (`vault-events.md` §5), and the
  remedy is for one of them to mint its own.
- **Crashes.** A log is appended; a crash may leave a cut-short last
  line, which readers report and skip, and the next append terminates
  first (§5). Durability past a process crash is the backend's to
  claim (§9.2).
- **At rest, the vault is plaintext**, all of it: events, key
  *names*, blobs, and so is a backup zip. There is no secret in it to
  protect (§7); the keys that *use* the identity are in its devices,
  under a passphrase there (`device.md` §8). A client wanting
  encryption at rest wraps the backend; a backup that should not be
  readable is a transport question — a passphrase on the zip — not the
  format's; either way the client must say plainly in its copy what it
  does.
- **A backup is the record, not the identity.** Under version 2 a zip
  carried the seed, and unpacking it anywhere was being the person;
  under version 3 it carries every event, blob and file and no key,
  and unpacking it is a new device joining (§10.4), which the
  identity's other devices and contacts learn of above this document.
  A backup is still a move, not a sync, and the folder does not stand
  in the way of one: a sync is "ingest what the other device holds
  that I lack, and the blobs those events name", and nothing here
  should have to change for it. What a deletion leaves on disk, and
  why, is `vault-events.md` §10.

## 12. Open

- **Ingest segment granularity.** One segment per device per `ingest`
  call (§9.3): many small merges leave many small files, one per
  device each time. Compacting a store's own ingest segments would be
  the obvious answer — nothing reads by segment, so it would break
  nothing — and is forbidden as rule 3 is worded; whether the rule
  should distinguish a segment the store minted for ingest from one a
  device wrote is a question for when the file count is felt.
- **`fsync`** (§9.2): whether `FsBackend` should sync per append so
  the daemon can claim power-loss durability.
- **Reading by hand.** A backup is one JSONL per device; finding one
  conversation in it is `grep` for its `peerKey`. Whether a folder
  store should also keep a per-channel index under its owner's cache
  directory (`device.md` §5) for its own reads is `event-store.md`
  §12, not the format's.
- **Version-2 folders.** A version-2 folder is a version-3 folder with
  `keystore.json` and `local/` in it. Whether a reader may, once, lift
  the two into a device directory — the keystore read as v4
  (`device.md` §4.5), `local/self.json` become `device.json`, the
  owners moved — and rewrite `config.version`, or whether version-2
  vaults are started over as version-1 vaults were, is the one
  migration question this version has. The rule above says no
  migration; what keeping it costs is every existing vault.
- **`identity` in `config.json`** (§6.1) still names a key, `anchor`,
  by its derivation name — the one place the vault says how a key is
  derived, and now a name only the device that minted it can derive.
  Replacing it with an identifier of the anchor's inception event,
  with the anchor's public key in that event, is the next change to
  §6.1, and ships under this version number: no reader of version 3
  ships before both.
