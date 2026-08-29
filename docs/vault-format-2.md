# The `.estoc` vault format, version 2 — draft

Status: **draft**, 2026-08-29. Not implemented; nothing writes it yet.
Version 1 (`vault-format.md`) stays the contract until this document is
frozen. There is no migration: a version-2 reader refuses a version-1
vault (§13), and a version-1 vault is used by a version-1 reader or
started over. Sections marked *provisional* are leanings, not decisions.

## 0. What changes, in one paragraph

Version 1 kept three kinds of file — records, logs, singletons — and let a
record (`contacts/<cid>.json`) be the truth about who a message belongs to.
Version 2 keeps logs, singletons, and content-addressed blobs. Every
file that is not a singleton or a blob is an append-only event, either
an **observation** (what an envelope proved, what the wire returned) or
a **decision** (what the person chose); everything else — which contact
a message belongs to, what a contact's current DID is, whether an
invitation is still open — is a **fold** over those events and lives in
`local/cache/`, rebuildable. Every log lives under the device that
authored it, so another copy of the vault is merged by copying
directories; what is this device's alone — which device it is, its
caches, its traces — lives under `local/` and is never in a backup. A
log line carries a message's skeleton; its body is a blob beside it, and
erasing is unlinking blobs, never log lines. Messages are partitioned by
what the envelope proved — our key and their key, not their DID and not
our decision about who they are; keys are named by random ids, not by
the contact they were minted for.

## 1. What a vault is

Unchanged from v1 §1: a directory, `.estoc/` is the machine's half, a
backup is the zip.

## 2. Principles

v1's six rules stand in spirit (§2 there); two are restated and five are
added.

1. **Three kinds of file, none of them a record.** A **log** — immutable
   events, append-only JSONL in segments, merged by union; a
   **singleton** — one per vault or per device, kept local on merge; a
   **blob** — bytes named by their hash, merged by union, the only kind
   ever unlinked (§10). Where v1 rewrote a small JSON file whole, v2
   appends an event and folds.
2. **Names carry no decisions.** v1 said ids are minted, never computed.
   v2 adds: a name must not encode *whose* something is. `pair/<cid>/<id>`
   encoded a contact into a key name at mint time; v2 keys are `did/<id>`.
3. **Every event under `devices/<dev>/` was authored by device `dev`.**
   A device appends only under its own directory. Another device's
   directory is only ever copied — whole files, never created, edited,
   or truncated — however many hands the copy passed through. Authorship
   is a path, and a merge is a copy.
4. **Observation before decision.** An event is one or the other, never
   both. An observation about a counterpart is written in the partition
   the envelope proves (§7) and needs no local state to place; an
   observation about a mediator — what it answered — is written in the
   device's `me/` (§8.1). Decisions are written under the thing decided
   about (`contacts/<cid>/`, `me/`; a decision about one message, beside
   that message: `held`, §7.1, and `message.erased`, §10) and carry their
   grounds inline, because the bodies they rest on may be erased.
5. **Folds are pure and commutative.** `now` and `self` (the device
   asking, §6.4) are parameters; a setting that affects a fold is an
   event; the order two segments are read in must not change the result.
   Tests: incremental = full; shuffled = same; merge(A,B) = merge(B,A).
6. **Conflicts are projections.** Two devices deciding differently
   produce two events, not an error. The fold shows both; a later decision
   resolves them. Merge never rewrites, never drops, never invents.
7. **Logs are never deleted from.** Not a line, not a segment, not a
   directory. The only thing ever unlinked is a blob (§10) — and, under
   `local/`, what was never part of the vault.

## 3. Layout

```
.estoc/
  config.json                                singleton — format/version, anchor; immutable
  keystore.json                              singleton — @estoc/keystore v3, unchanged
  blobs/<hash>                               content-addressed bytes — message bodies, attachments; global; the one place anything is unlinked (§10)
  devices/<dev>/                             everything device <dev> wrote
    device.json                              immutable — dev, mintedAt
    me/<seg>.jsonl                           log — this device's decisions about my identity, and what its mediator answered: DIDs, mediation, label
    contacts/<cid>/<seg>.jsonl               log — decisions about a contact
    parts/<myKey>/<peerKey>/<seg>.jsonl      log — observations in one partition: skeletons, deliveries, resolutions
  state/                                     reserved, as v1 §6.7
  local/                                     this backend's own; never in a snapshot, never merged; §6.4
    self.json                                which <dev> this backend writes as
    options.json                             device options: trace retention
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

- **`dev`** — a device id, 6 characters of lowercase RFC 4648 base32,
  minted the first time a backend opens (or creates) the vault and finds
  no `local/self.json`. Recorded there (which one *I* am) and in
  `devices/<dev>/device.json` (that this one exists). It appears in every
  event id this device writes. Not secret; not carried by a restore,
  since `local/` is not in a snapshot — a restore mints a fresh one and
  keeps the old directory as history.
- **`eid`** — every event's id: `<uuidv7>-<dev>`. The dedup key for every
  log. The uuidv7 is minted at the instant the event is appended, so it
  and the event's `at` agree within a device. Wherever a fold orders
  events — a thread by time, a latest-wins field — it orders by `at`,
  then `(uuidv7, dev)` as the total tiebreak. One rule; §8 and §9 refer
  back to it.
- **Segments** are `<uuidv7>.jsonl` under the writing device's
  directory; the writer appends to its newest segment or mints one.
- **`pid`** — a partition id, the path `<myKey>/<peerKey>` (§7). `myKey`
  is a key name and has slashes of its own; `peerKey` is always the last
  segment. The one id in a log that is computed rather than minted,
  because it must come out the same on every device.
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
`pair/<cid>/<id>`, `invite/<id>`, `mediation/<id>/public` do not exist in
version 2 (§13).

`keystore.json` is unchanged: `keys[]` stays a cache, rebuilt by walking
every device's `me/` for `did.minted` and `mediation.set`.

## 6. Singletons

### 6.1 `config.json`

```jsonc
{
  "format": "estoc",
  "version": 2,
  "identity": { "anchor": { "key": "anchor", "did": "did:key:z6Mk…" } }
}
```

Only what was fixed the moment the vault was created, and never changes:
the format, and the anchor that says which identity this is. Nothing a
person can edit lives here (v1's `label` is a `label.set` event, §8.1).
Merge: must be identical on both sides — the anchor check is what makes
it a merge at all (v1 §7); a differing `version` is refused (§13).

### 6.2 `keystore.json`

As v1 §6.2.

### 6.3 `devices/<dev>/device.json`

```jsonc
{ "dev": "k7q3ma", "mintedAt": "…" }
```

Written once when the device mints its id, never rewritten. That a
device exists is the only fact here; everything it *does* — which
mediator it uses, what it calls itself — is events in its `me/` (§8.1),
so there is no mutable per-device file to reconcile. Merge: copied when
absent; if present on both sides the bytes must match, and a mismatch
is reported as two writers sharing one `dev` (§14), never resolved by
picking one.

### 6.4 `local/` — this backend's own

Everything that is true of *this copy on this machine* and of nothing
else. Never in a snapshot, never merged, never read by another device.

```jsonc
// local/self.json
{ "dev": "k7q3ma" }
// local/options.json — shape owned by the implementation; e.g.
{ "trace": { "wire": { "keep": "P30D", "cap": 33554432 } } }
```

- `self.json` is the pointer every write, every merge, and every fold
  that depends on the asking device (rule 5) needs: which
  `devices/<dev>/` is mine. Missing means "first open on this backend":
  mint a `dev`, write it and `devices/<dev>/device.json`, go on.
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
| anoncrypt, opened with K, unsigned | K | `anon` | `anoncrypt` |
| signed by their Ed25519 key P, bare or inside anoncrypt opened with K | `-` or K | hash(P) | `signed` |
| outbound, sealed from our K to their key P | K | hash(P) | `authcrypt` |
| outbound, sealed anonymously to their key P | `-` | hash(P) | `anoncrypt` |

The key that proves the sender places: the authcrypt sealing key, else
the signing key, else `anon`. A signature inside authcrypt does not move
the message — the line records it (`signedBy`, §7.1), and if one
document lists both keys a `peer.resolved` says so. Transport wrappers
(`forward`) are not messages and are not recorded here; the trace (v1
§6.10) may keep them.

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
devices/k7q3ma/parts/mediation/0198…/me/q4w8…/ this device's mediator
```

Mediation traffic — mediate-request, keylist updates, pickup — is
partitioned like everything else, under the mediation's `me` key. Those
partitions are the mediator's, not any contact's: the fold joins them to
`mediation.set.mediatorDid` (§9.3) and keeps them out of the identity
graph (§9.1).

The same partition appears under every device that observed it; the
partition's log is their union. `parts/<myKey>/` is "everyone who ever
wrote to this key of ours" — which is not the same as one contact: a
key is a DID, and a DID can be handed on. Attribution therefore anchors
on the whole pair (§9.1), never on `myKey` alone.

### 7.1 Partition events

One log, one `type` per line, `eid` as the dedup key:

```jsonc
{ "eid": "0198…-k7q3ma", "at": "…", "type": "part.opened",   "key": "did:key:z6LS…", "kind": "authcrypt", "firstDid": "did:peer:4…" }
{ "eid": "…", "at": "…", "type": "message.in",    "mid": "0198…", "id": "<wire id>", "msgType": "https://…/message", "thid": "…", "pthid": "…", "bytes": 48213, "body": "<hash>", "attachments": ["<hash>"], "signedBy": "did:key:z6Mk…" }
{ "eid": "…", "at": "…", "type": "message.out",   "mid": "0198…", "id": "…", "msgType": "…", "thid": "…", "bytes": 1120, "body": "<hash>", "attachments": [] }
{ "eid": "…", "at": "…", "type": "delivery",      "mid": "0198…", "attempt": 1, "status": "failed", "error": "…" }
{ "eid": "…", "at": "…", "type": "delivery",      "mid": "0198…", "attempt": 2, "status": "sent" }
{ "eid": "…", "at": "…", "type": "peer.resolved", "did": "did:peer:4…", "keys": ["did:key:z6LS…", "did:key:z6Mk…"], "service": "did:peer:2…" }
{ "eid": "…", "at": "…", "type": "peer.rotated",  "from": "did:peer:4…old", "to": "did:peer:4…new", "fromPrior": "eyJ…", "mid": "0198…" }
{ "eid": "…", "at": "…", "type": "message.erased", "mid": "0198…", "blobs": ["<hash>"], "because": "user" }
```

- `part.opened`: the first line a device writes in a partition — the
  full peer key (the hash in the path is not reversible; absent for
  `anon`), the kind, and the DID the key wore when first seen. Readable
  context; the truth about which DIDs list a key is `peer.resolved`.
  Every device writes its own on first contact with the partition.
- `message.in` / `message.out`: the **skeleton** of a message — its
  local `mid` (minted at append), the wire `id`, `msgType`, `thid`,
  `pthid`, `bytes` (the size of the plaintext), `body` — the hash of
  the blob holding the plaintext (§7.3) — `attachments`, the hashes of
  every blob lifted out of it, and `signedBy` when a signature rode
  inside the encryption. The line is the permanent record of which
  blobs the message references: collection (§10) reads it, never the
  body, so it works after the body is gone. Everything a thread view, a
  search index, or a collector needs is on the line; nothing a person
  said is. `direction` is the event type and `sender` is the partition;
  neither is a field.
- `delivery`: as v1 §6.6, minus `to` — the partition is the `to`; the
  DID we sealed to is in the message's `msg.to`. Fold as before: no
  event = pending, last `failed` = retry, `held` = by hand, `sent` =
  final. `held` is a device decision; a fold reads only the writing
  device's `held` as binding on that device.
- `peer.resolved`: we resolved a DID and found this partition's key in
  its document — on every inbound (the skid's DID) and before every
  outbound (the DID we are writing to), written only when the result
  differs from the partition's latest `peer.resolved` for that DID (the
  fold is the same either way; the log is shorter). Records the whole
  key list and the service, so a later reader sees what the document
  said then. This is the edge that joins partitions: two partitions
  whose keys were each found under one DID are one counterpart (§9.1).
  The `keys` list is context, never an edge — a document can list keys
  it does not control. For `did:peer:4` the resolution is local and
  deterministic; for `did:web` it is the same trust we already place in
  it by writing to it.
- `peer.rotated`: lifted from a `message.in` whose plaintext carried a
  valid `from_prior` — `iss` = `from`, a DID this partition's key was
  resolved under; `sub` = `to`. Written in the **old** partition,
  carries the JWT as evidence, names the `mid` it came from. The other
  edge the fold follows.
  *Provisional:* a separate event rather than re-parsing every message
  on fold.
- `message.erased` (§10) and `delivery { status: held }` are the two
  decisions that live here, beside the message they are about (rule 4).
- Nothing about which contact the peer is goes here.

### 7.2 Frozen partitions

A partition is **frozen** when its `myKey` is not a current key of ours
(retired, or a mediation that is no longer current on the device asking)
or its `peerKey` is not in the current document of the contact's current
DID (§9.2). Frozen is a fold, asked per device (`self`, rule 5), never
written: a frozen partition still receives inbound observations (a late
envelope to an old key is a fact) but nothing is sent from it. An
unattributed partition is never written from, so the question only
arises for attributed ones.

### 7.3 Bodies — `blobs/<hash>`

A message's plaintext is written to `blobs/<hash>` **before** its line is
appended, `hash` = sha256 of the bytes, lowercase hex, sharded
`blobs/<hash[0:2]>/<hash>` on backends that want it. The same store holds
attachments lifted out of a plaintext and any other bytes a log line
names by hash; a blob no line names is an orphan (§10.3). Blobs are
immutable, merged by union, deduplicated by construction, and the one
directory outside `devices/` that every device writes to — safely,
because a content address has no author.

A crash between the two writes leaves an orphan blob, harmless, swept by
the next collection (§10). The other order is never used: a line whose
body was never written would be indistinguishable from an erase.

*Provisional — lifting.* An attachment carried inline (`data.base64`,
`data.json`) may be lifted out at append time: its bytes go to their own
blob, the body blob is written with that `data` replaced by a `links`
entry naming the blob (the attachment's own `hash` stays), and the
blob's hash goes into the line's `attachments[]`. The body blob is then
the plaintext *as stored*, not byte-for-byte as it crossed the wire; the
wire form is what the trace keeps (v1 §6.10). A message left inline has
`attachments: []` and its attachments are erased with its body. Whether
to lift at all is open (§15).

A blob that is **absent** means one of two things, and the reader tells
them apart by the partition log (§10): **erased** — the person removed
it everywhere; or, with no erase on record, **missing** — damage, to be
reported as such and never dressed up as a deletion.

## 8. Decision logs

### 8.1 `me/` — my DIDs

```jsonc
{ "eid": "…", "at": "…", "type": "did.minted",    "key": "did/0198…", "did": "did:peer:4…", "routingDid": "did:peer:2…", "mediation": "0198…" }
{ "eid": "…", "at": "…", "type": "did.registered","key": "did/0198…" }                     // the mediator accepted it as a recipient
{ "eid": "…", "at": "…", "type": "did.published", "key": "did/0198…", "as": "oob", "oobId": "…", "goal": "Write to Alice", "uses": "one" }
{ "eid": "…", "at": "…", "type": "did.published", "key": "did/0198…", "as": "profile", "uses": "many" }
{ "eid": "…", "at": "…", "type": "did.retired",   "key": "did/0198…", "because": "mediation-changed" }
{ "eid": "…", "at": "…", "type": "mediation.set",     "id": "0198…", "mediatorDid": "did:web:mediator.estoc.dev", "me": { "key": "mediation/0198…/me", "did": "did:peer:4…" } }
{ "eid": "…", "at": "…", "type": "mediation.granted", "id": "0198…", "routingDid": "did:peer:2…" }
{ "eid": "…", "at": "…", "type": "mediation.retired", "id": "0198…", "because": "changed" }
{ "eid": "…", "at": "…", "type": "label.set",      "name": "Alice" }
{ "eid": "…", "at": "…", "type": "device.label",   "dev": "k7q3ma", "name": "phone" }
{ "eid": "…", "at": "…", "type": "device.retired", "dev": "p2x8rq", "because": "lost" }
```

- `did.minted` and `mediation.set` are the only places a DID string of
  ours is recorded (the snapshot, v1 §2.4); the key is derived from the
  name and compared on use. The `mediation` id says which device's
  arrangement the routing DID came from.
- `did.registered` is an observation — what the writing device's
  mediator answered (rule 4); a fold treats it as binding for that
  device only.
- `did.published` says how the DID was handed out. `uses: one` is what an
  invitation was; `uses: many` is what the public DID was. An invitation
  is therefore not a file: it is a `did.published` with `as: oob`, and
  "open" is a fold (§9.4).
- `did.retired`: no further outbound from this key; inbound still opens.
- `mediation.set` / `granted` / `retired`: v1's `config.mediation` as
  events — one device's arrangement with one mediator, which is why they
  are in the device's own `me/`. `set` mints the mediation id and the
  `me` key; `granted` is an observation, what the mediator answered (the
  routing DID); `retired` closes it. Which key is published as this
  device's address is `did.published { as: profile }`, not a field
  here. The device's current mediation
  is the fold: the last `set` without a `retired`, plus its `granted` if
  any. Another device can *see* it (§9.3) without adopting it.
- `label.set`: what the identity calls itself — what `user-profile`
  announces. Latest wins (§4); two devices renaming at once is an
  ordinary LWW, not a conflict worth showing.
- `device.label`: a name for a device, the person's, for lists.
- `device.retired`: a decision about another device (lost, replaced).
  Its directory stays — history is history — but a fold stops treating
  its mediation as a live address and shows any later events from it as
  suspect.

### 8.2 `contacts/<cid>/` — one contact

```jsonc
{ "eid": "…", "at": "…", "type": "created" }
{ "eid": "…", "at": "…", "type": "petname",   "name": "alice" }
{ "eid": "…", "at": "…", "type": "flag",      "pinned": true }
{ "eid": "…", "at": "…", "type": "claimedName", "name": "Alice L.", "mid": "0198…" }
{ "eid": "…", "at": "…", "type": "useKey",    "key": "did/0198…", "because": "minted" }
{ "eid": "…", "at": "…", "type": "attach",    "pid": "did/0198…/k3j9…", "because": "invitation", "oobId": "…" }
{ "eid": "…", "at": "…", "type": "attach",    "pid": "did/0198…/k3j9…", "because": "accepted" }
{ "eid": "…", "at": "…", "type": "attach",    "pid": "-/m8v2…", "because": "manual" }
{ "eid": "…", "at": "…", "type": "detach",    "pid": "…" }
{ "eid": "…", "at": "…", "type": "absorb",    "from": "<cid>", "supersedes": ["<eid>", "<eid>"] }
{ "eid": "…", "at": "…", "type": "profileShared", "mid": "0198…" }
{ "eid": "…", "at": "…", "type": "deleted" }
```

- `attach pid`: **the one attribution anchor.** This partition — this
  key of ours *and* this key of theirs — belongs to this contact. Written
  when the person accepts someone who took our invitation (`because:
  invitation`, the partition the accepted envelope landed in); when we
  take someone's invitation (`accepted`, the partition our first
  outbound opens — `peer.resolved` before sending fixes the peer key, so
  the pair is known before any reply, and our own first message is
  attributed from the start); and when the person adopts a stranger
  (`manual`). Nothing else attributes: not the key we used, not the DID
  they claimed in a plaintext, not who happened to write first to a key
  we minted toward someone.
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
- Latest-wins fields (`petname`, each `flag`) resolve as §4.
- Nothing here is ever deleted (rule 7).

## 9. Folds

All folds are rebuildable and live under `local/cache/` (§12). They read every
device's directory. They are the only place the word "contact" means
anything to a message.

### 9.1 Attribution — `pid → cid`

Build the **identity graph**: nodes are partitions and DIDs — leaving
out `anon` partitions, which have no peer key and join nothing, and
mediation partitions (`myKey` under `mediation/`), which are the
mediator's (§9.3). A `peer.resolved` in P joins P to its `did`; a
`peer.rotated` joins its `from` to its `to`. Only the partition an event
sits in — the key that actually opened or signed an envelope — joins;
the `keys` a document lists never do, because a document can list keys
it does not control. Take P's connected component and collect every live
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
The fold never parses key names.

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
- `writeTo`: the unfrozen partitions (§7.2). There may be several — more
  than one key of ours, more than one of theirs; the default is the one
  with the latest `message.in`, else the one under the latest `useKey`.
  None means "must mint or rotate before sending".
- `thread`: the union of `message.*` across attributed partitions and
  devices, sorted by `at`. Cross-partition and cross-device order relies
  on `at` alone, as v1 §7 already required across segments.

### 9.3 My DIDs and devices

Per `did/<id>`: minted, registered (per device), published-as, uses,
retired, `usedBy` (the contacts with a live `useKey` on it), and
`takenBy` (the contacts with an `attach` on one of its partitions). Per
device: its current mediation, the partition its mediator's key opened
(`parts/mediation/<id>/me/*`, joined to `mediatorDid` by
`peer.resolved`), its label, whether it is retired — so the application
can list "your addresses" across every device without adopting
another's mediation. For the identity: its `label`.

### 9.4 Invitations

An invitation is a `did.published { as: oob, uses: one }`. It is **open**
iff its key has no `did.retired` and no live `attach` names a partition
under it. It is **taken** by
the contact whose `attach` does — which also makes that contact's
`useKey` on the key implicit; the fold adds it. A second stranger
writing to a taken one-use key lands in its own partition (an
observation is never refused a home), is in no attached component, and
is shown unattributed; the application's policy is to turn it away.
Single use is therefore a policy, not a format guarantee — two devices
apart can each take the same invitation, and the fold shows two
attaches under one key, which is a conflict only if they are the same
peer key.

## 10. Erasing

Nothing is ever deleted from a log. Only blobs are unlinked, and only
because the person said so; an absence with no such record is damage.

### 10.1 Erase

```jsonc
{ "eid": "…", "at": "…", "type": "message.erased", "mid": "0198…", "blobs": ["<body hash>", "<attachment hash>"], "because": "user" }
```

- Permanent and global: every device that folds it unlinks the named
  blobs, and a merge never copies them in again (§12). `blobs` names
  what to drop — the body, some or all attachments — so an attachment
  can be erased and the text kept, or the reverse.
- Event first, then unlink. The skeleton stays; readers show "erased".
- `because`: `user`, `contact-deleted` (§11).

### 10.2 Reading an absence

For a blob `h` referenced by a line: present → show it; absent and some
`message.erased` names `h` → erased; absent otherwise → **missing**,
reported as damage.

### 10.3 Collection

A blob may be unlinked when, over the union of every device's logs,
**every** line that names it (a `message.*` line's `body` or
`attachments`; any other line that names a hash) has a `message.erased`
naming it. An orphan — a blob no line anywhere names, from a crash
between the two writes (§7.3) — is collectable too; so is nothing else.
Reference counting is a fold; a collector may run at any time and is
never required to.

### 10.4 No space policy

Version 2 has no device-side retention for bodies. Browser storage is
evicted per origin, all or nothing, never per file — an application
asks for `navigator.storage.persist()` and otherwise treats loss as a
restore-from-backup problem, not a format one — and a person's own disk
is theirs to fill. Should a device-side policy ever be wanted, its shape
is an eviction event beside the erase: a fact about one copy, binding no
one, never making a blob collectable, undone by nothing but the blob
being present again (§15).

Skeleton lines are small (a few hundred bytes) and are kept for the
life of the vault, along with `part.opened`, `peer.resolved`, and every
erase (rule 7). What that leaves on disk after a deletion is stated in
§14. Should a vault one day need to drop skeletons too, a per-partition
erase (a tombstone segment that suppresses everything before it, merged
by presence) is the shape it would take; version 2 does not define one
(§15).

## 11. Deleting a contact

Deletion is a set of decisions, all appended in this device's
directory; no file under `devices/` is unlinked (rule 7).

1. `contacts/<cid>/`: append `deleted`.
2. Fold attribution. For every partition attributed exactly to this
   contact (single-valued), for every `message.*` line in it: append
   `message.erased { blobs: [body, …attachments], because:
   contact-deleted }` and unlink them (§10.1).
3. For every key the contact has a live `useKey` on that was
   `did.published { uses: one }` or minted toward it, and that no other
   contact uses: append `did.retired { because: contact-deleted }`, so
   nothing further is accepted on it.
4. The fold hides the contact and its partitions; a later envelope to a
   retired key still lands in its partition, unattributed, and the
   application's policy turns it away.

Another device, when its fold first shows the tombstone, does step 2
for any line in those partitions the deleting device had not seen — a
late inbound, an outbound of its own. Step 3 is identity-wide and is
not repeated. Partitions in conflict (multi-valued) are
left until the conflict is resolved. Because nothing is unlinked but
blobs, a merge from an older copy cannot revive the contact: its
`deleted` and every `erased` are still here, and §12 keeps the bodies
out.

## 12. Snapshot, import, cache

- **Snapshot** = everything under `.estoc/` except `local/`.
- **Import** into an empty backend = restore, `config.json` written last;
  there is no `local/`, so the first open mints a `dev` (§6.4) and the
  imported directories stay as history — including the old device's
  mediation, visible (§9.3) until the person retires it; every outbound
  message whose fold is not `sent` gets a `held` in the new directory.
- **Import** into the same anchor = merge:
  - `devices/<x>/` for every `x` not present: copied whole;
  - `devices/<x>/` present on both sides: any missing segment copied;
    for two segments sharing a name, one must be a prefix of the other
    (rule 3) and the longer is kept; `device.json` must match (§6.3).
    A segment pair that is not prefix-related, or a `device.json` that
    differs, is two writers sharing one `dev`: the import stops and
    reports it rather than choosing;
  - `devices/<self>/` (`self` from `local/self.json`) is never touched
    by an import;
  - `blobs/`: **after** the device directories are merged, fold the
    union of skeletons and erases; a blob absent here and present there
    is copied iff it is not collectable under §10.3 over that union — an
    erased blob never comes back;
  - singletons local; `state/` as v1; `local/` is not in the snapshot
    and is not touched; any other path copied when absent.
- **`local/cache/`** holds the folds of §9 with, for each, the set of
  `(device, segment, cursor)` it was folded to, so a start can fold
  incrementally and a mismatch triggers a refold. Deleting `local/cache/` is
  always safe.

## 13. Version 1

There is no migration. A version-2 reader that opens a directory whose
`config.version` is 1 refuses it and says so: nothing is read past
`config.json`, nothing is written, nothing is renamed. A version-1 vault
is used by a version-1 reader or started over. The v1 key names
`pair/<cid>/<id>`, `invite/<id>` and `mediation/<id>/public` are not
derivation names in version 2 (§5), and nothing in this format reads a
`cid` out of a key name.

## 14. Versioning, robustness, boundaries

As v1 §8–§10, with `config.version` = 2. One writer per device
directory (rule 3) replaces "one writer per vault" as the format-level
rule; the application still serialises writers on one directory. Two
processes sharing one `dev` is a bug, not a merge: it shows up as
non-prefix segments or a differing `device.json` under one `dev` (§12),
and the remedy is for one of them to mint its own. A backup is still a
move, not a sync, but the format no longer stands in the way of one: a
sync is "copy the other devices' directories and the blobs they
reference", and nothing here should have to change for it.

**What deletion leaves behind.** v1 deleted a contact's file outright.
v2 keeps, forever: the contact's decision log with its tombstone — and
in it the petname and any `claimedName` the contact sent; in `me/`, the
`goal` text of any invitation they took (§8.1); every partition's
skeleton lines (`mid`, `at`, `thid`, sizes, blob hashes,
delivery outcomes, `erased` lines), and the identity evidence in them —
`part.opened` with the peer's full public key and first DID,
`peer.resolved` with every DID and key list seen. Only bodies and
attachments are gone. A person reading the disk can see *that* the
identity corresponded with a given key, when, and how much; not what was
said, except the names just listed. This is a deliberate trade for
merge safety and is within v1's trust statement (the vault is plaintext
at rest but for the seed); an application must say so in its copy where
it says "delete".

## 15. Open

- Whether `claimedName` / `profileShared` stay in the contact log or
  become partition observations read by the fold (§8.2).
- Whether `peer.rotated` is written or derived (§7.1).
- Which key when a document lists several agreement keys: the one the
  envelope used (inbound) and the first listed (outbound) is the working
  rule; the fold joins them regardless.
- Whether attachments are lifted out of the plaintext into their own
  blobs at append time or left inline in the body blob (§7.3). The
  skeleton's `attachments[]` and §10's per-blob erase assume lifting;
  a message that keeps them inline simply has `attachments: []`. If
  lifting stays, the body blob is the stored form, not the wire form.
- Whether a signature inside authcrypt is a field on the line
  (`signedBy`, §7.1) or its own event.
- A per-partition erase for the case where the residue of §14 is not
  acceptable: a tombstone segment under `devices/<dev>/parts/…/` after
  which earlier segments may be unlinked and are not copied in by merge.
  It reintroduces the deletion of a log; not in version 2.
- A per-device key in `device.json` (for authenticating a device's
  directory when directories are exchanged over a wire rather than by
  hand). Not needed while a merge is a backup, so not in version 2.
- A device-side space policy for bodies (§10.4): an eviction event that
  explains a local absence without binding anyone. Not in version 2.
