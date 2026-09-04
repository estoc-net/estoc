# distributed-delivery/1.0

Status: **draft** — Estoc delivery profile for application messages sent
by trusted full replicas of one vault.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

## 1. What it is for

An Estoc message begins as a durable vault decision. Network resolution,
encryption, mediation and retries are consequences of that decision and may
happen later on any full replica. Several replicas may race to send or
receive the same logical message; the observable conversation must still
contain one message, not one per replica.

This profile defines:

- the addressing boundary between public rendezvous, pairwise relationships
  and replicas;
- the distinct IDs used by the application, encryption package and mediator
  delivery;
- when a sender may call a message submitted or acknowledged;
- end-to-end durable receipt using DIDComm `please_ack` and `ack`;
- duplicate and conflict handling across replicas; and
- idempotency requirements for automatic handlers.

It does not define mailbox fan-out (`replica-mediation/1.0`), public-to-
pairwise bootstrap (`rendezvous/1.0`) or event/blob replication
(`vault-sync/1.0`).

## 2. Terms

- **Full replica** — one independently writable incarnation of a vault that
  holds the seed and appends vault events. It may run in a local application
  or on a server. It is not a hardware identity or authorization boundary.
- **Rendezvous DID** — a public vault-scoped DID used to discover and begin a
  relationship.
- **Relationship DID** — a vault-scoped pairwise DID used for one ongoing
  relationship.
- **Message ID (`mid`)** — the vault entity ID of a logical message. An
  outbound `mid` is minted once with the intent. An inbound `mid` is
  deterministically derived so that several replicas converge on the same
  vault entity.
- **Wire ID** — the innermost DIDComm plaintext message's `id`. It names one
  logical application message and remains stable across retries and
  repackaging.
- **Package ID** — the Routing 2.0 `forward.id` for one exact encrypted inner
  envelope. Re-encryption creates a new package ID.
- **Delivery ID** — a mediator-generated, per-replica opaque attachment ID
  used only by Message Pickup.
- **Submitted** — a transport endpoint accepted one package attempt.
- **Acknowledged** — the ultimate peer authenticated an ACK for the wire ID
  after durably accepting the message.
- **Logical channel** — the local recipient key plus authenticated peer key,
  with contact-scoped DID transitions followed as defined by the vault.

The IDs are deliberately different:

```text
one logical message (wire ID)
    ├── package P1: exact ciphertext for recipient key K1
    │      ├── mediator delivery D1 to replica A
    │      └── mediator delivery D2 to replica B
    └── package P2: re-encrypted later for recipient key K2
           ├── mediator delivery D3 to replica A
           └── mediator delivery D4 to replica B
```

## 3. Addressing layers

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

Estoc version 3 recognizes two communication roles:

```text
rendezvous DID
    public, reusable, normally did:web
    used only to begin unrelated relationships

relationship DID
    pairwise, normally did:peer
    used for ordinary traffic after bootstrap
```

Both are vault-scoped. Every full replica can derive their private keys and
receive messages addressed to them. A web service holding the seed is merely
another full replica; it does not own the public DID or pairwise DIDs.

A DID may advertise a mediated or direct delivery route. This changes only
transport:

```text
peer -> recipient DID -> direct endpoint -> vault runtime
```

or:

```text
peer -> recipient DID -> mediator -> per-replica delivery
```

The innermost `to`, logical channel, wire ID, package ID and receiving fold
are unchanged. A direct endpoint MUST NOT expose a replica ID as the
application recipient. When several routes are advertised, a sender sends a
package through one selected route and may try another after failure; it
must not intentionally create one conversation message per route.

A mediator or vault ingress MAY use `replica_id` internally to push an
already addressed delivery to one authenticated live replica. That internal
selection occurs after peer-facing DID addressing: it MUST NOT change the
innermost `to`, create a replica-specific application address, or remove the
durable mailbox delivery before that replica acknowledges it.

After `rendezvous/1.0` succeeds, the public DID is replaced only inside that
relationship context. The public DID remains active for other initiators.

## 4. Vault-first sending

The public send operation of a full vault runtime MUST be able to commit
while DNS, DID resolution and every mediator are unavailable. Before
starting any required network effect, it MUST durably record:

- a newly minted message ID (`mid`);
- a newly minted wire ID;
- contact or conversation target;
- message type and thread headers;
- body and attachment roots; and
- the user's decision to send.

A successful vault commit does not imply the message has been encrypted or
submitted. Any full replica that later observes the pending decision MAY
prepare and submit it.

Correctness MUST NOT depend on one replica remaining online or on a mutable
entry under `local/`.

A remote thin client that lacks the seed may stage a command while offline,
but that staging is not a vault commit. The command becomes authoritative
only when a full vault runtime durably appends `message.out`. A future client
access protocol may define such commands without changing this delivery
profile.

## 5. Preparing a package

To prepare a message, a replica folds the target contact, chooses its current
peer DID and relationship channel, constructs the innermost plaintext, and
encrypts it for the ultimate recipient. The plaintext `id` MUST be the
recorded wire ID.

Unless an application protocol explicitly provides an equivalent receipt
rule, every Estoc application message MUST include:

```json
{ "please_ack": [""] }
```

The empty string requests acknowledgment of the current message under
DIDComm Messaging 2.1. This header is on the innermost application message.
It MUST NOT be copied onto Routing 2.0 `forward` wrappers.

The canonical innermost plaintext and authenticated sender identity MUST
remain identical for every package of one logical message. Repacking may
change the ultimate recipient encryption key, cryptographic randomness and
outer routing, but it MUST NOT change application plaintext, `from`, `to` or
sender key generation. An application protocol may impose a stricter
recipient-key pin; `rendezvous/1.0` does so for one request wire ID.

The exact encrypted inner envelope is stored as a vault blob before the
package becomes eligible for network submission. A package record names:

- wire ID;
- package ID;
- local sender DID and key;
- ultimate recipient DID and key resolution used;
- canonical plaintext hash;
- encrypted-envelope blob root; and
- normalized encrypted-envelope hash.

Every retry of the same package ID MUST use byte-for-byte the same normalized
encrypted envelope. If the ultimate recipient key or packing parameters
change, the sender creates a new package ID while preserving the wire ID and
canonical plaintext.

The Routing 2.0 `forward.id` MUST equal the package ID. This makes an
identical submission idempotent at an Estoc mediator.

## 6. Submission and retry

A transport success, including an HTTP 2xx from a mediator, records only
`submitted`. It is not proof that:

- the route existed;
- the mediator retained the package;
- any recipient replica fetched it; or
- the ultimate peer durably accepted the message.

Until acknowledged or explicitly held, any full replica MAY retry a pending
package with exponential backoff and jitter. Races between replicas are
permitted. Correctness comes from stable IDs and receiving idempotency, not
from a distributed send lock.

A sender SHOULD prefer retrying the latest prepared package. It MAY keep
older packages eligible until an ACK arrives when a key or route transition
makes either package plausibly useful.

An explicit user or policy hold stops automatic retries vault-wide. A hold is
not a delivery result.

## 7. Durable end-to-end acknowledgment

A receiving replica honors `please_ack` only after it has:

1. authenticated and validated the innermost DIDComm message;
2. durably stored the retained body and attachment blobs;
3. durably appended the inbound logical message observation; and
4. made the observation visible to ordinary vault recovery after a process
   crash.

It need not wait for:

- another local handler;
- user rendering or reading;
- upload to `vault-sync/1.0`; or
- another replica to receive the same package.

If the application protocol has a natural response, the receiver SHOULD
place the original wire ID in that response's DIDComm `ack` header. Otherwise
it sends the standard empty message:

```json
{
  "id": "21559fb4-1a9f-54b1-b8fa-1bf82700d365",
  "type": "https://didcomm.org/empty/1.0/empty",
  "thid": "019b1b61-1ff1-74d7-a3d6-c493db8e5032",
  "ack": ["019b1b61-1ff1-74d7-a3d6-c493db8e5032"],
  "body": {}
}
```

A pure ACK MUST NOT contain `please_ack`. Its message ID MUST be the stable
automatic wire ID derived from the acknowledged inbound message under
`vault-events.md`, so concurrent replicas emit one logical ACK. A receiver
MUST NOT honor more than one acknowledgment request for one logical message
with an unbounded series of pure ACKs.

An authenticated ACK received on the same relationship channel, or on a
valid contact-scoped continuation of it, acknowledges every wire ID named in
its `ack` array. The sender records acknowledgment idempotently. One valid
ACK from any ultimate peer replica is sufficient to stop automatic retry of
every package for that wire ID.

Acknowledgment means durable receipt by the peer vault. It does not mean
read, displayed, accepted by a business workflow, or copied to every peer
replica.

## 8. Receiving identity and duplicates

For an authenticated incoming message, the receiver computes:

```text
logical_key = ("authenticated", authenticated peer key, wire ID)
content_hash = SHA-256(RFC 8785 canonical innermost plaintext)
```

For signed but not authcrypted messages, the authenticated signing key is the
peer key. For a truly anonymous message, the receiver instead uses:

```text
logical_key = ("anonymous", local recipient key, wire ID)
```

The authenticated form intentionally omits the local recipient key. A retry
encrypted to another key generation or another local DID of the same
receiving vault therefore remains one logical message when the authenticated
peer identity and wire ID are unchanged. Applications SHOULD apply stricter
replay limits to anonymous messages because an anonymous sender can
intentionally reuse another anonymous message ID.

The fold applies these rules:

- same `logical_key` and same `content_hash`: one logical message with
  several transport or replica observations;
- same `logical_key` and different `content_hash`: integrity conflict;
  preserve both observations, execute no automatic side effect, and surface
  the conflict;
- different authenticated peer key: different logical channel unless a
  valid contact-scoped transition joins them.

A repeated package may therefore be decrypted and durably observed by more
than one replica without appearing as several conversation messages.

Pickup acknowledgment is per transport delivery. Every replica that persists
a duplicate may independently ACK its mediator delivery even when the
logical message already exists in the merged vault.

## 9. Rendezvous handoff

`rendezvous/1.0` is an application protocol carried by this delivery profile.
Its request is sent:

```text
from initiator relationship DID
  to responder public rendezvous DID
```

Its acceptance is sent:

```text
from responder relationship DID
  to initiator relationship DID
  with from_prior: responder public DID -> responder relationship DID
```

The request and acceptance obey the same offline intent, package retry,
deduplication and acknowledgment rules as every other message.

The public-to-pairwise transition is stored with `scope == relationship` and
a contact ID. It MUST NOT globally merge all relationship DIDs that can prove
the same public predecessor. Once the handoff is acknowledged, ordinary
traffic for that contact uses the relationship DIDs; loss of the public web
publisher does not interrupt the established relationship.

## 10. Automatic effects

Delivery is at least once and active replicas may process the same logical
message concurrently. Every automatic effect MUST therefore have an
idempotency key derived from stable logical input, for example:

```text
effect_id = base64url(
  SHA-256(
    UTF8("estoc/effect/1\0") ||
    UTF8(mid) || 0x00 ||
    UTF8(handler_id) || 0x00 ||
    UTF8(effect_kind) || 0x00 ||
    UTF8(decimal_ordinal)
  )
)
```

Effects that emit DIDComm messages MUST derive or persist a stable output
wire ID from `effect_id`. Concurrent replicas may encrypt and submit separate
packages, but they emit the same logical response.

Effects that modify an external system MUST pass `effect_id` to that system's
idempotency facility or explicitly document at-least-once side effects.
Estoc does not claim distributed exactly-once execution.

Contact adoption, rendezvous acceptance and other automatic creation MUST
use the deterministic identities in `vault-events.md` and `rendezvous/1.0`.
Two replicas must not leave two permanent contacts or pairwise DIDs merely
because they handled the same message separately.

## 11. Required vault observations

The exact event names are defined by `vault-events.md`, but a conforming vault
model MUST be able to represent these distinct facts:

```text
message.out             vault-first durable intent, no network required
message.prepared        exact encrypted package is durable
message.packageRetired  one obsolete package is no longer retried
delivery.submitted      a package transport attempt was accepted
delivery.failed         a package attempt failed
delivery.acknowledged   ultimate peer ACK named the wire ID
delivery.held           explicit policy or user decision to stop retry
delivery.released       one explicit hold is released
message.in              durable logical inbound observation
peer.transitioned       one contact moved from a public or old DID to a new DID
relationship.established responder accepted one rendezvous request
```

`delivery.submitted` MUST NOT remove a message from the set awaiting ultimate
acknowledgment. A message imported or synchronized from another replica MUST
NOT be held merely because another author created it.

A recommended `message.in` payload includes:

```json
{
  "mid": "<deterministic inbound message id>",
  "wireId": "<innermost message id>",
  "contentHash": "<base64url sha-256>",
  "myKey": "did/019b.../key-agreement/0",
  "peerKey": "k3j9...",
  "receivedVia": {
    "mediation": "019b...",
    "deliveryId": "019b..."
  }
}
```

For authenticated inbound messages, `mid` MUST be derived exactly as
specified by the vault-events document from the authenticated peer key and
wire ID. Replica observations of the same logical message therefore use the
same `mid`. The `wireId` remains the peer-selected DIDComm identifier and
MUST remain separately stored.

## 12. Failure rules

- Failure before outbound intent commit: no vault message exists.
- Failure after intent commit but before preparation: any replica may prepare
  it later.
- Failure after package storage but before submission observation: the same
  package may be submitted again.
- Failure after mediator acceptance but before `submitted` observation:
  retrying the same package is idempotent.
- Failure after inbound commit but before pickup ACK: redelivery is expected
  and is a duplicate observation.
- Failure after pickup ACK but before ultimate ACK submission: another
  replica or a later retry may send the ultimate ACK; the sender keeps
  retrying meanwhile.
- Loss of every recipient replica for longer than mediator retention may lose
  the in-flight package. The sender's durable retry loop and ultimate ACK are
  the reliability boundary.
- Loss of a rendezvous web publisher prevents new discovery but does not
  invalidate an established relationship DID or its mediator route.

## 13. Privacy

Wire IDs, relationship IDs in DIDComm headers, application types and message
content are visible only inside end-to-end encrypted application messages.
Package IDs and recipient routing DIDs are visible to the mediator. Delivery
IDs and replica IDs are visible to the recipient's mediator.
Implementations SHOULD NOT make any of these IDs encode contact names,
replica labels, event IDs or content.

The rendezvous DID is intentionally public and correlatable. Relationship
DIDs SHOULD be disclosed only over encrypted channels and MUST NOT appear in
reusable public invitations.

Pure ACKs are application messages and reveal receipt timing to the ultimate
peer. They do not reveal which replica received first.

## 14. Required conformance cases

1. An application can commit `message.out` with all networking disabled.
2. A peer addresses a rendezvous or relationship DID and never a replica ID.
3. Two replicas prepare or submit one intent without producing two logical
   wire IDs.
4. Retrying one package uses identical envelope bytes and package ID.
5. Repacking for a changed recipient key uses a new package ID and the
   original wire ID, canonical plaintext and authenticated sender identity.
6. HTTP or mediator acceptance records `submitted`, never `acknowledged`.
7. A receiver emits an ACK only after durable inbound commit.
8. Two replicas receiving the same plaintext produce one logical message
   after event convergence.
9. Reuse of a wire ID with different canonical plaintext produces an
   integrity conflict and no automatic effect.
10. Duplicate ACKs are harmless and any valid ultimate ACK stops every
    package retry for that wire ID.
11. A rendezvous acceptance moves one contact to one relationship DID without
    retiring or globally replacing the public DID.
12. A direct and mediated route for the same DID enter the same inbound fold
    and do not create separate conversation messages.
13. A crash at every boundary in §12 loses neither a committed outbound
    intent nor an unacknowledged inbound delivery.
