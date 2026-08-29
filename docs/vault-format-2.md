# The `.estoc` vault format, version 2 — draft

Status: **draft**, 2026-08-29. Not implemented; nothing writes it yet.
Version 1 (`vault-format.md`) stays the contract until this document is
frozen and `@estoc/vault` migrates a version-1 vault forward on open (§13).
Sections marked *provisional* are leanings, not decisions.

## 0. What changes, in one paragraph

Version 1 kept three kinds of file — records, logs, singletons — and let a
record (`contacts/<cid>.json`) be the truth about who a message belongs to.
Version 2 keeps only logs and singletons. Every file that is not a
singleton is an append-only event, either an **observation** (what an
envelope proved, what the wire returned) or a **decision** (what the
person chose); everything else — which contact a message belongs to, what
a contact's current DID is, whether an invitation is still open — is a
**fold** over those events and lives in `local/cache/`, rebuildable. Every log
lives under the device that authored it, so another copy of the vault is
merged by copying directories; what is this device's alone — which
device it is, its caches, its traces — lives under `local/` and is never
in a backup. A log line carries a message's skeleton;
its body is a blob beside it, and retention is deleting blobs, never log
lines. Messages are partitioned by what the envelope proved — our key and
their key, not their DID and not our decision about who they are; keys
are named by random ids, not by the contact they were minted for.

## 1. What a vault is

Unchanged from v1 §1: a directory, `.estoc/` is the machine's half, a
backup is the zip.

## 2. Principles

v1's six rules stand (§2 there). Two are sharpened and five are added.

1. **Two kinds of file.** A **log** — immutable events, append-only JSONL
   in segments, merged by union — or a **singleton**. There are no
   records. Where v1 rewrote a small JSON file whole, v2 appends an event
   and folds.
2. **Names carry no decisions.** v1 said ids are minted, never computed.
   v2 adds: a name must not encode *whose* something is. `pair/<cid>/<id>`
   encoded a contact into a key name at mint time; v2 keys are `did/<id>`.
3. **Every event under `devices/<dev>/` was authored by device `dev`.**
   A device appends only under its own directory. Another device's
   directory is only ever copied — whole files, never created, edited,
   or truncated — however many hands the copy passed through. Authorship
   is a path, and a merge is a copy.
4. **Observation before decision.** An event is one or the other, never
   both. Observations are written in the partition the envelope proves
   (§7) and need no local state to place. Decisions are written under
   the thing decided about (`contacts/<cid>/`, `me/`; a decision about
   one message, beside that message, §10) and carry their grounds
   inline, because the bodies they rest on may be purged.
5. **Folds are pure and commutative.** `now` is a parameter; a setting
   that affects a fold is an event; the order two segments are read in
   must not change the result. Tests: incremental = full; shuffled = same;
   merge(A,B) = merge(B,A).
6. **Conflicts are projections.** Two devices deciding differently
   produce two events, not an error. The fold shows both; a later decision
   resolves them. Merge never rewrites, never drops, never invents.
7. **Logs are never deleted from.** Not a line, not a segment, not a
   directory. The only thing ever unlinked is a blob (§10) — and, under
   `local/`, what was never part of the vault.

## 3. Layout

```
.estoc/
  config.json                                singleton — format/version, label, anchor
  keystore.json                              singleton — @estoc/keystore v3, unchanged
  blobs/<hash>                               content-addressed bytes — message bodies, attachments; global; the one place purge deletes from
  devices/<dev>/                             everything device <dev> wrote
    device.json                              singleton-per-device — minted, current mediation
    me/<seg>.jsonl                           log — decisions about my DIDs: minted, registered, published, retired
    contacts/<cid>/<seg>.jsonl               log — decisions about a contact
    parts/<myKey>/<peerKey>/<seg>.jsonl      log — observations in one partition: skeletons, deliveries, resolutions
  state/                                     reserved, as v1 §6.7
  local/                                     this backend's own; never in a snapshot, never merged; §6.4
    device.json                              which <dev> this backend writes as
    options.json                             device options: retention policy, trace retention
    cache/                                   rebuildable folds; §12
    trace/<stream>/<seg>.jsonl               device observations with retention; as v1 §6.10
```

Gone: `contacts/<cid>.json`, `invitations/`, `messages/`, `deliveries/`,
v1's `config.mediation`, and top-level `cache/` and `trace/` (moved
under `local/`).

`<seg>` is a uuidv7. Path rules as v1 §3. A log's segments are the union
of `devices/*/<log path>/<seg>.jsonl`; a reader concatenates them and
lets events carry their own `at`.

## 4. Identifiers and time

- **`dev`** — a device id, 6 lowercase base32 characters, minted the first
  time a backend opens (or creates) the vault and finds no
  `local/device.json`. Recorded there (which one *I* am) and in
  `devices/<dev>/device.json` (that this one exists). It appears in every
  event id this device writes. Not secret; not carried by a restore,
  since `local/` is not in a snapshot — a restore mints a fresh one and
  keeps the old directory as history.
- **`eid`** — every event's id: `<uuidv7>-<dev>`. The dedup key for every
  log. Time-ordered within a device; across devices only `at` orders,
  with `(uuidv7, dev)` as the tiebreak wherever a fold needs "latest".
- **Segments** are `<uuidv7>.jsonl` under the writing device's
  directory; the writer appends to its newest segment or mints one.
- **`pid`** — a partition id, the path `<myKey>/<peerKey>` (§7): the one
  id that is computed rather than minted, because it must come out the
  same on every device.
- **`cid`**, **`mid`**, mediation `id`, key `id` — uuidv7, as v1.
- Wire ids and time as v1 §4.

## 5. Keys

Derivation unchanged (`estoc/v3/<purpose>/<name>`, HKDF over the seed;
v1 §5). The name table shrinks:

| name | derives | notes |
| --- | --- | --- |
| `anchor` | did:key — the identity | fixed |
| `mediation/<id>/me` | did:peer:4, no service — how the mediator knows us | one per mediation |
| `did/<id>` | did:peer:4, service = routing DID — a DID of ours handed to people | `id` random uuidv7 |

Every DID we give to a person is a `did/<id>`. Whether it went into an
out-of-band invitation, onto a profile page, or straight to one contact;
whether it is meant for one taker or many; whom it now belongs to — these
are decisions in `me/` and `contacts/`, not in the name. The v1 names
`pair/<cid>/<id>`, `invite/<id>`, `mediation/<id>/public` remain valid
derivation names for keys that already exist (§13); no new key is minted
under them.

`keystore.json` is unchanged: `keys[]` stays a cache, rebuilt by walking
every device's `me/` for `did.minted` and `device.json` for `me`.

## 6. Singletons

### 6.1 `config.json`

```jsonc
{
  "format": "estoc",
  "version": 2,
  "label": "Alice",
  "identity": { "anchor": { "key": "anchor", "did": "did:key:z6Mk…" } }
}
```

Only what is true of the identity as a whole. Merge: kept local; both
sides agree by construction.

### 6.2 `keystore.json`

As v1 §6.2.

### 6.3 `devices/<dev>/device.json`

```jsonc
{
  "dev": "k7q3ma",
  "mintedAt": "…",
  "label": "phone",                              // optional, the person's
  "mediation": {                                 // this device's arrangement; or null
    "id": "0198…",
    "mediatorDid": "did:web:mediator.estoc.dev",
    "me": { "key": "mediation/0198…/me", "did": "did:peer:4…" },
    "routingDid": "did:peer:2…",
    "public": "did/0198…"                        // the key published as this device's address; null until granted
  }
}
```

- v1's `config.mediation`, moved to where it was always true: a
  mediation is one device's arrangement with one mediator. Another device
  can *see* it (the fold shows every device's address) without adopting
  it.
- `mediation.public` is a key name pointing into `me/`; the DID and its
  registration live there.
- Rewritten whole by its own device only (rule 3). On merge it is copied
  with the rest of the directory.

### 6.4 `local/` — this backend's own

Everything that is true of *this copy on this machine* and of nothing
else. Never in a snapshot, never merged, never read by another device.

```jsonc
// local/device.json
{ "device": "k7q3ma" }
// local/options.json — shape owned by the implementation; e.g.
{ "retention": { "bodies": { "keep": "P90D" } }, "trace": { "wire": { "keep": "P30D", "cap": 33554432 } } }
```

- `device.json` is the pointer every write and every merge needs: which
  `devices/<dev>/` is mine. Missing means "first open on this backend":
  mint a `dev`, write both files, go on.
- `options.json` holds device options — v1 §6.10 said a retention policy
  is never written into the vault; `local/` is not the vault in the
  sense that matters (it is not what a backup carries), so the policy
  has a file without becoming a fact.
- `cache/` (§12) and `trace/` (v1 §6.10) move here unchanged in meaning:
  both are this device's, one rebuildable and one not.
- Two processes sharing one `local/` share one `dev` and must serialise
  as v1 §9 requires (Web Lock, file lock).

## 7. Partitions — `parts/<myKey>/<peerKey>/`

A partition is every observation involving one key of ours and one public
key of theirs. It is placed by the envelope alone — the key that opened
it and the key that sealed or signed it — with no lookup:

| envelope | `myKey` | `peerKey` | `kind` |
| --- | --- | --- | --- |
| authcrypt, opened with our key K, sealed by their X25519 key P | K | hash(P) | `authcrypt` |
| anoncrypt, opened with K | K | `anon` | `anoncrypt` |
| signed only, by their Ed25519 key P | `-` | hash(P) | `signed` |
| outbound, sealed from our K to their key P | K | hash(P) | `authcrypt` |

```
peerKey = base32lower( sha256( multicodec-prefixed raw public key ) )[0:26]
```

i.e. the hash of the bytes a `did:key` of that key encodes (`z6LS…` for
X25519, `z6Mk…` for Ed25519). Hashed rather than used raw for uniform
length and safety on case-insensitive filesystems.

The DID is **not** in the partition key. A DID is a name a key wears:
`did:peer:4` commits to its keys, `did:web` and `did:peer:2` can change
them, and the envelope proves the key either way. So a `did:web` owner
rotating keys opens a new partition exactly as a `from_prior` rotation
does, and the two are linked the same way — by observation (§7.1
`peer.resolved`). A consequence, not a goal: neither side's routing DID
is in the key, so a partition survives either side changing mediator
while keeping keys.

```
devices/k7q3ma/parts/did/0198…/k3j9…/          authcrypt with our did/0198…, as seen by k7q3ma
devices/k7q3ma/parts/did/0198…/anon/           anoncrypt to our did/0198…
devices/k7q3ma/parts/-/k3j9…/                  signed only
devices/k7q3ma/parts/pair/0198…/0198…/k3j9…/   a legacy key, migrated (§13)
```

The same partition appears under every device that observed it; the
partition's log is their union. `parts/<myKey>/` is "everyone who ever
wrote to this key of ours" — which is not the same as one contact: a
key is a DID, and a DID can be handed on. Attribution therefore anchors
on the whole pair (§9.1), never on `myKey` alone.

### 7.1 Partition events

One log, one `type` per line, `eid` as the dedup key:

```jsonc
{ "eid": "0198…-k7q3ma", "at": "…", "type": "part.opened",   "key": "did:key:z6LS…", "kind": "authcrypt", "firstDid": "did:peer:4…" }
{ "eid": "…", "at": "…", "type": "message.in",    "mid": "0198…", "id": "<wire id>", "msgType": "https://…/message", "thid": "…", "pthid": "…", "bytes": 48213, "body": "<hash>" }
{ "eid": "…", "at": "…", "type": "message.out",   "mid": "0198…", "id": "…", "msgType": "…", "thid": "…", "bytes": 1120, "body": "<hash>" }
{ "eid": "…", "at": "…", "type": "delivery",      "mid": "0198…", "attempt": 1, "status": "failed", "error": "…" }
{ "eid": "…", "at": "…", "type": "delivery",      "mid": "0198…", "attempt": 2, "status": "sent" }
{ "eid": "…", "at": "…", "type": "peer.resolved", "did": "did:peer:4…", "keys": ["did:key:z6LS…", "did:key:z6Mk…"], "service": "did:peer:2…" }
{ "eid": "…", "at": "…", "type": "peer.rotated",  "to": "did:peer:4…new", "fromPrior": "eyJ…", "mid": "0198…" }
```

- `part.opened`: the first line a device writes in a partition — the
  full peer key (the hash in the path is not reversible), the kind, and
  the DID the key wore when first seen. Readable context; the truth
  about which DIDs a key belongs to is `peer.resolved`. Every device
  writes its own on first contact with the partition.
- `message.in` / `message.out`: the **skeleton** of a message — its
  local `mid` (minted at append), the wire `id`, `msgType`, `thid`,
  `pthid`, size, and `body`, the hash of the blob holding the DIDComm
  plaintext exactly as it arrived or left (§7.3). Everything a thread
  view, a search index, or a retention rule needs is on the line;
  nothing a person said is. `direction` and `sender` are gone — the
  partition is both.
- `delivery`: as v1 §6.6, minus `to` — the partition is the `to`; the
  DID we sealed to is in the message's `msg.to`. Fold as before: no
  event = pending, last `failed` = retry, `held` = by hand, `sent` =
  final. `held` is a device decision; a fold reads only the writing
  device's `held` as binding on that device.
- `peer.resolved`: we resolved a DID and found this partition's key in
  its document — on every inbound (the skid's DID) and before every
  outbound (the DID we are writing to). Records the whole key list and
  the service, so a later reader sees what the document said then. This
  is the edge that joins partitions: two partitions whose keys were
  found under one DID are one counterpart (§9.1). For `did:peer:4` the
  resolution is local and deterministic; for `did:web` it is the same
  trust we already place in it by writing to it.
- `peer.rotated`: lifted from a `message.in` whose plaintext carried a
  valid `from_prior` signed by a key of this partition's DID, naming
  `to`. Written in the **old** partition, carries the JWT as evidence,
  names the `mid` it came from. The other edge the fold follows.
  *Provisional:* a separate event rather than re-parsing every message
  on fold.
- `message.cleared`: §10.
- Nothing about who the peer *is* goes here.

### 7.2 Frozen partitions

A partition is **frozen** when its `myKey` is not a current key of ours
(retired, or a mediation that is no longer current on the device asking)
or its `peerKey` is not in the current document of the contact's current
DID (§9.2). Frozen is a fold, never written: a frozen partition still
receives inbound observations (a late envelope to an old key is a fact)
but nothing is sent from it; a retention rule may treat "frozen" as a
reason to clear its bodies (§10).

### 7.3 Bodies — `blobs/<hash>`

A message's plaintext is written to `blobs/<hash>` **before** its line is
appended, `hash` = sha256 of the bytes, lowercase hex, sharded
`blobs/<hash[0:2]>/<hash>` on backends that want it. The same store holds
attachments lifted out of a plaintext (the DIDComm attachment keeps its
`hash` and gains a `links` entry naming the blob) and any other
content-addressed bytes (v1 §6.8). Blobs are immutable, merged by union,
deduplicated by construction, and the one directory outside `devices/`
that every device writes to — safely, because a content address has no
author.

A crash between the two writes leaves an orphan blob, harmless, swept by
the next garbage collection (§10). The other order is never used: a line
whose body was never written would be indistinguishable from a purge.

A blob that is **absent** is a body that was cleared (§10). Readers show
the skeleton and "cleared"; nothing else changes.

## 8. Decision logs

### 8.1 `me/` — my DIDs

```jsonc
{ "eid": "…", "at": "…", "type": "did.minted",    "key": "did/0198…", "did": "did:peer:4…", "routingDid": "did:peer:2…", "mediation": "0198…" }
{ "eid": "…", "at": "…", "type": "did.registered","key": "did/0198…" }                     // the mediator accepted it as a recipient
{ "eid": "…", "at": "…", "type": "did.published", "key": "did/0198…", "as": "oob", "oobId": "…", "goal": "Write to Alice", "uses": "one" }
{ "eid": "…", "at": "…", "type": "did.published", "key": "did/0198…", "as": "profile", "uses": "many" }
{ "eid": "…", "at": "…", "type": "did.retired",   "key": "did/0198…", "because": "mediation-changed" }
{ "eid": "…", "at": "…", "type": "device.retired","dev": "p2x8rq", "because": "lost" }
```

- `did.minted` is the one place a DID string of ours is recorded (the
  snapshot, v1 §2.4); the key is derived from the name and compared on
  use. The `mediation` id says which device's arrangement the routing
  DID came from.
- `did.registered` is the writing device's fact about its mediator; a
  fold treats it as binding for that device only.
- `did.published` says how the DID was handed out. `uses: one` is what an
  invitation was; `uses: many` is what the public DID was. An invitation
  is therefore not a file: it is a `did.published` with `as: oob`, and
  "open" is a fold (§9.4).
- `did.retired`: no further outbound from this key; inbound still opens.
- `device.retired`: a decision about another device (lost, replaced).
  Its directory stays — history is history — but a fold stops treating
  its `device.json` as a live address and shows any later events from it
  as suspect.

### 8.2 `contacts/<cid>/` — one contact

```jsonc
{ "eid": "…", "at": "…", "type": "created" }
{ "eid": "…", "at": "…", "type": "petname",   "name": "alice" }
{ "eid": "…", "at": "…", "type": "flag",      "pinned": true }
{ "eid": "…", "at": "…", "type": "claimedName", "name": "Alice L.", "mid": "0198…" }
{ "eid": "…", "at": "…", "type": "useKey",    "key": "did/0198…", "because": "minted" }
{ "eid": "…", "at": "…", "type": "attach",    "pid": "did/0198…/k3j9…", "because": "invitation", "oobId": "…" }
{ "eid": "…", "at": "…", "type": "attach",    "pid": "did/0198…/k3j9…", "because": "reply" }
{ "eid": "…", "at": "…", "type": "attach",    "pid": "-/m8v2…", "because": "manual" }
{ "eid": "…", "at": "…", "type": "detach",    "pid": "…" }
{ "eid": "…", "at": "…", "type": "absorb",    "from": "<cid>", "supersedes": ["<eid>", "<eid>"] }
{ "eid": "…", "at": "…", "type": "profileShared", "mid": "0198…" }
{ "eid": "…", "at": "…", "type": "deleted" }
```

- `attach pid`: **the one attribution anchor.** This partition — this
  key of ours *and* this key of theirs — belongs to this contact. Written
  when the person accepts an invitation (`because: invitation`, the
  partition the accepted envelope landed in), when the first envelope
  from a counterpart arrives on a key we minted toward them (`reply`),
  when the person adopts a stranger (`manual`), and by migration.
  Nothing else attributes: not the key we used, not the DID they
  claimed in a plaintext.
- `useKey key`: we address this contact from this key. Outbound only —
  it picks the `myKey` to seal with and says nothing about who writes
  back. Minting a key toward a contact is `did.minted` + `useKey`.
- `absorb from`: the other contact's attaches and useKeys are this
  contact's; `supersedes` lists the conflicting eids it resolves. The
  absorbed contact gets a `deleted`.
- `claimedName` and `profileShared` are observations wearing a decision's
  clothes — they come from a message — and are kept here for the fold's
  convenience, with the `mid` as grounds. *Provisional.*
- `deleted` is a tombstone (§11).
- Latest-wins fields (`petname`, each `flag`) resolve by `(uuidv7, dev)`.
- Nothing here is ever deleted (§10).

## 9. Folds

All folds are rebuildable and live under `local/cache/` (§12). They read every
device's directory. They are the only place the word "contact" means
anything to a message.

### 9.1 Attribution — `pid → cid`

Build the **identity graph**: nodes are partitions (except `anon`
partitions, which have no peer key and join nothing) and DIDs; a
`peer.resolved` in P joins P to its `did`; a `peer.rotated` in P₀ joins
P₀'s DID to `to`. Take P's connected component and collect every live
`attach` (no later `detach`, not superseded by an `absorb`) whose `pid`
is in it:

- **none** → P is **unattributed**: a stranger, or a second taker of a
  one-use key, or someone the contact handed our DID on to. The
  application shows it as such; the person's "accept" is an `attach`.
- **one contact** → P belongs to it, and so does every partition in the
  component (a `did:web` key rotation, a `from_prior` hop, a signing key
  beside an agreement key).
- **several** → a **multi-value**: the fold returns all of them, the
  application shows the conflict, and an `absorb` resolves it. This
  happens when two devices each accepted the same stranger while apart;
  it is not an error.

`myKey` never enters into it. That a key was minted toward Alice, or
published in an invitation Alice took, says who we *meant* it for; who
actually sealed to it is the peer key, and only the pair is evidence.
Legacy `pair/<cid>/<id>` names are not read for their cid; migration
writes the `attach` (§13); the fold never parses names.

### 9.2 Contact state

From a contact's log and its attributed partitions:

- `petname`, flags, `claimedName`: latest event.
- `keys[]`: every live `useKey`, with its `did.minted` DID.
- `theirDids[]`: the DIDs in the contact's component of the identity
  graph, ordered by `peer.rotated`; the **current** DID is a chain's
  end, and its current keys are the latest `peer.resolved` for it. Two
  ends = multi-value, shown.
- `addressedAs`: the `myKey` of the latest `message.in` across attributed
  partitions.
- `writeTo`: the one unfrozen partition, if any; none means "must mint
  or rotate before sending".
- `thread`: the union of `message.*` across attributed partitions and
  devices, sorted by `at`. Cross-partition and cross-device order relies
  on `at` alone, as v1 §7 already required across segments.

### 9.3 My DIDs and devices

Per `did/<id>`: minted, registered (per device), published-as, uses,
retired, `usedBy` (the contacts with a live `useKey` on it), and
`takenBy` (the contacts with an `attach` on one of its partitions). Per device:
its `device.json` and whether it is retired — so the application can
list "your addresses" across every device without adopting another's
mediation.

### 9.4 Invitations

An invitation is a `did.published { as: oob, uses: one }`. It is **open**
iff no live `attach` names a partition under its key. It is **taken** by
the contact whose `attach` does — which also makes that contact's
`useKey` on the key implicit; the fold adds it. A second stranger
writing to a taken one-use key lands in its own partition (an
observation is never refused a home), is in no attached component, and
is shown unattributed; the application's policy is to turn it away.
Single use is therefore a policy, not a format guarantee — two devices
apart can each take the same invitation, and the fold shows two
attaches under one key, which is a conflict only if they are the same
peer key.

## 10. Retention

Nothing is ever deleted from a log. Retention operates on `blobs/` only:

- **Clearing** a message = deleting `blobs/<body>` and appending a
  decision, in the writing device's copy of the partition:

  ```jsonc
  { "eid": "…", "at": "…", "type": "message.cleared", "mid": "0198…", "because": "retention" }
  { "eid": "…", "at": "…", "type": "message.cleared", "mid": "0198…", "because": "user" }
  ```

  Event first, then unlink; a blob still present after a `cleared` is
  swept by the next collection. The skeleton stays: `mid`, thread
  structure, sizes, delivery outcomes, and the `cleared` line itself,
  which is why a gap is a fact on record rather than a mystery.
- **`because`** governs resurrection on merge (§12): a `retention` clear
  is one device making room, and a copy that still has the body brings
  it back; a `user` clear is the person's decision, and the body is not
  copied in again.
- **Collection**: a blob no live line references — no `message.*` line
  names it as `body` or as an attachment, or every line that does has a
  `cleared` after it — may be deleted. Reference counting is a fold over
  every device; a collector may run at any time and is never required to.
- **Policy** — what to clear, when, whether frozen partitions clear
  sooner, whether attachments go before bodies — is a device option, as
  trace retention is (v1 §6.10). The format fixes only the mechanics:
  unlink, and the `cleared` line.
- Skeleton lines are small (a few hundred bytes) and are kept for the
  life of the vault, along with `part.opened`, `peer.resolved`, and
  every `cleared` (rule 7). What that leaves on disk after a deletion is
  stated in §14. Should a vault one day need to drop skeletons too, a
  per-partition erase (a tombstone segment that suppresses everything
  before it, merged by presence) is the shape it would take; version 2
  does not define one (§15).

## 11. Deleting a contact

Deletion is decisions, all appended in this device's directory; no
file under `devices/` is unlinked (rule 7).

1. `contacts/<cid>/`: append `deleted`.
2. Fold attribution. For every partition attributed exactly to this
   contact (single-valued), for every `message.*` line in it: append
   `message.cleared { because: user }` and unlink the blob (§10).
3. For every key the contact has a live `useKey` on that was
   `did.published { uses: one }` or minted toward it, and that no other
   contact uses: append `did.retired { because: contact-deleted }`, so
   nothing further is accepted on it.
4. The fold hides the contact and its partitions; a later envelope to a
   retired key still lands in its partition, unattributed, and the
   application's policy turns it away.

Other devices do steps 2 and 3 for their own directories when their
fold shows the tombstone. Partitions in conflict (multi-valued) are
left until the conflict is resolved. Because nothing is unlinked but
blobs, a merge from an older copy cannot revive the contact: its
`deleted` and every `cleared` are still here, and §12 keeps the bodies
out.

## 12. Snapshot, import, cache

- **Snapshot** = everything under `.estoc/` except `local/`.
- **Import** into an empty backend = restore, `config.json` written last;
  there is no `local/`, so the first open mints a `dev` (§6.4) and the
  imported directories stay as history; every outbound message whose
  fold is not `sent` gets a `held` in the new directory.
- **Import** into the same anchor = merge:
  - `devices/<x>/` for every `x` not present: copied whole;
  - `devices/<x>/` present on both sides: per file, the longer of two
    segments that share a name (a prefix relation, by rule 3), any
    missing segment copied, `device.json` from whichever copy has the
    later `mintedAt`-plus-mtime — *provisional*; in practice both sides
    have the same bytes or one is strictly ahead;
  - `devices/<self>/` (`self` from `local/device.json`) is never touched
    by an import;
  - `blobs/`: copied when absent, **unless** the receiving side has a
    `message.cleared { because: user }` for every line that references
    it (fold first, then copy);
  - singletons local; `state/` as v1; `local/` is not in the snapshot
    and is not touched; any other path copied when absent.
- **`local/cache/`** holds the folds of §9 with, for each, the set of
  `(device, segment, cursor)` it was folded to, so a start can fold
  incrementally and a mismatch triggers a refold. Deleting `local/cache/` is
  always safe.

## 13. Migration from version 1

On open, once, forward only. The migrating device mints its `dev` and
writes everything below into its own directory; the v1 directories are
renamed `migrated-v1/` and left for the person to delete.

- `config.mediation` → `devices/<dev>/device.json`; its `public` key →
  `did.minted` + `did.published { as: profile, uses: many }` (+
  `did.registered`).
- `contacts/<cid>.json` → `contacts/<cid>/`: `created`, `petname`,
  flags, `claimedName`, `profileShared`; one `useKey { key, because:
  migration }` per `myDids[].key`; one `attach { pid, because:
  migration }` per partition the contact's messages land in (§ below);
  `dids[]` hops with `fromPrior` → a
  `peer.rotated` in the partition of the prior DID's key (found by the
  `myDids` entry current at `from`).
- `invitations/<id>.json` → `me/`: `did.minted` + `did.published { as:
  oob, uses: one }` (+ `did.registered`); if `acceptedBy`, the
  `attach` above covers it (the accepting envelope's partition is one
  the contact's messages land in).
- `messages/*.jsonl` → partitions: inbound `myKey` = the `myDids[]`
  entry whose `did` is in `msg.to` (falling back to `addressedAs`, then
  the mediation's public key), `peerKey` = the agreement key of
  `sender` resolved now (`anon` if null; v1 did not record the key, only
  the DID, so this is the one place migration trusts a resolution it
  did not witness — a `peer.resolved` is written for it, marked
  `because: migration`); outbound `myKey` = the entry whose `did` is
  `msg.from`, `peerKey` = the agreement key of `msg.to[0]`. `mid` and
  `at` copied, `msg` written to `blobs/` and its hash put on the line,
  the skeleton fields lifted from it; `eid` minted; a `part.opened` at
  the head of each partition.
- `deliveries/*.jsonl` → the partition of their `mid`.
- A v1 message whose `msg` was already stripped by hand has no v2 body:
  the line is written with `body` and no blob, plus a `message.cleared
  { because: migration }`.
- Legacy key names are kept as derivation names; nothing is re-minted.

## 14. Versioning, robustness, boundaries

As v1 §8–§10, with: `config.version` = 2; one writer per device
directory (rule 3) replaces "one writer per vault" as the format-level
rule — the application still serialises writers on one directory, and
two processes sharing one `dev` is a bug, not a merge. A backup is
still a move, not a sync, but the format no longer stands in the way of
one: a sync is "copy the other devices' directories and the blobs they
reference", and nothing here should have to change for it.

**What deletion leaves behind.** v1 deleted a contact's file outright.
v2 keeps, forever: the contact's decision log with its tombstone, every
partition's skeleton lines (`mid`, `at`, `thid`, sizes, delivery
outcomes, `cleared` lines), and the identity evidence in them —
`part.opened` with the peer's full public key and first DID,
`peer.resolved` with every DID and key list seen. Only bodies and
attachments are gone. A person reading the disk can see *that* the
identity corresponded with a given key, when, and how much; not what was
said. This is a deliberate trade for merge safety and is within v1's
trust statement (the vault is plaintext at rest but for the seed);
an application must say so in its copy where it says "delete".

## 15. Open

- Whether `claimedName` / `profileShared` stay in the contact log or
  become partition observations read by the fold (§8.2).
- Whether `peer.rotated` is written or derived (§7.1).
- Which key when a document lists several agreement keys: the one the
  envelope used (inbound) and the first listed (outbound) is the working
  rule; the fold joins them regardless.
- Whether attachments are lifted out of the plaintext into their own
  blobs at append time or left inline in the body blob (§7.3); lifting
  lets them be cleared separately.
- A per-partition erase for the case where the residue of §14 is not
  acceptable: a tombstone segment under `devices/<dev>/parts/…/` after
  which earlier segments may be unlinked and are not copied in by merge.
  It reintroduces the deletion of a log; not in version 2.
- `device.json` merge tiebreak when two copies of one device's directory
  disagree (§12) — should not happen under rule 3; needs a stated rule
  anyway.
- Retention defaults and the purge trigger (device option; not here).
