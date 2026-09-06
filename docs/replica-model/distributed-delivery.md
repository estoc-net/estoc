# distributed-delivery/1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — phase-1 delivery profile for one active full vault
runtime. The identifiers and folds are future-safe for replication, but
`replica-mediation/1.0` and multi-writer execution are deferred.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Implement sending | [Commit boundaries](#cross-layer-commit-and-acknowledgment-table) → [Send](#send-an-ordinary-message) → [Prepare](#preparing-a-package) → [Completion and expiry](#submission-completion-and-expiration) |
| Implement receiving | [Receive](#receive-a-message) → [Recover](#receive-recovery) → [ACK processing](#durable-end-to-end-acknowledgment) |
| Implement identity and effects | [Hash projections](#canonical-projections-and-hashes) → [Observation and execution identity](#observation-identity-logical-aliasing-and-execution-identity) → [Automatic effects](#automatic-effects) |

<details>
<summary>Contents</summary>

- [1. What it is for](#what-it-is-for)
- [2. Terms](#terms)
- [3. Addressing layers](#addressing-layers)
- [4. Vault-first procedures and commit boundaries](#vault-first-procedures-and-commit-boundaries)
- [5. Canonical projections and hashes](#canonical-projections-and-hashes)
- [6. Preparing a package](#preparing-a-package)
- [7. Submission completion and expiration](#submission-completion-and-expiration)
- [8. Durable end-to-end acknowledgment](#durable-end-to-end-acknowledgment)
- [9. Observation identity, logical aliasing and execution identity](#observation-identity-logical-aliasing-and-execution-identity)
- [10. First contact and address policy](#first-contact-and-address-policy)
- [11. Automatic effects](#automatic-effects)
- [12. Required vault observations](#required-vault-observations)
- [13. Failure rules](#failure-rules)
- [14. Privacy](#privacy)
- [15. Required conformance cases](#required-conformance-cases)

</details>
<!-- reading-guide:end -->

<a id="what-it-is-for"></a>

## 1. What it is for

An Estoc message begins as a durable vault decision. Resolution, address
selection, encryption, mediation and retry are effects that happen later in a
full vault runtime. Phase 1 has exactly one active full runtime. Stable logical,
package and wire identifiers are nevertheless defined so a later replicated
runtime can converge without changing peer-visible messages.

Every outbound completes submission when `delivery.submitted` is durably
committed for any of its packages. Before that boundary, eligible work may be
retried or recovered after a crash. After it, no package for that logical
outbound is prepared or submitted again. Peer ACKs record receipt information;
they do not select the submission completion boundary.

This profile defines:

- the separation of communication addresses, symmetric relationships and
  runtime replicas;
- IDs and hashes for logical content, immutable intent, exact DIDComm
  plaintext, encrypted packages and mediator deliveries;
- which DIDComm headers are frozen at intent time;
- package preparation and valid repackaging;
- submission and expiry states, with independent peer-receipt information;
- end-to-end durable receipt observations with DIDComm `please_ack` and `ack`;
- duplicate and conflict handling across process restarts and future replicas;
- ordinary first-contact delivery and optional early address rotation; and
- idempotency requirements for automatic handlers.

It does not define the DASL object profile ([dasl-objects.md](dasl-objects.md)), mailbox
fan-out (`replica-mediation/1.0`), the relationship and address policy profile
([relationships.md](relationships.md)) or event/object replication (`vault-sync/1.0`).

<a id="terms"></a>

## 2. Terms

- **Full replica** — an independently writable vault incarnation holding the
  seed and appending vault events. It may run locally or on a server.
- **Communication address** — a supported DID used to send and receive.
  Local addresses are seed-derived Peer DIDs. Public/rendezvous disclosure and
  pairwise allocation are policies with identical core relationship semantics.
- **Relationship** — the stable symmetric birth-address identity with two
  independently changeable ends under [vault-events.md section 6](vault-events.md#relationships-and-address-changes); its local
  and peer histories determine message scope under section 9.
- **Outbound message ID (`messageId`)** — the vault entity ID of one outbound
  logical message, also used as its innermost DIDComm plaintext `id`.
- **Inbound observation message ID** — a deterministic ID for one authenticated
  `(peer key, wire ID)` observation before verified aliasing.
- **Logical execution ID** — a durable, immutable identity used by automatic
  effects after one or more inbound observation message IDs are recognized as the same
  logical input. It never changes merely because a later alias is learned.
- **Wire ID** — the innermost DIDComm plaintext `id`, stable across retries and
  permitted repackaging.
- **Semantic projection** — application meaning: `id`, `type`, `thid`,
  `pthid`, body and ordered logical attachments.
- **Intent projection** — semantic projection plus immutable message-level
  control headers recorded by `message.out`.
- **Intent hash** — SHA-256 of the canonical intent projection.
- **Plaintext hash** — SHA-256 of one exact complete innermost DIDComm
  plaintext, including package addressing and security headers.
- **Package ID** — Routing 2.0 `forward.id` for one exact encrypted inner
  envelope.
- **Delivery ID** — a mediator-generated opaque attachment ID used by Message
  Pickup. In the phase-1 single-replica profile it belongs to the mediation
  account queue; the deferred replica profile scopes it to a replica.
- **Submitted** — a transport endpoint accepted one package attempt and the
  vault committed `delivery.submitted`; this completes the logical outbound's
  submission work.
- **Acknowledged** — the ultimate peer sent an authenticated explicit `ack`
  naming the wire ID after durable receipt.
- **Receipt request** — the exact `message.out.pleaseAck` array names the
  messages whose explicit ACK is requested. It is independent of local
  submission completion.

```text
one outbound message (messageId = wire ID, intent hash)
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

`H1` and `H2` may differ while intent hashes remain equal.

<a id="addressing-layers"></a>

## 3. Addressing layers

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

All local communication addresses are vault-scoped. The active full runtime
derives their private keys and receives their messages. Public/private
allocation does not select a different binding, sender permission or receive
path. A later server or replica does not own an address merely by executing
the vault. The symmetric relationship is independent of local/peer orientation;
each message still has a sender and recipient, and every rotation is directed.

Each local communication DID has one immutable `boundRouteId`, mediated or
direct. Changing its keys or bound route creates a successor DID entity;
[vault-events.md section 6.5](vault-events.md#relationship-localtransitioned) records a relationship's local continuation.
An external recipient's resolved document may offer transport choices; choosing
among authorized routes does not change the application recipient. A direct
endpoint MUST NOT expose a replica ID as the peer-visible recipient.

The phase-1 mediator uses ordinary account-scoped Message Pickup with one
active pickup client. The deferred `replica-mediation/1.0` extension may later
fan out an already encrypted package without changing the innermost recipient.

A valid `from_prior` replaces one endpoint only inside its named relationship.
Other relationships using the same address retain their own current ends.

<a id="phase-1-mediator-envelope-and-storage-profile"></a>

### 3.1 Phase-1 mediator envelope and storage profile

The no-plaintext mediator boundary is a phase-1 requirement and is independent
of replica fan-out. Before storing a Routing 2.0 `forward`, the mediator MUST
require:

1. an outer DIDComm encrypted message addressed to the mediator;
2. a valid `body.next` that maps to the mediation account itself or a recipient
   currently registered to that account;
3. exactly one attachment;
4. attachment `media_type == "application/didcomm-encrypted+json"`;
5. exactly one of `data.json` or `data.base64`, and no `data.links`;
6. after decoding, one DIDComm encrypted-message JSON serialization with
   non-empty `protected`, `recipients`, `iv`, `ciphertext`, and `tag`; and
7. normalized bytes within the advertised account and message limits.

Validation is syntactic. The mediator MUST NOT decrypt the inner application
envelope or possess an application content-decryption key. It RFC-8785-
canonicalizes the accepted encrypted-message JSON and stores only those exact
UTF-8 bytes plus the minimum account, recipient, package, retention, pickup and
transport metadata required for operation. It MUST NOT persist or log unpacked
application plaintext, content keys, attachment content, decrypted `forward`
bodies or request bodies. A deployment MAY enable bounded diagnostic logging
only by explicit operator action; such logging is outside the no-plaintext
profile and MUST be visibly disclosed, access-controlled and time-bounded.

The sender's local DASL CID for the normalized envelope is never part of
Routing 2.0 and MUST NOT be sent merely to deliver the package.

For the phase-1 account-scoped queue, the package idempotency key is:

```text
(mediation account DID, body.next, forward.id)
```

Repeating that key with byte-identical normalized inner-envelope bytes is an
idempotent retry. Reusing it with different bytes is a package conflict; the
first accepted value remains and the later value MUST NOT replace it.

The mediator applies one recipient profile to all communication DIDs.
Public/private allocation is not sent to it. HTTP or
mediator acceptance means only `submitted`; ultimate acknowledgment still
requires an authenticated application plaintext whose explicit `ack` names the
wire ID.

The mediator MUST bound normalized envelope size, retained ciphertext bytes,
retained message count, registered recipients, recipient-update rate, pickup
batch size and retention time. A quota or validation failure MUST NOT leave a
partially stored package. Anonymous routing responses SHOULD avoid becoming a
precise account- or recipient-existence oracle.

<a id="4-vault-first-sending-and-commit-boundaries"></a>

<a id="vault-first-sending-and-commit-boundaries"></a>

<a id="vault-first-procedures-and-commit-boundaries"></a>

## 4. Vault-first procedures and commit boundaries

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only.

A full vault runtime MUST be able to commit a send while DNS, DID resolution
and every mediator are unavailable. Before required network work it records:

- `messageId`, also used as the wire ID;
- one immutable target relationship and nullable birth-address selection
  under [vault-events.md section 9.2](vault-events.md#message-out);
- message type, thread and parent-thread IDs;
- body and ordered normalized attachments;
- immutable `createdTime`, which is an Epoch-Seconds integer or null;
- immutable `expiresTime`, which is an Epoch-Seconds integer or null;
- immutable `pleaseAck`, represented as null or an ordered array;
- immutable `ack`, represented as an ordered array;
- immutable supported additional top-level headers; and
- the user or deterministic automatic-effect decision to send.

`createdTime == null` means the DIDComm `created_time` header is absent. A
preparer MUST NOT invent it. A user-authored message normally freezes commit
time, while a deterministic response may copy or derive a timestamp under its
protocol. The value is not a transport-freshness proof.

A successful vault commit uses the process-durable boundary in
[event-store.md section 2.1](event-store.md#commit-and-durability-terminology). Correctness MUST NOT depend on an uninterrupted
process lifetime or rebuildable cache state. A remote thin client without the
seed may stage a command offline, but the command becomes authoritative only
when a full vault runtime process-durably appends `message.out`.

<a id="cross-layer-commit-and-acknowledgment-table"></a>

### 4.1 Cross-layer commit and acknowledgment table

The following table is normative. "Committed" means process-durable success.

| Step | Required committed evidence | Permitted next action |
| --- | --- | --- |
| Object acceptance | Complete verified objects under the commit's writer lock | Append the referencing batch before releasing the lock |
| Outbound intent | `message.out` and every rooted object | Resolve, register, prepare or submit |
| Prepared package | `message.prepared` and its exact envelope; every application outbound also requires its common binding under [vault-events.md section 6.2](vault-events.md#relationship-bound) | Submit that exact package |
| Submission completion | Valid `delivery.submitted` for any package of the outbound | Stop all further preparation/submission for that message ID; apply envelope retention under [vault-events.md section 12.3](vault-events.md#held-roots) |
| Normal inbound | Objects, `message.in` and required resolution/binding evidence | Pickup-ACK, effect or peer ACK |
| Terminal pre-vault rejection | Safe terminal classification and bounded diagnostic, if any | Pickup-ACK only |
| Stable execution scope | Previously committed receipt and binding evidence, plus any required transition, under section 9 | Apply peer-scoped ACKs or derive and separately commit an eligible automatic intent |
| Ultimate peer ACK | Validated `ack` plus `delivery.acknowledged` | Record receipt information independently of submission work |

The terminal pre-vault path creates no `message.in`, peer ACK, contact or
handler effect. An ACK never substitutes for a missing `delivery.submitted`
event or retains a completed outbound's envelope for a later duplicate.

Object acceptance and event append use `Vault.commit` under [event-store.md section 10](event-store.md#vault-interface).

<a id="send-an-ordinary-message"></a>

### 4.2 Send an ordinary message

The synchronous full-vault send operation:

1. prepares attachment objects;
2. prepares the stored message document;
3. selects durable nullable `createdTime`, optional `expiresTime`, exact
   `pleaseAck` value (null or array), exact ordered `ack` and complete `headers`;
4. computes the intent hash;
5. selects one existing relationship or freezes the symmetric birth addresses
   under [vault-events.md section 9.2](vault-events.md#message-out), validates offline local eligibility and
   any contact assignment, and records the immutable target R. Neither a public
   sender nor absence of a first reply prevents this operation;

6. commits those objects with `message.out` through `Vault.commit`; and
7. returns `messageId`.

It performs no network operation. When `createdTime` is null, preparation
omits `created_time`. Every outbound uses the same submission completion rule
in [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold), regardless of its `pleaseAck` or `ack` arrays.

The active phase-1 runtime may later:

1. stop when submitted, terminally failed, expired or conflicted under
   [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold);
2. fold the intent's target R and any birth metadata;
3. resolve under [relationships.md section 10.1](relationships.md#did-resolution-requirements) and commit/reuse the common root
   binding before preparation. Select that R's current sender and peer end,
   checking portable lifecycle, assignment and pinned/verified key evidence;

4. attach our frozen relationship-scoped `fromPrior` while our own DID rotation
   remains unconfirmed;
5. construct complete plaintext by copying every intent-time header;
6. compute plaintext hash, encrypt, and use `Vault.commit` for the exact
   envelope and `message.prepared`;
7. submit directly or through Routing 2.0 with `packageId == forward.id`;
8. append `delivery.submitted` on acceptance or `delivery.failed` on terminal
   failure; record retryable failures only in local trace; and
9. schedule another attempt only while submission work remains eligible.

Within the active runtime, prepare/submit work for one logical message ID MUST be
serialized. Before each transport call, recheck its committed completion and
eligibility state; after acceptance, commit `delivery.submitted` before
dispatching further work for that message ID. This per-message scheduling boundary
does not hold the vault writer lock across network calls. If the process exits
before the submission event commits, reopen may submit the same exact package
again under section 13. No durable pre-call attempt reservation is required.

A new package may change address/security evidence only while the outbound is
unsubmitted, under validated repack rules and with the same intent hash.
Receiving may join equal wire IDs across a verified peer-key transition in one
relationship.

<a id="91-receive-a-message"></a>

<a id="receive-a-message"></a>

### 4.3 Receive a message

1. Before authoritative key/route recovery, retain delivery pending without
   pickup ACK. Apply [relationships.md sections 9.1](relationships.md#deferred-delivery)–[9.2](relationships.md#hard-pre-vault-gate)'s
   exact-recipient and lifecycle gate at every communication address. Enter or
   resume authentication only as permitted by its [local wait state](relationships.md#deferred-delivery)
   and [rules for loss of wait state](relationships.md#shared-accounting-and-lost-wait-state).
2. Authenticate/decrypt, validate syntax and exact DID/key/long-form consistency,
   and apply [sender resolution and its bounded retries](relationships.md#did-resolution-requirements).
   Safely terminal delivery is pickup-ACKed without portable application input;
   recoverable prerequisites defer.
3. Under the [receive lock and pair-lookup rules](vault-events.md#receipt-and-relationship-evidence),
   select the unique binding and transition evidence or a genuinely new live
   root pair. Apply [relationships.md section 9.3](relationships.md#integrity-checks-and-durable-receipt)'s
   superseded-sender and invitation/relationship-integrity checks. Required
   pre-receipt evidence deferral follows [section 9.1](relationships.md#deferred-delivery),
   with no `message.in` or pickup ACK; missing, pending or conflicting membership
   cannot become a new birth.
4. Commit/reuse exact `peer.resolved` and its document first. When a new binding
   is needed, commit it separately and obtain its returned `eventId`; only then
   commit `message.in` referencing that binding, with retained content, hashes
   and its fresh receipt ordinal. Hold the receive lock across these dependent
   commits and recheck recipient eligibility. Crash after binding but before
   receipt leaves reusable evidence, no invitation consumption and no receipt
   ACK; redelivery repeats authentication and reuses the binding.
5. Only after durable receipt, ACK the mediator delivery. A crash before this
   point leaves it pending or causes idempotent redelivery.
6. Validate every carried rotation against its exact retained predecessor and
   carrier evidence; commit/reuse `relationship.peerTransitioned` before
   scope/ACK/effects.
   Missing evidence leaves that input deferred, without a new-birth fallback.
7. Derive per-observation scope and message ID-group consistency under section 9,
   then process explicit ACKs through section 8.3's exact outbound membership.
8. Apply contact and early-privacy policy only to eligible application input
   under [relationships.md sections 5.2](relationships.md#binding-and-contact-policy) and [11](relationships.md#early-private-address-policy-and-notifications). Binding already exists; a contact
   or local successor is not required to assign protocol identity.
9. Check the local-sender gate, reuse any chosen protocol/notification effect,
   freeze eligible ACK targets, and commit at most one ACK-bearing response
   before sending. Control input uses ordinary control/ACK rules without a
   recursive privacy notification or contact creation.
10. On a duplicate or recovery, reuse existing intents. Resume only eligible
    unsubmitted work. A submitted response never gets another package or send.

<a id="92-receive-recovery"></a>

<a id="receive-recovery"></a>

### 4.4 Receive recovery

Recovery enumerates retained input, binding references, peer transitions,
local policy triggers and unfinished effects. It requires no mediator redelivery
or runtime-local queue. Partial imports retain missing-reference deferral;
conflicting evidence suppresses affected work in every import order. Neither
recovery nor a later rotation may derive a new R from a successor address.

<a id="canonical-projections-and-hashes"></a>

## 5. Canonical projections and hashes

<a id="semantic-projection"></a>

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

Values are copied from `M`. Absent thread values are null. Body and attachments
use the closed normalization in [vault-events.md section 8](vault-events.md#stored-message-document). The semantic
projection contains no implementation-selected attachment metadata.

It excludes:

```text
typ, from, to, created_time, expires_time,
please_ack, ack, from_prior
```

`return_route` is forbidden in an Estoc vault application plaintext.

This projection is the `semantic` member of the intent projection below. It
has no separately stored hash.

<a id="intent-projection"></a>

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
  "created_time": null,
  "expires_time": null,
  "please_ack": [""],
  "ack": [],
  "headers": {}
}
```

`please_ack` is null when the wire header is absent; otherwise it is the exact
ordered wire array. Each string names a message whose explicit acknowledgment
is requested. `""` means the current message, and the current wire ID MAY be
used instead.

Define:

```text
expandPleaseAck(currentWireId, values):
    replace every "" with currentWireId
    retain the first occurrence of each target
    ignore later duplicate targets without reordering
```

An expanded array containing the current wire ID requests that message's ACK.
An absent or empty array does not request it, while `[""]` and `[currentWireId]`
do. This request never changes submission completion or retry eligibility.

Writers SHOULD NOT emit duplicate targets. Readers preserve the accepted wire
array exactly and apply deduplication only to receipt processing. Absent
`please_ack` normalizes to null; absent `ack` normalizes to `[]`; absent
`created_time` or `expires_time` normalizes to null; absent additional headers
normalize to `{}`. The producer freezes and emits `ack` targets in
oldest-to-newest receive order under section 8.1, never lexicographic order;
this implements the ordering MUST in
[DIDComm Messaging v2.1, ACKs](https://identity.foundation/didcomm-messaging/spec/v2.1/#acks).

`headers` contains every permitted top-level DIDComm field not represented by
a dedicated field. The reserved names `typ`, `id`, `type`, `from`, `to`,
`created_time`, `expires_time`, `thid`, `pthid`, `please_ack`, `ack`,
`from_prior`, `return_route`, `body` and `attachments` are forbidden. A
difference in any such field is an intent difference.
Local effect bookkeeping and package addressing are excluded.

`intentHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON for
this projection.

<a id="exact-plaintext-hash"></a>

### 5.3 Exact plaintext hash

`plaintextHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for the complete innermost DIDComm plaintext actually encrypted by one
package or received in one observation. It includes `from`, `to`, `from_prior`
and every present header.

All packages for one outbound `messageId` agree on the intent hash. They may have
different plaintext hashes only when package-level addressing or security
evidence changes under an expressly permitted rule.

<a id="preparing-a-package"></a>

## 6. Preparing a package

A preparer folds the target and selects:

- one live sender DID entity and its fixed key-agreement method, using the
  relationship's current local end under [vault-events.md section 6.5](vault-events.md#relationship-localtransitioned);
- one current peer DID and authenticated peer key;
- exact `peer.resolved` evidence, fresh for the first package of each new
  non-numalgo-4 message ID under [relationships.md section 10.1](relationships.md#did-resolution-requirements);
- one recipient route authorized by that evidence; and
- any required relationship-scoped `from_prior`.

It then constructs the complete innermost plaintext from durable intent.
Version 3 emits:

- `typ`, `id`, `type`, `from`, `to` and `body`;
- `created_time`, `expires_time`, `thid` and `pthid` only when non-null;
- `please_ack` whenever `pleaseAck` is not null, including `[]`;
- `ack` when non-empty;
- `from_prior` when required;
- `attachments` when non-empty; and
- every `headers` entry at the plaintext top level.

`message.out.headers` MUST obey the reserved-name rule in section 5.2. An
implementation that cannot preserve a supported additional header MUST reject
preparation rather than dropping it.

The plaintext `id` is the committed `message.out.messageId`. The preparer
RFC-8785-canonicalizes the plaintext, computes `plaintextHash`,
encrypts, parses the encrypted-message JSON with duplicate-member and I-JSON
validation, and uses `Vault.commit` to accept
`UTF8(RFC8785(parsedEncryptedEnvelope))` as one raw DASL object with
`message.prepared`. Submission uses those exact stored bytes.

Retrying an unsubmitted package reuses identical plaintext, normalized
ciphertext bytes and package ID. While the logical outbound remains
unsubmitted, a new package for it may change `from`, `to`,
selected keys, peer resolution or `from_prior` only under a valid DID-entity
selection or verified relationship-scoped transition for the same logical target.
A local DID's keys and bound route never change in place; an external
recipient's transport choice remains constrained by its resolution evidence.
Every changed plaintext or encryption result requires a new package ID and
plaintext hash. Birth metadata preserves root identity while packages follow
validated changes of either end in the same R.

<a id="submission-completion-and-expiration"></a>

## 7. Submission completion and expiration

[vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold) defines submission completion and
work eligibility for every trigger, including timers, reopen and duplicate
responses. A worker checks that fold before preparation or submission; after
any valid `delivery.submitted` commits for that outbound, it MUST NOT prepare,
repackage or submit that logical message ID again. A deliberate later send creates a new
`message.out` and wire ID.

Before completion, an expired message receives a message-scoped terminal
`delivery.failed(code="expired")` and no new submission. Reaching expiry after
submission does not create a new delivery failure. An ACK can still supply
receipt information, including the late indicator defined from committed
carrier observations in [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold), without changing
submission state or work eligibility.

Eligible unsubmitted work may use local timers, backoff and recovery. Protocols
may impose tighter limits; [relationships.md section 14](relationships.md#retry-replacement-and-address-rollover) defines ordinary retry
defaults. Route recovery or a changed clock never reopens a submitted or
terminally failed outbound.

Envelope collection uses [vault-events.md section 12.3](vault-events.md#held-roots)'s retention predicate,
independently of scheduling eligibility. Submission releases this outbound's
envelope contribution; ACK and duplicate-response replay add no retention.
That definition also governs unavailable routes, retryable resolution failures
and the separate lifetimes of content, skeletons and independent references.

<a id="durable-end-to-end-acknowledgment"></a>

## 8. Durable end-to-end acknowledgment

<a id="freezing-an-ack-target-set"></a>

### 8.1 Freezing an ACK target set

Before selecting or committing any new deterministic reply intent, including
a natural protocol response with no ACK targets, the writer MUST check for a
usable local sender in the input's unique relationship scope. Its current local
DID must pass portable identity/route checks under [vault-events.md sections 6.5](vault-events.md#relationship-localtransitioned) and [7.6](vault-events.md#contact-fold); any contact assignment must be conflict-free and not deleted.
An unassigned control relationship needs no contact. These are portable checks,
not requirements for online resolution or observed registration before intent.
No other R or historical local end may substitute for an unavailable sender.

If there is no usable sender, receive and scope the input normally but commit
no reply intent and freeze no ACK targets. Required response/ACK work remains
unfinished, rediscovered from committed input under [vault-events.md section 13.1](vault-events.md#open-the-writable-full-runtime) when a usable sender exists, including after a local successor is created.
Current tombstones, integrity and erasure rules still apply. Already committed
intents are reused; later rotation or retirement uses that document's [section 6.5](vault-events.md#relationship-localtransitioned) repack/blocking rules without minting a replacement effect.

Binding and required input/proof evidence must already be committed. An early
privacy transition and its notification follow [relationships.md section 11](relationships.md#early-private-address-policy-and-notifications);
they do not create scope or bypass the local-sender gate. Recheck eligibility
under the same writer lock as response selection and intent commit.

For one received carrier message `X`, a conforming receiver performs this
algorithm after normal inbound commit, only when no response intent already
exists under section 11 and the sender gate above passes:

1. If `X.pleaseAck == null`, create no ACK obligation.
2. Expand `""` to `X.wireMessageId`; retain the first occurrence of every target and
   ignore later duplicates.
3. Derive `X.logicalPeerScope` under section 9.
   Look up each requested wire ID only as `(X.logicalPeerScope, wireMessageId)`. The
   current `X.wireMessageId` is known by virtue of X's own derived scope. An older
   target is eligible only when it is conflict-free and derives to the exact
   same scope. A verified key transition may widen lookup only inside one
   relationship scope; unrelated relationships, unknown senders,
   conflicted targets and ambiguous scope attribution are omitted.
4. Sort eligible targets ascending by [vault-events.md section 10.2](vault-events.md#message-in)'s
   `firstReceiptKey`, omitting targets affected by its receipt-integrity conflict.
   Use that complete-key order, never decimal-string, canonical-event or
   `ChangeToken` order.
5. Freeze that exact ordered array as `message.out.ack` in one deterministic
   natural response or one deterministic pure ACK associated with X's logical
   execution ID.

A requested target unknown or outside X's peer scope at step 3 is omitted.
Its later arrival does not mutate the frozen response or create a second ACK
effect for X; the sender may request it again in another message. If
no target remains, the receiver creates no ACK-only effect. DIDComm message IDs
are sender-scoped; wire-ID equality elsewhere in the vault is never sufficient
evidence for an ACK target.

The [first-receipt definition](vault-events.md#message-in) governs ordering after history union;
import never rewrites a frozen response or grants a new multi-writer
execution guarantee.

Before proposing the response it MUST have authenticated and validated X,
accepted every retained object and process-durably appended `message.in`.
Any additional non-conflicted relationship or key evidence needed for the
response MUST already be committed before deriving the response execution ID,
freezing ACK targets or committing its intent under section 9.

The response thread follows X, not each older target:

```text
thid  = X.thid, or X.wireMessageId when X.thid is null
pthid = X.pthid
```

Remote Report Problem correlation in [relationships.md section 13](relationships.md#remote-errors-and-integrity-failures) instead
uses its child-thread `pthid` rule; this profile selects no local rejection effect.

A natural response may carry the frozen `ack` array. If no deterministic
natural response is available, use `https://didcomm.org/empty/1.0/empty`.
Pure ACKs contain no `please_ack` and follow the same submission completion
rule as every outbound; they are control observations under [vault-events.md section 10.6](vault-events.md#inbound-message-and-execution-fold). Control input creates no contact or early-privacy notification.
Its permitted receipt ACK uses the same scope and sender gates at every local
address. No-response protocol errors retain their no-response rule.

<a id="deterministic-pure-ack"></a>

### 8.2 Deterministic pure ACK

For a pure ACK:

```text
handlerId  = https://estoc.dev/distributed-delivery/1.0#pure-ack
effectKind = pure-ack
ordinal    = 0
```

The output's `ack`, `thid` and `pthid` follow section 8.1. `createdTime` copies
the carrier's normalized value, including null; `expiresTime` is null. A null
`createdTime` omits the wire header. Body and attachments are empty;
`pleaseAck` is null; `headers` is `{}`.

This is the **generic pure-ACK profile**. An Empty rotation notification uses
the same producing tuple but freezes `pleaseAck == [""]` under [relationships.md section 11.1](relationships.md#automatic-response-selection). Package preparation independently chooses the current local
proof. One carrier cannot create both variants: the notification consumes its
ACK response selection. Control input cannot trigger a privacy notification;
the generic ACK variant cannot request another ACK.

The executable vector uses execution scope
`{"relationshipId":"35807a1e-3b8a-52f5-9580-29cd5265882e"}`, carrier wire ID
`019b1b61-3444-7190-9db5-1cc9c215eb23` and the tuple above.

The generic execution/effect derivation in sections 9 and 11 produces:

```text
executionId      = cf135b1f-1d7a-51eb-88ae-42447d426abe
effectKey        = MzoucVz8FGCDtGEE2FTwgiwSg6elFih1OQT91MzmpSU
outbound message ID = wire ID = 7b53df5f-594d-50f4-adc3-3f7fbd0fe6c5
```

<a id="applying-ack"></a>

### 8.3 Applying `ack`

An authenticated plaintext acknowledges an outbound only when its explicit
`ack` array names that outbound wire ID, the candidate outbound belongs to the
same validated logical peer scope as the ACK-bearing carrier, and every
package-level addressing, transition and protocol-specific proof gate has
passed. Apply [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold)'s outbound
membership and [section 10.5](vault-events.md#complete-observation-witnesses)'s complete-witness checks.
Lookup is `(carrier.logicalPeerScope, acknowledgedWireId)`, never a
vault-global wire-ID search. Threading, a natural response, transport acceptance,
`please_ack` presence or a mediator receipt is insufficient without the
explicit value.

A valid ACK adds receipt information only. It neither creates a missing
`delivery.submitted` nor changes submission eligibility or envelope retention.
Duplicate ACKs are harmless. Acknowledged means durable receipt by the peer
vault, not read, displayed or accepted by a business workflow.

<a id="duplicate-receipt-handling"></a>

### 8.4 Duplicate receipt handling

When a conflict-free carrier is delivered again, the receiver looks up its
existing deterministic response under section 11. If that outbound has a
committed `delivery.submitted`, the duplicate causes no further submission,
even when exact bytes are still present. If it remains unsubmitted, only its
existing eligible work may resume under section 7.

A duplicate MUST NOT mint a new effect, outbound message, wire ID, package or
`from_prior`, or change frozen ACK targets, merely to obtain another send.
Collected or erased response bytes are not recreated for a submitted response.
If a request was not honored because no eligible target remained or the
input failed integrity, redelivery creates no new response obligation.
Required ACK work left unfinished by a crash still follows [vault-events.md section 13.1](vault-events.md#open-the-writable-full-runtime)'s recovery rules, subject to the same submitted boundary.

<a id="observation-identity-logical-aliasing-and-execution-identity"></a>

## 9. Observation identity, logical aliasing and execution identity

<a id="observation-ids-and-vectors"></a>

#### Observation IDs and vectors

`peerPublicKey` below is derived from the observation's referenced
`peer.resolved(peerResolutionEventId).peerPublicKey` under [vault-events.md section 4.1](vault-events.md#key-evidence);
it is not duplicated in `message.in` or `message.prepared`. The same derivation
supplies all message/package peer-key comparisons in this document. A missing
non-null reference defers, never falls back to null.

For an authenticated or signed innermost message:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v1", "authenticated", peerPublicKey, wireMessageId])
)
```

For a truly anonymous message:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v1", "anonymous", localKeyName, wireMessageId])
)
```

This value identifies an observation namespace. The authenticated form omits
`localKeyName`, so a valid repack to another accepted local DID/key can converge
under one message ID.

The published authenticated vectors are executable:

```text
peerPublicKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
wireMessageId = 019b2a70-f225-721c-835f-67175be0667e
messageId     = 369d7a43-8dce-5b86-b073-e390d457f357

peerPublicKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
wireMessageId = 019b1b61-3444-7190-9db5-1cc9c215eb23
messageId     = a8b9afd5-60fe-5f49-a669-bd998e760e7e
```

These vectors intentionally use wire IDs different from the outbound examples
in [vault-events.md section 9](vault-events.md#outbound-message-events). Equal wire IDs chosen independently by different senders are not by
themselves a protocol violation; sender/relationship scope is part of logical
identity and ACK lookup.

A verified relationship-scoped transition may cause observations with different
authenticated `peerPublicKey` values and therefore different message IDs to represent one
logical message. [vault-events.md section 10.6](vault-events.md#inbound-message-and-execution-fold) defines that second-stage merge. The original
observation message IDs remain stored for audit and conflict detection.

These values are **observation identities**. Equal intent hashes under one message ID
form one observation group; differences are intent conflicts.

<a id="execution-scope-and-commit-prerequisites"></a>

#### Execution scope and commit prerequisites

Automatic execution uses a stable **execution scope**, not an observation message ID.
Its unique derived value is the carrier's **logical peer scope**
(`logicalPeerScope`) for ACK lookup, duplicate handling and automatic execution.
The phase-1 application execution scope is:

```json
{ "relationshipId": "<relationship ID>" }
```

Every authenticated application address pair uses this same scope. Anonymous
input and mediator control traffic have no application execution scope; no
provisional key-based scope executes before relationship evidence is ready.

A `Vault.commit` validator derives automatic-intent scope and ACK targets from
the event set committed before that call. Receipt/binding/transition proposed
in the same batch cannot authorize a response. Commit those prerequisites
first, then derive and commit the effect; recovery resumes from that prefix.

<a id="address-chains-and-observation-membership"></a>

#### Address chains and observation membership

`peerChain(R)` contains canonical DID/key authorizations from exactly:

- the peer document referenced by `relationship.bound.peerResolutionEventId`; and
- every valid `relationship.peerTransitioned.peerResolutionEventId` for that R's rooted
  peer chain.

Each node includes all key-agreement methods authorized by its exact document,
not only the selected encryption key. Resolve those methods to section [4.1](vault-events.md#key-evidence) of [vault-events.md](vault-events.md)'s canonical key values. The resolution's `keyAgreementMethodIds`
must match the document; missing bytes defer and a fresh document may recover
them only when its canonical raw CID is identical. Different selected keys
within one document can scope the same R. Equal keys under unrelated canonical
DIDs do not imply continuation. A current resolver result cannot extend the
historical set; current sender authentication remains a separate receive gate.

The local history starts with `relationship.bound.localDidId` and extends through
`relationship.localTransitioned`. `relationshipRecipientKeyNames(R)` includes that
whole rooted history. For a new delivery, first apply [relationships.md section 9.3](relationships.md#integrity-checks-and-durable-receipt)'s producer-time superseded-sender check under the receive lock. The rows
below validate immutable evidence of committed observations; they neither
admit new traffic from a superseded peer node nor re-evaluate earlier receipts
against a later rotation. Each valid committed observation must satisfy one
of these rows:

| Observation | Immutable evidence and authorization | Scope |
| --- | --- | --- |
| Proof-free root sender | `relationshipBindingEventId` names a valid bound R; actual local key is in its rooted local history; sender DID/key is authorized by its pinned root peer document; `peerTransitionEventId == null` | R |
| Proof-free peer successor | Same binding/local history check; `peerTransitionEventId` names the valid R edge whose `toDid` and exact successor document authorize the observed DID/key | R |
| Carried `fromPrior` | A valid `relationship.peerTransitioned` for that exact carrier/proof identifies R and authorizes its new sender; actual recipient belongs to R's local history; any non-null carrier binding reference agrees | R |

These rows do not inspect public/private policy or message type. Lookup hints
alone authorize none of them. A newly authenticated root pair first commits a
common binding under [relationships.md section 9.3](relationships.md#integrity-checks-and-durable-receipt), then follows the first row.
A recognized DID with an unpinned key retains its binding/edge references but
has no scope and follows that document's same-DID diagnostic. Missing proof or
binding evidence defers, never falls back to a fresh birth or key-based scope.

All applicable evidence must identify one unique R. The pair index under
[vault-events.md section 6.6](vault-events.md#relationship-fold-and-address-index) catches competing birth/continuation claims.
For each message ID group, every valid observation must derive the same R: different
Rs conflict, any unresolved observation defers the group, and neither permits
per-observation effects. Retain previous committed receipts/effects without
reassigning their identities when a later conflict appears.

<a id="execution-id-and-immutable-transcript"></a>

#### Execution ID and immutable transcript

```text
executionId = UUIDv5(
  estocNamespace("message-execution"),
  RFC8785(["v2", {"relationship": R}, wireMessageId])
)
```

Here `R` is the scope's `relationshipId`. The transcript member name
`"relationship"` is a fixed derivation tag, independent of the payload and
runtime field name. Build that exact object for hashing; serializing
`logicalPeerScope` with its `relationshipId` member would produce a different,
invalid execution ID. Namespace purposes follow [vault-events.md section 3.4](vault-events.md#entity-ids-and-reproducible-uuidv5-namespaces).

Rotation preserves R, execution identity and ACK namespace. Historical input
verifies its saved references during import; producer current-address and
authentication checks for a new delivery do not retrospectively rewrite it.
Current local sender eligibility and contact lifecycle separately govern new
outbound effects. Threads, ACK targets, contact merges and public address
labels do not supply relationship identity.

<a id="local-rotation-scope-vector"></a>

##### Local-rotation scope vector

Using the existing relationship, key and carrier fixture above, let two
validated local transitions extend P0 to P1 and then P1 to P2, each with the
predecessor-confirmation evidence required by [vault-events.md section 6.5](vault-events.md#relationship-localtransitioned):

```text
R             = 35807a1e-3b8a-52f5-9580-29cd5265882e
P0            = 019b2a60-c68e-75bf-b6fb-ae1a41f8d715
P1            = 019b6a10-12c0-7410-89ab-38e54b097c21
P2            = 019b6a20-12c0-7420-89ab-38e54b097c22
peerPublicKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
wireMessageId = 019b1b61-3444-7190-9db5-1cc9c215eb23

for localKeyName = did/<P0|P1|P2>/key-agreement:
  messageId = a8b9afd5-60fe-5f49-a669-bd998e760e7e
  executionScope = {"relationshipId":"35807a1e-3b8a-52f5-9580-29cd5265882e"}
  executionId = cf135b1f-1d7a-51eb-88ae-42447d426abe
  pure-ack effectKey = MzoucVz8FGCDtGEE2FTwgiwSg6elFih1OQT91MzmpSU
  pure-ack outbound message ID = 7b53df5f-594d-50f4-adc3-3f7fbd0fe6c5
```

Each observation references resolution evidence with its own `localKeyName` and this
same authenticated peer key/DID pair in `peerChain(R)`. Equal-intent deliveries
at P0, P1 and P2 therefore share one execution, even after P0 retires. An
explicit ACK at P2 may acknowledge an outbound whose historical valid package
sent from P0, and an ACK at eligible P0 may acknowledge a package from P2, under
[vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold)'s membership rules. A DID outside this chain
supplies no such membership. These are executable identity and scope fixtures,
not JWT or numalgo-4 document test vectors; the DID entity IDs stand for
validated local documents and transition proofs.

<a id="first-contact-and-address-policy"></a>

## 10. First contact and address policy

First contact uses the ordinary sender and receiver procedures. Trust Ping is
the no-content default; useful application content may be sent immediately.
No Estoc wire handshake, initial-specific acceptance limits or qualifying
first-reply gate exists. Offline `birth` metadata fixes only the original
address pair and R; it does not pin later package addresses.

After binding, the optional early-privacy policy may create a local successor
and send an ordinary notification with `from_prior`. Both initial and later
rotations use [vault-events.md section 6.5](vault-events.md#relationship-localtransitioned). Either peer may keep a public
address. Messages, ACKs, notification effects, repacks and submission completion
all use the same R throughout. The detailed policy and idempotent trigger
recovery are in [relationships.md section 11](relationships.md#early-private-address-policy-and-notifications).

<a id="automatic-effects"></a>

## 11. Automatic effects

An automatic DIDComm output is one effect identified by
`(executionId, handlerId, effectKind, ordinal)`. `executionId` MUST equal the
derived execution ID of a unique conflict-free carrier group. Each protocol
MUST define its handler ID, effect kind, stable non-negative integer ordinal
and output intent rules. Its outputs MUST obey [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold)'s
limit of one logical outbound carrying a non-empty `ack` per execution, across
all producing tuples. Handler IDs and kinds are non-empty strings without
U+0000; `decimalOrdinal` is `0` for zero, otherwise decimal digits without
leading zeros.
Retries MUST NOT change the tuple to create another effect or evade a conflict.

```text
effectKey = base64url(
  SHA-256(
    UTF8("estoc/effect/3\0") ||
    UTF8(executionId) || 0x00 ||
    UTF8(handlerId) || 0x00 ||
    UTF8(effectKind) || 0x00 ||
    UTF8(decimalOrdinal)
  )
)
```

The key is unpadded base64url. It determines the outbound message ID and wire ID under
[vault-events.md section 9.1](vault-events.md#ids). The effect's content is its `message.out` intent.
That event retains the complete producing tuple under its [section-9.2](vault-events.md#message-out) schema;
the stored `ordinal` is exactly `decimalOrdinal`, not a runtime-only counter.
One key permits only one compatible intent under that document's [section 9.8](vault-events.md#outbound-message-and-delivery-fold);
payload validation MUST verify the execution ID against that carrier group,
the stored tuple and output intent against the producing protocol, the key
against that tuple, and the message ID against the key.

Under the writer lock in [event-store.md section 10](event-store.md#vault-interface), the runtime MUST derive
the carrier's execution ID and check for an already-selected ACK-bearing
response under [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold) before selecting an ACK response
handler or tuple. If one exists, reuse it; a new handler or tuple cannot consume
the carrier's ACK obligation again. Competing imported selections suppress
response work under that fold.
For a new DIDComm reply, apply section 8.1's local-sender gate before selection;
missing a sender leaves unfinished work without committing intent.
For each eligible effect, look up its derived message ID before freezing ACK targets,
timing or other intent fields.
It reuses an existing non-conflicted intent; it MUST NOT regenerate one after
content erasure, submission, a later observation or a changed clock. If no
intent exists, it commits the intent through `Vault.commit` before effects.
Derivation, lookup and commit are one locked operation.
Receipt, common bindings and required transitions MUST already
be committed before this operation. A batch cannot authorize its own response
scope; section 9 permits no prospective-scope exception.
A conflicting local intent is rejected before append; imported conflicts remain
history and suppress work under [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold). Duplicate
carriers may resume only unsubmitted response work under section 8.4.

Other external effects MUST commit their protocol-defined portable intent
before execution and use that protocol's idempotency or explicit at-least-once
contract. The message fold does not validate those payloads.

Phase 1 has one active writer but still makes no process-level exactly-once
claim. A future multi-writer profile must coordinate automatic execution before
claiming stronger behavior.

<a id="required-vault-observations"></a>

## 12. Required vault observations

Exact schemas are in [vault-events.md](vault-events.md):

```text
message.out                       durable intent and immutable headers
message.prepared                  exact plaintext and encrypted package
message.packageRetired            package no longer submitted
delivery.submitted                transport accepted a package
delivery.failed                   terminal package or message failure
delivery.acknowledged             ultimate peer ACK named the wire ID
message.in                        durable inbound observation
relationship.peerTransitioned     peer DID continuation in one named relationship
relationship.bound                symmetric birth addresses and pinned peer document
relationship.contactAssigned      independent local contact assignment
relationship.localTransitioned    frozen successor and proof for our end
```

One valid committed `delivery.submitted` completes the entire outbound's
submission work, regardless of either ACK array. `delivery.acknowledged`
records a separate receipt observation and cannot create or reopen submission
work. Missing submission evidence leaves eligible work recoverable even when
an earlier transport call may already have succeeded.

A recommended inbound observation records both hashes and durable headers:

```json
{
  "messageId": "<deterministic inbound message id>",
  "wireMessageId": "<innermost message id>",
  "receiptOrdinal": "42",
  "intentHash": "<base64url sha-256>",
  "plaintextHash": "<base64url sha-256>",
  "createdTime": null,
  "expiresTime": null,
  "pleaseAck": [""],
  "ack": [],
  "localKeyName": "did/019b.../key-agreement",
  "peerResolutionEventId": "<exact-peer.resolved-eventId>",
  "relationshipBindingEventId": "<exact-relationship.bound-eventId>",
  "peerTransitionEventId": null,
  "receivedVia": {
    "mediationId": "019b...",
    "deliveryId": "019b..."
  }
}
```

<a id="failure-rules"></a>

## 13. Failure rules

- Before intent commit, no vault message exists.
- After intent commit but before preparation, the active full runtime may
  prepare later; a future replicated profile may allow any full replica to do
  so.
- After package storage but before submission observation, the exact package
  may be submitted again.
- After mediator acceptance but before `delivery.submitted`, retry reuses the
  exact package idempotently. Missing submission evidence does not prove that
  no attempt occurred; [relationships.md section 14](relationships.md#retry-replacement-and-address-rollover)
  governs local attempt accounting and its permitted reset after restart/restore.
- After `delivery.submitted` commits, restart, duplicate receipt and missing
  ACK never cause another submission or replacement package for that message ID.
- At expiry before prepare or retry of an unsubmitted outbound, a
  message-scoped terminal failure is recorded and no package is submitted.
- After inbound commit but before pickup ACK, redelivery converges as another
  observation.
- After pickup ACK but before ultimate ACK intent/submission, writable-open
  recovery MUST rediscover unfinished work from committed inbound history,
  reuse frozen intents and relationship evidence, and resume eligible
  deterministic work.
  Neither mediator redelivery nor a local queue is a recovery prerequisite.
- Loss or unavailability of the recipient runtime beyond mediator retention
  may lose an in-flight package after submission completed. The sender does
  not compensate by resending a submitted outbound. This profile provides
  best-effort delivery after recorded transport acceptance, independently of
  any later peer receipt observation.

<a id="privacy"></a>

## 14. Privacy

Wire IDs, message types and content are visible only inside end-to-end
encrypted application messages. Package IDs and recipient routing DIDs are
visible to the mediator. Delivery IDs are visible to the recipient mediator.
A future replica-mediation profile
would additionally expose opaque replica IDs to that mediator.

A disclosed rendezvous DID is intentionally correlatable within its audience.
Relationship DIDs SHOULD be disclosed only in encrypted messages and use
Peer DID long form on first disclosure.

Pure ACKs reveal durable receipt timing to the ultimate peer, not which
replica received first. Implementations SHOULD NOT encode contact names,
replica labels, event IDs or content in peer- or mediator-visible IDs.

<a id="required-conformance-cases"></a>

## 15. Required conformance cases


<a id="intent-and-immutable-packaging-dd-1-dd-12"></a>

### Intent and immutable packaging (DD-1–DD-12)

1. <a id="dd-1"></a> `message.out` commits with all networking disabled.
2. <a id="dd-2"></a> A peer addresses a rendezvous or relationship DID, never a replica ID.
3. <a id="dd-3"></a> `pleaseAck == null` omits the wire header; an array is preserved exactly on
   the wire.
4. <a id="dd-4"></a> `pleaseAck == []` requests no explicit acknowledgment.
5. <a id="dd-5"></a> `pleaseAck` containing `""` or the current wire ID requests its receipt;
   an array naming only older IDs does not. Neither changes submission work.
6. <a id="dd-6"></a> A receiver accepts the standard empty-string sentinel and current-message
   ID form and expands them to the current wire ID for processing.
7. <a id="dd-7"></a> Intent freezes `createdTime`, `expiresTime`, exact `pleaseAck`, exact `ack`
   and every supported additional header.
8. <a id="dd-8"></a> `return_route` in vault application headers or innermost plaintext is
   rejected.
9. <a id="dd-9"></a> Two valid preparations of one intent agree on the intent hash.
10. <a id="dd-10"></a> Retrying one package uses identical plaintext, ciphertext and package ID.
11. <a id="dd-11"></a> A permitted address/key transition creates a new package/plaintext hash
    while preserving wire ID and intent hash.
12. <a id="dd-12"></a> Body, type, thread, attachment, timing, ACK policy or additional-header
    changes under one wire ID produce an intent conflict.

<a id="submission-and-acknowledgment-dd-13-dd-22"></a>

### Submission and acknowledgment (DD-13–DD-22)

13. <a id="dd-13"></a> HTTP or mediator acceptance records submitted, never acknowledged.
14. <a id="dd-14"></a> Every outbound stops all preparation/submission after committed
    `delivery.submitted`, including when its `pleaseAck` requests the current
    wire ID and no ACK arrives. A later transport failure or expiry does not
    replace the submitted outcome.
15. <a id="dd-15"></a> A deterministic response acknowledges a message only when explicit `ack`
    names its wire ID.
16. <a id="dd-16"></a> ACK is emitted only after durable inbound commit.
17. <a id="dd-17"></a> Pure ACK uses `pleaseAck == null`, creates no ACK loop and completes
    submission at the same committed boundary as other outbounds.
18. <a id="dd-18"></a> A pure ACK whose carrier omitted `created_time` commits
    `createdTime == null` and omits the wire header on every preparation.
19. <a id="dd-19"></a> The fixed pure-ACK vector derives execution ID
    `cf135b1f-1d7a-51eb-88ae-42447d426abe`, effect key
    `MzoucVz8FGCDtGEE2FTwgiwSg6elFih1OQT91MzmpSU`, and one outbound/wire ID
    `7b53df5f-594d-50f4-adc3-3f7fbd0fe6c5`.
20. <a id="dd-20"></a> One carrier that requests current and older known IDs freezes one ordered
    deduplicated ACK target set; unknown targets arriving later do not mutate
    the response effect.
21. <a id="dd-21"></a> A valid ACK received before `delivery.submitted` adds receipt information
    without completing submission or releasing its envelope. Eligible pending
    submission remains recoverable with its exact package.
22. <a id="dd-22"></a> A duplicate carrier reuses its frozen response. Before submitted it may
    resume eligible work; after submitted it causes no send, even when the
    exact response bytes remain. Collected bytes do not cause a replacement.

<a id="scope-aliases-and-conflicts-dd-23-dd-30"></a>

### Scope, aliases and conflicts (DD-23–DD-30)

23. <a id="dd-23"></a> Valid address variants converge; invalid variants conflict.
24. <a id="dd-24"></a> Equal wire IDs under transition-verified peer keys merge only through the
    same stable relationship execution scope; unrelated key reuse does not.
25. <a id="dd-25"></a> A repackaged observation that arrives before transition evidence remains
    effect-deferred. After verification it derives the same relationship/wire-ID
    execution identity and cannot execute once per peer key.
26. <a id="dd-26"></a> Multiple relationship matches or incompatible derivation rows for one
    observation suppress ACK processing and new effects as an execution-scope
    conflict, even when each source is individually valid.
27. <a id="dd-27"></a> Control observations follow [vault-events section 10.6](vault-events.md#inbound-message-and-execution-fold) at every address.
    Binding and scoped ACK processing remain possible without contact creation
    or a recursive privacy notification.
28. <a id="dd-28"></a> Invalid `from_prior` prevents ACK processing and transition.
29. <a id="dd-29"></a> Duplicate explicit ACKs are harmless and affect only peer receipt
    information, never submission completion or envelope retention.
30. <a id="dd-30"></a> Expiry stops unsubmitted work permanently. Receipt `late` follows
    [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold)'s committed observation-time rule for both
    submitted and expired messages, without changing submission outcome or
    restarting work. Already-submitted messages acquire no new expired failure.

<a id="first-contact-rotation-and-transport-dd-31-dd-39"></a>

### First contact, rotation and transport (DD-31–DD-39)

31. <a id="dd-31"></a> The default initial rendezvous message may be Trust Ping; a received
    application message may be first without a custom wrapper.
32. <a id="dd-32"></a> No emitted message uses an `https://estoc.dev/rendezvous/1.0/*` type.
33. <a id="dd-33"></a> Every unconfirmed local successor uses the same long-form sender and
    frozen from_prior rules, including the first public-to-private rotation.
34. <a id="dd-34"></a> `from_prior.sub` equals plaintext `from` byte-for-byte; the protected JWT
    `kid` has the exact `iss` DID portion. Predecessor method authorization uses
    [vault-events.md section 6.4](vault-events.md#relationship-peertransitioned)'s validated spelling comparison against the
    pinned document, without requiring byte equality with presentedDid.
35. <a id="dd-35"></a> Until exact-successor confirmation, every new package from that end
    carries its proof and long form. The root has no initial-handoff proof
    variant.
36. <a id="dd-36"></a> Direct and mediated delivery enter the same inbound fold.
37. <a id="dd-37"></a> Crash before `delivery.submitted` commits may recover by resending the
    same package; crash after its commit never resends that message ID. Committed
    intent and accepted inbound data survive each section-13 boundary.
38. <a id="dd-38"></a> Phase 1 works with one active full runtime and ordinary account-scoped
    Message Pickup; replica fan-out is not required.
39. <a id="dd-39"></a> A common pinned binding precedes first preparation on a send path and
    scopes first receipt on a receive path. Ordinary public-address replies
    need no rotation; carried proofs still validate before effects.

<a id="normalization-ack-and-retention-regressions-dd-40-dd-49"></a>

### Normalization, ACK and retention regressions (DD-40–DD-49)

40. <a id="dd-40"></a> A reader preserves duplicate `please_ack` or `ack` wire targets exactly,
    expands the current-message sentinel only for processing, and ignores
    later duplicate targets without changing the stored array.
41. <a id="dd-41"></a> Two implementations normalize every accepted attachment carrier, missing
    value, null, empty string and closed metadata field to the same semantic
    projection used by `intentHash`.
42. <a id="dd-42"></a> Conforming mediator operation persists and logs no application plaintext;
    any explicitly enabled bounded diagnostic mode is visibly outside the
    no-plaintext profile.
43. <a id="dd-43"></a> ACK target lookup is scoped by `(carrier.logicalPeerScope, wireMessageId)`;
    another relationship reusing the same wire ID is never acknowledged.
44. <a id="dd-44"></a> ACK target order uses the minimum complete receipt key, not canonical event
    order or EventStore change order; a clock rollback between two receives
    does not reverse their ACK order in a linear history.
45. <a id="dd-45"></a> Submitted completion survives restart, loss of local state, clock rollback,
    package retirement and envelope collection. Later duplicate input cannot
    reopen submission or require the collected envelope.
46. <a id="dd-46"></a> If one of several valid packages for a message ID is submitted, every package of
    that message ID stops work; selecting another package, route or handler cannot
    bypass completion.
47. <a id="dd-47"></a> Generic pure ACK copies carrier pthid and nullable creation time. An Empty
    rotation notification uses the same tuple with its policy-defined ACK
    request; one carrier cannot produce both variants.
48. <a id="dd-48"></a> After a common binding and restart, direct replies and verified rotations
    reconstruct the same relationship execution ID with no handoff event.
49. <a id="dd-49"></a> An unsubmitted package survives route unavailability and GC with its exact
    envelope. Committed submission or terminal failure releases its contribution
    under the retention fold; route recovery cannot reopen submitted work.

<a id="recovery-and-automatic-effects-dd-50-dd-56"></a>

### Recovery and automatic effects (DD-50–DD-56)

50. <a id="dd-50"></a> Recovery completes queued birth/binding work without inbound traffic and
    finds pickup-ACKed unfinished effects without redelivery.
51. <a id="dd-51"></a> A crash after an outcome-unknown transport call can reset the local retry
    budget, but never changes the wire ID, exact retry package or frozen expiry.
52. <a id="dd-52"></a> Retry, restore and later aliases reuse the same effect key and frozen
    intent before computing new ACK targets or timing. Concurrent local workers
    cannot commit different intents for that key, or change the ordinal to
    evade the conflict.
53. <a id="dd-53"></a> Protocol errors, pure ACKs and ordinary content use one R scope and retain
    their normal response rules. A different DID cannot join that R without
    verified continuation.
54. <a id="dd-54"></a> Equal-intent observations at root and successor local addresses execute
    once only if their saved evidence validates the same R. Missing references
    defer; mismatches conflict without choosing an observation by arrival
    order.
55. <a id="dd-55"></a> A batch containing new scope-bearing input, binding or transition and its
    dependent response is rejected. Commit prerequisites first; recovery uses
    that prefix without provisional scope.
56. <a id="dd-56"></a> Two workers handling one outbound serialize prepare/submit work. Observed
    acceptance commits before another dispatch, and no later dispatch starts
    after the submitted event. A crash before that commit still permits
    recovery with the same package rather than consuming a pre-call reservation.

<a id="binding-resolution-and-sender-eligibility-dd-57-dd-62"></a>

### Binding, resolution and sender eligibility (DD-57–DD-62)

57. <a id="dd-57"></a> An offline birth freezes symmetric R and birth addresses. Public addresses
    can send before a first reply. All later packages use current endpoints in
    that same R; birth metadata never blocks a valid repack.
58. <a id="dd-58"></a> A freshly resolved same-DID new key does not extend `peerChain(R)`. Outbound
    preparation follows [relationships.md section 10.1](relationships.md#did-resolution-requirements)'s message-scoped failure;
    an inbound at the local relationship DID without continuation proof has
    no scope and processes no ACK/effect. The contact diagnostic cannot make
    the observation executable, even when that R has a contact assignment.
59. <a id="dd-59"></a> All key-agreement keys of the same pinned document can authenticate in one
    R. Equal-intent wire variants merge once; fresh unpinned keys cannot
    enlarge membership or change birth identity.
60. <a id="dd-60"></a> A new non-numalgo-4 message ID resolves and commits current recipient evidence
    before first preparation. Transient unavailability leaves it retryable;
    definitive resolution failure is terminal under [relationships.md section 10.1](relationships.md#did-resolution-requirements). An unchanged online-revalidated document still creates new evidence.
    Existing packages retry or repack using retained snapshots only. Whenever
    an inbound delivery enters or resumes authentication, including duplicates,
    it uses current sender resolution; unavailability defers without pickup ACK
    only within that section's per-delivery budget. Definitive DNS failures
    and exhausted retries take the terminal pre-vault ACK path; redelivery
    cannot reset the active sequence. Recoverable local prerequisite waits
    consume no budget. Relationship-evidence waits and their evidence-change
    retries use that section's suspension and fresh-sequence rule.
    Reusing matching evidence requires a fresh document check. Recovery of
    committed input uses its retained snapshot without another network lookup.
61. <a id="dd-61"></a> Section 8.1's sender gate precedes selection and commit of a deterministic
    reply, including a natural response without ACK targets. A retired local
    end without a usable successor leaves durable input and unfinished work,
    with no reply intent or frozen ACK selection. Recovery after a valid local
    transition sends from that relationship's current end, reusing any already
    committed response instead of creating another effect.
62. <a id="dd-62"></a> Section 9's local-rotation vector preserves message ID, execution ID, effect key
    and automatic outbound message ID across local recipient keys. Historical local
    membership also permits ACKs across predecessor/successor packages under
    [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold); a shared contact alone does not.

<a id="rotation-membership-and-receipt-recovery-dd-63-dd-69"></a>

### Rotation membership and receipt recovery (DD-63–DD-69)

63. <a id="dd-63"></a> A proof at the original address or any local successor extends the common
    binding. Later proof-free input freezes generic binding/transition
    references. Partial imports defer; equal-intent variants retain one
    execution and response selection.
64. <a id="dd-64"></a> Opposite first sends with the same two canonical DIDs produce one R.
    Public/public, public/private and private/private pairs use the same
    formula and scope rules.
65. <a id="dd-65"></a> ACK membership uses the immutable outbound R plus verified binding/package
    evidence. Changing contact preferences or endpoint direction never
    reassigns an outbound.
66. <a id="dd-66"></a> Local and remote rotations commute across the two ends. Unsubmitted birth
    and ordinary intents repack while preserving their wire/execution IDs;
    submitted ones stay complete.
67. <a id="dd-67"></a> After a peer edge commits, a new message ID from the superseded node is terminal
    before message.in, with pickup ACK only. A matching committed observation
    message ID in R creates no new response obligation; ordinary unfinished work
    remains recoverable. Later transitions and import order cannot retroactively
    remove scope from previously committed input.
68. <a id="dd-68"></a> A new inbound binding commits before the message.in draft can reference
    its returned eventId. Crash at that boundary leaves no receipt, invitation
    consumption or pickup ACK; reauthentication reuses the binding, including
    when the incoming message is a pure ACK control observation. The enclosing
    receive operation holds the shared writer lock across lookup and these
    commits, excluding a competing outbound binding until it releases the lock.
69. <a id="dd-69"></a> After an authenticated unknown-iss carrier commits, its exact local/sender
    pair remains pending for later proof-free input until predecessor evidence
    and the verified edge are available. No new birth or provisional scope
    bypasses that deferral; unrelated local pairs are unaffected by the claim.
    The waiting proof-free delivery gets no message.in or pickup ACK. Evidence
    changes relevant to that pair trigger retry with a fresh bounded sender-
    resolution sequence when needed. While local wait state is retained, mere
    redelivery does not retry; loss of that state follows [relationships.md section 10.1](relationships.md#did-resolution-requirements)'s receive/authentication rule. Time in the evidence wait consumes neither
    resolver attempts nor its local retention stop. No local retention timeout
    clears the pending claim.
