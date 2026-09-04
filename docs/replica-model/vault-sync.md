# vault-sync/1.0

Status: **draft** — encrypted, append-only synchronization of an Estoc
vault through an untrusted sync store.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

## 1. What it is for

Full Estoc replicas write while disconnected and later converge by set
union. The sync store is a rendezvous and encrypted backup mirror: it
keeps opaque immutable objects, tells clients which opaque object IDs
exist, and serves their ciphertext. It never receives vault event JSON,
blob CIDs, message bodies, event types or contact data in plaintext.

The protocol synchronizes:

- the immutable vault configuration needed for bootstrap;
- vault events;
- extension-store events; and
- content-addressed blob blocks referenced by those events.

It does not synchronize `local/`, sockets, pickup acknowledgments,
process locks, fold caches, traces, local options or other local
state. Correctness-critical state must be an event or referenced blob,
not an unsynchronized local file.

Version 1.0 is append-only. It has no per-object remote deletion,
compaction or distributed garbage collection.

## 2. Roles and dependencies

- **Sync client** — an unlocked full replica.
- **Sync store** — an untrusted server that authenticates one shared
  vault account, stores immutable ciphertext and provides inventory.

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
vault seed. The following reserved names are fixed:

```text
sync/account
sync/index
sync/data
```

`sync/account` is represented as the DIDComm-capable `did:key` used by
Estoc's existing key-derivation implementation. Its authenticated sender
DID names the server-side sync account. The first valid `hello` MAY
create that account lazily.

The client derives 32-byte keys with HKDF-SHA-256:

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
to reconstruct `config.json`. It does not contain `seedJwe`; a new local vault copy wraps the supplied seed under its own local passphrase and
rebuilds the key-name cache from events.

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

The request creates no vault object. It MAY lazily create the empty
server account.

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
server-side object set. A destructive server reset MUST produce a new
`store_id`. A client whose cached `store_id` differs MUST discard its
remote sequence cursor and perform full inventory reconciliation.

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

## 12. Client synchronization algorithm

### 12.1 Publishing local objects

A client SHOULD publish in this order:

1. root object, if absent;
2. blob blocks referenced by a new event;
3. the event object.

The order prevents a well-behaved peer from discovering an event before
its referenced bytes have been offered. It is not a transaction: a crash
may leave harmless unreferenced blocks on the server.

The client uses its local event store's `changes()` only to discover what
this local store gained efficiently. A local `ChangeToken` is never sent
to the sync store and is meaningless on another replica.

### 12.2 Applying remote objects

For every unknown opaque object descriptor, a client:

1. obtains and verifies the ciphertext bytes;
2. decrypts and validates the sync frame;
3. recomputes the opaque object ID;
4. for a block, verifies its CID and puts it idempotently;
5. for an event, first ensures every referenced blob root it intends to
   make complete is available, then ingests the event into its named
   store; and
6. advances its remote sequence cursor only after durable local writes.

Events may be downloaded in any order. The event store's set union, not
server sequence, determines vault meaning. Server sequence is a delivery
cursor only.

An unknown extension store is not opened merely because an opaque object
exists; after decryption, the client applies the vault's extension
lifecycle policy before writing an extension event or block.

### 12.3 Missing blocks

A client may learn of an event before every referenced block is locally
present because another uploader crashed or account quota prevented a
block. It MUST retain the event ciphertext descriptor and retry missing
object discovery. It MUST distinguish `not fetched` from a logical vault
erasure.

A client MUST NOT fabricate a block object ID from a server descriptor;
it computes the ID from the expected CID under `K_index` and asks for it.

### 12.4 Event conflicts

Two decrypted event objects with the same `eid` and different event
content are an integrity conflict, not an ordinary concurrent decision.
A client MUST surface the conflict and MUST NOT claim full convergence.
It MAY quarantine the incoming object. Automatic first-wins resolution
across replicas is forbidden because arrival order differs.

## 13. Bootstrap and recovery

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

## 14. Quota and availability

The server MAY cap:

- object size;
- account ciphertext bytes;
- objects per account;
- request batch sizes; and
- upload/download ticket lifetime.

Quota refusal creates no partial object. Because version 1.0 has no
remote garbage collection, clients MUST surface approaching quota and
allow the user to export, move to another sync store, or reset the remote
account deliberately.

A local write never waits for sync availability. Sync failures change
replication lag, not local commit success or mailbox pickup.

## 15. Privacy and security

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

## 16. Problem reports

Authenticated control errors use Problem Report 2.0:

| code | meaning |
|---|---|
| `e.estoc.vault-sync.invalid-request` | malformed body, ID, hash or limit |
| `e.estoc.vault-sync.store-reset` | supplied `store_id` is no longer current |
| `e.estoc.vault-sync.object-too-large` | object exceeds the account limit |
| `e.estoc.vault-sync.quota` | account cannot accept another object |
| `e.estoc.vault-sync.upload-expired` | upload ticket is no longer valid |
| `e.estoc.vault-sync.hash-mismatch` | uploaded ciphertext failed hash or length |
| `e.estoc.vault-sync.too-many-objects` | request exceeds a batch limit |
| `e.estoc.vault-sync.unsupported-version` | frame or protocol version unsupported |

HTTP upload and download endpoints return generic transport errors and
MUST NOT disclose another account's object existence.

## 17. Required conformance cases

1. Two replicas independently offer the same logical object with
   different random ciphertext; exactly one immutable server object
   remains and both clients can decrypt and validate it.
2. Re-offering an existing ID allocates no overwrite upload.
3. An incomplete, oversized or hash-mismatched upload creates no object
   and no sequence.
4. `changes` returns every committed object after a cursor in increasing
   sequence order.
5. Losing all local cursor state and running `inventory` finds the same
   server object set.
6. A changed `store_id` forces full reconciliation.
7. An object inserted while inventory pages are being read is either in
   the fixed `through` snapshot or has a later sequence returned by
   `changes`; it is never skipped because of object-ID sort position.
8. Download hash, AEAD tag, frame, semantic validation and object-ID
   recomputation are all checked before local acceptance.
9. Blob bytes are verified against their CID before `put`.
10. Event blobs are uploaded before the event in the normal publishing
    path; a crash between them leaves only safe unreferenced data.
11. Concurrent offline event sets converge after both replicas exchange
    every opaque object.
12. Same `eid` with different event content is surfaced as integrity
    conflict, not silently first-wins.
13. A fresh local replica with seed and store locator can reconstruct the
    root configuration, events and blobs while minting a new local
    `replica_id` and `store_generation`.
14. Searching server database, object storage, logs and traces for an
    event-type, contact-name or message-body sentinel finds none in
    plaintext.
15. Mailbox failure does not block sync, and sync failure does not block
    local append, sending intent or mailbox pickup.
16. No sync request carries a replica ID, and the sync store keeps no
    replica registry or per-replica cursor.
