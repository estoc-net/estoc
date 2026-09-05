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

This profile defines:

- the boundary between rendezvous discovery, pairwise relationships and
  replicas;
- IDs and hashes for logical content, immutable intent, exact DIDComm
  plaintext, encrypted packages and mediator deliveries;
- which DIDComm headers are frozen at intent time;
- package preparation and valid repackaging;
- submitted, acknowledged, expired and held states;
- end-to-end durable receipt with DIDComm `please_ack` and `ack`;
- duplicate and conflict handling across process restarts and future replicas;
- the rendezvous bootstrap delivery profile; and
- idempotency requirements for automatic handlers.

It does not define the DASL object profile (`dasl-objects.md`), mailbox
fan-out (`replica-mediation/1.0`), the rendezvous admission profile
(`rendezvous.md`) or event/object replication (`vault-sync/1.0`).

## 2. Terms

- **Full replica** — an independently writable vault incarnation holding the
  seed and appending vault events. It may run locally or on a server.
- **Rendezvous DID** — a disclosed DID used only to begin relationships.
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
- **Submitted** — a transport endpoint accepted one package attempt.
- **Acknowledged** — the ultimate peer sent an authenticated explicit `ack`
  naming the wire ID after durable receipt.
- **Receipt-required** — the exact `message.out.pleaseAck` array requests an
  explicit ACK of this message by containing `""` or this message's wire ID.
- **Submission-terminal** — this message is not receipt-required; its first
  successful submission ends normal background retry. The message may still
  carry a `please_ack` request for older message IDs.
- **Replay deadline** — the durable local `message.out.replayUntil` instant
  through which exact deterministic response packages remain retained for
  duplicate-request recovery. It is not a DIDComm header.
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
    disclosed address for bounded first contact
    self-resolving did:peer:4

relationship DID
    pairwise did:peer:4
    ordinary traffic after admission
```

Both are vault-scoped. The phase-1 active full runtime derives their private
keys and receives messages addressed to them. A later server or additional
full replica does not own the DIDs merely because it executes the vault.

Each local communication DID has one immutable `boundRoute`, mediated or
direct. Changing its keys or bound route creates a successor DID entity.
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

A full vault runtime MUST be able to commit a send while DNS, DID resolution
and every mediator are unavailable. Before required network work it records:

- `mid`, also used as the wire ID;
- target contact or explicit channel;
- message type, thread and parent-thread IDs;
- body and ordered normalized attachments;
- immutable `createdTime`, which is an Epoch-Seconds integer or null;
- immutable `expiresTime`, which is an Epoch-Seconds integer or null;
- immutable `pleaseAck`, represented as null or an ordered array;
- immutable `ack`, represented as an ordered array;
- immutable supported additional top-level headers;
- `replayUntil`, represented as an Epoch-Seconds integer or null; and
- the user or deterministic automatic-effect decision to send.

`createdTime == null` means the DIDComm `created_time` header is absent. A
preparer MUST NOT invent it. A user-authored message normally freezes commit
time, while a deterministic response may copy or derive a timestamp under its
protocol. The value is not a transport-freshness proof.

`replayUntil` controls local retention only. It is excluded from the semantic
and intent projections and is never emitted on the wire. A deterministic
response or pure ACK that may be replayed after a duplicate request MUST set a
non-null replay deadline under section 7.

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
| Prepared package | `message.prepared` and its exact envelope | Submit that exact package |
| Normal inbound | Objects, `message.in` and required channel evidence | Pickup-ACK, effect or peer ACK |
| Terminal pre-vault rejection | Safe terminal classification and bounded diagnostic, if any | Pickup-ACK only |
| Stable execution scope | Admission, initiator binding, relationship or pinned initial-package evidence under section 9 | Apply peer-scoped ACKs, freeze ACK targets, or run an eligible automatic effect |
| Ultimate peer ACK | Validated `ack` plus `delivery.acknowledged` | Stop normal retry |
| Replay submission paused | Unresolved hold or ordinary terminal delivery failure | Retain exact replay material but submit nothing automatically |
| Replay closure | Process-durable `message.replayClosed` after deadline or erasure | Release replay-only exact envelope roots |

The terminal pre-vault path creates no `message.in`, peer ACK, contact or
handler effect. Stopping normal retry after an ultimate ACK does not release
exact response material. Reaching `replayUntil` also does not release it until
the monotonic replay-closure event has committed.

Object acceptance and event append use `Vault.commit` under `event-store.md`
section 10.

### 4.2 Send an ordinary message

The synchronous full-vault send operation:

1. prepares attachment objects;
2. prepares the stored message document;
3. selects durable nullable `createdTime`, optional `expiresTime`, exact
   `pleaseAck` value (null or array), exact ordered `ack`, complete `headers`,
   and any required replay deadline;
4. computes the intent hash;
5. rejects a rendezvous DID as an ordinary relationship target;
6. commits those objects with `message.out` through `Vault.commit`; and
7. returns `mid`.

It performs no network operation. When `createdTime` is null, preparation
omits `created_time`. Expand `pleaseAck` by replacing `""` with
the current wire ID. Receipt-required completion is selected only when that
expanded set contains the current wire ID. `null`, `[]`, or an array naming
only older messages is submission-terminal for the current message.

The active phase-1 runtime may later:

1. stop when held, acknowledged, terminally failed, expired, or
   submission-terminal and already submitted;
2. fold target contact/channel;
3. choose valid sender DID, peer DID/key and exact resolution evidence;
4. attach the frozen contact-scoped `fromPrior` while pairwise handoff remains
   unconfirmed;
5. construct complete plaintext by copying every intent-time header;
6. compute plaintext hash, encrypt, and use `Vault.commit` for the exact
   envelope and `message.prepared`;
7. submit directly or through Routing 2.0 with `packageId == forward.id`;
8. append `delivery.submitted` on acceptance or `delivery.failed` on terminal
   failure; record retryable failures only in local trace; and
9. retry according to completion mode.

A new package may change address/security evidence only under validated repack
rules while preserving the intent hash. Receiving may join equal wire IDs
across a verified peer-key transition in one relationship.

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

A current outbound is receipt-required exactly when its expanded array
contains its own wire ID. Thus an absent or empty array does not request an ACK
of the current message, while `[""]` and `[currentWireId]` do.

Writers SHOULD NOT emit duplicate targets. Readers preserve the accepted wire
array exactly and apply deduplication only to receipt processing. Absent
`please_ack` normalizes to null; absent `ack` normalizes to `[]`; absent
`created_time` or `expires_time` normalizes to null; absent additional headers
normalize to `{}`. ACK values are interpreted in oldest-to-newest receive
order, never lexicographic order; this implements the ordering MUST in
[DIDComm Messaging v2.1, ACKs](https://identity.foundation/didcomm-messaging/spec/v2.1/#acks).

`headers` contains every permitted top-level DIDComm field not represented by
a dedicated field. The reserved names `typ`, `id`, `type`, `from`, `to`,
`created_time`, `expires_time`, `thid`, `pthid`, `please_ack`, `ack`,
`from_prior`, `return_route`, `body` and `attachments` are forbidden. A
difference in any such field is an intent difference.
`replayUntil`, local effect bookkeeping and package addressing are excluded.

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

- one live sender DID entity and its fixed key-agreement method;
- one current peer DID and authenticated peer key;
- exact `peer.resolved` evidence;
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

Retrying a package reuses identical plaintext, normalized ciphertext bytes and
package ID. A new package for the same logical message may change `from`, `to`,
selected keys, peer resolution or `from_prior` only under a valid DID-entity
selection or verified contact-scoped transition for the same logical target.
A local DID's keys and bound route never change in place; an external
recipient's transport choice remains constrained by its resolution evidence.
Every changed plaintext or encryption result requires a new package ID and
plaintext hash. One initial rendezvous wire ID remains pinned to its original
resolution snapshot and recipient key.

## 7. Expiration, normal completion and replay retention

Before preparation or any normal retry, a worker checks durable expiry. When
`expiresTime != null` and `now >= expiresTime`, it appends a message-scoped,
terminal `expired` failure and submits no new package. A later user attempt
requires a new `message.out` and wire ID.

Normal retry mode is derived from the current wire ID and exact
`message.out.pleaseAck` value:

```text
requested = expandPleaseAck(wireId, pleaseAck or [])
receiptRequired = wireId is in requested
```

- **receipt-required** — normal retry continues until an authenticated explicit
  ACK names the wire ID, or until expiry, hold or terminal failure.
- **submission-terminal** — the first successful submission ends normal
  background retry, while display remains `submitted`, not `acknowledged`.

HTTP, WebSocket or mediator acceptance records only `delivery.submitted`.
Expiry permanently ends new work. A later valid ACK may improve display to
`acknowledged-late`, but never reactivates preparation or normal retry.

Normal completion is separate from duplicate-response replay. A deterministic
protocol response or pure ACK created to honor an inbound `please_ack` MUST
freeze `replayUntil` before `message.out` is appended. The exact deadline is:

1. a protocol-defined deterministic deadline when that protocol defines one;
2. otherwise, the response's `expiresTime` when it is non-null; or
3. otherwise, exactly 604800 seconds after the local decision clock read used
   to construct the response intent.

A protocol-defined deadline MUST NOT be later than a non-null response
`expiresTime`; the response remains unexpired throughout its replay window.
The selected value remains unchanged across preparation, submission, ACK and
restart. The phase-1 generic pure-ACK fallback uses rule 3. The rendezvous
handoff profile defines its own deterministic response timing and uses rule 2.

Replay has two separate predicates:

- **replay material open** — exact replay material must remain retained; and
- **replay submission eligible** — automatic duplicate handling is currently
  allowed to submit the retained package.

`vault-events.md` section 15.3 is the sole normative envelope-retention rule.
It derives normal material need independently of submission eligibility, then
unions that contribution with the durable replay obligation. A hold or missing
route therefore does not release a normal-only package. A null `replayUntil`
requires no closure event. For non-null deadlines, replay-only release requires
committed `message.replayClosed`, not a wall-clock observation or ordinary
completion/failure. Explicit message/root erasure has its separate precedence
and erased-closure recovery path.

The rules below decide when retained material may be submitted; they do not
supply another retention predicate.

Automatic duplicate replay is submission-eligible only when all of these are
true:

- replay material is still open;
- the current wall-clock sample is strictly before `replayUntil`;
- no unresolved `delivery.held` applies to the message;
- there is no message-scoped terminal `delivery.failed`;
- the selected package has no package-scoped terminal failure;
- the selected package itself has not expired; and
- its exact envelope is still retained and validates.

A hold therefore pauses duplicate replay without shortening retention. After a
matching `delivery.released`, duplicate replay may resume only if every other
predicate above still holds. A terminal delivery failure blocks replay
submission but retains material until monotonic replay closure or explicit
erasure. Package retirement
stops normal retry but does not, by itself, close replay.

When a clock sample first observes `now >= replayUntil` and replay material is
still open, the runtime MUST stop replay submission, append the monotonic
closure, and only then make replay-only roots eligible for collection. Once
exact bytes have been intentionally erased, the
runtime MUST NOT mint a replacement package merely to answer a duplicate.

A user or policy hold stops automatic work. In phase 1 there is one active
writer; future synchronization MUST NOT create a hold merely because another
author produced the intent.

## 8. Durable end-to-end acknowledgment

### 8.1 Freezing an ACK target set

For one received carrier message `X`, a conforming receiver performs this
algorithm after normal inbound commit, only when no response intent already
exists under section 11:

1. If `X.pleaseAck == null`, create no ACK obligation.
2. Expand `""` to `X.wireId`; retain the first occurrence of every target and
   ignore later duplicates.
3. Derive `X.logicalPeerScope` under section 9 from committed evidence.
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

Before freezing the response it MUST have authenticated and validated X,
accepted every retained object, process-durably appended `message.in`, and
committed any non-conflicted channel evidence needed to address the response.

The response thread follows X, not each older target:

```text
thid  = X.thid, or X.wireId when X.thid is null
pthid = X.pthid
```

A natural response may carry the frozen `ack` array. If no deterministic
natural response is available, use `https://didcomm.org/empty/1.0/empty`.
Pure ACKs contain no `please_ack`, are submission-terminal, and are excluded
from application thread display.

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
`please_ack`, `from_prior`, thread values and replay deadline before intent
commit. One carrier MUST NOT create both a generic pure-ACK effect and a
rendezvous handoff-Empty effect; selecting the handoff fallback consumes the
carrier's ACK obligation.

The executable vector uses execution scope
`{"relationship":"73a7d8f5-3523-5802-9b65-02da2078273e"}`, carrier wire ID
`019b1b61-3444-7190-9db5-1cc9c215eb23` and the tuple above.

The generic execution/effect derivation in sections 9 and 11 produces:

```text
executionId      = feeae3f7-34ea-5ff1-b449-0ef76a7375c7
effectKey        = QA60SmyoScCqinpKWDanveWJ5CrNVMGA74fKnNxAQpg
outbound MID = wire ID = f0a3577e-4de5-58aa-8a4b-dd9b3ef0fcf6
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

One valid ACK stops normal retry of every package for the receipt-required
outbound. It does not end replay retention for packages that answer another
message. Duplicate ACKs are harmless. Acknowledged means durable receipt by the
peer vault, not read, displayed or accepted by a business workflow.

### 8.4 Duplicate receipt handling

When a conflict-free carrier is delivered again and its frozen ACK target set
was previously honored, the receiver MUST re-submit an already-existing exact
deterministic response or pure-ACK package exactly when replay submission is
eligible under section 7. In particular, an unresolved hold or ordinary
terminal failure blocks submission even though it does not by itself release
replay material.

It MUST NOT mint a new effect, outbound message, wire ID, package or
`from_prior` only because of the duplicate. Acknowledgment of the response
stops normal retry but does not cancel an open replay-material obligation. A
bounded debounce may reduce repeated submission.

After `message.replayClosed`, or when explicit erasure has released the
exact bytes and closed replay, no replay is required and no replacement package
may be invented. A hold that is later released may resume replay only when closure
and every other eligibility predicate still permit it. A receiver that never
honored an optional ACK request has no obligation to invent a response upon
redelivery.

## 9. Observation identity, logical aliasing and execution identity

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
peerKey = k3j9n0m4x6q2w7c8v5p1d8s0fa
wireId  = 019b2a70-f225-721c-835f-67175be0667e
mid     = 29370ccd-932b-51eb-9cc3-4c083adc151a

peerKey = k3j9n0m4x6q2w7c8v5p1d8s0fa
wireId  = 019b1b61-3444-7190-9db5-1cc9c215eb23
mid     = 206bcd7e-7320-5512-bbdb-a4d19331d58e
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
(`logicalPeerScope`) for ACK lookup, duplicate replay and automatic execution.
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

During validation of a `Vault.commit`, scope and intent derivation may use its
prospective atomic event set. Those facts become scope evidence only when the
whole batch commits.

For relationship `R`, `peerChain(R)` is the historical set containing the
responder's `relationship.established.peerKey` or the initiator's
`message.in(relationship.initiatorBound.handoffMid).peerKey`, plus successor
`peerKey` values from valid `peer.transitioned` events naming `R` under
`vault-events.md` section 11.2. The first handoff contributes only its successor
key. Retirement preserves historical scope evidence. Contact attribution and
route availability do not select a scope; current work eligibility is separate.

| Observation | Required committed evidence | Derived scope |
| --- | --- | --- |
| Responder candidate addressed to a local rendezvous DID | The effective `relationship.admissionDecided` with `inboundMid == o.mid`, under `vault-events.md` section 14.4 | Accept: its deterministic relationship, even before materialization. Reject: exact channel `(o.myKey, o.peerKey)`. No effective result: no scope. |
| Initiator handoff | Valid `relationship.initiatorBound` with `handoffMid == o.mid` | Its relationship |
| Ordinary relationship traffic | Relationship `R` with `o.myKey == did/<R.ourDid>/key-agreement` and `o.peerKey` in `peerChain(R)` | That unique `R`; no match supplies no scope |
| Initiator no-handoff problem report under `rendezvous.md` section 13 | `o.fromPrior == null`; a valid initial `message.prepared` has null `fromPrior`, exact `(o.myKey, o.peerKey)` and a pinned `peer.resolved(peerResolution)` validating that channel | Exact channel `(o.myKey, o.peerKey)` |

Each row contributes at most one scope; multiple matching relationships are
an execution-scope conflict. All applicable rows for one observation MUST agree.
Then every valid observation in one MID group MUST derive the same scope.
Missing evidence leaves the group deferred; incompatible scopes preserve
history but suppress ACK processing and new effects, without selecting a row,
observation or canonical winner. Only after these checks may groups join under
`vault-events.md` section 14.7's transition-aware union.

The execution identity is:

```text
executionId = UUIDv5(
  estocNamespace("message-execution"),
  RFC8785(["v2", executionScope, wireId])
)
```

Initiator handoff recovery follows `rendezvous.md` section 12 even when the
responder DID is already known. A final rejection's fixed bootstrap control
channel is the explicit non-transitioning exception in that document's section
13; it neither aliases keys nor establishes a relationship.

A message without a unique stable scope is **effect-deferred**. It MUST NOT
execute under a provisional observation, contact or channel identity. A later
verified alias reuses the relationship-derived execution ID; a conforming
runtime never executes once per peer key and repairs it by choosing a smaller
MID. All required scope evidence MUST commit before applying explicit ACKs,
freezing ACK targets or running automatic effects.

A conforming `empty/1.0/empty` pure ACK remains a durable control observation,
but is excluded from thread display, unread counts, notifications and
application-content handlers.

### 9.1 Receive a message

For every account-scoped pickup or direct delivery:

1. while the vault is locked, recovery is incomplete, or the local key index is
   not yet authoritative, do not classify recipient ownership; keep the
   delivery pending without pickup ACK;
2. once local key state is authoritative, inspect every recipient `kid` before
   decryption. A delivery is deferred only when at least one `kid` maps to an
   exact known local key-agreement method with a concrete recoverable
   prerequisite that is not yet satisfied, such as a configured-but-not-live
   rendezvous generation. A foreign DID, a locally controlled DID with a
   nonexistent or wrong-purpose fragment, a terminal rendezvous generation,
   or a set of recipient `kid` values with no valid local key-agreement match
   is terminal wrong-recipient input: safely classify it, pickup-ACK it when
   mediated, and append no `message.in`, contact or response effect;
3. authenticate, decrypt and validate the complete innermost message,
   including the exact selected local key-agreement method, Peer DID long-form
   and authcrypt sender evidence;
4. when addressed to a rendezvous DID, run `rendezvous.md` section 10.2's bounded pre-vault
   gate; a safely classified hard rejection received through Message Pickup
   MUST be pickup-ACKed without `message.in`;
5. for admitted or ordinary traffic, derive channel, observation MID,
   intent hash and exact plaintext hash;
6. prepare retained body/attachment objects and the stored message document;
7. use `Vault.commit` for those objects and `message.in` with applicable
   `channel.firstSeen`, exact `peer.resolved`, contact attachment and
   non-controversial observations;
8. only then ACK the account-scoped mediator delivery;
9. before processing ACK values or continuation, validate every package-level
   proof; a handoff carrying `from_prior` requires exact pinned historical
   evidence even if its responder DID is already known but binding is incomplete;
10. after validation, append `peer.transitioned` when applicable; an initiator
    processing a validated pairwise handoff also commits
    `relationship.initiatorBound` so the relationship scope is reconstructible
    after restart;
11. resolve the stable relationship or non-transitioning channel execution
    scope; if required transition/binding evidence is missing, defer ACK
    application and automatic effects;
12. only after that unique derived logical peer scope exists, process explicit
    `ack` values into idempotent peer-scoped `delivery.acknowledged`;
13. schedule eligible deterministic application effects through that execution
    ID. Bootstrap admission itself follows `rendezvous.md` section 10.2 and is a local decision,
    not an application effect requiring a provisional execution identity;
14. run the frozen peer-scoped ACK-target algorithm in
    `distributed-delivery.md` section 8; when at least one target is honored,
    append one deterministic protocol response or pure-ACK intent with a replay
    deadline; and
15. on duplicate receipt while replay-submission-eligible, re-submit the same
    retained response package rather than creating another effect or package.

A conforming pure ACK is retained for audit and delivery processing but excluded
from user threads, unread counts, notifications and application handlers. It has
`pleaseAck == null`, so first successful submission ends normal retry.

A crash before durable message commit leaves mediator delivery pending. A
crash after commit but before pickup ACK causes redelivery and another valid
duplicate observation.

## 10. Rendezvous bootstrap delivery

Rendezvous is a processing profile, not an Estoc DIDComm protocol family. The
first message to a rendezvous DID is an ordinary allowlisted application
message.

When no other content is available, the initiator sends Trust Ping 2.0 with
`response_requested == true`, `please_ack: [""]`, finite expiry and the OOB
invitation ID as `pthid` when applicable. An allowlisted application protocol
may instead send its real first message with the same receipt and expiry
requirements.

After local relationship admission, the responder selects a deterministic
handoff response: Trust Ping `ping-response`, a protocol-defined deterministic
machine response, or Empty Message ACK. Human-authored content is ordinary
later traffic.

The first responder message is sent from the relationship DID, carries
`from_prior`, explicitly ACKs the initial wire ID and requests its own ACK with
`please_ack: [""]`. It freezes a replay deadline and retains every exact
handoff package through that deadline. The initiator verifies `from_prior`
before applying the response ACK or appending `peer.transitioned`.

Until the responder receives an authenticated message addressed to the new
relationship DID, outbound packages from that DID carry the same byte-stable
`from_prior`. Rejection is silent or uses a protocol-specific error or Report
Problem 2.0; there is no custom decline message.

## 11. Automatic effects

An automatic DIDComm output is one effect identified by
`(executionId, handlerId, effectKind, ordinal)`. `executionId` MUST equal the
derived execution ID of a unique conflict-free carrier group. Each protocol
MUST define its handler ID, effect kind, stable non-negative integer ordinal
and output intent rules. Handler IDs and kinds are non-empty strings without
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
One key permits only one compatible intent under that document's section 14.8;
payload validation MUST verify the execution ID against that carrier group,
the key against its derived execution ID and producing protocol, and the MID
against the key.

Under the writer lock in `event-store.md` section 10, the runtime MUST derive
the carrier's execution ID and look up the derived MID before freezing ACK
targets, timing or other intent fields.
It reuses an existing non-conflicted intent; it MUST NOT regenerate one after
content erasure, replay closure, a later observation or a changed clock. If no
intent exists, it commits the intent through `Vault.commit` before effects.
Derivation, lookup and commit are one locked operation.
A conflicting local intent is rejected before append; imported conflicts remain
history and suppress work under `vault-events.md` section 14.8. Duplicate
carriers use the existing package only while section 8.4 permits replay.

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
message.packageRetired            package no longer retried
message.replayClosed              monotonic end of duplicate replay retention
delivery.submitted                transport accepted a package
delivery.failed                   terminal package or message failure
delivery.acknowledged             ultimate peer ACK named the wire ID
delivery.held                     user or policy hold
delivery.released                 release of one exact hold
message.in                        durable inbound observation
peer.transitioned                 DID continuation in one named relationship
relationship.admissionDecided     local bootstrap admission decision
relationship.established          stable responder-side pairwise relationship
relationship.initiatorBound       portable initiator-side relationship binding
```

When `expandPleaseAck(wireId, pleaseAck or [])` contains `wireId`, submission
does not remove the outbound from the set awaiting ultimate acknowledgment.
Otherwise, first successful submission ends normal background retry for this
message, even when its `pleaseAck` array asks for acknowledgment of older
messages.

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
  "peerKey": "k3j9...",
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
- At expiry before prepare or retry, a message-scoped terminal failure is
  recorded and no package is submitted.
- After inbound commit but before pickup ACK, redelivery converges as another
  observation.
- After pickup ACK but before ultimate ACK intent/submission, writable-open
  recovery MUST rediscover unfinished work from committed inbound history,
  reuse frozen intents and relationship evidence, and resume eligible
  deterministic work.
  Neither mediator redelivery nor a local queue is a recovery prerequisite.
- Loss or unavailability of the recipient runtime beyond mediator retention
  may lose an in-flight package. Receipt-required sender retry is the recovery boundary.
- Submission-terminal messages deliberately accept best-effort completion
  after transport acceptance.

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
5. `pleaseAck` containing `""` or the current wire ID makes the current
   message receipt-required; an array naming only older IDs does not.
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
14. A submission-terminal message stops normal retry after first successful
    submission; a receipt-required message waits for explicit ACK or another
    terminal state.
15. A deterministic response acknowledges a message only when explicit `ack`
    names its wire ID.
16. ACK is emitted only after durable inbound commit.
17. Pure ACK uses `pleaseAck == null`, creates no ACK loop and is
    submission-terminal.
18. A pure ACK whose carrier omitted `created_time` commits
    `createdTime == null` and omits the wire header on every preparation.
19. The fixed pure-ACK vector derives execution ID
    `feeae3f7-34ea-5ff1-b449-0ef76a7375c7`, effect key
    `QA60SmyoScCqinpKWDanveWJ5CrNVMGA74fKnNxAQpg`, and one outbound/wire ID
    `f0a3577e-4de5-58aa-8a4b-dd9b3ef0fcf6`.
20. One carrier that requests current and older known IDs freezes one ordered
    deduplicated ACK target set; unknown targets arriving later do not mutate
    the response effect.
21. ACK of a deterministic response stops normal retry but its exact packages
    remain held until durable replay closure.
22. Duplicate receipt before replay closure re-submits the same response/ACK
    package only while replay submission is eligible; after durable closure or
    explicit erasure no replacement is minted.
23. Valid address variants converge; invalid variants conflict.
24. Equal wire IDs under transition-verified peer keys merge only through the
    same stable relationship execution scope; unrelated key reuse does not.
25. A repackaged observation that arrives before transition evidence remains
    effect-deferred. After verification it derives the same relationship/wire-ID
    execution identity and cannot execute once per peer key.
26. Multiple relationship matches or incompatible derivation rows for one
    observation suppress ACK processing and new effects as an execution-scope
    conflict, even when each source is individually valid.
27. Pure Empty ACK is retained for control/audit but absent from threads,
    unread counts and application handlers.
28. Invalid `from_prior` prevents ACK processing and transition.
29. Duplicate explicit ACKs are harmless and one valid ACK stops all normal
    receipt-required package retry.
30. Expiry stops work permanently; a later valid ACK may display
    acknowledged-late without restarting work.
31. The default initial rendezvous message may be Trust Ping; an admitted
    application message may be first without a custom wrapper.
32. No emitted message uses an `https://estoc.dev/rendezvous/1.0/*` type.
33. A deterministic handoff response carries pairwise long-form sender
    evidence, one frozen relationship-level `from_prior`, explicit ACK and
    `please_ack: [""]`.
34. `from_prior.sub` equals plaintext `from` byte-for-byte; `from_prior.kid`
    belongs to the exact `iss` spelling pinned from discovery.
35. Until handoff confirmation, every responder message from the new pairwise
    DID carries the same `from_prior` and long-form sender spelling.
36. Direct and mediated delivery enter the same inbound fold.
37. Crash injection at every section-13 boundary loses neither committed
    outbound intent nor unacknowledged inbound delivery.
38. Phase 1 works with one active full runtime and ordinary account-scoped
    Message Pickup; replica fan-out is not required.
39. A non-Estoc peer that does not provide explicit ACK or `from_prior`
    confirmation remains visibly unconfirmed and is outside reliable-bootstrap
    conformance.
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
45. Reaching `replayUntil` does not release exact replay material until a
    durable `message.replayClosed` is committed; restart or clock rollback
    cannot reopen a closed replay obligation.
46. An unresolved hold or ordinary terminal delivery failure blocks
    duplicate replay submission without releasing replay material. After
    release, replay resumes only if every other eligibility condition still
    holds.
47. Generic pure ACK copies carrier `pthid` and normalized `created_time` or
    null. Rendezvous handoff Empty uses its separately frozen rendezvous
    profile and one carrier cannot produce both ACK intents.
48. After initiator handoff validation and restart, the portable relationship
    binding reconstructs the same execution ID; later verified rotation does
    not create another execution identity for the same relationship/wire ID.
49. A held normal-only package survives GC and release with its exact envelope;
    terminal normal release with a null replay deadline requires no closure.
50. Recovery completes handoff binding even for a known responder DID and finds
    pickup-ACKed unfinished work without mediator redelivery.
51. A crash after an outcome-unknown transport call can reset the local retry
    budget, but never changes the wire ID, exact retry package or frozen expiry.
52. Retry, restore and later aliases reuse the same effect key and frozen
    intent before computing new ACK targets or timing. Concurrent local workers
    cannot commit different intents for that key, or change the ordinal to
    evade the conflict.
