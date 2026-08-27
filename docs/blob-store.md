# blob-store/1.0

Status: specified 2026-08-26; store side implemented in `didcomm-mediator`
the same day (upload URL = `PUT /b/<hash>?token=…` through the mediator,
not a presigned object-store URL); client side (`put` → upload → the
package named in an object-share) in `@estoc/agent-core` 0.16.0.
Design history: `research/notes/2026-08-26-want-and-blob-road.md`.

## 1. What it is for

Putting a **blob** — bytes the store cannot read, named by their hash —
somewhere a contact can `GET` it later, so that what does not fit in a
DIDComm message (an `object-share/1.0` package, `docs/object-share.md`
§8) can still travel while neither side needs the other awake. The store
is the mediator: an agent that holds a mediation with it may put blobs;
anyone with the URL may get them. The bytes are ciphertext under a key
the store never sees; the store holds them for a while, unlisted, and
forgets them. It is the envelope queue's big sibling, under the same
posture: encrypted, per-mediation, expiring, not a content host.

The protocol is between an agent and its own mediator, on the channel
they already have. It says three things: *keep this*, *here it is*,
*drop it*. The bytes themselves go over HTTP, not DIDComm.

## 2. Messages

### 2.1 `put`

```json
{
  "type": "https://estoc.dev/blob-store/1.0/put",
  "id": "<uuid>",
  "body": { "hash": "bciqk…", "size": 734003200 }
}
```

- **`body.hash`** — the blob's name: a multihash (sha2-256) of the bytes,
  multibase base32 lower (`b…`) — the same string an object-share
  package uses as `data.hash` and attachment `id`. Required.
- **`body.size`** — the byte length. Required. The store decides on it
  before a byte moves.

Sent to the mediator's DID, as any mediation message. The sender must
hold a mediation with the store; a `put` from anyone else is refused.

Putting a hash the store already holds is a **renewal**: no upload is
needed, the retention is extended, and the result says so. A blob is
one object however many mediations put it; it is retained until the
latest retention any of them holds, and counted against each of their
quotas while they hold it.

### 2.2 `put-result`

```json
{
  "type": "https://estoc.dev/blob-store/1.0/put-result",
  "id": "<uuid>",
  "thid": "<id of the put>",
  "body": {
    "hash": "bciqk…",
    "url": "https://mediator.estoc.dev/b/bciqk…",
    "retain_until": "2026-09-25T12:00:00Z",
    "upload": { "url": "https://…", "expires": "2026-08-26T13:00:00Z" }
  }
}
```

- **`body.url`** — where the blob is, or will be once uploaded: the
  string to put in a share's `data.links`. Serves `GET` and `HEAD` with
  `Range`, to anyone, with no listing anywhere. Stable for the blob's
  life.
- **`body.retain_until`** — required, an RFC 3339 instant: the store
  keeps the blob at least until then. Chosen by the store (a configured
  period from now, `MEDIATOR_BLOB_RETAIN_SECONDS`, default 30 days);
  renewed by putting again. The store never promises forever: an agent
  that wants a blob kept keeps putting.
- **`body.upload`** — present when the store does not have the bytes
  yet: a URL to `PUT` them to, and when that grant expires. The upload
  is a plain HTTP `PUT` of exactly `size` bytes; the store accepts it
  only if the bytes are `size` long and hash to `hash`, and otherwise
  keeps nothing — `url` then serves 404 until a put succeeds. A
  presigned object-store URL is the expected form, binding length and
  checksum, so the store's own process handles no bytes. Absent, the
  store already holds the blob (a renewal) and `url` serves now.

A `put` that is refused is answered with a `problem-report` in the same
thread, `code`:

- `e.p.blob.too-large` — `size` is over the store's per-blob limit
  (`MEDIATOR_BLOB_MAX_BYTES`);
- `e.p.blob.quota` — it would take the mediation over its quota
  (`MEDIATOR_BLOB_QUOTA_BYTES`), counting the blobs it holds now;
- `e.p.blob.refused` — no mediation, or the store does not do blobs.

The limits are also advertised in the mediator's `GET /` alongside its
message size limit, for an agent that would rather know before asking.

### 2.3 `delete`

```json
{
  "type": "https://estoc.dev/blob-store/1.0/delete",
  "id": "<uuid>",
  "body": { "hash": "bciqk…" }
}
```

Releases this mediation's hold on the blob. The store frees the quota
at once; the bytes go when no mediation holds them any more — another
mediation's put is its own hold. Answered with:

### 2.4 `delete-result`

```json
{
  "type": "https://estoc.dev/blob-store/1.0/delete-result",
  "id": "<uuid>",
  "thid": "<id of the delete>",
  "body": { "hash": "bciqk…" }
}
```

Deleting a hash this mediation does not hold is not an error: the
result is the same, nothing held.

## 3. The store

- **Named by hash, verified on the way in.** A blob is written only
  when the bytes match the name; from then on the name is proof enough
  and `GET` serves them as they are. The store never sees inside: to it
  a blob is `size` bytes with a hash, and what an object-share receiver
  does with them is between the two agents.
- **Unlisted.** There is no index of blobs, per mediation or at all,
  and no way to ask the store what it holds beyond putting a hash one
  already knows. A URL is learned from the agent that put the blob, in
  a message only its recipient can read.
- **Expiring.** A blob past every retention is gone; the store may
  also drop early under `e.p.blob.refused` conditions it did not
  foresee, which is why an object-share receiver treats a dead link as
  a partial object, not a broken share, and waits for a later share.
- **Per-mediation accounting.** Every hold is a (mediation, hash) pair
  with a `retain_until`; quota is the sum of sizes of a mediation's
  live holds; ending a mediation ends its holds.
- **Not a relay.** The store serves what it was given, to whoever has
  the URL, for as long as it said. It resolves no DIDs, renders nothing,
  redirects nowhere, and does not know that a blob is a package of an
  object, let alone whose.

## 4. What is not here

- Who may *read* a blob: anyone with the URL. The bytes are ciphertext
  and the key went in a DIDComm message; access control is the key,
  and the store does not do identity for readers.
- Blobs in the clear. The protocol carries no media type and defines
  no use of an unencrypted blob; a store that wished to forbid them
  could not tell, and does not try.
- Content-derived keys or cross-sender deduplication of plaintext:
  a hash of ciphertext under a fresh key names one package, and two
  senders of one object make two blobs. That is the price of the store
  not knowing what it holds.
