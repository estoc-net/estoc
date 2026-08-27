# blob-store/1.0

Status: implemented — store side in `didcomm-mediator` (`put`/`delete`
handlers, bytes at `/b/<id>`), client side in `@estoc/agent-core` 0.16.0
(`put`, upload, then the package named in an `object-share/1.0` share),
2026-08-26; blobs made one mediation's own, served under a random id,
2026-08-27.
Design history: `research/notes/2026-08-26-want-and-blob-road.md`.

## 1. What it is for

Putting a **blob** — bytes the store cannot read — where a contact can
`GET` it later, so that what does not fit in a DIDComm message (an
`object-share/1.0` package, `docs/object-share.md` §8) still travels
while neither side needs the other awake. The store is the mediator: an
agent holding a mediation with it may put blobs; anyone with the URL may
get them. The bytes are ciphertext under a key the store never sees; it
holds them for a while, unlisted, and forgets them — the envelope queue's
big sibling, under the same posture: encrypted, per-mediation, expiring,
not a content host.

A blob is **one mediation's**: put by it, uploaded by it, served at a
URL of its own, gone when it deletes it or the retention runs out.
Nothing is shared between mediations — not bytes, not names — so every
URL has exactly one answer for who put it, and a `delete` is final. The
store is a temporary way of moving bytes, not a place they live.

The protocol runs between an agent and its own mediator, on the channel
they already have, and says three things: *keep this*, *here it is*,
*drop it*. The bytes go over HTTP, not DIDComm.

## 2. Messages

All are sent to the mediator's DID as mediation messages and, like
mediation and pickup, stay out of the message log. The sender must hold
a mediation with the store; from anyone else, `put` and `delete` are
refused.

### 2.1 `put`

```json
{
  "type": "https://estoc.dev/blob-store/1.0/put",
  "id": "<uuid>",
  "body": { "hash": "bciqk…", "size": 734003200 }
}
```

- **`body.hash`** — a sha2-256 multihash of the bytes, multibase base32
  lower (`b…`) — the string an object-share package carries as
  `data.hash`. The store checks the upload against it, and it is the
  name this mediation refers to the blob by from then on. Required.
- **`body.size`** — the byte length. Required: the store decides on it
  before a byte moves.

Putting a hash this mediation already has a blob for is a **renewal**:
same URL, retention extended, and no `upload` unless the bytes never
arrived. Another mediation putting the same hash makes another blob —
its own URL, its own upload, its own retention and quota.

### 2.2 `put-result`

```json
{
  "type": "https://estoc.dev/blob-store/1.0/put-result",
  "id": "<uuid>",
  "thid": "<id of the put>",
  "body": {
    "hash": "bciqk…",
    "url": "https://mediator.estoc.dev/b/m3q7xk…",
    "retain_until": "2026-09-25T12:00:00Z",
    "upload": { "url": "https://…", "expires": "2026-08-26T13:00:00Z" }
  }
}
```

- **`body.url`** — where the blob is, or will be once uploaded: the
  string for a share's `data.links`. Its last segment is a random id the
  store minted for this blob — not the hash, not the mediation: the URL
  says nothing about what it serves or who put it, and is unguessable.
  Serves `GET` and `HEAD`, with `Range`, to anyone; stable for the
  blob's life.
- **`body.retain_until`** — RFC 3339: the store will not choose to
  expire the blob before then (§3, *Expiring*). Chosen by the store — a
  configured period from now (`MEDIATOR_BLOB_RETAIN_SECONDS`, default
  30 days) — and never forever: an agent that wants a blob kept keeps
  putting.
- **`body.upload`** — present when the store lacks the bytes: a URL to
  `PUT` them to, and when that grant expires. The upload is one plain
  HTTP `PUT` of exactly `size` bytes; the store keeps them only if they
  are `size` long and hash to `hash`, and otherwise nothing — `url`
  serves 404 until an upload succeeds. Where the upload URL points is the
  store's business (this mediator: its own `PUT /b/<id>?token=…`, a
  one-time token good for an hour; a presigned object-store URL would do
  as well); the agent `PUT`s and expects 2xx. Absent, the store already
  holds the bytes and `url` serves now.

A refused `put` is answered with a `problem-report` in the same thread,
`code`:

- `e.p.blob.too-large` — `size` is over the store's per-blob limit
  (`MEDIATOR_BLOB_MAX_BYTES`, default 100 MiB);
- `e.p.blob.quota` — it would take the mediation over its quota
  (`MEDIATOR_BLOB_QUOTA_BYTES`, default 1 GiB), counting the blobs it
  holds now;
- `e.p.blob.refused` — no mediation, a store that keeps no blobs, or a
  `put` the store cannot act on (`hash` not a blob name, `size` not a
  byte count or not the held blob's size).

The limits are also in the mediator's `GET /`, beside its message size
limit, for an agent that would rather know before asking.

### 2.3 `delete`

```json
{
  "type": "https://estoc.dev/blob-store/1.0/delete",
  "id": "<uuid>",
  "body": { "hash": "bciqk…" }
}
```

Deletes this mediation's blob for the hash: the URL serves 404 from
then on, the quota is freed, the bytes go. Deleting a hash this
mediation has no blob for is not an error: the result is the same,
nothing there. A `hash` that is not a blob name is `e.p.blob.refused`.

### 2.4 `delete-result`

```json
{
  "type": "https://estoc.dev/blob-store/1.0/delete-result",
  "id": "<uuid>",
  "thid": "<id of the delete>",
  "body": { "hash": "bciqk…" }
}
```

## 3. The store

- **One owner.** A blob is (mediation, hash): one row, one upload, one
  URL, one `retain_until`. Two mediations putting the same bytes are two
  blobs the store does not know to be alike; deleting one touches
  nothing of the other. Ending a mediation ends its blobs.
- **Verified on the way in, located by id.** A blob is written only when
  the bytes match the hash; from then on `GET` serves them as they are,
  at an id chosen at random when the row was made. The store never sees
  inside: to it a blob is `size` bytes with a hash, and what an
  object-share receiver does with them is between the two agents.
- **Unlisted.** There is no index of blobs, per mediation or at all, and
  no way to ask the store what it holds beyond putting a hash one already
  knows. A URL is learned from the agent that put the blob, in a message
  only its recipient can read.
- **Expiring.** A blob past its retention is gone. Before that the store
  does not choose to drop it, but may lose it — a disk, a move, a policy
  it did not foresee: a store is a mediator, not an archive, and
  `retain_until` is intent, not guarantee. An object-share receiver
  treats a dead link as a partial object, not a broken share.
- **Per-mediation accounting.** Quota is the sum of sizes of a
  mediation's live blobs, uploaded or not.
- **Not a relay.** The store serves what it was given, to whoever has
  the URL, for as long as it said. It resolves no DIDs, renders nothing,
  redirects nowhere, and does not know that a blob is a package of an
  object, let alone whose.

## 4. What is not here

- Who may *read* a blob: anyone with the URL. The bytes are ciphertext
  and the key went by DIDComm; the key is the access control, and the
  store does no identity for readers.
- Blobs in the clear. The protocol carries no media type and defines no
  use of an unencrypted blob; a store that wished to forbid them could
  not tell.
- Deduplication of any kind. A hash of ciphertext under a fresh key
  names one package, so two senders of one object make two blobs; and
  the store keeps even identical bytes apart when two mediations put
  them, so that each one's `delete` means what it says. That is the
  price of the store not knowing what it holds, and of every URL having
  one owner.
