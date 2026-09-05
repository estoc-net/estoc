# vault-sync/1.0

Status: **draft** — encrypted synchronization of an Estoc vault through an
untrusted sync store using immutable objects between explicit account resets.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

## 1. What it is for

Full Estoc replicas write while disconnected and later converge by set
union. The sync store is an anti-entropy meeting point and encrypted backup mirror: it
keeps opaque immutable objects, tells clients which opaque object IDs
exist, and serves their ciphertext. It never receives vault event JSON,
blob CIDs, message bodies, event types or contact data in plaintext.

The protocol synchronizes:

- the immutable vault configuration needed for bootstrap;
- vault events, including rendezvous, relationship, route and any selected
  optional `did:web` publication state;
- extension-store events; and
- content-addressed blob blocks referenced by those events, including exact
  prepared DID document revisions.

It does not synchronize `local/`, sockets, pickup acknowledgments,
process locks, fold caches, traces, local options or other local
state. Correctness-critical state must be an event or referenced blob,
not an unsynchronized local file.

Within one `store_id`, version 1.0 is append-only. It has no selective
per-object retraction, compaction or distributed garbage collection. A
portable `message.erased` event synchronizes like any other event and changes
what conforming clients expose, but it does not remove older ciphertext from
the sync store. Section 12 defines the only version-1.0 physical purge: an
authenticated reset of the entire remote account object set.

## 2. Roles and dependencies

- **Sync client** — an unlocked full replica. It may run in a local
  application or on a server holding the same vault seed.
- **Sync store** — an untrusted server that authenticates one shared vault
  account, stores immutable ciphertext and provides inventory.

A remote thin client that does not hold the seed is not a sync client. The
sync protocol does not establish a preferred or authoritative host and does
not reveal which replica publishes a public DID document.

Control messages are DIDComm Messaging 2.1 messages in the family:

```text
https://estoc.dev/vault-sync/1.0
```

They MUST be authcrypted from the vault's sync account DID to the sync
store DID. Object bytes move over single-use HTTP URLs carried inside
those authcrypted control messages. Those URLs MUST use HTTPS, except
that an implementation MAY allow HTTP for an explicitly configured
loopback development endpoint.

A deployment MAY serve sync and mediation from the same process and DID,
but mailbox and sync data MUST use separate storage tables, quotas,
retention rules, key derivation domains and APIs.

## 3. Shared account and keys

Every full replica derives the same sync account and object keys from the
vault seed. There is exactly one `@estoc/keystore` v3 asymmetric key name:

```text
sync/account
```

`sync/account` is represented as the DIDComm-capable `did:key` produced by
the normal keystore-v3 named-key derivation. Its authenticated sender DID
names the server-side sync account. Control of this key authenticates a
caller, but does not by itself grant service admission.

`K_index` and `K_data` are not keystore key names and MUST NOT be obtained by
calling the named asymmetric-key derivation with `sync/index` or `sync/data`.
They are the following two 32-byte symmetric keys, derived only by the
explicit HKDF-SHA-256 profile below:

```text
K_index = HKDF-SHA-256(
  IKM = vault seed,
  salt = SHA-256("estoc/vault-sync/1.0"),
  info = "index",
  L = 32
)

K_data = HKDF-SHA-256(
  IKM = vault seed,
  salt = SHA-256("estoc/vault-sync/1.0"),
  info = "data",
  L = 32
)
```

The literal UTF-8 strings and no terminating NUL are used in the HKDF
inputs above.

The sync protocol has no replica registry and carries no replica ID.
Possession of the shared sync-account key authorizes the account. Each
client keeps its own cursors and diagnostics locally; the sync store does
not need to know which writable incarnation issued a request.

## 4. Sync objects

A server stores only:

```text
opaque object ID
ciphertext byte length
ciphertext sha2-256 multihash
opaque ciphertext bytes
account-local insertion sequence
server timestamps
```

It MUST NOT be told the object kind, event ID, extension ID or CID.

### 4.1 Plaintext frame

Before encryption, every object is one binary frame:

```text
offset  length  value
0       8       ASCII "ESTOCS1\n"
8       4       unsigned big-endian header length N
12      N       UTF-8 RFC 8785 canonical JSON header
12+N    rest    payload bytes
```

Unknown header fields are rejected in version 1.0.

#### Root object

Header:

```json
{ "kind": "root", "version": 1 }
```

Payload: RFC 8785 canonical UTF-8 of the immutable vault configuration:

```json
{
  "format": "estoc",
  "version": 3,
  "identity": {
    "anchor": {
      "key": "anchor",
      "did": "did:key:z6Mk..."
    }
  }
}
```

The root object allows a replica holding the seed and sync-store locator
to reconstruct `config.json`. It does not contain `seedJwe`; a new local vault copy wraps the supplied seed under its own local passphrase and derives requested named keys on demand from fixed protocol names and
portable events.

#### Event object

Header:

```json
{
  "kind": "event",
  "store": "vault",
  "eid": "019b1b61-1ff1-74d7-a3d6-c493db8e5032",
  "sha256": "k3sU...base64url..."
}
```

`store` is either `vault` or `extension:<uuidv7>`. Payload is the exact
RFC 8785 canonical UTF-8 event JSON. `sha256` is the unpadded base64url
SHA-256 of that payload.

The client MUST validate the event envelope, require its `eid` to equal
the header, and require the payload hash to match before ingest.

#### Block object

Header:

```json
{
  "kind": "block",
  "cid": "bafkrei..."
}
```

Payload is the raw block bytes. The client MUST verify the bytes against
the CID before storing them. Blocks are account-wide and MAY satisfy
references from the vault or any extension store.

### 4.2 Object IDs

Object IDs are unpadded base64url encodings of 32-byte HMAC-SHA-256
values:

```text
root:
  HMAC(K_index, UTF8("root\0"))

event:
  HMAC(K_index,
       UTF8("event\0" + store + "\0" + eid + "\0") || SHA256(payload))

block:
  HMAC(K_index, UTF8("block\0" + cid))
```

The `\0` values are one zero byte. `store`, `eid` and `cid` are encoded
as UTF-8 exactly as serialized in the header.

Including the event payload hash permits two corrupt contents under one
`eid` to coexist as different opaque server objects so that clients can
detect the event-store conflict rather than have the server choose one.
A block's CID already commits to its payload.

The server treats object IDs as opaque strings and MUST enforce the
canonical unpadded base64url form.

### 4.3 Encryption

Each plaintext frame is encrypted independently with AES-256-GCM under
`K_data`:

```text
version byte     0x01
nonce            12 random bytes
ciphertext+tag   AES-256-GCM output, 16-byte tag
```

Associated data is:

```text
UTF8("estoc/vault-sync/1.0\0") || raw_32_byte_object_id
```

The nonce MUST be generated from a cryptographically secure random
source and MUST NOT be reused with `K_data`. The ciphertext multihash
used by the server is sha2-256 over the entire version-byte, nonce and
ciphertext/tag sequence.

After download, a client MUST verify the announced ciphertext hash,
decrypt with the object ID as associated data, parse the frame, validate
its semantic contents, and recompute its object ID before accepting it.

## 5. Server storage semantics

Objects are immutable and put-if-absent.

- The first complete valid upload for an absent object ID creates it and
  assigns the next account-local sequence.
- An existing object ID is never overwritten, renewed or assigned a new
  sequence.
- A later client may have independently encrypted the same plaintext and
  therefore possess different ciphertext bytes. The existing server
  object wins; the client verifies it by downloading and opening it when
  needed.
- An incomplete or hash-mismatched upload creates no object.
- Sequence values are unsigned decimal strings in JSON to avoid integer
  precision loss. They increase monotonically per account and are never
  reused.

The store MUST make a committed object visible atomically to `changes`,
`inventory` and `want`.

## 6. `hello`

Message type:

```text
https://estoc.dev/vault-sync/1.0/hello
```

```json
{
  "id": "019b1b70-d29e-7a6f-b0a2-734173aa706a",
  "type": "https://estoc.dev/vault-sync/1.0/hello",
  "from": "did:key:z6LS...sync-account",
  "to": ["did:web:sync.example"],
  "body": {}
}
```

The request creates no vault object. For an already admitted account, an
empty body is sufficient. For an absent account, the request MUST satisfy
section 6.1 before the server may create any account row.

### 6.1 Admission and lazy account creation

Successful DIDComm authcrypt proves control of the sync-account key; it does
not prove entitlement to consume storage. A sync store MUST NOT implement open
registration by creating an account solely because a syntactically valid
`hello` arrives from a new DID.

For an absent account, a deployment MUST use at least one of these admission
methods and MUST document or advertise the methods it accepts:

- **provisioned** — the exact sync-account DID was provisioned out of band;
- **capability** — `hello.body.admission` carries an opaque, single-use,
  account-bound capability issued by the sync-store operator; or
- **mediation-grant** — a co-operated sync store accepts an active mediation
  grant plus proof that the grant's mediation account authorizes this sync
  account.

A capability form is:

```json
{
  "admission": {
    "method": "capability",
    "token": "g3Q...opaque-single-use-capability"
  }
}
```

The token format and issuance ceremony are deployment-specific, but the
server MUST bind it to the authenticated sync-account DID and its own service
DID, enforce an expiry and single use, and never log the token.

A mediation-grant form is:

```json
{
  "admission": {
    "method": "mediation-grant",
    "mediation_account": "did:peer:4zQm...mediation-account",
    "grant_id": "019b1b6f-36c5-7f27-95ea-f94042e88298",
    "proof": "eyJhbGciOiJFZERTQSIsImtpZCI6Ii4uLiJ9.eyJzeW5jX2FjY291bnQiOiIuLi4ifQ.signature"
  }
}
```

The compact JWS protected header is exactly:

```json
{
  "alg": "EdDSA",
  "kid": "<mediation-account authentication method>",
  "typ": "estoc/vault-sync-admission+jws"
}
```

and its RFC 8785 canonical payload is exactly:

```json
{
  "aud": "did:web:sync.example",
  "expires_time": 1788443400,
  "grant_id": "019b1b6f-36c5-7f27-95ea-f94042e88298",
  "mediation_account": "did:peer:4zQm...mediation-account",
  "request_id": "019b1b70-d29e-7a6f-b0a2-734173aa706a",
  "sync_account": "did:key:z6LS...sync-account"
}
```

The server verifies the signature, exact request and account bindings, a
currently active local mediation grant, and an expiry no more than five
minutes in the future. The admission proof does not make the mediation
account a sync encryption key.

Account creation, quota reservation and single-use capability consumption
MUST be one transaction. Failure creates no empty account. An existing,
non-disabled account does not need to resupply admission on later `hello`
requests.

## 7. `hello-result`

Message type:

```text
https://estoc.dev/vault-sync/1.0/hello-result
```

```json
{
  "id": "019b1b71-2728-7f7f-8399-462768242e0e",
  "thid": "019b1b70-d29e-7a6f-b0a2-734173aa706a",
  "type": "https://estoc.dev/vault-sync/1.0/hello-result",
  "body": {
    "store_id": "019b1b70-f42e-7d19-87a0-16a165264762",
    "state": "ready",
    "sequence": "1842",
    "limits": {
      "max_object_bytes": 16777216,
      "max_offer_objects": 256,
      "max_want_objects": 256,
      "max_page_objects": 512,
      "max_account_bytes": 10737418240,
      "upload_ttl_seconds": 900,
      "download_ttl_seconds": 900
    }
  }
}
```

`store_id` is a stable random UUID identifying this account's current
server-side object set. `state` is `ready` or `rebuilding`. Normal offer,
changes, inventory and want operations require `ready`. A destructive reset
MUST produce a new `store_id` and enters `rebuilding` until section 12's
baseline is committed. A client whose cached `store_id` differs MUST discard
its remote sequence cursor and execute the pull-before-push reset recovery
algorithm in section 13.

## 8. Offering and uploading objects

### 8.1 `offer`

Message type:

```text
https://estoc.dev/vault-sync/1.0/offer
```

```json
{
  "id": "019b1b72-f8f9-7b1d-b2a6-9a71344fba15",
  "type": "https://estoc.dev/vault-sync/1.0/offer",
  "body": {
    "objects": [
      {
        "id": "bXkvh0Q0lE5VZmqPlYI2dlIgweaUa3YMVNXFEDEw1aM",
        "hash": "bciq...ciphertext-multihash",
        "byte_count": 948
      }
    ]
  },
  "return_route": "all"
}
```

The list MUST contain no duplicate object ID and MUST not exceed the
advertised limit. `hash` is a sha2-256 multihash in multibase base32
lower. `byte_count` counts encrypted bytes, including the version byte,
nonce and tag.

During normal `ready` operation, no extra field is present. While the account
is `rebuilding`, only the reset owner may offer objects, and the body MUST also
contain:

```json
{
  "rebuild": {
    "reset_id": "019b1b7d-2bb6-76b5-ac2e-ac91ffb597ae",
    "token": "k3Q...opaque-rebuild-capability"
  }
}
```

The capability is bound to the authenticated account, current `store_id` and
`reset_id`. It MUST NOT be logged, accepted after commit/supersession, or used
for another account. All ordinary clients receive `store-rebuilding` instead
of upload tickets while this state is active.

### 8.2 `offer-result`

Message type:

```text
https://estoc.dev/vault-sync/1.0/offer-result
```

```json
{
  "id": "019b1b73-16f5-7ab1-bde1-865ffad3a51c",
  "thid": "019b1b72-f8f9-7b1d-b2a6-9a71344fba15",
  "type": "https://estoc.dev/vault-sync/1.0/offer-result",
  "body": {
    "existing": [
      {
        "id": "QhE...",
        "hash": "bciq...stored-ciphertext-hash",
        "byte_count": 811,
        "sequence": "1837"
      }
    ],
    "uploads": [
      {
        "id": "bXkvh0Q0lE5VZmqPlYI2dlIgweaUa3YMVNXFEDEw1aM",
        "put": "https://sync.example/sync-upload/random-token",
        "expires_time": 1788444300
      }
    ],
    "rejected": []
  }
}
```

Each offered ID appears exactly once in `existing`, `uploads` or
`rejected`.

An `existing` descriptor reports the server's stored ciphertext, which
may differ from the offering client's independently generated
ciphertext. The client MUST NOT attempt to overwrite it. Before treating
the object as a verified remote backup, the client MUST have previously
verified that exact stored ciphertext hash or MUST fetch, decrypt and
recompute the object ID. The same rule applies after an HTTP 204 upload
race when the winning stored hash differs from the offered hash.

An upload URL is single-use, unguessable, time-limited and bound to the
authenticated account, object ID, offered hash and byte count. The client
performs an HTTP `PUT` of exactly the ciphertext bytes:

- no request compression;
- exact `Content-Length`;
- no redirect following;
- `Content-Type: application/octet-stream`.

The server streams through the advertised byte limit and sha2-256 hash.
Only a complete match is committed. Successful first creation returns
HTTP 201. If another upload committed the same object ID first, the
server returns HTTP 204 and leaves the existing object unchanged.

Upload transport status is not itself a sync cursor. A client confirms
visibility with `changes`, `inventory`, `want`, or a later `offer`.

## 9. Incremental changes

### 9.1 `changes`

Message type:

```text
https://estoc.dev/vault-sync/1.0/changes
```

```json
{
  "id": "019b1b76-6518-7c78-a88a-ea26891ff8ed",
  "type": "https://estoc.dev/vault-sync/1.0/changes",
  "body": {
    "store_id": "019b1b70-f42e-7d19-87a0-16a165264762",
    "after": "1800",
    "limit": 256
  },
  "return_route": "all"
}
```

`after` is exclusive. A new client uses `"0"`. The server rejects a
mismatching `store_id` so the client cannot silently apply a cursor from
a reset store.

### 9.2 `changes-result`

Message type:

```text
https://estoc.dev/vault-sync/1.0/changes-result
```

```json
{
  "id": "019b1b76-7aef-7ea5-9645-08f9792b7fb6",
  "thid": "019b1b76-6518-7c78-a88a-ea26891ff8ed",
  "type": "https://estoc.dev/vault-sync/1.0/changes-result",
  "body": {
    "store_id": "019b1b70-f42e-7d19-87a0-16a165264762",
    "through": "1842",
    "more": false,
    "objects": [
      {
        "sequence": "1801",
        "id": "QhE...",
        "hash": "bciq...",
        "byte_count": 811
      }
    ]
  }
}
```

Objects are ordered by numeric sequence. `through` is the greatest
sequence examined in this page and equals `after` when no later object
exists. A client advances its local cursor only after every returned
descriptor through that value is either fully applied or durably written
to a local pending-download set. Losing an in-memory download queue MUST
not make advancing the cursor lose an object. A client MAY refetch an
object; object acceptance is idempotent.

`changes` is an optimization, not the sole correctness mechanism. A
client MUST also implement full inventory.

## 10. Full inventory

### 10.1 `inventory`

Message type:

```text
https://estoc.dev/vault-sync/1.0/inventory
```

```json
{
  "id": "019b1b78-6751-7a5c-a998-f6a60f352f1c",
  "type": "https://estoc.dev/vault-sync/1.0/inventory",
  "body": {
    "store_id": "019b1b70-f42e-7d19-87a0-16a165264762",
    "through": null,
    "after_id": null,
    "limit": 512
  },
  "return_route": "all"
}
```

`store_id` is REQUIRED and is obtained from `hello-result`. `after_id`
is exclusive and is `null` for the first page. `through` is `null` on the
first page and MUST equal the snapshot sequence returned by that page on
every continuation request.

### 10.2 `inventory-result`

Message type:

```text
https://estoc.dev/vault-sync/1.0/inventory-result
```

```json
{
  "id": "019b1b78-85e5-7ec8-85c8-b44cd169ee83",
  "thid": "019b1b78-6751-7a5c-a998-f6a60f352f1c",
  "type": "https://estoc.dev/vault-sync/1.0/inventory-result",
  "body": {
    "store_id": "019b1b70-f42e-7d19-87a0-16a165264762",
    "through": "1842",
    "complete": false,
    "next_after_id": "QhE...",
    "objects": [
      {
        "id": "A0F...",
        "hash": "bciq...",
        "byte_count": 1220,
        "sequence": "1811"
      }
    ]
  }
}
```

On the first page, the server captures the account's current sequence as
`through`. Every page in that inventory snapshot contains only objects
whose insertion sequence is less than or equal to `through`. The server
MUST reject a continuation whose `store_id` or `through` differs from the
first page.

Pages are ordered by Unicode code-point order of canonical object IDs.
`next_after_id` is the last returned ID when `complete` is false and is
`null` when complete. This fixed snapshot prevents a concurrently inserted
object whose ID sorts before the current page from being skipped. Objects
inserted after `through` are obtained later through `changes` or another
inventory.

After the complete snapshot is durably applied or represented in a local
pending-download set, the client MAY set its incremental remote cursor to
`through`.

A client MUST run full inventory when:

- it has no cursor;
- `store_id` changed;
- the server rejects or cannot satisfy its cursor;
- local sync metadata was lost; or
- the user requests verification.

A periodic full inventory is RECOMMENDED to detect local bookkeeping
bugs, but its cadence is an implementation policy.

## 11. Downloading objects

### 11.1 `want`

Message type:

```text
https://estoc.dev/vault-sync/1.0/want
```

```json
{
  "id": "019b1b7a-ae56-7d5a-8e3d-d26ec7a145cb",
  "type": "https://estoc.dev/vault-sync/1.0/want",
  "body": {
    "ids": ["A0F...", "QhE..."]
  },
  "return_route": "all"
}
```

The list has no duplicates and does not exceed the advertised limit.

### 11.2 `objects`

Message type:

```text
https://estoc.dev/vault-sync/1.0/objects
```

```json
{
  "id": "019b1b7a-cd2c-7f2a-96b9-fc09645372f9",
  "thid": "019b1b7a-ae56-7d5a-8e3d-d26ec7a145cb",
  "type": "https://estoc.dev/vault-sync/1.0/objects",
  "body": {
    "objects": [
      {
        "id": "A0F...",
        "hash": "bciq...",
        "byte_count": 1220,
        "get": "https://sync.example/sync-object/random-token",
        "expires_time": 1788445200
      }
    ],
    "missing": ["QhE..."]
  }
}
```

A download URL is unguessable, time-limited, account-bound and valid only
for HTTP `GET`. Clients MUST NOT follow redirects. They MUST abandon a
response whose announced or received length exceeds `byte_count`, whose
length ends short, or whose bytes fail `hash`.

The HTTP URL reveals no logical object ID in its path.

## 12. Remote account reset

Version 1.0 deliberately has no selective `retract` message. Logical erasure
is expressed by portable vault events. A physical remote purge is an
all-object reset followed by construction of a new trusted baseline. The
baseline protocol exists to prevent a stale replica from immediately
re-uploading erased content bytes into an empty account.

### 12.1 Preconditions

Before requesting reset, the initiating full replica MUST:

1. fully reconcile the current `ready` store or explicitly obtain user
   confirmation that remote-only objects will be abandoned;
2. ingest all locally available events and run the erasure-closure procedure
   in `vault-events.md`;
3. compute the current held-root set from the converged fold; and
4. be able to supply the immutable root object, every accepted event object
   and every currently held block it intends to preserve.

Reset is not a selective event retraction. Another trusted full replica may
later republish immutable event objects that it still has. It MUST NOT
republish content blocks released by the converged erasure fold.

### 12.2 `reset`

Message type:

```text
https://estoc.dev/vault-sync/1.0/reset
```

```json
{
  "id": "019b1b7d-368c-75b6-8724-1598205178d4",
  "type": "https://estoc.dev/vault-sync/1.0/reset",
  "from": "did:key:z6LS...sync-account",
  "to": ["did:web:sync.example"],
  "body": {
    "store_id": "019b1b70-f42e-7d19-87a0-16a165264762",
    "reset_id": "019b1b7d-2bb6-76b5-ac2e-ac91ffb597ae",
    "confirm": "delete-all-remote-objects"
  }
}
```

The request MUST be authcrypted by the admitted sync account. `store_id` MUST
be current, `reset_id` is a fresh canonical UUIDv7, and `confirm` is the exact
literal above. A stale precondition deletes nothing.

On first acceptance the server atomically:

1. invalidates every object, inventory snapshot and transfer ticket in the old
   object set;
2. creates a fresh `store_id` with sequence zero and state `rebuilding`;
3. records the accepted `reset_id`; and
4. returns a short-lived rebuild capability to the reset owner.

The result is:

```json
{
  "id": "019b1b7d-4cfa-7771-ab86-d9c3fe1c9a04",
  "thid": "019b1b7d-368c-75b6-8724-1598205178d4",
  "type": "https://estoc.dev/vault-sync/1.0/reset-result",
  "body": {
    "reset_id": "019b1b7d-2bb6-76b5-ac2e-ac91ffb597ae",
    "old_store_id": "019b1b70-f42e-7d19-87a0-16a165264762",
    "store_id": "019b1b7d-4bcc-7807-a609-8004542c76a4",
    "state": "rebuilding",
    "sequence": "0",
    "rebuild_token": "k3Q...opaque-rebuild-capability"
  }
}
```

Repeating the same authenticated reset request is idempotent and returns the
same rebuild epoch plus a currently usable capability. A new reset may
supersede an abandoned rebuild only by naming its current rebuilding
`store_id` and a new `reset_id`; that operation invalidates the previous
capability and partial baseline.

### 12.3 Building and committing the baseline

While rebuilding, the reset owner uploads, in this order:

1. the immutable root object;
2. every locally accepted event object, including `message.erased` and any
   newly generated erasure-closure events; and
3. only blob blocks that are roots held by the current post-erasure fold.

It MUST NOT offer a block merely because bytes remain in a local blob store.
The event set is append-only; the held-root fold, not byte presence, determines
whether content is republished.

After all uploads are visible, the owner computes:

```text
baseline_ids = all opaque object IDs in the rebuilding object set,
               sorted by UTF-8 byte order
baseline_hash = base64url(SHA-256(UTF8(RFC8785(baseline_ids))))
```

and sends:

```text
https://estoc.dev/vault-sync/1.0/reset-commit
```

```json
{
  "id": "019b1b7e-ff9f-7d4d-9b3e-5280d9680a7c",
  "type": "https://estoc.dev/vault-sync/1.0/reset-commit",
  "from": "did:key:z6LS...sync-account",
  "to": ["did:web:sync.example"],
  "body": {
    "store_id": "019b1b7d-4bcc-7807-a609-8004542c76a4",
    "reset_id": "019b1b7d-2bb6-76b5-ac2e-ac91ffb597ae",
    "rebuild_token": "k3Q...opaque-rebuild-capability",
    "root_id": "QhE...opaque-root-id",
    "object_count": 1841,
    "baseline_hash": "V0F...base64url-sha256"
  }
}
```

The server verifies the capability, current state, presence of `root_id`,
object count and hash over its exact current set. It then atomically changes
state to `ready` and invalidates the capability. It returns:

```json
{
  "id": "019b1b7f-1815-719e-aabb-69e064bc80f5",
  "thid": "019b1b7e-ff9f-7d4d-9b3e-5280d9680a7c",
  "type": "https://estoc.dev/vault-sync/1.0/reset-committed",
  "body": {
    "store_id": "019b1b7d-4bcc-7807-a609-8004542c76a4",
    "reset_id": "019b1b7d-2bb6-76b5-ac2e-ac91ffb597ae",
    "state": "ready",
    "sequence": "1841",
    "baseline_hash": "V0F...base64url-sha256"
  }
}
```

Until this commit, non-owner clients MUST NOT download a partial baseline or
publish their local set. They receive `store-rebuilding` and retry later.
Services MUST disclose how long invalidated ciphertext may remain in offline
backups or disaster-recovery media.

## 13. Client synchronization algorithm

### 13.1 Publishing local objects

During ordinary `ready` operation a client publishes in this order:

1. ingest and fold all newly learned remote events before offering local
   objects;
2. generate and publish any erasure-closure events required by that union;
3. publish the immutable root object if it is absent;
4. for each new event that currently retains blob blocks, publish those blocks
   first, but only when their CIDs are in the **current held-root set**; and
5. publish the event object after its currently held referenced blocks are
   available remotely.

Blocks-before-event preserves availability for normal messages, while the
held-root test preserves erasure safety. A block not currently held MUST NOT be
offered even when its bytes remain locally available. An event with no held
blocks, including an erasure or closure event, may be offered immediately.

The local event store's `changes()` only discovers what this local store gained
efficiently. A local `ChangeToken` is never sent to the sync store and is
meaningless on another replica.

A client that observes a different `store_id` MUST enter **pull-before-push**:

1. stop all offers and invalidate the old remote cursor;
2. wait while `hello-result.state == "rebuilding"`;
3. when ready, obtain and download a full inventory baseline;
4. decrypt, validate and ingest all root/event objects before offering any
   local object;
5. run erasure closure against the union and recompute held roots;
6. publish newly required closure events first, then missing immutable events,
   then only currently held blocks; and
7. resume incremental changes only after that publication pass.

This ordering prevents a stale replica that missed `message.erased` from
re-uploading released content bytes after reset. It does not make reset a
selective event tombstone: immutable event objects retained by a trusted full
replica may reappear.

### 13.2 Applying remote objects

For every unknown opaque descriptor, a client obtains/verifies ciphertext,
decrypts and validates the frame, and recomputes the object ID. During normal
incremental sync it may then apply blocks and events idempotently subject to
the held-root rules.

For a reset baseline or lost-cursor full reconciliation, the client MUST first
download enough objects to classify them after decryption, then:

1. verify and accept the immutable root;
2. validate and ingest all event objects in their named stores, independently
   of server sequence;
3. fold the complete learned event union and append equivalent erasure-closure
   events for newly discovered roots of already erased logical messages;
4. recompute the held-root set;
5. retain/fetch a block only when its CID is currently held, verify it against
   its CID, and put it idempotently; and
6. advance the remote cursor only after all corresponding durable local writes.

Events may arrive in any order. Server sequence is a delivery cursor, not
vault meaning. An erased block descriptor may be ignored after frame/object-ID
verification; absence of released bytes is not `not fetched`.

An unknown extension store is not opened merely because an opaque object
exists. After decryption, the client applies the vault's extension lifecycle
policy before writing an extension event or held block.

### 13.3 Missing blocks

A client may learn of an event before every referenced block is locally
present because another uploader crashed or account quota prevented a
block. It MUST retain the event ciphertext descriptor and retry missing
object discovery. It MUST distinguish `not fetched` from a logical vault
erasure.

A client MUST NOT fabricate a block object ID from a server descriptor;
it computes the ID from the expected CID under `K_index` and asks for it.

### 13.4 Event conflicts

Two decrypted event objects with the same `eid` and different event
content are an integrity conflict, not an ordinary concurrent decision.
A client MUST surface the conflict and MUST NOT claim full convergence.
It MAY quarantine the incoming object. Automatic first-wins resolution
across replicas is forbidden because arrival order differs.

## 14. Bootstrap and recovery

A new local replica needs:

- the vault seed;
- the sync-store DID/endpoint locator; and
- a local passphrase or platform mechanism under which to wrap the seed.

A normal folder restore obtains candidate locators from `sync.configured`
events after opening the readable snapshot. A bootstrap that starts with
only the seed must obtain the first locator from an external trusted source.

It derives the sync account and object keys, fetches the fixed root object
ID, verifies the immutable configuration, inventories every opaque object,
downloads and validates events and blocks, builds a fresh local core vault,
and finally mints a new local `replica_id` and private `store_generation`.
Unknown portable folder paths that have no versioned sync-object profile are
not reconstructed by this protocol.

Absence of the root object means the server account cannot bootstrap a
vault. An existing local vault may publish it. A root object whose anchor
does not match the anchor derived from the supplied seed is fatal.

A sync store is not the sole sovereign representation. A normal Estoc
folder snapshot remains a complete readable interchange format.

A full replica bootstrapped on a web server has no special sync identity. It
uses the same account and anti-entropy as any other full replica, then may
reconcile a selected `did:web` document if it separately holds publication
authority. Loss of that publisher does not alter synchronized pairwise DID
state.

## 15. Quota and availability

The server MAY cap:

- object size;
- account ciphertext bytes;
- objects per account;
- request batch sizes; and
- upload/download ticket lifetime.

Quota refusal creates no partial object. Because version 1.0 has no
selective remote garbage collection, clients MUST surface approaching quota
and allow the user to export, move to another sync store, or invoke the formal
whole-account reset in section 12 deliberately. A UI MUST describe reset as a
remote-mirror purge, not as selective message erasure.

A local write never waits for sync availability. Sync failures change
replication lag, not local commit success or mailbox pickup.

## 16. Privacy and security

The sync store can observe:

- the sync account DID;
- opaque object IDs;
- ciphertext hashes and sizes;
- object creation and download times;
- account totals; and
- network metadata.

It MUST NOT receive plaintext object kinds, event IDs, CIDs, event types,
message bodies, contacts, key names or extension IDs.

Opaque IDs are deterministic within one vault and therefore reveal
repeat occurrence and object count to that store. They are unlinkable
across vault seeds under the HMAC assumption.

A malicious store may omit, reorder, replay or corrupt ciphertext. AEAD,
content checks, object-ID recomputation, full inventory and event-store
conflict reporting detect corruption and replay but cannot force the
store to remain available.

All full replicas share `K_index`, `K_data` and the sync-account key. A
malicious full replica can read, add or withhold vault data and is outside
version 1.0's threat model.

## 17. Problem reports

Authenticated control errors use Problem Report 2.0:

| code | meaning |
|---|---|
| `e.estoc.vault-sync.invalid-request` | malformed body, ID, hash or limit |
| `e.estoc.vault-sync.admission-required` | absent account needs an accepted admission method |
| `e.estoc.vault-sync.admission-invalid` | admission proof, capability, grant, binding or expiry failed |
| `e.estoc.vault-sync.admission-denied` | operator policy refuses account creation |
| `e.estoc.vault-sync.account-disabled` | admitted account is administratively disabled |
| `e.estoc.vault-sync.store-reset` | supplied `store_id` is no longer current; client must pull before push |
| `e.estoc.vault-sync.store-rebuilding` | a reset baseline is not committed; non-owner operations must wait |
| `e.estoc.vault-sync.reset-not-owner` | rebuild capability is absent, invalid or bound to another reset epoch |
| `e.estoc.vault-sync.reset-baseline` | root, object count or baseline hash does not match the rebuilding set |
| `e.estoc.vault-sync.reset-confirmation` | reset ID, expected store ID or literal confirmation is invalid |
| `e.estoc.vault-sync.object-too-large` | object exceeds the account limit |
| `e.estoc.vault-sync.quota` | account cannot accept another object |
| `e.estoc.vault-sync.upload-expired` | upload ticket is no longer valid |
| `e.estoc.vault-sync.hash-mismatch` | uploaded ciphertext failed hash or length |
| `e.estoc.vault-sync.too-many-objects` | request exceeds a batch limit |
| `e.estoc.vault-sync.unsupported-version` | frame or protocol version unsupported |

HTTP upload and download endpoints return generic transport errors and
MUST NOT disclose another account's object existence.

## 18. Required conformance cases

1. Two replicas independently offer the same logical object with different
   randomized ciphertext; exactly one immutable server object remains and both
   clients can decrypt and verify it.
2. Re-offering an existing ID allocates no overwrite upload; incomplete,
   oversized or hash-mismatched uploads create no object or sequence.
3. `changes` and a fixed-through paged inventory cannot permanently skip a
   committed object.
4. Losing all local cursor state and running inventory discovers the same
   ready object set.
5. Download hash, AEAD tag, frame validation, semantic validation and object-ID
   recomputation all precede local acceptance.
6. Blob bytes are verified against CID before `put`.
7. Concurrent offline event sets converge after exchange; same `eid` with
   different RFC 8785 canonical event bytes is an integrity conflict.
8. A fresh full replica with seed and locator reconstructs root, events and
   held blobs, then mints new local replica/store-generation IDs.
9. No sync message exposes replica ID, event type, CID, contact or application
   plaintext to the server.
10. A previously unseen sync account without accepted admission creates no
    account, object or quota reservation.
11. `sync/account` is the sole named asymmetric key; `K_index` and `K_data`
    match only the explicit HKDF profile.
12. Version 1.0 exposes no selective retract and documents reset as a whole
    remote-mirror purge, not logical message erasure.
13. Reset with stale precondition or malformed confirmation deletes nothing.
14. Successful reset rotates `store_id`, invalidates old objects/tickets and
    enters `rebuilding`; ordinary clients cannot offer, inventory or download a
    partial baseline.
15. Only a valid reset-owner capability may upload during rebuilding.
16. `reset-commit` verifies root presence, exact object count and RFC
    8785-derived baseline hash before atomically entering `ready`.
17. Repeating one accepted `reset_id` is idempotent; a fresh reset against the
    rebuilding store can supersede an abandoned rebuild and invalidates its
    capability.
18. The reset owner publishes every accepted event, including erase/closure
    events, but only blocks in its current held-root set.
19. A stale replica observing changed `store_id` performs full pull-before-push,
    ingests baseline events, applies erasure closure and recomputes held roots
    before offering anything.
20. A stale replica that still physically stores erased bytes does not offer
    those block objects after baseline reconciliation.
21. A late immutable event may reappear after reset, but any newly learned root
    of an already erased logical message receives closure before its content
    block can be offered.
22. Sync unavailability never blocks local event commit, send intent or mailbox
    pickup.
