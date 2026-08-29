# The vault's events, version 2 — draft

Status: **draft**, 2026-08-29. Not implemented. Sections marked
*provisional* are leanings, not decisions.

The third of three documents. Every line below is an event of
`event-store.md` §3 — an envelope of `eid`, `at`, `author`, `type`, and
a payload — read and written through the store there; nothing here
names a path, and the store knows none of the words used here. The
folder that carries these events on disk is `vault-folder.md`'s, and
the examples are its lines, which are the events themselves
(`vault-folder.md` §4): the envelope fields are shown once per example
block and elided after, and so are the fields a block's events share.

## 0. What changes, in one paragraph

Version 1 let a record be the truth about who a message belongs to.
Version 2 has no records. Every event is either an **observation**
(what an envelope proved, what the wire returned) or a **decision**
(what the person chose); everything else — which contact a message
belongs to, what a contact's current DID is, whether an invitation is
still open — is a **fold** over those events, rebuildable. An
observation carries the pair of keys the envelope proved — our key and
their key, not their DID and not our decision about who they are; a
decision carries what it is about — a contact, a key, a device, a
message. Keys are named by random ids, not by the contact they were
minted for. A message's body is a blob its skeleton names, and erasing
is unlinking blobs, never events.

## 1. Principles

The principles of `event-store.md` §2, as they apply to meaning.

1. **Observation before decision.** An event is one or the other, never
   both. An observation about a counterpart carries the partition the
   envelope proves (§3) and needs no local state to place; an
   observation about a mediator — what it answered — carries the
   mediation it belongs to (§5). A decision carries the thing it is
   about as a field — `cid`, `key`, `dev`, `mid` — and its grounds
   inline, because the bodies it rests on may be erased.
2. **Names carry no decisions.** A key is `did/<id>`, never
   `pair/<cid>/<id>`: whom a key was minted for, and whom it now belongs
   to, are events about it (§2, §6).
3. **Folds are the only place "contact" means anything to a message.**
   Every fold is pure, a function of the event set with `now` and
   `self` as parameters, rebuildable, and cached locally
   (`event-store.md` §7.4).
4. **Conflicts are projections.** Two devices deciding differently is
   two events; the fold shows both; a later decision resolves them.
5. **Nothing is deleted.** An erase is a decision plus an unlinked blob
   (§8); a deleted contact is a tombstone (§9).

**Type names.** Every type is `noun.verb` — `did.minted`,
`contact.attach`, `message.in` — and the noun says what kind of thing
the event is about. Since every device's events are one log, the type
is the only thing that says what a line is; there is no directory to
borrow meaning from.

## 2. Identity, devices, keys

- **The identity** is the anchor: `did:key` from the key named
  `anchor`, fixed at creation and recorded in `config.json`
  (`vault-folder.md` §6.1). What the identity calls itself is
  `label.set` (§5).
- **A device** is an `author` (`event-store.md` §4). A device's first
  event is `device.minted`; a device is named, and retired, by
  decisions from any device (§5). `self` is the device a fold is asked
  from.
- **Keys** derive as v1 §5 (`estoc/v3/<purpose>/<name>`, HKDF over the
  seed). The name table shrinks:

  | name | derives | notes |
  | --- | --- | --- |
  | `anchor` | did:key — the identity | fixed |
  | `mediation/<id>/me` | did:peer:4, no service — how the mediator knows us | one per mediation |
  | `did/<id>` | did:peer:4, service = routing DID — a DID of ours handed to people | `id` random uuidv7 |

  Every DID we give to a person is a `did/<id>`. Whether it went into an
  out-of-band invitation, onto a profile page, or straight to one
  contact; whether it is meant for one taker or many; whom it now
  belongs to — these are decisions about it (§5, §6), not in the name.
  The v1 names `pair/<cid>/<id>`, `invite/<id>`,
  `mediation/<id>/public` do not exist in version 2 (§11).

- **The key cache** (`keystore.json`, `vault-folder.md` §6.2) is
  rebuilt by walking every device's log for `did.minted` and
  `mediation.set`.

## 3. Partitions

A partition is every observation involving one key of ours and one
public key of theirs. It is not a place: it is two fields, `myKey` and
`peerKey`, that every observation carries, and a fold groups by. They
are set by the envelope alone — the key that opened it and the key that
sealed or signed it — with no lookup:

| envelope | `myKey` | `peerKey` | `kind` |
| --- | --- | --- | --- |
| authcrypt, opened with our key K, sealed by their X25519 key P | K | hash(P) | `authcrypt` |
| anoncrypt, opened with K, unsigned | K | `anon` | `anoncrypt` |
| signed by their Ed25519 key P, bare or inside anoncrypt opened with K | `-` or K | hash(P) | `signed` |
| outbound, sealed from our K to their key P | K | hash(P) | `authcrypt` |
| outbound, sealed anonymously to their key P | `-` | hash(P) | `anoncrypt` |

The key that proves the sender places: the authcrypt sealing key, else
the signing key, else `anon`. A signature inside authcrypt does not move
the message — the line records it (`signedBy`, §3.1), and if one
document lists both keys a `peer.resolved` says so. Transport wrappers
(`forward`) are not messages and are not recorded; the trace (v1 §6.10)
may keep them.

```
peerKey = base32lower( sha256( multicodec-prefixed raw public key ) )[0:26]
```

i.e. the hash of the bytes a `did:key` of that key encodes (`z6LS…` for
X25519, `z6Mk…` for Ed25519). Hashed rather than used raw for uniform
length and for safety anywhere it becomes a name.

The **partition id**, `pid`, is the string `<myKey>/<peerKey>`. It is
the one id in the vault that is computed rather than minted
(`event-store.md` §2 principle 2), because it must come out the same on
every device: it is what a `contact.attach` (§6) names.

The DID is **not** in the pair. A DID is a name a key wears:
`did:peer:4` commits to its keys, `did:web` and `did:peer:2` can change
them, and the envelope proves the key either way. So a `did:web` owner
rotating keys opens a new partition exactly as a `from_prior` rotation
does, and the two are linked the same way — by observation (§3.1
`peer.resolved`). A consequence, not a goal: neither side's routing DID
is in the pair, so a partition survives either side changing mediator
while keeping keys.

```
{ "myKey": "did/0198…",           "peerKey": "k3j9…" }   authcrypt with our did/0198…
{ "myKey": "did/0198…",           "peerKey": "anon"  }   anoncrypt to our did/0198…
{ "myKey": "-",                   "peerKey": "k3j9…" }   signed only
{ "myKey": "mediation/0198…/me",  "peerKey": "q4w8…" }   this device's mediator
```

Mediation traffic — mediate-request, keylist updates, pickup — carries
a pair like everything else, under the mediation's `me` key. Those
partitions are the mediator's, not any contact's: the fold joins them to
`mediation.set.mediatorDid` (§7.3) and keeps them out of the identity
graph (§7.1).

The same partition is observed by every device that saw it; the
partition's events are the union of theirs. "Every partition under
`myKey`" is "everyone who ever wrote to this key of ours" — which is not
the same as one contact: a key is a DID, and a DID can be handed on.
Attribution therefore anchors on the whole pair (§7.1), never on
`myKey` alone.

### 3.1 Partition events

Every observation carries `myKey` and `peerKey`; the block shows them
once.

```jsonc
{ "eid": "0198…", "author": "k7q3ma", "at": "…", "myKey": "did/0198…", "peerKey": "k3j9…",
  "type": "part.opened",   "key": "did:key:z6LS…", "kind": "authcrypt", "firstDid": "did:peer:4…" }
{ "type": "message.in",    "mid": "0198…", "id": "<wire id>", "msgType": "https://…/message", "thid": "…", "pthid": "…", "bytes": 48213, "body": "<hash>", "attachments": ["<hash>"], "signedBy": "did:key:z6Mk…" }
{ "type": "message.out",   "mid": "0198…", "id": "…", "msgType": "…", "thid": "…", "bytes": 1120, "body": "<hash>", "attachments": [] }
{ "type": "delivery",      "mid": "0198…", "attempt": 1, "status": "failed", "error": "…" }
{ "type": "delivery",      "mid": "0198…", "attempt": 2, "status": "sent" }
{ "type": "peer.resolved", "did": "did:peer:4…", "keys": ["did:key:z6LS…", "did:key:z6Mk…"], "service": "did:peer:2…" }
{ "type": "peer.rotated",  "from": "did:peer:4…old", "to": "did:peer:4…new", "fromPrior": "eyJ…", "mid": "0198…" }
{ "type": "message.erased", "mid": "0198…", "blobs": ["<hash>"], "because": "user" }
```

- `part.opened`: written once by each device the first time it sees a
  pair — the full peer key (the hash in `peerKey` is not reversible;
  absent for `anon`), the kind, and the DID the key wore when first
  seen. Readable context; the truth about which DIDs list a key is
  `peer.resolved`. "First" is what the writing device had not seen; two
  devices each write their own.
- `message.in` / `message.out`: the **skeleton** of a message — its
  local `mid` (minted at append), the wire `id`, `msgType`, `thid`,
  `pthid`, `bytes` (the size of the plaintext), `body` — the hash of
  the blob holding the plaintext (§4) — `attachments`, the hashes of
  every blob lifted out of it, and `signedBy` when a signature rode
  inside the encryption. The line is the permanent record of which
  blobs the message references: collection (§8.3) reads it, never the
  body, so it works after the body is gone. Everything a thread view, a
  search index, or a collector needs is on the line; nothing a person
  said is. `direction` is the event type and `sender` is the pair;
  neither is a further field.
- `delivery`: as v1 §6.6, minus `to` — the pair is the `to`; the DID we
  sealed to is in the message's `msg.to`. Carries the pair so that it
  is its own thread's without a join. Fold as before: no event =
  pending, last `failed` = retry, `held` = by hand, `sent` = final.
  `held` is a device decision; a fold reads only the writing device's
  `held` as binding on that device.
- `peer.resolved`: we resolved a DID and found this pair's peer key in
  its document — on every inbound (the skid's DID) and before every
  outbound (the DID we are writing to), written only when the result
  differs from the pair's latest `peer.resolved` for that DID (the fold
  is the same either way; the log is shorter). Records the whole key
  list and the service, so a later reader sees what the document said
  then. This is the edge that joins partitions: two pairs whose peer
  keys were each found under one DID are one counterpart (§7.1). The
  `keys` list is context, never an edge — a document can list keys it
  does not control. For `did:peer:4` the resolution is local and
  deterministic; for `did:web` it is the same trust we already place in
  it by writing to it.
- `peer.rotated`: lifted from a `message.in` whose plaintext carried a
  valid `from_prior` — `iss` = `from`, a DID this pair's peer key was
  resolved under; `sub` = `to`. Carries the **old** pair, the JWT as
  evidence, and the `mid` it came from. The other edge the fold
  follows. *Provisional:* a separate event rather than re-parsing every
  message on fold.
- `message.erased` (§8) and `delivery { status: held }` are the two
  decisions that carry a pair, because they are about one message in
  it (principle 1).
- Nothing about which contact the peer is goes on any of these.

### 3.2 Frozen partitions

A partition is **frozen** when its `myKey` is not a current key of ours
(retired, or a mediation that is no longer current on the device asking)
or its `peerKey` is not in the current document of the contact's current
DID (§7.2). Frozen is a fold, asked per device (`self`), never
written: a frozen partition still receives inbound observations (a late
envelope to an old key is a fact) but nothing is sent from it. An
unattributed partition is never written from, so the question only
arises for attributed ones.

## 4. Bodies

A message's plaintext is a blob (`event-store.md` §6), written
**before** its skeleton is appended; the skeleton names it by hash. The
same blob store holds attachments lifted out of a plaintext and any
other bytes an event names by hash; a blob no event names is an orphan
(§8.3). A crash between the two writes leaves an orphan, harmless,
swept by the next collection. The other order is never used: a line
whose body was never written would be indistinguishable from an erase.

*Provisional — lifting.* An attachment carried inline (`data.base64`,
`data.json`) may be lifted out at append time: its bytes go to their own
blob, the body blob is written with that `data` replaced by a `links`
entry naming the blob (the attachment's own `hash` stays), and the
blob's hash goes into the line's `attachments[]`. The body blob is then
the plaintext *as stored*, not byte-for-byte as it crossed the wire; the
wire form is what the trace keeps (v1 §6.10). A message left inline has
`attachments: []` and its attachments are erased with its body. Whether
to lift at all is open (§12).

A blob that is **absent** means one of two things, and the reader tells
them apart by the events (§8.2): **erased** — the person removed it
everywhere; or, with no erase on record, **missing** — damage, to be
reported as such and never dressed up as a deletion.

## 5. Identity and devices

What a device says about the identity, about itself and the other
devices, and what its mediator answered.

```jsonc
{ "eid": "…", "author": "k7q3ma", "at": "…", "type": "device.minted" }
{ "type": "did.minted",    "key": "did/0198…", "did": "did:peer:4…", "routingDid": "did:peer:2…", "mediation": "0198…" }
{ "type": "did.registered","key": "did/0198…" }                     // the mediator accepted it as a recipient
{ "type": "did.published", "key": "did/0198…", "as": "oob", "oobId": "…", "goal": "Write to Alice", "uses": "one" }
{ "type": "did.published", "key": "did/0198…", "as": "profile", "uses": "many" }
{ "type": "did.retired",   "key": "did/0198…", "because": "mediation-changed" }
{ "type": "mediation.set",     "id": "0198…", "mediatorDid": "did:web:mediator.estoc.dev", "me": { "key": "mediation/0198…/me", "did": "did:peer:4…" } }
{ "type": "mediation.granted", "id": "0198…", "routingDid": "did:peer:2…" }
{ "type": "mediation.retired", "id": "0198…", "because": "changed" }
{ "type": "label.set",      "name": "Alice" }
{ "type": "device.label",   "dev": "k7q3ma", "name": "phone" }
{ "type": "device.retired", "dev": "p2x8rq", "because": "lost" }
```

- `device.minted`: the first event a device writes — that this device
  exists, and when (`at`). Nothing about a device is a file: a device's
  existence travels with its events. Immutable by being an event; a
  second `device.minted` from one `author` is two writers sharing it
  (`vault-folder.md` §11).
- `did.minted` and `mediation.set` are the only places a DID string of
  ours is recorded (the snapshot, v1 §2.4); the key is derived from the
  name and compared on use. The `mediation` id says which device's
  arrangement the routing DID came from.
- `did.registered` is an observation — what the writing device's
  mediator answered (principle 1); a fold treats it as binding for that
  device only.
- `did.published` says how the DID was handed out. `uses: one` is what an
  invitation was; `uses: many` is what the public DID was. An invitation
  is therefore not a file: it is a `did.published` with `as: oob`, and
  "open" is a fold (§7.4).
- `did.retired`: no further outbound from this key; inbound still opens.
- `mediation.set` / `granted` / `retired`: v1's `config.mediation` as
  events — one device's arrangement with one mediator, which is why the
  device writing them is the device they bind. `set` mints the
  mediation id and the `me` key; `granted` is an observation, what the
  mediator answered (the routing DID); `retired` closes it. Which key
  is published as this device's address is `did.published { as:
  profile }`, not a field here. The device's current mediation is the
  fold: the last `set` without a `retired`, plus its `granted` if any.
  Another device can *see* it (§7.3) without adopting it.
- `label.set`: what the identity calls itself — what `user-profile`
  announces. Latest wins (`event-store.md` §4); two devices renaming at
  once is an ordinary LWW, not a conflict worth showing.
- `device.label`: a name for a device, the person's, for lists. `dev`
  is the device the decision is about — payload, not authorship; the
  author is the event's `author`.
- `device.retired`: a decision about another device (lost, replaced).
  Its events stay — history is history — but a fold stops treating its
  mediation as a live address and shows any later events from it as
  suspect.

## 6. Contacts

Decisions about one contact. Every one carries the `cid`; a contact's
log is the union, across devices, of the events that name it.

```jsonc
{ "eid": "…", "author": "k7q3ma", "at": "…", "cid": "0198…",
  "type": "contact.created" }
{ "type": "contact.petname",   "name": "alice" }
{ "type": "contact.flag",      "pinned": true }
{ "type": "contact.claimedName", "name": "Alice L.", "mid": "0198…" }
{ "type": "contact.useKey",    "key": "did/0198…", "because": "minted" }
{ "type": "contact.attach",    "pid": "did/0198…/k3j9…", "because": "invitation", "oobId": "…" }
{ "type": "contact.attach",    "pid": "did/0198…/k3j9…", "because": "accepted" }
{ "type": "contact.attach",    "pid": "-/m8v2…", "because": "manual" }
{ "type": "contact.detach",    "pid": "…" }
{ "type": "contact.absorb",    "from": "<cid>", "supersedes": ["<eid>", "<eid>"] }
{ "type": "contact.profileShared", "mid": "0198…" }
{ "type": "contact.deleted" }
```

- `contact.attach pid`: **the one attribution anchor.** This partition
  — this key of ours *and* this key of theirs — belongs to this
  contact. Written when the person accepts someone who took our
  invitation (`because: invitation`, the pair the accepted envelope
  carried); when we take someone's invitation (`accepted`, the pair our
  first outbound opens — `peer.resolved` before sending fixes the peer
  key, so the pair is known before any reply, and our own first message
  is attributed from the start); and when the person adopts a stranger
  (`manual`). Nothing else attributes: not the key we used, not the DID
  they claimed in a plaintext, not who happened to write first to a key
  we minted toward someone.
- `contact.useKey key`: we address this contact from this key. Outbound
  only — it picks the `myKey` to seal with and says nothing about who
  writes back. Minting a key toward a contact is `did.minted` +
  `contact.useKey`.
- `contact.absorb from`: the other contact's attaches and useKeys are
  this contact's; `supersedes` lists the conflicting eids it resolves.
  The absorbed contact gets a `contact.deleted`.
- `contact.claimedName` and `contact.profileShared` are observations
  wearing a decision's clothes — they come from a message — and are
  kept here for the fold's convenience, with the `mid` as grounds.
  *Provisional.*
- `contact.deleted` is a tombstone (§9).
- Latest-wins fields (`petname`, each `flag`) resolve by canonical
  order (`event-store.md` §4).
- A `cid` is minted with `contact.created` and never appears on an
  observation (§3.1): the store does not know contacts, and neither
  does a message until a fold says so.

## 7. Folds

All folds are rebuildable and cached locally with the change token they
were folded to (`event-store.md` §7.4); they must therefore accept
events in any order, one at a time (`event-store.md` §5.4). They read
every device's events. They are the only place the word "contact" means
anything to a message.

### 7.1 Attribution — `pid → cid`

Build the **identity graph**: nodes are partitions and DIDs — leaving
out `anon` partitions, which have no peer key and join nothing, and
mediation partitions (`myKey` under `mediation/`), which are the
mediator's (§7.3). A `peer.resolved` carrying pair P joins P to its
`did`; a `peer.rotated` joins its `from` to its `to`. Only the pair an
event carries — the key that actually opened or signed an envelope —
joins; the `keys` a document lists never do, because a document can
list keys it does not control. Take P's connected component and collect
every live `contact.attach` (no later `contact.detach`, not superseded
by a `contact.absorb`) whose `pid` is in it:

- **none** → P is **unattributed**: a stranger, or a second taker of a
  one-use key, or someone the contact handed our DID on to. The
  application shows it as such; the person's "accept" is a
  `contact.attach`.
- **one contact** → P belongs to it, and so does every partition in the
  component (a `did:web` key rotation, a `from_prior` hop, a signing key
  beside an agreement key).
- **several** → a **multi-value**: the fold returns all of them, the
  application shows the conflict, and a `contact.absorb` resolves it.
  This happens when two devices each accepted the same stranger while
  apart; it is not an error.

`myKey` never enters into it. That a key was minted toward Alice, or
published in an invitation Alice took, says who we *meant* it for; who
actually sealed to it is the peer key, and only the pair is evidence.
The fold never parses key names.

### 7.2 Contact state

From a contact's events and its attributed partitions:

- `petname`, flags, `claimedName`: latest event.
- `keys[]`: every live `contact.useKey`, with its `did.minted` DID.
- `theirDids[]`: the DIDs in the contact's component of the identity
  graph, ordered by `peer.rotated`; the **current** DID is a chain's
  end, and its current keys are the latest `peer.resolved` for it. Two
  ends = multi-value, shown.
- `addressedAs`: the `myKey` of the latest `message.in` across attributed
  partitions.
- `writeTo`: the unfrozen partitions (§3.2). There may be several — more
  than one key of ours, more than one of theirs; the default is the one
  with the latest `message.in`, else the one under the latest
  `contact.useKey`. None means "must mint or rotate before sending".
- `thread`: the union of `message.*` across attributed partitions and
  devices, in canonical order. Cross-partition and cross-device order
  relies on `at` alone, as v1 §7 already required across segments.

### 7.3 My DIDs and devices

Per `did/<id>`: minted, registered (per device), published-as, uses,
retired, `usedBy` (the contacts with a live `contact.useKey` on it), and
`takenBy` (the contacts with a `contact.attach` on one of its
partitions). Per device: its current mediation, the partition its
mediator's key opened (`myKey` = `mediation/<id>/me`, joined to
`mediatorDid` by `peer.resolved`), its label, whether it is retired —
so the application can list "your addresses" across every device
without adopting another's mediation. For the identity: its `label`.

### 7.4 Invitations

An invitation is a `did.published { as: oob, uses: one }`. It is **open**
iff its key has no `did.retired` and no live `contact.attach` names a
partition under it. It is **taken** by the contact whose
`contact.attach` does — which also makes that contact's
`contact.useKey` on the key implicit; the fold adds it. A second
stranger writing to a taken one-use key lands in its own partition (an
observation is never refused a home), is in no attached component, and
is shown unattributed; the application's policy is to turn it away.
Single use is therefore a policy, not a format guarantee — two devices
apart can each take the same invitation, and the fold shows two
attaches under one key, which is a conflict only if they are the same
peer key.

## 8. Erasing

Nothing is ever deleted from a log. Only blobs are unlinked, and only
because the person said so; an absence with no such record is damage.

### 8.1 Erase

```jsonc
{ "eid": "…", "author": "k7q3ma", "at": "…", "myKey": "did/0198…", "peerKey": "k3j9…",
  "type": "message.erased", "mid": "0198…", "blobs": ["<body hash>", "<attachment hash>"], "because": "user" }
```

- Permanent and global: every device that folds it unlinks the named
  blobs, and a merge never copies them in again (§10). `blobs` names
  what to drop — the body, some or all attachments — so an attachment
  can be erased and the text kept, or the reverse.
- Event first, then unlink. The skeleton stays; readers show "erased".
- `because`: `user`, `contact-deleted` (§9).

### 8.2 Reading an absence

For a blob `h` referenced by a line: present → show it; absent and some
`message.erased` names `h` → erased; absent otherwise → **missing**,
reported as damage.

### 8.3 Collection

A blob may be unlinked when, over the union of every device's events,
**every** event that names it (a `message.*` line's `body` or
`attachments`; any other event that names a hash) has a
`message.erased` naming it. An orphan — a blob no event anywhere names,
from a crash between the two writes (§4) — is collectable too; so is
nothing else. Reference counting is a fold; a collector may run at any
time and is never required to.

### 8.4 No space policy

Version 2 has no device-side retention for bodies. Browser storage is
evicted per origin, all or nothing, never per file — an application
asks for `navigator.storage.persist()` and otherwise treats loss as a
restore-from-backup problem, not a format one — and a person's own disk
is theirs to fill. Should a device-side policy ever be wanted, its shape
is an eviction event beside the erase: a fact about one copy, binding no
one, never making a blob collectable, undone by nothing but the blob
being present again (§12).

Skeleton lines are small (a few hundred bytes) and are kept for the
life of the vault, along with `part.opened`, `peer.resolved`, and every
erase. What that leaves behind after a deletion is stated in §10.
Should a vault one day need to drop skeletons too, a per-partition
erase (a tombstone that suppresses everything before it, merged by
presence) is the shape it would take; version 2 does not define one
(§12).

## 9. Deleting a contact

Deletion is a set of decisions, all appended by this device; no event
is removed (principle 5).

1. Append `contact.deleted { cid }`.
2. Fold attribution. For every partition attributed exactly to this
   contact (single-valued), for every `message.*` event carrying it:
   append `message.erased { blobs: [body, …attachments], because:
   contact-deleted }` with the pair, and unlink them (§8.1).
3. For every key the contact has a live `contact.useKey` on that was
   `did.published { uses: one }` or minted toward it, and that no other
   contact uses: append `did.retired { because: contact-deleted }`, so
   nothing further is accepted on it.
4. The fold hides the contact and its partitions; a later envelope to a
   retired key still lands in its partition, unattributed, and the
   application's policy turns it away.

Another device, when its fold first shows the tombstone, does step 2
for any event in those partitions the deleting device had not seen — a
late inbound, an outbound of its own. Step 3 is identity-wide and is
not repeated. Partitions in conflict (multi-valued) are left until the
conflict is resolved. Because nothing is unlinked but blobs, a merge
from an older copy cannot revive the contact: its `contact.deleted` and
every `message.erased` are still here, and §10 keeps the bodies out.

## 10. Merge, seen from the events

A merge is `ingest` (`event-store.md` §5.2): every event on the other
side that is not here by `eid` is added; nothing here is rewritten,
dropped, or reordered. What the events then require:

- **Blobs come in by collectability.** After the events are merged,
  fold the union of skeletons and erases; a blob absent here and
  present there is copied iff it is not collectable under §8.3 over
  that union. An erased blob never comes back.
- **Held after merge.** Once the set is merged — or restored into a
  fresh device — every outbound message whose delivery fold is not
  `sent` gets a `held` from the device asking. A decision made on the
  merged set, appended by `self`, and no store's business.
- **A restored device is history.** A restore mints a fresh device
  (`event-store.md` §4, `vault-folder.md` §9.4); the old device's
  events stay, including its mediation, visible (§7.3) until the person
  retires it (`device.retired`, §5).
- **Two writers sharing one `author`** is a bug, not a merge: it shows
  as one `eid` with two contents, or two `device.minted` from one
  `author` (and, in a folder, non-prefix segments —
  `vault-folder.md` §11). The remedy is for one of them to mint its own.

**What deletion leaves behind.** v1 deleted a contact's file outright.
v2 keeps, forever: the contact's decisions with their tombstone — and
among them the petname and any `claimedName` the contact sent; the
`goal` text of any invitation they took (§5); every partition's
skeleton lines (`mid`, `at`, `thid`, sizes, blob hashes, delivery
outcomes, `erased` lines), and the identity evidence in them —
`part.opened` with the peer's full public key and first DID,
`peer.resolved` with every DID and key list seen. Only bodies and
attachments are gone. A person reading the disk can see *that* the
identity corresponded with a given key, when, and how much; not what
was said, except the names just listed. This is a deliberate trade for
merge safety and is within v1's trust statement (the vault is plaintext
at rest but for the seed); an application must say so in its copy where
it says "delete".

## 11. Version 1

There is no migration (`vault-folder.md` §10). The v1 key names
`pair/<cid>/<id>`, `invite/<id>` and `mediation/<id>/public` are not
derivation names in version 2 (§2), and nothing in version 2 reads a
`cid` out of a key name.

## 12. Open

- Whether `contact.claimedName` / `contact.profileShared` stay
  decisions or become observations read by the fold (§6).
- Whether `peer.rotated` is written or derived (§3.1).
- Which key when a document lists several agreement keys: the one the
  envelope used (inbound) and the first listed (outbound) is the working
  rule; the fold joins them regardless.
- Whether attachments are lifted out of the plaintext into their own
  blobs at append time or left inline in the body blob (§4). The
  skeleton's `attachments[]` and §8's per-blob erase assume lifting;
  a message that keeps them inline simply has `attachments: []`. If
  lifting stays, the body blob is the stored form, not the wire form.
- Whether a signature inside authcrypt is a field on the line
  (`signedBy`, §3.1) or its own event.
- A per-partition erase for the case where the residue of §10 is not
  acceptable: a tombstone after which earlier events carrying the pair
  may be dropped and are not merged in. It reintroduces the deletion of
  events, and with one log per device it means rewriting a segment;
  not in version 2.
- A per-device key, as a field of `device.minted` (for authenticating a
  device's events when they are exchanged over a wire rather than by
  hand). Not needed while a merge is a backup, so not in version 2.
- A device-side space policy for bodies (§8.4): an eviction event that
  explains a local absence without binding anyone. Not in version 2.
- **Type names for extensions.** The vault's own types are `noun.verb`
  with a short noun; an extension's need a namespace that cannot
  collide (`event-store.md` §10). Which convention is not decided.
