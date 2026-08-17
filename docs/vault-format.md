# The `.estoc` vault format, version 1

Status: **contract** — 2026-08-17. This document freezes the on-disk format
every Estoc client reads and writes. `@estoc/agent-core` is the reference
implementation; where the two disagree, this document is what the code has
to be brought back to. It describes the format *as decided*, which differs
from what agent-core ≤ 0.12 writes in the ways listed at the end; no vault
exists outside development, so there is no migration from those.

## 1. What a vault is

A vault is a directory. The directory **is** the format: a backup is the
directory zipped, a restore is the zip unpacked, and any client that can
read files can read a vault. Nothing about an identity lives anywhere else.

The directory has two halves. `.estoc/` is the machine's: identity, keys,
contacts, mail. Whatever surrounds it is the person's — documents to
publish, one day — and is not specified here. In the browser today the
vault root is the origin's OPFS root and only `.estoc/` exists; the
passphrase-unlocked seed cached in IndexedDB is a device convenience, not
part of the vault.

## 2. Principles

Everything below follows from six rules. When a new file is added, it must
say which of them it obeys.

1. **Three kinds of file, three merge rules.** Every file is one of:
   - a **record** — a small, mutable thing with an id, one JSON file, named
     by its id, rewritten whole; merged by id, later `updatedAt` wins;
   - a **log** — immutable events, append-only JSONL in segments named by
     uuid; merged by union, deduplicated by a per-log key, never rewritten;
   - a **singleton** — `config.json`, `keystore.json`: one per vault, kept
     local on merge (see §7 for the one exception, the keystore's key list).
2. **Files are named by ids, never by names.** A contact file is
   `<cid>.json`, not `<petname>.json`; a key is `pair/<cid>/<id>`, not
   `pair/<cid>/<n>`. Ids are minted at creation and never computed from
   the state of anything else — no counters, no "next index", no "count of
   what exists so far". Petnames, DIDs, key indices are clothing.
3. **Files encode facts, not interpretations.** Which contact a message
   belongs to is resolved at read time through DID histories; whether a
   message was delivered is a separate event beside it; how any of it
   looks on a screen is the application's business. A fact, once written,
   is not edited.
4. **DIDs are snapshots.** Every DID in the vault is the string that was
   handed out at the moment it was minted, and is checked — never
   recomputed — against the seed on open. Changing a mediator mints new
   DIDs; it never silently renames one a correspondent holds.
5. **Derived state, not steps.** Wherever a process can be interrupted, the
   files record *what is true* (this DID has no `registeredAt`; this
   contact's current DID does not ride the current routing DID) and every
   start re-derives what to do. Nothing has to be undone after a crash.
6. **Additive evolution.** Fields are added, optional, and unknown ones are
   preserved by readers that do not understand them. Anything else is a
   new format version (§8).

## 3. Layout

```
.estoc/
  config.json               singleton — format/version, label, identity anchor, current mediation
  keystore.json             singleton — @estoc/keystore v3: one sealed seed + a cache of key names
  contacts/<cid>.json       record — one per contact
  invitations/<id>.json     record — one per single-use invitation issued
  messages/<uuid>.jsonl     log — every message between this vault and its contacts
  deliveries/<uuid>.jsonl   log — what became of each outbound message, per try
  state/                    reserved — high-churn per-person state (read cursors, drafts); §6.7
  blobs/                    reserved — content-addressed bytes lifted out of messages; §6.8
  cache/                    reserved — rebuildable indexes; never backed up, never merged; §6.9
```

Paths are `/`-separated, relative to the vault root, ASCII, no `.` or `..`
segments. Text files are UTF-8; JSON files are pretty-printed with a
trailing newline; JSONL lines are compact JSON terminated by `\n`.

## 4. Identifiers and time

- **Local ids** — `cid`, `mid`, a mediation's `id`, a pairwise DID's id —
  are UUIDv7 (time-ordered; sortable as strings; a generator per client
  is fine). They never leave the machine.
- **Wire ids** — a DIDComm message `id`, an invitation's `id` (the
  out-of-band message id) — are what the protocol makes them (random
  UUIDs). A wire id is a claim by whoever sent it: a deduplication key and
  a thread reference, **never** a storage identity. A message record's
  `mid` and its `msg.id` are two different things and are never unified.
- **Time** is ISO 8601 UTC with milliseconds (`2026-08-17T10:00:00.000Z`).
  Ordering *within* a device is by log position or by UUIDv7; timestamps
  break ties across devices only (merges) and are known to be only as
  good as the clocks.

## 5. Keys and derivation

One seed, sealed under a passphrase in `keystore.json`, derives every key.
Derivation is HKDF-SHA256 over the seed with

```
salt = "estoc-keystore"
info = "estoc/v3/<purpose>/<name>"        purpose ∈ { ed25519, x25519 }
```

The **name is the derivation path.** The same seed and the same name
always give the same key, so `keystore.json`'s key list is a cache, not
an allocation table (§6.2), and a key can be derived from its name alone
before — or without — its cache entry existing.

Names match `[A-Za-z0-9._/-]+`, are never renamed and never reused. Every
name is `<kind>/…/<id>` where the id is the id of the thing the key
belongs to — the one fixed name is the root:

| name | derives | id belongs to |
| --- | --- | --- |
| `anchor` | did:key — the identity's root; `config.identity.anchor` | — (fixed; seed alone recovers it) |
| `mediation/<id>/me` | did:peer:4, no service — the DID the mediator knows us by | the mediation, `config.mediation.id` |
| `mediation/<id>/public` | did:peer:4, service = routing DID — the address for strangers | the same mediation |
| `pair/<cid>/<id>` | did:peer:4 toward contact `cid`, service = routing DID | that `myDids[]` entry (its id is only ever the key's suffix) |
| `invite/<id>` | did:peer:4 an invitation hands out | the invitation (its out-of-band message id) |

There is no counter anywhere in a name: not a generation, not "the nth
key toward this contact". Two devices minting toward the same contact
mint two keys; a merge keeps both (§7).

`anchor` is the one thing recoverable from the seed with no other file:
two vaults are the same identity iff their anchor DIDs are equal, and that
is the check every merge starts with.

The keystore document version is 3 and the derivation label is `estoc/v3`:
the two move together, so one number identifies both the document shape
and the derivation scheme. Earlier keystore documents — v1
(independently sealed keys) and v2 (index-derived, label `estoc/v1`) —
are refused, not migrated: v3 is the only store.

## 6. Files

### 6.1 `config.json` — singleton

```jsonc
{
  "format": "estoc",
  "version": 1,
  "label": "Alice",                              // display name; what user-profile announces
  "identity": {
    "anchor": { "key": "anchor", "did": "did:key:z6Mk…" }
  },
  "mediation": {                                 // or null: an identity that is not (yet) reachable
    "id": "0198…",                               // uuidv7, minted by setMediator
    "mediatorDid": "did:web:mediator.estoc.dev",
    "me":     { "key": "mediation/0198…/me",     "did": "did:peer:4…" },
    "routingDid": "did:peer:2…",                 // from mediate-grant; null until granted
    "public": { "key": "mediation/0198…/public", "did": "did:peer:4…" }  // null until granted
  }
}
```

- `format` and `version` govern the whole vault (§8). Readers refuse a
  version they do not know.
- Every `{key, did}` is a **key ref**: the keystore name and the DID it
  was minted as (a snapshot, §2.4). Open re-derives and compares.
- `mediation` is the *current* reachability decision, one at a time. A
  change of mediator replaces it wholesale with a fresh `id` and fresh
  `me`/`public` keys (so two mediators cannot correlate one vault by a
  shared DID). Retired mediation keys stay in the keystore because retired
  public DIDs still open old mail and still sign `from_prior` for contacts
  who only ever wrote to them; the retired public DID itself is recorded
  in the `myDids[]` of every such contact (§6.3).
- Merge: kept local. `mediation` is a fact about *this* device's
  arrangement with a mediator; `label` and `anchor` are the same on both
  sides by construction.

### 6.2 `keystore.json` — singleton (`@estoc/keystore` v3)

```jsonc
{
  "version": 3,
  "seedJwe": "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIi…",   // the 32-byte seed, PBES2-HS512+A256KW / A256GCM
  "keys": [
    { "name": "anchor",                    "did": "did:key:z6Mk…", "createdAt": "…" },
    { "name": "mediation/0198…/me",        "did": "did:key:z6Mk…", "createdAt": "…" },
    { "name": "pair/0198…/0198…",          "did": "did:key:z6Mk…", "createdAt": "…" }
  ]
}
```

- `seedJwe` is the only secret in the vault. The passphrase seals it and
  nothing else (§9).
- `keys[]` is a **cache**: which names have been minted, when, and the
  did:key of each Ed25519 half so a client can list keys without
  unlocking. It is not the source of truth for which keys exist — the
  records that reference them are (`config.mediation`, `contacts/*.myDids[].key`,
  `invitations/*.key`) — and it can be rebuilt by walking those records
  and re-deriving. A name referenced by a record but missing here is
  derived on demand and may be added; an entry here that no record
  references is harmless residue (a crash between minting and recording)
  and may be dropped.
- Writers therefore record first and cache second: the contact (or config,
  or invitation) naming a new key is written before the keystore entry.
- Merge: `seedJwe` stays local (same seed, possibly a different
  passphrase); `keys[]` is the union by `name`. This is the one part of
  a singleton that merges — it can, because it is only a cache.

### 6.3 `contacts/<cid>.json` — record

```jsonc
{
  "cid": "0198…",                     // uuidv7; the anchor every other file refers to
  "name": "alice",                    // petname; free to change
  "createdAt": "…",
  "updatedAt": "…",                   // stamped on every write; the merge tiebreak
  "claimedName": "Alice L.",          // what they said over user-profile — a claim, never verified
  "dids": [                           // theirs, oldest first; the one without `until` is current
    { "did": "did:peer:4…old", "from": "…", "until": "…" },
    { "did": "did:peer:4…new", "from": "…", "fromPrior": "eyJ…" }   // the JWT the old DID signed announcing the new one
  ],
  "myDids": [                         // ours toward them, oldest first; absent while we never wrote
    { "did": "did:peer:4…", "key": "mediation/0198…/public", "from": "…", "until": "…" },   // a retired public DID they once wrote to
    { "did": "did:peer:4…", "key": "pair/0198…/0198…", "from": "…", "registeredAt": "…" }
  ],
  "addressedAs": "did:peer:4…",       // the DID of ours their latest envelope was sealed to (proven by our opening it)
  "invitation": "…",                  // the out-of-band id of theirs we accepted to meet them, if that is how it began
  "profileSharedAt": "…"              // when our user-profile went out to them
}
```

- The file is named by `cid`; the petname is inside. A record has one home
  for life.
- `dids[]` is a chain with evidence: `fromPrior` is the JWT that proved a
  hop, kept so the history is verifiable, not remembered.
- `myDids[]` mirrors it from our side. `key` names the keystore entry;
  `registeredAt` absent means "the mediator has not accepted this DID as
  a recipient yet" and every start retries (§2.5). A retired public DID
  appears here, closed, for contacts who wrote to it and were never
  answered — the prior a later `from_prior` will name.
- Attribution: a message belongs to the contact whose `dids[]` contains
  the DID the envelope proved (§6.5) — current or historical.
- Merge: by `cid`; the later `updatedAt` wins whole; a tie keeps the local
  record. (Under the single-home rule of §10 this is sufficient; a
  field-level merge of the two histories is a possible later refinement,
  not a format change.)
- Deletion is a hard delete of the file. Messages from that contact's DIDs
  become unattributed, and a merge from a copy that still has the record
  brings it back. A tombstone (`deletedAt`, DID history kept) is the
  likely refinement when either of those bites; it would be additive.

### 6.4 `invitations/<id>.json` — record

```jsonc
{
  "id": "…",                          // the out-of-band/2.0 message id; the answer names it as pthid
  "key": "invite/…",
  "did": "did:peer:4…",               // service = routing DID at the time
  "createdAt": "…",
  "goal": "Write to Alice",
  "registeredAt": "…",                // absent until the mediator accepted the DID
  "acceptedBy": "0198…",              // cid of whoever answered first; absent while open
  "acceptedAt": "…"
}
```

- Open ⇔ `acceptedBy` absent. The first envelope sealed to the DID takes
  it: the `{key, did, registeredAt}` move into that contact's `myDids[]`
  (name unchanged), and the invitation is marked. Anyone else writing to
  it afterwards is turned away.
- Merge: by `id`; added when missing; an open one here that the incoming
  copy knows to be taken becomes taken (the DID is spent either way).

### 6.5 `messages/<uuid>.jsonl` — log

One line per message that passed between this vault and anyone who is
not its mediator, in either direction:

```jsonc
{ "mid": "0198…", "at": "…", "direction": "in", "sender": "did:peer:4…", "msg": { …plaintext as unpacked… } }
{ "mid": "0198…", "at": "…", "direction": "out", "msg": { "id": "…", "type": "…", "from": "…", "to": ["…"], "body": {…} } }
```

- `mid` is the local primary key, minted at append and written into the
  line — never assigned by a reader.
- `msg` is the DIDComm plaintext exactly as it arrived or left; every
  protocol field (`id`, `type`, `thid`, `pthid`, `from_prior`,
  `attachments`) stays available to later readers.
- `sender` (inbound only) is the DID the envelope *proved* — the authcrypt
  key's DID — and is the only basis for attribution. The plaintext `from`
  is never trusted for that. An anonymous envelope is logged with
  `sender: null` and belongs to nobody.
- What is logged: everything between contacts — messages, pings,
  requests, unknown types, anonymous mail. What is not: traffic with the
  mediator (coordinate-mediation, pickup) and the `forward` wrapping.
  Whether a record is *shown* is the application's projection.
- Dedup keys for merge: `mid`, and `(direction, sender, msg.id)`.

### 6.6 `deliveries/<uuid>.jsonl` — log

One line per outcome of one try to deliver one outbound message:

```jsonc
{ "mid": "0198…", "at": "…", "status": "failed", "attempt": 1, "to": "did:peer:4…", "error": "…" }
{ "mid": "0198…", "at": "…", "status": "sent",   "attempt": 2, "to": "did:peer:4…" }
{ "mid": "0198…", "at": "…", "status": "held",   "attempt": 0, "error": "imported undelivered; retry by hand" }
```

- The state of a message is the fold of its events: **no event = pending**
  (written, never yet tried — or crashed between the two, which is the
  same); last `failed` = will be retried at start, on reconnect, before
  the next message to that contact, or by hand; last `held` = imported
  undelivered, retried by hand only; `sent` = final, whatever comes after
  (later receipt-like states, if any, are new statuses beside it, not
  rewrites).
- The message line is never touched by any of this. A message written
  offline is a fact; whether it went is another.
- Only outbound messages have deliveries; inbound "arrived" is the message
  line itself.
- Dedup key for merge: `(mid, attempt, status)`. `held` events do not
  merge in from another copy (they are that copy's own decision); instead
  every outbound message a merge or restore brings in without a `sent`
  behind it gets a fresh `held` here.

### 6.7 `state/` — reserved

High-churn, per-person, mutable state that must **not** live in a contact
record — read cursors, drafts, anything written on every glance. Putting a
cursor in `contacts/<cid>.json` would stamp `updatedAt` on every read and
let "I just looked at this" outrank a DID-history change on merge.

Rules fixed now, shape later: files under `state/` are small JSON, keyed by
what they are about (a `cid`, a `thid`); they travel with the vault (a
restore on a new device keeps your place); they merge **per key** by their
own timestamp — the newest wins, and for cursors that is equivalent to
`max`.

Per-contact *decisions* that change rarely (pinned, muted, archived) are
petname-class facts and belong in the contact record, not here.

### 6.8 `blobs/` — reserved

Content-addressed bytes lifted out of message lines: `blobs/<hash>` for
attachments larger than a line should carry, referenced from the message's
DIDComm attachment by its `hash` (and a `links` entry naming the blob).
Immutable; merged by union. Until this exists, attachments are inline in
`msg`.

### 6.9 `cache/` — reserved

Rebuildable indexes (a thread index, a search index, one day SQLite).
Anything here can be deleted at any time and is regenerated from the logs
and records. It is **not** part of a snapshot and is never merged.

## 7. Snapshot and import

- A **snapshot** is every file under `.estoc/`, recursively, except
  `cache/`, keyed by vault-relative path, bytes untouched. Not an allowlist:
  a client must not drop from a backup what a newer client (or another
  client) wrote. A backup zip's entries are these paths (`.estoc/config.json`,
  …); importers tolerate an enclosing folder or a bare `.estoc/` contents.
- **Import** lays a snapshot over a backend:
  - into an empty backend it is a **restore** — every file as it was,
    `config.json` written last so a crash midway leaves "no vault", not a
    vault missing pieces; then a `held` for every undelivered outbound
    message (§6.6);
  - into a vault with the **same anchor DID** it is a **merge**, by kind:
    logs by union under their dedup keys, each log's new records laid down
    as one new segment; records by their rules (§6.3, §6.4); `config.json`
    kept local; `keystore.json`'s `keys[]` unioned by name, `seedJwe`
    kept local; `state/` per key by timestamp; `blobs/` by union;
    `cache/` ignored; **any other path copied when absent, never
    overwritten**;
  - into a vault with a **different anchor DID** it is refused: two
    identities are two vaults.
- Merge never rewrites a line and never deletes a file. What it cannot
  express (a deletion made on one side) it does not attempt.
- Log segments are `<uuidv7>.jsonl` (lowercase); the name is minted when
  the segment is made, never computed from what else is in the directory
  (rule 2 — no "highest number plus one"). Readers concatenate segments in
  name order, which is creation order; **nothing may rely on cross-segment
  order for chronology** — a merge lays older records down in a newer
  segment — records carry their own `at`. A writer appends to the newest
  segment present, or mints one. Files in a log directory that are not
  `<uuidv7>.jsonl` are not segments.

## 8. Versioning

- `config.version` is the version of the whole vault. This document is
  version 1. A reader refuses a version it does not know.
- **Within a version**: new fields are optional and additive; readers
  ignore fields they do not know and **preserve them when rewriting a
  record** (a client must not strip another client's fields from a
  contact); a field's meaning never changes; new statuses, new kinds of
  file, new key kinds are additive too.
- **Across versions**: anything else — a renamed field, a changed merge
  rule, a changed derivation — is version 2, and a client that writes
  version 2 migrates a version-1 vault on open, once, forward only.
- `keystore.json` carries its own `version` (3) — it is a document the
  keystore package owns — and the derivation label matches it (`estoc/v3`).
  Changing either is a vault version change too, since the DIDs change.
- No line-level or record-level version fields: `config.version` covers
  every file.

## 9. Robustness and trust

- **Records** are written whole and atomically (a crash never leaves half
  a file where a good one was). **Logs** are appended; a crash may leave a
  cut-short last line, which readers report and skip; the next append
  first terminates such a fragment so two lines never fuse. Appends to
  one log are serialised within a writer.
- **One writer at a time** per vault. The format does not arbitrate two
  clients on one directory (in the browser, the application takes a Web
  Lock); a second writer must wait or read only.
- **At rest, the vault is plaintext** except the seed. Messages, contacts,
  and key *names* are readable files, and so is a backup zip apart from
  `seedJwe`. The passphrase protects the ability to *use* the identity,
  not the history; a client wanting encryption at rest wraps the backend,
  and must say so plainly in its copy.
- **Attribution is the envelope's**, never the plaintext's (§6.5).
  `fromPrior` JWTs are kept as evidence, not summarised.

## 10. Boundaries (deliberate non-goals of version 1)

- **A backup is a move, not a sync.** One vault has one home at a time;
  a merge reconciles the copies of one person's history, not two live
  devices' concurrent activity. Concretely: `config.mediation` is
  device-local; two devices minting toward the same contact mint two
  DIDs, and the contact record's whole-file merge picks one history;
  undelivered mail from another copy is held, not sent. The format leaves
  the door open (name-derived keys make the keystore mergeable; nothing
  in a name depends on local state) but does not walk through it.
- **No encryption at rest**, no per-file secrecy beyond the seed.
- **No indexes** in the format; queries scan (`cache/` is where an
  index would go, and it is disposable).
- **The person's half of the folder** — documents, renderers, anything
  outside `.estoc/` — is unspecified here.

## 11. From agent-core 0.12 to this document

What the reference implementation had to change to match — done in
`@estoc/keystore` 0.3.0 and `@estoc/agent-core` 0.13.0 (2026-08-17); kept
here as the record of what moved. Nothing here migrates a 0.12 vault;
there were none to migrate.

1. **`@estoc/keystore` 0.3.0** — document v3: drop `nextIndex` and every
   `index`; `keys[]` entries are `{name, did, createdAt}`; derivation
   `info = estoc/v3/<purpose>/<name>`; `deriveIdentity(seedKey, name)`;
   `addDerivedKey` idempotent by name (same name → same key; refuse a
   name that fails the grammar); `openDerivedKey` derives from the name
   whether or not the cache lists it; retire v2 parsing (v1 stays).
2. **agent-core key names** — `mediation/<id>/me`, `mediation/<id>/public`,
   `pair/<cid>/<uuidv7>`; `invite/<id>` unchanged; `anchor` unchanged.
   Delete `mediationKeyName`, `mediationGeneration`, the pair counter in
   `mintPairwise`, and the "reuse the key a crash left in the index"
   branches; write the record before the cache entry.
3. **`config.mediation.id`** (uuidv7, minted in `Vault.setMediator`).
4. **Snapshot = everything under `.estoc/`** except `cache/`: `VaultBackend`
   gains a way to list subdirectories (or a recursive walk); `snapshotVault`
   walks; `importVault` merges by kind and copies unknown paths when absent.
5. **Segment names** — `<uuidv7>.jsonl`, minted (no counter); readers
   order by name and drop non-segment files.
6. **Readers preserve unknown fields** in records they rewrite (contacts,
   invitations): parse into the typed shape without dropping extras.
7. Re-pin the fixed-seed test vector (anchor and the `mediation/…/me` DID
   under `FIXED_SEED`); update README "Identity" table and CHANGELOGs;
   the app needs no format code, only a wipe of development vaults.
