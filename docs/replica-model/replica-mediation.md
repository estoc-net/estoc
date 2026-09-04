# replica-mediation/1.0

Status: **draft** — proposed Estoc profile for DIDComm Messaging 2.1,
Routing 2.0, Coordinate Mediation 3.0 and Message Pickup 3.0.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

## 1. What it is for

One Estoc vault may have several independently writable full replicas. Every
full replica holds the same vault seed and can derive the same communication
DIDs, recipient keys and mediation account keys. A sender still addresses
one vault-scoped DID and sends one encrypted application message. The
mediator fans that opaque message out to the vault's active replicas, and
each replica acknowledges independently.

The recipient DID may be:

- a public rendezvous DID, normally `did:web`, used for the first encrypted
  relationship request; or
- a pairwise relationship DID, normally `did:peer`, used after handoff.

The mediator applies identical storage, fan-out and pickup semantics to both.
It does not need to know the vault role of a recipient DID.

The protocol adds two things to ordinary DIDComm mediation:

1. a lifecycle for **replicas** under one mediation account; and
2. a replica-scoped profile of Message Pickup 3.0.

It also fixes the storage and privacy rules that make this fan-out safe: the
mediator stores one encrypted inner DIDComm envelope, creates one
**delivery** per active replica, and never treats one replica's
acknowledgment as another replica's.

This protocol does not synchronize the vault event set. That is
`vault-sync/1.0`. It does not define public-to-pairwise handoff; that is
`rendezvous/1.0`. It does not make one full replica less trusted than another,
and it does not make a lost copy of the shared seed revocable.

## 2. Dependencies

A conforming implementation uses:

- DIDComm Messaging 2.1;
- Routing 2.0 (`https://didcomm.org/routing/2.0`);
- Coordinate Mediation 3.0
  (`https://didcomm.org/coordinate-mediation/3.0`);
- Message Pickup 3.0 (`https://didcomm.org/messagepickup/3.0`);
- Problem Report 2.0 (`https://didcomm.org/report-problem/2.0`);
- `rendezvous/1.0` for the optional public-to-pairwise handoff; and
- this protocol family:
  `https://estoc.dev/replica-mediation/1.0`.

A mediator implementing this document SHOULD disclose the
`replica-mediation/1.0` protocol with Discover Features 2.0. Discovery is
advisory; successful `register` is the authoritative capability check.

## 3. Terms and trust model

- **Vault** — one Estoc identity and its event, blob and key material.
- **Full replica** — one independently writable incarnation of a
  vault, holding the seed and enough vault data to derive and use the
  vault's communication identities. It is not a hardware identity.
- **Mediation account** — the DIDComm identity that established one
  Coordinate Mediation arrangement with a mediator. It is shared by all
  full replicas of the vault.
- **Recipient DID** — any DID registered under the mediation account and
  accepted as `body.next` of a Routing 2.0 `forward` message. It may be a
  public rendezvous DID or a pairwise relationship DID. The mediator does
  not assign semantics based on its method or role.
- **Replica ID** — a lowercase canonical UUIDv7 naming one writable local
  incarnation for event provenance, delivery and acknowledgment. It is
  stored as `local/replica.json.replica_id`, is also used as the author of
  events produced by that incarnation, and is not a key or authorization
  boundary. There is no second identity for the execution host or operating system.
- **Mailbox message** — one retained encrypted inner DIDComm envelope,
  stored once under a mediation account.
- **Delivery** — one replica's pending right to obtain a mailbox message.
  A delivery has its own opaque ID and acknowledgment state.
- **Retention window** — the interval in which a mailbox message remains
  eligible for replay to newly registered replicas.

Every unlocked full replica is equally authorized to act as the vault.
The mediation account's authenticated DIDComm channel authorizes
`register`, `list` and `retire`. The `replica_id` only separates normal
clients' pickup and acknowledgment state.

Retiring a replica changes future delivery policy. It does not erase a
seed already copied into that local incarnation, revoke communication
keys, or stop a holder of the seed from deriving the mediation account
and registering a new replica ID. Recovering from a hostile or lost full
replica requires
rotation of the affected root secret or communication identities and is
outside this protocol.

## 4. Invariants

A conforming mediator MUST preserve all of the following:

1. One retained mailbox message has exactly one immutable encrypted
   envelope.
2. At most one delivery exists for a `(mailbox message, replica)` pair.
3. Acknowledging a delivery for replica A MUST NOT acknowledge, delete or
   hide the corresponding delivery for replica B.
4. A mailbox message remains until its retention deadline, independently
   of how many current replicas acknowledged it.
5. Registering a replica with retained replay and accepting a concurrent
   `forward` MUST be atomic with respect to each other: the replica gets a
   delivery whether registration commits first or forwarding commits
   first.
6. The mediator MUST NOT decrypt the inner application message or possess
   an application content-decryption key.
7. Delivery is at least once. Clients MUST tolerate the same delivery
   being returned or pushed more than once before acknowledgment.
8. A transport acceptance response from a mediator is not proof that an
   ultimate recipient durably received the application message.
9. A sender addresses a recipient DID, never a replica ID. Replica fan-out is
   an internal mailbox operation.
10. Public rendezvous and pairwise relationship DIDs receive the same
    per-replica delivery semantics.

## 5. Replica lifecycle

A replica is either `active` or `retired`:

```text
              register
   absent  ─────────────> active ─────────────> retired
                                retire             │
                                                   └── terminal
```

A retired replica ID MUST NOT become active again. A returning or newly created independently writable local incarnation
mints a fresh replica ID.

Replica registration has no inactivity lease in version 1.0. A replica
remains active until an authenticated `retire` request. Message expiry,
not replica liveness, bounds mediator storage.

One independently writable local vault copy MUST have exactly one active
replica ID. Creating a second independently writable copy MUST mint a
new replica ID. A portable snapshot omits the source copy's active
replica selection. An exact move MAY preserve a replica ID only when
the implementation guarantees that the previous writer can no longer
append events or acknowledge deliveries under that ID.

### 5.1 `register`

Message type:

```text
https://estoc.dev/replica-mediation/1.0/register
```

Example:

```json
{
  "id": "019b1b48-8b3c-7c19-b667-218ae742bd91",
  "type": "https://estoc.dev/replica-mediation/1.0/register",
  "from": "did:peer:4zQm...mediation-account",
  "to": ["did:web:mediator.example"],
  "body": {
    "replica_id": "019b1b47-dbf6-72b1-9239-0ce3de7ab12d",
    "replay": "retained"
  }
}
```

The message MUST be authcrypted from the mediation account DID to the
mediator DID.

- `replica_id` is REQUIRED and MUST be a canonical UUIDv7.
- `replay` is REQUIRED. The only value in version 1.0 is `retained`.

On first registration the mediator MUST, in one transaction:

1. create the active replica;
2. create a delivery for every unexpired mailbox message under the
   account for which that replica has no delivery; and
3. commit both changes together.

Repeating the same request for an active replica is idempotent. The
mediator MUST still repair any missing retained deliveries before
replying. Re-registering a retired replica ID fails.

### 5.2 `registered`

Message type:

```text
https://estoc.dev/replica-mediation/1.0/registered
```

Example:

```json
{
  "id": "019b1b48-fb26-7de9-a962-87e065564655",
  "thid": "019b1b48-8b3c-7c19-b667-218ae742bd91",
  "type": "https://estoc.dev/replica-mediation/1.0/registered",
  "body": {
    "replica_id": "019b1b47-dbf6-72b1-9239-0ce3de7ab12d",
    "state": "active",
    "registered_time": 1788442800,
    "replayed_count": 17,
    "limits": {
      "message_retention_seconds": 604800,
      "max_replicas": 16,
      "max_message_bytes": 1048576,
      "max_deliveries_per_request": 100
    }
  }
}
```

- `registered_time` is UTC Epoch Seconds. For an idempotent repeat it is
  the original registration time.
- `replayed_count` is the number of delivery rows inserted or repaired by
  this request. It MAY be zero.
- `limits` is REQUIRED. A mediator MAY choose account-specific values,
  but MUST apply the values it reports.

### 5.3 `list`

Message type:

```text
https://estoc.dev/replica-mediation/1.0/list
```

```json
{
  "id": "019b1b4a-c295-769d-8b5c-c73317bd9d55",
  "type": "https://estoc.dev/replica-mediation/1.0/list",
  "from": "did:peer:4zQm...mediation-account",
  "to": ["did:web:mediator.example"],
  "body": {}
}
```

The request MUST be authcrypted from the mediation account. It lists only
replicas under that account.

### 5.4 `replicas`

Message type:

```text
https://estoc.dev/replica-mediation/1.0/replicas
```

```json
{
  "id": "019b1b4b-0e10-7ebc-877c-46a596cc8289",
  "thid": "019b1b4a-c295-769d-8b5c-c73317bd9d55",
  "type": "https://estoc.dev/replica-mediation/1.0/replicas",
  "body": {
    "replicas": [
      {
        "replica_id": "019b1b47-dbf6-72b1-9239-0ce3de7ab12d",
        "state": "active",
        "registered_time": 1788442800,
        "last_seen_time": 1788443012
      },
      {
        "replica_id": "019b1947-a249-79e1-a297-cb5437d1494e",
        "state": "retired",
        "registered_time": 1788350000,
        "retired_time": 1788440000
      }
    ]
  }
}
```

`last_seen_time` is advisory and MAY be absent. Its absence or age MUST
NOT retire a replica.

Human-readable names, hardware identifiers, operating-system identifiers
and user labels MUST NOT be sent in this protocol. A client that wants
to display a name for a replica stores it as encrypted vault metadata
and joins it locally with the opaque `replica_id`.

### 5.5 `retire`

Message type:

```text
https://estoc.dev/replica-mediation/1.0/retire
```

```json
{
  "id": "019b1b4c-7f52-77cc-98cb-02bd8c12011a",
  "type": "https://estoc.dev/replica-mediation/1.0/retire",
  "from": "did:peer:4zQm...mediation-account",
  "to": ["did:web:mediator.example"],
  "body": {
    "replica_id": "019b1947-a249-79e1-a297-cb5437d1494e",
    "reason": "lost"
  }
}
```

`reason` is OPTIONAL and is one of `user`, `replaced`, `lost`, or
`other`. It is diagnostic only.

The mediator MUST atomically mark the replica retired and remove or mark
terminal all unacknowledged deliveries for that replica. It MUST NOT
delete the underlying mailbox messages before their retention deadline.
Repeating retirement is idempotent.

### 5.6 `retired`

Message type:

```text
https://estoc.dev/replica-mediation/1.0/retired
```

```json
{
  "id": "019b1b4c-968a-7356-b5e0-9e44cd8412bf",
  "thid": "019b1b4c-7f52-77cc-98cb-02bd8c12011a",
  "type": "https://estoc.dev/replica-mediation/1.0/retired",
  "body": {
    "replica_id": "019b1947-a249-79e1-a297-cb5437d1494e",
    "state": "retired",
    "retired_time": 1788443100
  }
}
```

## 6. Coordinate Mediation profile

The mediation account remains the one `recipient` in Coordinate Mediation
3.0. All full replicas derive and use that same account key. Recipient DIDs
are therefore registered once per mediation arrangement, not once per
replica.

Registration is method-neutral. A `did:web` rendezvous DID and a `did:peer`
relationship DID may both be registered under the same account. The
recipient-control proof is verified against an authentication method of the
specific recipient DID and does not grant the mediator application-level
knowledge of its role.

### 6.1 Recipient-control proof

A conforming Estoc mediator MUST require control proof for every
`recipient-update` entry. The normal Coordinate Mediation fields remain;
Estoc adds `registration_id` and `proof`:

```json
{
  "type": "https://didcomm.org/coordinate-mediation/3.0/recipient-update",
  "id": "019b1b50-b403-7940-abaf-f59b92d2231b",
  "body": {
    "updates": [
      {
        "recipient_did": "did:peer:4zQm...recipient",
        "action": "add",
        "registration_id": "019b1b50-42bf-71b7-a8d8-70543a158ffd",
        "proof": "eyJhbGciOiJFZERTQSIsImtpZCI6Ii4uLiIsInR5cCI6ImVzdG9jL3JlY2lwaWVudC1yZWdpc3RyYXRpb24randzIn0.eyJhY2NvdW50IjoiLi4uIn0.signature"
      }
    ]
  },
  "return_route": "all"
}
```

`proof` is a compact JWS:

- protected `alg` MUST be `EdDSA`;
- protected `typ` MUST be
  `estoc/recipient-registration+jws`;
- protected `kid` MUST identify an authentication verification method of
  `recipient_did`;
- the payload MUST be the UTF-8 RFC 8785 canonical form of:

```json
{
  "account": "did:peer:4zQm...mediation-account",
  "action": "add",
  "aud": "did:web:mediator.example",
  "expires_time": 1788443400,
  "registration_id": "019b1b50-42bf-71b7-a8d8-70543a158ffd",
  "request_id": "019b1b50-b403-7940-abaf-f59b92d2231b",
  "recipient": "did:peer:4zQm...recipient"
}
```

The mediator MUST verify every duplicated value against the surrounding
request. `expires_time` MUST be in the future and MUST NOT be more than
five minutes after the mediator's current time.

For `remove`, the JWS payload uses `"action":"remove"` and MUST name the
currently active `registration_id`.

### 6.2 Registration state

A recipient DID has at most one active mediation account at a mediator.

For `add`:

- absent recipient: add it;
- same account and same `registration_id`: `no_change`;
- same account and a new valid `registration_id`: atomically replace the
  registration ID;
- another account already owns the recipient: `client_error`.

For `remove`:

- same account and matching active `registration_id`: remove it;
- absent, another account, or stale registration ID: `no_change`.

Removing a recipient affects future `forward` messages only. Retained
mailbox messages and their deliveries remain until expiry.

A conforming `recipient-query` response SHOULD include the active
`registration_id` beside every recipient DID as an Estoc extension.

## 7. Routing and mailbox storage profile

### 7.1 Accepted forward

A mediator implementing this profile MUST apply all of these checks to a
Routing 2.0 `forward` before storage:

1. the outer DIDComm message was encrypted to the mediator;
2. `body.next` is a valid DID and resolves to a local mediation account
   or a currently registered recipient DID;
3. there is exactly one attachment;
4. the attachment's `media_type` is
   `application/didcomm-encrypted+json`;
5. the attachment uses `data.json` or `data.base64`, but not both and not
   `data.links`;
6. after decoding, the value is one DIDComm encrypted-message JSON
   serialization with non-empty `protected`, `recipients`, `iv`,
   `ciphertext`, and `tag` fields; and
7. the normalized UTF-8 JSON is within the mediator's message-size limit.

Validation is syntactic. The mediator cannot and MUST NOT decrypt the
inner envelope.

The mediator normalizes an accepted inner envelope with RFC 8785 and
stores those UTF-8 bytes. The mailbox message's deduplication key is:

```text
(mediation account DID, body.next, forward.id)
```

`forward.id` therefore identifies one exact encrypted package. Repeating
that key with identical normalized bytes is an idempotent retry. Reusing
it with different bytes is a package conflict; the first value remains
and the second MUST NOT replace it.

### 7.2 Atomic fan-out

For a new accepted package, one database transaction MUST:

1. insert the mailbox message and its retention deadline; and
2. create one delivery for every active replica of the mediation
   account.

The message MUST still be retained when the account currently has no
active replicas. A later `register` with `replay: retained` creates the
missing delivery.

Live delivery happens only after the transaction commits. A failed or
lost live push changes no durable state.

### 7.3 Sender-visible behavior

Routing is one-way and may be anonymous. A mediator SHOULD avoid making
HTTP status, latency or response bodies into a recipient-existence
oracle. It MAY return the same transport acceptance for a stored
forward, an unknown route, a quota refusal and an invalid anonymous
forward.

Consequently, the sender MUST treat mediator or HTTP acceptance only as
`submitted`. Ultimate delivery is established by an authenticated
application-level ACK, as described in `distributed-delivery/1.0`.

### 7.4 Recipient-role neutrality

The mediator MUST NOT require a recipient to be classified as public,
rendezvous, pairwise, relationship or server-owned. For routing purposes,
all registered recipient DIDs have the same shape:

```text
recipient DID -> mediation account -> active replica deliveries
```

A sender resolving a public `did:web` may discover this mediator through its
`DIDCommMessaging` service and send a `rendezvous/1.0/request`. Later traffic
to the resulting `did:peer` relationship DID may use the same mediation
account and storage path. It may instead use another vault-scoped mediation
account at the same or another mediator; the replica lifecycle and delivery
rules are identical per account.

Changing the active replica set, adding a full replica on a server or moving
the web publisher MUST NOT require changing either recipient DID. Thin
clients that do not hold the seed do not register here.

## 8. Message Pickup 3.0 replica profile

All pickup messages MUST be authcrypted from the mediation account to the
mediator. For an account using replica mediation, the following message
bodies MUST contain `replica_id`:

- `status-request`;
- `status`;
- `delivery-request`;
- `delivery`;
- `messages-received`; and
- `live-delivery-change`.

A request omitting `replica_id` MUST fail with
`e.estoc.replica-mediation.replica-required`. There is no account-global
fallback.

The replica MUST exist under the authenticated account and be active.
Unknown or retired IDs fail and MUST NOT reveal another account's
replicas.

### 8.1 Status

Example request:

```json
{
  "type": "https://didcomm.org/messagepickup/3.0/status-request",
  "id": "019b1b54-a824-7bdb-86b7-4e89b35b0886",
  "body": {
    "replica_id": "019b1b47-dbf6-72b1-9239-0ce3de7ab12d",
    "recipient_did": "did:peer:4zQm...recipient"
  },
  "return_route": "all"
}
```

`message_count`, `total_bytes`, oldest/newest times and longest wait MUST
be calculated over unacknowledged, unexpired deliveries for that replica
only. If `recipient_did` is present, every value MUST be further limited
to that recipient DID.

The matching `status` body echoes `replica_id` and, when requested,
`recipient_did`.

### 8.2 Delivery request and delivery

```json
{
  "type": "https://didcomm.org/messagepickup/3.0/delivery-request",
  "id": "019b1b55-080a-786c-b1e8-0fb171459704",
  "body": {
    "replica_id": "019b1b47-dbf6-72b1-9239-0ce3de7ab12d",
    "limit": 50
  },
  "return_route": "all"
}
```

The response is the standard `delivery` message with `replica_id` added:

```json
{
  "type": "https://didcomm.org/messagepickup/3.0/delivery",
  "id": "019b1b55-1303-7c04-8d55-ddc24d38a03c",
  "thid": "019b1b55-080a-786c-b1e8-0fb171459704",
  "body": {
    "replica_id": "019b1b47-dbf6-72b1-9239-0ce3de7ab12d"
  },
  "attachments": [
    {
      "id": "019b1b53-75cc-71d7-a61c-45360fc20851",
      "media_type": "application/didcomm-encrypted+json",
      "data": { "base64": "eyJwcm90ZWN0ZWQiOi..." }
    }
  ]
}
```

Each attachment ID names the delivery, not the mailbox message and not
the application message. It MUST be opaque, contain at least 128 bits of
unpredictability, and be unique within the mediator. One durable delivery
keeps the same attachment ID across polling, redelivery and live push.
Different replicas receive different attachment IDs for the same
encrypted envelope.

A delivery request does not acknowledge or remove anything. The
mediator MAY suppress immediate repeated delivery for load control, but
MUST eventually make every unacknowledged, unexpired delivery available
again.

### 8.3 Messages received

```json
{
  "type": "https://didcomm.org/messagepickup/3.0/messages-received",
  "id": "019b1b56-70f2-7cc7-9ba4-0fc6218bb64a",
  "body": {
    "replica_id": "019b1b47-dbf6-72b1-9239-0ce3de7ab12d",
    "message_id_list": [
      "019b1b53-75cc-71d7-a61c-45360fc20851"
    ]
  },
  "return_route": "all"
}
```

The mediator MUST affect only deliveries belonging to the authenticated
account and named replica. Unknown IDs, IDs already acknowledged and IDs
belonging to another replica have no effect. Processing the same list
again is idempotent.

A client MUST NOT send a delivery ID until it has:

1. decoded and authenticated the inner DIDComm envelope;
2. durably stored the message body and every attachment it intends to
   retain; and
3. durably appended its inbound vault observation.

Business handlers, rendering, replica synchronization and read state are
not prerequisites for pickup acknowledgment.

### 8.4 Live delivery

`live-delivery-change` adds `replica_id` to its body. Live-delivery state
is scoped to one authenticated connection and one replica. The mediator
MUST push only that replica's deliveries to the connection.

Several simultaneous connections MAY identify the same replica and MAY
receive the same delivery. They share that replica's acknowledgment
domain. Disconnecting or failing a push MUST NOT acknowledge a delivery.

This live connection is the permitted form of direct-to-replica transport in
version 1.0. It is an internal mailbox delivery channel authenticated under
the mediation account; the external sender still addresses the recipient
DID and never learns the replica ID. A live push never replaces the durable
delivery row before `messages-received`.

## 9. Retention and replay

For an accepted mailbox message, the mediator computes:

```text
expires_at = min(
  received_at + account.message_retention_seconds,
  forward.expires_time when present
)
```

A past `forward.expires_time` is not stored. A longer sender expiry does
not extend the mediator's advertised retention.

Until `expires_at`:

- the encrypted mailbox message remains available for retained replay;
- active replicas may have pending or acknowledged delivery state; and
- a newly registered replica receives a delivery even if every older
  replica already acknowledged the message.

At or after `expires_at`, the mediator MAY delete the message and every
associated delivery. An inactive but unretired replica MUST NOT prevent
expiry.

A sender that needs stronger reliability keeps its own durable outbox
and retries until it receives an ultimate authenticated ACK. This
protocol does not turn the mediator into a permanent archive.

## 10. Quotas

A mediator MUST publish and enforce at least:

- maximum active replicas per account;
- maximum normalized encrypted-envelope bytes per mailbox message;
- maximum retained ciphertext bytes or retained messages per account;
- maximum delivery IDs per pickup acknowledgment; and
- message retention seconds.

Ciphertext quota SHOULD count the one stored envelope once, not once per
replica delivery. Delivery-row quota MAY be separate.

When quota prevents storage, the mediator MUST NOT partially create a
mailbox message or only some replica deliveries.

## 11. Privacy and security

The mediator is permitted to observe and retain routing metadata needed for
operation, including:

- mediation account DID;
- recipient DID (`body.next`) and therefore its method syntax;
- replica IDs;
- ciphertext size and hash;
- arrival, delivery, acknowledgment and expiry times; and
- transport metadata such as IP address and connection timing.

The mediator MUST NOT be sent an explicit rendezvous role, relationship ID,
contact ID, human-readable label or web-publication state. A replica ID MUST
NOT appear in a public DID document or in an innermost application `to`
header as a delivery target.

Recipient DIDs registered under the same mediation account are linkable to
that mediator. Pairwise DIDs prevent public correlation by unrelated peers;
they do not by themselves hide account membership from the mediator. A vault
that needs that property uses separate mediation arrangements and accepts the
additional registration, pickup and availability cost.

Because every full replica uses the same mediation-account key, the mediator
cannot cryptographically prove that a caller supplied its own local
`replica_id`. Per-replica scoping prevents conforming clients from
accidentally acknowledging one another's deliveries; it is not isolation
from a malicious holder of the vault seed.

The mediator MUST NOT:

- decrypt an inner application envelope;
- persist an unpacked application plaintext;
- possess or log application content keys;
- fetch attachment links supplied by an anonymous sender;
- log request bodies, decrypted `forward` bodies, inner ciphertext bytes or
  pickup attachment bytes by default; or
- present replica retirement as cryptographic seed revocation.

An encrypted envelope can contain sender-chosen bytes. The enforceable claim
is therefore that the mediator stores only a syntactically valid DIDComm
encrypted-message envelope and never opens it, not that every byte of
ciphertext was honestly produced from human-unreadable input.

## 12. Problem reports

Errors on authenticated request-response interactions use Problem Report
2.0. Defined codes are:

| code | meaning |
|---|---|
| `e.estoc.replica-mediation.invalid-request` | malformed or unsupported body |
| `e.estoc.replica-mediation.replica-required` | pickup request omitted `replica_id` |
| `e.estoc.replica-mediation.unknown-replica` | no such replica under this account |
| `e.estoc.replica-mediation.replica-retired` | replica ID is terminal |
| `e.estoc.replica-mediation.too-many-replicas` | account limit reached |
| `e.estoc.replica-mediation.recipient-proof` | recipient-control proof failed |
| `e.estoc.replica-mediation.recipient-conflict` | another account owns the recipient |
| `e.estoc.replica-mediation.message-too-large` | normalized envelope exceeds the limit |
| `e.estoc.replica-mediation.quota` | account retention quota is exhausted |

A mediator MAY intentionally give no DIDComm problem report for an
anonymous Routing 2.0 `forward`, so as not to create a route oracle.

## 13. Required conformance cases

A conforming implementation demonstrates at least these cases:

1. Two active replicas receive distinct delivery IDs for one stored
   ciphertext.
2. Replica A's acknowledgment leaves replica B's delivery pending.
3. A late replica obtains every unexpired retained message.
4. Concurrent replica registration and forwarding cannot omit the late
   replica's delivery.
5. A crash before local durable commit produces no pickup ACK and the
   delivery is available again.
6. A crash after local commit but before ACK may redeliver; the client
   records one logical application message.
7. Repeating one `forward.id` with identical normalized bytes stores no
   second message.
8. Reusing one `forward.id` with different bytes never overwrites the
   first message.
9. `recipient_did` filters status and delivery in fact, not only in the
   response body.
10. A retired or unknown replica cannot inspect or acknowledge another
    replica's queue.
11. No active replica is required for an accepted message to remain
    replayable during its retention window.
12. Plain, signed-only, linked or structurally invalid inner attachments
    are not persisted as mailbox messages.
13. Searching mediator database rows, object storage, logs and traces for
    an application plaintext sentinel does not find the sentinel or an
    application content key.
14. Replica registration and listing reveal no hardware identifier,
    operating-system identifier or human-readable local label.
15. A `did:web` rendezvous recipient and a `did:peer` relationship recipient
    selecting the same mediated route receive identical fan-out and ACK
    isolation.
16. No public DID document, relationship DID document or application message
    uses a replica ID as the peer-visible recipient.
17. Adding or removing a server full replica changes only delivery rows and
    does not change registered recipient DIDs.
