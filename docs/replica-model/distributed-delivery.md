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

An Estoc message begins as a durable intent in one fixed oriented channel.
Phase 1 has one active executor. Channel receipt, local acceptance, directed
continuity, contact membership and dispatch authority are separate facts.

Every actual message transport call follows a committed `delivery.attempted`.
Only the live initial action or a new explicit manual retry may make that call.
Transport acceptance commits `delivery.submitted`, permanently completing that
outbound. A failed/unknown call, missing ACK, process reopen or another replica
does not automatically retry it. A manual retry preserves the exact attempted
package; selecting another channel means a new message ID.

This profile defines intent/package identity, channel-local deduplication,
explicit ACK authorization, process-durable receipt and effect ordering.
Storage, local channel policy and deferred transport/sync extensions retain
their separate owners. It makes no cross-channel or cross-replica exactly-once
business-execution promise.

<a id="terms"></a>

## 2. Terms

- **Channel** — fixed canonical DID pair; each vault supplies its local/peer orientation.
- **Contact** — local names, preferences and selected channel histories with no protocol authority.
- **Full replica** — a writable vault incarnation; phase 1 still has one active executor.
- **Outbound message ID** — one committed intent's entity ID and plaintext `id`.
- **Inbound message ID** — derived from exact channel, authenticated sender and wire ID.
- **Execution ID** — stable identity of one channel-local input; identity alone grants no work.
- **Package ID** — exact encrypted inner envelope identity and Routing `forward.id`.
- **Delivery ID** — mediator pickup identity, separate from message/package IDs.
- **Attempted** — committed evidence that a transport call may have happened.
- **Submitted** — recorded transport acceptance; it is not ultimate receipt.
- **Acknowledged** — accepted explicit peer `ack` naming the exact authorized outbound.
- **Semantic/intent/plaintext hashes** — the projections in section 5; addressing
  is package evidence but the intent's channel is independently immutable.

One message may have pre-attempt preparations within its fixed channel.
All attempts use the first attempted package exactly. Mediator redelivery and
replica fan-out create more observations of those bytes, not new channels or
permission for multiple automatic responses.

<a id="addressing-layers"></a>

## 3. Addressing layers

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

All local communication addresses are vault-scoped. The active full runtime
derives their private keys and receives their messages. Public/private
allocation does not select a different acceptance, sender permission or receive
path. A later server or replica does not own an address merely by executing
the vault. The fixed channel is independent of local/peer orientation;
each message still has a sender and recipient, and every rotation is directed.

Each local communication DID has one immutable `boundRouteId`, mediated or
direct. Changing its keys or bound route creates a successor DID entity;
[local rotation decisions](channels.md#did-rotationselected) select continuation
in an exact channel context; their links are derived.
An external recipient's resolved document may offer transport choices; choosing
among authorized routes does not change the application recipient. A direct
endpoint MUST NOT expose a replica ID as the peer-visible recipient.

The phase-1 mediator uses ordinary account-scoped Message Pickup with one
active pickup client. The deferred `replica-mediation/1.0` extension may later
fan out an already encrypted package without changing the innermost recipient.

A valid `from_prior` justifies one endpoint replacement in its exact channel context.
Unrelated channels using that address retain their own endpoint decisions.

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
- one immutable oriented channel, sender DID and recipient DID selection
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
<a id="91-receive-a-message"></a>
<a id="92-receive-recovery"></a>

### 4.1 Commit and acknowledgment boundaries

| Boundary | Durable prerequisite | Meaning |
| --- | --- | --- |
| Offline send intent | Content and `message.out` with fixed channel/direction | A selected new message, not authority for recovery dispatch |
| Package preparation | Accepted DID pair, operation resolution and `message.prepared` | Recoverable immutable bytes |
| Transport invocation | Prior `delivery.attempted` plus its still-live local action | Exactly one call may occur; the event itself is not replayable work |
| Submission completion | `delivery.submitted` referencing that attempt/package | Stop preparation and sending for this message ID |
| Channel receipt | Current authentication, exact resolution, objects and `message.in` | Normal pickup ACK may follow |
| Proof resolution | Exact carrier plus `message.fromPriorResolved` and its document | Fold can compute proof result and continuity status |
| New source-derived work | Complete source/channel/proof evidence, current policy and the concrete intent/result | No separate per-message admission commit |
| Peer ACK | Complete channel witness and exact channel/path target | Receipt information only |

Every dependency reference names an event committed before the dependent call.
Object storage alone is not event commitment. Contact membership, a thread ID,
peer ACK or a missing submission event never supplies dispatch authority.

<a id="send-an-ordinary-message"></a>

### 4.2 Send an ordinary message

Under the operation lock, normalize content, freeze immutable headers, choose
one concrete sender and recipient, derive their channel and commit `message.out`
with objects. This call does no network work. An explicit user send may select
a new channel; an automatic output requires a complete source/channel witness and
independent authorization for its selected response channel.

The original live initial action may then resolve/register and prepare the
fixed channel. Missing prerequisites may wait locally before the first call.
A manual action can resume an eligible pending intent. The action serializes
this message's work and performs these steps:

1. Recheck completion, expiry, denial, conflict, retained keys/routes and bytes.
2. If already attempted, select that exact package; missing references or bytes
   defer. Otherwise prepare within the intent's fixed channel and commit it.
3. Verify local recipient registration before disclosure when needed.
4. Under the vault lock recheck eligibility and commit `delivery.attempted`.
5. After successful commit returns its event ID, release the vault lock and
   invoke transport once using the exact envelope and package ID.
6. Record transport acceptance as `delivery.submitted` referencing that attempt,
   or terminal failure where proven. Failure/uncertainty grants no next call.

Keep per-message dispatch serialized across this procedure, without holding
the vault lock across network I/O. A commit with uncertain outcome grants no
transport call. A crash after attempt commit consumes the live invocation;
reopen cannot replay it. A fresh manual action records another attempt for the
same exact package. Submitted/terminal messages require a deliberate new send
with a new ID. Rotation and contact preferences never retarget old work.

<a id="receive-a-message"></a>

### 4.3 Receive a message

1. Resolve exact local recipient/key/route eligibility and authenticate the
   current sender under [the gate](relationships.md#hard-pre-vault-gate).
   Missing cryptographic material may require unopened wait.
2. Validate normalized wire fields, supported content and resource limits.
3. Under the lock, commit/reuse exact resolution evidence, then commit content
   and `message.in` with fixed channel and fresh receipt ordinal.
4. Pickup-ACK process-durable receipt independently of channel policy/history.
5. If `from_prior` is present, reuse a complete proof witness or obtain its
   predecessor document and commit `message.fromPriorResolved`. Fold proof
   status and continuity from those facts, then resolve channel acceptance.
   Missing evidence stays pending and visible; receipt grants no implicit
   acceptance. A missing predecessor channel does not prevent saving proof evidence.
6. For each consumer, validate exact source/channel/proof evidence. Before new
   work, recheck supersession, denial and that operation's current policy.
   Commit the concrete intent or local result with already committed references;
   there is no per-message admission event.
7. Process valid explicit peer ACKs and local display/profile projections.
   The sole active executor may independently create an eager ACK, a Ping reply
   and a rotation notification when their individual policies permit. Each
   output commits its fixed-channel intent before dispatch.
8. A retained duplicate creates no new response obligation or dispatch action.

Hard terminal rejection may pickup-ACK without `message.in` under the gate;
failed durable receipt withholds normal pickup ACK. Control types have no
special admission authority and no recursive privacy-response trigger.

<a id="receive-recovery"></a>

### 4.4 Recovery

Rebuild receipts, exact acceptance/proof evidence, local rotation decisions,
invitations, denials, profile
and display projections from retained facts. Saved authenticated input does not
need current sender re-resolution. Links and UI verification states derive
from retained proof snapshots; obtaining missing proof evidence follows the separate
[predecessor resolution rule](relationships.md#predecessor-resolution).
Missing bytes/references remain recovery work. Later validation does not append
another receipt or grant automatic response/notification dispatch. The same
uninterrupted initial receive operation may continue after a prerequisite wait;
reopen, import and a separate evidence-recovery operation have no such action.

Enumerate pending/unconfirmed messages for manual action. Reopen, restore,
import, replica change and duplicate pickup do not dispatch old messages or
recreate old ACK/notification effects for sending. Existing message, execution,
attempt and submission identities never change when history is recovered.
Erased input starts no new effects. Receiving fresh unrelated live input remains
independent. [Channels](channels.md#fixed-outbound-channel) owns dispatch authority.

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

Use `message.out.senderDidId`, the canonical selected recipient and its derived
fixed channel. Resolve first-package freshness under
[the address profile](relationships.md#recipient-resolution-freshness); select
keys authorized by that operation's document in the accepted DID pair. A
method-authorized update may change keys or service without changing the channel
or its acceptance. An explicit user-authored outbound may establish that
acceptance. Automatic output cannot authorize itself.

Construct the complete plaintext from immutable intent: conditional nullable
timestamps/threads, exact `pleaseAck`, frozen `ack`, supported headers, body and
ordered attachments. `from`/`to`, exact key methods and any frozen proof follow
that fixed channel's evidence. The wire ID equals the outbound message ID.
Reject forbidden `return_route`, duplicate JSON members and invalid I-JSON.
Canonicalize with RFC 8785, encrypt through maintained DIDComm APIs, then commit
the exact normalized envelope and `message.prepared` before transport.

Pre-attempt preparation may replace a package only inside this fixed channel
with retained valid evidence. Once any attempt references a package, every
manual retry uses its exact plaintext, ciphertext, proof, spelling, package ID
and envelope CID. Missing evidence blocks replacement. Later confirmation,
rotation or document resolution does not rewrite it. Another channel requires
a new explicit send with a new wire ID.

<a id="submission-completion-and-expiration"></a>

## 7. Submission completion and expiration

Any valid committed submission completes the entire message. It prevents new
preparation and every retry, regardless of ACK policy. Missing submission does
not establish nondelivery or authorize automatic recovery. Attempted-unconfirmed
and restored queued/prepared messages require manual action.

Expiry stops new work at equality and records message-terminal failure when
observed before preparation/dispatch. It does not overwrite an already recorded
submission. Later ACK evidence can report receipt without reopening anything.
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

Before creating an ACK intent, require a complete channel witness,
non-erased eligible source and an authorized usable local sending channel.
The channel can be the carrier's channel or its verified role-preserving
successor. An unrelated channel in the same contact is never a substitute. If no
eligible sender exists, preserve the input for manual action; do not commit
an incomplete response or automatically dispatch it after a later restore.

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
have complete channel-witness evidence from the same peer direction in this
channel or an authorized predecessor channel. Validate the exact path,
authentication and requesting peer; no vault-global wire-ID match or display
group grants a target.
If multiple otherwise eligible channel inputs with that wire ID are ambiguous,
omit it. The current carrier can identify itself by its exact source.

Sort eligible targets by their minimum complete receipt key, then freeze their
wire IDs in one output. Unknown, conflicted, erased or unauthorized targets are
omitted and later discovery cannot change the saved array. Generic replies use
`thid = carrier.thid ?? carrier.wireMessageId`, copy nullable `pthid`, and follow
the producing protocol's response rules. No-response errors still do not reply.

Send the ACK as its own Empty message once its prerequisites are ready. Do not
wait for, attach it to, or consume the tuple of a natural reply or rotation
notification. Those outputs may coexist with this intent. Built-in Ping replies
and rotation notifications have `ack == []`; another application protocol may
define its own explicit ACKs subject to the same target checks. There is no
cross-handler limit of one ACK-bearing output. Control input may supply ACK
observations but cannot trigger recursive privacy notifications. Never request
an ACK for a pure ACK, or answer a pure ACK with another pure ACK. Every output
follows normal attempt/submission boundaries; duplicates grant no resend action.

<a id="deterministic-pure-ack"></a>

### 8.2 Deterministic pure ACK

```text
handlerId  = https://estoc.dev/distributed-delivery/1.0#pure-ack
effectKind = pure-ack
ordinal    = 0
```

Copy the carrier's normalized nullable creation time; expiry is null. Body is
`{}`, attachments empty, `pleaseAck` null and `headers` empty. Threads and ACK
targets follow section 8.1. This tuple is only for a pure ACK; a rotation
notification uses its own tuple under section 11. Freeze the selected output
channel at intent commit.

The executable fixture uses channel `88a41cd6-a196-52a4-87df-7ce060e7d373`,
authenticated sender `did:web:bob.example` and wire ID
`019b1b61-3444-7190-9db5-1cc9c215eb23`:

```text
executionId = 07e2f712-1880-56c9-9ad6-914f5014b101
effectKey = -KB2EWusNRJSTOTRKOhBSWSgl715YRd2L0UQ051TYJI
outbound message ID = wire ID = 83f41bfc-7758-576d-bde2-9d0ec2ca97c2
```

These values follow the channel execution transcript and unchanged effect-key
algorithm below. They replace the retired relationship-root fixtures.

<a id="applying-ack"></a>

### 8.3 Applying `ack`

Require an explicit wire ID and one complete channel witness. Find the exact
outbound intent/package, then verify that the carrier's channel is the same
or an authorized role-preserving successor of its fixed channel. The carrier's
sender must be the original peer or its verified replacement and its recipient
the original local endpoint or its verified local successor. Undirected graph
connectivity, group membership, threads and ordinary responses are insufficient.

All redundant witness fields must come from one complete source row. Missing
path/authentication/package references defer the acknowledgment. The carrier's
key need not equal the old package's recipient key: a same-DID document update
is authorized by the carrier's own current authentication evidence. The
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

For authenticated input, canonicalize the sender and actual local recipient,
derive their channel, then compute:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v2", "authenticated", channelId, canonicalSenderDid, wireMessageId])
)
```

Keys and source event IDs remain exact authentication evidence. Different
authorized keys under different method-valid snapshots can represent the same
channel input; document updates create no new deduplication scope.
Opposite sender directions cannot collide merely by choosing the same wire ID.
For truly anonymous input, retain the independent observation-only derivation:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v1", "anonymous", localKeyName, wireMessageId])
)
```

For channel `88a41cd6-a196-52a4-87df-7ce060e7d373` and sender
`did:web:bob.example`, the naming vectors are:

| wireMessageId | messageId | executionId |
| --- | --- | --- |
| `019b2a70-f225-721c-835f-67175be0667e` | `48f06965-e381-55ac-b4ad-e2c1f073d4b3` | `08b42540-d5dc-534f-876a-b9c80e20b18a` |
| `019b1b61-3444-7190-9db5-1cc9c215eb23` | `8f5875a2-a9e5-59f6-978c-bcce5ee11dc8` | `07e2f712-1880-56c9-9ad6-914f5014b101` |

These are identifier fixtures, not authentication/proof fixtures.

<a id="execution-scope-and-commit-prerequisites"></a>

### Execution prerequisites

A deterministic ID supplies no authority by itself. Each operation validates
its complete source, channel acceptance and required proof evidence under
[operation eligibility](channels.md#operation-eligibility). Any link is computed
by the fold. New automatic work additionally requires current policy and live
initial/manual authority. ACK observations validate their target/path directly.
Anonymous and mediator-control input have no application execution. A batch
cannot authorize its own output by proposing source/channel/proof evidence
together with it.

<a id="address-chains-and-observation-membership"></a>

### Source observations

Validate each source's actual channel against the accepted DID pair and its
authentication against its own snapshot under [channels.md](channels.md#operation-eligibility). Equal intent in
one channel/sender/wire-ID input shares one execution. Incompatible authenticated
intent conflicts; incomplete consistent siblings do not erase a complete witness.
Another channel stays separate, even when a later verified link connects it.
No graph root, minimum component ID or contact enters identity.

<a id="execution-id-and-immutable-transcript"></a>

### Execution ID

```text
executionId = UUIDv5(
  estocNamespace("message-execution"),
  RFC8785(["v3", {"channel": channelId, "sender": canonicalSenderDid}, wireMessageId])
)
```

Use the literal transcript members `channel` and `sender`. Namespace derivation
is in [vault-events.md](vault-events.md#entity-ids-and-reproducible-uuidv5-namespaces).
The event schema member names are not substitutes for these transcript tags.

<a id="local-rotation-scope-vector"></a>

### Rotation and message identity

Changing either endpoint produces another channel and another inbound/execution
ID. The old observation and its effects remain unchanged. Retrying an existing
outbound does not make this change; only a new send can select the new channel.
The earlier cross-address alias fixture is retired. ACK authorization may still
follow verified successor paths for an exact old message; that path does not
merge the ACK carrier and the acknowledged message into one execution.

<a id="first-contact-and-address-policy"></a>

## 10. First contact and address policy

Useful content or Trust Ping can be the first ordinary DIDComm message.
No Estoc handshake, contact ID or private-address requirement is
introduced. Channel acceptance follows explicit local policy or verified links.
Optional early privacy rotation creates a new channel for new output, never
rewrites an old message. See [the address policy](relationships.md).

<a id="automatic-effects"></a>

## 11. Automatic effects

An automatic DIDComm output is one effect identified by
`(executionId, handlerId, effectKind, ordinal)`. `executionId` MUST equal the
derived execution ID of one complete, conflict-free logical carrier after the
channel-local evidence and intent checks in [vault-events.md section 10.6](vault-events.md#inbound-message-and-execution-fold).
Independently validated observations of that channel, sender and wire ID that
disagree on the intent constitute an execution conflict under that section.
An unresolved or conflicting sibling observation cannot clear that
disagreement merely by making its group ineligible. One complete group
cannot authorize automatic work while the execution conflict exists. Each protocol
MUST define its handler ID, effect kind, stable non-negative integer ordinal
and output intent rules. Distinct operations have independent tuples; none
claims a shared reply slot or blocks another merely by producing an ACK.
Handler IDs and kinds are non-empty strings without
U+0000; `decimalOrdinal` is `0` for zero, otherwise decimal digits without
leading zeros.
Retries MUST NOT change the tuple to create another effect or evade a
conflict. Selecting a different handler, effect kind or ordinal cannot
bypass a conflict of the carrier's execution ID.

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

Under the operation lock in [event-store.md section 10](event-store.md#vault-interface),
check the specific operation's source, current policy and usable authorized
sender. Derive its tuple and look up its message ID before freezing targets,
timing, channel or other fields. Reuse an existing non-conflicted intent; do not
regenerate it after submission, source erasure, another observation or a changed
clock. Source and channel evidence references are retained directly in the
[intent](vault-events.md#message-out), with no separate message admission commit.
Missing evidence or sender leaves that operation pending without blocking
another independently eligible operation.

ACKs and rotation notifications are eager standalone Empty messages. A Ping
response or another natural protocol response does not carry either operation
on its behalf. Each may be selected and committed independently from the same
source. Arrival, dependency completion or handler order does not merge their
tuples. This draft uses separate messages, without a combined-output optimization.

Only eligible live input may automatically create an initial inbound-derived
intent. Historical input can expose individual unfinished operations for
explicit manual completion using the same tuples. Every new intent commits
through `Vault.commit` before network effects. Existing intents form a pending
work view; no separate persistent queue is required. Having an intent alone
grants no dispatch action. Derivation, lookup and commit are one locked operation;
all source/channel/proof dependencies must already be committed.
A conflicting local intent is rejected before append; imported conflicts remain
history and suppress work under [vault-events.md section 9.8](vault-events.md#outbound-message-and-delivery-fold). Duplicate
carriers never grant a dispatch action under section 8.4.

Other external effects MUST commit their protocol-defined portable intent
before execution and use that protocol's idempotency or explicit at-least-once
contract. The message fold does not validate those payloads.

Phase 1 has one active writer but still makes no process-level exactly-once
claim. A future multi-writer profile must coordinate automatic execution before
claiming stronger behavior.

<a id="built-in-independent-operations"></a>

### Built-in independent operations

| Operation | `handlerId` | `effectKind` | `ordinal` |
| --- | --- | --- | --- |
| Requested receipt ACK | `https://estoc.dev/distributed-delivery/1.0#pure-ack` | `pure-ack` | `"0"` |
| Trust Ping reply | `https://didcomm.org/trust-ping/2.0` | `ping-response` | `"0"` |
| Inbound-triggered rotation notification | `https://estoc.dev/distributed-delivery/1.0#rotation-notification` | `rotation-notification` | `"0"` |

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
unchanged peer from its predecessor acceptance. Packaging carries that decision's
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
another successor. A missing notification is manual work under the current
dispatch profile, not authority for automatic replay.

<a id="required-vault-observations"></a>

## 12. Required vault observations

```text
message.out                fixed channel and immutable intent
message.prepared           exact selected envelope
message.packageRetired     package no longer eligible
delivery.attempted         one live action may have invoked transport
delivery.submitted         exact attempt observed transport acceptance
delivery.failed            terminal package/message failure
delivery.acknowledged      exact authorized peer receipt observation
message.in                 independent authenticated channel receipt
message.fromPriorResolved  exact issuer-document association for a received proof
did.rotationSelected       local successor and frozen proof selected before sending
channel.accepted           local DID-pair acceptance with decision evidence
channel.blocked            local channel/successor denial
```

Continuity links and verification status are fold results, not events.
Contact events are not delivery observations. Schemas and folds
are owned by [vault events](vault-events.md) and [channels](channels.md).

<a id="failure-rules"></a>

## 13. Failure rules

- Before intent commit, no message exists. A failed/uncertain commit grants no send.
- After intent/preparation but before any attempt, reopen still requires manual
  action; absence of an attempt in an old snapshot does not prove nondelivery.
- After attempt commit but before transport, crash leaves an unconfirmed attempt
  and no live permission to invoke it. It may never have left the process.
- After acceptance but before submission commit, crash also leaves unconfirmed
  history. Manual retry may deliver duplicate bytes; channel-local dedup applies.
- After submission commit, no retry or replacement preparation is allowed.
- After rotation, old intents/packages remain in their fixed channels. If that
  channel becomes unusable, a deliberate new send has a new wire ID.
- After receipt but before pickup ACK, redelivery is another same-channel
  observation. Receipt commit still permits pickup ACK independently of policy.
- After receipt/acceptance but before a reply, recovery preserves local state
  and pending work without automatically sending ACKs, replies or notifications.
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
A future replica-mediation profile
would additionally expose opaque replica IDs to that mediator.

A disclosed rendezvous DID is intentionally correlatable within its audience.
Pairwise DIDs SHOULD be disclosed only in encrypted messages and use
Peer DID long form on first disclosure.

Pure ACKs reveal durable receipt timing to the ultimate peer, not which
replica received first. Implementations SHOULD NOT encode contact names,
replica labels, event IDs or content in peer- or mediator-visible IDs.

<a id="required-conformance-cases"></a>

## 15. Required conformance cases


<a id="intent-and-immutable-packaging-dd-1-dd-12"></a>

### Intent and immutable packaging (DD-1–DD-12)

1. <a id="dd-1"></a> `message.out` commits with all networking disabled.
2. <a id="dd-2"></a> A peer addresses a communication DID, never a replica or contact ID.

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
11. <a id="dd-11"></a> Rotation cannot change any existing message channel. Pre-attempt replacement stays in that channel; after an attempt every retry uses the exact package.

12. <a id="dd-12"></a> Body, type, thread, attachment, timing, ACK policy or additional-header
    changes under one wire ID produce an intent conflict.

<a id="submission-and-acknowledgment-dd-13-dd-22"></a>

### Submission and acknowledgment (DD-13–DD-22)

13. <a id="dd-13"></a> Transport acceptance records submitted with the exact prior attempt reference, never ultimate acknowledgment.

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
19. <a id="dd-19"></a> The channel pure-ACK fixture derives execution 07e2f712-1880-56c9-9ad6-914f5014b101, effect -KB2EWusNRJSTOTRKOhBSWSgl715YRd2L0UQ051TYJI and wire ID 83f41bfc-7758-576d-bde2-9d0ec2ca97c2.

20. <a id="dd-20"></a> One carrier that requests current and older known IDs freezes one ordered
    deduplicated ACK target set; unknown targets arriving later do not mutate
    the response effect.
21. <a id="dd-21"></a> A valid ACK before submitted adds receipt information only; manual action is still required for another exact-package attempt.

22. <a id="dd-22"></a> Duplicate input reuses its frozen response state but never dispatches it; submitted/collected responses cannot be recreated.

<a id="scope-aliases-and-conflicts-dd-23-dd-30"></a>
<a id="scope-observations-and-conflicts-dd-23-dd-30"></a>

### Channel observations and conflicts (DD-23–DD-30)

23. <a id="dd-23"></a> Authorized key variants within one channel/sender/wire-ID input converge; inconsistent authenticated intent conflicts.

24. <a id="dd-24"></a> Equal wire IDs in different channels do not merge, even through verified links. Same-channel authorized variants share one execution.

25. <a id="dd-25"></a> Missing channel acceptance/link evidence defers that observation; later evidence grants only its channel-local execution and no recovery dispatch.

26. <a id="dd-26"></a> Contradictory channel identity evidence or authenticated intent suppress new effects; contact edits cannot resolve them and ordinary document updates do not cause them.

27. <a id="dd-27"></a> Control input with a complete channel witness may supply authorized ACK evidence without creating contacts or recursive privacy notifications; its type grants no admission.

28. <a id="dd-28"></a> Invalid carried proof prevents acceptance/link/ACK effects; independent authentication can still retain receipt and failed unpack creates none.

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
    exact predecessor verification document, without requiring byte equality with presentedDid.
35. <a id="dd-35"></a> New unconfirmed successor packages include frozen proof/long form; attempted packages never change after confirmation.

36. <a id="dd-36"></a> Direct and mediated traffic use the same channel receipt/acceptance folds; only mediated traffic has pickup ACK.

37. <a id="dd-37"></a> Crashes before/after a transport call or before submission commit reopen without automatic sending; manual retry preserves the exact attempted package.

38. <a id="dd-38"></a> Phase 1 works with one active full runtime and ordinary account-scoped
    Message Pickup; replica fan-out is not required.
39. <a id="dd-39"></a> Exact channel acceptance precedes preparation; complete source/channel and carried-proof evidence precedes dependent automatic intents. No per-message admission event is required.

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
43. <a id="dd-43"></a> ACK targets require exact same-channel or verified role-preserving successor authorization; shared contacts and wire IDs alone supply none.

44. <a id="dd-44"></a> ACK target order uses the minimum complete receipt key, not canonical event
    order or EventStore change order; a clock rollback between two receives
    does not reverse their ACK order in a linear history.
45. <a id="dd-45"></a> Submitted completion survives restart, loss of local state, clock rollback,
    package retirement and envelope collection. Later duplicate input cannot
    reopen submission or require the collected envelope.
46. <a id="dd-46"></a> If one of several valid packages for a message ID is submitted, every package of
    that message ID stops work; selecting another package, route or handler cannot
    bypass completion.
47. <a id="dd-47"></a> Generic pure ACK copies carrier pthid and nullable creation time. An Empty rotation notification uses a distinct fixed tuple, empty ack array and its own ACK request; one input may produce both intents.
48. <a id="dd-48"></a> Reopen reconstructs channel-local execution IDs independently of contacts and grants no dispatch permission.

49. <a id="dd-49"></a> An unsubmitted package survives route unavailability and GC with its exact
    envelope. Committed submission or terminal failure releases its contribution
    under the retention fold; route recovery cannot reopen submitted work.

<a id="recovery-and-automatic-effects-dd-50-dd-56"></a>

### Recovery and automatic effects (DD-50–DD-56)

50. <a id="dd-50"></a> Recovery exposes incomplete acceptance/proof and pending response work from retained data, without dispatching protocol output or requiring redelivery. A new proof verification may resolve its predecessor; existing receipt/link verification uses saved evidence.

51. <a id="dd-51"></a> Outcome-unknown calls remain unconfirmed after crash; manual retry preserves wire ID, package, channel and expiry.

52. <a id="dd-52"></a> Saved automatic tuples/intents remain immutable across restore; historical input creates no new dispatch action or replacement response channel.

53. <a id="dd-53"></a> Ordinary content, errors and pure ACKs use channel-local identity and their protocol-specific response rules; continuity authorizes exact paths only.

54. <a id="dd-54"></a> Equal-intent observations at different local DIDs have different channels and execution IDs; later links never merge or replay them.

55. <a id="dd-55"></a> A batch cannot authorize its response by proposing new source/acceptance/proof evidence in the same call; prerequisites commit first and links are derived.

56. <a id="dd-56"></a> Serialize each message dispatch, commit its attempt before transport and its observed acceptance afterward. A crash consumes that live invocation and recovery cannot replay it.

<a id="binding-resolution-and-sender-eligibility-dd-57-dd-62"></a>

### Binding, resolution and sender eligibility (DD-57–DD-62)

57. <a id="dd-57"></a> Offline intent freezes actual channel/sender/recipient. Even a never-attempted message is not readdressed after rotation.

58. <a id="dd-58"></a> A valid same-DID key/service update preserves channel acceptance. An ACK carrier can authenticate with the new key and acknowledge an old-key package; exact historical package evidence is unchanged.

59. <a id="dd-59"></a> Independently authorized keys across document revisions share channel-local input identity; an unauthorized key contributes no acceptance or authenticated intent conflict.

60. <a id="dd-60"></a> A new non-numalgo-4 message ID resolves and commits current recipient evidence
    before first preparation. Transient unavailability leaves it retryable;
    definitive resolution failure is terminal under [relationships.md section 10.1](relationships.md#did-resolution-requirements). An unchanged online-revalidated document still creates new evidence.
    Attempted packages retry manually with exact bytes; pre-attempt preparation
    remains in the fixed channel using retained snapshots. Whenever
    an inbound delivery enters or resumes authentication, including duplicates,
    it uses current sender resolution; unavailability defers without pickup ACK
    only within that section's per-delivery budget. Definitive DNS failures
    and exhausted retries take the terminal pre-vault ACK path; redelivery
    cannot reset the active sequence. Recoverable local prerequisite waits
    consume no budget. Unopened cryptographic waits use that section's
    suspension and fresh-sequence rule. Post-receipt channel acceptance recovery
    consumes no sender-resolution attempts.
    Reusing matching evidence requires a fresh document check. Recovery of
    committed input uses its retained snapshot without another network lookup.
61. <a id="dd-61"></a> A reply needs a usable authorized channel before intent commit. Missing sender leaves manual work; later recovery never dispatches it or retargets an existing response.

62. <a id="dd-62"></a> Different local recipient DIDs produce different message/execution IDs. A verified role-preserving successor path may authorize an ACK for an old outbound without merging executions.

<a id="rotation-membership-and-receipt-recovery-dd-63-dd-69"></a>

### Rotation membership and receipt recovery (DD-63–DD-69)

63. <a id="dd-63"></a> A proof establishes an exact channel link without a component root. Later proof-free input uses that channel acceptance and retains channel-local identity.

64. <a id="dd-64"></a> Opposite first sends derive one fixed channel with separate sender directions; public/private labels do not change the formula.

65. <a id="dd-65"></a> ACK authorization uses the outbound fixed oriented channel and exact package/path evidence; display preferences never reassign it.

66. <a id="dd-66"></a> Opposite-side links justify their evidence-backed join. Existing queued, attempted and submitted messages all keep their original channels.

67. <a id="dd-67"></a> Superseded peer input remains receivable but creates no new automatic work. Existing intents and results remain historical and duplicates never dispatch old effects.

68. <a id="dd-68"></a> Receipt precedes channel acceptance and concrete source-derived work. Matching channel acceptance consumes its invitation; all crash prefixes reopen without automatic replies.

69. <a id="dd-69"></a> Missing predecessor acceptance or verification snapshots keep continuity pending after authenticated receipt. Saved authentication is reusable; failed unpack still withholds receipt/ACK.

### Group waits and transition validity (DD-70–DD-71)

70. <a id="dd-70"></a> Incomplete consistent same-channel siblings do not erase a complete witness. A complete observation may witness continuity/confirmation without any handler decision or output intent.

71. <a id="dd-71"></a> Complete same-channel/sender/wire-ID witnesses with conflicting authenticated intents conflict the execution under every handler tuple; submission remains complete and different channels are never execution aliases.

### Independent operation recovery (DD-72–DD-75)

72. <a id="dd-72"></a> One Ping requesting ACK may produce three separate intents: pure ACK, Ping reply and rotation notification. Handler order changes none of their tuples; a saved Ping reply does not occupy either other operation's slot.

73. <a id="dd-73"></a> Missing optional successor registration or notification preparation does not block an eligible ACK or Ping reply on an authorized usable channel. Their committed channels remain fixed when notification work later completes.

74. <a id="dd-74"></a> Crash after a rotation decision but before notification intent leaves manual work. Completion reuses the original trigger, successor and proof; a later input cannot change the notification tuple or allocate another successor.

75. <a id="dd-75"></a> Notification submission does not confirm successor knowledge. Other new successor messages still carry the same proof until exact-address confirmation; saved attempted packages never change afterward.
