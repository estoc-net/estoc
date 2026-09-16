# Estoc channel address and display policy 1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — ordinary DIDComm channels, discovery and
early private-address allocation for one active writable vault runtime.
Multi-replica mediation and vault synchronization are deferred.

This document uses **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**
and **MAY** as described in BCP 14 when they appear in all capitals.

There is no Estoc rendezvous wire protocol, connection request, accept or
decline. Messages use ordinary DIDComm protocols. Channel acceptance is independent of public/private address allocation.
Address-change evidence derives a channel-local `from_prior` link; relationships are
display groups under [channels.md](channels.md#display-relationships).

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Understand channels and display | [Model](#what-it-is-for) → [Identifiers](#symmetric-relationship-identity) → [Peer address changes](#peer-address-changes) |
| Implement authentication and receipt | [Receipt gates](#uniform-receipt) → [Receive procedure](distributed-delivery.md#receive-a-message) → [Resolution and retry rules](#did-resolution-requirements) → [Peer DID profile](#peer-did-numalgo-4-profile) |
| Implement address policy | [Discovery](#out-of-band-discovery) → [Select a channel](#ordinary-sending-and-birth-selection) → [Early privacy and notification](#early-private-address-policy-and-notifications) → [Retry and rollover](#retry-replacement-and-address-rollover) |

<details>
<summary>Contents</summary>

- [1. What it is for](#what-it-is-for)
- [2. Dependencies](#dependencies)
- [3. Terms](#terms)
- [4. Invariants](#invariants)
- [5. Channel and display identifiers](#symmetric-relationship-identity)
- [6. Out-of-band discovery](#out-of-band-discovery)
- [7. Address lifecycle](#address-lifecycle)
- [8. Ordinary sending and channel selection](#ordinary-sending-and-birth-selection)
- [9. Uniform receipt](#uniform-receipt)
- [10. DID profiles and resolution evidence](#did-profiles-and-resolution-evidence)
- [11. Early private-address policy and notifications](#early-private-address-policy-and-notifications)
- [12. Peer address changes](#peer-address-changes)
- [13. Remote errors and integrity failures](#remote-errors-and-integrity-failures)
- [14. Retry, replacement and address rollover](#retry-replacement-and-address-rollover)
- [15. Phase-1 execution and deferred replication](#phase-1-execution-and-deferred-replication)
- [16. Privacy, abuse, interoperability and security](#privacy-abuse-interoperability-and-security)
- [17. Required conformance cases](#required-conformance-cases)

</details>
<!-- reading-guide:end -->

<a id="what-it-is-for"></a>

## 1. What it is for

A fixed channel records communication between two DIDs. Verified links connect
channels when one endpoint rotates. The original message stays in its actual
channel and no cryptographic relationship root or stable graph-component ID
exists. [Channels](channels.md#model) owns that model.

Public/rendezvous and pairwise describe disclosure and allocation policy, not
different message schemas or receipt permissions. A shared DID can participate
in several channels; a local continuity decision does not change all of them.
Useful content may be the first message. Trust Ping is the no-content default.
Display relationships and contacts organize history without protocol authority.

<a id="dependencies"></a>

## 2. Dependencies

A conforming implementation uses:

- DIDComm Messaging 2.1;
- Out-of-Band 2.0 (`https://didcomm.org/out-of-band/2.0`);
- Trust Ping 2.0 (`https://didcomm.org/trust-ping/2.0`);
- Empty Message 1.0 (`https://didcomm.org/empty/1.0`);
- Report Problem 2.0 (`https://didcomm.org/report-problem/2.0`) when a
  remote Report Problem response is received;
- Routing 2.0 (`https://didcomm.org/routing/2.0`);
- Peer DID Method numalgo 4;
- RFC 8785 JSON Canonicalization Scheme;
- `distributed-delivery/1.0`; and
- [vault-events.md](vault-events.md).

Phase 1 uses ordinary Coordinate Mediation and account-scoped Message Pickup
when a mediator is used. `replica-mediation/1.0` and `vault-sync/1.0` are
informative deferred extensions, not dependencies of this profile.

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only.

<a id="terms"></a>

## 3. Terms

- **Communication address** — a supported canonical DID with retained keys
  and routing evidence; local DIDs are seed-derived numalgo-4 entities.
- **Channel** — a fixed pair of distinct canonical DIDs with vault-local orientation.
- **Acceptance** — a durable local decision to use a DID-pair channel, with exact evidence of that decision.
- **Continuity link** — a fold-derived, verified replacement of one endpoint in one channel context.
- **Relationship** — a display group of channels or channel chains.
- **Application input** — accepted authenticated input other than control input,
  Empty, Trust Ping ping-response or Report Problem for privacy-trigger purposes.
- **Rotation notification** — an ordinary new message disclosing a selected local rotation.
- **Rotation confirmation** — complete authenticated input proving knowledge of
  the exact successor in its validated channel context; it is not a peer ACK.

<a id="invariants"></a>

## 4. Invariants

1. Channel identity is symmetric; message identity additionally includes sender direction.
2. Authenticate before receipt; accept channel evidence before application effects.
3. Receipt never creates a display relationship or silently accepts a channel.
4. A verified link has exact channel context and never globally aliases DIDs.
5. Opposite-side rotations may form a verified join; competing same-side successors conflict.
6. Missing evidence is pending, never an arrival-order election or permission fallback.
7. Every outbound freezes its channel when intent commits; rotation affects new intents only.
8. Every transport attempt has a prior committed attempt record and a live dispatch action.
9. Import, reopen and replica change never automatically send old work.
10. Manual retry preserves the attempted package; a new channel needs a new message ID.
11. Display grouping grants no ACK, key, invitation or execution authority.
12. Phase 1 has one active executor; peers address DIDs, never replica or display-group IDs.

<a id="10-symmetric-relationship-identity"></a>
<a id="symmetric-relationship-identity"></a>

## 5. Channel and display identifiers

The former symmetric relationship-root derivation is retired. Fixed channel
IDs use [the channel formula and vectors](channels.md#channel-identity).
Explicit display relationships use UUIDv7; a UI's automatic grouping may change
when new graph evidence arrives, without changing protocol identities.

<a id="101-contact-ids"></a>
<a id="contact-ids"></a>

### 5.1 Contact IDs

Contacts use UUIDv7. Create or assign a contact only by explicit product policy;
it may retain an unverified discovery DID before channel acceptance. Neither
that decision nor matching names or keys establishes channel authority.
No root-derived automatic contact or private-DID identifier is required.

<a id="102-binding-and-contact-policy"></a>
<a id="binding-and-contact-policy"></a>

### 5.2 Acceptance and display policy

`channel.accepted` records a DID pair, decision-time evidence and its manual, outbound,
invitation or verified-link basis under [channels.md](channels.md#admission).
Opposite first sends can select the same channel without role arbitration.
The accepted pair remains usable across method-authorized document updates;
each operation retains its own verification snapshot.

`relationship.channelsSet` and `relationship.contactAssigned` organize display.
They do not accept messages, consume invitations, continue channels or authorize
new sends. Deleting a contact is presentation state; a product action that also
blocks communication must append concrete channel denials separately.

<a id="out-of-band-discovery"></a>

## 6. Out-of-band discovery

OOB, QR, directory, file, NFC or manual exchange discloses an ordinary address.
Reusable discovery SHOULD use a public-contact address. An OOB ID supplies
`pthid`, never channel identity. `did.disclosed.admitChannel` records whether
that local invitation permits automatic channel acceptance. False requires
manual acceptance. Profile/direct disclosure cannot grant this permission.

A one-use invitation is consumed by matching durable channel acceptance under
[the invitation fold](vault-events.md#invitation-fold), independently of reply
or display work. Plain receipt does not consume it. Deletion, erasure and
later conflicts do not reopen it. Different channel consumers conflict.

<a id="address-lifecycle"></a>

## 7. Address lifecycle

`did.created`, `did.disclosed` and `did.retired` retain their local key/route
semantics. Retirement blocks new sending, disclosure and acceptance. Exact
retained keys may receive while their routes remain eligible. Explicit route
or mediation retirement stops transport; temporary outage remains recoverable.

Rotation is a channel link, not global address retirement. Keep old and new
recipient routes through exact-successor confirmation. It changes selection
for newly created intents only. An existing fixed-channel message never moves
to the successor; explicit key/route retirement can make its retry impossible.
New old-peer inputs received after verified supersession are saved but refused
application acceptance under [channels.md](channels.md#continuity).

<a id="ordinary-sending-and-birth-selection"></a>

## 8. Ordinary sending and channel selection

The send API selects one exact oriented channel before committing intent.
An explicit address choice can start a new channel without a wire handshake.
A contact/group selection must resolve to a concrete eligible channel; display
membership supplies no authentication authority. Verified successors may guide
this new selection. An existing intent's selection is immutable.

<a id="ordinary-sending-requirements"></a>

### 8.1 Common requirements

All messages follow DIDComm authentication, exact recipient-method checks and
the ordinary content/header rules in [distributed-delivery.md](distributed-delivery.md). There is no
initial-specific size, message-type, age or lifetime acceptance policy. Hard
parser/resource limits and integrity checks remain. Missing `please_ack` or
`response_requested == false` does not prevent durable receipt; acceptance follows local policy.

<a id="default-trust-ping"></a>

### 8.2 Default Trust Ping

When no application content is ready, send an ordinary Trust Ping:

```json
{
  "type": "https://didcomm.org/trust-ping/2.0/ping",
  "id": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "from": "did:peer:4zQm...bob-long:z...input",
  "to": ["did:peer:4zQm...alice-short"],
  "body": { "response_requested": true }
}
```

A false `response_requested` prohibits `ping-response`. It does not prohibit
a separate address-change notification under section 11, whose purpose is
disclosing a locally selected rotation. Receipt alone does not request an ACK.

<a id="content-first-communication"></a>

### 8.3 Content-first communication

Any supported application protocol may be the first message, including Basic
Message, with its normal body, thread and attachment semantics. No rendezvous
wrapper, extra wire relationship field or preliminary handshake is required.
Content remains application content regardless of whether a rotation is carried.

<a id="select-addresses-and-commit-intent"></a>

### 8.4 Select addresses and commit intent

1. Select a live local DID and canonical peer DID, validating supplied Peer long forms.
2. Derive their fixed channel and direction. Reuse a complete channel acceptance
   when present; each later preparation still resolves its own peer evidence.
3. Commit content and `message.out` with this channel, sender and recipient.
   This offline action does no DNS, mediator or socket work.

<a id="prepare-and-send"></a>

### 8.5 Prepare and send

1. Require a live initial dispatch action or an explicit manual action, and
   recheck completion, expiry, denial, conflict and local lifecycle.
2. For first preparation, resolve the fixed peer and retain its evidence. An
   explicit user send may establish channel acceptance with `basis: outbound`.
3. Prepare only in the intent's fixed channel. Once attempted, reuse its exact
   package; missing bytes wait rather than causing replacement encryption.
4. Verify required recipient registration, commit `delivery.attempted`, then
   make one transport call. Record `delivery.submitted` on acceptance.
5. Failure or uncertain outcome leaves manual work. Opening, importing,
   duplicate input and rotation do not dispatch it. Changing channel creates
   a new user-authored message and wire ID.

See [dispatch authority](channels.md#fixed-outbound-channel).

<a id="uniform-receipt"></a>

## 9. Uniform receipt

<a id="deferred-delivery"></a>

### 9.1 Deferred delivery

Pre-receipt waits concern only the ability to identify the exact local
key-agreement method, recover local key/document/route state, safely open the
envelope, authenticate the current sender, or commit durable channel evidence.
Locked/incomplete recovery is not evidence that a recipient is foreign.
Current-sender resolution follows section 10.1's bounded retry rules; other
recoverable cryptographic/local prerequisites suspend its active budget.

[channels.md section 3.1](channels.md#receipt) governs a DIDComm library that
cannot authenticate a carrier without predecessor material. Failed unpack
supplies no authenticated observation or pickup ACK. Missing channel
acceptance or continuity by itself is not a pre-receipt wait.

After durable `message.in`, missing channel acceptance, continuity evidence, invitation
decisions or scope evidence becomes upper-layer recovery work. It withholds
effects and ultimate ACKs, not pickup ACK. Recovery reads the saved evidence;
it does not restart sender resolution for an already committed observation.
Timeout, reconnect, a new wire ID and erased bodies grant no channel acceptance.

Local wait state for an unopened delivery is runtime scheduling state. Retry
when its actual cryptographic/local prerequisite changes; unrelated evidence
does not retry it. Redelivery while that wait is retained does not restart
authentication. Loss of that local state re-enters ordinary authentication
with one shared bounded sequence when resolution is required. Such waits have
no client age cap and consume no sender-resolution budget. Mediator expiry
may remove that delivery but cannot erase portable channel or continuity
evidence already committed.

<a id="hard-pre-vault-gate"></a>

### 9.2 Hard pre-vault gate

Recipient classification begins before decryption once section 9.1 says local
key state is authoritative. An exact local key-agreement method is eligible
for receipt when its DID/key mapping is valid and conflict-free, its bound
route has no terminal dependency. DID retirement does not remove a retained
exact key from channel receipt eligibility; acceptance or display membership is not read. Missing
recoverable prerequisites defer under section 9.1. If no recipient `kid`
identifies an eligible or recoverably pending method, the delivery is terminal
wrong-recipient input: a mediated delivery MUST be pickup-ACKed and MUST create
no `message.in`, contact or response effect.

Input to an eligible retired local key MUST pass through ordinary
decryption, authentication and durable receipt. It does not require renewed
recipient registration. Acceptance rules are unchanged; channel denials and
the availability of a usable local sender under [distributed-delivery.md section 8.1](distributed-delivery.md#freezing-an-ack-target-set) still govern subsequent work. Its mediation stays in the required
receiving set under [vault-events.md section 5.6](vault-events.md#mediation-fold) while its bound route
remains configured, non-retired and conflict-free and the mediation is usable.
Explicit channel blocking remains independent of contact display deletion under
[vault-events.md section 13.6](vault-events.md#delete-a-contact).

For an exact local recipient that can be decrypted, the receiver then checks
only conditions needed to classify the input safely before writing portable
application state:

- recipient eligibility above, exact key-agreement method and valid bound route;
- valid DIDComm syntax and authenticated encryption;
- a supported authenticated sender DID under [section 10.1](#did-resolution-requirements), with matching
  `from`/`skid`/`apu` and valid first-disclosure long form for numalgo 4;
- distinct canonical sender and recipient DIDs for an authenticated channel;
- per-source and per-recipient abuse rate limits; and
- emergency raw-ingress/storage exhaustion limits.

An implementation MUST NOT use this gate for a local preference about message
type, initial-specific size/lifetime limits, message age or expiry,
display-group or recipient capacity, absence of current-message `please_ack`,
or Trust Ping `response_requested == false`. Ordinary parser/transport limits
and concrete resource exhaustion still apply, without a separate bootstrap
floor or ceiling.

A safely classified hard rejection received through Message Pickup:

- MUST be pickup-ACKed;
- MUST NOT append `message.in`;
- MUST NOT create a contact, relationship or response effect; and
- MAY leave only a bounded local diagnostic.

Direct transport has no pickup ACK. Malformed crypto, wrong recipient,
a definitively unresolvable sender DID, exhaustion of
[section 10.1](#did-resolution-requirements)'s sender-resolution budget and hard abuse/resource
limits are examples of this gate. Supersession, invitation and channel
policy are checked after receipt at acceptance.

<a id="integrity-checks-and-durable-receipt"></a>

### 9.3 Integrity checks and durable receipt

Commit the authenticated channel observation before deciding acceptance.
`message.accepted` references the source and exact channel acceptance; a
proof-bearing source must have complete evidence for its derived peer link. The complete
schema and producer/import distinction are in
[channels.md](channels.md#message-accepted).

Superseded senders, blocked channels, invalid proof and contradictory identity
evidence grant no new effects. A matching accepted duplicate has no new response
obligation and cannot trigger old output dispatch. Later normal rotation
does not retroactively invalidate an already accepted observation.
Current authentication remains separate from historical permission.

<a id="5-did-profiles-and-resolution-evidence"></a>

<a id="did-profiles-and-resolution-evidence"></a>

## 10. DID profiles and resolution evidence

<a id="51-common-requirements"></a>

<a id="did-resolution-requirements"></a>

### 10.1 Common requirements

<a id="local-methods-and-pinned-peer-documents"></a>

#### Local methods and retained peer documents

A locally controlled communication DID MUST have its fixed key-agreement and
authentication methods, seed-derived keys, validated numalgo-4 document and one
immutable `boundRouteId` under [vault-events.md section 5.2](vault-events.md#did-identity-and-keys). That document must
support authenticated messages and signing `from_prior`. Recipient lifecycle
is role-independent under section 9; sending and new acceptance require a live DID.

Before the first channel package is submitted, its sender MUST durably retain:

- the exact presented peer DID;
- the canonical peer DID;
- the exact RFC 8785 canonical resolved DID document under its raw DASL CID;
- the selected authentication `kid`;
- the selected key-agreement `kid`; and
- the resolution event ID.

These are immutable operation snapshots, not a permanent channel key set.
Each message or proof records the exact resolution it used; later operations
may use a method-authorized updated document. Recovery of a saved operation
may retrieve missing bytes only when their canonical raw CID matches its
referenced document CID. A current revision cannot substitute for those bytes.

<a id="resolver-security-and-supported-senders"></a>

#### Resolver security and supported senders

An external peer or mediator may use `did:web`; resolving it does not create a
locally controlled DID entity or a document-publication obligation. A Web
resolver used by a mediator or client MUST be constrained against SSRF, DNS
rebinding, redirects to forbidden networks, unbounded responses and DID
mismatch. Failure to resolve safely is deferred or reported as
`did-resolution-unavailable` only for the transient failures classified below.
A policy-forbidden fetch is a definitive failure; no failure falls back to an
unrestricted fetch.

For an external Web target, the sender retains the exact Web document revision
used by each package. Key IDs are taken from that operation's authorized
document, not synthesized from a vault key-generation naming convention.

Remote senders may use either a public DID, including
`did:web`, or a Peer DID. The receiver verifies the sender's exact DID spelling
and authorized key-agreement method under its supported resolver; it MUST NOT
require the peer to create a pairwise DID. An unsupported sender method fails
authentication and is terminal under section 9.2; unavailable resolution
defers receipt without pickup ACK within this section's sender-resolution
budget under section 9.1. Numalgo-4 first-disclosure requirements apply only
when that method is used. A same-DID authenticated
reply from a key authorized by its current method-resolved document needs no
`from_prior`; a different DID requires verified continuation evidence to join
the accepted channel context.

<a id="recipient-resolution-freshness"></a>

#### Recipient-resolution freshness

This section owns recipient-resolution freshness. A `did:peer:4` recipient
uses its retained, validated long-form document and needs no fresh resolution.
For every other supported DID method, the preparer MUST resolve after the
new outbound intent commits and commit that fresh `peer.resolved` before its
first package. Do this for each new message ID, including later sends in the same channel;
an earlier outbound's snapshot, a local TTL or a resolver's stale/offline cache
cannot satisfy the requirement. An online conditional revalidation that
confirms the same document is sufficient and produces a new resolution event.
If no first package committed before interruption, repeat resolution on resume.
Unavailable resolution keeps the outbound retryable; it is not evidence of a
key change. Freshness is a producer ordering rule, not a clock comparison in
the portable fold.

Once a package exists, retry does not re-resolve and uses its exact bytes.
Any pre-attempt re-preparation stays in the same fixed channel and uses its
retained snapshot. After an attempt, only the exact package may be retried;
neither another channel nor a new encryption replaces it.
First-package resolution uses the failure classification below, including
the outbound `peer-key-changed` result. A fresh resolution remains evidence for
current preparation, never authority to add a continuity link.

<a id="sender-authentication-freshness"></a>

#### Sender-authentication freshness

This section also owns sender-authentication freshness. A `did:peer:4` sender
authenticates against its validated long-form document, retained or supplied
with this disclosure. For every other supported method, whenever a delivery
enters or resumes authentication under section 9.1, the receiver MUST resolve
the presented sender DID and authenticate its authcrypt key against that
current document. Unopened-delivery waits follow the suspension rule below. Post-receipt
channel acceptance recovery uses saved authentication evidence. Online conditional revalidation is sufficient; a local
TTL or stale/offline cache is not. A retained
`peer.resolved` may be reused only when that freshly validated document's raw
CID equals its `documentCid` and its `localKeyName`, `peerPublicKey`, `did` and `presentedDid`
match the observation; otherwise commit new evidence before `message.in`.
A key absent from the current document fails section 9.2 even when a historical
snapshot authorized it. Saved evidence validates historical operations; it
does not authenticate new deliveries. Unavailable resolution defers without
pickup ACK only within the budget below; it cannot fall back to a stale snapshot.

<a id="resolution-failure-classification"></a>

#### Resolution failure classification

For both sender and recipient resolution, **unavailable** means there is no
definitive answer now: a network/transport failure, timeout, temporary resolver
failure (`internalError` / `INTERNAL_ERROR`), or a retryable HTTP response
(408, 429 or 5xx) from the derived `did.json` resource. A definitive resolution
result takes precedence over its transport status: an intermediary resolver's
HTTP 500/501 carrying a malformed-document or unsupported-method result does
not turn that result into temporary unavailability.

A DNS NXDOMAIN response for the derived `did.json` authority, or NODATA for
all usable address families after alias resolution, is a definitive failure.
NODATA for one address family alone does not fail an otherwise usable address.
SERVFAIL, DNS timeout, connection timeout or refusal, and TLS validation
failure are unavailable; none permits bypassing TLS or the resolver policy.

A definitive failure includes not found or deactivated (including a derived
`did.json` 404/410), an invalid DID or document, an unsupported method, a
document ID inconsistent with the exact presented DID, a key absent from that
document, and resolution forbidden by the SSRF/resource policy above. These
categories include the corresponding
[DID Resolution errors](https://www.w3.org/TR/did-resolution/#errors), whatever
the resolver API's spelling. For inbound sender authentication they are
terminal section-9.2 failures: pickup-ACK when mediated and create no
`message.in`. Only unavailable answers defer, within the inbound budget below.
For first-package recipient resolution, definitive failure records
message-scoped terminal
`delivery.failed(code="peer-key-changed", packageId=null)` without preparation
or evidence purporting successful resolution, including for a first send;
unavailable answers keep the outbound retryable. Missing historical evidence follows
the separate recovery rule and is not a definitive new-resolution result.
Other completed unsuccessful resolution results are definitive for that
attempt; a policy refusal MUST NOT be disguised as transient unavailability.

The `peer-key-changed` code also covers definitive first-package resolution
failure when no earlier peer key exists. User-facing text MUST NOT describe
every such result as an observed key replacement; use the bounded local
resolution diagnostic, or a neutral peer-resolution failure label when that
diagnostic is absent. This does not add a portable diagnostic payload.

<a id="inbound-sender-resolution-budget"></a>

#### Inbound sender-resolution budget

Once local receive prerequisites are
satisfied, the runtime MUST use finite per-attempt timeouts, a finite attempt
budget and local backoff with a finite cap for each delivery. It SHOULD use
section 14's retry-interval, backoff-cap and attempt-count defaults, applied
to resolution calls rather than transport submissions; the outbound wire
expiry rule does not apply. Count an attempt before invoking the resolver,
including failure and unknown outcomes. While receive-ready, schedule retries
without waiting for another delivery or an external resolution-change signal.

<a id="active-time-retention-limits"></a>

#### Active-time retention limits

A retention stop bounds only the active resolution sequence. At its first
attempt, if a known absolute mediator delivery-retention deadline is still in
the future, the interval from that attempt to the deadline caps active elapsed
time; a past or unknown deadline supplies no such cap. An advertised
retention duration also caps active elapsed time, measured from the first
attempt. Active elapsed time includes resolver calls and backoff, but excludes
all non-resolution deferral waits under section 9.1, including interruptions
after the first attempt. Time before the first attempt never counts. A past
deadline alone never makes a delivery the mediator still delivers terminal;
unknown retention or lost local state still requires a finite attempt budget.
These are local resolution stops, not changes to the mediator's actual
retention, and require no cumulative delivery-lifetime wait history.

<a id="shared-accounting-and-lost-wait-state"></a>

#### Shared accounting and lost wait state

All workers share one resolution sequence per mediation/pickup delivery ID;
replica-scoped pickup additionally includes that replica ID. Direct input uses
its normalized envelope CID. Redelivery/reconnect does not replenish an active
sequence. Local or cryptographic prerequisite waits suspend an active sequence
without resetting its consumed attempts or active time. If sender resolution
already succeeded and unpack then waits for historical cryptographic material,
an evidence-change retry starts one fresh sequence to authenticate the current
sender again. Loss of accounting, or loss of local wait state followed by
redelivery, also starts one fresh finite sequence when resolution is required;
a past or now-unknown retention deadline alone cannot terminate that retry.

Committed channel observations are outside this accounting: channel
admission/recovery checks their sender authentication with retained snapshots.
Establishing a previously unverified link may separately require predecessor
resolution under [the proof rule](#predecessor-resolution); it does not repeat
sender authentication or the receipt/pickup operation.
A new network delivery, including a duplicate, still authenticates under the
current-sender rule before it can add another observation.

<a id="exhaustion-and-non-resolution-deferral"></a>

#### Exhaustion and non-resolution deferral

When the budget or retention stop is reached without a definitive answer,
classify that delivery as terminal input under section 9.2: pickup-ACK when
mediated, no `message.in`, contact or response effect, and at most a bounded
local diagnostic. Exhaustion does not prove a key change or permanently reject
the DID; the sender may make a new explicit attempt under ordinary sending
rules. It never authorizes automatic retry of a submitted message ID. A successful
resolution within budget instead proceeds through normal authentication and
durable receipt. Locked-vault, incomplete-recovery, recoverable local
key/route/historical-cryptographic-evidence deferrals under section
9.1 suspend this accounting: do not schedule resolution calls or apply this
terminal path while the delivery remains in such a wait. This bounds an
unresolved authentication attempt, not the age, expiry or acceptance time of a
valid initial message.

<a id="evidence-change-retries"></a>

#### Evidence-change retries

For an unopened delivery, retry only when its missing local or cryptographic
material changes. Reapply current authentication with the one shared bounded
resolution sequence under the accounting rule above. Resume a suspended active
sequence; start a fresh one only when that rule permits it.

For a committed channel observation, evidence changes schedule channel
acceptance, continuity verification or acceptance recovery. They do not repeat the
receive operation, consume sender-resolution attempts or require another pickup.
Keep unresolved evidence portable through the original receipt and references.

<a id="duplicate-authentication-and-historical-recovery"></a>

#### Duplicate authentication and historical recovery

These rules also apply to duplicate deliveries that would create a new
observation. If interruption occurs before inbound commit, resolve again when
the delivery resumes authentication under section 9.1, even if resolution
evidence already committed. Recovery or import of an already committed
observation verifies its retained evidence without a new
network resolution; a later revocation does not invalidate historical receipt
or acceptance. As with recipient freshness, this is a producer ordering rule, not
an event-time or fold-clock test. Retained `message.fromPriorResolved` evidence
lets the fold reverify the original JWT and derive its link without resolving
the predecessor again, independently of current sender authentication.

<a id="predecessor-resolution"></a>

#### Predecessor resolution for DID replacement

First reuse a complete proof witness for the exact carrier context and compact
JWT under [the continuity fold](channels.md#continuity), if one exists. Each
new carrier still passes current-sender authentication. An accepted predecessor
is needed for channel inheritance, not for checking or saving the proof.

Otherwise resolve the prior DID for this verification.
A `did:peer:4` predecessor uses its validated immutable document. A `did:web`
predecessor requires fresh method resolution, allowing online conditional
revalidation but no stale/offline fallback. With the already committed carrier
ID, commit the canonical document object and `message.fromPriorResolved` naming
its CID. The fold then checks the JWT's authentication method and original
signature. A method-valid document may be saved even when that proof fails;
the event never asserts verification success. The resolution may differ from
initial channel acceptance or any earlier message. If interrupted before the
association commits, repeat mutable-DID resolution on resume; after commit,
use that exact evidence and compute the result without another network fetch.
Use the same resolver security and bounded call timeouts; this lookup has no
authority to dispatch protocol output or undo durable receipt/pickup ACK.

Unavailable predecessor resolution leaves the saved carrier's proof pending;
a definitive invalid DID, document, claim or unauthorized signing key cannot
establish continuity. Failed resolution without a method-valid document creates
no successful-resolution event; show its diagnostic beside pending verification.
Never search unassociated older revisions to bypass a current authorization
failure. A proof with no retained valid witness whose signing key has been
removed cannot newly verify; an existing witness remains historical evidence,
even when its predecessor channel history arrives later. This is a producer
freshness rule, not a portable timestamp ordering rule. Import validates saved
associations without network resolution. Missing exact bytes defer recovery;
a newer document cannot replace them, even if it authorizes the same key.

<a id="key-changes-without-did-continuation"></a>

#### Document updates without DID replacement

The [did:web method](https://w3c-ccg.github.io/did-method-web/#update) permits
updating keys and services while keeping the DID. These are ordinary method
updates, not `from_prior` transitions; [DIDComm rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation)
handles replacement of the DID itself. Successful resolution with a newly
authorized usable key is not a `peer-key-changed` failure.

For a new message's first package, use currently authorized keys and service
from its fresh resolution. For new incoming delivery, authenticate with its
current sender document. Neither operation requires equality with the channel
acceptance's document CID or another message's selected key. Keep the same
channel, acceptance, invitation consumer and channel-local deduplication scope.
Normal denial, supersession and carried-proof checks still apply.

Retain every referenced snapshot without choosing one channel-wide current
revision, merging their authorized keys or rewriting old evidence. Importing
different valid Web revisions is not an integrity conflict by itself. Prepared
packages keep their retained evidence and attempted packages remain byte-for-byte
fixed. A service or key update supplies no retry or automatic dispatch authority.
Local and remote `did:peer:4` documents remain immutable under their canonical
DID; this rule does not allow replacing their encoded keys or route in place.

<a id="52-peer-did-numalgo-4-profile"></a>

<a id="peer-did-numalgo-4-profile"></a>

### 10.2 Peer DID numalgo-4 profile

Every local communication address is a Peer DID numalgo 4. Both validated long
and canonical short forms name one entity. Canonicalization validates the long
form and uses its derived short form. The retained resolution document follows
[vault-events.md section 4.4](vault-events.md#peer-resolved)'s fixed long-form representation, including when
the presented DID is short. Supported non-Peer methods use their method-defined
canonical DID, with no inferred aliases from names, common keys, resolver
redirects or service endpoints.

For `did:web` and any other supported method that defines no canonical form,
the canonical DID is the exact presented string. Apply no case folding,
percent-decoding, IDNA mapping or trailing-dot normalization to DID identity;
spellings that differ in any byte are distinct DIDs. A resolver may perform
the method's URL/DNS processing internally but MUST retain and compare the
original DID string. For `did:web`, the returned document's `id` MUST equal
that string byte-for-byte; do not rewrite a mismatching document to make it
match. This fixes the comparison used by the
[did:web resolution procedure](https://w3c-ccg.github.io/did-method-web/#read-resolve)
without changing how it derives the fetch URL.

First disclosure of any local address uses its long form, whether in OOB or
plaintext `from`. Within each accepted channel context, a sender MUST use its long
form until a complete authenticated observation confirms knowledge of that exact
address under [channels.md](channels.md#continuity). A successor also includes
its frozen proof until confirmed. Confirmation in an unrelated channel does not
satisfy either condition merely because the address is shared. Later new
messages in the confirmed context may use the short form;
they do not rewrite the retained predecessor spelling. Application `to`,
Routing `forward.next` and mediator registration use the canonical short form
once the peer document is known. Registration is verified before disclosure.

For authcrypt, plaintext `from` and the DID portion of protected `skid` are
byte-identical; decoded `apu` is the exact UTF-8 `skid` string. If the library
represents the sender only through `apu`, its DID portion still equals `from`.
The fragment identifies an authorized key-agreement method in that exact
document. Do not mix long and short forms in one package. A short form with no
known long-form document fails authentication; it does not create channel acceptance.

The predecessor's exact first-disclosure long form is used for `from_prior.iss`
and its protected authentication `kid`; `sub` uses the successor's long form.
A receiver compares predecessor DID spellings and authentication-method IDs
under [vault-events.md section 6.4](vault-events.md#relationship-peertransitioned), using only the method's validated spelling
equivalence and the exact verification document. Exact wire spellings remain retained.
A successor may bind another route or mediation for privacy. Neither changing
transport preference nor choosing another service changes an existing DID.

<a id="early-private-address-policy-and-notifications"></a>

## 11. Early private-address policy and notifications

Public and private addresses use the same channel model. On newly accepted live
application input, local policy may prefer a fresh private local successor when
the selected local DID was publicly disclosed or is shared with another peer.
It records `did.rotationSelected` with a UUIDv7 successor,
exact source observation and frozen proof. Reuse an existing matching decision;
do not branch merely because work was interrupted. Group membership is not a
reason to rotate an unrelated channel.

This policy can choose a successor for a new response intent, never modify an
existing response's channel. If a response already exists, preserve it and use
a later new input or explicit new send for any notification. No recovery worker
automatically dispatches a missing notification from historical input.

<a id="automatic-response-selection"></a>

### 11.1 Automatic response selection

On eligible live input, choose the natural deterministic protocol response
when available; otherwise use Empty for a selected rotation notification.
Trust Ping uses ping-response only when `response_requested` is not false.
One accepted channel input permits one frozen ACK-bearing selection. Use its
channel execution ID and the protocol tuple from
[delivery](distributed-delivery.md#automatic-effects).

Empty, ping-response and Report Problem do not trigger another privacy
notification. A generic pure ACK requests no ACK. Notification proof, successor,
source and new intent are committed before transport; duplicate receipt and
recovery never mint a new effect merely to send again.

<a id="proof-and-ordinary-message-headers"></a>

### 11.2 Proof and ordinary message headers

A newly prepared successor-channel message carries the frozen proof and long
form until exact-successor confirmation. Its `from` equals `from_prior.sub` in
the validated wire spelling. The predecessor authentication method signs the
JWT with fixed rotation `iat`; a message timestamp cannot regenerate it.
An attempted package remains byte-identical after confirmation.

<a id="registration-and-submission"></a>

### 11.3 Registration and submission

Verify the new recipient registration before disclosing its address. Commit
the exact package and then an attempt event before making the transport call.
Acceptance records submission; failure/uncertainty leaves manual action.
Replica change, missing ACK and notification loss never cause automatic replay.

<a id="confirmation-and-overlap"></a>

### 11.4 Confirmation and overlap

Use the exact-address, accepted-peer and local-only/join context checks in
[channels.md](channels.md#continuity). Input at a predecessor confirms no
successor. A peer ACK names a message and is independent of address knowledge.
Retain both recipient routes through confirmation; retire a shared resource
only when no other channel or disclosure still needs it.

<a id="peer-address-changes"></a>

## 12. Peer address changes

Store the authenticated successor-channel observation first, even when its
predecessor document or history is missing. Commit resolution evidence when
available and fold the original proof into a peer edge in its accepted
predecessor context; then accept the target channel and message as allowed.
No link event is appended. Show [verification status](channels.md#verification-status)
while evidence is pending or invalid. Opposite local/peer rotations use the explicitly
verified join; neither a shared DID nor UI grouping supplies a missing edge.

Superseded peer input is receivable but cannot create new application work.
Existing acceptance remains historical evidence. Competing successors and
contradictory identity evidence conflict without selecting the earliest event.
Links do not merge message identities, move old outputs or automatically send anything.

<a id="remote-errors-and-integrity-failures"></a>

## 13. Remote errors and integrity failures

A Report Problem is a display diagnostic beside a uniquely correlated outbound
only when its accepted carrier has the same authorized channel or a verified
role-preserving successor path. Keep its body available for display. It does
not prove submission failure, retract a link or authorize replay. A normal
authenticated observation may separately prove exact-address knowledge.

Missing source/verification evidence defers attribution; inconsistent evidence exposes
conflict. Do not assign an error to a display group by wire ID or name alone.

<a id="retry-replacement-and-address-rollover"></a>

## 14. Retry, manual resend and address rollover

An initial live action may retry prerequisite resolution/registration before
its first transport call, subject to expiry and these recommended bounds:

```text
minimum prerequisite retry interval = 30 seconds
exponential backoff cap = 21600 seconds
resolution-attempt budget per active sequence = 32
```

Inbound sender resolution uses its own per-delivery accounting and active-time
rules above. Pickup, recipient reconciliation and sync may retry normally;
they are not replay of a user message.

Each message transport call requires a prior `delivery.attempted` and one live
initial/manual dispatch action. There is no automatic transport retry after
failure/uncertainty or recovery. Manual retry preserves the first attempted
package, including fixed channel and IDs. Submitted, terminal, expired, erased
or otherwise ineligible work cannot retry. Missing bytes must be recovered.

A new explicit send uses a new message ID and may select a verified successor
channel. The original remains submitted, failed or unconfirmed as evidenced;
new sending never claims it was undelivered. Same content does not imply one
operation. Business protocols needing idempotency must define their own
authenticated operation identity.

<a id="phase-1-execution-and-deferred-replication"></a>

## 15. Phase-1 execution and deferred replication

Phase 1 permits one active executor. Import/restore reconstructs state but
grants no dispatch action for historical intents or automatic responses.
Replicas may later synchronize receipts, proof evidence, local decisions and
display groups, rebuilding links without
automatically taking over another replica's pending outbox. Multi-executor
automatic reactions require a separately specified coordination policy.

<a id="privacy-abuse-interoperability-and-security"></a>

## 16. Privacy, abuse, interoperability and security

Public/pairwise labels are disclosure policy. Peers receive ordinary DIDComm
messages and no display relationship or replica ID. Shared addresses can
correlate traffic; fresh pairwise addresses reduce that reuse.

Continuity applies to exact channel contexts and role-preserving paths. It
cannot transfer authority through display membership. Channel receipt never
implies application permission. Resource/parser limits remain in force.
Cross-channel reuse of a peer's wire ID is not deduplicated by this profile;
channel-local acceptance does not promise exactly-once business execution.
An unconfirmed local successor with a terminal route cannot silently branch or
roll back; explicit new communication is a new channel and new message.

<a id="required-conformance-cases"></a>

## 17. Required conformance cases


<a id="did-identity-and-relationship-birth-rz-1-rz-12"></a>

### DID identity and channel acceptance (RZ-1–RZ-12)

1. <a id="rz-1"></a> Peer-DID first disclosure validates its long form, canonical short form, fixed keys and bound route without DNS.
2. <a id="rz-2"></a> Each external Web operation retains exact document bytes; a later network revision can authorize new operations but cannot replace historical proof evidence.
3. <a id="rz-3"></a> No emitted message uses an Estoc rendezvous request, accept or decline type, or a wire relationship ID.
4. <a id="rz-4"></a> Public/public, public/pairwise and pairwise/pairwise pairs use the same channel receipt and separate explicit admission rules.

5. <a id="rz-5"></a> Run both channel naming fixtures in both directions; distinct canonical pairs differ. Display relationship IDs do not enter the derivation.

6. <a id="rz-6"></a> Validated Peer long/short spellings name one channel endpoint; shared keys, endpoints and labels do not alias distinct DIDs.

7. <a id="rz-7"></a> Opposite first sends select one channel with distinct message directions; unsolicited receipt does not accept the channel or create a display group.

8. <a id="rz-8"></a> Another independently authorized key, including in an updated Web document, preserves channel/sender/wire-ID identity without creating a contact.

9. <a id="rz-9"></a> A live public channel can carry ordinary content before a reply or private allocation.

10. <a id="rz-10"></a> Offline intent commits fixed channel/sender/recipient without DNS; first preparation resolves and accepts the exact peer evidence.

11. <a id="rz-11"></a> Preparation reuses DID-pair acceptance and resolves current recipient evidence. Different valid imported Web revisions coexist without a winning revision or a union of authorized keys.

12. <a id="rz-12"></a> One local DID with two different peer DIDs has two independent channels without exclusive local-DID ownership.

<a id="address-changes-and-ordinary-replies-rz-13-rz-25"></a>

### Address changes and ordinary replies (RZ-13–RZ-25)

13. <a id="rz-13"></a> A local rotation in C(A0,B0) leaves C(A0,C0) and public disclosure of A0 unchanged.

14. <a id="rz-14"></a> Either endpoint rotation creates another channel; old message and execution identities remain unchanged and graph discovery never merges them.

15. <a id="rz-15"></a> Early privacy uses a normal local channel link, fresh UUIDv7 successor and frozen trigger/proof.

16. <a id="rz-16"></a> A committed successor/local rotation decision survives crash with exact route, keys, JWT, iat and source; its link rebuilds and no notification dispatches automatically on reopen.

17. <a id="rz-17"></a> Missing optional private allocation does not prevent channel acceptance or an ordinary public-address reply.

18. <a id="rz-18"></a> Normal Trust Ping selects ping-response; response_requested false is still received and may get an independent Empty rotation notification.
19. <a id="rz-19"></a> Content-first Basic Message remains its own application message without a rendezvous wrapper.
20. <a id="rz-20"></a> Control input may obtain explicit channel/message acceptance and process eligible ACKs, but creates no contact or recursive privacy notification.

21. <a id="rz-21"></a> Generic pure ACK has no ACK request. A privacy notification and natural response share the execution's one ACK-bearing selection.
22. <a id="rz-22"></a> New successor messages carry frozen proof/long form until confirmation; attempted packages remain exact after confirmation.

23. <a id="rz-23"></a> Input at the exact successor confirms rotation; input at a predecessor does not. Explicit ACK naming a message remains separate.
24. <a id="rz-24"></a> A local link needs exact predecessor confirmation; no second same-side link is authorized before its predecessor is known by the peer.

25. <a id="rz-25"></a> Both live recipient routes remain during rotation overlap. Shared routes/addresses survive until unrelated users no longer need them.

<a id="peer-continuation-and-integrity-rz-26-rz-35"></a>

### Peer continuation and integrity (RZ-26–RZ-35)

26. <a id="rz-26"></a> Successor proof at different local addresses needs the corresponding complete channel evidence or a verified join; no global relationship lookup is required.

27. <a id="rz-27"></a> Opposite-side links with one accepted base justify the exact diagonal channel in either import order without synthetic observations.

28. <a id="rz-28"></a> Forged proof, wrong sub, unrelated channel context, unauthorized signing key or mismatched predecessor resolution cannot authorize a link.

29. <a id="rz-29"></a> Repeated proof can reuse a complete link's exact historical verification evidence while its new carrier authenticates against an updated successor document.

30. <a id="rz-30"></a> Competing same-side successors, authorization cycles and contradictory identity evidence expose conflict without arrival-order winners; document revisions do not split that context.

31. <a id="rz-31"></a> Missing acceptance/proof references defer derived continuity while authenticated receipt still commits and pickup-ACKs; UI distinguishes missing proof from missing history.

32. <a id="rz-32"></a> A newly authorized same-DID key can authenticate input eligible for normal acceptance and ACKs. A removed key cannot authenticate new delivery merely because an earlier snapshot authorized it.

33. <a id="rz-33"></a> Verified peer supersession refuses new old-peer work through its local-only context, preserves prior acceptance and leaves unrelated public-DID channels unaffected.

34. <a id="rz-34"></a> Matching proof-free channel acceptance consumes a one-use invitation; plain receipt, continuation and pthid alone do not.

35. <a id="rz-35"></a> Same-channel consumption is idempotent; unavailable invitations refuse another consumer and imported incompatible consumers conflict. Crash/erasure never reopen consumption.

<a id="recipient-lifecycle-rz-36-rz-38"></a>

### Recipient lifecycle (RZ-36–RZ-38)

36. <a id="rz-36"></a> A retired local DID permits no new acceptance or sending, but retained keys may receive on eligible routes without continuity history.

37. <a id="rz-37"></a> A terminal route or mediation rejects input; temporary missing key/route/recovery prerequisites defer without pickup ACK.
38. <a id="rz-38"></a> Wrong recipient DID or method fragment, authentication-purpose kid and unknown Peer short form are terminal before application state.

<a id="resolution-freshness-and-budgets-rz-39-rz-45"></a>

### Resolution freshness and budgets (RZ-39–RZ-45)

39. <a id="rz-39"></a> Every new delivery, including a duplicate, authenticates its current sender. Recovery of already committed channel evidence does not re-resolve the sender to admit scope.

40. <a id="rz-40"></a> NXDOMAIN and no usable address-family data are definitive; one-family NODATA alone is not. SERVFAIL, timeout and TLS failure use bounded unavailability.
41. <a id="rz-41"></a> Per-delivery sender-resolution retries count before calls, schedule without redelivery, share accounting and stop at their finite budget or active-time retention bound. At a sequence's first attempt, a future known absolute deadline caps active time by its remaining interval, including after local-state reset; an advertised duration also caps active time. A past or unknown deadline supplies no absolute-deadline cap. Unknown retention still requires a finite budget.
42. <a id="rz-42"></a> Budget exhaustion pickup-ACKs terminal input without message.in. Locked-vault, local recovery and other non-resolution deferrals consume neither attempts nor active time, including when they interrupt a sequence. A wait that crosses an absolute deadline does not itself exhaust the retained sequence on resumption; its previously consumed attempts and active time remain counted. A permitted retry after loss of accounting, or a redelivery after loss of local wait state whether or not accounting survived, instead starts a fresh finite sequence under [section 10.1](#did-resolution-requirements) when the sender method requires resolution. Neither path permits terminal ACK solely because the wait crossed the deadline.
43. <a id="rz-43"></a> A successful current resolution within budget permits normal durable receipt. Imported receipts use retained evidence without fresh network requests.
44. <a id="rz-44"></a> First-package recipient resolution is fresh when required; an attempted package never replaces its snapshot or channel.

45. <a id="rz-45"></a> Resolution failure before any prior evidence uses neutral diagnostics, not an unsupported claim that a key was replaced. A successful authorized key update is not a failure.

<a id="completion-contact-policy-and-phase-boundary-rz-46-rz-54"></a>

### Completion, contact policy and phase boundary (RZ-46–RZ-54)

46. <a id="rz-46"></a> Queued, prepared and attempted messages retain their fixed channel after either endpoint rotates; a successor send has a new ID.

47. <a id="rz-47"></a> Submission stops further preparation and retry; missing ACK and duplicate receipt never reopen it.

48. <a id="rz-48"></a> Expiry and bounded prerequisite retries are independent of incoming age and rotation iat; transport retries require manual action.

49. <a id="rz-49"></a> Contact/group assignment is independent of channel acceptance; control-only channels need no invented contact.

50. <a id="rz-50"></a> Display regrouping changes no channel acceptance, verification evidence, continuation, message identity or ACK authorization.

51. <a id="rz-51"></a> Deleting a contact changes display only; an explicit delete-and-block action writes channel denials without retiring shared resources.

52. <a id="rz-52"></a> A remote problem report needs exact channel/path correlation and readable body; it changes no submission or continuity state.

53. <a id="rz-53"></a> An unconfirmed successor with a terminal route cannot branch or roll back; temporary outage does not invoke this terminal limitation.
54. <a id="rz-54"></a> Phase-1 operation needs no replica-mediation or vault-sync implementation and discloses no replica ID to peers.

<a id="receipt-recovery-and-evidence-fixtures-rz-55-rz-61"></a>

### Receipt recovery and evidence fixtures (RZ-55–RZ-61)

55. <a id="rz-55"></a> Receipt precedes channel acceptance and message acceptance. Crash retains each committed prefix; acceptance may already consume an invitation, and no prefix dispatches automatically on reopen.

56. <a id="rz-56"></a> Confirmation in an unrelated channel does not permit short-form disclosure or proof omission; validated equivalent predecessor spellings verify against the exact retained method evidence.

57. <a id="rz-57"></a> Independently authenticated carriers are saved while predecessor evidence is pending. Restore validates local links; failed unpack never fabricates receipt, and proof-free input grants no implicit acceptance.

58. <a id="rz-58"></a> Long/short Peer spellings retain the same canonical document CID and cannot create another document revision by resolver transformation.

59. <a id="rz-59"></a> did:web:Bob.Example and did:web:bob.example remain distinct endpoints; returned document ID mismatch cannot be repaired by URL/DNS normalization.

60. <a id="rz-60"></a> Profile facts retain their exact source channel. Display grouping can show several chains but transfers no authority or shared-profile permission.

61. <a id="rz-61"></a> Authenticated did:web receipt commits and pickup-ACKs while continuity is incomplete. Recovery uses saved authentication; new network delivery uses its bounded fresh sequence.
