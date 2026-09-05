# replica-mediation/1.0

Status: **deferred draft** — future multi-replica extension for DIDComm
Messaging 2.1, Routing 2.0, Coordinate Mediation 3.0 and Message Pickup 3.0.
It is not required or implemented by Estoc phase 1, which uses one active full
runtime and ordinary account-scoped Message Pickup.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

> **Phase-1 boundary.** A mediation account that has not explicitly enabled
> this extension behaves as an ordinary Coordinate Mediation / Message Pickup
> account and carries no `replica_id`. Once this extension is enabled for an
> account, its replica-scoped rules are a clean break and account-global pickup
> MUST NOT be mixed with them.

## 1. What it is for

One Estoc vault may have several independently writable full replicas. Every
full replica holds the same vault seed and can derive the same communication
DIDs, recipient keys and mediation account keys. A sender still addresses
one vault-scoped DID and sends one encrypted application message. The
mediator fans that opaque message out to the vault's active replicas, and
each replica acknowledges independently.

The recipient DID may be:

- a rendezvous DID, by default self-resolving `did:peer:4` and optionally
  `did:web`, used for an encrypted initial relationship message; or
- a pairwise relationship `did:peer:4`, used after handoff.

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
`vault-sync/1.0`. It does not define rendezvous-to-pairwise handoff; that is
the processing profile in `rendezvous.md`. It does not make one full replica
less trusted than another, and it does not make a lost copy of the shared seed
revocable.

## 2. Dependencies

A conforming implementation uses:

- DIDComm Messaging 2.1;
- Routing 2.0 (`https://didcomm.org/routing/2.0`);
- Coordinate Mediation 3.0
  (`https://didcomm.org/coordinate-mediation/3.0`);
- Message Pickup 3.0 (`https://didcomm.org/messagepickup/3.0`);
- Problem Report 2.0 (`https://didcomm.org/report-problem/2.0`);
- the processing profile in `rendezvous.md` for rendezvous-to-pairwise
  handoff; and
- this protocol family:
  `https://estoc.dev/replica-mediation/1.0`.

A mediator implementing this document SHOULD disclose the
`replica-mediation/1.0` protocol with Discover Features 2.0. Discovery is
advisory; successful `register` is the authoritative capability check.

## 3. Terms and trust model

- **Vault** — one Estoc identity and its event, object and key material.
- **Full replica** — one independently writable incarnation of a
  vault, holding the seed and enough vault data to derive and use the
  vault's communication identities. It is not a hardware identity.
- **Mediation account** — the DIDComm identity that established one
  Coordinate Mediation arrangement with a mediator. It is shared by all
  full replicas of the vault.
- **Recipient DID** — any DID registered under the mediation account and
  accepted as `body.next` of a Routing 2.0 `forward` message. It may be a
  Peer or Web rendezvous DID or a pairwise relationship
  DID. The mediator does not assign semantics based on method or role.
- **Replica ID** — a lowercase canonical UUIDv7 naming one writable local
  incarnation for event provenance, delivery and acknowledgment. It is
  stored as `local/replica.json.replica_id`, is also used as the author of
  events produced by that incarnation, and is not a key or authorization
  boundary. There is no second identity for the execution host or operating
  system.
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
replica requires rotation of the affected root secret or communication identities and is
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
10. Peer or optional Web rendezvous DIDs and pairwise relationship
    DIDs receive the same per-replica delivery semantics.

## 5. Replica lifecycle

A replica is either `active` or `retired`:

```text
              register
   absent  ─────────────> active ─────────────> retired
                                retire             │
                                                   └── terminal
```

A retired replica ID MUST NOT become active again. A returning or
newly created independently writable local incarnation mints a fresh replica
ID.

The default version-1.0 policy has no inactivity lease: a replica remains
active until an authenticated `retire` request. A mediator MAY instead
advertise a non-null `inactivity_retirement_seconds` service policy. When it
does, the value MUST be at least `message_retention_seconds`, the server MUST
base it only on its own authenticated `last_seen_time`, and crossing the limit
atomically retires the replica before later fan-out. The retirement reason is
`inactivity-policy`, the old ID remains terminal, and a returning local copy
mints a new replica ID and obtains retained replay. Clients MUST surface this
loss-of-long-offline-delivery tradeoff before using such a mediator. Message
expiry, not an indefinitely stale delivery row, still bounds mailbox storage.

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
      "max_recipients": 4096,
      "max_message_bytes": 1048576,
      "max_retained_messages": 100000,
      "max_pending_deliveries_per_replica": 100000,
      "max_deliveries_per_request": 100,
      "max_recipient_updates_per_request": 100,
      "inactivity_retirement_seconds": null
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
- `inactivity_retirement_seconds` is either null, meaning no automatic
  retirement, or the finite service policy defined in section 5. It MUST NOT
  change for an existing active replica without being returned on a later
  authenticated registration response before enforcement.

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

`last_seen_time` is the mediator's UTC Epoch Seconds observation of the most
recent successful authenticated `register`, replica-scoped pickup request,
`messages-received`, or live-delivery operation for that ID. It MAY be absent
when the server cannot provide it. Its age is advisory unless the server has
explicitly advertised a finite `inactivity_retirement_seconds`; without that
policy, age alone MUST NOT change state.

Human-readable names, hardware identifiers, operating-system identifiers
and user labels MUST NOT be sent in this protocol. A client that wants to
display a name for a replica stores it as encrypted vault metadata and joins
it locally with the opaque `replica_id`.

A conforming client MUST periodically reconcile `list`, and MUST do so after a
restore that minted a new replica ID. It SHOULD identify old active entries by
locally encrypted labels and `last_seen_time`, and offer explicit retirement
after the new replica has completed bootstrap, sync and registration. On
`too-many-replicas`, the client MUST list current replicas and ask the user to
retire one or more explicit IDs rather than silently reusing or evicting an
ID. An operator MAY recommend a review interval, but that recommendation is
not a retirement authority.

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

`reason` is OPTIONAL and is one of `user`, `replaced`, `lost`,
`inactivity-policy`, `fork-recovery`, or `other`. An automatic retirement uses
`inactivity-policy`. The value is diagnostic and does not change the terminal
state.

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
    "reason": "inactivity-policy",
    "retired_time": 1788443100
  }
}
```

`reason` is the retained reason when known and null when a legacy/operator
retirement did not preserve one.

### 5.7 Client re-incarnation after terminal retirement

If `register`, `list`, status, live delivery or another authenticated mediator
response says that the client's **current** replica ID is retired, the client
MUST treat the ID as terminal even when `local/` is otherwise intact. It MUST:

1. stop new event appends, pickup ACKs, live registration and outbound
   submission under the old ID;
2. durably finish or checkpoint local work; events already authored by the old
   ID remain valid sync objects;
3. atomically mint and store a fresh `replica_id` and `store_generation` in
   `local/replica.json`;
4. reopen local event stores under the new author and discard change tokens or
   caches bound to the old generation;
5. append or reconcile `replica.retired` for the old ID with the mediator's
   stable reason, including `inactivity-policy` when applicable;
6. register the new ID with retained replay on **every** required mediation
   account, and retire the old ID on remaining accounts; and
7. resume pickup, sync and outbound work only under the fresh ID.

A terminal response from one required mediator rotates the local replica ID
for all mediators. A runtime MUST NOT split event authorship and ACK identity
by keeping the old ID on another arrangement.

## 6. Coordinate Mediation profile

The mediation account remains the one `recipient` in Coordinate Mediation
3.0. All full replicas derive and use that account key. Recipient DIDs are
registered once per mediation arrangement, not once per replica.

Registration is method-neutral. A canonical short-form Peer rendezvous
DID, an optional `did:web` rendezvous DID, and canonical short-form pairwise
`did:peer:4` relationship DIDs may all be registered under the same account.
The recipient-control proof is verified against an authentication method of
the exact recipient DID.

### 6.1 Recipient-control proof

A conforming Estoc mediator MUST require control proof for every
`recipient-update` entry. Estoc adds `registration_id`, `proof` and optional
`resolution_material`:

```json
{
  "type": "https://didcomm.org/coordinate-mediation/3.0/recipient-update",
  "id": "019b1b50-b403-7940-abaf-f59b92d2231b",
  "body": {
    "updates": [
      {
        "recipient_did": "did:peer:4zQm...recipient-short",
        "action": "add",
        "registration_id": "019b1b50-42bf-71b7-a8d8-70543a158ffd",
        "resolution_material": {
          "kind": "did-peer-4-long-form",
          "value": "did:peer:4zQm...recipient-short:z...input-document"
        },
        "proof": "eyJhbGciOiJFZERTQSIsImtpZCI6Ii4uLiIsInR5cCI6ImVzdG9jL3JlY2lwaWVudC1yZWdpc3RyYXRpb24randzIn0.eyJhY2NvdW50IjoiLi4uIn0.signature"
      }
    ]
  },
  "return_route": "all"
}
```

`proof` is compact JWS:

- protected `alg` is `EdDSA`;
- protected `typ` is `estoc/recipient-registration+jws`;
- protected `kid` identifies an authentication method of `recipient_did`;
- payload is UTF-8 RFC 8785 canonical JSON:

```json
{
  "account": "did:peer:4zQm...mediation-account",
  "action": "add",
  "aud": "did:web:mediator.example",
  "expires_time": 1788443400,
  "registration_id": "019b1b50-42bf-71b7-a8d8-70543a158ffd",
  "request_id": "019b1b50-b403-7940-abaf-f59b92d2231b",
  "recipient": "did:peer:4zQm...recipient-short"
}
```

The mediator verifies every duplicated value against the request.
`expires_time` is in the future and no more than five minutes after mediator
current time. A remove proof uses `"action":"remove"` and names the active
registration ID.

A single request MUST NOT contain more updates than the mediator's advertised
`max_recipient_updates_per_request`. The whole request is atomic: quota,
proof or resolution failure in one entry prevents applying every entry unless
the surrounding Coordinate Mediation response explicitly reports per-entry
atomic groups. Version 1.0 RECOMMENDS one atomic request.

### 6.2 Method-specific resolution

#### Peer DID numalgo 4

Mediator storage and `recipient_did` use canonical short form. When the
mediator does not already retain verified resolution material for that short
form, `resolution_material` MUST contain the corresponding long form.

The mediator locally:

1. decodes and validates the long-form input document;
2. recomputes the canonical short form from the encoded-document hash;
3. requires that recomputed value to equal `recipient_did` byte-for-byte;
4. contextualizes relative verification methods under that canonical short
   DID;
5. requires the proof payload `recipient` to equal the same short form;
6. resolves the protected proof `kid` to an authentication method from the
   supplied document, accepting a long-form DID URL only after normalizing its
   DID portion to the verified short form; and
7. verifies the JWS.

The long form is resolution material, never the stored recipient key. No
network request is permitted for Peer DID resolution. A mismatched short form,
invalid input document, key fragment mismatch or unresolved authentication key
fails the entire update entry.

#### `did:web`

A client does not choose an arbitrary fetch URL. The mediator derives the one
standard `did:web` resolution URL from `recipient_did` and uses either an
operator-configured trusted DID resolver or a constrained resolver satisfying
all of these rules:

- HTTPS only; no IP-literal DID authority;
- no userinfo, fragment or query component;
- no redirects;
- DNS results are resolved before connection and every selected address is
  globally routable, excluding loopback, private, link-local, multicast,
  documentation, carrier-grade NAT, metadata-service and other reserved
  ranges for both IPv4 and IPv6;
- the connected address is pinned to the validated DNS result to prevent DNS
  rebinding;
- strict connect, total-time, response-size and decompression limits;
- only the derived `did.json` path is fetched;
- the returned document `id` exactly equals `recipient_did`; and
- the proof `kid` is an authorized authentication method in that document.

A deployment unable to enforce those constraints MUST reject or defer the
registration with `did-resolution-unavailable`; it MUST NOT fall back to an
unrestricted server-side URL fetch. Cache entries are keyed by DID, canonical
document hash and bounded freshness policy. Resolution failure never grants
registration.

`resolution_material` is null for ordinary `did:web` registration. Supplying
client-provided document bytes MAY be used as a cache hint, but does not
replace secure publication resolution.

### 6.3 Registration state

A recipient DID has at most one active mediation account at a mediator.

For `add`:

- absent recipient and available quota: add it;
- same account and same `registration_id`: `no_change`;
- same account and a new valid `registration_id`: atomically replace the ID;
- another account already owns it: `client_error`;
- recipient or registration-rate quota exceeded: reject without mutation.

For `remove`:

- same account and matching active registration ID: remove it;
- absent, another account or stale registration ID: `no_change`.

Removing a recipient affects future `forward` only. Retained mailbox messages
and deliveries remain until expiry. A conforming `recipient-query` response
SHOULD include active `registration_id` beside each recipient DID.


## 7. Routing and mailbox storage extension

### 7.1 Inherited phase-1 envelope profile

This deferred extension inherits `distributed-delivery/1.0` section 3.1
unchanged. In particular, outer `forward` validation, inner encrypted-envelope
normalization, package idempotency, quota atomicity, sender-visible `submitted`
semantics and the no-application-plaintext storage boundary are phase-1 rules,
not replica features.

Enabling replica mediation MUST NOT weaken those rules. The extension changes
only how one already accepted mailbox package is associated with delivery
state. A local DASL CID remains absent from Routing 2.0 and is not disclosed to
the mediator merely to deliver a package.

### 7.2 Atomic fan-out

For a new accepted package, one database transaction MUST:

1. insert the mailbox message and its retention deadline; and
2. create one delivery for every active replica of the mediation account.

The message MUST still be retained when the account currently has no active
replicas. A later `register` with `replay: retained` creates the missing
delivery.

Live delivery happens only after the transaction commits. A failed or lost live
push changes no durable state.

### 7.3 Sender-visible behavior

The sender-visible behavior remains the phase-1 behavior: mediator or HTTP
acceptance is only `submitted`, and ultimate delivery requires an authenticated
application-level ACK. Replica fan-out is deliberately invisible to the
sender.

### 7.4 Recipient-role neutrality

The mediator MUST NOT require a recipient to be classified as rendezvous,
relationship, public, pairwise or server-owned. For routing purposes all
registered recipients have the same shape:

```text
recipient DID -> mediation account -> active replica deliveries
```

The default discovery path gives a peer the long form of a Peer rendezvous DID,
then registers/routes its canonical short form. An optional `did:web` facade
may expose the same mediator through `DIDCommMessaging`. Later traffic to a
pairwise `did:peer:4` may use the same account and storage path or a separate
vault-scoped arrangement for metadata unlinkability.


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
`e.estoc.replica-mediation.replica-required` **after this extension has been
enabled for the account**. Before enablement, a phase-1 account uses ordinary
account-global Message Pickup 3.0. Account-global and replica-scoped pickup
MUST NOT operate concurrently on one enabled mediation account.

An account with zero active replicas may still retain accepted mailbox
messages with zero delivery rows. It cannot perform pickup. The first later
`register(replay=retained)` atomically creates that replica's deliveries for
every unexpired message before pickup becomes possible.

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

A client may acknowledge a delivery through exactly one of two terminal
paths:

1. **normal acceptance** — it decoded and authenticated the inner DIDComm
   envelope, process-durably stored every retained object, and
   process-durably appended the inbound vault observation; or
2. **terminal pre-vault rejection** — it authenticated enough envelope and
   protocol state to classify the delivery safely under a profile such as
   `rendezvous.md`'s hard gate, committed any required bounded local diagnostic,
   and determined that the message MUST be discarded without `message.in`.

The rejection path creates no ultimate peer ACK, contact, application effect or
portable message content. Recipient classification follows the same exact-key
rule as `rendezvous.md`: while unlock/recovery is incomplete, ownership is not
classified; once the local key index is authoritative, a recipient is deferred
only when its complete `kid` maps to a known local key-agreement
method/generation with a concrete recoverable prerequisite. A foreign DID, a
locally controlled DID with a nonexistent or wrong-purpose fragment, a
terminal generation, or a recipient set with no exact local key-agreement
match is terminal wrong-recipient input and may use the rejection ACK path.

A delivery that is genuinely undecryptable despite an exact live local key,
depends on missing recoverable local generation/sync state, or is otherwise
not safely classifiable MUST NOT be acknowledged. This distinction prevents
terminal wrong-recipient or malformed input from redelivering forever without
allowing temporary local incompleteness to lose mail.

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

## 10. Quotas and abuse bounds

A mediator MUST publish and enforce at least:

- maximum active replicas per account;
- maximum registered recipient DIDs per account;
- maximum recipient updates per request and a bounded registration rate;
- maximum normalized encrypted-envelope bytes per mailbox message;
- maximum retained ciphertext bytes and/or retained messages per account;
- maximum pending deliveries per replica and/or account;
- maximum delivery IDs per pickup acknowledgment; and
- message retention seconds.

Ciphertext quota SHOULD count one stored envelope once rather than once per
replica. Delivery-row quota is separate. Replica fan-out and late replay MUST
check delivery quota transactionally.

When any limit prevents accepting a forward, registering a recipient,
registering a replica or creating replay deliveries, the mediator MUST NOT
leave partial state. In particular it MUST NOT store one mailbox message while
creating deliveries for only some active replicas.

Public rendezvous DIDs amplify unauthenticated initiator traffic into
recipient storage, user prompts and potential relationship registrations.
Operators SHOULD support per-account and per-recipient rate limits in addition
to hard storage caps. An authenticated administration or discovery response
MAY expose current usage, but anonymous routing behavior SHOULD remain
uniform enough not to become a precise account-existence oracle.


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
| `e.estoc.replica-mediation.replica-retired` | replica ID is terminal; current client must re-incarnate under section 5.7 |
| `e.estoc.replica-mediation.too-many-replicas` | active replica limit reached; client must list and explicitly retire IDs |
| `e.estoc.replica-mediation.too-many-recipients` | registered recipient limit reached |
| `e.estoc.replica-mediation.too-many-deliveries` | fan-out or replay delivery limit reached |
| `e.estoc.replica-mediation.registration-rate` | recipient registration rate exceeded |
| `e.estoc.replica-mediation.recipient-proof` | recipient-control proof failed |
| `e.estoc.replica-mediation.recipient-conflict` | another account owns the recipient |
| `e.estoc.replica-mediation.did-resolution-unavailable` | recipient DID could not be safely resolved now |
| `e.estoc.replica-mediation.unsafe-did-resolution` | requested resolution would violate resolver policy |
| `e.estoc.replica-mediation.message-too-large` | normalized envelope exceeds the limit |
| `e.estoc.replica-mediation.quota` | another advertised storage limit is exhausted |

A mediator MAY intentionally give no DIDComm problem report for an
anonymous Routing 2.0 `forward`, so as not to create a route oracle.

## 13. Required conformance cases

A conforming implementation demonstrates at least these cases:

1. Two active replicas receive distinct delivery IDs for one stored
   ciphertext; A's ACK leaves B pending.
2. A late replica obtains every unexpired retained message, including when all
   older replicas ACKed.
3. Concurrent replica registration and forwarding cannot omit the new
   replica's delivery.
4. Crash before durable normal acceptance produces no pickup ACK; crash after
   commit may redeliver and converges logically.
5. A safely classified terminal pre-vault rejection may be pickup-ACKed without
   `message.in`, while an undecryptable or deferred delivery remains pending.
6. Repeating one `forward.id` with identical normalized bytes stores no second
   message; different bytes never overwrite the first.
7. `recipient_did` actually filters status and delivery.
8. A retired/unknown replica cannot inspect or ACK another replica's queue.
9. With zero active replicas, ciphertext remains retained with zero deliveries;
   all pickup without a registered active `replica_id` fails and there is no
   account-global fallback.
10. First later registration atomically creates retained deliveries before
   pickup is possible.
11. Plain, signed-only, linked or structurally invalid inner attachments are
    not persisted as mailbox messages.
12. Database, object storage, logs and traces do not contain an application
    plaintext sentinel or content key.
13. Replica protocol messages reveal no hardware/OS identifier or human label.
14. A default Peer rendezvous recipient, optional Web rendezvous recipient and
    pairwise Peer recipient receive identical fan-out/ACK isolation.
15. Recipient, replica and delivery quotas fail atomically without partial
    state.
16. Peer DID long-form material is decoded locally, its canonical short form
    exactly matches registration/proof payload, and proof key authorization
    verifies after normalization.
17. `did:web` proof resolution uses only the constrained resolver and never
    unrestricted server-side URL fetching.
18. No public document or application message uses replica ID as peer-visible
    recipient.
19. Adding/removing a server full replica changes delivery rows only, not
    recipient DIDs.
20. Without an advertised inactivity policy, age alone never retires a
    replica. With one, the server applies the exact disclosed bound and reason
    `inactivity-policy`.
21. A local copy whose current ID is server-retired stops using it, atomically
    mints new replica/store-generation IDs, preserves old-author events,
    registers the fresh ID on every required mediation and obtains retained
    replay.
22. A restore lists replicas and explicitly retires selected stale IDs rather
    than silently reusing or evicting one.
23. Recipient-key triage defers only an exact known local key-agreement
    method/generation with a recoverable missing prerequisite. After local key
    recovery is authoritative, foreign DIDs, nonexistent or wrong-purpose
    local fragments and terminal generations may use the terminal pre-vault ACK
    path and do not remain pending.
