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
- **Rendezvous DID** — a disclosed vault-scoped DID used only to begin
  relationships. The required default is `did:peer:4`; `did:web` is optional.
- **Relationship DID** — a vault-scoped pairwise `did:peer:4` used for one
  ongoing relationship.
- **Outbound message ID (`mid`)** — the vault entity ID of one outbound
  logical message.
- **Inbound observation MID** — a deterministic ID for one authenticated
  `(peer key, wire ID)` observation before verified aliasing.
- **Logical execution ID** — a durable, immutable identity used by automatic
  effects after one or more inbound observation MIDs are recognized as the same
  logical input. It never changes merely because a later alias is learned.
- **Wire ID** — the innermost DIDComm plaintext `id`, stable across retries and
  permitted repackaging.
- **Semantic projection** — application meaning: `id`, `type`, `thid`,
  `pthid`, body and ordered logical attachments.
- **Semantic hash** — SHA-256 of the canonical semantic projection.
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

`H1` and `H2` may differ while semantic and intent hashes remain equal.

## 3. Addressing layers

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

Version 3 recognizes:

```text
rendezvous DID
    disclosed address for bounded first contact
    default self-resolving did:peer:4
    optional did:web facade

relationship DID
    pairwise did:peer:4
    ordinary traffic after admission
```

Both are vault-scoped. The phase-1 active full runtime derives their private
keys and receives messages addressed to them. A later server or additional
full replica does not own the DIDs merely because it executes the vault.

A DID may advertise mediated or direct routes. Route choice changes transport,
not application recipient. A direct endpoint MUST NOT expose a replica ID as
the peer-visible recipient.

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

- `mid` and wire ID;
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
| Object acceptance | Complete verified object plus pending-reference guard | Append its referencing event |
| Outbound intent | `message.out` and every rooted object | Resolve, register, prepare or submit |
| Prepared package | `message.prepared` and its exact envelope | Submit that exact package |
| Normal inbound | Objects, `message.in` and required channel evidence | Pickup-ACK, effect or peer ACK |
| Terminal pre-vault rejection | Safe terminal classification and bounded diagnostic, if any | Pickup-ACK only |
| Stable execution binding | `message.executionBound`, plus `relationship.initiatorBound` when initiator handoff requires it | Run one automatic effect under the stable execution ID |
| Ultimate peer ACK | Validated `ack` plus `delivery.acknowledged` | Stop normal retry |
| Replay submission paused | Unresolved hold or ordinary non-retryable delivery failure | Retain exact replay material but submit nothing automatically |
| Replay closure | Process-durable `message.replayClosed` after deadline or erasure | Release replay-only exact envelope roots |

The terminal pre-vault path creates no `message.in`, peer ACK, contact or
handler effect. Stopping normal retry after an ultimate ACK does not release
exact response material. Reaching `replayUntil` also does not release it until
the monotonic replay-closure event has committed.

Object acceptance and event commit MUST be coordinated with collection as
specified by `dasl-objects.md`; neither the table nor an orphan grace period
permits collection to race a reference commit.

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

`semanticHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for the projection.

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
order, never lexicographic order.

`headers` contains every permitted top-level DIDComm field not represented by
a dedicated field. A difference in any such field is an intent difference.
`replayUntil`, local effect bookkeeping and package addressing are excluded.

`intentHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON for
this projection.

### 5.3 Exact plaintext hash

`plaintextHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for the complete innermost DIDComm plaintext actually encrypted by one
package. It includes `from`, `to`, `from_prior` and every emitted header.

All packages for one outbound `mid` agree on semantic and intent hashes. They
may have different plaintext hashes only when package-level addressing or
security evidence changes under an expressly permitted rule.

## 6. Preparing a package

A preparer folds the target and selects:

- one live sender DID and key generation;
- one current peer DID and authenticated peer key;
- exact `peer.resolved` evidence;
- one route; and
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

The reserved names are:

```text
typ, id, type, from, to, created_time, expires_time,
thid, pthid, please_ack, ack, from_prior, return_route,
body, attachments
```

They MUST NOT appear in `message.out.headers`. An implementation that cannot
preserve a supported additional header MUST reject preparation rather than
dropping it.

The preparer RFC-8785-canonicalizes the plaintext, computes `plaintextHash`,
encrypts, parses the encrypted-message JSON with duplicate-member and I-JSON
validation, and stores `UTF8(RFC8785(parsedEncryptedEnvelope))` as one raw DASL
object before appending `message.prepared`. Submission uses those exact stored
bytes.

Retrying a package reuses identical plaintext, normalized ciphertext bytes and
package ID. A new package for the same logical message may change `from`, `to`,
selected keys, peer resolution or `from_prior` only when a selected key
generation, selected route or verified contact-scoped transition permits it.
Every changed plaintext or encryption result requires a new package ID and
plaintext hash. One initial rendezvous wire ID remains pinned to its original
resolution generation.

## 7. Expiration, normal completion and replay retention

Before preparation or any normal retry, a worker checks durable expiry. When
`expiresTime != null` and `now >= expiresTime`, it appends a message-scoped,
non-retryable `expired` failure and submits no new package. A later user attempt
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

For a response with non-null `replayUntil`, replay material remains open until
a valid `message.replayClosed` exists for the response. A committed
`message.erased` covering the exact replay roots may justify an early
`message.replayClosed(because="erased")`, but erasure alone does not implicitly
change the replay fold.

Merely observing `now >= replayUntil` does not release roots. The active runtime
MUST first append `message.replayClosed`; collection may release replay-only
roots only after that commit. This makes closure irreversible across process
restart, loss of `local/` and later wall-clock rollback.

While replay material is open, acknowledgment, submission-terminal completion,
ordinary package retirement, user/policy hold, and a non-retryable delivery
failure do not by themselves release the exact envelope. They may, however,
block submission.

Automatic duplicate replay is submission-eligible only when all of these are
true:

- replay material is still open;
- the current wall-clock sample is strictly before `replayUntil`;
- no unresolved `delivery.held` applies to the message;
- there is no message-scoped non-retryable `delivery.failed`;
- the selected package has no package-scoped non-retryable failure;
- the selected package itself has not expired; and
- its exact envelope is still retained and validates.

A hold therefore pauses duplicate replay without shortening retention. After a
matching `delivery.released`, duplicate replay may resume only if every other
predicate above still holds. A non-retryable delivery failure blocks replay submission but retains
material until monotonic replay closure or explicit erasure. Package retirement
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
algorithm after normal inbound commit:

1. If `X.pleaseAck == null`, create no ACK obligation.
2. Expand `""` to `X.wireId`; retain the first occurrence of every target and
   ignore later duplicates.
3. Resolve `X.logicalPeerScope` from its durable `message.executionBound`.
   Look up each requested wire ID only as `(X.logicalPeerScope, wireId)`. The
   current `X.wireId` is known by virtue of X's own binding. An older target is
   eligible only when it is conflict-free and can be bound or is already bound
   to the exact same scope. A verified key transition may widen lookup only
   inside one relationship scope; unrelated relationships, unknown senders,
   conflicted targets and ambiguous scope attribution are omitted.
4. For every retained target, derive `firstReceiptOrdinal` as the smallest
   phase-1 `message.in.receiptOrdinal` among observations belonging to that
   logical message. Order targets by numeric `firstReceiptOrdinal`, oldest
   first; break an impossible ordinal tie by wire ID. Canonical event order and
   local `ChangeToken` order MUST NOT be used as receive order.
5. Freeze that exact ordered array as `message.out.ack` in one deterministic
   natural response or one deterministic pure ACK associated with X's logical
   execution ID.

A requested target unknown or outside X's peer scope at step 3 is omitted. Any
older target admitted by the "can be bound" branch MUST have that exact
`message.executionBound` process-durably committed before the response intent
is frozen. Its later arrival does not mutate the frozen response or create a
second ACK effect for X; the sender may request it again in another message. If
no target remains, the receiver creates no ACK-only effect. DIDComm message IDs
are sender-scoped; wire-ID equality elsewhere in the vault is never sufficient
evidence for an ACK target.

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

For a pure ACK, the effect-specific input is the exact RFC 8785 value:

```json
{
  "ack": ["<frozen target IDs>"],
  "created_time": "<carrier created_time or null>",
  "expires_time": null,
  "pthid": "<carrier pthid or null>",
  "reply_scope": { "relationship": "<relationship ID>" },
  "thid": "<carrier thid or carrier wire ID>"
}
```

`created_time` copies the carrier's normalized `createdTime`, including null;
`pthid` copies the carrier's normalized `pthid`, including null; and
`expires_time` is null. If `createdTime` is null, the outbound intent stores
null and the wire omits `created_time`. `reply_scope` is the stable execution
scope used for the carrier. Body and attachments are empty; `pleaseAck` is
null; `headers` is `{}`.

This is the **generic pure-ACK profile**. A rendezvous handoff Empty Message
shares the generic deterministic execution/effect/output-ID derivation recipe,
but it is not this generic profile: `rendezvous.md` freezes its timing,
`please_ack`, `from_prior`, thread values and replay deadline before intent
commit. One carrier MUST NOT create both a generic pure-ACK effect and a
rendezvous handoff-Empty effect; selecting the handoff fallback consumes the
carrier's ACK obligation.

The executable vector uses execution scope
`{"relationship":"73a7d8f5-3523-5802-9b65-02da2078273e"}`, carrier wire ID
`019b1b61-3444-7190-9db5-1cc9c215eb23` and this exact effect input:

```json
{
  "ack": ["019b1b61-3444-7190-9db5-1cc9c215eb23"],
  "created_time": null,
  "expires_time": null,
  "pthid": null,
  "reply_scope": {
    "relationship": "73a7d8f5-3523-5802-9b65-02da2078273e"
  },
  "thid": "019b1b61-3444-7190-9db5-1cc9c215eb23"
}
```

The generic execution/effect derivation in sections 9 and 11 produces:

```text
executionId      = feeae3f7-34ea-5ff1-b449-0ef76a7375c7
effectInputHash  = AaXUfFDZaQtcuTAUZ37wn2hC2yUXs1hqub910SuBfHg
effectId         = QU7ryTNMw1tii4V4tdS3XdEpqknAWUU6PkhTfdgXdok
outbound MID     = 89bb3649-cd60-51ab-84cf-9f7e0c0f1c3e
outbound wire ID = 2b85898b-4c15-5212-a56b-4826d9462a81
```

### 8.3 Applying `ack`

An authenticated plaintext acknowledges an outbound only when its explicit
`ack` array names that outbound wire ID, the candidate outbound belongs to the
same validated logical peer scope as the ACK-bearing carrier, and every
package-level addressing, transition and protocol-specific proof gate has
passed. Lookup is therefore `(carrier.logicalPeerScope, acknowledgedWireId)`,
never a vault-global wire-ID search. Threading, a natural response, transport
acceptance, `please_ack` presence or a mediator receipt is insufficient without
the explicit value.

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

These values are **observation identities**. Equal semantic and intent hashes
under one MID form one observation group; differences are conflicts.

Automatic execution uses a stable **execution scope**, not an observation MID.
For any inbound carrier with a validated `message.executionBound`, this exact
scope is its **logical peer scope** (`logicalPeerScope`) for ACK lookup,
duplicate replay and automatic execution. A carrier without a unique valid
binding has no logical peer scope yet and is not eligible for those actions.
The closed phase-1 scopes are:

```json
{ "relationship": "<relationship ID>" }
```

or, for a durable channel that is not part of a relationship and for which
cross-key aliasing is forbidden:

```json
{
  "channel": {
    "myKey": "did/.../key-agreement/0",
    "peerKey": "..."
  }
}
```

An admitted responder-side rendezvous candidate uses its deterministic
relationship ID even before `relationship.established` is appended.
Initiator-side handoff traffic uses a relationship scope only after the
validated handoff is process-durably bound under
`relationship.initiatorBound`; that binding is derived from the pinned
rendezvous evidence, the initiator's own relationship identity and the initial
outbound. Ordinary established relationship traffic reuses the same scope
through later verified key rotations. Anonymous or unattributed messages are
not automatically effect-eligible unless a protocol defines another stable
execution scope in a later version.

The execution identity is:

```text
executionId = UUIDv5(
  estocNamespace("message-execution"),
  RFC8785(["v2", executionScope, wireId])
)
```

Before the first automatic effect, the runtime MUST process-durably append a
`message.executionBound` that records the exact scope, wire ID, execution ID
and all currently known observations in that logical group.

Two authenticated observation groups may be unioned as one logical message
only when they have the same wire ID, agree on semantic and intent hashes,
validate every package proof, and resolve to the same execution scope. A
cross-peer-key merge is permitted only through the same non-conflicted
relationship scope and a verified contact-scoped `peer.transitioned` chain.

A message whose sender key is not yet attached to such a stable scope is
**effect-deferred**. It MUST NOT execute under a provisional observation or
contact identity merely because transition evidence has not arrived yet. When
the evidence arrives, the observation is bound to the already deterministic
relationship execution ID. This rule covers the case where the repackaged
observation arrives before the key transition.

A binding whose `executionId` does not equal the formula above, or two scopes
claimed for one logical alias group, is an execution-identity conflict.
Previously committed effects remain immutable history, but no new automatic
effect is emitted. A conforming phase-1 runtime never executes the same
relationship/wire-ID input once per peer key and then attempts to repair it by
choosing a smaller MID.

A conforming `empty/1.0/empty` pure ACK remains a durable control observation,
but is excluded from thread display, unread counts, notifications and
application-content handlers.

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

Every automatic effect is scoped by a durable logical execution identity and
an effect-specific canonical input:

```text
effectInputHash = base64url(
  SHA-256(UTF8(RFC8785(effectInput)))
)

effectId = base64url(
  SHA-256(
    UTF8("estoc/effect/2\0") ||
    UTF8(executionId) || 0x00 ||
    UTF8(handlerId) || 0x00 ||
    UTF8(effectKind) || 0x00 ||
    UTF8(decimalOrdinal) || 0x00 ||
    UTF8(effectInputHash)
  )
)
```

Each protocol MUST define a closed `effectInput` containing every portable
value that can change the logical effect, but no package-level route, current
clock or rebuildable cache state. Before execution, the runtime process-durably
commits the execution binding and any effect intent. An external call uses
`effectId` as its idempotency key or explicitly accepts at-least-once behavior.

Effects emitting DIDComm messages derive stable outbound MID and wire ID from
`effectId` as specified by `vault-events.md`. Duplicate carriers re-submit the
existing package under section 8.4 rather than deriving another effect.

Phase 1 has one active writer but still makes no process-level exactly-once
claim. A future multi-writer profile must coordinate execution bindings before
it can claim stronger behavior.

## 12. Required vault observations

Exact schemas are in `vault-events.md`:

```text
message.out                       durable intent and immutable headers
message.prepared                  exact plaintext and encrypted package
message.packageRetired            package no longer retried
delivery.submitted                transport accepted a package
delivery.failed                   retryable or terminal failure
delivery.acknowledged             ultimate peer ACK named the wire ID
delivery.held                     user or policy hold
delivery.released                 release of one exact hold
message.in                        durable inbound observation
message.executionBound            immutable logical execution identity
peer.transitioned                 contact-scoped DID continuation
relationship.admissionDecided     local bootstrap admission decision
relationship.established          stable pairwise relationship
```

When `expandPleaseAck(wireId, pleaseAck or [])` contains `wireId`, submission
does not remove the outbound from the set awaiting ultimate acknowledgment.
Otherwise, first successful submission ends normal background retry for this
message, even when its `pleaseAck` array asks for acknowledgment of older
messages.

A recommended inbound observation records all hashes and durable headers:

```json
{
  "mid": "<deterministic inbound message id>",
  "wireId": "<innermost message id>",
  "semanticHash": "<base64url sha-256>",
  "intentHash": "<base64url sha-256>",
  "plaintextHash": "<base64url sha-256>",
  "createdTime": null,
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

- Before intent commit, no vault message exists.
- After intent commit but before preparation, the active full runtime may
  prepare later; a future replicated profile may allow any full replica to do
  so.
- After package storage but before submission observation, the exact package
  may be submitted again.
- After mediator acceptance but before `delivery.submitted`, retry is
  idempotent.
- At expiry before prepare or retry, a message-scoped terminal failure is
  recorded and no package is submitted.
- After inbound commit but before pickup ACK, redelivery converges as another
  observation.
- After pickup ACK but before ultimate ACK submission, the active runtime may
  send or re-send the deterministic response; a future replicated profile may
  do so from another full replica.
- Loss or unavailability of the recipient runtime beyond mediator retention
  may lose an in-flight package. Receipt-required sender retry is the recovery boundary.
- Submission-terminal messages deliberately accept best-effort completion
  after transport acceptance.
- Loss of an optional Web publisher prevents Web-facade discovery but does not
  invalidate Peer invitations or established relationship DIDs.

## 14. Privacy

Wire IDs, message types and content are visible only inside end-to-end
encrypted application messages. Package IDs and recipient routing DIDs are visible to the mediator. Delivery
IDs are visible to the recipient mediator. A future replica-mediation profile
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
9. Two valid preparations of one intent agree on semantic and intent hashes.
10. Retrying one package uses identical plaintext, ciphertext and package ID.
11. A permitted address/key transition creates a new package/plaintext hash
    while preserving wire ID, semantic hash and intent hash.
12. Body, type, thread or attachment changes under one wire ID produce a
    semantic conflict.
13. Timing, ACK policy or additional-header changes under one wire ID produce
    an intent conflict.
14. HTTP or mediator acceptance records submitted, never acknowledged.
15. A submission-terminal message stops normal retry after first successful
    submission; a receipt-required message waits for explicit ACK or another
    terminal state.
16. A deterministic response acknowledges a message only when explicit `ack`
    names its wire ID.
17. ACK is emitted only after durable inbound commit.
18. Pure ACK uses `pleaseAck == null`, creates no ACK loop and is
    submission-terminal.
19. A pure ACK whose carrier omitted `created_time` commits
    `createdTime == null` and omits the wire header on every preparation.
20. The fixed pure-ACK vector derives execution ID
    `feeae3f7-34ea-5ff1-b449-0ef76a7375c7`, effect ID
    `QU7ryTNMw1tii4V4tdS3XdEpqknAWUU6PkhTfdgXdok`, MID
    `89bb3649-cd60-51ab-84cf-9f7e0c0f1c3e` and wire ID
    `2b85898b-4c15-5212-a56b-4826d9462a81`.
21. One carrier that requests current and older known IDs freezes one ordered
    deduplicated ACK target set; unknown targets arriving later do not mutate
    the response effect.
22. ACK of a deterministic response stops normal retry but its exact packages
    remain held until durable replay closure.
23. Duplicate receipt before replay closure re-submits the same response/ACK
    package only while replay submission is eligible; after durable closure or explicit erasure no replacement is minted.
24. Valid address variants converge; invalid variants conflict.
25. Equal wire IDs under transition-verified peer keys merge only through the
    same stable relationship execution scope; unrelated key reuse does not.
26. A repackaged observation that arrives before transition evidence remains
    effect-deferred. After verification it derives the same relationship/wire-ID
    execution identity and cannot execute once per peer key.
27. A binding with the wrong derived ID or a different scope suppresses new
    effects as an execution-identity conflict.
28. Pure Empty ACK is retained for control/audit but absent from threads,
    unread counts and application handlers.
29. Invalid `from_prior` prevents ACK processing and transition.
30. Duplicate explicit ACKs are harmless and one valid ACK stops all normal
    receipt-required package retry.
31. Expiry stops work permanently; a later valid ACK may display
    acknowledged-late without restarting work.
32. The default initial rendezvous message may be Trust Ping; an admitted
    application message may be first without a custom wrapper.
33. No emitted message uses an `https://estoc.dev/rendezvous/1.0/*` type.
34. A deterministic handoff response carries pairwise long-form sender
    evidence, one frozen relationship-level `from_prior`, explicit ACK and
    `please_ack: [""]`.
35. `from_prior.sub` equals plaintext `from` byte-for-byte; `from_prior.kid`
    belongs to the exact `iss` spelling pinned from discovery.
36. Until handoff confirmation, every responder message from the new pairwise
    DID carries the same `from_prior` and long-form sender spelling.
37. Direct and mediated delivery enter the same inbound fold.
38. Crash injection at every section-13 boundary loses neither committed
    outbound intent nor unacknowledged inbound delivery.
39. Phase 1 works with one active full runtime and ordinary account-scoped
    Message Pickup; replica fan-out is not required.
40. A non-Estoc peer that does not provide explicit ACK or `from_prior`
    confirmation remains visibly unconfirmed and is outside reliable-bootstrap
    conformance.
41. A reader preserves duplicate `please_ack` or `ack` wire targets exactly,
    expands the current-message sentinel only for processing, and ignores
    later duplicate targets without changing the stored array.
42. Two implementations normalize every accepted attachment carrier, missing
    value, null, empty string and closed metadata field to the same semantic
    projection and hash.
43. Conforming mediator operation persists and logs no application plaintext;
    any explicitly enabled bounded diagnostic mode is visibly outside the
    no-plaintext profile.
44. ACK target lookup is scoped by `(carrier.logicalPeerScope, wireId)`;
    another relationship reusing the same wire ID is never acknowledged.
45. ACK target order follows durable first receipt ordinal, not canonical event
    order or EventStore change order; a clock rollback between two receives
    does not reverse their ACK order.
46. Reaching `replayUntil` does not release exact replay material until a
    durable `message.replayClosed` is committed; restart or clock rollback
    cannot reopen a closed replay obligation.
47. An unresolved hold or ordinary non-retryable delivery failure blocks
    duplicate replay submission without releasing replay material. After
    release, replay resumes only if every other eligibility condition still
    holds.
48. Generic pure ACK copies carrier `pthid` and normalized `created_time` or
    null. Rendezvous handoff Empty uses its separately frozen rendezvous
    profile and one carrier cannot produce both ACK intents.
49. After initiator handoff validation and restart, the portable relationship
    binding reconstructs the same execution ID; later verified rotation does
    not create another execution identity for the same relationship/wire ID.
