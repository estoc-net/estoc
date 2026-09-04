# distributed-delivery/1.0

Status: **draft** — Estoc delivery profile for application messages sent by
trusted full replicas of one vault.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

## 1. What it is for

An Estoc message begins as a durable vault decision. Network resolution,
address selection, encryption, mediation and retry are effects of that
decision and may happen later on any full replica. Several replicas may race
to send or receive the same logical message; the observable conversation
must still contain one message rather than one per replica or package.

This profile defines:

- the addressing boundary between public rendezvous, pairwise relationships
  and replicas;
- the distinct IDs and hashes used for logical content, immutable intent,
  exact DIDComm plaintext, encrypted packages and mediator deliveries;
- which DIDComm headers are frozen at intent time and which may vary only as
  validated package addressing evidence;
- when a sender may call a message submitted or acknowledged;
- expiration and terminal retry behavior compatible with offline queues;
- end-to-end durable receipt using DIDComm `please_ack` and `ack`;
- duplicate and conflict handling across replicas; and
- idempotency requirements for automatic handlers.

It does not define mailbox fan-out (`replica-mediation/1.0`), public-to-
pairwise bootstrap (`rendezvous/1.0`) or event/blob replication
(`vault-sync/1.0`).

## 2. Terms

- **Full replica** — one independently writable incarnation of a vault that
  holds the seed and appends vault events. It may run locally or on a server.
- **Rendezvous DID** — a public vault-scoped DID used to begin unrelated
  relationships.
- **Relationship DID** — a vault-scoped pairwise DID used for one ongoing
  relationship.
- **Message ID (`mid`)** — the vault entity ID of one logical message. An
  outbound `mid` is minted once with the intent. An inbound `mid` is
  deterministically derived so replicas converge on the same entity.
- **Wire ID** — the innermost DIDComm plaintext message's `id`. It remains
  stable across retries and permitted repackaging.
- **Semantic projection** — the application meaning of a DIDComm message:
  `id`, `type`, `thid`, `pthid`, body and ordered logical attachments.
- **Semantic hash** — the hash of the semantic projection.
- **Intent projection** — the semantic projection plus the immutable
  message-level control headers recorded by `message.out`: `created_time`,
  `expires_time`, `please_ack`, `ack`, and the `headers` map of additional
  DIDComm top-level fields.
- **Intent hash** — the hash of the intent projection.
- **Plaintext hash** — the hash of one exact complete innermost DIDComm
  plaintext, including package addressing and security headers such as
  `from`, `to` and `from_prior`.
- **Package ID** — the Routing 2.0 `forward.id` for one exact encrypted inner
  envelope. A different complete plaintext, recipient key or encryption
  result requires a new package ID.
- **Delivery ID** — a mediator-generated, per-replica opaque attachment ID
  used only by Message Pickup.
- **Submitted** — a transport endpoint accepted one package attempt.
- **Acknowledged** — the ultimate peer authenticated an `ack` naming the wire
  ID after durably accepting the message.
- **Logical channel** — the local recipient key plus authenticated peer key,
  with contact-scoped DID transitions followed by the vault fold.

The identifiers and hashes are intentionally different:

```text
one logical message (mid, wire ID, semantic hash, intent hash)
    ├── package P1
    │     exact plaintext hash H1
    │     exact encrypted envelope E1
    │       ├── mediator delivery D1 to replica A
    │       └── mediator delivery D2 to replica B
    └── package P2 after a permitted address/key transition
          exact plaintext hash H2
          exact encrypted envelope E2
            ├── mediator delivery D3 to replica A
            └── mediator delivery D4 to replica B
```

`H1` and `H2` may differ while the semantic and intent hashes remain equal.

## 3. Addressing layers

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

Estoc version 3 recognizes:

```text
rendezvous DID
    public, reusable, normally did:web
    used only to begin unrelated relationships

relationship DID
    pairwise, normally did:peer:4
    used for ordinary traffic after bootstrap
```

Both are vault-scoped. Every full replica can derive their private keys and
receive messages addressed to them. A web service holding the seed is an
ordinary full replica; it does not own the public or pairwise DIDs.

A DID may advertise mediated or direct routes. Route choice changes only
transport. A direct endpoint MUST NOT expose a replica ID as the application
recipient. When several routes are advertised, a sender submits one package
through one selected route and may try another after failure; it does not
create one application message per route.

A mediator or vault ingress MAY use `replica_id` internally after DID
addressing to deliver the already encrypted package to an authenticated live
replica. This MUST NOT alter the innermost recipient or remove that replica's
durable delivery before pickup acknowledgment.

After `rendezvous/1.0` succeeds, the public DID is replaced only inside the
named relationship. It remains active for other initiators.

## 4. Vault-first sending

A full vault runtime MUST be able to commit a send while DNS, DID resolution
and every mediator are unavailable. Before required network work it MUST
durably record:

- a message ID and wire ID;
- target contact or explicit channel;
- message type, thread and parent-thread IDs;
- body and ordered logical attachments;
- immutable `createdTime`;
- immutable `expiresTime` or null;
- immutable `pleaseAck` and `ack` arrays; and
- the user or deterministic handler decision to send.

`createdTime` is a durable protocol timestamp selected as part of the intent.
A user-authored message normally uses the commit-time clock; a deterministic
automatic protocol MAY derive it from the triggering message so concurrent
replicas agree. It is not a transport freshness proof. A protocol may impose
a maximum lifetime by constraining `expiresTime - createdTime`. A receiver MUST NOT reject an otherwise valid,
unexpired message merely because `created_time` lies outside a clock-skew
window.

A successful vault commit does not imply resolution, encryption or
submission. Any full replica that later observes the pending decision may
prepare and submit it. Correctness MUST NOT depend on one replica remaining
online or on mutable state under `local/`.

A remote thin client without the seed may stage a command while offline, but
that is not a vault commit. The command becomes authoritative only when a
full vault runtime durably appends `message.out`.

## 5. Canonical projections and hashes

### 5.1 Semantic projection

For an innermost plaintext `M`, define:

```json
{
  "id": "<M.id>",
  "type": "<M.type>",
  "thid": null,
  "pthid": null,
  "body": {},
  "attachments": []
}
```

The values are copied from `M`; absent `thid`, `pthid`, body or attachments
are represented exactly as required by the application profile, with null or
an empty value as specified by `vault-events.md`. Attachment entries are the
ordered logical DIDComm attachment descriptors before encryption.

The semantic projection deliberately excludes:

```text
typ, from, to, created_time, expires_time,
please_ack, ack, from_prior, return_route
```

`semanticHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for that projection.

### 5.2 Intent projection

The intent projection is:

```json
{
  "semantic": {
    "id": "<wire ID>",
    "type": "<message type>",
    "thid": null,
    "pthid": null,
    "body": {},
    "attachments": []
  },
  "created_time": 1788442800,
  "expires_time": null,
  "please_ack": [""],
  "ack": [],
  "headers": {}
}
```

These control fields are copied from durable `message.out`. `headers` is an
RFC 8785 JSON object containing every permitted top-level DIDComm header not
represented by a dedicated field. For inbound messages, an absent time is
normalized as null, an absent acknowledgment header as an empty array, and no
additional header as an empty object. Both acknowledgment arrays MUST contain
unique strings and their
wire order is preserved by the intent projection. In particular, an `ack`
array follows DIDComm's oldest-to-newest receive order; it is never sorted
lexicographically. The empty string MAY appear at most once in `please_ack` to
mean the current message and MUST NOT appear in `ack`. Outbound `message.out`
stores the exact ordered arrays. A preparer MUST NOT substitute its clock,
reorder either array, or opportunistically add an acknowledgment. Automatic
effects include only protocol-mandated acknowledgments of their triggering
messages, not unrelated pending ACKs.

`intentHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for this projection. Any difference in an additional durable header is an
intent difference, not a package-only variation.

### 5.3 Exact plaintext hash

`plaintextHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for the complete innermost DIDComm plaintext actually encrypted by one
package. It includes `from`, `to`, `from_prior` and every other present
header.

All packages for one `mid` MUST have equal `semanticHash` and `intentHash`.
They are not required to have equal `plaintextHash` when a permitted address
or contact-scoped transition changes package-level fields.

## 6. Preparing a package

A replica folds the target, chooses a currently valid sender DID and peer
address, constructs the complete innermost plaintext, validates it against
the application protocol and encrypts it for the ultimate recipient.

Unless an application protocol provides an equivalent terminal receipt rule,
every Estoc application intent SHOULD record:

```json
{ "pleaseAck": [""] }
```

The resulting innermost header is `"please_ack":[""]`. It MUST NOT be copied
onto a Routing 2.0 `forward` wrapper.

The preparer MUST copy `created_time`, `expires_time`, `please_ack`, `ack`,
`headers`, `id`, `type`, `thid`, `pthid`, body and attachments from the durable
intent. It MUST NOT generate `created_time: now` at preparation time.

Version 1.0 uses a closed outbound header profile:

- `typ` is always `application/didcomm-plain+json`;
- `id`, `type`, `from`, `to`, `created_time` and `body` are emitted;
- `thid`, `pthid`, `expires_time` and `from_prior` are omitted when null;
- `please_ack`, `ack` and `attachments` are omitted when empty; and
- every entry in `headers` is emitted as a top-level member.

`headers` MUST NOT contain any reserved member named above. An implementation
MUST reject preparation of an unsupported or unpersisted top-level header; it
must never silently invent, drop or default one. A later protocol version may
classify another package-only header explicitly, but version 1.0 treats every
additional header as immutable intent.

`from`, `to` and `from_prior` are package-level addressing and security
evidence. They may differ between packages for one intent only when all of
the following hold:

1. the semantic and intent projections remain unchanged;
2. the target remains the same contact or explicit logical channel;
3. the change follows a valid selected DID/key generation or a verified
   contact-scoped continuation;
4. every package is independently valid under the application protocol; and
5. the new complete plaintext receives a new package ID and plaintext hash.

A protocol may impose stricter pinning. In particular, one
`rendezvous/1.0/request` wire ID pins the exact public DID resolution snapshot,
public key generation and application `to`; changing them requires a new
request wire ID.

The exact encrypted inner envelope MUST be stored as a vault blob before the
package is eligible for submission. A package record names:

- message ID and wire ID;
- semantic, intent and plaintext hashes;
- package ID;
- local sender DID and key;
- ultimate recipient DID and resolution evidence;
- exact encrypted-envelope blob root; and
- normalized encrypted-envelope hash.

Every retry of one package ID MUST reuse byte-for-byte the same normalized
encrypted envelope. Any change to complete plaintext, recipient key,
cryptographic randomness or packing creates a new package ID. The Routing
2.0 `forward.id` MUST equal that package ID.

## 7. Expiration, submission and retry

Before preparing or submitting, a worker evaluates the durable expiry:

- when `expiresTime == null`, the message has no application expiry;
- when `now < expiresTime`, ordinary retry policy applies; and
- when `now >= expiresTime`, the worker MUST submit no new package or retry.

On expiry it appends a message-scoped, non-retryable `delivery.failed` with
`code == "expired"`. A new attempt after expiry requires a new outbound
intent and wire ID. Existing submitted packages may still produce late
inbound or ACK observations, which remain history but do not restart retry.

A transport success, including HTTP 2xx from a mediator, records only
`submitted`. It does not prove that the route existed, the mediator retained
the package, a recipient replica fetched it or the ultimate peer committed
it.

Until acknowledged, held, expired or otherwise terminated by a
message-scoped non-retryable failure, any full replica MAY retry an eligible
package with exponential backoff and jitter. Races between replicas are
permitted. Stable IDs, exact package bytes and receiver idempotency provide
correctness; a distributed send lock is only an optimization.

A package-scoped non-retryable failure retires that package but may allow a
new package for the same message. A message-scoped non-retryable failure ends
automatic work for the whole intent unless an explicit protocol event creates
a replacement intent. Sensitive error strings remain local; portable failure
codes are stable and non-secret.

## 8. Durable end-to-end acknowledgment

A receiving replica honors `please_ack` only after it has:

1. authenticated and validated the complete innermost DIDComm plaintext;
2. durably stored the retained body and attachment blobs;
3. durably appended the inbound logical message observation; and
4. made that observation recoverable after process failure.

It need not wait for another handler, rendering, `vault-sync/1.0`, or another
replica.

A natural application response that completes the request MUST place the
request wire ID in its DIDComm `ack` array. Otherwise the receiver sends the
standard empty message:

```json
{
  "id": "21559fb4-1a9f-54b1-b8fa-1bf82700d365",
  "type": "https://didcomm.org/empty/1.0/empty",
  "from": "did:peer:4zQm...alice-short",
  "to": ["did:peer:4zQm...bob-short"],
  "thid": "019b1b61-1ff1-74d7-a3d6-c493db8e5032",
  "ack": ["019b1b61-1ff1-74d7-a3d6-c493db8e5032"],
  "body": {}
}
```

A pure ACK MUST NOT request another ACK. Its `mid` and wire ID are stable
automatic IDs derived from the acknowledged inbound message. Concurrent
replicas therefore emit one logical ACK even if they submit several packages.

An authenticated inbound message received on the same relationship channel,
or a valid contact-scoped continuation, acknowledges every locally known
outbound wire ID named in its `ack` array. ACK handling is idempotent. A value
that does not name a known outbound wire ID has no delivery effect.

One valid ultimate ACK from any peer replica stops retry of every package for
that outbound wire ID. Acknowledged means durable receipt by the peer vault;
it does not mean read, displayed, accepted by a business workflow or copied
to every peer replica.

A threaded response is not implicitly an Estoc delivery acknowledgment.
When it completes an acknowledged request, it MUST carry the explicit `ack`
array. `rendezvous/1.0/accept` and `decline` follow this rule.

## 9. Receiving identity, duplicates and control variants

For an authenticated or signed incoming message:

```text
logical_key = ("authenticated", authenticated peer key, wire ID)
```

For a truly anonymous message:

```text
logical_key = ("anonymous", local recipient key, wire ID)
```

The receiver computes `semanticHash`, `intentHash` and `plaintextHash` using
§5. The authenticated key deliberately namespaces the wire ID; the local
recipient key is omitted in the authenticated form so a valid repack to
another accepted local DID/key can converge.

The fold applies:

- same logical key and same semantic hash and intent hash: one logical message
  with several package, route or replica observations;
- same logical key and different semantic hash: application-content integrity
  conflict;
- same logical key and same semantic hash but different intent hash: control-
  intent integrity conflict;
- different plaintext hashes with equal semantic and intent hashes: allowed
  only when every observation's package-level addressing and security
  evidence validates; otherwise an integrity conflict;
- different authenticated peer key: different logical channel unless valid
  contact-scoped evidence joins them.

On an integrity conflict the vault preserves observations, suppresses
automatic application effects and does not process disputed `ack` or
`please_ack` headers until application policy resolves the conflict.

When semantic and intent hashes agree, each authenticated complete plaintext
observation may contribute idempotent package-level evidence such as a valid
`from_prior`. The stable `ack` and `please_ack` arrays are already protected
by the intent hash and therefore cannot be expanded by a repack without
creating a conflict.

Pickup acknowledgment remains per transport delivery. Every replica that
durably stores a duplicate may independently ACK its mediator delivery even
when the merged vault already contains the logical message.

## 10. Rendezvous handoff

`rendezvous/1.0` is carried by this profile.

A request is sent from the initiator relationship DID to the responder public
DID. It records `pleaseAck == [""]`. An `accept`, `decline` or authenticated
request-triggered problem response explicitly records the request wire ID in
its `ack` array; threading alone is insufficient.

Acceptance is sent from the responder relationship DID to the initiator
relationship DID with `from_prior` proving the public-to-pairwise handoff.
The transition is contact-scoped and does not retire the public DID.

Before handoff confirmation, only request-specific `accept` packages may be
prepared from the new responder relationship DID. Ordinary content may remain
queued, but package preparation is deferred. After one accept is ultimately
acknowledged, ordinary traffic may use the pairwise DID without bootstrap
`from_prior`.

A replacement rendezvous request may use a new wire ID while reusing the same
initiator key. The responder derives its stable relationship/contact from the
public DID and authenticated initiator key, not the request wire ID. Each
request still receives its own threaded response and explicit ACK.

## 11. Automatic effects

Delivery is at least once and replicas may process one logical message
concurrently. Every automatic effect MUST have an idempotency key derived
from stable logical input, for example:

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

Effects emitting DIDComm messages derive or persist stable output `mid` and
wire IDs. Effects modifying external systems pass `effect_id` to an
idempotency facility or explicitly document at-least-once behavior. Estoc
does not claim distributed exactly-once execution.

Rendezvous acceptance and decline use the stricter derivations in
`rendezvous/1.0`. Stable relationship state is independent of request wire
ID; response effects are request-specific.

## 12. Required vault observations

The exact schemas are defined in `vault-events.md`. A conforming vault MUST
represent:

```text
message.out                 durable intent and immutable control headers
message.prepared            one exact complete plaintext and encrypted package
message.packageRetired      one package is no longer retried
delivery.submitted          a transport endpoint accepted a package
delivery.failed             retryable or terminal package/message failure
delivery.acknowledged       ultimate peer ACK named the wire ID
delivery.held               explicit policy or user hold
delivery.released           release of one exact hold
message.in                  durable logical inbound observation
peer.transitioned           one contact-scoped DID continuation
rendezvous.requestDecided   one durable admission decision per request
relationship.established    stable relationship independent of request retry
```

`delivery.submitted` does not remove a message from the set awaiting ultimate
acknowledgment. A synchronized outbound is not held merely because another
author created it.

A recommended inbound event records all three hashes and the durable control
headers:

```json
{
  "mid": "<deterministic inbound message id>",
  "wireId": "<innermost message id>",
  "semanticHash": "<base64url sha-256>",
  "intentHash": "<base64url sha-256>",
  "plaintextHash": "<base64url sha-256>",
  "createdTime": 1788442800,
  "expiresTime": null,
  "pleaseAck": [""],
  "ack": [],
  "myKey": "did/019b.../key-agreement/0",
  "peerKey": "k3j9...",
  "receivedVia": {
    "mediation": "019b...",
    "deliveryId": "019b..."
  }
}
```

## 13. Failure rules

- Before outbound intent commit, no vault message exists.
- After intent commit but before preparation, any replica may prepare later.
- After package storage but before submission observation, the exact package
  may be submitted again.
- After mediator acceptance but before `submitted`, retrying that package is
  idempotent.
- If expiry is reached before prepare or retry, no package is submitted and a
  message-scoped non-retryable `expired` failure is recorded.
- After inbound commit but before pickup ACK, redelivery is expected and
  converges as another observation.
- After pickup ACK but before ultimate ACK submission, another replica or a
  later retry may send the ultimate ACK; the sender continues meanwhile.
- Loss of every recipient replica for longer than mediator retention may lose
  an in-flight package. Sender retry until ultimate ACK is the reliability
  boundary.
- Loss of a rendezvous web publisher prevents new discovery but does not
  invalidate an established relationship DID.

## 14. Privacy

Wire IDs, relationship IDs in application headers, types and content are
visible only inside end-to-end encrypted application messages. Package IDs
and recipient routing DIDs are visible to the mediator. Delivery IDs and
replica IDs are visible to the recipient's mediator.

The public rendezvous DID is intentionally correlatable. Relationship DIDs
SHOULD be disclosed only in encrypted channels and MUST use `did:peer:4` long
form on first disclosure, followed by canonical short form.

Pure ACKs reveal durable receipt timing to the ultimate peer, not which
replica received first. Implementations SHOULD NOT encode contact names,
replica labels, event IDs or content in peer- or mediator-visible IDs.

## 15. Required conformance cases

1. An application commits `message.out` with all networking disabled.
2. A peer addresses a rendezvous or relationship DID and never a replica ID.
3. The intent durably freezes `createdTime`, `expiresTime`, and the exact
   ordered `pleaseAck` and `ack` arrays; two preparers neither substitute their
   local clocks nor reorder or enlarge acknowledgment sets.
4. Two replicas prepare one intent with equal semantic and intent hashes.
5. Retrying one package uses identical envelope bytes and package ID.
6. A permitted contact/address transition creates a new package and
   plaintext hash while preserving wire ID, semantic hash and intent hash.
7. Changing body, attachment order, type or thread metadata under one wire ID
   produces a semantic conflict.
8. Changing `ack`, `please_ack`, created time, expiry or any additional
   durable header under one wire ID produces an intent conflict and no control
   side effect.
9. HTTP or mediator acceptance records `submitted`, never `acknowledged`.
10. A natural response acknowledges a request only when its explicit `ack`
    array names the request wire ID.
11. A receiver emits an ACK only after durable inbound commit.
12. Two replicas receiving valid address variants of one message fold to one
    logical message and preserve both plaintext/package observations.
13. Invalid package-level `from_prior` or addressing evidence creates a
    conflict despite equal semantic and intent hashes.
14. Duplicate ACKs are harmless and one valid ultimate ACK stops every
    package retry for that wire ID.
15. An expired message records message-scoped non-retryable failure and no
    further package is prepared or submitted.
16. A replacement rendezvous request with a new wire ID and the same
    initiator key reuses one responder relationship and contact.
17. A direct and mediated route for the same recipient enter the same inbound
    fold rather than creating separate conversation messages.
18. A crash at every boundary in §13 loses neither a committed outbound
    intent nor an unacknowledged inbound delivery.
