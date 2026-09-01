# object-share/1.0

Status: implemented — §1–6 in `@estoc/agent-core` 0.15.0
(`@estoc/folder-object` 0.5.0), §7–8 in 0.16.0 (folder-object 0.6.0),
2026-08-26. The store a package lives in is `blob-store/1.0`
(`docs/blob-store.md`).
Design history: `research/notes/2026-08-24-object-share-over-didcomm.md`,
`research/notes/2026-08-26-want-and-blob-road.md`.

## 1. What it is for

Handing a contact a whole **object** — a [folder-object](https://github.com/estoc-net/folder-object)
hashed into a UnixFS tree (`@estoc/folder-object`, profile
`unixfs-v1-2025`) — over DIDComm, in one message, with nothing to ask
back.

The unit is an object or a signed object, the two forms
`@estoc/folder-object` has. The protocol reads exactly one thing inside
the tree — that it *is* an object (`index.json` well-formed, folder-object
spec §8) — and does not interpret the object's format. A tree that does
not say what it is has no interpretation and is not this protocol's unit
(that would be sending a zip). Nor is this media-sharing/1.0, whose unit
is a flat item named by an arbitrary id: ours is a tree named by content,
whose structure the receiver verifies.

One message carries the card, if any; the tree's **skeleton**, always;
and its **leaves**, inline when they fit and otherwise as one
**package** (§8) — the closure as an encrypted CAR at a URL, the key in
the message. Either way the receiver can verify the card, read what the
object says it is, and walk every path and size before, or without, a
content byte moving. There is no ask in the protocol (§7).

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
  object's card as `@estoc/folder-object` defines it: a compact JWS
  (`typ: estoc/object-card`, EdDSA) over exactly `{did, root}`, `did` a
  `did:key` and `kid` its one verification method. Its `root` must equal
  `body.root`; a card about another tree is a share that does not verify.
  The body carries nothing else about the object: whatever the object
  says about itself is in the tree (`index.json`), and saying it twice
  makes two truths. (`body.package`, §8, is about transport, not the
  object.)
- **`attachments`** — the tree's blocks, one attachment each, in CID
  order. `id` **is** the CID and is the block's only name; `data.base64`
  is base64url (DIDComm v2); `media_type` is
  `application/vnd.ipld.dag-pb` or `application/vnd.ipld.raw`;
  `byte_count` is the decoded length. `data.hash` is not used on blocks:
  DIDComm defines it beside `links`, and didcomm-rust drops it from an
  inline attachment. Attachments of any other shape are ignored, not
  errors (the package attachment, §8, is one).

  **One `id`, one attachment.** The same `id` on two attachments — block
  or package, whatever their bytes — is malformed: two attachments under
  one name leave it to the reader which bytes the name means.
  `media_type` and `byte_count` are informative, for tooling that reads
  attachments without decoding blocks, and are not checked: the CID says
  the codec and the bytes say their length. A block is what it is when
  its bytes hash to its `id`.

  The blocks fall in two classes, told apart by codec:

  - **skeleton** — every `dag-pb` block the root reaches: directory
    nodes (plain and HAMT shards) and the chunk-index nodes of files
    over 1 MiB. **Always complete**; a share missing one is malformed,
    since the tree cannot be walked. The skeleton is the whole listing —
    every path's name, size (`Tsize`) and CID — so a receiver holding
    only it already sees what the object contains and how big each part
    is.
  - **leaves** — every `raw` block: single-block files and the chunks of
    larger ones. **May be absent**, except the leaves of `index.json`,
    which is what makes the tree an object (§1). No field says whether a
    leaf is present; its CID among the attachments (or already held, §4)
    is the signal.

  The **minimal share** is the skeleton plus `index.json`'s blocks; a
  share missing any of them is malformed. Everything under `files/` is
  what may travel as a package.

  There is no manifest beside the tree: the UnixFS nodes are the
  skeleton, and a second listing would be a second truth. Chunking is the
  hashing profile's (`unixfs-v1-2025`: 1 MiB chunks, balanced layout, raw
  leaves), not this protocol's: a chunk is a leaf, a chunk index is
  skeleton.
- No `thid`: a share starts nothing and answers nothing. An application
  that answers (a comment, a reply post) threads on the share's `id` like
  any message.

## 3. Sending

1. Read the folder as an object (`readObject`: `index.json` + `files/…`,
   litter dropped) and hash it; the closure is `hashTree`'s `nodes` plus
   every raw block (`closureOf`).
2. Choose the road by the sender's inline limit (`maxShareBytes`, default
   1 MiB). The minimal share always goes inline; if it alone exceeds the
   limit, refuse — the object cannot be shared by this message. If the
   whole closure fits, every leaf goes inline. Otherwise **no leaf goes
   inline** and the whole closure goes as one package (§8) — never "the
   leaves that fit": a leaf set chosen by size is a partial object with
   no meaning the receiver can act on, while skeleton-plus-package is one
   definite thing.
3. The card, if any. Plain, nobody stands behind the object and the
   message says only what the envelope says. To stand behind it, sign
   `{did: anchor, root}` with the vault's anchor key. To pass on a signed
   object, verify its card and require its `root` to equal the root just
   computed; the message then carries the author's testimony, not ours.
   One card per share: signing and passing on are not combined.
4. Put every block of the closure in our own `blobs/` and send. The
   record's body names the blocks by id — the block attachments without
   their `data`, the bytes in `blobs/` once (`docs/vault-events.md` §4);
   a delivery fills them back in from there.

## 4. Receiving

The agent logs the message like any other and homes it to the contact the
envelope proves. The handler (`verifyShare`) then:

1. if there is a card, verifies it under the `did:key` in its own payload
   and requires its `root` to be `body.root`;
2. decodes the block attachments and verifies the skeleton from
   `body.root` over them and over blocks already in `blobs/`
   (`verifyTree`): every `dag-pb` node reachable and hashing to its CID,
   every link resolved to a present block or an absent `raw` CID. A
   missing `dag-pb` block is malformed; a missing `raw` block is a
   missing leaf, recorded;
3. verifies each present leaf against its CID;
4. reads the tree as an object (`readObject`). `index.json` absent or
   malformed is malformed, not a missing leaf: a well-hashed tree that is
   not an object does not verify, however good its hashes;
5. on success puts every block the tree reaches in `blobs/<cid>`
   (put-if-absent) and records the message with those attachments by id
   alone, their bytes in `blobs/`; a block carried beside the tree is no
   part of the object, neither put nor stripped. The object is
   **complete** if no leaf is missing, **partial** otherwise. Leaves held
   from an earlier share count as present: the CID names them, whoever
   sent them;
6. on failure keeps the record as it arrived — a fact about what was
   sent — and notes why; nothing goes to `blobs/`;
7. if the object is partial and the share names a usable package (§8),
   the application may fetch it whenever it chooses
   (`Agent.fetchPackage`): the package's blocks are imported and steps
   2–5 run again.

The application shows the record either way and runs the same check to
decide how: a share that does not verify is shown as that, not hidden; a
partial object is shown as an object with missing files — its title,
paths and sizes all known — never as a broken one.

## 5. What the card says, and what it does not

The envelope proves **who sent** the message (the pairwise DID). The card
proves **who stands behind the object** — the signer's anchor `did:key`,
which is not the pairwise DID. Handing over and standing behind are two
acts, and a share does one or both; that is why the card is a layer and
not a field the message cannot do without. Without a card the receiver
holds an object a contact handed them: no less verified (the tree is what
`root` names, and it is an object), just nobody's testimony. Keeping the
two apart means:

- a contact can pass on what another wrote under the author's card, and
  a third party can check it without knowing either pairwise channel;
- what lands in the vault is the same card-plus-blocks the author would
  publish anywhere else — the message is transport, the object is the
  fact;
- a signed share reveals the signer's anchor DID to the receiver. That is
  the identity a contact is meant to know from someone who stands behind
  a thing; anyone who would rather not show it hands the object over
  plain.

A card means exactly one thing — *this DID stands behind this object* —
and what that amounts to is defined by the format the object declares
(`post/1.0`: "I publish this post"). Every other intent is another layer:
"I sent you this" is the envelope; "I pass on what they wrote" is their
card under my envelope; "I recommend / reply to / quote this" is a new
object of mine that refers to theirs. Which of two trees is *current* is
the tree's own business (`index.json`'s `id` and `updated`), never the
card's.

## 6. Storage

`blobs/<cid>` (`docs/vault-folder.md` §8): immutable, named by content,
merged by union on import. A share's blocks are there once, whichever
road and however many shares brought them: the record's body keeps the
block attachments by id and without their `data` (`docs/vault-events.md`
§4), so erasing the share's root erases the bytes, and a delivery of a
share of ours puts them back from `blobs/`. Nothing changes on the wire.

## 7. Two roads, no round trip

A share is one message, complete by itself, on one of two roads the
sender chooses by size (§3):

- **inline** — every block in the message; the receiver has the whole
  object the moment it reads it.
- **skeleton inline, bytes at a URL** — the minimal share in the message
  and the whole closure as one package (§8) the receiver downloads
  itself, when it likes, while the store keeps it (`available_until`),
  without the sender.

The road is the sender's rule. The receiver cannot enforce it — a share
with some leaves inline looks the same as one whose missing leaves
arrived earlier, since `blobs/` is by CID — and checks what is checkable:
the skeleton whole, `index.json` present, every block by its CID, the
card. What it may end up holding is a **verified skeleton with bytes
absent**: a partial object. A sender that sent less has given less, which
is not an attack; a package that is gone (the store's retention ran out)
leaves the same state. It is a state, not a road: nobody chooses it, and
any later share of the same root — or of another object containing the
same file — fills it in, since leaves land in `blobs/` wherever they come
from.

There is no third road and no ask. With the skeleton the receiver lacks
nothing it needs to *know* — who stands behind the object, what it is,
every file's name and size — and the bytes are either here or at the URL.
Asking again is a human act, not a message type. An ask would make the
sender a block store that must be awake to answer — with two phones each
online now and then, the fault that stalled HTTP-over-DIDComm — turn one
share into a conversation, and need a state machine on both sides for
what is still owed. One message plus one URL needs neither; what it costs
is that a lost package is lost, and the skeleton is what makes that a
partial object rather than nothing.

## 8. Package

A **package** is the tree's closure as a CARv1, encrypted under a fresh
key, put at a URL, and named in the share. The bytes travel over HTTP
whenever the receiver chooses; the share carries the URL, the hash and
the key; the mediator's queue never holds the bytes. A package is a
**blob** in `blob-store/1.0`'s sense (§8.1) whose plaintext is a CAR.

```json
{
  "type": "https://estoc.dev/object-share/1.0/share",
  "id": "<uuid>",
  "body": {
    "root": "bafybei…",
    "card": "<compact JWS>",
    "package": {
      "attachment_id": "bciqk…",
      "ciphering": { "algorithm": "AES256_GCM_HKDF_1MB", "parameters": { "key": "<base64url, 32 bytes>" } },
      "available_until": "2026-09-26T12:00:00Z"
    }
  },
  "attachments": [
    { "id": "bafybei…", "media_type": "application/vnd.ipld.dag-pb", "byte_count": 108, "data": { "base64": "…" } },
    { "id": "bafkrei…", "media_type": "application/vnd.ipld.raw",    "byte_count": 100, "data": { "base64": "…" } },
    { "id": "bciqk…", "media_type": "application/vnd.ipld.car", "byte_count": 734003200,
      "data": { "links": ["https://…/b/m3q7xk…"], "hash": "bciqk…" } }
  ]
}
```

**The package attachment** is a DIDComm linked attachment whose `id`,
`data.hash`, `data.links` and `byte_count` are all about the
**ciphertext**; `media_type` `application/vnd.ipld.car` names the
plaintext.

- `data.hash` is the ciphertext's name — a sha2-256 multihash, multibase
  base32 lower (`b…`), the string the sender's store checked the upload
  against (§8.1) — and `id` is the same string. Hashing the ciphertext
  lets a download be checked as it is, before any key is used. A package
  whose bytes do not hash to `data.hash` is discarded.
- `data.links` holds **exactly one URL**: absolute, `https:` or `http:`,
  no credentials. DIDComm allows a list; this protocol does not use it —
  the bytes have one place. The URL is a place to `GET` ciphertext and
  nothing more: the receiver fetches it as given, follows no redirect,
  and may refuse it by its own policy (a private address, a scheme it
  does not trust) — that is a partial object, not an error in the share.
  The URL says nothing about the bytes or the sender (the store names it
  at random, §8.1); the hash is the share's, not the URL's.
- `byte_count` is the contract for the download: a response that
  announces or sends more is abandoned where it stands, one that ends
  short is not the package, and the receiver need never hold more than
  `byte_count` bytes nor spend a key on bytes of the wrong length.

**`body.package`** names the package — at most one per share, because
the closure either fits the message or goes to one URL (§7). It lives in
the body, not on the attachment, because DIDComm attachments have no such
field and implementations drop fields they do not know.

- `attachment_id` — the package attachment's `id`.
- `ciphering` — `algorithm` and `parameters`: the shape of
  media-sharing/1.0's, and no more of that protocol. `algorithm` is one
  of the list below; `parameters.key` is the raw key, base64url. The key
  is fresh per package and travels only in this authcrypted message:
  encrypting it to the receiver is what the envelope does. One
  ciphertext, one key, any number of recipients each told in their own
  message — sharing one object with several contacts is one upload.
- `available_until` — RFC 3339: the store's `retain_until` (§8.1) as the
  sender was last told it. Required, since the sender always knows it;
  advisory, since only the store knows what it will do. A share can wait
  in a mediator's queue for weeks, and the receiver reads the date
  against now to decide whether to fetch first and read later, or to
  expect a partial object. Past it the bytes may still be there — one
  `GET` says — but nobody promised.

A package attachment with no `body.package` entry is ignored. An entry
that is there but cannot be used — not an object; naming no attachment,
or one not in the message, or one of the wrong shape or `media_type`; an
algorithm this receiver does not have; a key of the wrong size; no
`available_until` — is **named but unusable**: the share is still what
its blocks make it, verified and partial (§7), and the receiver reports
*why* the bytes cannot be had, distinct from a share that offered none.
It is not malformed: the object is whole in what it says about itself and
the card is still good; what is broken is a way of getting bytes, and
they may come another way. (`verifyShare` returns `package` for a usable
one, `packageProblem` for a named-but-unusable one, neither for none.)

A package is transport for one share: bytes the sender put somewhere for
the recipients it tells, for as long as its store keeps them. A recipient
that passes the object on shares it anew (§3), by its own road and under
its own package if it needs one; nothing in this protocol extends a
package's life or lets a third party stand in for the sender at the
store.

**Algorithms.** `AES256_GCM_HKDF_1MB` — Tink's streaming AEAD of that
name (`AesGcmHkdfStreaming`: 32-byte key, HKDF-SHA256 to a 32-byte
derived key, 1 MiB ciphertext segments, empty associated data), wire
format as Tink specifies: a header (length byte, salt, 7-byte nonce
prefix), then segments each AES-GCM under a nonce of prefix, segment
number and last-segment flag. Every segment authenticates alone, in
order; truncation is caught by the last-segment flag. It is the only
algorithm in 1.0.

In 1.0 the receiver fetches the whole ciphertext, checks length and hash,
then opens it: nothing is decrypted, and no block kept, before the bytes
are known to be the package. The segment format is chosen so that a
later version can resume by HTTP `Range` on segment boundaries and check
each segment as it lands — but that is the format's permission, not a
provision of this protocol: what state a resuming receiver keeps, how a
`206` is checked, and that `data.hash` is still over the whole are not
specified, and a 1.0 receiver that starts over is conforming. (Not
media-sharing's whole-file `aes-256-cbc` with `iv` and `tag` in the
message: one tag over a file means the whole file before a byte is
trusted, and a range can never be checked.)

**The plaintext** is a CARv1 whose `roots` is exactly `[root]` and whose
blocks the sender **must** make the tree's whole closure — skeleton,
`index.json`, every leaf. It repeats what the message carries so that it
is a whole object on its own, verifiable by anyone with the URL and key,
without the message; it neither replaces nor loosens the minimal share,
which is always inline (§2).

**Fetching** (`Agent.fetchPackage`), at any time the receiver likes:
`GET` the URL, check the length, verify the hash, decrypt, read the CAR.
`roots` is checked first — a CAR rooted anywhere else is not this
object's package and is discarded whole, like bytes that fail the hash.
Then block by block: bytes that do not hash to the CID they are filed
under are dropped, blocks outside the closure of `root` are dropped, and
what remains goes to `blobs/` put-if-absent, after which the share is
checked again (§4). A package that opens but lacks blocks of the closure
is **not** discarded: what walks is kept and the object is partial, as it
would be had those bytes never been offered — whole is the sender's duty,
salvage is the receiver's. Bytes that are gone, or that fail the hash,
leave the share what it was: a verified, partial object. Once imported,
nothing of the package itself is kept: the blocks are in `blobs/` by CID
and the package was transport.

**Sending** (§3 step 2): when the closure does not fit inline, CAR it,
encrypt under a fresh key, put the ciphertext in a store (§8.1), and
send the minimal share inline with the package named.

### 8.1 Where the bytes live

The URL is any HTTP location serving the ciphertext with `GET`. The
sender's own mediator is the natural one: `blob-store/1.0`
(`docs/blob-store.md`) lets an agent holding a mediation with it put a
blob there under a retention and get back the URL. The store checks the
upload against the package's `data.hash`, serves it at a URL of its own
choosing (a random id, unrelated to the hash), and its `retain_until` is
the share's `available_until`. The blob is the sender's alone — its
`delete` ends it — and the store is a temporary road, not where the
object lives: what lives is the object in each vault's `blobs/`. Nothing
in the share depends on which store: the receiver has a URL, a hash and
a key.
