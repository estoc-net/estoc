# object-share/1.0

Status: implemented in `@estoc/agent-core` 0.14.0 (2026-08-24). Design
history: `research/notes/2026-08-24-object-share-over-didcomm.md`.

## 1. What it is for

Handing a contact a whole **object** — a [folder-object](https://github.com/estoc-net/folder-object)
hashed into a UnixFS tree (`@estoc/folder-object`, profile
`unixfs-v1-2025`) — over DIDComm, in one message, with nothing to fetch
and nothing to ask back. The protocol carries the closure, and, when
someone stands behind the object, the card: a share is either an
**object** or a **signed object**, the two forms `@estoc/folder-object`
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

DIDComm stays the control plane. Big objects will take another road
(a WebRTC data channel signalled over DIDComm, or a content relay), and
will keep the CID as the unit; this message will then carry the card and
whatever blocks fit inline, and no protocol field changes.

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
- **`attachments`** — the closure: every block the root reaches, one
  attachment each, in CID order. `id` **is** the CID and is the block's
  only name; `data.base64` is base64url (DIDComm v2), `media_type` is
  `application/vnd.ipld.dag-pb` for directory / chunked-file nodes and
  `application/vnd.ipld.raw` for single-block files, `byte_count` the
  decoded length. `data.hash` is not used: DIDComm defines it beside
  `links`, and didcomm-rust drops it from an inline attachment.
  Attachments of any other shape are ignored, not errors.
- No `thid`: a share starts nothing. An application that answers (a
  comment, a reply post) threads on the share's `id` like any message.

## 3. Sending

1. Read the folder as an object (`readObject`: `index.json` + `files/…`,
   litter dropped), hash its canonical tree and gather the closure:
   `hashTree`'s `nodes` plus the input bytes of every single-block file
   (`closureOf`).
2. Refuse if the blocks sum past the sender's limit (`maxShareBytes`,
   default 1 MiB): an object that does not fit one message waits for
   another road; splitting it into asks would make the sender the relay.
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
2. decodes the block attachments and verifies the tree from `body.root`
   over them (`verifyTree`): every path reachable, every hash matching,
   no block missing;
3. reads the tree as an object (`readObject`): a well-hashed tree that is
   not a folder-object — no `index.json`, or a malformed one — does not
   verify, however good its hashes;
4. on success puts every block in `blobs/<cid>` (put-if-absent — blocks
   already held from another share are simply already there);
5. on failure keeps the record as it arrived (a fact about what was sent)
   and notes why; nothing goes to `blobs/`.

The application shows the record either way, and runs the same check to
decide how (`verifyShare`); a share that does not verify is shown as
that, not hidden.

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
