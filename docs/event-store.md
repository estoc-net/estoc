# The vault as an event store — draft

Status: **draft**, 2026-08-29. A companion to `vault-format-2.md`: that
document says what a version-2 vault *is* on disk; this one says what a
program *sees*, and how the two are the same thing. Nothing here adds an
event type, a file, or a field to the format. It names a seam, and puts
the folder on one side of it.

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
- how stores **exchange** events: export, import, and the cache (§7);
- the **amendments** `vault-format-2.md` needs to permit this (§8).

It does not define events (§7–8 there), folds (§9 there), erasing (§10
there), or the trace log, which is local and stays a log of its own.

## 2. The event

An event is a JSON object. Every event has:

| field  | meaning |
|--------|---------|
| `eid`  | `<uuidv7>-<dev>`, as `vault-format-2.md` §4. The dedup key. |
| `at`   | RFC 3339 UTC, as v1 §4. |
| `type` | the event type, as §7.1 / §8 there. |
| `dev`  | the authoring device; the suffix of `eid`, present as a field so nothing has to parse ids. |
| `scope`| one of `me`, `contact`, `part`: which log family. |

and, by scope, a **locator**:

| scope     | locator fields      | the log in `vault-format-2.md` |
|-----------|---------------------|--------------------------------|
| `me`      | (none)              | `devices/<dev>/me/` |
| `contact` | `cid`               | `devices/<dev>/contacts/<cid>/` |
| `part`    | `myKey`, `peerKey`  | `devices/<dev>/parts/<myKey>/<peerKey>/` |

`dev` and `scope` are locator fields too. Together they are the
**Locator**: everything that says *where* an event is, and nothing that
says what it is. The rest of the object is the event's own fields, as
specified per type.

Rules:

1. **The locator is on the event.** Every event carries its full
   locator as fields. Nothing about where an event belongs has to be
   recovered from state; this is what §7 of `vault-format-2.md` bought
   by partitioning on observed keys rather than on `cid`, and it is what
   makes a flat table with a `WHERE` clause a correct reading.
2. **`dev` is authorship.** The `dev` field, the `eid` suffix, and (in a
   folder) the `devices/<dev>/` directory always agree. A store rejects
   an event where they do not.
3. **Events are opaque above the locator.** The store neither validates
   nor interprets an event's own fields. Type-specific validation is the
   fold's, and a line that does not parse as JSON is a *damaged* line
   (§4.4), reported, not stored.

## 3. Path ↔ fields

The folder layout of `vault-format-2.md` §3 is the locator, spelled as a
path. Two pure functions:

```
locate(event)          → "devices/<dev>/me/"
                       | "devices/<dev>/contacts/<cid>/"
                       | "devices/<dev>/parts/<myKey>/<peerKey>/"

place(path, line)      → event      (path gives the locator; the line gives the rest)
```

- **On disk, the line omits what the path already says.** A line under
  `devices/k7q3ma/parts/did/0198…/abc…/` does not repeat `dev`, `scope`,
  `myKey`, `peerKey`; `place` reinjects them. This keeps the on-disk
  form exactly what `vault-format-2.md` §7.1 shows, and it is why the
  locator must be recoverable from the path alone: `myKey` has slashes
  of its own, so `peerKey` is always the last directory (§4 there) and
  the rest between `parts/` and it is `myKey`.
- **In memory, the event is whole.** Anything above the store — folds,
  policy, a database store — sees the full object of §2 and never a
  path.
- **The mapping is total and injective on locators.** Every valid
  locator has exactly one directory, and every directory under
  `devices/<dev>/` that holds segments parses to exactly one locator.
  A directory that does not parse is not part of the event set; a
  reader reports it and moves on (as `vault-format-2.md` §14: unknown
  paths are carried, not read).
- **Segments are not part of the mapping.** Which `<seg>.jsonl` a line
  sits in says nothing about the event. Segments are how the folder
  store appends and merges (§5); a program never sees them.

**Round trip.** For any event set *S* produced by any conforming store,
rendering *S* as a folder (§7.1) and reading that folder back yields
*S*: same events, same fields, compared as JSON objects with `eid` as
identity. This is the conformance test every store passes, and the
definition of "a version-2 vault" that is independent of the medium.

## 4. The store interface

```ts
interface Locator {
  dev: string;
  scope: "me" | "contact" | "part";
  cid?: string;                       // scope === "contact"
  myKey?: string; peerKey?: string;   // scope === "part"
}

interface Event extends Locator {
  eid: string;
  at: string;
  type: string;
  [field: string]: unknown;           // the event's own fields; opaque here
}

/** Per-device high-water marks: the last eid seen from each dev. */
type Cursor = Record<string, string>;

interface Filter extends Partial<Locator> {
  type?: string;
}

interface EventStore {
  /** This device's own event. `event.dev` must equal the store's self dev. */
  append(event: Event): Promise<void>;
  /** Events from elsewhere (a backup, another store, another device). Union by eid. */
  ingest(events: AsyncIterable<Event>): Promise<Ingested>;
  /** Every event matching `filter`, after `since`, in canonical order. */
  scan(filter?: Filter, since?: Cursor): AsyncIterable<Event>;
  /** The high-water mark of everything this store holds. */
  cursor(): Promise<Cursor>;
  /** Damaged lines met since open, for the caller to surface. */
  damaged(): DamagedLine[];
  /** Which dev this store appends as; `vault-format-2.md` §6.4. */
  readonly self: string;
}

interface BlobStore {                 // content-addressed; as today
  get(hash): Promise<Uint8Array | null>;
  has(hash): Promise<boolean>;
  put(hash, bytes): Promise<void>;
  unlink(hash): Promise<void>;
  list(): Promise<string[]>;
}

interface Singletons {                // config, keystore, devices/<dev>/device.json
  read(name): Promise<Uint8Array | null>;
  write(name, bytes): Promise<void>;
}
```

A vault, to a program, is `{ events: EventStore, blobs: BlobStore,
singletons: Singletons }` plus the trace log. `Vault` in `@estoc/vault`
holds these three and the key-minting it does today; the five stores go,
replaced by folds over `events.scan(...)`.

### 4.1 `append`

Writes one event authored by `self`. Durable when the promise resolves:
a crash after that never loses it, a crash before it never leaves a
half-event where a whole one was expected (a truncated line is
*damaged*, skipped, and never fused with the next; §5). Appends from one
store instance are ordered; two instances on one folder are the
caller's problem, as today (Web Locks in the app, one daemon on disk).

### 4.2 `ingest`

Takes events from anywhere, authored by anyone, and adds those whose
`eid` is not already present. Returns what was added and skipped. Never
rewrites, never drops, never reorders what was there: this is `merge` in
`vault-format-2.md` §12 with the file-level rules moved into the folder
store (§5.3). Two events with one `eid` and different content are the
"two writers sharing one dev" case there; `ingest` keeps the one it has
and reports the other.

`ingest` is not import. After a merge, agent-core still does what it
does today: fold, and `held` every outbound whose delivery is not
`sent` (`holdUndelivered`). That is a decision made on the merged set,
appended by `self`, and no store's business.

### 4.3 `scan`

Yields events whose locator fields equal every field given in `filter`
(and whose `type` equals `filter.type` if given), and whose `eid` is
past `since[dev]` for their `dev` (all of a dev if `since` has no entry
for it). Order is the canonical order of `vault-format-2.md` §4: `at`,
then `(uuidv7, dev)`.

The filter is deliberately small: locator fields and `type`. A database
store could answer richer questions; the folder store can only scan. A
question the filter cannot ask (a thread by `thid`, a message by `mid`,
"everything about this contact across partitions") is a fold, and lives
in the cache (§7.3), so no store is asked to be a query engine.

### 4.4 Cursor and damage

A `Cursor` names, per device, the last `eid` seen. Because each device's
events are appended by one writer in `eid` order, "everything after
cursor" is well defined for every store: a folder seeks past a line in a
segment, a database asks `dev = ? AND eid > ?`. The cache (§7.3) keeps
one; a future device-to-device sync sends one ("what you have after
this"); a fold that restarts folds from one.

Damaged lines are what the folder store finds on disk and cannot parse
(`DamagedLine` as today: where, the text, the error). They are reported,
never stored, never counted in a cursor. A database store has none by
construction.

## 5. The folder store

The reference implementation: `EventStore` over `VaultBackend`, the
bytes interface that exists today (read, write, append, remove, size,
list, dirs). It knows the tree; nothing above it does.

### 5.1 Reading

`scan(filter)` walks the directories `locate` would produce for the
filter (a fully specified locator is one directory; a partial one is a
`walk` from the deepest fixed prefix), reads every `<seg>.jsonl`, parses
each line, reinjects the locator from the path (`place`), skips damaged
lines into `damaged()`, and merges the per-directory streams in
canonical order. `since` is honoured by skipping lines whose `eid` is
not past the dev's mark.

### 5.2 Appending

As `SegmentedLog` today, per directory: appends go to the newest
segment under `devices/<self>/<locate(event)>/`, or a fresh
`<uuidv7>.jsonl`; a first append heals a segment that does not end in a
newline by terminating the fragment before writing. Appends are
serialised per store instance, because `VaultBackend.append` is
size-then-write. The line written is the event minus its locator (§3).

### 5.3 Ingesting

For each incoming event, by `dev`: if the `eid` is already under
`devices/<dev>/`, skip; otherwise append the line to a segment under
`devices/<dev>/<locate(event)>/` that **this store minted for ingest**,
never to a segment the authoring device wrote. So a merged folder may
hold, under `devices/x/parts/…/`, both `0198…a.jsonl` written by `x`
and `0198…b.jsonl` written here from what `x` wrote. Both contain only
events authored by `x`. Readers union by `eid`, so nothing is doubled.

**Fast path.** When the source is itself a folder (a backup zip, another
`.estoc/` directory), the store may copy whole segments instead: a
segment absent here is copied; a segment present on both sides where one
is a prefix of the other is replaced by the longer; a pair that is
neither is "two writers sharing one dev" and stops the import. This is
`vault-format-2.md` §12 verbatim, and it is only an optimisation of
§4.2: the event set that results is the same as ingesting line by line.
A store that only ever ingests through the interface is conformant.

### 5.4 The rest

Blobs and singletons are what they are today. `local/` is the folder
store's own (self, options, cache, trace) and is neither an event nor
exported. `snapshotVault` becomes "everything under `.estoc/` except
`local/`", as §12 there, and is also the rendering a non-folder store
must produce (§7.1).

## 6. A database store

Not proposed for implementation now; written to show the seam holds.

### 6.1 Shape

One table, the locator as columns, the rest as JSON:

```sql
CREATE TABLE events (
  eid      TEXT PRIMARY KEY,
  dev      TEXT NOT NULL,
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,
  scope    TEXT NOT NULL,          -- me | contact | part
  cid      TEXT,                   -- scope = contact
  my_key   TEXT,                   -- scope = part
  peer_key TEXT,                   -- scope = part
  data     TEXT NOT NULL           -- the event's own fields, JSON
);
CREATE INDEX events_dev   ON events (dev, eid);
CREATE INDEX events_part  ON events (my_key, peer_key, at, eid);
CREATE INDEX events_cid   ON events (cid, at, eid);
CREATE TABLE blobs   (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
CREATE TABLE singles (name TEXT PRIMARY KEY, bytes BLOB NOT NULL);
```

`append` and `ingest` are `INSERT OR IGNORE`; `scan` is a `SELECT` with
the filter as `WHERE` and `ORDER BY at, eid`; `cursor` is `SELECT dev,
MAX(eid) GROUP BY dev`. Blob write and skeleton append become one
transaction, which the folder store cannot offer (it orders them: blob
first, then the line, §7.3 there). Collection (§10.3 there) is one query
over `data` for referenced hashes.

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
  object store keyed by `eid` with indexes on `[dev, eid]`, `[my_key,
  peer_key, at, eid]`, `[cid, at, eid]`; the app already depends on
  `idb`. Same interface, no SQL. Whether either is worth it is a
  question for when a fold is too slow to run at open, not before.

### 6.3 What it must still do

Render a folder (§7.1) for backup, and read one (§7.2) for restore or
merge, because the folder is the interchange format and the sovereignty
contract. A database store that cannot round-trip (§3) is not a vault.

## 7. Exchange

### 7.1 Export: rendering a folder

A store renders its event set as a `vault-format-2.md` tree: each event
to `locate(event)`, minus its locator, one line each, in `eid` order
within a directory; blobs to `blobs/<hash>`; singletons in place.

Segment naming on export, *provisional*: a non-folder store has no
segments, so it must choose names, and two exports of the same store
must produce prefix-related files, or a folder merging both would see
two writers for one dev. Rule: **one segment per directory, named by
the uuidv7 of its first event.** The name is then minted (it is an
event id) rather than computed from the directory, and stable across
exports; a later export of a grown set is a longer file of the same
name. A folder store exporting is a copy and keeps its own names.

### 7.2 Import: reading a folder

`place` every line of every segment under `devices/*/`, `ingest` the
result; blobs by the rule of `vault-format-2.md` §12 (after the events,
never a collectable one); singletons by theirs. The folder store may
take the fast path (§5.3). The identity check (`config.identity.anchor`
must match) and the restore-vs-merge distinction (is there a vault here
yet) are above the store, as they are today in `importVault`.

### 7.3 Cache

`local/cache/` is a projection of `scan()`, kept with the `Cursor` it
was folded to. On open, `scan(filter, cursor)` yields what is new and
the fold advances; a cursor the store does not recognise (a device it
has never seen with a mark, a mark past what it holds) means refold. A
cache is itself a store of the projection's choosing; the app's is
IndexedDB today for keys, and nothing says it cannot hold the folds.

This is the one place a database is plainly right and costs nothing:
the cache is rebuildable, so its store needs no round trip, no
interchange format, and no promise beyond "delete me and I come back".

## 8. Amendments to `vault-format-2.md`

To be applied there if this document is accepted. Nothing else moves.

1. **Rule 3** (*every event under `devices/<dev>/` was authored by
   `dev`*): keep the first sentence; replace "a merge is a copy" with:
   a device appends only to segments it minted; a segment is never
   edited or truncated by anyone but its writer; **a merge may add
   segments under any device's directory, holding only that device's
   events** (§5.3 here). Authorship is the `eid`; the path is where a
   folder keeps it. Two same-named segments that are not prefix-related
   remain the two-writers error.
2. **§4 Segments**: "the writer appends to its newest segment or mints
   one" gains "an importer appends to a segment of its own under the
   authoring device's directory". Note the export naming rule (§7.1
   here) as provisional.
3. **§12 Import**: restate as `ingest` (§4.2 here) with the file-copy
   rules kept as the fast path. The blob rule and the singletons rule
   stay.
4. **§7.1**: "`direction` is the event type and `sender` is the
   partition; neither is a field" stays true of the *line*; add that in
   memory the partition is the `myKey`/`peerKey` fields of the event
   (§3 here).
5. **§2**: add rule 8, *the folder is one serialization of the event
   set*: a program reads and writes events through the interface of
   `event-store.md`; any store that round-trips the folder is a
   conforming vault.

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
  The folder store sits on it.
- **Runtimes.** Node 22.13 has `node:sqlite`; the browser has `idb`
  and no wasm SQLite; the app is not cross-origin isolated (§6.2).
- **Size.** Today's five stores plus `transfer.ts` are about a thousand
  lines. A folder store (`locate`/`place`, segments, ingest with fast
  path) is a few hundred; the rest becomes folds, which version 2 needs
  regardless. The reduction is real but modest; the gain is one merge
  routine, one place that knows the tree, and a store per runtime.

## 10. Open

- **Ingest and rule 3.** §8.1 is the one real change to the format's
  principles. The alternative, keeping "a merge is a copy" strict and
  forbidding event-level ingest into a folder, would make a database
  store unable to feed a folder except by rendering a whole new tree,
  and the app unable to merge a backup except file by file. The
  amendment seems cheap; the review should confirm nothing in §9–12
  there relied on "one directory, one writer" beyond the prefix rule.
- **Export segment naming** (§7.1): first-event uuidv7, or persist a
  minted name per directory in the store. The former needs no state.
- **Filter surface** (§4.3): `mid` and `thid` are tempting. Kept out;
  the cache answers them.
- **Daemon RPC.** Once the store is the interface, the daemon could
  expose `scan(since)` and push events rather than records, and the
  app's cache could be an IndexedDB store fed by it. Not this
  document's call.
- **Trace.** Stays a `SegmentedLog` under `local/trace/`; it has its own
  retention and is never exchanged. Whether it should implement the same
  interface for uniformity is a code question.
