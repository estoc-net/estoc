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
directory is one column, each envelope field is another, and the
payload is one JSON column; a segment is a page; a merge is `INSERT OR
IGNORE`. The folder is a serialization of that table, chosen because a
person can read it with nothing but a text editor. Nothing in the model depends on the choice.

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

What is *not* here: no path (`vault-folder.md`), no event type defined
— §6.2 names three of `vault-events.md`'s — no fold (`vault-events.md`), and nothing a copy keeps for itself beyond what
§6.1 says of it: a trace, a cache, an option is beside the vault, not
in it.

## 2. Principles

Version 1 had six rules (`vault-format.md` §2); the draft that preceded
these three documents had eight. Sorted by layer, these are the ones
that hold for every store. `vault-folder.md` §2 has the ones about
files; `vault-events.md` §1 the ones about meaning.

1. **A vault is events, blobs and files.** *Events*: immutable,
   appended, unioned, folded. *Blobs*: blocks named by their CID (§6),
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
   event's. This is a property of a set, not of every set: what a copy
   keeps beside the vault (§6.1) shares the event's shape and not this
   rule, and an extension's own set (§6.2) is disposed of whole, never
   a line at a time.
5. **Conflicts are projections.** Two devices deciding differently
   produce two events, not an error. A fold that can show both does;
   one that must pick — a field that is one value at a time — takes
   the latest by canonical order (§4), which is the clocks' latest and
   not always the person's last word; and where that would be wrong,
   the resolution is an event of its own (`vault-events.md` §6). A
   store never chooses between events it holds. The
   one thing it refuses is two *contents* under one `eid` (§5.5), which
   is not two decisions but one broken.
6. **Folds are functions of the set.** `self` is the one parameter;
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

An event is a JSON object. Five fields are the **envelope**: four the
store reads, and one it checks and never reads. The sixth,
`data`, is the **payload**, which the store carries and never reads:

| field    | meaning |
|----------|---------|
| `eid`    | a bare uuidv7 (§4): minted at append, the dedup key; the same kind of id as `mid` and `cid`. |
| `at`     | RFC 3339 UTC (§4). |
| `type`   | the event type, a non-empty string; `vault-events.md` names the vault's own. |
| `author` | the authoring device (§4). |
| `blobs`  | every blob this event references, as roots (§6): a root, and every block it reaches. The complete list, always present, `[]` when the event references nothing — a CID anywhere else on the event is not a reference. |
| `data`   | the payload: a JSON object, always present, `{}` when the type carries nothing. |

`data` holds the event's own fields, as specified per type, opaque to
the store. What an event is *about* — a contact, a key, a device, a
message, the pair of keys an envelope proved — is a field of `data`
naming it, and `vault-events.md` says which. The store does not know
the vault's shape at all. A channel (`vault-events.md` §3) is two
fields of `data` every observation carries and a fold groups by, not a
place in the store; a contact is a `data.cid` on a decision, as a key
is a `data.key` and a device a `data.dev`.

```jsonc
{ "eid": "0198…", "at": "2026-08-29T10:00:00Z", "author": "k7q3ma", "type": "contact.petname",
  "data": { "cid": "0198…", "name": "alice" } }
```

The payload is one field rather than the rest of the object so that
the two halves cannot collide. Flat, the envelope would be frozen at
the names it has: a sixth envelope field added later — a version, a
signature, where an ingested event came from — would clash with any
payload, an extension's (§10) above all, that had already used the
name. Nested, the envelope can grow and no name is reserved; the store
checks that `data` is an object and nothing about what is in it. It
is also what the store already is: a table of envelope columns and
one payload column (§8.1), and what DIDComm (headers and `body`) and
CloudEvents (context attributes and `data`) chose for the same
reason. `data` and not `body` because `body` names a blob on a message
skeleton (`vault-events.md` §3.1); not `params` because an event is a
fact, not a call.

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
extension's — still says what it holds, and a collector that keeps by
this rule is safe for events it does not know. That is why the list is
never absent: `[]` is the event's own statement that it references
nothing, where a missing field would only be silence, and a collector
that treated the two alike could not tell "nothing" from "not said". What a root reaches is
read from the blocks, not the event: the name says whether a block has
links (§6), so the walk needs no type either. The store itself only
checks the field's shape. Type-specific fields may say which root is
which (`body`, `attachments`), drawn from this list.

**Nothing is reserved inside `data`.** `device.label { dev }` names
the device a decision is about and `contact.petname { cid }` the
contact; a type may use any name, including the envelope's, and a
store never looks. Outside `data`, at the top level, the store accepts
the five envelope fields and refuses any other (rule 3): a field that
belongs to no version of the envelope is a malformed event, not an
extension.

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
   `blobs` is an array of CIDs (§6), `[]` included; that `data` is a
   JSON object; and that no other top-level field is present. An event
   that fails is rejected — `append` throws, `ingest` reports (§5.2) —
   and never stored. `data` is opaque: type-specific validation is the
   fold's. Bytes a
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
  It is an order of clocks: across devices, or across a step back on
  one, "latest" means the latest `at`, and a decision the person made
  last can sort before one they made earlier. Version 2 accepts this
  for fields that are one value at a time (a petname, a label) and
  gives what cannot tolerate it — attribution — an explicit resolving
  event (`vault-events.md` §6) instead of a better clock; a hybrid
  logical clock is the change if that ever stops being enough (§10).
  `scan` (§5.3) yields in this order and sorts to produce it: no
  container of events — segment, file, table — is ever assumed to be in
  it.
- **`cid`**, **`mid`**, mediation `id`, key `id` — uuidv7, as v1.
  Wire ids and time as v1 §4.

## 5. The store interface

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [field: string]: JsonValue };
type Cid = string;                    // CIDv1, sha-256, codec raw or dag-pb, base32 lower (§6)

type JsonObject = { [field: string]: JsonValue };

type Event<D extends JsonObject = JsonObject> = {
  eid: string;                        // a bare uuidv7
  at: string;                         // RFC 3339 UTC
  author: string;                     // a device id
  type: string;
  blobs: Cid[];                       // every root the event references, `[]` for none; checked, never read, here
  data: D;                            // the payload; opaque here — `vault-events.md` types it per `type`
};

/** What a caller hands to `append`: no eid, at, or author — the store mints them; `blobs` left out is `[]`. */
type Draft<D extends JsonObject = JsonObject> = { type: string; blobs?: Cid[]; data: D };

/** Equality, by `===` on primitives: on the envelope fields named, and on the top-level fields of
 *  `data` named under `data`. `null` matches a field present and null; `undefined` is no
 *  constraint. A store may index some; the folder store reads and compares. */
type Filter = { author?: string; type?: string; data?: { [field: string]: JsonPrimitive | undefined } };

/** A frontier of this store instance: what it held when the token was taken. Opaque; meaningful only
 *  to the instance that issued it. Not an auth token: a checkpoint a caller keeps beside a fold. */
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
  /** What this store gained after `since` and at or before `token`; each event once, in no promised order. */
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
today — folds, and `held`s every outbound of *another* device whose
delivery is not `sent` and that `self` has not already held
(`vault-events.md` §10). That is a decision made on the merged set,
appended by `self`, and no store's business.

### 5.3 `scan`

Yields the store's whole event set, filtered: events whose `author`
and `type` equal those given in `filter`, and whose `data`'s top-level
fields equal every field given under `filter.data`. One event per `eid`
(conflicts resolved as §5.5). Order is canonical (§4).

**The store sorts.** No segment, file or table is assumed to be in
canonical order, and a reader never merges pre-sorted streams: `at` is
a wall clock and can step back even on the authoring device, an
ingested batch holds whatever order the events came in, and a database
sorts in the query anyway. A vault's event set fits in memory; the cost
of sorting it is not what any fold waits on.

The filter is equality and nothing more: no ranges, no joins, no
"across", and nothing deeper than the top level of `data`. A database
store may index the fields it is asked about most (`author`, `type`, a
channel's pair); the folder store reads
everything and compares, and is no slower for it than it is at reading
everything. A question equality cannot ask (a thread by time,
everything about one contact across its channels) is a fold, and
lives in the cache (§7.4), so no store is asked to be a query engine.

### 5.4 `changes`

`changes(filter, since)` answers "what has this store gained since
`since`". The `token` is a **frontier**: a mark of what the store held
at the moment `changes` was called, taken before any event is read, in
whatever form the store keeps such a thing. `events` yields exactly
the events that arrived after `since` and at or before `token`,
matching `filter` — a complete delta, each event once — **in no
promised order**. A caller that folds those events and keeps `token`
therefore has a fold that is exactly as far as the token, whatever was
appended concurrently: the next call picks up from there and nothing
falls between.

No order is promised because none is worth keeping. An event older than
everything the caller has folded can arrive late (§5.2), so the delta
is not in canonical order whatever a store does; and the sequence a
store happened to gain events in is not one the folder can reproduce
— it reads segments, not a ledger — and not one any fold may lean on:
principle 6 (shuffled = same) applied one event at a time is the
contract, and a fold that cannot keep it refolds from `scan`. The
folds of `vault-events.md` §7 are functions of the set and qualify;
the property is stated here because `changes` is what makes it
load-bearing. A store that has an order (a sequence column, §8) may
yield in it; a caller must not notice.

A token is a string a caller stores and hands back, and nothing more. It
belongs to the store *instance* that issued it (§4), and names that
instance and, since one copy opens more than one store (the vault's
and each extension's, §6.2), which of them: a folder store's names its
instance, the store, its segments and their lengths; a database's names
its instance, the store and a sequence number; and neither means
anything to the other. A token of the vault's store is never one of an
extension's, and re-minting the instance re-mints it for every store
the copy opens. A token the store cannot place —
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
interface BlobStore {                 // a block store of the `unixfs-v1-2025` profile
  // files — what an event's `body` and `attachments` name
  put(bytes: Uint8Array): Promise<Cid>;          // hashes by the profile; returns the file's root. A caller cannot misname bytes.
  get(root: Cid): Promise<Uint8Array | null>;    // the file's bytes, chunks rejoined; null if the root or any chunk is absent; throws on a node that is not a file
  // blocks — what the profile's trees are made of
  putBlock(cid: Cid, bytes: Uint8Array): Promise<void>;   // checked against `cid` (profile name, hash, and for dag-pb that the bytes decode as a profile node); the only way in for a block minted elsewhere
  getBlock(cid: Cid): Promise<Uint8Array | null>;
  has(cid: Cid): Promise<boolean>;
  list(): Promise<Cid[]>;
  // removal — the only way bytes leave a store; serialised with everything above
  collect(keep: Cid[]): Promise<Collected>;      // unlinks every block no root in `keep` reaches that is older than the store's grace
}

interface Collected { unlinked: Cid[]; young: Cid[] }   // `young`: unreferenced but too recent to touch; the next collection sees them again

interface FileStore {                 // everything in a vault that is neither an event nor a blob
  read(path): Promise<Uint8Array | null>;
  write(path, bytes): Promise<void>;
  list(): Promise<string[]>;
}
```

A vault, to a program, is `{ events: EventStore, blobs: BlobStore,
files: FileStore }`, and an `{ events, blobs }` of the same kind for
every extension it has installed (§6.2). `Vault` in `@estoc/vault`
holds the three and the key-minting it does today; the five stores go,
replaced by folds over `events.scan(...)` and `events.changes(...)`.
What a copy keeps for itself — the trace among it — is none of these
and is §6.1.

**Blobs are blocks.** A blob is one block of the UnixFS hashing
profile `unixfs-v1-2025` (`@estoc/folder-object`, `object-share.md`
§2): a CIDv1 over sha-256, base32 lower, whose codec is **`raw`** —
bare bytes, at most 1 MiB — or **`dag-pb`** — a UnixFS node: a
directory, a HAMT shard, or the chunk index of a file over 1 MiB,
whose links are further blocks. A **file** is a raw block (at most
1 MiB) or a dag-pb root over raw 1 MiB chunks in the profile's
balanced layout; `put` hashes bytes into exactly that and returns the
root, so the same bytes have the same name in a vault, in an
`object-share/1.0` share, and in a signed object, and a single-block
file's name *is* its bytes' raw CID. A received object — blocks
already named — comes in by `putBlock`, one per block, and is read
back by `@estoc/folder-object` over `getBlock`; nothing is re-hashed
and nothing is stored twice. A CID names a block inside a tree; a
bare multihash (`blob-store.md`) names bytes outside one — a package
as uploaded — and the two are never confused.

Blobs are immutable, merged by union, deduplicated by construction
(two attachments sharing a chunk share a block), and the one thing in
a vault that is ever unlinked (`vault-events.md` §8). A name is
computed by the store on `put`, checked by `putBlock` and on import
(§7.3), and may be checked on read. The check is three things: that
the name is a profile name (CIDv1, sha-256, `raw` or `dag-pb`); that
the bytes hash to it, and a raw block is at most 1 MiB; and, for
`dag-pb`, that the bytes decode as a node the profile makes — a
UnixFS file, directory, or HAMT shard, its links well formed — since
a hash proves only that the bytes are the ones named, and the empty
node, or any dag-pb without UnixFS data, has a perfectly good CID that
no conforming `put` ever minted. It is not a closure check: blocks
arrive one at a time, leaves before root, and a root whose kind admits
a partial tree may lack leaves for good (`vault-events.md` §4); what
a root reaches is read when it is read. A block that fails is
**damage**: never served, never copied, and **absent** to everyone —
to a reader (`vault-events.md` §8.2), to an import (§7.3, so that a
sound copy elsewhere can replace it), and to the store itself, which
unlinks it or sets it aside under a path that is not a blob's whenever
it finds it, reporting it. So every name a vault holds is one a
conforming `put` could have minted, and a name found otherwise is not
held. Which events reference which roots is on the
events (`blobs`, §3), and which blocks a root reaches is in the
blocks: raw has no links, dag-pb's are in the node, and the codec is
in the name. A collector therefore needs no type; when a block may go
is the events' business (`vault-events.md` §8.3); the store only
promises that a CID it holds returns the bytes it was given.

**A blob is written before the event that names it** — every block
of it, leaves before the root, root before the line. The other order
is never used: an event whose blocks were never written would be
indistinguishable from an erase. A store that can make the writes one
transaction (§8) may; a folder cannot and orders them, and a crash
between the writes leaves orphan blocks, harmless.

**Bytes leave by `collect`, and only when old.** The two interfaces
give the store no way to see that a `put` and the `append` that
follows it are one act, so a block that no event names is either
abandoned by a crash or about to be named, and the store cannot tell
which. What it can tell is age. It keeps, for each block, when it
last wrote it — a fact of this copy alone, kept however the store
keeps such things (the folder reads its file's modification time,
`vault-folder.md` §7), never exported; a block whose write time it
does not know it takes as written now — and **a `put` or `putBlock`
of a block already held renews that time**: the write is a no-op for
the bytes and not for the clock, because the caller is about to name
the block and a collector must not take it first. `collect(keep)`
then unlinks every block that no root in `keep` reaches and that is
older than a grace the store sets, and nothing else; an unreferenced
block younger than the grace is reported as `young` and left for the
next call. Which roots are `keep` is the events' business — every
root some event still holds (`vault-events.md` §8.3) — and the store
walks them without a type, since the links are in the blocks. An
erased blob is therefore not unlinked *by* the erase but by the
collection that follows it, and one that was written moments ago
waits out the grace first; readers ask the erase before the bytes
(`vault-events.md` §8.2), so bytes that linger read as erased all the
same. The grace is generous — the write it may belong to is bounded
by a process, not a clock; git's `gc.pruneExpire` is the same answer
to the same race — and a store that writes blocks and line in one
transaction (§8) has no orphans and may set it to nothing.

`collect` is serialised with the store's own `put`, `putBlock` and
`get`, as `dispose` is with an extension's operations (§6.2): it runs
between them, never beside one. Two instances over one serialization
are the caller's problem, as for `append` (§5.1). The renewal is what
closes the race a lock alone would not: a `put` that returned before
a `collect` began has already made its block young, whatever the
`append` after it is still waiting on. Nothing else removes a block a
store holds; damage (above) is the store's own finding and is set
aside by it, not collected.

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

### 6.1 Local state

Everything so far is the vault: what a backup carries, what two copies
merge, what a text editor reads. A copy also keeps things that are true
of it alone and travel nowhere — which device it is (§4), the folds it
has cached (§7.4), the retention it was told to apply, the envelopes
it observed. None of it is an event of the set, and none of it is a
file in the `FileStore` sense: a snapshot has none, an import touches
none, and no other device reads any. `vault-folder.md` §6.4 says where
the folder keeps it.

Local state has **owners** and three **lifetimes**, and a piece of it
is one of the three, never a mix:

| kind | rebuildable | disposable | example |
|------|-------------|------------|---------|
| **options** | no | no | what this device was told: a retention level, whether to run an installed extension here |
| **cache** | yes | yes | a fold and the token it was folded to (§7.4) |
| **trace** | no | yes | what this device saw: an envelope opened, a frame sent, kept for a while |

An owner is whoever keeps the state: the agent, the application's
folds, an extension. Each owner has its own of each kind, and the
kinds are told apart by what may be done to them: a cache may be
deleted at any moment and comes back; a trace may be pruned by its own
retention and does not come back; options are kept until the person
changes them. Nothing about an owner's local state is the store's
business beyond keeping the three apart.

**Options are the device's, and only the device's.** A setting that
affects a fold, or that should follow the identity to its other devices
— a name, a mediator, whether an extension is installed at all — is an
event, not an option (§2 principle 6, `vault-events.md` §5). An option
is what would be wrong to replicate: how long this phone keeps its
trace, whether this laptop runs an extension the identity has
installed.

**Trace** is the kind that looks like the vault and is not. A trace
line has the event's shape — `eid`, `at`, `type`, `data`, so that one
reader, one filter and one line format serve both — and none of the
event's contract:

- it is **minted by its producer**, not by the store: the agent hands
  a line its id and time as it makes it, because the next line may cite
  it as its `parent` whether or not anyone is keeping a trace at all (a
  chain of envelopes is a chain of ids);
- it has no `author` that matters and is never ingested: one device
  wrote it and only that device reads it, so there is no union, no
  duplicate, no conflict, no forked self;
- it is **pruned**: a retention the owner sets unlinks whole segments,
  never a line (as v1 §6.10), and a `ChangeToken` issued before a prune
  is not one the store can promise to place (§5.4);
- it is never exported and needs no interchange form; a store that
  cannot render it as a folder is still a conforming vault.

So a trace store is not an `EventStore` and does not claim to be. It
is the smaller thing below:

```ts
/** The event's shape, less what only exchange needs: no author, no blobs. Id and time are the producer's. */
type LocalEvent<D extends JsonObject = JsonObject> = { eid: string; at: string; type: string; data: D };

/** As Filter (§5), less `author`, plus `eid`: a line is looked up by the id another line cites. */
type LocalFilter = { eid?: string; type?: string; data?: { [field: string]: JsonPrimitive | undefined } };

interface LocalEventStore<E extends LocalEvent = LocalEvent> {
  append(event: E): Promise<void>;                       // minted by the producer; the store checks the shape and nothing else
  scan(filter?: LocalFilter): AsyncIterable<E>;          // equality, as §5.3; canonical order
  prune(policy: RetentionPolicy): Promise<PruneReport>;  // what is kept, per the owner; what was unlinked
}
```

`eid` is in the filter because it is how a chain is read: a line's
`parent` is an `eid`, and following it is one lookup per link, which
is what a store may index (§7.4). `RetentionPolicy` and what is inside
`data` are the owner's. The agent
is the first owner: its trace (v1 §6.10) is one, and its streams are
its retention classes. The vault's `EventStore` and an owner's
`LocalEventStore` share the event's shape, the filter and, in a folder,
the segment format; they share no lifetime, and a program that holds
one does not hold the other.

### 6.2 Extension stores

An extension — a handler, a renderer, a lens, a connector — keeps
local state as an owner of §6.1, and keeps what must follow the
identity in **a store of its own**: an `{ events: EventStore, blobs:
BlobStore }` exactly like the vault's, replicated, merged by the same
`ingest`, folded by the same rules, and not the vault's set.
`extension.installed` in the vault's set (`vault-events.md` §5) mints
the store's id, `ext`, and is all the vault's set records about it
besides the person's later decisions to stop running it or to dispose
of it.

Why a set of its own and not a namespace in the vault's:

- **Disposal.** Principle 4 holds within a set. The vault's set is
  what the person said and decided; an extension's is what a program
  recorded on their behalf, and the person may want it gone — after
  trying the extension and dropping it, after a version that wrote too
  much. In its own set it goes whole (`extension.purged`), the way a
  blob goes: the vault's set keeps the one line that says it was there
  and was dropped, which is the person's decision and belongs to them.
  In the vault's set it could never go.
- **Authority.** An extension writes to the store it is handed and no
  other. A permission is a handle, not a check on a `type` prefix at
  `append`. An extension that is to act as the application — create a
  contact, send a message — is handed the vault's store for that and
  writes the vault's own types through it, which is the application's
  grant to make.
- **Names.** Inside its own set an extension names its types as it
  likes, less one prefix: `estoc.*` is the host's, for whatever the
  application itself may one day write into an extension's set —
  version 2 writes nothing there — and an extension does not use it;
  the application, which hands out the handle, refuses it there, and
  the store below reads no type. Two extensions cannot collide because
  they are two sets. The namespace an earlier draft left open (§10)
  shrinks to that one reserved prefix.

What follows from it:

- **`ext` is minted** — a uuidv7 taken by `extension.installed`, never
  a name the extension chose (principle 2). Two devices that each
  install the same extension before merging have two stores; the fold
  shows both and a later decision says which is which, as with a
  contact seen twice.
- **One way.** An extension's events may cite the vault's — a `mid`, a
  `cid` — and a fold that joins them reads both stores. The vault's
  events never cite an extension's, so a store disposed of leaves
  nothing dangling.
- **Blobs are the store's own.** An extension's `blobs` names blobs in
  its own `BlobStore`, and collection runs per store over that store's
  events — so an unreferenced blob is an orphan there as anywhere.
  **The vault carries no extension's code.** In version 2 an extension
  is first-party, shipped with the application, and
  `extension.installed` names it; there are no bytes to carry. A
  third-party extension whose code should follow the identity is §10:
  whatever form that takes, the bytes would be blobs of the
  extension's own store, held by a host event there (the `estoc.*`
  prefix above), never the vault's blobs — a blob the vault's set
  references is pinned for the vault's life, and code is exactly what
  should not be. An extension may *read* a blob of the vault's by
  CID,
  through whatever the application hands it, and never pins one: an
  erase in the vault's set (`vault-events.md` §8) wins over any
  extension's reference, which is what sovereignty over one's own
  record means.
- **Replicated means never deleted.** Inside its set an extension's
  events are as permanent as the vault's. There is no replicated set
  with a retention, because a merge would bring back what one device
  had pruned; what needs a retention is local, and is trace (§6.1).
- **Readable without the extension.** An extension's store renders as
  the same folder the vault does (§7, `vault-folder.md` §3.1): after
  the extension is gone, what it recorded is still lines a text editor
  reads. This is what lets `extension.removed` (stop running it) and
  `extension.purged` (dispose of its store) be two decisions: tags a
  person made through a tagging extension do not die with the
  extension unless the person says so.
- **Devices are the vault's.** An extension store has no
  `device.minted`: its authors are the vault's devices, and import
  (§7.3) asks the completeness check of the *vault's* merged set for
  them — an extension event whose author has no `device.minted` there
  is read and reported as incomplete, exactly as the vault's own would
  be. It appends as the same `self`, and the forked-self rule of
  `ingest` (§5.2) holds in it as everywhere; because one import is
  many `ingest`s, the check runs over every store before the first
  write (§7.3).
- **Disposal is an operation, decided above.** Which extensions are
  purged is a fold over the vault's set (`vault-events.md` §7.3); a
  store does not read `extension.purged`, or any type. The application
  applies the fold by calling `dispose(ext)`, the one operation besides
  `BlobStore.collect` that removes bytes: it removes the extension's
  store and the extension's local state (§6.1) together, so that
  options, cache and trace do not outlive what they were about. Import
  (§7.3) asks the same fold, as it asks the blob rule; a snapshot
  copies what is on disk (`vault-folder.md` §9.1), and a purged store
  it still carries is dropped by whoever imports it.
- **Disposal revokes.** A handle is the permission (above), so
  `dispose` must end the permission, not only the bytes: the
  application stops the extension first; `dispose` is serialised with
  the store's operations — it waits for those in flight and none
  begin after; every handle to the store, held by anyone, is dead from
  then on and every method of it — reads as much as writes — rejects
  with `Disposed`, and so does `extension(ext)` for that `ext` for the
  rest of this instance's life, so that a dead handle cannot be
  replaced by asking again. Nothing is silently re-created.
- **A store exists when the fold says so, and on disk when written.**
  There is no call that makes an empty extension store.
  `extension(ext)` hands out a handle; the store's bytes come into
  being at its first `append` or `put`, and a store nothing was ever
  written to has no bytes, is not in `extensions()`, not in a snapshot,
  and needs no representation — which is why `VaultBackend` needs no
  notion of an empty directory. Whether an `ext` *may* be opened is
  the lifecycle fold's answer (`vault-events.md` §7.3) — installed,
  not purged — and the application asks it before calling
  `extension(ext)`; the store below reads no type and cannot tell a
  new `ext` from a purged one, so an application that opened a purged
  `ext` again would be contradicting its own fold, and nothing below
  the fold can tell. That a fresh install mints a fresh uuidv7 is
  likewise the application's rule: a re-install is a new
  `extension.installed` and a new `ext`, never the old one. On open,
  before any extension is handed its store or run, the application
  folds the lifecycle and applies every `dispose` the fold owes — a
  snapshot may lawfully carry a purged store not yet removed, and a
  restore copies it (§7.3, `vault-folder.md` §9.4).

A vault, to a program, is therefore its own three stores, a map from
`ext` to an extension's two, and `dispose`:

```ts
interface Vault {
  events: EventStore; blobs: BlobStore; files: FileStore;
  extension(ext: string): { events: EventStore; blobs: BlobStore };   // a handle; bytes exist from the first write; rejects an `ext` this instance disposed of
  extensions(): Promise<string[]>;                                     // every `ext` with bytes on disk
  dispose(ext: string): Promise<void>;                                 // store and local state, whole; every handle dead
}
```

The folder is `vault-folder.md` §3.1; export and import loop over the
map (§7.2, §7.3).

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
so a device's events always travel with its `device.minted`. Every
extension store the vault holds is exported beside it (§6.2), each as
its own tree; a purged one is gone before export if the application
has applied the fold (`dispose`), and dropped on import if not.

### 7.3 Import

Nothing is written until everything is checked; then three kinds of
thing, three rules, in this order. This is the one statement of the
algorithm: `vault-folder.md` §9.3 says what each step is on a folder,
`vault-events.md` §10 what the events require of it, and neither
restates it.

0. **Preflight**, before the first write. The source is read whole —
   a folder reads the other copy whole anyway (`vault-folder.md` §8.3,
   §9.3); a store that cannot hold an import in memory stages it,
   which is that store's problem and not a change to the rule — and
   three things are checked against it, any failure refusing the
   import with nothing written: that the source is a version-2 vault
   (`vault-folder.md` §10); that its format and anchor are identical
   to this one's (`vault-folder.md` §6) — the check that makes this a
   merge rather than a restore, made above the store, as today in
   `importVault`; and that no set the import will write is a forked
   self (§5.2) — the vault's, then, by the fold over the merged vault
   set that says which extensions are purged, every extension set the
   fold lets in. `ingest` promises to write nothing when `self` is
   forked, and an import is one `ingest` per store; the promise must
   hold for the import, not for each store in turn, or a fork found in
   the third store would find the first two already written — and the
   same is true of an anchor found wrong after the events went in,
   which is why the anchor is checked here and not with the files.
1. **Events**: `ingest` every event the folder holds (§5.2), `self`'s
   included — a duplicate is a duplicate. A device whose events arrive
   without its `device.minted` is read — its events are still that
   device's — and reported as incomplete. There is no faster path: an
   earlier draft
   let an import copy whole segments — a device directory absent here,
   a segment absent here, the longer of two prefix-related segments —
   and it is withdrawn, because a copied segment is not read: it could
   double an `eid` already ingested by another route, the reader's
   tie-break could then replace what this store had (which `ingest`
   promises never to do), and `changes` would replay bytes that were
   not new. Reading every line costs one parse of the other copy, which
   is what `scan` costs anyway.
2. **Blobs**, after the events: a block absent here — a damaged one
   is absent (§6): a source that has it sound repairs it — and present
   there is copied iff a root held over the merged event set
   (`vault-events.md` §8.3) reaches it — walking the blocks either
   copy holds — and iff it passes the block check (§6) — one that does
   not is damage in the source, reported, not copied. An erased blob
   never comes back. The rule is the events'; the order — events first
   — is what makes it answerable.
3. **Files**, each by its own policy (`vault-folder.md` §6); the
   format and anchor, checked in preflight, are not touched.

Then, for each extension store the source holds (§6.2): its events
and then its blobs, by rules 1 and 2, into the store of the same `ext`
here, which comes into being with the first line written if this copy
had none (§6.2). The completeness check of rule 1 is asked of the
merged *vault* set — an extension event whose author has no
`device.minted` there is read and reported as incomplete — since an
extension store has no such event of its own. One that the fold over
the merged vault set says is purged (`vault-events.md` §7.3) is not
read, as an erased blob never comes back: the rule is the events',
asked as the blob rule is, and the store applies it without reading a
type. One no `extension.installed` accounts for is read and reported.

**Restore** is the same steps into an empty store — there is no
anchor here to check the source's against — the format and anchor
written last, as today; a folder store restoring into an
empty backend may copy the snapshot as it is, since the snapshot is
the interchange format and a copy of it is a conforming folder
(`vault-folder.md` §9.4). There is no `self`, so the first open mints
a device and an instance (§4); the imported devices stay as history.

### 7.4 Cache

A fold's result is a projection, kept locally with the `ChangeToken` it was
folded to. On open, `changes(filter, token)` yields what arrived since
and the fold advances, one event at a time in whatever order they
come, which the folds of `vault-events.md` are built to accept (§5.4);
a rejected token means the cache belongs to another store and the fold
restarts from `scan(filter)`. A cache is itself a store of the
projection's choosing; the app's is IndexedDB today for keys, and
nothing says it cannot hold the folds.

This is the one place a database is plainly right and costs nothing:
the cache is rebuildable, so its store needs no round trip, no
interchange format, and no promise beyond "delete me and I come back".
The trace store (§6.1) is the other: not rebuildable, but local,
never exchanged, and read by id — a chain of `parent`s is a chain of
lookups — which is exactly what the folder does worst and an index does
for free.

## 8. A database store

Not proposed for implementation now; written to show the seam holds.

### 8.1 Shape

One table, the envelope as columns, `data` as JSON — the same split
the event itself makes (§3) — and one column the folder gets for free
from the file system — the order an event arrived in:

```sql
CREATE TABLE events (
  seq      INTEGER PRIMARY KEY,     -- insertion order; what the token names (§5.4 promises no order, so this is the store's own)
  eid      TEXT NOT NULL UNIQUE,
  author   TEXT NOT NULL,
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,
  blobs    TEXT NOT NULL,           -- JSON array of CIDs (roots), '[]' for none
  data     TEXT NOT NULL            -- the event's `data`, JSON
);
CREATE INDEX events_order ON events (at, eid, author);
-- Fields of `data` a store wants to filter on are its own choice, e.g.
--   my_key   TEXT GENERATED ALWAYS AS (json_extract(data, '$.myKey')),
--   peer_key TEXT GENERATED ALWAYS AS (json_extract(data, '$.peerKey')),
-- with an index on (my_key, peer_key, at, eid). The model does not say.
CREATE TABLE blobs (cid TEXT PRIMARY KEY, bytes BLOB NOT NULL, written TEXT NOT NULL);   -- `written`: renewed by a repeated put (§6)
CREATE TABLE links (parent TEXT NOT NULL, child TEXT NOT NULL);   -- a dag-pb block's links, filled on put; derived, rebuildable from `blobs`
CREATE TABLE files (path TEXT PRIMARY KEY, bytes BLOB NOT NULL);
```

An extension store (§6.2) is another such pair of tables, or the same
tables with an `ext` column; the model does not say.

`append` and `ingest` are `INSERT` with the `UNIQUE` on `eid`
catching duplicates, which the store then compares for conflict (§3);
`scan` is a `SELECT` with the filter as `WHERE` — envelope columns,
generated columns, else `json_extract` — and `ORDER BY at, eid,
author`; `changes` takes `token = MAX(seq)` and selects `seq > since
AND seq <= token ORDER BY seq`, prefixed by the instance id. Export
renders each author's rows into one segment in `seq` order and
remembers nothing (§7.2). Blob write and skeleton append become one
transaction, which the folder store cannot offer (§6), and the grace
may be zero. `collect(keep)` is a recursive query over `links` from
`keep` and a `DELETE` of every `cid` not reached whose `written` is
older than the grace.

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
  on whatever it filters by (`[data.myKey, data.peerKey, at, eid]` for
  threads);
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
- **`VaultBackend` stays, plus one method.** OPFS (`createWritable`
  atomic on close, append as size-then-seek), Node `fs`, and memory:
  330 lines, with `modified(path)` added for a block's age (§6,
  `vault-folder.md` §7) — `File.lastModified` on OPFS, `stat` on
  Node, a map in memory. The folder store sits on it. Neither `fs`
  nor OPFS syncs on append today, which is what §5.1 promises no more
  than.
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
- **Indexing** (§5.3): equality on `author`, `type` and a top-level
  field of `data` lets a store index what it
  likes; whether the folder store should keep a local index for the
  pair under its owner's cache (`vault-folder.md` §6.4), or leave all of that to folds, is for when
  open is slow.
- **`fsync` on Node** (§5.1): a per-append `fsync` in `FsBackend` would
  let the daemon claim power-loss durability. Cheap; not decided.
- **The profile's hasher in the store** (§6): `put` chunks and roots
  by `unixfs-v1-2025`, and collection decodes dag-pb links. Both live
  in `@estoc/folder-object` today, with the exporter beside them.
  Whether `@estoc/vault` depends on that package or on a smaller one
  split out of it (the CID helpers, the chunker, a links decoder) is
  an implementation matter; the profile and the names are fixed
  either way.
- **A logical clock** (§4): latest-wins is by `at`, a wall clock. If
  a field ever needs "the person's last decision" rather than "the
  latest timestamp", the change is a hybrid logical clock in the
  envelope, not a rule in a fold; nothing in version 2 needs it.
- **Daemon RPC.** Once the store is the interface, the daemon could
  expose `changes(since)` and push events rather than records, and the
  app's cache could be an IndexedDB store fed by it. Not this
  document's call.
- **Device-to-device sync** (§5.4): anti-entropy over `eid` sets, its
  own design; nothing here should have to change for it beyond what
  `vault-folder.md` §11 already says.
- **Extensions.** An extension's state is local (§6.1) or its own
  store (§6.2), and the vault's set records only that it was installed,
  removed or purged (`vault-events.md` §5). Version 2's extensions
  are first-party: the application ships them, the vault carries no
  code. Not decided, and deferred with third-party extensions: what
  `extension.installed` names — a hash of the code, the root of a
  signed object, a name to be resolved — and how a device obtains the
  bytes (carried in the extension's own store as blocks under a host
  event; or fetched by the root); how the application grants an extension the vault's own store to
  act as the application; and whether an extension runs where the agent
  runs (and sees what it sees) or only where the person looks, which is
  the application's boundary, not the store's. The agent's trace was
  the first owner of local state and has no store of its own.
