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
- **Message ID (`mid`)** — the vault entity ID of one logical message.
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

## 4. Vault-first sending

A full vault runtime MUST be able to commit a send while DNS, DID resolution
and every mediator are unavailable. Before required network work it records:

- `mid` and wire ID;
- target contact or explicit channel;
- message type, thread and parent-thread IDs;
- body and ordered logical attachments;
- immutable `createdTime`;
- immutable `expiresTime` or null;
- immutable `pleaseAck`, represented as null or an ordered array;
- immutable `ack`, represented as an ordered array;
- all supported additional top-level headers; and
- the user or deterministic automatic-effect decision to send.

`createdTime` is a durable protocol timestamp. A user-authored message usually
uses commit time. A deterministic automatic response may derive it from its
triggering message so concurrent replicas agree. It is not a transport
freshness proof.

A receiver MUST NOT reject an otherwise valid, unexpired message merely
because `created_time` lies outside a local clock-skew window. A protocol may
constrain `expiresTime - createdTime`.

A successful vault commit does not imply resolution, encryption or
submission. The active full runtime may complete those effects later. Correctness MUST
NOT depend on an uninterrupted process lifetime or on rebuildable cache state.

A remote thin client without the seed may stage a command while offline, but
that is not a vault commit. It becomes authoritative only when a full vault
runtime appends `message.out`.

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

Values are copied from `M`. Absent thread values are null. Body and
attachments use the canonical stored-message representation defined by
`vault-events.md`.

The semantic projection excludes:

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
  "created_time": 1788442800,
  "expires_time": null,
  "please_ack": [""],
  "ack": [],
  "headers": {}
}
```

`please_ack` is either null, meaning the wire header is absent, or the exact
ordered array carried by the wire header. Each array element names a message
whose explicit acknowledgment is requested. The empty string means the current
message. The current wire ID MAY be used instead of the empty string.

Define:

```text
expandPleaseAck(currentWireId, values):
    replace every "" with currentWireId
    remove later duplicates without reordering the first occurrence
```

A message is receipt-required exactly when:

```text
pleaseAck != null
and currentWireId is in expandPleaseAck(currentWireId, pleaseAck)
```

Therefore:

```text
pleaseAck == null       header absent; current message not receipt-required
pleaseAck == []         header present but requests no explicit message ID
pleaseAck == [""]       requests explicit ACK of the current message
pleaseAck == [wireId]   requests explicit ACK of the current message
pleaseAck == [olderId]  requests ACK of the older message only
```

Estoc writers SHOULD omit `please_ack` rather than emit `[]`. Receivers MUST
accept and preserve all standard forms, including `[]`, `[""]` and an array
containing the current message ID.

For inbound normalization:

- absent `please_ack` becomes null;
- a present array remains byte-for-byte equal as a JSON string sequence;
- absent `ack` becomes `[]`;
- absent time becomes null; and
- no additional header becomes `{}`.

`please_ack` and `ack` values are strings. Writers SHOULD NOT emit duplicate
targets. Readers preserve the wire array exactly and, when applying receipt
semantics, expand `""` only in `please_ack` and ignore each later occurrence of
a target already seen. Wire order is preserved. `ack` follows oldest-to-newest
receive order and is never sorted lexicographically. A preparer MUST NOT
substitute its clock, alter receipt policy, reorder arrays or opportunistically
add unrelated acknowledgments.

`headers` contains every permitted top-level DIDComm field not represented by
a dedicated field. A difference in any such field is an intent difference.

`intentHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON for
this projection.

### 5.3 Exact plaintext hash

`plaintextHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for the complete innermost DIDComm plaintext actually encrypted by one
package. It includes `from`, `to`, `from_prior` and every emitted header.

All packages for one `mid` agree on semantic and intent hashes. They may have
different plaintext hashes only when package-level addressing or security
evidence changes under a permitted rule.

## 6. Preparing a package

A preparer folds the target and selects:

- one live sender DID and key generation;
- one current peer DID and authenticated peer key;
- exact `peer.resolved` evidence;
- one route; and
- any required contact-scoped `from_prior`.

It then constructs the complete innermost plaintext from durable intent.
Version 3 emits:

- `typ`, `id`, `type`, `from`, `to`, `created_time` and `body`;
- `thid`, `pthid` and `expires_time` when non-null;
- `please_ack` whenever `pleaseAck` is not null, including `[]`;
- `ack` when non-empty;
- `from_prior` when required;
- `attachments` when non-empty; and
- each `headers` entry at the plaintext top level.

The reserved names are:

```text
typ, id, type, from, to, created_time, expires_time,
thid, pthid, please_ack, ack, from_prior, return_route,
body, attachments
```

They MUST NOT appear in `message.out.headers`. An implementation that cannot
preserve an additional supported header MUST reject preparation rather than
dropping it.

The preparer RFC-8785-canonicalizes the plaintext, computes `plaintextHash`,
encrypts, parses the encrypted-message JSON with duplicate-member and I-JSON
validation, and stores `UTF8(RFC8785(parsedEncryptedEnvelope))` as one raw DASL
object before appending `message.prepared`. Submission uses those exact stored
bytes.

Retrying a package reuses identical plaintext, normalized ciphertext bytes and
package ID.

A new package for the same logical message may change `from`, `to`, selected
keys, peer resolution or `from_prior` only when a selected key generation,
selected route or verified contact-scoped transition permits it. A new exact
plaintext or encryption result requires a new package ID and plaintext hash.

A protocol may be stricter. In particular, one initial rendezvous message pins
its resolution generation for that wire ID.

## 7. Expiration, completion and retry

Before preparation or retry, a worker checks durable expiry. When
`now >= expiresTime`, it appends a message-scoped, non-retryable `expired`
failure and submits no package. A later user attempt requires a new
`message.out` and wire ID.

Completion mode is derived from the current message's wire ID and exact
`message.out.pleaseAck` value:

```text
requested = expandPleaseAck(wireId, pleaseAck or [])
receiptRequired = wireId is in requested
```

- **receipt-required** — retry continues until an authenticated explicit ACK
  names the wire ID, or until expiry, hold or terminal failure.
- **submission-terminal** — the first successful submission ends normal
  background retry, while display remains `submitted`, not `acknowledged`.

A message can be submission-terminal while requesting acknowledgments of older
messages. A present empty array by itself does not make the current message
receipt-required.

HTTP success, WebSocket acceptance or mediator acceptance only records
`delivery.submitted`.

Work eligibility and displayed outcome are separate. Expiry permanently ends
new work. A later valid ACK may improve display to acknowledged-late but never
reactivates preparation or retry.

A user or policy hold stops automatic work vault-wide. In the phase-1 profile
there is one active writer. Future synchronization MUST NOT create a hold merely
because another author produced the intent.

## 8. Durable end-to-end acknowledgment

### 8.1 Honoring `please_ack`

A receiver expands a present `please_ack` array by replacing `""` with the
current incoming wire ID. If the resulting target set is empty, the header asks
for no explicit ACK and creates no response obligation in this profile.

A conforming Estoc receiver honors requested IDs only after it has:

1. authenticated, decrypted and validated the complete message;
2. stored retained body and attachment objects;
3. durably appended `message.in`; and
4. committed any non-controversial channel evidence required to address the
   response.

It includes in outgoing `ack` only requested message IDs that are durably known
to it. Values are ordered oldest-to-newest by the receiver's convergent logical
receive order. The empty string never appears in an `ack` array.

The receiver uses an existing deterministic protocol response when the
application protocol defines one. If no such response is available, it uses:

```text
https://didcomm.org/empty/1.0/empty
```

with an explicit `ack` header.

A natural DIDComm response may be an implicit protocol acknowledgment, but
Estoc records `delivery.acknowledged` only from an authenticated explicit
`ack` value. A pure ACK contains no `please_ack` and is submission-terminal. It
never asks for another ACK.

### 8.2 Deterministic pure ACK

For a pure ACK of one triggering message:

```text
handlerId  = https://estoc.dev/distributed-delivery/1.0#pure-ack
effectKind = pure-ack
ordinal    = 0
createdTime = triggering message.createdTime
expiresTime = null
thid = triggering thid, or triggering wireId when thid is null
pthid = triggering pthid
pleaseAck = null
ack = [triggering wireId]
headers = {}
body = {}
attachments = []
```

The generic automatic-effect derivation produces stable effect, MID and wire
IDs. For triggering MID
`019b1b61-2e26-7a8f-8f29-a4d86a82dbd4`, the vectors are:

```text
effectId = Pq2QwoCogLZIy8AtxGjbmtwAKdQyJoCatxh8IjL3o7o
mid      = db2107e1-e230-5efb-808e-7fa065054f73
wireId   = 5627527e-2820-5935-9d91-7e0181838aa9
```

### 8.3 Applying `ack`

An authenticated plaintext acknowledges an outbound only when its explicit
`ack` array names that outbound wire ID and every package-level addressing,
transition and protocol-specific proof gate has passed.

Threading, a natural response, transport acceptance, `please_ack` presence or a
mediator receipt is insufficient without the explicit `ack` value.

One valid ACK stops automatic retry of every package for the logical
receipt-required outbound. Duplicate ACKs are harmless. Acknowledged means
durable receipt by the peer vault, not read, displayed or accepted by a
business workflow.

### 8.4 Duplicate receipt handling

When a conflict-free message is delivered again and at least one expanded
`please_ack` target was previously honored, the receiver MUST re-submit the
same already-existing deterministic protocol response or pure-ACK package. It
MUST NOT mint a new effect, message, wire ID, package or `from_prior`.

This repairs response or ACK loss without duplicate application side effects.
A bounded debounce may reduce repeated submission. A receiver that did not
honor an optional ACK request is not required to invent a response merely
because the request was duplicated.

## 9. Receiving identity and duplicate folding

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

The authenticated form omits `myKey`, so a valid repack to another local
recipient key can converge under one observation MID.

For each MID group:

- equal semantic and intent hashes form one observation group;
- different semantic hash is an application-content conflict;
- equal semantic hash with different intent hash is a control-intent conflict;
- every plaintext variant must independently validate; and
- conflicts suppress disputed automatic effects and ACK processing.

After contact attribution, two authenticated MID groups may be merged as one
logical message when:

- wire IDs are equal;
- both attribute to the same non-conflicted contact;
- authenticated peer keys are connected by a verified contact-scoped
  `peer.transitioned` chain;
- semantic and intent hashes agree; and
- every package-level proof validates.

This is the only cross-peer-key wire-ID merge.

A conforming `empty/1.0/empty` pure ACK is durably retained for control and
audit, but excluded from thread display, unread counts, notifications and
application-content handlers.

## 10. Rendezvous bootstrap delivery

Rendezvous is a processing profile, not an Estoc DIDComm protocol family.
The first message to a rendezvous DID is an ordinary allowlisted application
message.

When no other content is available, the initiator sends:

```text
https://didcomm.org/trust-ping/2.0/ping
```

with `response_requested == true`, `please_ack: [""]`, finite expiry and OOB
invitation ID as `pthid` when applicable.

An allowlisted application protocol may instead send its real first message
with the same receipt and expiry requirements.

After local relationship admission, the responder selects a deterministic
handoff response:

1. Trust Ping `ping-response` for a Trust Ping whose response is requested;
2. a deterministic protocol response whose bytes are fully determined by the
   admitted message and portable state; or
3. Empty Message ACK otherwise.

Human-authored content is never used as the handoff response. It is an ordinary
later message and carries the frozen relationship `from_prior` until the
handoff is confirmed.

Relationship admission does not imply business-protocol acceptance.

The first responder message:

- is sent from the responder relationship DID;
- uses long-form Peer DID sender evidence on first disclosure;
- contains `from_prior` proving rendezvous DID to relationship DID;
- explicitly ACKs the initial wire ID;
- has `please_ack: [""]` to request handoff confirmation;
- preserves protocol threading and OOB `pthid`; and
- uses the deterministic handoff timing from `rendezvous.md`: its
  `created_time` equals the triggering initial message's `created_time`, its
  `expires_time` is the triggering initial expiry plus 604800 seconds, and
  `from_prior.iat` equals the relationship-level rotation instant frozen by
  `relationship.established`.

The initiator validates `from_prior` against the pinned resolution snapshot
before applying the response ACK or appending `peer.transitioned`. It then
confirms the response with a natural outbound message or pure ACK to the new
relationship DID.

Until the responder receives an authenticated message addressed to the new
relationship DID, every outbound package from that DID to the contact carries
the same byte-stable `from_prior`. Ordinary traffic may therefore overtake the
selected response without becoming unattributed.

A rejected bootstrap emits no custom decline. It is silent or uses a
protocol-specific error or Report Problem 2.0 message from the rendezvous DID.

## 11. Automatic effects

Delivery is at least once. Phase 1 may process one logical message more than
once after redelivery or a crash boundary. A future multi-replica profile may
also process it concurrently. Every automatic effect has an idempotency key:

```text
effectId = base64url(
  SHA-256(
    UTF8("estoc/effect/1\0") ||
    UTF8(mid) || 0x00 ||
    UTF8(handlerId) || 0x00 ||
    UTF8(effectKind) || 0x00 ||
    UTF8(decimalOrdinal)
  )
)
```

Effects emitting DIDComm messages derive stable output MID and wire ID.
External calls use `effectId` as an idempotency key or explicitly document
at-least-once behavior.

Trust Ping responses use:

```text
handlerId  = https://didcomm.org/trust-ping/2.0
effectKind = ping-response
ordinal    = 0
```

Pure ACK uses section 8.2. Application protocols define their own stable
handler ID, effect kind and ordinal.

Estoc does not claim distributed exactly-once execution.

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
19. The fixed pure-ACK vector derives effect ID
    `Pq2QwoCogLZIy8AtxGjbmtwAKdQyJoCatxh8IjL3o7o`, MID
    `db2107e1-e230-5efb-808e-7fa065054f73` and wire ID
    `5627527e-2820-5935-9d91-7e0181838aa9`.
20. Duplicate receipt of a message whose requested IDs were already honored
    re-submits the same response/ACK package rather than creating another
    effect.
21. Valid address variants converge; invalid variants conflict.
22. Equal wire IDs under transition-verified peer keys in one contact merge;
    unrelated key reuse does not.
23. Pure Empty ACK is retained for control/audit but absent from threads,
    unread counts and application handlers.
24. Invalid `from_prior` prevents ACK processing and transition.
25. Duplicate explicit ACKs are harmless and one valid ACK stops all
    receipt-required package retry.
26. Expiry stops work permanently; a later valid ACK may display
    acknowledged-late without restarting work.
27. The default initial rendezvous message may be Trust Ping; an admitted
    application message may be first without a custom wrapper.
28. No emitted message uses an `https://estoc.dev/rendezvous/1.0/*` type.
29. A deterministic handoff response carries pairwise long-form sender
    evidence, one frozen relationship-level `from_prior`, explicit ACK and
    `please_ack: [""]`.
30. `from_prior.sub` equals plaintext `from` byte-for-byte; `from_prior.kid`
    belongs to the exact `iss` spelling pinned from discovery.
31. Until handoff confirmation, every responder message from the new pairwise
    DID carries the same `from_prior` and long-form sender spelling.
32. Direct and mediated delivery enter the same inbound fold.
33. Crash injection at every section-13 boundary loses neither committed
    outbound intent nor unacknowledged inbound delivery.
34. Phase 1 works with one active full runtime and ordinary account-scoped
    Message Pickup; replica fan-out is not required.
35. A non-Estoc peer that does not provide explicit ACK or `from_prior`
    confirmation remains visibly unconfirmed and is outside reliable-bootstrap
    conformance.
36. A reader preserves duplicate `please_ack` or `ack` wire targets exactly,
    expands the current-message sentinel only for processing, and ignores
    later duplicate targets without changing the stored array.
37. Conforming mediator operation persists and logs no application plaintext;
    any explicitly enabled bounded diagnostic mode is visibly outside the
    no-plaintext profile.
