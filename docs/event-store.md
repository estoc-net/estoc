# The vault as an event store — draft

Status: **draft**, 2026-08-29. The first of three documents that
together replace `vault-format-2.md`:

- **this one** says what a vault *is* to a program: the event, the
  store interface, and what every store must guarantee whatever it is
  made of;
- `vault-folder.md` says how a version-2 `.estoc/` folder serializes
  that store — the mapping in both directions, folder → store and
  store → folder — and is the interchange format every store must read
  and write;
- `vault-events.md` says what the events *mean*: the types a vault
  records, what each carries, and the folds that turn them into
  contacts, threads and addresses.

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

Looked at as a database, the whole vault is **one table**. The device
directory is one column and every field of a line is another; a
segment is a page; a merge is `INSERT OR IGNORE`. The folder is a
serialization of that table, chosen because a person can read it with
nothing but a text editor. Nothing in the model depends on the choice.

So the program's interface should be the table, not the folder. Folds
read events through a filter; policy appends events; the store behind
the interface is a folder on OPFS or disk, an in-memory set for tests,
or a database where one is cheaper. Swapping the store touches nothing
above the seam, and the folder stays the interchange format every store
must be able to read and write.

## 1. Three documents

| document | defines | reads |
|----------|---------|-------|
| `event-store.md` | the event (§3), ids and order (§4), the store (§5), blobs and files (§6), interchange (§7) | — |
| `vault-folder.md` | the tree, `locate` / `decodeEvent`, segments, singletons, the folder store, snapshot and import as file operations | this |
| `vault-events.md` | every event type and what it carries; channels; folds; erasing; deleting | this |

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
   unioned, the only thing ever unlinked. *Files*: everything that is
   neither, and among them the singletons — the format and anchor, the
   key cache, reserved state. Nothing is a record: where v1 rewrote a small JSON file whole,
   v2 appends an event and folds.
2. **Ids are minted, never computed, and encode nothing.** An `eid`
   says nothing about who wrote it; a key name says nothing about the
   contact it was minted for. What a thing is *for* is an event about
   it. A channel (`vault-events.md` §3) has no id at all: it is the two
   key fields an observation carries, and two devices agree on it
   because the envelope proved the same keys to both.
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
   is the reference store and the interchange format; any store that
   round-trips it (§7.1) is a conforming vault.

## 3. The event

An event is a JSON object. Four fields are the **envelope**, which the
store reads; a fifth, optional, the store checks and never reads:

| field    | meaning |
|----------|---------|
| `eid`    | a bare uuidv7 (§4): minted at append, the dedup key; the same kind of id as `mid` and `cid`. |
| `at`     | RFC 3339 UTC (§4). |
| `type`   | the event type, a non-empty string; `vault-events.md` names the vault's own. |
| `author` | the authoring device (§4). |
| `blobs`  | optional: every blob this event references, as hashes (§6). The complete list — a hash anywhere else on the event is not a reference. |

Everything else is the **payload**: the event's own fields, as
specified per type, opaque to the store. What an event is *about* — a
contact, a key, a device, a message, the pair of keys an envelope
proved — is a payload field naming it, and `vault-events.md` says
which. The store does not know the vault's shape at all. A channel
(`vault-events.md` §3) is two fields every observation carries and a
fold groups by, not a place in the store; a contact is a `cid` on a
decision, as a key is a `key` and a device a `dev`.

An earlier draft gave the store a **locator** — `scope`, `cid`,
`myKey`, `peerKey` — and mirrored it as directories. It was dropped
because nothing the store does needed it: every reader reads the whole
set (§5.3), a merge reads every line whatever its subject
(`vault-folder.md` §8.3), and the operations that might have wanted a
channel as a unit — erasing one,
syncing one — are not in version 2 and would not need directories if
they were. What the locator did do was multiply segments and tie the
store to one vault's shape.

`blobs` is in the envelope for one reader: collection
(`vault-events.md` §8.3), which must find every blob any event
references without understanding any event. With the list on the
envelope, an event of a type the collector has never seen — an
extension's — still says what it holds, and a store that unlinks by
this rule is safe for events it does not know. The store itself only
checks the field's shape. Type-specific fields may say which blob is
which (`body`, `attachments`), drawn from this list.

**Reserved names.** `eid`, `at`, `type`, `author`, `blobs` belong to
the envelope; a payload must not use them, and a store rejects an
event whose payload does. Nothing else is reserved: `device.label {
dev }` names the device a decision is about and `contact.petname { cid
}` the contact, and both are payload.

**JSON.** An event is a JSON object in the sense of RFC 8259: its
values are objects, arrays, strings, numbers, booleans and `null`, and
nothing else — no `undefined`, no bigint, no cycle, no `Date`. A draft
that does not survive JSON serialization unchanged is rejected by
`append`. Two events have the **same content** when they are
structurally equal as JSON: objects compared as unordered maps, arrays
in order, numbers as doubles, strings by code point. Key order is not
a difference, and neither is whitespace: a store that re-serializes on
export (§8) would otherwise turn every event it exported into a
conflict on the way back.

Rules:

1. **Everything about an event is on the event.** Which contact, which
   channel, which message a line concerns is a field of it; nothing
   has to be recovered from state or from where a store keeps it. This
   is what makes a flat table a correct reading, and what lets a line
   say what it is once it is apart from its store — in a report, a
   grep, a copy.
2. **`author` is authorship.** The `author` field is the only statement
   of who wrote an event, and a store appends only as its own `self`
   (§5.1). A serialization that also keeps events by author (the folder
   does, by directory) must agree with the field and refuse a line
   where they differ. Authorship is the field, not the id: `eid` says
   nothing about who wrote the event, exactly as `mid` says nothing
   about who received the message.
3. **The store validates the envelope and nothing else.** On `append`
   and `ingest` it checks that the object is a JSON object (above);
   that `eid` is a well-formed uuidv7; that `at` is RFC 3339 UTC; that
   `type` is a non-empty string; that `author` is a device id; that
   `blobs`, if present, is an array of hashes (§6); and that no other
   reserved name is used by the payload. An event that fails is rejected —
   `append` throws, `ingest` reports (§5.2) — and never stored. The
   payload is opaque: type-specific validation is the fold's. Bytes a
   serialization holds that do not parse as an event at all are a
   *damaged* line (§5.5), reported, not stored.

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
- **instance** — a random id a store mints together with `self` and
  keeps beside it (`vault-folder.md` §6.4). Not an event field, not in
  a backup. It names this copy of the store to the tokens it issues
  (§5.4): a fold takes `self` as a parameter, so a cache folded under
  one device must never be applied under another, and a restore that
  mints a fresh `self` mints a fresh instance with it.
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
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [field: string]: JsonValue };
type Hash = string;                   // sha256 of the bytes, lowercase hex

type Event = {
  eid: string;                        // a bare uuidv7
  at: string;                         // RFC 3339 UTC
  author: string;                     // a device id
  type: string;
  blobs?: Hash[];                     // every blob the event references; checked, never read, here
  [field: string]: JsonValue | undefined; // the payload; opaque here
};

/** What a caller hands to `append`: no eid, at, or author — the store mints them. */
type Draft = { type: string; blobs?: Hash[]; [field: string]: JsonValue | undefined };

/** Equality on top-level fields, by `===` on primitives: `null` matches a field present and null;
 *  `undefined` is no constraint. A store may index some; the folder store reads and compares. */
type Filter = { author?: string; type?: string; [field: string]: JsonPrimitive | undefined };

/** A position in this store instance's own arrival order. Opaque; meaningful only to the instance
 *  that issued it. Not an auth token: a checkpoint a caller keeps beside a fold. */
type ChangeToken = string;

interface Ingested {
  added: number;
  duplicates: number;                 // same eid, same content: skipped
  conflicts: Conflict[];              // same eid, different content: the store keeps what it had
  rejected: Rejected[];               // failed envelope validation (§3 rule 3)
}

interface EventStore {
  /** Which device this store appends as (§4). */
  readonly self: string;
  /** This device's own event. The store mints eid and at, sets author = self, returns the whole event. */
  append(draft: Draft): Promise<Event>;
  /** Events from elsewhere (a backup, another store, another device). Union by eid.
   *  Reads its whole input before writing; throws ForkedSelf, having written nothing,
   *  on an event of `self` it does not already hold (§5.2). */
  ingest(events: AsyncIterable<Event>): Promise<Ingested>;
  /** Every event matching `filter`, in canonical order. */
  scan(filter?: Filter): AsyncIterable<Event>;
  /** What this store gained after `since`, in arrival order, up to `token`. */
  changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }>;
  /** Bytes met in storage that could not be read as events; for the caller to surface. */
  damaged(): DamagedLine[];
  /** Eids met with more than one content; for the caller to surface. */
  conflicting(): Conflict[];
}
```

Anything above the store — folds, policy, an application — sees the
`Event` of §3 and never a path or a segment. A caller that wants the
vault's own types typed — a `MessageIn` with its pair, a
`ContactAttach` with its `cid` — declares them above the seam;
`vault-events.md` is that declaration in prose. Where a store keeps
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
of merge, at every level: the folder store does it in one pass over
the other copy (`vault-folder.md` §8.3), and there is no file-level
shortcut that produces the same set — an earlier draft had one and
withdrew it (§7.3).

`ingest` reads its whole input before it writes anything (a vault's
event set fits in memory, and the folder store has to read the other
copy whole anyway), because of `self`. Events authored by `self` can
legitimately arrive — a backup of this very device, merged back — and
each is a duplicate, counted and skipped. One that is *not* already
here, or is here with other content, means two writers have shared one
device: this copy was cloned with its `local/` and both went on
writing, or this copy lost events it once wrote. Either way the store
does not know which history is its own, so it stops before writing —
throws `ForkedSelf`, naming the events — and the person decides:
usually, this copy mints a fresh device (§4, `vault-folder.md` §6.4)
and imports again, after which the old device's events are history on
both sides. Silently skipping them would hide exactly the fault the
`author` field exists to expose (§3 rule 2).

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

Yields the store's whole event set, filtered: events whose top-level
fields equal every field given in `filter`. One event per `eid`
(conflicts resolved as §5.5). Order is canonical (§4).

**The store sorts.** No segment, file or table is assumed to be in
canonical order, and a reader never merges pre-sorted streams: `at` is
a wall clock and can step back even on the authoring device, an
ingested batch holds whatever order the events came in, and a database
sorts in the query anyway. A vault's event set fits in memory; the cost
of sorting it is not what any fold waits on.

The filter is equality and nothing more: no ranges, no joins, no
"across". A database store may index the fields it is asked about most
(`author`, `type`, a channel's pair); the folder store reads
everything and compares, and is no slower for it than it is at reading
everything. A question equality cannot ask (a thread by time,
everything about one contact across its channels) is a fold, and
lives in the cache (§7.4), so no store is asked to be a query engine.

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
belongs to the store *instance* that issued it (§4), and names that
instance: a folder store's names its instance, its segments and their
lengths; a database's names its instance and a sequence number; and
neither means anything to the other. A token the store cannot place —
another instance's, a position past what it holds — is answered by
rejecting the call, and the caller answers that by refolding from
`scan`. Because events are never deleted (principle 4), a token an
instance issued is always one it can place, so a rejection means the
cache belongs to some other instance — another store, or this one
before it re-minted its device — which is exactly when a refold is
right. What a token does not defend against is a hand edit of a
serialization that leaves its size unchanged; that is a breach of the
folder's rules (`vault-folder.md` §2 rule 2), and the cache is stale
until deleted.

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
a copy made by hand — a segment dropped in with a file manager, never
through a store (`vault-folder.md` §8.5): the
store then keeps one by a fixed rule of its own, stated where the
store is (the folder's is `vault-folder.md` §8.5), yields that one from
`scan` and `changes`, and reports the others in `conflicting()`. The
rule exists so that every reader of one store agrees; it is not a
judgement about which is right. A conflict is evidence of two writers
sharing one `author` (`vault-folder.md` §11), and what the application
shows.

## 6. Blobs and files

```ts
interface BlobStore {                 // content-addressed
  get(hash: Hash): Promise<Uint8Array | null>;
  has(hash: Hash): Promise<boolean>;
  put(bytes: Uint8Array): Promise<Hash>;   // the store hashes; a caller cannot misname bytes
  unlink(hash: Hash): Promise<void>;
  list(): Promise<Hash[]>;
}

interface FileStore {                 // everything in a vault that is neither an event nor a blob
  read(path): Promise<Uint8Array | null>;
  write(path, bytes): Promise<void>;
  list(): Promise<string[]>;
}
```

A vault, to a program, is `{ events: EventStore, blobs: BlobStore,
files: FileStore }` plus the trace log. `Vault` in `@estoc/vault` holds
these three and the key-minting it does today; the five stores go,
replaced by folds over `events.scan(...)` and `events.changes(...)`.

**Blobs** are bytes named by `sha256`, lowercase hex; immutable, merged
by union, deduplicated by construction, and the one thing in a vault
that is ever unlinked (`vault-events.md` §8). The name is computed by
the store on `put`, checked against the bytes on import (§7.3), and may
be checked on read; a blob whose bytes do not hash to its name is
damage, never served. Which events reference which blobs is on the
events (`blobs`, §3), so a collector needs no type; when a blob may go
is the events' business (`vault-events.md` §8.3); the store only
promises that a hash it holds returns the bytes it was given.

**A blob is written before the event that names it.** A crash between
the two leaves an orphan blob — harmless, collectable
(`vault-events.md` §8.3). The other order is never used: an event whose
blob was never written would be indistinguishable from an erase. A
store that can make the two one transaction (§8) may; a folder cannot
and orders them.

**Files** are named by path, and the paths are the folder's
(`vault-folder.md` §6): the format and anchor, the key cache, reserved
state, and any path a reader does not understand and carries along —
including a path under `devices/` or `blobs/` that is not shaped like
a segment or a blob (`vault-folder.md` §8.6), so that it survives a
trip through a store that is not a folder. There is no per-device
file: everything about a device is an event.
A file that is one per vault and has a merge policy of its own is a
**singleton** (`vault-folder.md` §6); to the store it is a file like
any other. Each singleton states its policy where it is defined; the
store applies none of them (§7.3).

## 7. Interchange

### 7.1 The interchange format

Every store must be able to render its whole vault as a version-2
folder and read one back. The folder is the interchange format and the
sovereignty contract: a backup is a folder in a zip, a merge is a folder
read into a store, and a reader with a text editor is a conforming
reader. `vault-folder.md` §4 gives the mapping in both directions:
`locate(event)` — where in the tree an event goes — and
`decodeEvent(path, line)` — the event a line under a path is.

**Round trip.** For any event set *S* produced by any conforming store,
rendering *S* as a folder and reading that folder back yields *S*: same
events, same content in the sense of §3, with `eid` as identity.
Blobs and files round-trip byte for byte. This is the conformance test
every store passes, and the definition of "a version-2 vault" that is
independent of the medium.

### 7.2 Export

A store renders its whole event set as the tree, one line per event,
under `devices/<author>/`, in segments of its own choosing; blobs as
blobs, flat; every path in `FileStore` in place. A folder store exporting
is a copy and keeps its own names.

**How an author's events are chunked into segments is not state.** A
segment is not part of an event's identity — a program never sees one
— and a reader of the export unions lines by `eid` and assumes no
order (`vault-folder.md` §5), so two exports of one store need not be
related file by file: one segment per author, minted at export, is
enough. An earlier draft required a segment to be assigned once and
grow only at its end, so that a folder could merge by copying
segments; the copying is withdrawn (§7.3) and with it the state it
demanded.

An export is always the whole set. A store does not export by filter,
so a device's events always travel with its `device.minted`.

### 7.3 Import

Three kinds of thing, three rules, in this order:

1. **Events**: `ingest` every event the folder holds (§5.2), `self`'s
   included — a duplicate is a duplicate, and an event of `self`'s
   that is not already here stops the import before anything is
   written, as a forked self. A device whose events arrive without its
   `device.minted` is read — its events are still that device's — and
   reported as incomplete. There is no faster path: an earlier draft
   let an import copy whole segments — a device directory absent here,
   a segment absent here, the longer of two prefix-related segments —
   and it is withdrawn, because a copied segment is not read: it could
   double an `eid` already ingested by another route, the reader's
   tie-break could then replace what this store had (which `ingest`
   promises never to do), and `changes` would replay bytes that were
   not new. Reading every line costs one parse of the other copy, which
   is what `scan` costs anyway.
2. **Blobs**, after the events: a blob absent here and present there
   is copied iff it is not collectable over the merged event set
   (`vault-events.md` §8.3), and iff its bytes hash to its name — one
   that does not is damage in the source, reported, not copied. An
   erased blob never comes back. The rule is the events'; the order —
   events first — is what makes it answerable.
3. **Files**, each by its own policy (`vault-folder.md` §6). The one
   the store must know about is that the format and anchor must be
   identical on both sides — that check is what makes this a merge
   rather than a restore, and it is made above the store, as today in
   `importVault`.

**Restore** is the same three steps into an empty store, the format
and anchor written last, as today; a folder store restoring into an
empty backend may copy the snapshot as it is, since the snapshot is
the interchange format and a copy of it is a conforming folder
(`vault-folder.md` §9.4). There is no `self`, so the first open mints
a device and an instance (§4); the imported devices stay as history.

### 7.4 Cache

A fold's result is a projection, kept locally with the `ChangeToken` it was
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

One table, the envelope as columns, the payload as JSON, and one
column the folder gets for free from the file system — the order an
event arrived in:

```sql
CREATE TABLE events (
  seq      INTEGER PRIMARY KEY,     -- arrival order; the token
  eid      TEXT NOT NULL UNIQUE,
  author   TEXT NOT NULL,
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,
  blobs    TEXT,                    -- JSON array of hashes, or NULL
  data     TEXT NOT NULL            -- the payload, JSON
);
CREATE INDEX events_order ON events (at, eid, author);
-- Payload fields a store wants to filter on are its own choice, e.g.
--   my_key   TEXT GENERATED ALWAYS AS (json_extract(data, '$.myKey')),
--   peer_key TEXT GENERATED ALWAYS AS (json_extract(data, '$.peerKey')),
-- with an index on (my_key, peer_key, at, eid). The model does not say.
CREATE TABLE blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY, bytes BLOB NOT NULL);
```

`append` and `ingest` are `INSERT` with the `UNIQUE` on `eid`
catching duplicates, which the store then compares for conflict (§3);
`scan` is a `SELECT` with the filter as `WHERE` — envelope columns,
generated columns, else `json_extract` — and `ORDER BY at, eid,
author`; `changes` takes `token = MAX(seq)` and selects `seq > since
AND seq <= token ORDER BY seq`, prefixed by the instance id. Export
renders each author's rows into one segment in `seq` order and
remembers nothing (§7.2). Blob write and skeleton append become one
transaction, which the folder store cannot offer (§6). Collection
(`vault-events.md` §8.3) is one query over `blobs`, a `json_each`
away.

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
  object store keyed by `eid` with an autoincrement `seq` and an index
  on whatever it filters by (`[myKey, peerKey, at, eid]` for threads);
  the app already depends on `idb`. Same interface, no SQL. Whether
  either is worth it is a question for when a fold is too slow to run
  at open, not before.

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
  lines. A folder store (`locate`/`place`, segments, one-pass ingest,
  the segment-table token) is a few hundred; the rest becomes
  folds, which version 2 needs regardless. The reduction is real but
  modest; the gain is one merge routine, one place that knows the tree,
  and a store per runtime.

## 10. Open

- **Partial reads.** A store answers every `scan` from the whole set;
  there is no reading one channel or one contact without the rest,
  and the folder store reads every device's log to answer anything.
  The cache (§7.4) is the answer; a directory per channel would only
  help a reader that does not exist.
- **Indexing** (§5.3): equality on any field lets a store index what it
  likes; whether the folder store should keep a local index for the
  pair under `local/cache/`, or leave all of that to folds, is for when
  open is slow.
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
  (a URI, a reverse-DNS prefix) and what an extension may `append` (by
  `type` prefix, presumably) is not decided; the interface is shaped so
  that the answer is a convention on `type`, not a change here. An
  extension's event about a contact carries the `cid`, exactly as the
  vault's own do, and one that holds a blob lists it in `blobs` (§3),
  which is what keeps collection safe around it — though until an
  erase exists for events that are not messages, such a blob is pinned
  (`vault-events.md` §12).
- **Trace.** Stays a `SegmentedLog` of its own, local, with its own
  retention, never exchanged. Whether it should implement the same
  interface for uniformity is a code question.
