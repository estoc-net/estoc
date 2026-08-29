# The vault as an event store — draft

Status: **draft**, 2026-08-29. The first of three documents that
together replace `vault-format-2.md`:

- **this one** says what a vault *is* to a program: the event, the
  store interface, and what every store must guarantee whatever it is
  made of;
- `vault-folder.md` says how a version-2 `.estoc/` folder serializes
  that store — the mapping in both directions, folder → store and
  store → folder — and is the exchange form every store must read and
  write;
- `vault-events.md` says what the events *mean*: the types a vault
  records, in which scope, and the folds that turn them into contacts,
  threads and addresses.

Dependency runs one way. The folder implements this document; the
events are written on top of it; the folder and the events do not know
each other except through here. Someone extending the vault reads this
document and the naming conventions of `vault-events.md`; someone
reading a backup with a text editor reads `vault-folder.md`.

## 0. Why

`@estoc/vault` today is written against bytes: five stores
(`ContactStore`, `InvitationStore`, `MessageLog`, `DeliveryLog`,
`BlobStore`) each own a directory, each know its file names, and
`importVault` merges by classifying paths. Every store is a small
database with one table, and the merge is five merges. When a caller
asks "what happened to this contact", the answer is spread across three
of them.

Looked at as a database, the whole vault is **one table**. Each
directory level of the folder — device, scope, the keys of a partition
— is a column; a segment is a page; a merge is `INSERT OR IGNORE`. The
folder is a serialization of that table, chosen because copying a
subtree is free on a file system. Nothing in the model depends on the
choice.

So the program's interface should be the table, not the folder. Folds
read events through a filter; policy appends events; the store behind
the interface is a folder on OPFS or disk, an in-memory set for tests,
or a database where one is cheaper. Swapping the store touches nothing
above the seam, and the folder stays the interchange format every store
must be able to read and write.

## 1. Three documents

| document | defines | reads |
|----------|---------|-------|
| `event-store.md` | the event (§3), ids and order (§4), the store (§5), blobs and files (§6), exchange (§7) | — |
| `vault-folder.md` | the tree, `locate` / `place`, segments, singletons, the folder store, snapshot and import as file operations | this |
| `vault-events.md` | every event type, per scope; folds; erasing; deleting | this |

What is *not* here: no path (`vault-folder.md`), no event type, no fold
(`vault-events.md`), and not the trace log, which is local and stays a
log of its own.

## 2. Principles

Version 1 had six rules (`vault-format.md` §2); the draft that preceded
these three documents had eight. Sorted by layer, these are the ones
that hold for every store. `vault-folder.md` §2 has the ones about
files; `vault-events.md` §1 the ones about meaning.

1. **A vault is events, blobs and files.** *Events*: immutable,
   appended, unioned, folded. *Blobs*: bytes named by their hash,
   unioned, the only thing ever unlinked. *Files*: the few singletons
   that are neither — the format and anchor, the key cache, reserved
   state. Nothing is a record: where v1 rewrote a small JSON file whole,
   v2 appends an event and folds.
2. **Ids are minted, never computed, and encode nothing.** An `eid`
   says nothing about who wrote it; a key name says nothing about the
   contact it was minted for. What a thing is *for* is an event about
   it. The one exception is made where it is needed and says why: the
   partition id (`vault-events.md` §3) is computed, because it must
   come out the same on every device.
3. **Authorship is the `author` field.** Every event says which device
   wrote it, and a device writes only as itself. Nothing else about an
   event's origin is recoverable, and nothing needs to be.
4. **Events are never deleted.** Not by a store, not by a merge, not by
   the person. An absence of meaning is a later event
   (`vault-events.md` §8); an absence of bytes is a blob's, never an
   event's.
5. **Conflicts are projections.** Two devices deciding differently
   produce two events, not an error; a fold shows both; a later event
   resolves them. A store never chooses between events it holds. The
   one thing it refuses is two *contents* under one `eid` (§5.5), which
   is not two decisions but one broken.
6. **Folds are functions of the set.** `now` and `self` are parameters;
   a setting that affects a fold is an event; the order events are
   applied in does not change the result. Tests: incremental = full;
   shuffled = same; merge(A,B) = merge(B,A). This is what makes
   `changes` (§5.4) safe to fold from, and why nothing here promises an
   order except on `scan`.
7. **The folder is one serialization.** A program reads and writes
   events through the interface here, never a path. `vault-folder.md`
   is the reference store and the exchange form; any store that
   round-trips it (§7.1) is a conforming vault.

## 3. The event

An event is a JSON object. Every event has:

| field    | meaning |
|----------|---------|
| `eid`    | a bare uuidv7 (§4): minted at append, the dedup key; the same kind of id as `mid` and `cid`. |
| `at`     | RFC 3339 UTC (§4). |
| `type`   | the event type, as `vault-events.md` specifies per scope. |
| `author` | the authoring device (§4). A field, on the event wherever it is; nothing is parsed out of `eid`. |
| `scope`  | one of `me`, `contact`, `part`: which family of log. |

and, by scope, the rest of its **locator**:

| scope     | locator fields      | holds |
|-----------|---------------------|-------|
| `me`      | (none)              | what a device says about the identity and itself |
| `contact` | `cid`               | decisions about one contact |
| `part`    | `myKey`, `peerKey`  | observations involving one key of ours and one of theirs |

`author` and `scope` are locator fields too. Together they are the
**Locator**: everything that says *where* an event is, and nothing that
says what it is. The rest of the object is the event's **payload**: the
event's own fields, as specified per type.

**The partition scheme.** The three scopes are the one thing the store
knows about the vault's shape, and it knows the shape, not the meaning:
which types belong in which scope, and what a `cid`, a `myKey` or a
`peerKey` is, are `vault-events.md`'s (§2–3 there). The scheme lives
here rather than there because it is what a store filters, erases,
exports and — one day — syncs by, and because typing it as a union is
what lets a caller never spell a path. A store that had to be generic
would carry an opaque scope and a key list instead; this one is the
vault's store, and says so.

**Reserved names.** `eid`, `at`, `type`, `author`, `scope`, `cid`,
`myKey`, `peerKey` belong to the envelope; a payload must not use them,
and a store rejects an event whose payload does. `dev` is *not*
reserved: `device.label { dev }` and `device.retired { dev }` name the
device a decision is about, which is payload, and is why the locator's
authorship field is called `author` and not `dev`.

Rules:

1. **The locator is on the event.** Every event carries its full
   locator as fields. Nothing about where an event belongs has to be
   recovered from state; this is what partitioning on observed keys
   rather than on `cid` (`vault-events.md` §3) bought, and it is what
   makes a flat table with a `WHERE` clause a correct reading.
2. **`author` is authorship.** The `author` field is the only statement
   of who wrote an event, and a store appends only as its own `self`
   (§5.1). A serialization that also keeps events by author (the folder
   does, by directory) must agree with the field and refuse a line
   where they differ. Authorship is the field, not the id: `eid` says
   nothing about who wrote the event, exactly as `mid` says nothing
   about who received the message.
3. **The store validates the envelope and nothing else.** On `append`
   and `ingest` it checks that the object is a JSON object; that `eid`
   is a well-formed uuidv7; that `at` is RFC 3339 UTC; that `type` is a
   non-empty string; that the locator is complete for its `scope`; and
   that no reserved name is used by the payload. An event that fails is
   rejected — `append` throws, `ingest` reports (§5.2) — and never
   stored. The payload is opaque: type-specific validation is the
   fold's. Bytes a serialization holds that do not parse as an event at
   all are a *damaged* line (§5.5), reported, not stored.

## 4. Identity, time, order

- **`author`** — a device id: 6 characters of lowercase RFC 4648
  base32, minted by a store the first time it opens (or creates) a
  vault and finds no record of which device it is. The store keeps that
  record locally (`vault-folder.md` §6.4) and exposes it as `self`
  (§5); it is not part of the event set and does not travel in a
  backup, so a restore mints a fresh one and keeps the old device's
  events as history. Not secret. A device announces itself with its
  first event, `device.minted` (`vault-events.md` §5), so a device's
  existence travels with its events and needs no side channel.
- **`eid`** — every event's id: a bare uuidv7, the same kind of id as
  `mid` and `cid`, and like them trusted to be unique across devices.
  The dedup key for everything. Minted at the instant the event is
  appended, so it and the event's `at` agree within a device.
- **`at`** — RFC 3339 UTC, from the same clock as the `eid`, as v1 §4.
  A wall clock: it can step back, even on one device.
- **Canonical order** — wherever a fold orders events — a thread by
  time, a latest-wins field — it orders by `at`, then `(eid, author)`
  as the total tiebreak. One rule; `vault-events.md` refers back to it.
  `scan` (§5.3) yields in this order and sorts to produce it: no
  container of events — segment, file, table — is ever assumed to be in
  it.
- **`cid`**, **`mid`**, mediation `id`, key `id` — uuidv7, as v1.
  Wire ids and time as v1 §4.

## 5. The store interface

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
  rejected: Rejected[];               // failed envelope validation (§3 rule 3)
}

interface EventStore {
  /** Which device this store appends as (§4). */
  readonly self: string;
  /** This device's own event. The store mints eid and at, sets author = self, returns the whole event. */
  append(draft: Draft): Promise<Event>;
  /** Events from elsewhere (a backup, another store, another device). Union by eid. */
  ingest(events: AsyncIterable<Event>): Promise<Ingested>;
  /** Every event matching `filter`, in canonical order. */
  scan(filter?: Filter): AsyncIterable<Event>;
  /** What this store gained after `since`, in arrival order, up to `token`. */
  changes(filter?: Filter, since?: Token): Promise<{ token: Token; events: AsyncIterable<Event> }>;
  /** Bytes met in storage that could not be read as events; for the caller to surface. */
  damaged(): DamagedLine[];
  /** Eids met with more than one content; for the caller to surface. */
  conflicting(): Conflict[];
}
```

Anything above the store — folds, policy, an application — sees the
whole `Event` of §3 and never a path or a segment. Where a store keeps
an event, and in what bytes, is the store's own and is what
`vault-folder.md` specifies for the folder.

### 5.1 `append`

Takes a draft, sets `author` to `self`, mints the uuidv7 at that
instant and `at` from the same clock, and writes the event. The store
mints because the id is minted *at append* (§4) and that is the only
way to keep one device's ids monotone: a caller that minted its own
could hand over an old one. The whole event is returned; a caller that
needs the `eid` (to cite it in a later event) takes it from there.

When the promise resolves the event is written whole: a later reader
sees all of it or none of it; a partial write is *damaged* (§5.5),
skipped, and never fused with what follows it. This holds across a
crash of the process. Whether it holds across power loss is the
backend's property and is stated by the backend, not promised here:
Node's `appendFile` does not `fsync`, and OPFS offers no control over
when bytes reach the medium. A backend that wants the stronger claim
makes it itself (an `fsync` per append on Node is cheap at this write
rate) and says so.

Appends from one store instance are ordered; two instances over one
serialization are the caller's problem, as today (Web Locks in the app,
one daemon on disk).

### 5.2 `ingest`

Takes events from anywhere, authored by anyone, in any order; validates
each envelope (§3 rule 3); and adds those whose `eid` is not already
present. An `eid` already present with the same content is a
*duplicate* and is skipped; with different content it is a *conflict*:
the store keeps what it had, stores nothing, and reports it. Never
rewrites, never drops, never reorders what was there. This is the whole
of merge at the event level; the file-level rules a folder may use to
do it faster are `vault-folder.md` §8.3, and produce the same set.

Nothing about the authoring device's order survives ingest. A backup
made by filter, a second backup that fills in what the first lacked, a
store fed by another store's `changes` — each can deliver an old event
after a newer one from the same author. This is why there is no
per-device cursor (§5.4).

`ingest` is not import. Import is ingest plus blobs plus files, in that
order (§7.3); and after a merge the application still does what it does
today — folds, and `held`s every outbound whose delivery is not `sent`
(`vault-events.md` §10). That is a decision made on the merged set,
appended by `self`, and no store's business.

### 5.3 `scan`

Yields the store's whole event set, filtered: events whose locator
fields equal every field given in `filter`, and whose `type` equals
`filter.type` if given. One event per `eid` (conflicts resolved as
§5.5). Order is canonical (§4).

**The store sorts.** No segment, file or table is assumed to be in
canonical order, and a reader never merges pre-sorted streams: `at` is
a wall clock and can step back even on the authoring device, an
ingested batch holds whatever order the events came in, and a database
sorts in the query anyway. A vault's event set fits in memory; the cost
of sorting it is not what any fold waits on.

The filter is deliberately small: locator fields and `type`. A database
store could answer richer questions; the folder store can only scan. A
question the filter cannot ask (a thread by `thid`, a message by `mid`,
"everything about this contact across partitions") is a fold, and lives
in the cache (§7.4), so no store is asked to be a query engine.

### 5.4 `changes`

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
everything the caller has folded can arrive late (§5.2), and `changes`
delivers it when it arrives. So an incremental fold must not depend on
the order events are applied — principle 6 (shuffled = same) applied
one event at a time — and a fold that cannot promise that refolds from
`scan`. The folds of `vault-events.md` §7 are functions of the set and
qualify; the property is stated here because `changes` is what makes
it load-bearing.

A token is a string a caller stores and hands back, and nothing more. It
belongs to the store that issued it: a folder store's names segments and
lengths, a database's names a sequence number, and neither means
anything to the other. A token the store cannot place — a position past
what it holds, another store's — is answered by rejecting the call, and
the caller answers that by refolding from `scan`. Because events are
never deleted (principle 4), a token a store issued is always one it
can place, so a rejection means the cache belongs to some other store,
which is exactly when a refold is right.

What `changes` is not: a device-to-device sync. "What do you have that I
do not" between two vaults is anti-entropy over `eid` sets and is
designed on its own when it is designed; it does not reuse this token,
which is local, and the old per-device high-water mark it might have
suggested is wrong for the reason in §5.2.

### 5.5 Damage and conflict

**Damaged lines** are what a store finds in its own storage and cannot
read (`DamagedLine` as today: where, the text, the error). They are
reported, never stored, never counted anywhere. A database store has
none by construction; a folder store meets them after a crash or a
careless edit.

**Conflicts** are two contents under one `eid`. `ingest` finds them
against what it holds and reports them (§5.2). A reader can also meet
them, because a serialization may come to hold one `eid` twice through
a copy that did not read what it copied (`vault-folder.md` §8.3): the
store then keeps one by a fixed rule of its own, stated where the
store is (the folder's is `vault-folder.md` §8.5), yields that one from
`scan` and `changes`, and reports the others in `conflicting()`. The
rule exists so that every reader of one store agrees; it is not a
judgement about which is right. A conflict is evidence of two writers
sharing one `author` (`vault-folder.md` §11), and what the application
shows.

## 6. Blobs and files

```ts
interface BlobStore {                 // content-addressed; as today
  get(hash): Promise<Uint8Array | null>;
  has(hash): Promise<boolean>;
  put(hash, bytes): Promise<void>;
  unlink(hash): Promise<void>;
  list(): Promise<string[]>;
}

interface Files {                     // everything in a vault that is neither an event nor a blob
  read(path): Promise<Uint8Array | null>;
  write(path, bytes): Promise<void>;
  list(): Promise<string[]>;
}
```

A vault, to a program, is `{ events: EventStore, blobs: BlobStore,
files: Files }` plus the trace log. `Vault` in `@estoc/vault` holds
these three and the key-minting it does today; the five stores go,
replaced by folds over `events.scan(...)` and `events.changes(...)`.

**Blobs** are bytes named by `sha256`, lowercase hex; immutable, merged
by union, deduplicated by construction, and the one thing in a vault
that is ever unlinked (`vault-events.md` §8). Which events name which
blobs, and when a blob may go, is the events' business; the store only
promises that a hash it holds returns the bytes it was given.

**A blob is written before the event that names it.** A crash between
the two leaves an orphan blob — harmless, collectable
(`vault-events.md` §8.3). The other order is never used: an event whose
blob was never written would be indistinguishable from an erase. A
store that can make the two one transaction (§8) may; a folder cannot
and orders them.

**Files** are named by path, and the paths are the folder's
(`vault-folder.md` §6): the format and anchor, the key cache, reserved
state, and any path a reader does not understand and carries along.
There is no per-device file: everything about a device is an event.
Each file has its own merge policy, stated with the file; the store
applies none of them (§7.3).

## 7. Exchange

### 7.1 The exchange form

Every store must be able to render its whole vault as a version-2
folder and read one back. The folder is the interchange format and the
sovereignty contract: a backup is a folder in a zip, a merge is a folder
read into a store, and a reader with a text editor is a conforming
reader. `vault-folder.md` §4 gives the mapping in both directions:
`locate(event)` — where in the tree an event goes — and `place(path,
line)` — the event a line under a path is.

**Round trip.** For any event set *S* produced by any conforming store,
rendering *S* as a folder and reading that folder back yields *S*: same
events, same fields, compared as JSON objects with `eid` as identity.
Blobs and files round-trip byte for byte. This is the conformance test
every store passes, and the definition of "a version-2 vault" that is
independent of the medium.

### 7.2 Export

A store renders its whole event set as the tree, one line per event, in
the segment the store assigned the event; blobs as blobs; every path in
`Files` in place. A folder store exporting is a copy and keeps its own
names.

**A segment is assigned once and grows only at its end.** A segment is
not part of an event's identity — a program never sees one — but it is
part of a store's state, because the folder merges by segment
(`vault-folder.md` §5, §8.3): two exports of one store must be
prefix-related file by file, or a folder merging both would read them
as two writers. So a store that is not a folder remembers, per event,
the segment it belongs to, and renders the events of a segment in the
order they arrived. An earlier draft named export segments by the
uuidv7 of the first event in each directory, sorted by `eid`, and kept
no state; it is withdrawn, because an old event arriving late (§5.2)
would land in the middle of a same-named file and be read as two
writers. The state a store must keep is one segment name per event, and
there is no stateless rule that does the job.

An export is always the whole set. A store does not export by filter,
so a device's events always travel with its `device.minted`.

### 7.3 Import

Three kinds of thing, three rules, in this order:

1. **Events**: `ingest` every event the folder holds (§5.2), or take
   the folder's fast path (`vault-folder.md` §8.3), which produces the
   same set. The store never ingests into `self`'s own events. A
   device whose events arrive without its `device.minted` is read — its
   events are still that device's — and reported as incomplete.
2. **Blobs**, after the events: a blob absent here and present there
   is copied iff it is not collectable over the merged event set
   (`vault-events.md` §8.3). An erased blob never comes back. The rule
   is the events'; the order — events first — is what makes it
   answerable.
3. **Files**, each by its own policy (`vault-folder.md` §6). The one
   the store must know about is that the format and anchor must be
   identical on both sides — that check is what makes this a merge
   rather than a restore, and it is made above the store, as today in
   `importVault`.

**Restore** is the same three steps into an empty store, the format
and anchor written last, as today. There is no `self`, so the first
open mints a device (§4); the imported devices stay as history.

### 7.4 Cache

A fold's result is a projection, kept locally with the `Token` it was
folded to. On open, `changes(filter, token)` yields what arrived since
and the fold advances, in arrival order, which the folds of
`vault-events.md` are built to accept (§5.4); a rejected token means the
cache belongs to another store and the fold restarts from
`scan(filter)`. A cache is itself a store of the projection's choosing;
the app's is IndexedDB today for keys, and nothing says it cannot hold
the folds.

This is the one place a database is plainly right and costs nothing:
the cache is rebuildable, so its store needs no round trip, no
interchange format, and no promise beyond "delete me and I come back".

## 8. A database store

Not proposed for implementation now; written to show the seam holds.

### 8.1 Shape

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

`seg` is what §7.2 says a non-folder store must remember. `append`
uses the segment the store currently holds open for `(self,
locate(event))`, minting one the first time it writes to a locator and
rotating on whatever policy it likes; `ingest` mints one per locator
per call, as the folder does (`vault-folder.md` §8.3). Once assigned,
`seg` never changes, and rows within a segment are exported in `seq`
order; that is what makes two exports of one store prefix-related file
by file. `append` and `ingest` are `INSERT` with the `UNIQUE` on `eid`
catching duplicates, which the store then compares for conflict; `scan`
is a `SELECT` with the filter as `WHERE` and `ORDER BY at, eid, author`;
`changes` takes `token = MAX(seq)` and selects `seq > since AND seq <=
token ORDER BY seq`. Blob write and skeleton append become one
transaction, which the folder store cannot offer (§6). Collection
(`vault-events.md` §8.3) is one query over `data` for referenced hashes.

### 8.2 Where it would run

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

### 8.3 What it must still do

Render a folder (§7.2) for backup, and read one (§7.3) for restore or
merge, because the folder is the interchange format and the sovereignty
contract. A database store that cannot round-trip (§7.1) is not a
vault.

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
  today, which is what §5.1 promises no more than.
- **Runtimes.** Node 22.13 has `node:sqlite`; the browser has `idb`
  and no wasm SQLite; the app is not cross-origin isolated (§8.2).
- **Size.** Today's five stores plus `transfer.ts` are about a thousand
  lines. A folder store (`locate`/`place`, segments, ingest with fast
  path, the segment-table token) is a few hundred; the rest becomes
  folds, which version 2 needs regardless. The reduction is real but
  modest; the gain is one merge routine, one place that knows the tree,
  and a store per runtime.

## 10. Open

- **Filter surface** (§5.3): `mid` and `thid` are tempting. Kept out;
  the cache answers them.
- **`fsync` on Node** (§5.1): a per-append `fsync` in `FsBackend` would
  let the daemon claim power-loss durability. Cheap; not decided.
- **Daemon RPC.** Once the store is the interface, the daemon could
  expose `changes(since)` and push events rather than records, and the
  app's cache could be an IndexedDB store fed by it. Not this
  document's call.
- **Device-to-device sync** (§5.4): anti-entropy over `eid` sets, its
  own design; nothing here should have to change for it beyond what
  `vault-folder.md` §11 already says.
- **Extensions.** A handler or renderer that keeps state of its own
  would keep it as events, in a `type` namespace of its own, through
  this interface and nothing lower. What that namespace looks like
  (a URI, a reverse-DNS prefix), whether a scope of its own is needed,
  and what an extension may `append` (by `type` prefix, presumably) is
  not decided; the interface is shaped so that the answer is a
  convention on `type`, not a change here.
- **Trace.** Stays a `SegmentedLog` of its own, local, with its own
  retention, never exchanged. Whether it should implement the same
  interface for uniformity is a code question.
