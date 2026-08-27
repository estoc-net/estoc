# object-share/1.0

Status: implemented in full — §1–6 in `@estoc/agent-core` 0.15.0
(`@estoc/folder-object` 0.5.0), §7–8 (packages: CAR, `AES256_GCM_HKDF_1MB`,
blob-store put/upload, `Agent.fetchPackage`) in 0.16.0 (folder-object
0.6.0), 2026-08-26.
Design history: `research/notes/2026-08-24-object-share-over-didcomm.md`,
`research/notes/2026-08-26-want-and-blob-road.md`.

## 1. What it is for

Handing a contact a whole **object** — a [folder-object](https://github.com/estoc-net/folder-object)
hashed into a UnixFS tree (`@estoc/folder-object`, profile
`unixfs-v1-2025`) — over DIDComm, in one message, with nothing to ask
back. The protocol carries the tree's **skeleton** always, its **leaves**
inline when they fit and as one **package** (§8) when they do not, and,
when someone stands behind the object, the card: a share is either an
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
reads it whenever. There is no ask in this protocol at all: a share is
complete by itself — either every block is in the message, or the message
names one URL where the rest waits, and the receiver fetches it alone.

DIDComm stays the control plane. The bytes of a big object take another
road — the package: the blocks as an encrypted CAR at a URL, the key in
this message — and keep the CID as the unit. Either way the message
carries the card, the whole skeleton, and `index.json`: the receiver can
verify the card, read what the object says it is, walk the tree, see
every path and every size — before, or without, a single content byte
moving.

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
  verify. The body carries nothing else about the object: whatever the
  object says about itself is in the tree (`index.json`), and saying it
  twice makes two truths. (`body.package`, §8, is about transport, not
  the object.)
- **`attachments`** — blocks of the tree, one attachment each, in CID
  order. `id` **is** the CID and is the block's only name; `data.base64`
  is base64url (DIDComm v2), `media_type` is
  `application/vnd.ipld.dag-pb` or `application/vnd.ipld.raw`,
  `byte_count` the decoded length. `data.hash` is not used on block
  attachments: DIDComm defines it beside `links`, and didcomm-rust drops
  it from an inline attachment. Attachments of any other shape are
  ignored, not errors (the package attachment, §8, is one of them).

  **One `id`, one attachment.** The same `id` on two attachments — block
  or package, whatever their bytes — is malformed: the share does not
  verify. Two attachments under one name leave it to the reader which
  bytes the name means, and readers would differ; nothing a sender
  wants to say needs it. `media_type` and `byte_count` on a block are
  informative, for tooling that reads attachments without reading
  blocks: the receiver does not check them and they decide nothing. The
  CID says the codec and the bytes say their length, and a second
  statement of either would be a second truth (as with the body, above).
  A block is what it is when its bytes hash to its `id`, and nothing
  else.

  The tree's blocks fall in two classes, told apart by codec alone:

  - **skeleton** — every `dag-pb` block the root reaches: directory
    nodes (plain and HAMT shards) and the chunk-index nodes of files
    over 1 MiB. **The skeleton is always complete.** A share missing any
    skeleton block is malformed: without it the tree cannot be walked,
    and a tree that cannot be walked is not a shape the receiver can
    hold, only a hash. The skeleton is the whole directory listing —
    every path's name (the `dag-pb` link's `Name`), size (`Tsize`) and
    CID — so a receiver holding only the skeleton already sees what the
    object contains and how big each part is; only the bytes are absent.
  - **leaves** — every `raw` block: single-block files and the chunks of
    larger ones. **Leaves may be absent**, with one exception: the
    leaf (or leaves) of `index.json` always go with the skeleton. A
    leaf is present when its CID is among the attachments and absent
    otherwise; there is no field that says so, absence is the signal.

  `index.json` travels with the skeleton because it is what makes the
  tree an object (§1): a skeleton without it is a shape the receiver
  can walk but cannot name — no format, no title, not this protocol's
  unit until the file arrives. So the **minimal share** is the `dag-pb`
  blocks plus `index.json`'s blocks; a share missing either is
  malformed. Everything under `files/` is what may travel as a package.

  No skeleton of its own: the UnixFS nodes *are* the skeleton. A separate
  manifest — a list of paths and CIDs beside the tree — would be a second
  truth that has to be checked against the first, and is not a block.
  Chunking is whatever the hashing profile says (`unixfs-v1-2025`: 1 MiB
  chunks, balanced layout, raw leaves) and is not this protocol's
  concern: a chunk is a leaf like any other, a chunk index is skeleton
  like any other.
- No `thid`: a share starts nothing and answers nothing. An application
  that answers (a comment, a reply post) threads on the share's `id`
  like any message.

## 3. Sending

1. Read the folder as an object (`readObject`: `index.json` + `files/…`,
   litter dropped), hash its canonical tree and gather the closure:
   `hashTree`'s `nodes` (the skeleton) plus every raw block
   (`closureOf`).
2. Choose the road against the sender's inline limit (`maxShareBytes`).
   The skeleton and `index.json` always go inline; if those alone exceed
   the limit the object cannot be shared by this message at all —
   refuse. When the whole closure fits, every leaf goes inline and the
   share is complete in one message. When it does not, **no leaf goes
   inline** and the whole closure goes as one package (§8): the receiver
   gets the listing in the message and the bytes from the URL. Never
   "the leaves that fit": a leaf set chosen by size is a partial object
   with no meaning the receiver can act on, while skeleton-plus-package
   is one definite thing.
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
   and notes why; nothing goes to `blobs/`;
7. if the share names a package (§8) and the object is partial, fetches
   it — now or whenever the receiver chooses — imports its blocks, and
   runs steps 2–5 again with them held.

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

## 7. Two roads, no round trip

A share is one message and is complete by itself. It takes one of two
roads, decided by the sender by size (§3):

- **inline** — every block in the message. The mediator's queue holds
  it; the receiver has the whole object the moment it reads the message.
- **skeleton inline, bytes at a URL** — the skeleton and `index.json` in
  the message, the whole closure as one encrypted package (§8) the
  receiver downloads itself, when it likes and while the store keeps
  them (`available_until`, §8), without the sender.

The two roads are the sender's rule; the receiver does not enforce it
and cannot: a share with some leaves inline looks the same as a share
whose missing leaves arrived in an earlier one, since `blobs/` is by CID
and leaves land wherever they come from. The receiver checks what is
checkable — the skeleton whole, `index.json` present, every block by its
CID, the card — and reports what is here and what is not. A sender that
sends less than it should has given less, which is not an attack; what
the receiver sees is a partial object, the same state a package's
retention running out leaves behind. That state — **skeleton, verified,
bytes absent** — is where both roads end when the bytes do not arrive,
and is a state, not a road: no sender chooses it.

There is no third road and no ask. The receiver never tells the sender
what it lacks: with the skeleton it lacks nothing it needs to *know* —
who stands behind the object, what it is, every file's name and size —
and the bytes are either here or at the URL. A package that is gone (the
store's retention ran out, §8.1) leaves a verified skeleton-only share:
the receiver still sees what was shared and by whom, and asking for it
again is a human act, not a message type. Any later share of the same
root, or of another object containing the same file, fills a partial
object in: `blobs/` is by CID, so leaves land wherever they come from
(put-if-absent, then re-run the check).

Why no ask: an ask makes the sender a block store that must be awake to
answer, turns one share into a conversation, and needs a state machine on
both sides for what is still owed. One message plus one URL needs
neither. What it costs is that a lost package is lost; the skeleton is
what makes that a partial object rather than nothing.

## 8. Package

A **package** is the tree's closure as a CAR, encrypted, put at a URL,
and named in the share. It carries the bytes when they do not fit
inline: they travel over HTTP whenever the receiver chooses; the share
carries the card, the skeleton, the URL, the hash, and the key — DIDComm
is the control plane and the mediator's queue never holds the bytes.

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
      "data": { "links": ["https://…/b/bciqk…"], "hash": "bciqk…" } }
  ]
}
```

- **The package attachment** is a DIDComm linked attachment:
  `data.links`, `data.hash`, and `byte_count`, all about the
  **ciphertext**; `media_type`
  `application/vnd.ipld.car` names what the plaintext is. `data.hash` is
  a multihash (sha2-256) of the ciphertext bytes, multibase base32 lower
  (`b…`), and `id` is that same string: the ciphertext's own name. The
  hash is over the ciphertext so a download is checked as it is, before
  any key is used, and a package may be named by anyone who has the
  bytes. Verifying the hash is required; a package whose bytes do not
  hash to `data.hash` is discarded.
- **`data.links` holds exactly one URL**, absolute, `https:` or
  `http:`, with no credentials. DIDComm allows a list; this protocol
  does not use it: the bytes have one place, the sender's store (§8.1),
  and a mirror is that store's business (a redirect, or the same hash at
  another URL in a later share), not a list for the receiver to walk. A
  package naming zero or several links, or a URL of another shape, is a
  package that cannot be opened and is ignored. The URL is a place to
  `GET` ciphertext and nothing more: a receiver fetches it as given and
  follows no redirect, and may refuse a URL by its own policy (a private
  or local address, a scheme it does not trust) — that is a partial
  object, not an error in the share.
- **`byte_count` is the contract for the download.** A response that
  announces or sends more than `byte_count` bytes is not the package and
  is abandoned where it stands; one that ends short is not the package
  either. The receiver need never hold more than `byte_count` bytes, and
  never spends a key on bytes whose length is wrong.
- **`body.package`** — at most one per share: `attachment_id` naming the
  package attachment, `ciphering` saying how to open it, `available_until`
  saying how long the bytes were promised for. It lives in the body, not
  on the attachment, because DIDComm attachments have no such field and
  implementations drop fields they do not know. One package, because the
  share is one thing: the closure either fits the message or goes to one
  URL (§7).

  A package attachment with no `package` entry is ignored. An entry that
  is there but cannot be used — not an object, naming no attachment or
  one that is not in the message, an algorithm this receiver does not
  have, a key of the wrong size, no `available_until`, or an attachment
  of the wrong shape (§8, the rules above) — is **a package named but
  unusable**: the share is still what its blocks make it, verified and
  partial (§7), and the receiver reports *why* the bytes cannot be had,
  distinct from a share that offered none. It is not malformed: the
  object is whole in what it says about itself, and the card, if any,
  is still good; what is broken is a way of getting bytes, and the
  receiver may get them another way. (`verifyShare` returns `package`
  for a usable one, `packageProblem` for a named-but-unusable one, and
  neither for none.)
- **`available_until`** is an ISO 8601 date-time: the store's
  `retain_until` (§8.1) as the sender was last told it — required, since
  the sender always knows it, and advisory, since only the store knows
  what it will do. A share can wait in a mediator's queue for weeks; the
  receiver reads `available_until` against now to know whether to fetch
  first and read later, or to expect a partial object. Past the date the
  bytes may still be there — one `GET` says — but nobody promised it.
- **`ciphering`** takes media-sharing/1.0's shape — `algorithm` plus
  `parameters` — and no more of that protocol. `algorithm` is a name
  from the list below; `parameters.key` is the raw key, base64url. The
  key is a fresh random key per package and travels only in this
  authcrypted message: encrypting to the receiver is what the envelope
  already does. One ciphertext, one key, any number of recipients each
  told in their own message; a recipient may pass a package on by
  passing the URL, key and `available_until` on, under the object's
  card, without a second upload — for as long as the original hold
  lasts. Renewing it is the original sender's (`blob-store/1.0` renews
  by re-`put` under a mediation the forwarder does not have), so to
  offer the bytes past that date a forwarder puts them in its own store
  and names that package instead.

  Algorithms:

  - **`AES256_GCM_HKDF_1MB`** — Tink's streaming AEAD of that name
    (`AesGcmHkdfStreaming`: 32-byte key, HKDF-SHA256, 32-byte derived
    key, ciphertext segments of 1 MiB, empty associated data), wire
    format as Tink specifies: a header (length byte, salt, 7-byte nonce
    prefix) then segments each AES-GCM under a nonce of prefix, segment
    number, and last-segment flag. Every segment authenticates on its
    own, in order, and a truncated stream is detected by the last-segment
    flag. This is the only algorithm in 1.0.

    In 1.0 a receiver fetches the whole ciphertext, checks its length
    (`byte_count`) and hash, then opens it: nothing is decrypted, and no
    block is kept, before the bytes are known to be the package. The
    segment format is chosen so that a later version can resume an
    interrupted download by HTTP `Range` on segment boundaries and check
    each segment as it lands — but that is a format's permission, not a
    protocol's provision: what state a resuming receiver keeps, how a
    `206` is checked, and that `data.hash` is still over the whole are
    not specified here, and a 1.0 receiver that starts over is
    conforming.

  Not media-sharing's whole-file `aes-256-cbc` with `iv` and `tag` in the
  message: one tag over a file means the whole file before a byte is
  trusted, and a range cannot be checked at all.

- **The plaintext** is a CARv1 whose `roots` is exactly `[root]` and
  whose blocks the sender **must** make the tree's whole closure — the
  skeleton again, `index.json`, every leaf. The package repeats what the
  message already carries so it is a whole object on its own:
  verifiable by anyone with the URL and key, without the message. The
  receiver checks `roots` first: a CAR rooted anywhere else is not this
  object's package and is discarded whole, like bytes that fail the
  hash. Then it reads block by block: each block's bytes must hash to
  the CID it is filed under, else that block is dropped; blocks outside
  the closure of `root` are dropped; what remains goes to `blobs/`
  put-if-absent (the skeleton is already there), and the share is then
  checked again as in §4. A package that opens but lacks blocks of the
  closure is **not** discarded: what walks is kept and the object is
  partial (§7), as it would be had those bytes never been offered —
  whole is the sender's duty, salvage is the receiver's, and throwing
  good leaves away over missing ones serves nobody. The package
  attachment's `media_type` must be `application/vnd.ipld.car`;
  another is a package named but unusable. A package neither replaces nor loosens
  the minimal share: **the skeleton and `index.json` are always inline**
  (§2). A share whose package is unreachable, or whose bytes fail the
  hash, is still a verified skeleton-only share — partial, as in §7.
- **Fetching** is the receiver's, at any time it likes, though the
  bytes are promised only until `available_until`: `GET` the URL, check
  the length, verify the hash, decrypt, import. The bytes may be gone
  (the store's retention ran out, §8.1) — that is a partial object, not
  an error in the share. The
  receiver keeps nothing of the package itself once imported: the blocks
  are in `blobs/` by CID and the package was transport.
- **Sending** (§3 step 2): when the closure does not fit inline, CAR the
  closure, encrypt under a fresh key, put the ciphertext in a blob store
  (§8.1), and send the skeleton and `index.json` inline with the package
  named. Sharing the same object with several contacts reuses one
  ciphertext and one key.

### 8.1 Where the bytes live

The URL is any HTTP location serving the ciphertext bytes with `GET`
and `Range`. The sender's own mediator is the natural one: the
`blob-store/1.0` protocol (`docs/blob-store.md`) lets an agent that
holds a mediation with it put a ciphertext there under a retention and
get back the URL. The store holds bytes it cannot read, named by their
hash, for a while; it is the envelope queue's big sibling and the same
posture — encrypted, unlisted, expiring — not a content host.

Nothing in the share depends on which store: the receiver has a URL, a
hash, and a key.
