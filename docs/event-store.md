# The vault as an event store — draft

Status: **draft**, 2026-08-29, revised the same day after review. A
companion to `vault-format-2.md`: that document says what a version-2
vault *is* on disk; this one says what a program *sees*, and how the two
are the same thing. It names a seam and puts the folder on one side of
it. The amendments it needs from the format are applied there (§8); the
one thing it adds to the format is an event type, `device.minted`, in
place of a file.

What the review changed: the per-device cursor is gone, replaced by an
opaque arrival-order token (§4.4); the locator's `dev` is `author`, so it
cannot collide with an event that names a device (§2); a store that is
not a folder remembers a segment per event, so its exports stay
prefix-related (§6.1, §7.1); exchange is spelled out per kind of file
(§7.2); the store validates the envelope and reports conflicts (§2,
§4.5); durability is narrowed to what the backends deliver (§4.1).

## 0. Why

`vault-format-2.md` already treats the vault as a set of events folded
into state. But `@estoc/vault` today is written against bytes: five
stores (`ContactStore`, `InvitationStore`, `MessageLog`, `DeliveryLog`,
`BlobStore`) each own a directory, each know its file names, and
`importVault` merges by classifying paths. Every store is a small
database with one table, and the merge is five merges. When a caller
asks "what happened to this contact", the answer is spread across three
of them.

Looked at as a database, the whole tree is **one table**. Each directory
level of `devices/<dev>/parts/<myKey>/<peerKey>/<seg>.jsonl` is a column;
a segment is a page; a merge is `INSERT OR IGNORE`. The folder is a
serialization of that table, chosen because copying a subtree is free on
a file system. Nothing in the model depends on the choice.

So the program's interface should be the table, not the folder. Folds
read events through a filter; policy appends events; the store behind
the interface is a folder on OPFS or disk, an in-memory set for tests,
or a database where one is cheaper. Swapping the store touches nothing
above the seam, and the folder stays the interchange format every store
must be able to read and write.

## 1. Scope

This document defines:

- the **event** as the unit a program reads and writes (§2);
- the **mapping** between an event's fields and its place in the
  folder (§3): the serialization rule that makes `vault-format-2.md`'s
  tree and this document's table the same set;
- the **store interface** (§4) and what any implementation must
  guarantee;
- the **folder store** (§5), the reference implementation, and what a
  database store would look like (§6);
- how stores **exchange** events and everything else in a snapshot:
  export, import, and the cache (§7);
- what was **changed** in `vault-format-2.md` to permit this (§8).

It does not define events (§7–8 there), folds (§9 there), erasing (§10
there), or the trace log, which is local and stays a log of its own.

## 2. The event

An event is a JSON object. Every event has:

| field    | meaning |
|----------|---------|
| `eid`    | a bare uuidv7, as `vault-format-2.md` §4: minted at append, the dedup key; the same kind of id as `mid` and `cid`. |
| `at`     | RFC 3339 UTC, as v1 §4. |
| `type`   | the event type, as §7.1 / §8 there. |
| `author` | the authoring device. A field, on the line as well as in memory (§3); nothing is parsed out of `eid`. |
| `scope`  | one of `me`, `contact`, `part`: which log family. |

and, by scope, a **locator**:

| scope     | locator fields      | the log in `vault-format-2.md` |
|-----------|---------------------|--------------------------------|
| `me`      | (none)              | `devices/<author>/me/` |
| `contact` | `cid`               | `devices/<author>/contacts/<cid>/` |
| `part`    | `myKey`, `peerKey`  | `devices/<author>/parts/<myKey>/<peerKey>/` |

`author` and `scope` are locator fields too. Together they are the
**Locator**: everything that says *where* an event is, and nothing that
says what it is. The rest of the object is the event's **payload**: the
event's own fields, as specified per type.

**Reserved names.** `eid`, `at`, `type`, `author`, `scope`, `cid`,
`myKey`, `peerKey` belong to the envelope; a payload must not use them,
and a store rejects an event whose payload does. `dev` is *not*
reserved: `device.label { dev }` and `device.retired { dev }` name the
device a decision is about, which is payload, and is why the locator's
authorship field is called `author` and not `dev`.

Rules:

1. **The locator is on the event.** Every event carries its full
   locator as fields. Nothing about where an event belongs has to be
   recovered from state; this is what §7 of `vault-format-2.md` bought
   by partitioning on observed keys rather than on `cid`, and it is what
   makes a flat table with a `WHERE` clause a correct reading.
2. **`author` is authorship.** The `author` field and (in a folder) the
   `devices/<author>/` directory always agree; a store rejects a line
   where they do not. Authorship is the field, not the id: `eid` says
   nothing about who wrote the event, exactly as `mid` says nothing
   about who received the message.
3. **The store validates the envelope and nothing else.** On `append`
   and `ingest` it checks that the object is a JSON object; that `eid`
   is a well-formed uuidv7; that `at` is RFC
   3339 UTC; that `type` is a non-empty string; that the locator is
   complete for its `scope`; and that no reserved name is used by the
   payload. An event that fails is rejected — `append` throws, `ingest`
   reports (§4.2) — and never stored. The payload is opaque:
   type-specific validation is the fold's. A line on disk that does not
   parse as JSON is a *damaged* line (§4.5), reported, not stored.

## 3. Path ↔ fields

The folder layout of `vault-format-2.md` §3 is the locator, spelled as a
path. Two pure functions:

```
locate(event)          → "devices/<author>/me/"
                       | "devices/<author>/contacts/<cid>/"
                       | "devices/<author>/parts/<myKey>/<peerKey>/"

place(path, line)      → event      (path gives the locator; the line gives the rest)
```

- **On disk, the line omits the locator below `author`.** A line under
  `devices/k7q3ma/parts/did/0198…/abc…/` does not repeat `scope`,
  `myKey`, `peerKey`; `place` reinjects them. It does carry `author`:
  six characters, and the one field a line must be able to say for
  itself once it is apart from its path (in a report, a grep, a copy),
  and the one that checks the path (rule 2). This keeps the on-disk
  form what `vault-format-2.md` §7.1 shows, and it is why the rest of
  the locator must be recoverable from the path alone: `myKey` has
  slashes of its own, so `peerKey` is always the last directory (§4
  there) and the rest between `parts/` and it is `myKey`.
- **In memory, the event is whole.** Anything above the store — folds,
  policy, a database store — sees the full object of §2 and never a
  path.
- **The mapping is total and injective on locators.** Every valid
  locator has exactly one directory, and every directory under
  `devices/<author>/` that holds segments parses to exactly one
  locator. A directory that does not parse is not part of the event
  set; a reader reports it and moves on (as `vault-format-2.md` §14:
  unknown paths are carried, not read).
- **A segment is not part of an event's identity.** Which `<seg>.jsonl`
  a line sits in says nothing about the event, and a program never sees
  one. It *is* part of the store's state: the interchange format merges
  by segment (§5.3, §7.1), so a store that is not a folder still has to
  remember which segment each event would be written to (§6.1).

**Round trip.** For any event set *S* produced by any conforming store,
rendering *S* as a folder (§7.1) and reading that folder back yields
*S*: same events, same fields, compared as JSON objects with `eid` as
identity. This is the conformance test every store passes, and the
definition of "a version-2 vault" that is independent of the medium.

## 4. The store interface

```ts
type Where =
  | { scope: "me" }
  | { scope: "contact"; cid: string }
  | { scope: "part"; myKey: string; peerKey: string };

type Locator = Where & { author: string };

type Event = Locator & {
  eid: string;                        // a bare uuidv7
  at: string;                         // RFC 3339 UTC
  type: string;
  [field: string]: unknown;           // the payload; opaque here
};

/** What a caller hands to `append`: no eid, at, or author — the store mints them. */
type Draft = Where & { type: string; [field: string]: unknown };

interface Filter {
  author?: string;
  scope?: "me" | "contact" | "part";
  cid?: string;
  myKey?: string;
  peerKey?: string;
  type?: string;
}

/** A position in this store's own arrival order. Opaque; meaningful only to the store that issued it. */
type Token = string;

interface Ingested {
  added: number;
  duplicate: number;                  // same eid, same content: skipped
  conflicts: Conflict[];              // same eid, different content: the store keeps what it had
  rejected: Rejected[];               // failed envelope validation (§2 rule 3)
}

interface EventStore {
  /** Which device this store appends as; `vault-format-2.md` §6.3. */
  readonly self: string;
  /** This device's own event. The store mints eid and at, sets author = self, returns the whole event. */
  append(draft: Draft): Promise<Event>;
  /** Events from elsewhere (a backup, another store, another device). Union by eid. */
  ingest(events: AsyncIterable<Event>): Promise<Ingested>;
  /** Every event matching `filter`, in canonical order. */
  scan(filter?: Filter): AsyncIterable<Event>;
  /** What this store gained after `since`, in arrival order, up to `token`. */
  changes(filter?: Filter, since?: Token): Promise<{ token: Token; events: AsyncIterable<Event> }>;
  /** Lines met on disk that could not be read; for the caller to surface. */
  damaged(): DamagedLine[];
  /** Eids met with more than one content; for the caller to surface. */
  conflicting(): Conflict[];
}

interface BlobStore {                 // content-addressed; as today
  get(hash): Promise<Uint8Array | null>;
  has(hash): Promise<boolean>;
  put(hash, bytes): Promise<void>;
  unlink(hash): Promise<void>;
  list(): Promise<string[]>;
}

interface Files {                     // everything in a snapshot that is neither an event line nor a blob
  read(path): Promise<Uint8Array | null>;
  write(path, bytes): Promise<void>;
  list(): Promise<string[]>;
}
```

A vault, to a program, is `{ events: EventStore, blobs: BlobStore,
files: Files }` plus the trace log. `Vault` in `@estoc/vault` holds
these three and the key-minting it does today; the five stores go,
replaced by folds over `events.scan(...)` and `events.changes(...)`.
`Files` holds `config.json`, `keystore.json`, `state/`, and any path a
reader does not understand; there is no per-device file (§8).

### 4.1 `append`

Takes a draft, sets `author` to `self`, mints the uuidv7 at that
instant and `at` from the same clock, and writes the event. The store
mints because the format says the id is minted *at append* (§4 there)
and that is the only way to keep one device's ids monotone: a caller
that minted its own could hand over an old one. The whole event is
returned; a caller that needs the `eid` (to cite it in a later event)
takes it from there.

When the promise resolves the event is written as one whole line: a
later reader sees all of it or none of it; a truncated line is
*damaged*, skipped, and never fused with the next (§5.2). This holds
across a crash of the process. Whether it holds across power loss is
the backend's property and is stated by the backend, not promised here:
Node's `appendFile` does not `fsync`, and OPFS offers no control over
when bytes reach the medium. A backend that wants the stronger claim
makes it itself (an `fsync` per append on Node is cheap at this write
rate) and says so.

Appends from one store instance are ordered; two instances on one
folder are the caller's problem, as today (Web Locks in the app, one
daemon on disk).

### 4.2 `ingest`

Takes events from anywhere, authored by anyone, in any order; validates
each envelope (§2 rule 3); and adds those whose `eid` is not already
present. An `eid` already present with the same content is a
*duplicate* and is skipped; with different content it is a *conflict*:
the store keeps what it had, stores nothing, and reports it. Never
rewrites, never drops, never reorders what was there: this is merge in
`vault-format-2.md` §12 with the file-level rules moved into the folder
store (§5.3). A conflict is the "two writers sharing one dev" case
there, surfaced at the event rather than the file.

Nothing about the authoring device's order survives ingest. A backup
made by filter, a second backup that fills in what the first lacked, a
store fed by another store's `changes` — each can deliver an old event
after a newer one from the same author. This is why there is no
per-device cursor (§4.4).

`ingest` is not import. After a merge, agent-core still does what it
does today: fold, and `held` every outbound whose delivery is not
`sent` (`holdUndelivered`). That is a decision made on the merged set,
appended by `self`, and no store's business.

### 4.3 `scan`

Yields the store's whole event set, filtered: events whose locator
fields equal every field given in `filter`, and whose `type` equals
`filter.type` if given. One event per `eid` (conflicts resolved as
§4.5). Order is the canonical order of `vault-format-2.md` §4: `at`,
then `(eid, author)`.

**The store sorts.** No segment, file, or table is assumed to be in
canonical order, and a reader never merges pre-sorted streams: `at` is a
wall clock and can step back even on the authoring device, an importer's
segment (§5.3) holds whatever order the events came in, and a database
sorts in the query anyway. A vault's event set fits in memory; the cost
of sorting it is not what any fold waits on.

The filter is deliberately small: locator fields and `type`. A database
store could answer richer questions; the folder store can only scan. A
question the filter cannot ask (a thread by `thid`, a message by `mid`,
"everything about this contact across partitions") is a fold, and lives
in the cache (§7.3), so no store is asked to be a query engine.

### 4.4 `changes`

`changes(filter, since)` answers "what has this store gained since
`since`", in the order it gained it. The `token` is a position in the
store's own **arrival order** — appends and ingests, in the sequence
this store performed them — taken when `changes` is called, before any
event is read. `events` yields exactly the events that arrived after
`since` and at or before `token`, matching `filter`. A caller that
folds those events and keeps `token` therefore has a fold that is
exactly as far as the token, whatever was appended concurrently: the
next call picks up from there and nothing falls between.

Arrival order is **not** canonical order. An event older than
everything the caller has folded can arrive late (§4.2), and `changes`
delivers it when it arrives. So an incremental fold must not depend on
the order events are applied — rule 5 of `vault-format-2.md` (shuffled
= same) applied one event at a time — and a fold that cannot promise
that refolds from `scan`. The folds of §9 there are functions of the
set and qualify; the property is stated here because `changes` is what
makes it load-bearing.

A token is a string a caller stores and hands back, and nothing more. It
belongs to the store that issued it: a folder store's names segments and
lengths, a database's names a sequence number, and neither means
anything to the other. A token the store cannot place — a segment it
does not hold, a position past what it holds, another store's — is
answered by rejecting the call, and the caller answers that by refolding
from `scan`. Because logs are never truncated (rule 7 there), a token a
store issued is always one it can place, so a rejection means the cache
belongs to some other store, which is exactly when a refold is right.

What `changes` is not: a device-to-device sync. "What do you have that I
do not" between two vaults is anti-entropy over `eid` sets and is
designed on its own when it is designed; it does not reuse this token,
which is local, and the old per-device high-water mark it might have
suggested is wrong for the reason in §4.2.

### 4.5 Damage and conflict

**Damaged lines** are what the folder store finds on disk and cannot
read (`DamagedLine` as today: where, the text, the error). They are
reported, never stored, never counted anywhere. A database store has
none by construction.

**Conflicts** are two contents under one `eid`. `ingest` finds them
against what it holds and reports them (§4.2). A reader can also meet
them, because a folder may hold one `eid` in two segments after a
file-level copy (§5.3): the store then keeps one by a fixed rule — the
line from the segment whose name sorts first, and within a segment the
first — yields that one from `scan` and `changes`, and reports the
others in `conflicting()`. The rule exists so that every reader of one
folder agrees; it is not a judgement about which is right. Alongside
non-prefix segments and a second `device.minted` (§8), a conflict is the
evidence `vault-format-2.md` §14 names for two writers sharing one
`dev`, and what the application shows.

## 5. The folder store

The reference implementation: `EventStore` over `VaultBackend`, the
bytes interface that exists today (read, write, append, remove, size,
list, dirs). It knows the tree; nothing above it does.

### 5.1 Reading

`scan(filter)` walks the directories `locate` would produce for the
filter (a fully specified locator is one directory; a partial one is a
`walk` from the deepest fixed prefix), reads every `<seg>.jsonl`, parses
each line, reinjects the locator from the path (`place`), skips damaged
lines into `damaged()`, collects, dedups by `eid` (§4.5), sorts into
canonical order, and yields.

### 5.2 Appending

As `SegmentedLog` today, per directory: appends go to the newest
segment this store minted under `locate(event)` (which is under
`devices/<self>/`), or a fresh `<uuidv7>.jsonl`; a first append heals a
segment that does not end in a newline by terminating the fragment
before writing. Appends are serialised per store instance, because
`VaultBackend.append` is size-then-write. The line written is the event
minus its locator below `author` (§3).

### 5.3 Ingesting

For each incoming event: validate; if the `eid` is already under
`devices/<author>/`, compare and count it duplicate or conflict;
otherwise append the line to a segment under `locate(event)` that
**this store minted for this `ingest` call**, never to a segment the
authoring device wrote, and never to one a previous ingest wrote. So a
merged folder may hold, under `devices/x/parts/…/`, both `0198…a.jsonl`
written by `x` and `0198…b.jsonl` written here from what `x` wrote.
Both contain only events authored by `x`; readers union by `eid`, so
nothing is doubled. An ingest segment is closed when the call ends and
holds its events in the order they came, which is no order at all
(§4.3).

**Fast path.** When the source is itself a folder (a backup zip, another
`.estoc/` directory), the store may copy whole segments instead: a
segment absent here is copied; a segment present on both sides where one
is a prefix of the other is replaced by the longer; a pair that is
neither is "two writers sharing one dev" and stops the import. This is
`vault-format-2.md` §12 verbatim, and it is only an optimisation of
§4.2: the event set that results is the same as ingesting line by line.
The copy does not read what it copies, so a conflict it brings in is
met by the next reader (§4.5) rather than by the import; a store that
only ever ingests through the interface is conformant and reports it at
import instead.

### 5.4 Changes

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

### 5.5 The rest

Blobs are what they are today. `Files` is the backend's read/write/list
over every path in the snapshot that is not under `devices/*/` or
`blobs/`. `local/` is the folder store's own (self, options, cache,
trace) and is neither an event nor exported. `snapshotVault` becomes
"everything under `.estoc/` except `local/`", as §12 there, and is also
the rendering a non-folder store must produce (§7.1).

## 6. A database store

Not proposed for implementation now; written to show the seam holds.

### 6.1 Shape

One table, the locator as columns, the payload as JSON, and two columns
the folder gets for free from the file system — which segment an event
belongs to and the order it arrived in:

```sql
CREATE TABLE events (
  seq      INTEGER PRIMARY KEY,     -- arrival order; the token
  eid      TEXT NOT NULL UNIQUE,
  author   TEXT NOT NULL,
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,
  scope    TEXT NOT NULL,           -- me | contact | part
  cid      TEXT,                    -- scope = contact
  my_key   TEXT,                    -- scope = part
  peer_key TEXT,                    -- scope = part
  seg      TEXT NOT NULL,           -- the segment this event is exported in; assigned once
  data     TEXT NOT NULL            -- the payload, JSON
);
CREATE INDEX events_part  ON events (my_key, peer_key, at, eid);
CREATE INDEX events_cid   ON events (cid, at, eid);
CREATE TABLE blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY, bytes BLOB NOT NULL);
```

`seg` is what §3 says a non-folder store must remember. `append` uses
the segment the store currently holds open for `(self, locate(event))`,
minting one the first time it writes to a directory and rotating on
whatever policy it likes; `ingest` mints one per directory per call, as
§5.3. Once assigned, `seg` never changes, and rows within a segment are
exported in `seq` order; that is what makes two exports of one store
prefix-related file by file (§7.1). `append` and `ingest` are `INSERT`
with the `UNIQUE` on `eid` catching duplicates, which the store then
compares for conflict; `scan` is a `SELECT` with the filter as `WHERE`
and `ORDER BY at, eid`; `changes` takes `token = MAX(seq)` and selects
`seq > since AND seq <= token ORDER BY seq`. Blob write and skeleton
append become one transaction, which the folder store cannot offer (it
orders them: blob first, then the line, §7.3 there). Collection (§10.3
there) is one query over `data` for referenced hashes.

### 6.2 Where it would run

- **Node** (daemon, CLI): `node:sqlite` is built in from Node 22.5
  (experimental at 22.13, what the repository runs on). No native
  dependency. The mediator already runs this pattern (`SqlStore` over
  `better-sqlite3` / D1).
- **Browser** (app): the app is not cross-origin isolated (no
  COOP/COEP headers anywhere in `app/` or the mediator that serves it),
  which rules out the official `sqlite-wasm` OPFS VFS as it stands; the
  `opfs-sahpool` VFS needs no isolation but allows one connection,
  which fits the single-worker model the app already enforces with Web
  Locks. **IndexedDB** is the other candidate and needs no wasm: one
  object store keyed by `eid` with an autoincrement `seq` and indexes on
  `[my_key, peer_key, at, eid]`, `[cid, at, eid]`; the app already
  depends on `idb`. Same interface, no SQL. Whether either is worth it
  is a question for when a fold is too slow to run at open, not before.

### 6.3 What it must still do

Render a folder (§7.1) for backup, and read one (§7.2) for restore or
merge, because the folder is the interchange format and the sovereignty
contract. A database store that cannot round-trip (§3) is not a vault.

## 7. Exchange

### 7.1 Export: rendering a folder

A store renders its whole event set as a `vault-format-2.md` tree: each
event to `locate(event)/<seg>.jsonl`, where `<seg>` is the segment the
store assigned it (§3, §6.1), minus its locator below `author`, one
line each, in the
order they arrived within the segment; blobs to `blobs/<hash>`; every
path in `Files` in place. A folder store exporting is a copy and keeps
its own names.

Because a segment's assignment never changes, the order within it never
changes, and a segment only grows, two exports of one store are
prefix-related file by file, which is what a folder merging both
requires (§12 there). An earlier draft named export segments by the
uuidv7 of the first event in each directory, sorted by `eid`, and kept
no state; it is withdrawn, because an old event arriving late (§4.2)
would land in the middle of a same-named file and be read as two
writers. The state a store must keep is one segment name per event, and
there is no stateless rule that does the job.

An export is always the whole set. A store does not export by filter,
so a device's directory always travels with its `device.minted` (§8).

### 7.2 Import: reading a folder

Three kinds of thing, three rules, in this order:

1. **Events.** `place` every line of every segment under `devices/*/`
   and `ingest` the result (§4.2), or take the folder fast path (§5.3).
   `devices/<self>/` is never written by an import (§12 there). A
   device directory that arrives without its `device.minted` is read
   — its events are still that device's — and reported as incomplete.
2. **Blobs.** After the events, by the rule of `vault-format-2.md` §12:
   fold the union of skeletons and erases, copy a blob absent here iff
   it is not collectable over that union. An erased blob never comes
   back.
3. **Files**, each by its own policy:
   - `config.json` must be identical on both sides; the anchor check is
     what makes this a merge rather than a restore, and a differing
     `version` is refused (§13 there). Both checks are above the store,
     as they are today in `importVault`.
   - `keystore.json` is a cache (§5 there): merged by union of its
     `keys[]`, and rebuildable from every device's `me/` regardless.
   - `state/` as v1 §6.7.
   - Any other path: copied when absent, never overwritten.
   - `local/` is not in a snapshot and is not touched.

Restore is the same three steps into an empty store, `config.json`
written last, as today.

### 7.3 Cache

`local/cache/` is a projection, kept with the `Token` it was folded to.
On open, `changes(filter, token)` yields what arrived since and the fold
advances, in arrival order, which the folds of §9 there are built to
accept (§4.4); a rejected token means the cache belongs to another store
and the fold restarts from `scan(filter)`. A cache is itself a store of
the projection's choosing; the app's is IndexedDB today for keys, and
nothing says it cannot hold the folds.

This is the one place a database is plainly right and costs nothing:
the cache is rebuildable, so its store needs no round trip, no
interchange format, and no promise beyond "delete me and I come back".

## 8. Applied to `vault-format-2.md`

Folded into the format in the same change as this revision:

1. **Rule 3** keeps *every event under `devices/<dev>/` was authored by
   `dev`* and replaces "a merge is a copy" with: a device appends only
   to segments it minted; a segment is edited or truncated by nobody
   but its writer; a merge may add segments under any device's
   directory, holding only that device's events (§5.3 here).
   Authorship is the `author` field; the path is where a folder keeps
   it.
2. **Rule 8**, *the folder is one serialization of the event set*: a
   program reads and writes events through the interface here; any
   store that round-trips the folder is a conforming vault.
3. **§4 Segments** gains the importer's segment, and that a segment
   says nothing about the event in it.
4. **`devices/<dev>/device.json` is gone.** It was an immutable
   `{ dev, mintedAt }`, which is an event: `device.minted`, the first
   line a device writes in its own `me/` (§8.1 there). This closes
   exchange — a device's existence travels with its events and needs
   no side channel — and makes "two writers sharing one `dev`" visible
   as two `device.minted` under one directory instead of two files
   that differ. `Files` (§4) therefore holds nothing per device.
5. **§7.1**: "`direction` is the event type and `sender` is the
   partition; neither is a field" stays true of the *line*; in memory
   the partition is the `myKey` / `peerKey` fields of the event (§3
   here).
6. **§12 Import** is restated as `ingest` with the file-copy rules kept
   as the fast path; one `eid` with two contents joins non-prefix
   segments as the two-writers signal; the files rule is spelled out
   (§7.2 here); the cache keeps a change token rather than a
   per-segment cursor (§4.4 here).
7. **§14** names the three two-writers signals.
8. **§4 `eid`** is a bare uuidv7, no device suffix, and `author` is a
   field on every line. The suffix had two jobs: it let a line that
   omitted `author` still say who wrote it, and it let the old
   per-device cursor read a device out of an id. The cursor is gone
   (§4.4), and the first job is done more honestly by writing the
   field. An id that encodes a fact is what rule 2 there argues
   against, and `mid` and `cid` were already trusted bare.

## 9. Feasibility, as surveyed

What the code says today, for the record:

- **Consumers are already above bytes.** agent-core touches the vault
  through about fifteen methods on six objects (`contacts.{all, byCid,
  byDid, put, remove}`, `invitations.{all, byId, byDid, put, remove}`,
  `messages.{read, append}`, `deliveries.{read, append}`, `blobs.{get,
  put}`, `trace.*`, `config.*`) and never a path. The app constructs an
  `OpfsBackend` in its worker and otherwise imports types. The daemon's
  RPC is already a projection (`Snapshot` plus `message` / `delivery` /
  `contact` pushes). Moving the seam up changes `@estoc/vault`'s inside
  and `Vault`'s shape, which version 2 changes anyway.
- **Ingest has a precedent.** v1's `mergeLog` reads every existing
  record for its keys, then writes what is new into a fresh segment. It
  is `ingest` with the dedup key spelled per log; v2's single `eid`
  makes it one routine for every log.
- **`VaultBackend` stays.** OPFS (`createWritable` atomic on close,
  append as size-then-seek), Node `fs`, and memory: 330 lines, unchanged.
  The folder store sits on it. Neither `fs` nor OPFS syncs on append
  today, which is what §4.1 promises no more than.
- **Runtimes.** Node 22.13 has `node:sqlite`; the browser has `idb`
  and no wasm SQLite; the app is not cross-origin isolated (§6.2).
- **Size.** Today's five stores plus `transfer.ts` are about a thousand
  lines. A folder store (`locate`/`place`, segments, ingest with fast
  path, the segment-table token) is a few hundred; the rest becomes
  folds, which version 2 needs regardless. The reduction is real but
  modest; the gain is one merge routine, one place that knows the tree,
  and a store per runtime.

## 10. Open

- **Ingest segment granularity.** One segment per directory per
  `ingest` call (§5.3) means many small merges leave many small files.
  Compacting a store's own ingest segments would be the obvious answer
  and is forbidden as rule 7 there is worded; whether the rule should
  distinguish a segment the store minted for ingest from one a device
  wrote is a question for when the file count is felt.
- **Filter surface** (§4.3): `mid` and `thid` are tempting. Kept out;
  the cache answers them.
- **`fsync` on Node** (§4.1): a per-append `fsync` in `FsBackend` would
  let the daemon claim power-loss durability. Cheap; not decided.
- **Daemon RPC.** Once the store is the interface, the daemon could
  expose `changes(since)` and push events rather than records, and the
  app's cache could be an IndexedDB store fed by it. Not this
  document's call.
- **Device-to-device sync** (§4.4): anti-entropy over `eid` sets, its
  own design; nothing here should have to change for it beyond what
  `vault-format-2.md` §14 already says.
- **Trace.** Stays a `SegmentedLog` under `local/trace/`; it has its own
  retention and is never exchanged. Whether it should implement the same
  interface for uniformity is a code question.
