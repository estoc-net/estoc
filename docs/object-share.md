# object-share/1.0

Status: implemented in `@estoc/agent-core` 0.15.0 (`@estoc/folder-object`
0.5.0), 2026-08-26 — the skeleton / leaves split (§2, §7) included.
Design history: `research/notes/2026-08-24-object-share-over-didcomm.md`.

## 1. What it is for

Handing a contact a whole **object** — a [folder-object](https://github.com/estoc-net/folder-object)
hashed into a UnixFS tree (`@estoc/folder-object`, profile
`unixfs-v1-2025`) — over DIDComm, in one message, with nothing to ask
back. The protocol carries the tree's **skeleton** always, its **leaves**
when they fit, and, when someone stands behind the object, the card: a
share is either an **object** or a **signed object**, the two forms `@estoc/folder-object`
already has. It reads exactly one thing inside — that the tree *is* an
object (`index.json` well-formed, spec §8): a tree that does not say
what it is has no interpretation and is not this protocol's unit (that
would be sending a zip). It does not interpret the object's format.

It is not media-sharing/1.0. That protocol's unit is a flat media item
named by an arbitrary id; ours is a tree with structure the receiver
verifies, named by content. It is not a pull protocol either: with two
phones that are each online now and then, "send the card, ask for the
blocks" needs the sender's agent to be awake every time the receiver
asks — the same fault that stalled HTTP-over-DIDComm. Push carries the
whole thing while the sender is here; the mediator holds it; the receiver
reads it whenever.

DIDComm stays the control plane. The bytes of a big object take another
road (a WebRTC data channel signalled over DIDComm, or a content relay),
and keep the CID as the unit; this message carries the card, the whole
skeleton, and whatever leaves fit inline. The minimal share is card plus
skeleton and `index.json` and nothing under `files/`: the receiver can
verify the card, read what the object says it is, walk the tree,
see every path and every size, and know exactly which CIDs it lacks —
before a single content byte has moved.

## 2. Message

```json
{
  "type": "https://estoc.dev/object-share/1.0/share",
  "id": "<uuid>",
  "body": { "root": "bafybei…", "card": "<compact JWS>" },
  "attachments": [
    { "id": "bafybei…", "media_type": "application/vnd.ipld.dag-pb", "byte_count": 108, "data": { "base64": "…" } },
    { "id": "bafkrei…", "media_type": "application/vnd.ipld.raw",    "byte_count": 100, "data": { "base64": "…" } }
  ]
}
```

- **`body.root`** — the CID of the object's root directory node: the name
  of the tree the attachments make. Required.
- **`body.card`** — optional; present, the share is a signed object. The
  object's card: `@estoc/folder-object`'s compact JWS
  (`typ: estoc/object-card`, EdDSA) over exactly `{did, root}`; `did` is a
  `did:key`, `kid` its one verification method. Its `root` must equal
  `body.root` — a card about another tree is a share that does not
  verify. The body carries nothing else: whatever the object says about
  itself is in the tree (`index.json`), and saying it twice makes two
  truths.
- **`attachments`** — blocks of the tree, one attachment each, in CID
  order. `id` **is** the CID and is the block's only name; `data.base64`
  is base64url (DIDComm v2), `media_type` is
  `application/vnd.ipld.dag-pb` or `application/vnd.ipld.raw`,
  `byte_count` the decoded length. `data.hash` is not used: DIDComm
  defines it beside `links`, and didcomm-rust drops it from an inline
  attachment. Attachments of any other shape are ignored, not errors.

  The tree's blocks fall in two classes, told apart by codec alone:

  - **skeleton** — every `dag-pb` block the root reaches: directory
    nodes (plain and HAMT shards) and the chunk-index nodes of files
    over 1 MiB. **The skeleton is always complete.** A share missing any
    skeleton block is malformed: without it the tree cannot be walked,
    and a tree that cannot be walked is not a shape the receiver can
    hold, only a hash.
  - **leaves** — every `raw` block: single-block files and the chunks of
    larger ones. **Leaves may be absent**, with one exception: the
    leaf (or leaves) of `index.json` always go with the skeleton. A
    leaf is present when its CID is among the attachments and absent
    otherwise; there is no field that says so, absence is the signal.
    The skeleton already names each leaf and its size (the `dag-pb`
    link's `Tsize`), so the receiver knows what it lacks and how much
    that is.

  `index.json` travels with the skeleton because it is what makes the
  tree an object (§1): a skeleton without it is a shape the receiver
  can walk but cannot name — no format, no title, not this protocol's
  unit until the file arrives. So the **minimal share** is the `dag-pb`
  blocks plus `index.json`'s blocks; a share missing either is
  malformed. Everything under `files/` is what may wait.

  No skeleton of its own: the UnixFS nodes *are* the skeleton. A separate
  manifest — a list of paths and CIDs beside the tree — would be a second
  truth that has to be checked against the first, and is not a block.
  Chunking is whatever the hashing profile says (`unixfs-v1-2025`: 1 MiB
  chunks, balanced layout, raw leaves) and is not this protocol's
  concern: a chunk is a leaf like any other, a chunk index is skeleton
  like any other.
- No `thid`: a share starts nothing. An application that answers (a
  comment, a reply post) threads on the share's `id` like any message.

## 3. Sending

1. Read the folder as an object (`readObject`: `index.json` + `files/…`,
   litter dropped), hash its canonical tree and gather the closure:
   `hashTree`'s `nodes` (the skeleton) plus every raw block
   (`closureOf`).
2. Decide what goes inline against the sender's limit (`maxShareBytes`,
   default 1 MiB). The skeleton and `index.json` always go; if those
   alone exceed the limit the object cannot be shared by this message
   at all — refuse.
   Leaves go in full when the whole closure fits. When it does not, the
   share carries the skeleton and no leaves — all or nothing, not "the
   first few that fit": a leaf set chosen by size is a partial object
   with no meaning the receiver can act on, while skeleton-only is a
   definite thing (§7). The leaves then take another road; splitting
   them into asks over DIDComm would make the sender the relay.
3. The card, if any. Plain, the share is the object as it is: no card,
   nobody stands behind it, the message says only what the envelope says.
   To stand behind it, sign `{did: anchor, root}` with the vault's anchor
   key. To pass on a signed object that already has a card, verify it and
   require its `root` to equal the root just computed — the message then
   carries the author's testimony, not ours. One card per share: signing
   and passing on are not combined.
4. Keep the blocks in our own `blobs/` and send. The record in the log
   is the message as sent, attachments inline.

## 4. Receiving

The agent logs the message like any other (attachments inline) and homes
it to the contact the envelope proves. The handler then:

1. if there is a card, verifies it under the `did:key` in its own payload
   and requires its `root` to be `body.root`;
2. decodes the block attachments and verifies the **skeleton** from
   `body.root` over them (`verifyTree`): every `dag-pb` node reachable
   and hashing to its CID, every link resolved either to a present block
   or to an absent `raw` CID. A missing `dag-pb` block is malformed; a
   missing `raw` block is a missing leaf, recorded, not an error;
3. verifies each present leaf against its CID;
4. reads the tree as an object (`readObject`): `index.json`'s blocks
   are part of the minimal share (§2), so their absence is malformed
   like a missing skeleton block, not a missing leaf. A well-hashed
   tree that is not a folder-object — no `index.json`, or a malformed
   one — does not verify, however good its hashes;
5. on success puts every block it holds in `blobs/<cid>` (put-if-absent
   — blocks already held from another share are simply already there),
   and the object is **complete** if no leaf is missing, **partial**
   otherwise. Leaves already in `blobs/` from an earlier share count as
   present: the CID names them, whoever sent them;
6. on failure keeps the record as it arrived (a fact about what was sent)
   and notes why; nothing goes to `blobs/`.

The application shows the record either way, and runs the same check to
decide how (`verifyShare`); a share that does not verify is shown as
that, not hidden. A partial object is shown as an object with missing
files — its title, its paths, its sizes are all known — and never as a
broken one.

## 5. What the card says, and what it does not

The envelope proves **who sent** the message (the pairwise DID). The card,
when there is one, proves **who stands behind the object** — the signer's
anchor `did:key`, which is not the pairwise DID. Handing over and standing
behind are two acts, and a share does either one or both; that is why the
card is a layer and not a field the message cannot do without. Without a
card, what the receiver holds is an object a contact handed them — no
less verified (the tree is what `root` names, and it is an object), just
nobody's testimony. They differ on purpose:

- a contact can pass on what another wrote, under the author's card, and
  the third party can check it without knowing either pairwise channel;
- what lands in the vault is the same card-plus-blocks the author would
  publish anywhere else — the message is transport, the object is the fact
  (`Post ≠ DIDComm message`);
- it means a *signed* share reveals the signer's anchor DID to the
  receiver. That is the identity a contact is meant to know from someone
  who stands behind a thing; anyone who would rather not show it hands
  the object over plain, and the pairwise envelope is all the receiver
  learns.

Which of two trees is *current* is the tree's own business
(`index.json`'s `id` and `updated`), never the card's.

A card also means exactly one thing — *this DID stands behind this
object* — and what standing behind a given object amounts to is defined
by the format the object declares (`post/1.0`: "I publish this post").
A card over a bare folder would be a signature without a meaning — and a
bare folder is not this protocol's unit in the first place, signed or
not: what makes the tree shareable is that it declares what it is. Every
other intent lives in another layer. "I sent you this" is the envelope,
and a plain share says nothing more. "I stand behind this" is my card.
"I pass on what they wrote" is their card under my envelope. "I recommend
/ reply to / quote this" is a new object of mine that refers to theirs.

## 6. Storage

`blobs/<cid>` (`docs/vault-format.md` §6.8): immutable, named by content,
merged by union on import. The message log still holds the attachments
inline; lifting them out of log lines into `blobs/` references is a later
step and changes nothing on the wire.

## 7. Missing leaves

A share with absent leaves is a complete statement, not a broken one: the
card is verified, the tree is verified, the receiver holds the exact set
of CIDs it lacks, with sizes. What it lacks is bytes, and bytes are not
this protocol's business. Fetching them is:

- **another road**, by CID — a WebRTC data channel signalled over
  DIDComm, or a content relay — where the ask is the flat want list the
  skeleton already implies, `want [cid…] → block`. No path, no selector:
  the receiver has the tree, the sender is a block store;
- **or a later share** of the same root, or of another object that
  happens to contain the same file — `blobs/` is by CID, so leaves land
  wherever they come from and the partial object fills in
  (put-if-absent, then re-run the check).

There is no `want` message in object-share/1.0 over DIDComm, on purpose:
asking a phone for blocks over a store-and-forward channel needs that
phone awake at each ask (§1). The skeleton is what makes the ask
unnecessary here and trivial elsewhere.

An implementation that does not yet have another road still gets the
minimal share: a contact sees what was shared, who stands behind it, and
how big it is — and the leaves come when a road exists, without a second
protocol.
