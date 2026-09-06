# distributed-delivery/1.0

Status: **draft, phase 1** — phase-1 delivery profile for one active full vault
runtime. The identifiers and folds are future-safe for replication, but
`replica-mediation/1.0` and multi-writer execution are deferred.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

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

- the boundary between rendezvous discovery, pairwise relationships and
  replicas;
- IDs and hashes for logical content, immutable intent, exact DIDComm
  plaintext, encrypted packages and mediator deliveries;
- which DIDComm headers are frozen at intent time;
- package preparation and valid repackaging;
- submission and expiry states, with independent peer-receipt information;
- end-to-end durable receipt observations with DIDComm `please_ack` and `ack`;
- duplicate and conflict handling across process restarts and future replicas;
- the rendezvous bootstrap delivery profile; and
- idempotency requirements for automatic handlers.

It does not define the DASL object profile (`dasl-objects.md`), mailbox
fan-out (`replica-mediation/1.0`), the rendezvous receive profile
(`rendezvous.md`) or event/object replication (`vault-sync/1.0`).

## 2. Terms

- **Full replica** — an independently writable vault incarnation holding the
  seed and appending vault events. It may run locally or on a server.
- **Rendezvous DID** — a disclosed DID used to begin relationships. A remote
  peer may keep it for ordinary communication in the resulting relationship.
  Locally controlled rendezvous DIDs are vault-scoped `did:peer:4` entities;
  external targets are represented by pinned resolution evidence.
- **Relationship DID** — a vault-scoped pairwise `did:peer:4` used for one
  ongoing relationship.
- **Outbound message ID (`mid`)** — the vault entity ID of one outbound
  logical message, also used as its innermost DIDComm plaintext `id`.
- **Inbound observation MID** — a deterministic ID for one authenticated
  `(peer key, wire ID)` observation before verified aliasing.
- **Logical execution ID** — a durable, immutable identity used by automatic
  effects after one or more inbound observation MIDs are recognized as the same
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
- **Logical channel** — a local recipient key and authenticated peer key,
  interpreted through contact-scoped DID transitions.

```text
one outbound message (mid = wire ID, intent hash)
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

## 3. Addressing layers

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

Version 3 recognizes:

```text
rendezvous DID
    disclosed address for first contact
    self-resolving did:peer:4

relationship DID
    pairwise did:peer:4
    ordinary relationship traffic
```

Both are vault-scoped. The phase-1 active full runtime derives their private
keys and receives messages addressed to them. A later server or additional
full replica does not own the DIDs merely because it executes the vault.

Each local communication DID has one immutable `boundRoute`, mediated or
direct. Changing its keys or bound route creates a successor DID entity;
`vault-events.md` section 12.4 records a relationship's local continuation.
An external recipient's resolved document may offer transport choices; choosing
among authorized routes does not change the application recipient. A direct
endpoint MUST NOT expose a replica ID as the peer-visible recipient.

The phase-1 mediator uses ordinary account-scoped Message Pickup with one
active pickup client. The deferred `replica-mediation/1.0` extension may later
fan out an already encrypted package without changing the innermost recipient.

A valid `from_prior` handoff replaces a rendezvous DID only inside the named
contact relationship. The rendezvous DID remains usable for other parties.

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

The mediator treats rendezvous and relationship DIDs as recipient-role-neutral.
It does not need to know which role a registered recipient plays. HTTP or
mediator acceptance means only `submitted`; ultimate acknowledgment still
requires an authenticated application plaintext whose explicit `ack` names the
wire ID.

The mediator MUST bound normalized envelope size, retained ciphertext bytes,
retained message count, registered recipients, recipient-update rate, pickup
batch size and retention time. A quota or validation failure MUST NOT leave a
partially stored package. Anonymous routing responses SHOULD avoid becoming a
precise account- or recipient-existence oracle.

## 4. Vault-first sending and commit boundaries

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only.

A full vault runtime MUST be able to commit a send while DNS, DID resolution
and every mediator are unavailable. Before required network work it records:

- `mid`, also used as the wire ID;
- target contact or explicit channel;
- the immutable nullable initial-attempt metadata under `vault-events.md`
  section 9.2;
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
`event-store.md` section 2.1. Correctness MUST NOT depend on an uninterrupted
process lifetime or rebuildable cache state. A remote thin client without the
seed may stage a command offline, but the command becomes authoritative only
when a full vault runtime process-durably appends `message.out`.

### 4.1 Cross-layer commit and acknowledgment table

The following table is normative. "Committed" means process-durable success.

| Step | Required committed evidence | Permitted next action |
| --- | --- | --- |
| Object acceptance | Complete verified objects under the commit's writer lock | Append the referencing batch before releasing the lock |
| Outbound intent | `message.out` and every rooted object | Resolve, register, prepare or submit |
| Prepared package | `message.prepared` and its exact envelope; an initial outbound also requires its committed initiator binding under `vault-events.md` section 12.3 | Submit that exact package |
| Submission completion | Valid `delivery.submitted` for any package of the outbound | Stop all further preparation/submission for that MID; apply envelope retention under `vault-events.md` section 15.3 |
| Normal inbound | Objects, `message.in` and required channel evidence | Pickup-ACK, effect or peer ACK |
| Terminal pre-vault rejection | Safe terminal classification and bounded diagnostic, if any | Pickup-ACK only |
| Stable execution scope | Previously committed bootstrap input or relationship evidence, plus any required transition, under section 9 | Apply peer-scoped ACKs or derive and separately commit an eligible automatic intent |
| Ultimate peer ACK | Validated `ack` plus `delivery.acknowledged` | Record receipt information independently of submission work |

The terminal pre-vault path creates no `message.in`, peer ACK, contact or
handler effect. An ACK never substitutes for a missing `delivery.submitted`
event or retains a completed outbound's envelope for a later duplicate.

Object acceptance and event append use `Vault.commit` under `event-store.md`
section 10.

### 4.2 Send an ordinary message

The synchronous full-vault send operation:

1. prepares attachment objects;
2. prepares the stored message document;
3. selects durable nullable `createdTime`, optional `expiresTime`, exact
   `pleaseAck` value (null or array), exact ordered `ack` and complete `headers`;
4. computes the intent hash;
5. validates local sender and current peer target under `vault-events.md`
   section 9.2 and `rendezvous.md` section 8; without that section's qualifying
   inbound, use its initial-attempt procedure and constraints before intent
   commit. Ordinary traffic freezes `initial == null`; the peer may retain
   its rendezvous DID after a qualifying reply;
6. commits those objects with `message.out` through `Vault.commit`; and
7. returns `mid`.

It performs no network operation. When `createdTime` is null, preparation
omits `created_time`. Every outbound uses the same submission completion rule
in `vault-events.md` section 14.8, regardless of its `pleaseAck` or `ack` arrays.

The active phase-1 runtime may later:

1. stop when submitted, terminally failed, expired or conflicted under
   `vault-events.md` section 14.8;
2. fold target contact/channel;
3. choose valid sender DID, peer DID/key and exact resolution evidence under
   `rendezvous.md` section 5.1's resolution-freshness and same-DID key-change rules;
   ordinary work may select only an eligible `writeTo` under `vault-events.md`
   section 14.6, and an initial attempt follows its frozen selection under
   `rendezvous.md` section 8;
4. attach our frozen contact-scoped `fromPrior` while our own DID rotation
   remains unconfirmed;
5. construct complete plaintext by copying every intent-time header;
6. compute plaintext hash, encrypt, and use `Vault.commit` for the exact
   envelope and `message.prepared`;
7. submit directly or through Routing 2.0 with `packageId == forward.id`;
8. append `delivery.submitted` on acceptance or `delivery.failed` on terminal
   failure; record retryable failures only in local trace; and
9. schedule another attempt only while submission work remains eligible.

Within the active runtime, prepare/submit work for one logical MID MUST be
serialized. Before each transport call, recheck its committed completion and
eligibility state; after acceptance, commit `delivery.submitted` before
dispatching further work for that MID. This per-message scheduling boundary
does not hold the vault writer lock across network calls. If the process exits
before the submission event commits, reopen may submit the same exact package
again under section 13. No durable pre-call attempt reservation is required.

A new package may change address/security evidence only while the outbound is
unsubmitted, under validated repack rules and with the same intent hash.
Receiving may join equal wire IDs across a verified peer-key transition in one
relationship.

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

Values are copied from `M`. Absent thread values are null. Body and attachments
use the closed normalization in `vault-events.md` section 8. The semantic
projection contains no implementation-selected attachment metadata.

It excludes:

```text
typ, from, to, created_time, expires_time,
please_ack, ack, from_prior
```

`return_route` is forbidden in an Estoc vault application plaintext.

This projection is the `semantic` member of the intent projection below. It
has no separately stored hash.

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

### 5.3 Exact plaintext hash

`plaintextHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for the complete innermost DIDComm plaintext actually encrypted by one
package or received in one observation. It includes `from`, `to`, `from_prior`
and every present header.

All packages for one outbound `mid` agree on the intent hash. They may have
different plaintext hashes only when package-level addressing or security
evidence changes under an expressly permitted rule.

## 6. Preparing a package

A preparer folds the target and selects:

- one live sender DID entity and its fixed key-agreement method, using the
  relationship's current local end under `vault-events.md` section 12.4;
- one current peer DID and authenticated peer key;
- exact `peer.resolved` evidence, fresh for the first package of each new
  non-numalgo-4 MID under `rendezvous.md` section 5.1;
- one recipient route authorized by that evidence; and
- any required contact-scoped `from_prior`.

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

The plaintext `id` is the committed `message.out.mid`. The preparer
RFC-8785-canonicalizes the plaintext, computes `plaintextHash`,
encrypts, parses the encrypted-message JSON with duplicate-member and I-JSON
validation, and uses `Vault.commit` to accept
`UTF8(RFC8785(parsedEncryptedEnvelope))` as one raw DASL object with
`message.prepared`. Submission uses those exact stored bytes.

Retrying an unsubmitted package reuses identical plaintext, normalized
ciphertext bytes and package ID. While the logical outbound remains
unsubmitted, a new package for it may change `from`, `to`,
selected keys, peer resolution or `from_prior` only under a valid DID-entity
selection or verified contact-scoped transition for the same logical target.
A local DID's keys and bound route never change in place; an external
recipient's transport choice remains constrained by its resolution evidence.
Every changed plaintext or encryption result requires a new package ID and
plaintext hash. One initial rendezvous wire ID remains pinned to its original
resolution snapshot and recipient key.

## 7. Submission completion and expiration

`vault-events.md` section 14.8 is the sole owner of submission completion and
work eligibility. A worker checks that fold before preparation or submission.
After a valid `delivery.submitted` commits for any package, it MUST NOT prepare,
repackage or submit any package for that logical MID again. This includes
timer-driven work, reopen recovery and duplicate-triggered responses, even
when no peer ACK ever arrives. A deliberate later send creates a new
`message.out` and wire ID.

Before completion, an expired message receives a message-scoped terminal
`delivery.failed(code="expired")` and no new submission. Reaching expiry after
submission does not create a new delivery failure. An ACK can still supply
receipt information, including the late indicator defined from committed
carrier observations in `vault-events.md` section 14.8, without changing
submission state or work eligibility.

Eligible unsubmitted work may use local timers, backoff and recovery. Protocols
may impose tighter limits; `rendezvous.md` section 14 defines initial-message
defaults. Route recovery or a changed clock never reopens a submitted or
terminally failed outbound.

`vault-events.md` section 15.3 is the sole normative envelope-retention rule.
An unsubmitted, non-terminal package remains retained through unavailable
routes and retryable resolution failures. Committed submission releases this
outbound's envelope contribution without waiting for ACK or keeping bytes for
later response replay. Event skeletons, message content and independent
references retain their own lifetimes under that fold.

## 8. Durable end-to-end acknowledgment

### 8.1 Freezing an ACK target set

Before selecting or committing any new deterministic reply intent, including
a natural protocol response with no ACK targets, the writer MUST check for a
usable local sender in the input's unique relationship scope. This means that
relationship's `currentLocalDid(R)` is eligible in its contact's `writeTo[]`
under `vault-events.md` sections 12.4 and 14.6. It is a portable lifecycle and
evidence check, not a requirement for online resolution or registration before
intent. A sender in another relationship of the same contact cannot substitute.
For a permitted non-relationship channel, the exact channel's local sender
must satisfy the same local DID/route restrictions.

If there is no usable sender, receive and scope the input normally but commit
no reply intent and freeze no ACK targets. Required response/ACK work remains
unfinished, rediscovered from committed input under `vault-events.md` section
16.1 when a usable sender exists, including after a local successor is created.
Current tombstones, integrity and erasure rules still apply. Already committed
intents are reused; later rotation or retirement uses that document's section
12.4 repack/blocking rules without minting a replacement effect.

A first application candidate under `rendezvous.md` section 3 may materialize
its root DID and handoff intent together under that document's section 10.2.
For this case the proposed materialization must pass the same local sender
checks in the batch; its scope must still come from previously committed input
under section 9. Control or non-handoff input cannot create that DID. Recheck
the applicable gate under the same writer lock as selection and intent commit.

For one received carrier message `X`, a conforming receiver performs this
algorithm after normal inbound commit, only when no response intent already
exists under section 11 and the sender gate above passes:

1. If `X.pleaseAck == null`, create no ACK obligation.
2. Expand `""` to `X.wireId`; retain the first occurrence of every target and
   ignore later duplicates.
3. Derive `X.logicalPeerScope` under section 9.
   Look up each requested wire ID only as `(X.logicalPeerScope, wireId)`. The
   current `X.wireId` is known by virtue of X's own derived scope. An older
   target is eligible only when it is conflict-free and derives to the exact
   same scope. A verified key transition may widen lookup only inside one
   relationship scope; unrelated relationships, unknown senders,
   conflicted targets and ambiguous scope attribution are omitted.
4. Derive each target's `firstReceiptKey` under `vault-events.md` section
   10.2 as the minimum complete `(integer receiptOrdinal, author)` tuple across
   its valid observations and verified aliases. Sort targets ascending by that
   key within X's scope, never by decimal-string, canonical-event or
   `ChangeToken` order. Equal ordinals from different authors are valid and
   compare by author; omit only targets affected by a receipt-integrity
   conflict, not unrelated messages.
5. Freeze that exact ordered array as `message.out.ack` in one deterministic
   natural response or one deterministic pure ACK associated with X's logical
   execution ID.

A requested target unknown or outside X's peer scope at step 3 is omitted.
Its later arrival does not mutate the frozen response or create a second ACK
effect for X; the sender may request it again in another message. If
no target remains, the receiver creates no ACK-only effect. DIDComm message IDs
are sender-scoped; wire-ID equality elsewhere in the vault is never sufficient
evidence for an ACK target.

This preserves actual first-receipt order in a linear writer history. After
union of independently run copies, the same key supplies deterministic recovery
order, not a reconstruction of physical receive time across those copies.
Import never rewrites an already frozen response or grants a new multi-writer
execution guarantee.

Before proposing the response it MUST have authenticated and validated X,
accepted every retained object and process-durably appended `message.in`.
Any additional non-conflicted scope or channel evidence needed for the
response MUST already be committed before deriving the response execution ID,
freezing ACK targets or committing its intent under section 9.

The response thread follows X, not each older target:

```text
thid  = X.thid, or X.wireId when X.thid is null
pthid = X.pthid
```

Remote Report Problem correlation in `rendezvous.md` section 13 instead
uses its child-thread `pthid` rule; this profile selects no local rejection effect.

A natural response may carry the frozen `ack` array. If no deterministic
natural response is available, use `https://didcomm.org/empty/1.0/empty`.
Pure ACKs contain no `please_ack` and follow the same submission completion
rule as every outbound; they are control observations under `vault-events.md`
section 14.7. A control candidate at a rendezvous DID never selects a handoff
response. Its permitted receipt ACK uses the generic profile subject to the
same gate above and `rendezvous.md` section 10; the ACK request alone cannot
materialize a local DID.
No-handoff errors retain their no-response rule.

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

This is the **generic pure-ACK profile**. A rendezvous handoff Empty Message
uses the same handler, kind, ordinal and execution/key/output-ID recipe,
but it is not this generic profile: `rendezvous.md` freezes its timing,
`please_ack`, `from_prior` and thread values before intent commit. One carrier
MUST NOT create both a generic pure-ACK effect and a
rendezvous handoff-Empty effect; selecting the handoff fallback consumes the
carrier's ACK obligation. Only an application candidate can select that
fallback under `rendezvous.md` section 10; receiving a pure ACK at a rendezvous
key does not turn it into a handoff trigger.

The executable vector uses execution scope
`{"relationship":"9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3"}`, carrier wire ID
`019b1b61-3444-7190-9db5-1cc9c215eb23` and the tuple above.

The generic execution/effect derivation in sections 9 and 11 produces:

```text
executionId      = 225e9711-ab0b-510a-bb99-405e6aaf4bf9
effectKey        = UruAITvrqWKj_ag-HbwVlxM4TQAQvwFuoefti2CD-W8
outbound MID = wire ID = 0db52549-496c-5e54-9e60-d660397b5e34
```

### 8.3 Applying `ack`

An authenticated plaintext acknowledges an outbound only when its explicit
`ack` array names that outbound wire ID, the candidate outbound belongs to the
same validated logical peer scope as the ACK-bearing carrier, and every
package-level addressing, transition and protocol-specific proof gate has
passed. `vault-events.md` section 14.8 defines outbound membership using exact
initial/handoff references and validated package/DID evidence. Lookup is
`(carrier.logicalPeerScope, acknowledgedWireId)`, never a vault-global wire-ID
search. Threading, a natural response, transport acceptance, `please_ack`
presence or a mediator receipt is insufficient without the explicit value.

A valid ACK adds receipt information only. It neither creates a missing
`delivery.submitted` nor changes submission eligibility or envelope retention.
Duplicate ACKs are harmless. Acknowledged means durable receipt by the peer
vault, not read, displayed or accepted by a business workflow.

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
Required ACK work left unfinished by a crash still follows `vault-events.md`
section 16.1's recovery rules, subject to the same submitted boundary.

## 9. Observation identity, logical aliasing and execution identity

`peerKey` below is derived from the observation's referenced
`peer.resolved(peerResolution).peerKey` under `vault-events.md` section 4.1;
it is not duplicated in `message.in` or `message.prepared`. The same derivation
supplies their `ChannelKey` values and all message/package peer-key comparisons
in this document. A missing non-null reference defers, never falls back to null.

For an authenticated or signed innermost message:

```text
mid = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v1", "authenticated", peerKey, wireId])
)
```

For a truly anonymous message:

```text
mid = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v1", "anonymous", myKey, wireId])
)
```

This value identifies an observation namespace. The authenticated form omits
`myKey`, so a valid repack to another accepted local DID/key can converge
under one MID.

The published authenticated vectors are executable:

```text
peerKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
wireId  = 019b2a70-f225-721c-835f-67175be0667e
mid     = 369d7a43-8dce-5b86-b073-e390d457f357

peerKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
wireId  = 019b1b61-3444-7190-9db5-1cc9c215eb23
mid     = a8b9afd5-60fe-5f49-a669-bd998e760e7e
```

These vectors intentionally use wire IDs different from the outbound examples
in `vault-events.md` section 9. Equal wire IDs chosen independently by different senders are not by
themselves a protocol violation; sender/relationship scope is part of logical
identity and ACK lookup.

A verified contact-scoped transition may cause observations with different
authenticated `peerKey` values and therefore different MIDs to represent one
logical message. `vault-events.md` section 14.7 defines that second-stage merge. The original
observation MIDs remain stored for audit and conflict detection.

These values are **observation identities**. Equal intent hashes under one MID
form one observation group; differences are intent conflicts.

Automatic execution uses a stable **execution scope**, not an observation MID.
Its unique derived value is the carrier's **logical peer scope**
(`logicalPeerScope`) for ACK lookup, duplicate handling and automatic execution.
The closed phase-1 scopes are:

```json
{ "relationship": "<relationship ID>" }
```

or, for a durable channel that is not part of a relationship and for which
cross-key aliasing is forbidden:

```json
{
  "channel": {
    "myKey": "did/.../key-agreement",
    "peerKey": "..."
  }
}
```

Derive the scope of each authenticated observation `o` from committed,
validated evidence only. Mediation channels and anonymous observations have no
application execution scope. Missing prerequisites defer processing;
conflicting evidence cannot authorize another scope.

A `Vault.commit` validator MUST derive an automatic intent's execution scope
and ACK targets from the event set committed before that call. A proposed
bootstrap input, binding or transition in the same batch cannot supply scope.
Commit those prerequisites first, then derive and commit the response intent
in a separate call. Other intra-batch reference/schema checks remain part of
ordinary batch validation; they do not create an execution-scope exception.
A crash between calls is recovered from the committed prefix under
`vault-events.md` section 16.1 and the protocol's response rules.

For relationship `R`, `peerChain(R)` is the historical set of canonical
`(peer DID, peerKey)` pairs backed by the following exact retained snapshots:

- on the initiator, every key-agreement key authorized by
  `peer.resolved(initiatorBound.resolution)` under its canonical peer DID;
- on the responder, every key-agreement key in
  `peer.resolved(relationship.established.originResolution)` under its
  canonical sender DID. That event is the selected origin observation's
  `peerResolution`, frozen independently of later duplicates; and
- for each valid `peer.transitioned` naming `R`, its authenticated `peerKey`
  and all key-agreement keys of its frozen `peerResolution` document, under
  its canonical `to` DID. This reference matches the selected carrying
  inbound and cannot be replaced by a later observation of the same MID.

The `keyAgreementKids` list in each named resolution must agree with all
key-agreement authorizations in that document. Resolve each method to the
canonical public-key value in `vault-events.md` section 4.1. Unsupported keys
cannot be selected or used to authenticate, but must not be silently mistaken
for another key. Missing snapshot evidence defers the affected validation;
fresh resolution cannot substitute unless it recovers the identical raw CID.

The selected initial-package key and `relationship.established.peerKey` retain
their origin roles; other authorized keys are chain members without origin
status. On the initiator, the peer's pinned rendezvous keys are members before
any reply; on the responder, the origin sender document supplies the keys.
Fresh unpinned resolution never extends this set. Verified transitions add
successor document keys without removing historical scope evidence.
Membership scopes authenticated observations; it does not authenticate a new
delivery. Current sender authentication follows `rendezvous.md` section 5.1
even when the presented key belongs to this historical set.

Membership always checks DID and key from the same pinned or transition
snapshot, not two unrelated entries. A reply under another authorized key in
that snapshot needs no rotation. Equal-intent wire messages under those keys
can merge in this same relationship under `vault-events.md` section 14.7.
The same key under another unverified DID cannot join by key equality alone.

Retirement preserves this historical set. Current address, route availability
and contact tombstones govern work eligibility separately. A same-DID new key
outside this set, received at the local relationship DID without continuation,
has no scope and follows `rendezvous.md` section 5.1's diagnostic rule. The
same rule applies to a recognized successor DID at its relationship's
original rendezvous recipient. New bootstrap candidates follow their
key-derived input row; continuation traffic is excluded from that row.

The local side uses historical `localChain(R)` from `vault-events.md` section
12.4. A local transition extends acceptable recipient-key membership without
changing `R.ourDid`, the relationship ID, execution ID or ACK namespace. Local
chain conflicts or missing referenced evidence suppress affected ACK/effect
work just like missing or conflicting peer-chain evidence.

For inbound scope, `relationshipRecipientKeys(R)` under `vault-events.md`
section 14.4 additionally includes the responder's original rendezvous key.
That key does not become a member of `localChain(R)` or a possible sender.
At that address, a carried `from_prior` or non-null `message.in.peerTransition`
selects the relationship-traffic path before any bootstrap derivation. The
writer freezes that reference for proof-free successor input under
`vault-events.md` section 10.2. Such a path requires retained, validated
transition evidence; it cannot fall back to the candidate row while
verification is pending or conflicting. The original
no-proof bootstrap inputs retain their candidate classification under
`vault-events.md` section 12.1, including after materialization.

| Observation | Required committed evidence | Derived scope |
| --- | --- | --- |
| Responder bootstrap candidate under `vault-events.md` section 12.1, excluding continuation traffic | Committed `o` with `myKey` identifying one immutable local rendezvous DID and its exact `peerResolution` under that section and section 14.4 of that document | The deterministic relationship derived from that canonical recipient DID and `o.peerKey`, even before materialization; missing evidence defers and integrity conflicts suppress effects |
| Relationship traffic, including direct initial replies, handoffs, no-handoff reports and peer continuation at the original rendezvous | Relationship `R` with `o.myKey` in `relationshipRecipientKeys(R)` and `(o.did, o.peerKey)` in `peerChain(R)` through the same pinned or verified transition snapshot defined above. At a rendezvous recipient, use the transition validating this carried `from_prior`, or the exact `o.peerTransition` when the proof is absent; its successor document must authorize the observed DID/key. Every carried proof has its required committed transition evidence | That unique `R`; no match supplies no scope |

Each row contributes at most one scope; multiple matching relationships are
an execution-scope conflict. All applicable rows for one observation MUST agree.
A row that does not apply contributes nothing. If an applicable row lacks
required evidence, or no row supplies a scope, the observation has no scope
yet. For group consistency this is missing evidence, not a competing scope
value. A new sender without verified continuation evidence does not acquire an
existing relationship's scope through thread IDs, ACK targets or DID labels.
The initiator never falls back to a temporary bootstrap channel for a direct
reply or no-handoff error.

Apply the following rules to every valid observation in one MID group:

1. Conflicting derivation evidence or two distinct derived scopes makes an
   execution-scope conflict, even when another observation is unresolved.
2. Otherwise, any observation with no scope leaves the whole group deferred.
   This includes a candidate with missing DID/resolution evidence
   alongside an observation already attributed to a relationship. The deferred observation cannot be
   ignored to run the rest of the group.
3. Only when every observation derives the same unique scope may the group
   process ACKs or eligible effects and participate in `vault-events.md`
   section 14.7's transition-aware union.

Deferral and conflict preserve history but suppress ACK processing and new
effects, without selecting a row, observation or canonical winner. A later
observation may defer or conflict a previously executable group; already
committed ACK results and emitted effects remain history and do not authorize
an alternative execution identity.

The execution identity is:

```text
executionId = UUIDv5(
  estocNamespace("message-execution"),
  RFC8785(["v2", executionScope, wireId])
)
```

Initiator binding and transition recovery follow `rendezvous.md` section 12
even when the responder DID is already known. A remote no-handoff report
uses the initiator's pinned relationship scope, with control classification and diagnostics
under `vault-events.md` sections 14.7 and 14.6.

A message without a unique stable scope is **effect-deferred**. It MUST NOT
execute under a provisional observation, contact or channel identity. A later
verified alias reuses the relationship-derived execution ID; a conforming
runtime never executes once per peer key and repairs it by choosing a smaller
MID. All required scope evidence MUST commit before applying explicit ACKs or
selecting, committing or running automatic effects. A response intent and
its ACK targets cannot freeze in the same commit that first supplies their
scope evidence.

Control-observation classification and display follow `vault-events.md`
section 14.7.

#### Local-rotation scope vector

Using the existing relationship, key and carrier fixture above, let two
validated local transitions extend P0 to P1 and then P1 to P2, each with the
predecessor-confirmation evidence required by `vault-events.md` section 12.4:

```text
R  = 9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3
P0 = 019b2a60-c68e-75bf-b6fb-ae1a41f8d715
P1 = 019b6a10-12c0-7410-89ab-38e54b097c21
P2 = 019b6a20-12c0-7420-89ab-38e54b097c22
peerKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
wireId = 019b1b61-3444-7190-9db5-1cc9c215eb23

for myKey = did/<P0|P1|P2>/key-agreement:
  mid = a8b9afd5-60fe-5f49-a669-bd998e760e7e
  executionScope = {"relationship":"9e2aa6ec-7a8b-517c-8790-bb366cd5f0b3"}
  executionId = 225e9711-ab0b-510a-bb99-405e6aaf4bf9
  pure-ack effectKey = UruAITvrqWKj_ag-HbwVlxM4TQAQvwFuoefti2CD-W8
  pure-ack outbound MID = 0db52549-496c-5e54-9e60-d660397b5e34
```

Each observation references resolution evidence with its own `myKey` and this
same authenticated peer key/DID pair in `peerChain(R)`. Equal-intent deliveries
at P0, P1 and P2 therefore share one execution, even after P0 retires. An
explicit ACK at P2 may acknowledge an outbound whose historical valid package
sent from P0, and an ACK at eligible P0 may acknowledge a package from P2, by
`vault-events.md` section 14.8 path 2. A DID outside this chain supplies no such
membership. These are executable identity and scope fixtures, not JWT or
numalgo-4 document test vectors; the DID entity IDs stand for validated local
documents and transition proofs.

### 9.1 Receive a message

For every account-scoped pickup or direct delivery:

1. while the vault is locked, recovery is incomplete, or the local key index is
   not yet authoritative, do not classify recipient ownership; keep the
   delivery pending without pickup ACK;
2. once local key state is authoritative, inspect every recipient `kid` before
   decryption and apply `rendezvous.md` sections 9.1–9.2's exact-key and
   lifecycle classification. A retired relationship DID alone is not terminal
   for receipt: eligible input is received and scoped normally, without
   renewed registration. A retired rendezvous DID or any DID with a terminal
   bound-route dependency is terminal. Safely classify terminal input,
   pickup-ACK it when mediated, and append no `message.in`, contact or response
   effect; recoverable prerequisites defer without pickup ACK;
3. authenticate, decrypt and validate the complete innermost message,
   including the exact selected local key-agreement method, Peer DID long-form
   and authcrypt sender evidence. Apply `rendezvous.md` section 5.1's current
   sender-resolution and failure-classification rules to every delivery;
   transiently unavailable resolution defers without pickup ACK only within
   its per-delivery budget. Definitive failures and budget exhaustion use its
   section 9.2 terminal gate; recoverable local prerequisites have no such budget;
4. when addressed to a rendezvous DID, run `rendezvous.md` section 10.2's
   receive and integrity checks; a safely classified terminal failure through Message Pickup
   MUST be pickup-ACKed without `message.in`;
5. for input passing the receive and integrity checks, derive channel,
   observation MID, intent hash and exact plaintext hash;
6. prepare retained body/attachment objects and the stored message document;
7. commit/reuse the exact `peer.resolved` and document under `rendezvous.md`
   section 5.1's evidence-reuse rule first, then use its returned event ID as
   `message.in.peerResolution` in a separate
   `Vault.commit` with the retained content, applicable contact attachment and
   non-controversial observations. For a first application candidate, bootstrap
   attachment commits with materialization under that document's section 10.2;
   a control candidate alone creates no contact. Recheck recipient eligibility
   and retain the writer lock across both commits, including for duplicates.
   A rendezvous input also performs its integrity checks under that lock;
   its `myKey` identifies the immutable local rendezvous DID. The complete
   channel key derives its peer public key through the committed resolution;
8. only then ACK the account-scoped mediator delivery;
9. before processing ACK values or continuation, validate every package-level
   proof; a handoff carrying `from_prior` requires exact pinned historical
   evidence even if the sender DID is already known; recover and commit any
   missing initiator binding before transition or response work. At an
   original rendezvous recipient, use the same continuation path under
   `rendezvous.md` section 12, never a provisional new bootstrap scope;
10. after validation, commit `peer.transitioned` when applicable; a rotation
    extends the already committed relationship binding, while a direct reply
    from its pinned DID requires no rotation;
11. resolve the stable relationship or non-transitioning channel execution
    scope; if required transition/binding evidence is missing, defer ACK
    application and automatic effects. Apply `rendezvous.md` section 5.1's
    same-DID key-change diagnostic when its complete evidence is present;
12. only after that unique derived logical peer scope exists, process explicit
    `ack` values into idempotent peer-scoped `delivery.acknowledged`;
13. schedule eligible deterministic application effects through that execution
    ID under `vault-events.md` section 14.7's control-observation rules; the
    no-handoff error classification permits ACK processing in step 12 and
    no automatic responses in steps 14–15. Only application candidates enter
    `rendezvous.md` section 10.2's materialization. Continuation traffic at a
    rendezvous uses ordinary relationship handlers and ACK rules, with no new
    handoff or relationship. Control and other non-handoff candidates follow
    its section 10 without creating a relationship;
14. check section 8.1's local-sender gate, then run the frozen peer-scoped
    ACK-target algorithm in
    `distributed-delivery.md` section 8; when at least one target is honored,
    append one deterministic protocol response or pure-ACK intent; and
15. on duplicate receipt, reuse existing response work under section 8.4;
    a submitted response causes no further preparation or submission.

Control observations follow `vault-events.md` section 14.7. A pure ACK has
`pleaseAck == null` to avoid an ACK loop; its submission follows the same
completion rule as every other outbound.

A crash before durable message commit leaves mediator delivery pending. A
crash after commit but before pickup ACK causes redelivery and another valid
duplicate observation.

## 10. Rendezvous bootstrap delivery

Rendezvous is a processing profile, not an Estoc DIDComm protocol family. The
initial attempt to a rendezvous DID carries an ordinary application message.
`rendezvous.md` section 8 owns its durable local classification and constraints.

When no other content is available, the initiator sends Trust Ping 2.0 with
`response_requested == true`, `please_ack: [""]`, common nullable expiry and
the OOB invitation ID as `pthid` when applicable. An application protocol may
instead send its real first message. There are no initial-specific type, size
or lifetime limits, and receipt/materialization has no expiry deadline.

After durable receipt of an application candidate as defined in `rendezvous.md`
section 3, the responder selects a
deterministic handoff response: Trust Ping `ping-response`, a protocol-defined
deterministic machine response, or Empty Message ACK. Human-authored content is ordinary
later traffic. Control and other non-handoff candidates retain scope and
follow `rendezvous.md` section 10's receipt-ACK rules without selecting a
handoff or materializing a relationship.

A local Estoc responder sends its first message from its relationship DID,
with `from_prior`, eligible requested ACK targets and `please_ack: [""]`.
Its submission completes at committed `delivery.submitted` even while rotation
confirmation remains pending. A remote peer may keep its original rendezvous
or public DID: its authenticated replies use the initiator's precommitted
relationship scope without a handoff. When a peer does rotate, the receiver
verifies and commits `peer.transitioned` before applying the carrier's ACKs
or selecting response intents under `rendezvous.md` section 12.

Until the responder receives an authenticated message addressed to the new
relationship DID, outbound packages from that DID carry the same byte-stable
`from_prior`. Known integrity failures create no local rejection effect;
remote errors follow `rendezvous.md` section 13. There is no custom decline message.

## 11. Automatic effects

An automatic DIDComm output is one effect identified by
`(executionId, handlerId, effectKind, ordinal)`. `executionId` MUST equal the
derived execution ID of a unique conflict-free carrier group. Each protocol
MUST define its handler ID, effect kind, stable non-negative integer ordinal
and output intent rules. Its outputs MUST obey `vault-events.md` section 14.8's
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

The key is unpadded base64url. It determines the outbound MID and wire ID under
`vault-events.md` section 9.1. The effect's content is its `message.out` intent.
That event retains the complete producing tuple under its section-9.2 schema;
the stored `ordinal` is exactly `decimalOrdinal`, not a runtime-only counter.
One key permits only one compatible intent under that document's section 14.8;
payload validation MUST verify the execution ID against that carrier group,
the stored tuple and output intent against the producing protocol, the key
against that tuple, and the MID against the key.

Under the writer lock in `event-store.md` section 10, the runtime MUST derive
the carrier's execution ID and check for an already-selected ACK-bearing
response under `vault-events.md` section 14.8 before selecting an ACK response
handler or tuple. If one exists, reuse it; a new handler or tuple cannot consume
the carrier's ACK obligation again. Competing imported selections suppress
response work under that fold.
For a new DIDComm reply, apply section 8.1's local-sender gate before selection;
missing a sender leaves unfinished work without committing intent.
For each eligible effect, look up its derived MID before freezing ACK targets,
timing or other intent fields.
It reuses an existing non-conflicted intent; it MUST NOT regenerate one after
content erasure, submission, a later observation or a changed clock. If no
intent exists, it commits the intent through `Vault.commit` before effects.
Derivation, lookup and commit are one locked operation.
Bootstrap input, initiator bindings and required transitions MUST already
be committed before this operation. A batch cannot authorize its own response
scope; section 9 permits no prospective-scope exception.
A conflicting local intent is rejected before append; imported conflicts remain
history and suppress work under `vault-events.md` section 14.8. Duplicate
carriers may resume only unsubmitted response work under section 8.4.

Other external effects MUST commit their protocol-defined portable intent
before execution and use that protocol's idempotency or explicit at-least-once
contract. The message fold does not validate those payloads.

Phase 1 has one active writer but still makes no process-level exactly-once
claim. A future multi-writer profile must coordinate automatic execution before
claiming stronger behavior.

## 12. Required vault observations

Exact schemas are in `vault-events.md`:

```text
message.out                       durable intent and immutable headers
message.prepared                  exact plaintext and encrypted package
message.packageRetired            package no longer submitted
delivery.submitted                transport accepted a package
delivery.failed                   terminal package or message failure
delivery.acknowledged             ultimate peer ACK named the wire ID
message.in                        durable inbound observation
peer.transitioned                 DID continuation in one named relationship
relationship.established          stable responder-side pairwise relationship
relationship.initiatorBound       portable initiator-side relationship binding
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
  "mid": "<deterministic inbound message id>",
  "wireId": "<innermost message id>",
  "receiptOrdinal": "42",
  "intentHash": "<base64url sha-256>",
  "plaintextHash": "<base64url sha-256>",
  "createdTime": null,
  "expiresTime": null,
  "pleaseAck": [""],
  "ack": [],
  "myKey": "did/019b.../key-agreement",
  "peerResolution": "<exact-peer.resolved-eid>",
  "peerTransition": null,
  "receivedVia": {
    "mediation": "019b...",
    "deliveryId": "019b..."
  }
}
```

## 13. Failure rules

- Before intent commit, no vault message exists.
- After intent commit but before preparation, the active full runtime may
  prepare later; a future replicated profile may allow any full replica to do
  so.
- After package storage but before submission observation, the exact package
  may be submitted again.
- After mediator acceptance but before `delivery.submitted`, retry reuses the
  exact package idempotently. Missing submission evidence does not prove that
  no attempt occurred; the rendezvous attempt budget is runtime-local policy,
  not a crash-persistent lifetime cap.
- After `delivery.submitted` commits, restart, duplicate receipt and missing
  ACK never cause another submission or replacement package for that MID.
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

## 14. Privacy

Wire IDs, message types and content are visible only inside end-to-end
encrypted application messages. Package IDs and recipient routing DIDs are
visible to the mediator. Delivery IDs are visible to the recipient mediator.
A future replica-mediation profile
would additionally expose opaque replica IDs to that mediator.

A disclosed rendezvous DID is intentionally correlatable within its audience.
Relationship DIDs SHOULD be disclosed only in encrypted channels and use
Peer DID long form on first disclosure.

Pure ACKs reveal durable receipt timing to the ultimate peer, not which
replica received first. Implementations SHOULD NOT encode contact names,
replica labels, event IDs or content in peer- or mediator-visible IDs.

## 15. Required conformance cases

1. `message.out` commits with all networking disabled.
2. A peer addresses a rendezvous or relationship DID, never a replica ID.
3. `pleaseAck == null` omits the wire header; an array is preserved exactly on
   the wire.
4. `pleaseAck == []` requests no explicit acknowledgment.
5. `pleaseAck` containing `""` or the current wire ID requests its receipt;
   an array naming only older IDs does not. Neither changes submission work.
6. A receiver accepts the standard empty-string sentinel and current-message
   ID form and expands them to the current wire ID for processing.
7. Intent freezes `createdTime`, `expiresTime`, exact `pleaseAck`, exact `ack`
   and every supported additional header.
8. `return_route` in vault application headers or innermost plaintext is
   rejected.
9. Two valid preparations of one intent agree on the intent hash.
10. Retrying one package uses identical plaintext, ciphertext and package ID.
11. A permitted address/key transition creates a new package/plaintext hash
    while preserving wire ID and intent hash.
12. Body, type, thread, attachment, timing, ACK policy or additional-header
    changes under one wire ID produce an intent conflict.
13. HTTP or mediator acceptance records submitted, never acknowledged.
14. Every outbound stops all preparation/submission after committed
    `delivery.submitted`, including when its `pleaseAck` requests the current
    wire ID and no ACK arrives. A later transport failure or expiry does not
    replace the submitted outcome.
15. A deterministic response acknowledges a message only when explicit `ack`
    names its wire ID.
16. ACK is emitted only after durable inbound commit.
17. Pure ACK uses `pleaseAck == null`, creates no ACK loop and completes
    submission at the same committed boundary as other outbounds.
18. A pure ACK whose carrier omitted `created_time` commits
    `createdTime == null` and omits the wire header on every preparation.
19. The fixed pure-ACK vector derives execution ID
    `225e9711-ab0b-510a-bb99-405e6aaf4bf9`, effect key
    `UruAITvrqWKj_ag-HbwVlxM4TQAQvwFuoefti2CD-W8`, and one outbound/wire ID
    `0db52549-496c-5e54-9e60-d660397b5e34`.
20. One carrier that requests current and older known IDs freezes one ordered
    deduplicated ACK target set; unknown targets arriving later do not mutate
    the response effect.
21. A valid ACK received before `delivery.submitted` adds receipt information
    without completing submission or releasing its envelope. Eligible pending
    submission remains recoverable with its exact package.
22. A duplicate carrier reuses its frozen response. Before submitted it may
    resume eligible work; after submitted it causes no send, even when the
    exact response bytes remain. Collected bytes do not cause a replacement.
23. Valid address variants converge; invalid variants conflict.
24. Equal wire IDs under transition-verified peer keys merge only through the
    same stable relationship execution scope; unrelated key reuse does not.
25. A repackaged observation that arrives before transition evidence remains
    effect-deferred. After verification it derives the same relationship/wire-ID
    execution identity and cannot execute once per peer key.
26. Multiple relationship matches or incompatible derivation rows for one
    observation suppress ACK processing and new effects as an execution-scope
    conflict, even when each source is individually valid.
27. Pure Empty ACK, valid initial-response Empty or `ping-response`, and
    no-handoff errors obey `vault-events.md` section 14.7, including replies to
    subsequent initial attempts on an already bound relationship. Validated
    ACKs and eligible ACK requests still process. Arrival at a rendezvous DID
    never promotes control input to a handoff trigger; a permitted response
    uses the generic pure-ACK profile from an existing usable relationship DID.
28. Invalid `from_prior` prevents ACK processing and transition.
29. Duplicate explicit ACKs are harmless and affect only peer receipt
    information, never submission completion or envelope retention.
30. Expiry stops unsubmitted work permanently. Receipt `late` follows
    `vault-events.md` section 14.8's committed observation-time rule for both
    submitted and expired messages, without changing submission outcome or
    restarting work. Already-submitted messages acquire no new expired failure.
31. The default initial rendezvous message may be Trust Ping; a received
    application message may be first without a custom wrapper.
32. No emitted message uses an `https://estoc.dev/rendezvous/1.0/*` type.
33. Before confirmation of the responder's initial local end, a deterministic
    handoff response from it carries pairwise long-form sender evidence,
    the initial handoff's frozen `from_prior`, explicit ACK and
    `please_ack: [""]`.
34. `from_prior.sub` equals plaintext `from` byte-for-byte; `from_prior.kid`
    belongs to the exact `iss` spelling pinned from discovery.
35. Until handoff confirmation, every responder message from the new pairwise
    DID carries the same `from_prior` and long-form sender spelling.
36. Direct and mediated delivery enter the same inbound fold.
37. Crash before `delivery.submitted` commits may recover by resending the
    same package; crash after its commit never resends that MID. Committed
    intent and accepted inbound data survive each section-13 boundary.
38. Phase 1 works with one active full runtime and ordinary account-scoped
    Message Pickup; replica fan-out is not required.
39. The initiator binds its pinned peer DID before initial submission.
    Valid direct replies need no handoff, while a claimed rotation still needs
    its proof. Submitted or acknowledged state cannot replace authentication
    or transition evidence and missing ACK never reopens submitted work.
40. A reader preserves duplicate `please_ack` or `ack` wire targets exactly,
    expands the current-message sentinel only for processing, and ignores
    later duplicate targets without changing the stored array.
41. Two implementations normalize every accepted attachment carrier, missing
    value, null, empty string and closed metadata field to the same semantic
    projection used by `intentHash`.
42. Conforming mediator operation persists and logs no application plaintext;
    any explicitly enabled bounded diagnostic mode is visibly outside the
    no-plaintext profile.
43. ACK target lookup is scoped by `(carrier.logicalPeerScope, wireId)`;
    another relationship reusing the same wire ID is never acknowledged.
44. ACK target order uses the minimum complete receipt key, not canonical event
    order or EventStore change order; a clock rollback between two receives
    does not reverse their ACK order in a linear history.
45. Submitted completion survives restart, loss of local state, clock rollback,
    package retirement and envelope collection. Later duplicate input cannot
    reopen submission or require the collected envelope.
46. If one of several valid packages for a MID is submitted, every package of
    that MID stops work; selecting another package, route or handler cannot
    bypass completion.
47. Generic pure ACK copies carrier `pthid` and normalized `created_time` or
    null. Rendezvous handoff Empty uses its separately frozen rendezvous
    profile and one carrier cannot produce both ACK intents.
48. After initial-package binding and restart, direct replies and later
    verified rotations reconstruct the same relationship execution ID; no
    handoff observation is required to start the scope.
49. An unsubmitted package survives route unavailability and GC with its exact
    envelope. Committed submission or terminal failure releases its contribution
    under the retention fold; route recovery cannot reopen submitted work.
50. Recovery completes missing initial bindings even without inbound
    traffic, and finds pickup-ACKed unfinished work without redelivery.
51. A crash after an outcome-unknown transport call can reset the local retry
    budget, but never changes the wire ID, exact retry package or frozen expiry.
52. Retry, restore and later aliases reuse the same effect key and frozen
    intent before computing new ACK targets or timing. Concurrent local workers
    cannot commit different intents for that key, or change the ordinal to
    evade the conflict.
53. A valid no-handoff error, pure ACK and ordinary basicmessage on the
    pinned initial peer key all use the initiator's relationship scope. Only
    the valid error receives no-handoff control treatment and generates no
    response; other traffic follows its protocol and ACK-request rules. A
    different DID without proof cannot obtain that scope.
54. Two equal-intent observations with the same `(peerKey, wireId)` at a
    relationship DID and rendezvous DID execute once only if both committed
    observations derive the same relationship. Missing candidate evidence
    defers the group; inconsistent evidence conflicts it. Event order does not
    select an observation to execute, and emitted effects remain history.
55. A batch proposing scope-bearing bootstrap input, binding or transition
    with a dependent response intent is rejected. Commit the prerequisite
    first and the intent later; crash recovery uses that committed prefix
    without a new decision or provisional scope.
56. Two workers handling one outbound serialize prepare/submit work. Observed
    acceptance commits before another dispatch, and no later dispatch starts
    after the submitted event. A crash before that commit still permits
    recovery with the same package rather than consuming a pre-call reservation.
57. Before qualifying scoped inbound, an initiator send through its pinned
    peer end uses `rendezvous.md` section 8 and freezes non-null `initial`.
    Nullable expiry is valid for both initial and ordinary traffic. Direct
    replies, pure ACKs and verified handoffs/rotations qualify; a no-handoff
    error does not. Explicit-channel attempts fail before commit without
    rewriting the target. Existing initials keep their frozen classification.
58. A freshly resolved same-DID new key does not extend `peerChain(R)`. Outbound
    preparation follows `rendezvous.md` section 5.1's message-scoped failure;
    an inbound at the local relationship DID without continuation proof has
    no scope and processes no ACK/effect. The contact diagnostic cannot make
    the observation executable, even if DID-graph attribution finds a contact.
59. Two keys authorized by the same exact pinned peer document can carry
    direct replies in the same relationship. Equal-intent variants of one wire
    ID merge and execute once; neither key replaces the selected origin.
    A fresh unpinned document cannot grant membership to another key.
60. A new non-numalgo-4 MID resolves and commits current recipient evidence
    before first preparation. Transient unavailability leaves it retryable;
    definitive resolution failure is terminal under `rendezvous.md` section
    5.1. An unchanged online-revalidated document still creates new evidence.
    Existing packages retry or repack using retained snapshots only. Each
    inbound delivery instead authenticates against current sender resolution,
    including duplicates; unavailable resolution defers without pickup ACK
    only within that section's per-delivery budget. Definitive DNS failures
    and exhausted retries take the terminal pre-vault ACK path; redelivery
    cannot reset the budget. Recoverable local prerequisites have no such cap.
    Reusing matching evidence requires a fresh document check. Recovery of
    committed input uses its retained snapshot without another network lookup.
61. Section 8.1's sender gate precedes selection and commit of a deterministic
    reply, including a natural response without ACK targets. A retired local
    end without a usable successor leaves durable input and unfinished work,
    with no reply intent or frozen ACK selection. Recovery after a valid local
    transition sends from that relationship's current end, reusing any already
    committed response instead of creating another effect.
62. Section 9's local-rotation vector preserves MID, execution ID, effect key
    and automatic outbound MID across local recipient keys. Historical local
    membership also permits ACKs across predecessor/successor packages under
    `vault-events.md` section 14.8; a shared contact alone does not.
63. A P0-to-P1 proof delivered to the responder's original rendezvous uses
    its retained P0 binding to extend the same relationship. Committing the
    input before its transition supplies no provisional bootstrap scope;
    recovery commits the transition before ACK/effect work. Later P1 input
    without a proof pins that membership through `message.in.peerTransition`,
    including after erasure or restart. Equal-intent copies of one wire ID
    across verified peer keys keep one execution ID and reuse frozen response work.
