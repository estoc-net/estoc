# distributed-delivery/1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **phase 1, implemented** — phase-1 delivery profile for one active full vault
runtime.

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
- [7. Submission completion and termination](#submission-completion-and-expiration)
- [8. Durable end-to-end acknowledgment](#durable-end-to-end-acknowledgment)
- [9. Channel-local message and execution identity](#observation-identity-logical-aliasing-and-execution-identity)
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

An Estoc message begins as a durable intent in one fixed oriented channel.
Phase 1 has one active executor.

Every message transport call uses its committed `message.prepared` package.
Only the live initial action or a new explicit manual retry may make that call.
Transport acceptance commits `delivery.submitted`, permanently completing that
outbound. A failed/unknown call, missing ACK, process reopen or another replica
does not automatically retry it. A manual retry preserves the exact committed
package; selecting another channel means a new message ID.

This profile defines intent/package identity, channel-local deduplication,
explicit ACK authorization, process-durable receipt and effect ordering.
It makes no cross-channel or cross-replica exactly-once business-execution promise.

<a id="terms"></a>

## 2. Terms

- **Channel** — fixed ordered pair of canonical local and peer DIDs within one vault.
- **Contact** — local names, preferences and selected channel histories with no protocol authority.
- **Full replica** — a writable vault incarnation; phase 1 still has one active executor.
- **Outbound message ID** — one committed intent's entity ID and plaintext `id`.
- **Inbound message ID** — derived from canonical sender, canonical recipient and wire ID.
- **Execution ID** — stable identity of one channel-local input; identity alone grants no work.
- **Package ID** — exact encrypted inner envelope identity and Routing `forward.id`.
- **Delivery ID** — mediator pickup identity, separate from message/package IDs.
- **Prepared** — one committed, fixed package; it records no transport invocation.
- **Submitted** — recorded transport acceptance; it is not ultimate receipt.
- **Acknowledged** — accepted explicit peer `ack` naming the exact authorized outbound.
- **Semantic/intent/plaintext hashes** — the projections in section 5; addressing
  is package evidence but the intent's channel is independently immutable.

<a id="addressing-layers"></a>

## 3. Addressing layers

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

All local communication addresses are vault-scoped. The active full runtime
derives their private keys and receives their messages. Public/private
allocation does not select a different sender permission or receive
path. A later server or replica does not own an address merely by executing
the vault. The channel preserves local/peer roles within that vault;
each message has a sender and recipient, and every rotation is directed.

Each local communication DID has one immutable `boundRouteId`, mediated or
direct. Changing its keys or bound route creates a successor DID entity;
[local rotation decisions](channels.md#did-rotationselected) select continuation
in an exact channel context; their links are derived.
An external recipient's resolved document may offer transport choices; choosing
among authorized routes does not change the application recipient. A direct
endpoint MUST NOT expose a replica ID as the peer-visible recipient.

The phase-1 mediator uses ordinary account-scoped Message Pickup with one
active pickup client.

A valid `from_prior` justifies one endpoint replacement in its exact channel context.
Unrelated channels using that address retain their own endpoint decisions.

<a id="phase-1-mediator-envelope-and-storage-profile"></a>

### 3.1 Phase-1 mediator envelope and storage profile

Before storing a Routing 2.0 `forward`, the mediator MUST require:

1. an outer DIDComm encrypted message addressed to the mediator;
2. a valid `body.next` that maps to the mediation account itself or a recipient
   currently registered to that account;
3. exactly one attachment;
4. an attachment whose `media_type`, when present and non-null, equals
   `"application/didcomm-encrypted+json"`; an absent or null `media_type` is
   unspecified and does not bypass the checks below;
5. exactly one of `data.json` or `data.base64`, and no `data.links`;
6. after decoding, one DIDComm encrypted-message JSON serialization (General
   JWE JSON): base64url `protected`, `iv`, `ciphertext` and `tag`, and a
   non-empty `recipients` array whose entries each carry `header.kid` and a
   base64url `encrypted_key`. For every recipient, the decoded protected
   header, the shared unprotected header and the per-recipient header MUST
   have pairwise-disjoint member names, and their union MUST give `alg` and
   `enc` as non-empty strings; and
7. normalized bytes within the advertised account and message limits.

Senders SHOULD set the attachment `media_type`; stock Routing 2.0 wrappers
leave it out, so receivers apply the same checks either way and reject only a
declared different type.

No JSON object in the forward plaintext or in the decoded envelope may repeat
a member name. The rule is the same for `data.json` and `data.base64`, and it
is judged on the sender's JSON text: a parsed message that has already folded
repeated names or converted numbers is not a basis for it. `data.base64` MUST
decode as base64url without ignoring invalid characters and then as
well-formed UTF-8. Unknown members, numbers included, are kept and take part
in canonicalization, so both carriers of one envelope normalize to the same
bytes. The mediator MUST NOT limit the inner `alg` or `enc` to algorithms it
implements, and MUST NOT re-encode `protected`.

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
wire ID. HTTP errors, including 400 and 413, timeouts, disconnects and remote
Problem Reports supply only local failure diagnostics. They MUST NOT append
`delivery.failed`. An unsuccessful or uncertain call leaves manual work and
grants no automatic retry.

The mediator MUST bound normalized envelope size, retained ciphertext bytes,
retained message count, registered recipients, recipient-update rate, pickup
batch size and retention time. A quota or validation failure MUST NOT leave a
partially stored package. Anonymous routing responses SHOULD avoid becoming a
precise account- or recipient-existence oracle: an unknown `body.next`, a full
queue and a package conflict share one refusal. An acceptance still discloses
that `body.next` takes mail at this mediator at that moment; that is the cost
of acceptance meaning `submitted`.

<a id="4-vault-first-sending-and-commit-boundaries"></a>

<a id="vault-first-sending-and-commit-boundaries"></a>

<a id="vault-first-procedures-and-commit-boundaries"></a>

## 4. Vault-first procedures and commit boundaries

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only.

A full vault runtime MUST be able to commit a send while DNS, DID resolution
and every mediator are unavailable. Before network work, commit the content and
[message.out](vault-events.md#message-out), freezing its ID, channel, headers
and user or automatic-effect decision.

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
<a id="91-receive-a-message"></a>
<a id="92-receive-recovery"></a>

### 4.1 Commit and acknowledgment boundaries

| Boundary | Durable prerequisite | Meaning |
| --- | --- | --- |
| Offline send intent | Content and `message.out` with fixed channel/direction | A selected new message, not authority for recovery dispatch |
| Package preparation | Valid fixed-channel intent, operation resolution and `message.prepared` | One fixed package for this message |
| Transport invocation | Committed package plus a live initial/manual action | One call using the fixed package; no invocation event is stored |
| Submission completion | `delivery.submitted` naming that message/package | Stop preparation and sending for this message ID |
| Channel receipt | Current authentication, exact resolution, objects and `message.in` | Normal pickup ACK may follow |
| Proof verification | Exact authenticated carrier with its original JWT and derivable or retained immutable issuer material | Fold computes proof result and continuity status without another event |
| New source-derived work | Complete source/proof evidence, current policy and any additional evidence required by that consumer | Only the specific eligible operation may proceed |
| Peer ACK | Complete source witness and exact channel/path target | Receipt information only |

Every dependency reference names an event committed before the dependent call.
Object storage alone is not event commitment. Contact membership, a thread ID,
peer ACK or a missing submission event never supplies dispatch authority.

<a id="send-an-ordinary-message"></a>

### 4.2 Send an ordinary message

Under the operation lock, normalize content, freeze immutable headers, choose
one concrete sender and recipient, derive their channel and commit `message.out`
with objects. This call does no network work. An explicit user send may select
a new channel; an automatic output requires a complete source witness, its
operation's policy checks and a same-channel or verified role-preserving
successor response channel.

The original live initial action may then resolve/register and prepare the
fixed channel. Missing prerequisites may wait locally before the first call.
A manual action can resume an eligible pending intent. The action serializes
this message's work and performs these steps:

1. Recheck completion, termination, expiry, denial, conflict, retained keys/routes and bytes.
2. Reuse the committed package; missing references or bytes defer and conflicting
   preparations prevent sending. Prepare and commit one package in the intent's
   fixed channel only when neither a preparation nor an unresolved package
   reference exists.
3. Verify local recipient registration before disclosure when needed.
4. Under the vault lock, recheck package commitment, eligibility and the live
   action. Release the lock, consume that action's one invocation locally and
   call transport with the exact envelope and package ID.
5. Record transport acceptance as `delivery.submitted` naming the message/package.
   Other transport outcomes stay in local trace and MUST NOT produce
   `delivery.failed`. Failure/uncertainty grants no next call;
   explicit cancellation and expiry follow [termination](vault-events.md#delivery-failed).

Keep per-message dispatch serialized across this procedure, without holding
the vault lock across network I/O. Resolve an uncertain preparation commit
before dispatch or another preparation. A crash loses the live action, whether
or not transport was called; reopen cannot replay it. Further calls follow
[manual dispatch rules](channels.md#fixed-outbound-channel).

<a id="receive-a-message"></a>

### 4.3 Receive a message

1. Resolve exact local recipient/key/route eligibility and authenticate the
   current sender under [the gate](relationships.md#hard-pre-vault-gate).
   The [phase-1 adapter](channels.md#carried-proof-and-library-boundary) preserves
   any string-valued `from_prior` without verifying it. Missing local receive
   material may require unopened wait; missing predecessor material cannot.
2. Validate normalized wire fields, supported content and resource limits.
3. Under the lock, commit/reuse exact resolution evidence, then commit content
   and `message.in` with fixed channel and fresh receipt ordinal.
4. Pickup-ACK process-durable receipt independently of channel policy/history.
5. If `from_prior` is present, derive its immutable issuer document and verify
   this carrier's original JWT under [predecessor resolution](relationships.md#predecessor-resolution).
   Fold proof status and continuity without appending an event,
   showing missing evidence as pending.
6. For each consumer, validate exact source/proof evidence and its required
   target or protocol fields. Before new work, recheck supersession, denial
   and that operation's current policy. Commit the concrete intent or local
   result with already committed references. Automatic invitation consumption
   follows [channels.md](channels.md#invitation-consumed)
   independently of those consumers.
7. Process valid explicit peer ACKs and local display views of retained messages.
   The sole active executor may independently create an eager ACK, a Ping reply
   and a rotation notification when their individual policies permit. Each
   output commits its fixed-channel intent before dispatch.
8. A retained duplicate creates no new response obligation or dispatch action.

Hard terminal rejection may pickup-ACK without `message.in` under the gate;
failed durable receipt withholds normal pickup ACK. Control types never trigger
recursive privacy notifications.

<a id="receive-recovery"></a>

### 4.4 Recovery

Rebuild receipt-derived state from retained evidence without current-sender
re-resolution or another receipt event. Recover missing bytes/references and
recompute proofs from retained JWTs and immutable issuer material under
[predecessor resolution](relationships.md#predecessor-resolution).
The active runtime automatically completes missing
[invitation consumption](channels.md#invitation-consumed).

Expose pending/unconfirmed messages for manual action under
[dispatch authority](channels.md#fixed-outbound-channel), preserving message,
execution, package and submission identities. The same uninterrupted initial
receive operation may continue after a local receive prerequisite wait.
Post-receipt missing predecessor material instead ends automatic eligibility
for that carrier under [the proof rule](relationships.md#predecessor-resolution).
Reopen, import and separate evidence recovery have no such action. Erased input
starts no new content-derived effects. Fresh unrelated live input remains independent.

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
for the normalized innermost DIDComm plaintext of one package or one
observation. Normalization omits a top-level member whose value is explicitly
null when its name is one of `from`, `to`, `thid`, `pthid`, `created_time`,
`expires_time`, `from_prior` or `attachments`; that set is closed and does not
grow with the headers a library recognizes. Every other present top-level
member stays in the hash input, including `please_ack: null`, `ack: null` and
null values in additional headers. `body` is unchanged, nested nulls included.

Attachments are normalized as containers, not as JSON values. Each
descriptor and its `data` object retain only the members the
[stored attachment profile](vault-events.md#stored-message-document) admits;
an admitted optional member whose value is null is omitted, and any other
member is excluded. The JSON value inside a `json` carrier is unchanged,
nested nulls included, and the ordinary attachment syntax rules still apply,
including the required non-null `hash` of a `links` carrier.

The single-carrier rule of that profile is checked on the decrypted `data`
object as received, before it is projected onto a typed carrier and before
any member is discarded: exactly one of `base64`, `json` and `links` is
present, counted by presence, so `json: null` is a present carrier. A second
recognized carrier is not unsupported metadata and is never dropped to make
the attachment valid. A library that projects attachment data onto one
carrier must therefore reject an ambiguous object itself, or hand the
receiver enough of the original to reject it before acceptance.

The sender hashes the normalized plaintext it encrypts; the receiver
normalizes the accepted plaintext the same way before hashing. A hash helper
that hashes its input unchanged requires that normalization to have happened
before the call.

An outbound `messageId` has one fixed package. Its intent hash matches the
intent; its plaintext hash preserves the exact prepared addressing and proof.

<a id="preparing-a-package"></a>

## 6. Preparing a package

Use `message.out.senderDidId`, the canonical selected recipient and its derived
fixed channel. Resolve the peer under
[the address profile](relationships.md#recipient-resolution-freshness); select
keys authorized by that operation's document for the intent's fixed DID pair.
The immutable peer document fixes its authorized keys and service. Validate the
intent's source/proof evidence, local key and exact peer resolution under [the package schema](vault-events.md#message-prepared).
Preparation and dispatch require current policy and a live initial/manual action.

Construct the complete plaintext from immutable intent: conditional nullable
timestamps/threads, exact `pleaseAck`, frozen `ack`, supported headers, body and
ordered attachments. `from`/`to`, exact key methods and any frozen proof follow
that fixed channel's evidence. The wire ID equals the outbound message ID.
Reject forbidden `return_route`, duplicate JSON members and invalid I-JSON.
Canonicalize with RFC 8785, encrypt through maintained DIDComm APIs, then commit
the exact normalized envelope and `message.prepared` before transport.

Commit only when no preparation exists; otherwise reuse the saved package.
That commit freezes its plaintext, ciphertext, proof, spelling, package ID and
envelope CID for the initial call and every retry. Missing evidence or bytes
defer sending. Later confirmation, rotation, resolution or termination cannot
replace it; changing the package requires a new message ID.

<a id="submission-completion-and-expiration"></a>

## 7. Submission completion and termination

Any valid committed submission completes the message and prevents further
preparation or retry, regardless of ACK policy. Missing submission does not prove
nondelivery; pending work follows [the delivery fold](vault-events.md#outbound-message-and-delivery-fold).

Expiry stops new work at equality and records message-terminal failure when
observed before preparation/dispatch. It does not overwrite an already recorded
submission. Later ACK evidence can report receipt without reopening anything.
Explicit cancellation commits message-scoped `delivery.failed` with code
`cancelled` under [the termination rules](vault-events.md#delivery-failed),
stopping pending work without claiming nondelivery.
Valid expiry or cancellation terminates the entire intent without depending
on preparation evidence. Complete submission still takes precedence.
Erasure, security denial, key/route retirement and missing exact bytes separately
govern manual retry. Ordinary address rotation selects new messages only.

Prepared-envelope retention is owned solely by
[vault-events.md](vault-events.md#held-roots). A paused/unconfirmed eligible
package remains retained for possible manual action; waiting is not deletion.
ACKs have no independent retention contribution. A submitted envelope need not
be recreated for a duplicate input or manual "send again" with a new ID.

<a id="durable-end-to-end-acknowledgment"></a>

## 8. Durable end-to-end acknowledgment

<a id="freezing-an-ack-target-set"></a>

### 8.1 Freezing an ACK target set

Before creating an ACK intent, require an eligible complete source witness
and choose its exact sender/recipient under
[the built-in operation rule](#built-in-independent-operations). An unrelated
channel in the same contact is never a substitute. If no eligible sender exists,
preserve the input for manual action; do not commit an incomplete response or
automatically dispatch it after a later restore. An ACK uses retained receipt
and header evidence, so body erasure alone does not disqualify its source or
targets. It does not restore any permission for content-derived work.

Under the operation lock, look up the pure-ACK tuple for this execution before
choosing timing or targets. Reuse its fixed intent without sending it on
duplicate/recovery. Eligible live input and current ACK policy may create that
intent immediately, independently of any natural reply or rotation notification.
Explicit manual completion of pending ACK work follows the same checks under
[the dispatch contract](channels.md#fixed-outbound-channel).

Whether to honor `pleaseAck` is local policy, not a durable reply obligation.
If it is null/empty this profile creates no requested-ACK work. Otherwise
expand `""` to the carrier's wire ID, ignore later duplicate requests for
selection and preserve the original stored wire array. A named target must
have complete source-witness evidence from the same peer direction in this
channel or a verified role-preserving predecessor channel. Validate the exact path,
authentication and requesting peer; no vault-global wire-ID match or display
group grants a target.
If multiple otherwise eligible channel inputs with that wire ID are ambiguous,
omit it. The current carrier can identify itself by its exact source.

Sort eligible targets by their minimum complete receipt key, then freeze their
wire IDs in one output. Unknown, conflicted or unauthorized targets are
omitted and later discovery cannot change the saved array. Generic replies use
`thid = carrier.thid ?? carrier.wireMessageId`, copy nullable `pthid`, and follow
the producing protocol's response rules. No-response errors still do not reply.

Send the ACK as its own Empty message once its prerequisites are ready. Do not
wait for, attach it to, or consume the tuple of a natural reply or rotation
notification. Those outputs may coexist with this intent. Built-in Ping replies
and rotation notifications have `ack == []`; another application protocol may
define its own explicit ACKs subject to the same target checks. There is no
execution-wide limit of one ACK-bearing output. Control input may supply ACK
observations but cannot trigger recursive privacy notifications. Never request
an ACK for a pure ACK, or answer a pure ACK with another pure ACK. Every output
follows normal preparation/submission boundaries.

<a id="deterministic-pure-ack"></a>

### 8.2 Deterministic pure ACK

```text
effectType = https://estoc.dev/distributed-delivery/1.0#pure-ack
```

Copy the carrier's normalized nullable creation time; expiry is null. Body is
`{}`, attachments empty, `pleaseAck` null and `headers` empty. Threads and ACK
targets follow section 8.1.

The executable fixture uses recipient
`did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd`,
authenticated sender `did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP` and wire ID
`019b1b61-3444-7190-9db5-1cc9c215eb23`:

```text
executionId = ccee59f0-8c79-5011-8822-dbb14de9cf7d
effectKey = Vyjgpd9idT4bb9ejAEdwT5J8dX-kL6FfSniCkFZDB20
outbound message ID = wire ID = 3543ac01-4ac6-5c14-b160-4f8f4e2e6811
```

These values follow the channel execution transcript and effect-key
algorithm below.

<a id="applying-ack"></a>

### 8.3 Applying `ack`

Require an explicit wire ID and one complete source witness. Find the exact
outbound intent/package, then verify that the carrier's channel is the same
or an authorized role-preserving successor of its fixed channel. The carrier's
sender must be the original peer or its verified replacement and its recipient
the original local endpoint or its verified local successor. Undirected graph
connectivity, group membership, threads and ordinary responses are insufficient.

All redundant witness fields must come from one complete source row. Missing
path/authentication/package references defer the acknowledgment. The carrier's
key need not equal the old package's recipient key: validate it against the
carrier's own immutable DID document and any required successor path. The
observation records peer receipt only, not transport acceptance or permission
to send again.

<a id="duplicate-receipt-handling"></a>

### 8.4 Duplicate receipt handling

An authenticated duplicate in the same channel reuses its logical input/execution.
It creates no new effect, output ID, package, proof or dispatch action. A pending
response remains available for explicit manual retry; a submitted response
never sends again. Another channel has another input identity and is not a
duplicate under this profile. A display link to old content changes nothing.

<a id="observation-identity-logical-aliasing-and-execution-identity"></a>

## 9. Channel-local message and execution identity

<a id="observation-ids-and-vectors"></a>

### Observation IDs and vectors

For authenticated input, canonicalize the authenticated sender and actual local
recipient, then compute:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v3", "authenticated", canonicalSenderDid, canonicalRecipientDid, wireMessageId])
)
```

Keys and source event IDs remain exact authentication evidence. Different
authorized keys in the same immutable DID document can represent the same
channel input; selected key differences create no new deduplication scope.
Opposite sender directions cannot collide merely by choosing the same wire ID.
For truly anonymous input, retain the independent observation-only derivation:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v1", "anonymous", localKeyName, wireMessageId])
)
```

For recipient `did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd`
and sender `did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP`, the naming vectors are:

| wireMessageId | messageId | executionId |
| --- | --- | --- |
| `019b2a70-f225-721c-835f-67175be0667e` | `d2192dcf-cc5c-5f7d-b4f1-46972b7b04de` | `a03249b8-5e3e-5d10-a2e7-46844b38f5ae` |
| `019b1b61-3444-7190-9db5-1cc9c215eb23` | `9cfaed56-2cb3-5a84-bc56-f8e882784ac8` | `ccee59f0-8c79-5011-8822-dbb14de9cf7d` |

These are identifier fixtures, not authentication/proof fixtures.

<a id="execution-scope-and-commit-prerequisites"></a>

### Execution prerequisites

Automatic work requires [operation eligibility](channels.md#operation-eligibility)
and [dispatch authority](channels.md#fixed-outbound-channel), independently of
ID derivation. Source/endpoint/proof dependencies must already be committed.
Anonymous and mediator-control input have no application execution.

<a id="address-chains-and-observation-membership"></a>

### Source observations

Validate each source with its own recipient/key mapping and immutable
authentication document under [operation eligibility](channels.md#operation-eligibility).
Equal intent within one sender/recipient/wire-ID input shares one execution;
disagreement follows [the conflict rules](vault-events.md#duplicate-transition-and-conflict-rules).
Continuity links never merge inputs from different channels.

<a id="execution-id-and-immutable-transcript"></a>

### Execution ID

```text
executionId = UUIDv5(
  estocNamespace("message-execution"),
  RFC8785(["v4", {"sender": canonicalSenderDid, "recipient": canonicalRecipientDid}, wireMessageId])
)
```

Use the literal transcript members `sender` and `recipient`; RFC 8785 orders
object members canonically. For inbound work, the peer is the sender and the
local DID is the recipient. Namespace derivation
is in [vault-events.md](vault-events.md#entity-ids-and-reproducible-uuidv5-namespaces).
The event schema member names are not substitutes for these transcript tags.

<a id="local-rotation-scope-vector"></a>

### Rotation and message identity

Changing either endpoint produces another channel and another inbound/execution
ID. The old observation and its effects remain unchanged. Retrying an existing
outbound does not make this change; only a new send can select the new channel.
ACK authorization may follow verified successor paths for an exact outbound
message; that path does not merge the ACK carrier and the acknowledged message
into one execution.

<a id="first-contact-and-address-policy"></a>

## 10. First contact and address policy

Useful content or Trust Ping can be the first ordinary DIDComm message.
Address selection and optional early privacy rotation follow
[the address policy](relationships.md).

<a id="automatic-effects"></a>

## 11. Automatic effects

An automatic DIDComm output is identified by `(executionId, effectType)`.
`executionId` MUST derive from a complete, conflict-free logical carrier under
[the input fold](vault-events.md#inbound-message-and-execution-fold).
An authenticated intent conflict suppresses all automatic work for that execution;
making a disagreeing group ineligible cannot clear the conflict.

Each protocol MUST assign a fixed `effectType` URI to each operation and define
its output intent rules. The URI MUST include a scheme and MUST NOT contain
U+0000. Its exact UTF-8 spelling identifies the operation; implementations MUST
NOT normalize or dereference it to derive the key. The identifier is shared
across implementations and MUST remain unchanged when handlers are renamed,
split or refactored. Distinct operations MUST use different effect types, even
when they produce the same DIDComm message type. An effect type need not itself
be a DIDComm message type URI.

Each tuple permits at most one compatible output intent; different effect types
may independently produce outputs for the same execution. Retries MUST reuse
the tuple and MUST NOT change effect type to create another output or evade a
tuple or execution conflict.

```text
effectKey = base64url(
  SHA-256(
    UTF8("estoc/effect/3\0") ||
    UTF8(executionId) || 0x00 ||
    UTF8(effectType)
  )
)
```

The unpadded base64url key determines the outbound message and wire ID under
[vault events](vault-events.md#ids). The [message.out schema](vault-events.md#message-out)
stores the tuple and intent and defines their validation; conflicts follow
[the delivery fold](vault-events.md#outbound-message-and-delivery-fold).

Under the operation lock in [event-store.md section 9](event-store.md#vault-interface),
check the specific operation's source, current policy and usable authorized
sender. Derive its tuple and look up its message ID before freezing targets,
timing, channel or other fields. Reuse an existing non-conflicted intent; do not
regenerate it after submission, source erasure, another observation or a changed
clock. The exact source and any rotation decision are retained directly in the
[intent](vault-events.md#message-out).
Missing evidence or sender leaves that operation pending without blocking
another independently eligible operation.

ACKs and rotation notifications are eager standalone Empty messages, independent
of natural protocol responses. Arrival, dependency completion and handler order
never merge their tuples.

Derivation, lookup and `Vault.commit` form one locked operation with already
committed dependencies. Reject a conflicting local intent before append;
retain imported conflicts and suppress their work. Only eligible live input
may automatically create an initial intent. Historical unfinished work requires
explicit manual completion with the same tuples under
[dispatch authority](channels.md#fixed-outbound-channel).

Other external effects MUST commit their protocol-defined portable intent
before execution and use that protocol's idempotency or explicit at-least-once
contract. The message fold does not validate those payloads.

One active writer does not provide process-level exactly-once execution.

<a id="built-in-independent-operations"></a>

### Built-in independent operations

| Operation | `effectType` |
| --- | --- |
| Requested receipt ACK | `https://estoc.dev/distributed-delivery/1.0#pure-ack` |
| Trust Ping reply | `https://didcomm.org/trust-ping/2.0/ping-response` |
| Inbound-triggered rotation notification | `https://estoc.dev/distributed-delivery/1.0#rotation-notification` |

Pure ACK and rotation notification both use DIDComm type
`https://didcomm.org/empty/1.0/empty`. Their distinct effect types keep both
operations independent for one execution.

Before selecting addresses for a built-in ACK or Ping reply, reuse an existing
intent for its tuple. For a new intent, use the carrier's actual channel when
its local DID remains eligible for sending there. Otherwise use the unique
non-conflicted verified local-only successor head that retains the carrier's
canonical peer DID, if eligible; otherwise create no automatic intent.
`recipientDid` is the source's canonical `did`, never its `presentedDid` spelling.
Temporary network unavailability or pending recipient registration delays
dispatch without changing the selected channel. This is a producer selection
rule; import validates the saved intent's evidence, not the producer's then-visible
lifecycle state. A later rotation or retirement never reselects a committed intent.

A Ping reply requires `response_requested != false` and current protocol/policy
eligibility. It uses type `https://didcomm.org/trust-ping/2.0/ping-response`,
`thid = source.wireMessageId`, source `pthid`, `createdTime` and `expiresTime`,
empty body/attachments/headers, `ack == []` and `pleaseAck == null`. An expired
Ping cannot start a new reply. It is independent of an ACK requested by that Ping.

A rotation notification names the exact `rotationEventId` in its intent. It
uses the decision's trigger source for its execution, not a later input that
discovers unfinished notification work. Its type is `https://didcomm.org/empty/1.0/empty`,
body/attachments/headers are empty, `ack == []`, `pleaseAck == [""]`, expiry is
null, and source `pthid`, nullable creation time and `thid ?? wireMessageId` are
retained. Its sender is the decision's successor DID and recipient is the
decision's fixed `peerDid`. Its source, when present, belongs to the decision's
`fromDidId`/`peerDid` channel. Packaging carries that decision's
frozen proof until exact-successor confirmation. Notification submission alone
is not confirmation; other successor messages still carry the proof until confirmed.

A manual rotation with no trigger source uses a locally initiated UUIDv7
notification intent, null thread/parent-thread/creation time, and the same
Empty/ACK-request/expiry rules. Under the operation lock, reuse an existing
notification for that rotation decision before allocating its message ID.
Different selected notification IDs for one rotation decision conflict for
notification work; neither new triggers nor retries may create another selection.
Its source/effect fields are null, while `rotationEventId` remains present.
In either case, notification recovery reuses the rotation; it never allocates
another successor. A missing notification is manual work only while its source,
when present, remains eligible under [channels.md](channels.md#operation-eligibility).
Supersession of that source's peer prevents creating the intent. An existing
intent may still be manually dispatched under the ordinary restrictions;
recovery itself grants no automatic replay.

<a id="required-vault-observations"></a>

## 12. Required vault observations

```text
message.out                fixed channel and immutable intent
message.prepared           exact selected envelope
delivery.submitted         observed transport acceptance of the fixed package
delivery.failed            terminal failure or message cancellation
delivery.acknowledged      exact authorized peer receipt observation
message.in                 independent authenticated channel receipt
did.rotationSelected       local successor and frozen proof selected before sending
invitation.consumed        exact one-use disclosure and source-backed consumer
channel.blocked            local channel/successor denial
```

Continuity links and verification status are fold results, not events.
Contact events are not delivery observations. Schemas and folds
are owned by [vault events](vault-events.md) and [channels](channels.md).

<a id="failure-rules"></a>

## 13. Failure rules

- Before intent commit, no message exists. A failed/uncertain commit grants no send.
- After intent commit but before preparation, reopen requires manual action;
  an incomplete snapshot cannot prove nondelivery.
- After preparation commit, a crash before transport and a crash after transport
  acceptance but before submission commit leave the same portable prepared state.
  Recovery requires manual action and preserves the package. Retry may deliver
  duplicate bytes; channel-local dedup applies.
- After submission or termination commits, no retry is allowed.
- After rotation, old intents/packages remain in their fixed channels. If that
  channel becomes unusable, a deliberate new send has a new wire ID.
- After receipt but before pickup ACK, redelivery is another same-channel
  observation. Receipt commit still permits pickup ACK independently of policy.
- After receipt but before consumption, recovery automatically completes that
  local record when its retained source and current policy remain eligible.
  Before a reply, recovery preserves local state and pending work without
  automatically sending ACKs, replies or notifications.
- After erasure, no new content-derived effect is reconstructed.
- Mediator expiry/outage may lose an already submitted message. This best-effort
  profile does not automatically compensate through another replica or channel.

No failure window changes a message's channel or proves nondelivery merely by
lacking a success record. Manual new sending may produce another visible or
business operation if the first one arrived; protocol-level idempotency is
independent of this transport profile.

<a id="privacy"></a>

## 14. Privacy

Wire IDs, message types and content are visible only inside end-to-end
encrypted application messages. Package IDs and recipient routing DIDs are
visible to the mediator. Delivery IDs are visible to the recipient mediator.

A disclosed rendezvous DID is intentionally correlatable within its audience.
Pairwise DIDs SHOULD be disclosed only in encrypted messages and use
Peer DID long form on first disclosure.

Pure ACKs reveal durable receipt timing to the ultimate peer. Implementations
SHOULD NOT encode contact names, replica labels, event IDs or content in peer-
or mediator-visible IDs.

<a id="required-conformance-cases"></a>

## 15. Required conformance cases


<a id="intent-and-immutable-packaging-dd-1-dd-12"></a>

### Intent and immutable packaging (DD-1–DD-12)

- <a id="dd-1"></a> **DD-1.** `message.out` commits with all networking disabled.
- <a id="dd-2"></a> **DD-2.** A peer addresses a communication DID, never a replica or contact ID.

- <a id="dd-3"></a> **DD-3.** `pleaseAck == null` omits the wire header; an array is preserved exactly on
   the wire.
- <a id="dd-4"></a> **DD-4.** `pleaseAck == []` requests no explicit acknowledgment.
- <a id="dd-5"></a> **DD-5.** `pleaseAck` containing `""` or the current wire ID requests its receipt;
   an array naming only older IDs does not. Neither changes submission work.
- <a id="dd-6"></a> **DD-6.** A receiver accepts the standard empty-string sentinel and current-message
   ID form and expands them to the current wire ID for processing.
- <a id="dd-7"></a> **DD-7.** Intent freezes `createdTime`, `expiresTime`, exact `pleaseAck`, exact `ack`
   and every supported additional header.
- <a id="dd-8"></a> **DD-8.** `return_route` in vault application headers or innermost plaintext is
   rejected.
- <a id="dd-9"></a> **DD-9.** Repeated identical preparation payloads reuse one package; a different package ID, envelope or evidence reference for the same message conflicts, even when its intent hash agrees.
- <a id="dd-10"></a> **DD-10.** Retrying one package uses identical plaintext, ciphertext and package ID.
- <a id="dd-11"></a> **DD-11.** Rotation cannot change an existing message's channel or committed package. Cancellation or terminal failure permits no replacement, even before its first send; changing the package requires a new message ID.

- <a id="dd-12"></a> **DD-12.** Body, type, thread, attachment, timing, ACK policy or additional-header
    changes under one wire ID produce an intent conflict.

<a id="submission-and-acknowledgment-dd-13-dd-22"></a>

### Submission and acknowledgment (DD-13–DD-22)

- <a id="dd-13"></a> **DD-13.** Transport acceptance records submitted for the exact committed message/package pair, never ultimate acknowledgment.

- <a id="dd-14"></a> **DD-14.** Every outbound stops all preparation/submission after committed
    `delivery.submitted`, including when its `pleaseAck` requests the current
    wire ID and no ACK arrives. A later transport failure or expiry does not
    replace the submitted outcome.
- <a id="dd-15"></a> **DD-15.** A deterministic response acknowledges a message only when explicit `ack`
    names its wire ID.
- <a id="dd-16"></a> **DD-16.** ACK is emitted only after durable inbound commit.
- <a id="dd-17"></a> **DD-17.** Pure ACK uses `pleaseAck == null`, creates no ACK loop and completes
    submission at the same committed boundary as other outbounds.
- <a id="dd-18"></a> **DD-18.** A pure ACK whose carrier omitted `created_time` commits
    `createdTime == null` and omits the wire header on every preparation.
- <a id="dd-19"></a> **DD-19.** The channel pure-ACK fixture derives execution ccee59f0-8c79-5011-8822-dbb14de9cf7d, effect Vyjgpd9idT4bb9ejAEdwT5J8dX-kL6FfSniCkFZDB20 and wire ID 3543ac01-4ac6-5c14-b160-4f8f4e2e6811.

- <a id="dd-20"></a> **DD-20.** One carrier that requests current and older known IDs freezes one ordered
    deduplicated ACK target set; unknown targets arriving later do not mutate
    the response effect.
- <a id="dd-21"></a> **DD-21.** A valid ACK before submitted adds receipt information only; another transport call still requires manual action and the exact package.

- <a id="dd-22"></a> **DD-22.** Duplicate input reuses its frozen response state but never dispatches it; submitted/collected responses cannot be recreated.

<a id="scope-aliases-and-conflicts-dd-23-dd-30"></a>
<a id="scope-observations-and-conflicts-dd-23-dd-30"></a>

### Channel observations and conflicts (DD-23–DD-30)

- <a id="dd-23"></a> **DD-23.** Authorized key variants within one sender/recipient/wire-ID input converge; inconsistent authenticated intent conflicts.

- <a id="dd-24"></a> **DD-24.** Equal wire IDs in different channels do not merge, even through verified links. Same-channel authorized variants share one execution.

- <a id="dd-25"></a> **DD-25.** Missing source authentication, endpoint or required link evidence defers the affected automatic operation; invitation state alone does not. Later evidence validates only its channel-local execution and grants no recovery dispatch.

- <a id="dd-26"></a> **DD-26.** Contradictory channel identity evidence or authenticated intent suppress new effects; contact edits cannot resolve them and equivalent long/short DID spellings do not cause them.

- <a id="dd-27"></a> **DD-27.** Control input with a complete source witness may supply authorized ACK evidence. It creates no contacts or recursive privacy notifications, and its type alone consumes no invitation.

- <a id="dd-28"></a> **DD-28.** Invalid carried proof prevents link/ACK effects and cannot supply a proof-free invitation source; independently authenticated receipt is retained. Failed envelope authentication creates no receipt and follows the gate's wait or terminal rules.

- <a id="dd-29"></a> **DD-29.** Duplicate explicit ACKs are harmless and affect only peer receipt
    information, never submission completion or envelope retention.
- <a id="dd-30"></a> **DD-30.** Expiry stops unsubmitted work permanently. Receipt `late` follows
    [vault-events.md section 9.7](vault-events.md#outbound-message-and-delivery-fold)'s committed observation-time rule for both
    submitted and expired messages, without changing submission outcome or
    restarting work. Already-submitted messages acquire no new expired failure.

<a id="first-contact-rotation-and-transport-dd-31-dd-39"></a>

### First contact, rotation and transport (DD-31–DD-39)

- <a id="dd-31"></a> **DD-31.** The default initial rendezvous message may be Trust Ping; a received
    application message may be first without a custom wrapper.
- <a id="dd-32"></a> **DD-32.** No emitted message uses an `https://estoc.dev/rendezvous/1.0/*` type.
- <a id="dd-33"></a> **DD-33.** Every unconfirmed local successor uses the same long-form sender and
    frozen from_prior rules, including the first public-to-private rotation.
- <a id="dd-34"></a> **DD-34.** `from_prior.sub` equals plaintext `from` byte-for-byte; the protected JWT
    `kid` has the exact `iss` DID portion. Predecessor method authorization uses
    [vault-events.md section 6.4](vault-events.md#relationship-peertransitioned)'s validated spelling comparison against the
    exact predecessor verification document, without requiring byte equality with presentedDid.
- <a id="dd-35"></a> **DD-35.** New unconfirmed successor packages include frozen proof/long form; committed packages never change after confirmation.

- <a id="dd-36"></a> **DD-36.** Direct and mediated traffic use the same channel receipt and operation folds; only mediated traffic has pickup ACK.

- <a id="dd-37"></a> **DD-37.** Crashes before/after a transport call or before submission commit reopen without automatic sending; manual retry preserves the exact committed package.

- <a id="dd-38"></a> **DD-38.** Phase 1 works with one active full runtime and ordinary account-scoped
    Message Pickup.
- <a id="dd-39"></a> **DD-39.** Preparation requires a valid fixed-channel intent and exact local-key/peer-resolution evidence. Complete source and required carried-proof evidence precede dependent automatic intents; each operation checks its own current policy.

<a id="normalization-ack-and-retention-regressions-dd-40-dd-49"></a>

### Normalization, ACK and retention regressions (DD-40–DD-49)

- <a id="dd-40"></a> **DD-40.** A reader preserves duplicate `please_ack` or `ack` wire targets exactly,
    expands the current-message sentinel only for processing, and ignores
    later duplicate targets without changing the stored array.
- <a id="dd-41"></a> **DD-41.** Two implementations normalize every accepted attachment carrier, missing
    value, null, empty string and closed metadata field to the same semantic
    projection used by `intentHash`.
- <a id="dd-42"></a> **DD-42.** Conforming mediator operation persists and logs no application plaintext;
    any explicitly enabled bounded diagnostic mode is visibly outside the
    no-plaintext profile.
- <a id="dd-43"></a> **DD-43.** ACK targets require exact same-channel or verified role-preserving successor authorization; shared contacts and wire IDs alone supply none.

- <a id="dd-44"></a> **DD-44.** ACK target order uses the minimum complete receipt key, not canonical event
    order or EventStore change order; a clock rollback between two receives
    does not reverse their ACK order in a linear history.
- <a id="dd-45"></a> **DD-45.** Submitted completion survives restart, loss of local state, clock rollback,
    later termination and envelope collection. Later duplicate input cannot
    reopen submission or require the collected envelope.
- <a id="dd-46"></a> **DD-46.** A complete submission witness completes the message even if import later
    adds a competing preparation. The conflict remains visible; another package,
    route or handler cannot bypass completion.
- <a id="dd-47"></a> **DD-47.** Generic pure ACK copies carrier pthid and nullable creation time. An Empty rotation notification uses a distinct fixed tuple, empty ack array and its own ACK request; one input may produce both intents.
- <a id="dd-48"></a> **DD-48.** Reopen reconstructs channel-local execution IDs independently of contacts and grants no dispatch permission.

- <a id="dd-49"></a> **DD-49.** An unsubmitted package survives route unavailability and GC with its exact
    envelope. Committed submission, terminal failure or cancellation releases its contribution
    under the retention fold; route recovery cannot reopen submitted work.

<a id="recovery-and-automatic-effects-dd-50-dd-56"></a>

### Recovery and automatic effects (DD-50–DD-56)

- <a id="dd-50"></a> **DD-50.** Recovery exposes incomplete source/proof and pending response work from retained data, without dispatching protocol output or requiring redelivery. Proof verification uses the immutable issuer document derived from its long-form issuer or a matching retained peer.resolved document for a short-form issuer; receipt authentication still uses its exact saved references. Neither verification nor a cache rebuild appends an event.

- <a id="dd-51"></a> **DD-51.** A crash before transport and a crash after acceptance but before submission commit expose the same prepared state. Neither proves delivery or nondelivery; manual retry preserves wire ID, package, channel and expiry.

- <a id="dd-52"></a> **DD-52.** Saved `(executionId, effectType)` tuples and intents remain immutable across restore and handler refactoring; neither changes their effect keys or message IDs. Historical input creates no new dispatch action or replacement response channel.

- <a id="dd-53"></a> **DD-53.** Ordinary content, errors and pure ACKs use channel-local identity and their protocol-specific response rules; continuity authorizes exact paths only.

- <a id="dd-54"></a> **DD-54.** Equal-intent observations at different local DIDs have different channels and execution IDs; later links never merge or replay them.

- <a id="dd-55"></a> **DD-55.** A batch cannot authorize its response by proposing new source/endpoint/proof evidence in the same call; prerequisites commit first and links are derived. Invitation consumption is independent of the response.

- <a id="dd-56"></a> **DD-56.** Serialize each message dispatch, require its committed package and consume one live initial/manual action per transport call. Record observed acceptance afterward. Scanning saved events or restarting supplies no action, and one action cannot invoke transport twice.

<a id="binding-resolution-and-sender-eligibility-dd-57-dd-62"></a>

### Binding, resolution and sender eligibility (DD-57–DD-62)

- <a id="dd-57"></a> **DD-57.** Offline intent freezes the actual sender/recipient pair. Even a message with no prepared package is not readdressed after rotation.

- <a id="dd-61"></a> **DD-61.** A reply needs a usable authorized channel before intent commit. Missing sender leaves manual work; later recovery never dispatches it or retargets an existing response.

- <a id="dd-62"></a> **DD-62.** Different local recipient DIDs produce different message/execution IDs. A verified role-preserving successor path may authorize an ACK for an old outbound without merging executions.

<a id="rotation-membership-and-receipt-recovery-dd-63-dd-69"></a>

### Rotation membership and receipt recovery (DD-63–DD-69)

- <a id="dd-63"></a> **DD-63.** An authenticated carrier with its own verified JWT establishes an exact channel link. Later proof-free input authenticates its own exact DID pair and retains channel-local identity; each consumer applies its own evidence and policy requirements.

- <a id="dd-64"></a> **DD-64.** Opposite first sends use the same two canonical DIDs with reversed sender/recipient roles; public/private labels do not change the formula.

- <a id="dd-65"></a> **DD-65.** ACK authorization uses the outbound fixed oriented channel and exact package/path evidence; display preferences never reassign it.

- <a id="dd-66"></a> **DD-66.** Opposite-side links justify their evidence-backed join. Existing queued, prepared and submitted messages all keep their original channels.

- <a id="dd-67"></a> **DD-67.** Superseded peer input remains receivable but creates no new automatic work. Existing intents and results remain historical and duplicates never dispatch old effects.

- <a id="dd-68"></a> **DD-68.** Receipt precedes invitation.consumed and other concrete source-derived work. Only a complete consumption assigns an invitation consumer; all crash prefixes reopen without automatic replies.

- <a id="dd-69"></a> **DD-69.** Missing required immutable issuer material or endpoint/rotation evidence keeps the affected continuity path pending after authenticated receipt and pickup ACK; invitation state does not. Saved authentication is reusable for its original receipt. Failed envelope authentication creates no receipt; recoverable local prerequisites wait and definitive rejection follows the terminal pickup-ACK path.

### Group waits and transition validity (DD-70–DD-71)

- <a id="dd-70"></a> **DD-70.** Incomplete consistent same-channel siblings do not erase a complete witness. A complete observation may witness continuity/confirmation without any handler decision or output intent.

- <a id="dd-71"></a> **DD-71.** Complete witnesses for the same sender/recipient/wire-ID triple with conflicting authenticated intents conflict the execution for every effect type; submission remains complete and different channels are never execution aliases.

### Independent operation recovery (DD-72–DD-75)

- <a id="dd-72"></a> **DD-72.** One Ping requesting ACK may produce three separate intents with distinct effect types: pure ACK, Ping reply and rotation notification. Each type permits at most one compatible intent for that execution. Handler order changes none of their keys; a saved Ping reply does not occupy either other operation's slot, and the two Empty outputs remain independent.

- <a id="dd-73"></a> **DD-73.** Missing optional successor registration or notification preparation does not block an eligible ACK or Ping reply on an authorized usable channel. Their committed channels remain fixed when notification work later completes.

- <a id="dd-74"></a> **DD-74.** Crash after a rotation decision but before notification intent leaves manual work only while the source remains eligible. Supersession of the trigger's peer prevents creating the missing intent; an already committed intent may still be manually dispatched under ordinary restrictions. A source-free manual decision remains subject to send restrictions without a source-peer check. Completion reuses the original trigger, successor and proof; a later input cannot change the notification tuple or allocate another successor.

- <a id="dd-75"></a> **DD-75.** Notification submission does not confirm successor knowledge. Other new successor messages still carry the same proof until exact-address confirmation; committed packages never change afterward.

### Built-in response address selection (DD-76–DD-77)

- <a id="dd-76"></a> **DD-76.** With an eligible carrier local DID, an ACK or Ping reply uses the carrier channel even when a privacy successor already exists. A no-longer-eligible local DID selects only its unique eligible verified local-only successor head; ambiguous or unusable successors create no automatic intent. All equivalent long/short source spellings produce the canonical recipientDid. Handler order, pending registration and temporary network outage do not choose different addresses; existing intents are reused after lifecycle changes.

- <a id="dd-77"></a> **DD-77.** Body erasure leaves complete retained receipt/header evidence eligible for ACK source and target selection. It cannot justify a new Ping reply whose response_requested field is unavailable. Manual completion still requires an explicit action and current policy; erasure or recovery alone dispatches neither output.
