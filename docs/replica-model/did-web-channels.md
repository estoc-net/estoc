# Mutable channel DIDs

Status: **deferred draft**. This document contains candidate rules for a future
channel profile supporting `did:web` and mutable DID documents. It is not a
phase-1 dependency or an implementation-ready extension. Requirement words
below apply only to that candidate profile, whose post-receipt retry policy
remains unresolved.

Phase-1 channel endpoints, including continuity predecessors, support only
`did:peer:4` under [the channel DID profile](relationships.md#peer-did-numalgo-4-profile).
Mediator and routing DID resolution remains separate under
[mediator resolution](relationships.md#mediator-resolution).

## 1. Future endpoint identity and document updates

An external channel peer could use a Web DID without creating a locally
controlled DID entity or a document-publication obligation. Public and private
disclosure remain channel policy, independent of DID method.

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

<a id="key-changes-without-did-continuation"></a>

#### Document updates without DID replacement

The [did:web method](https://w3c-ccg.github.io/did-method-web/#update) permits
updating keys and services while keeping the DID. These are ordinary method
updates, not `from_prior` transitions; [DIDComm rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation)
handles replacement of the DID itself. Successful resolution with a newly
authorized usable key is not a `peer-key-changed` failure.

For a new message's package, use currently authorized keys and service
from its fresh resolution. For new incoming delivery, authenticate with its
current sender document. Neither operation requires equality with another
message's document CID or selected key. Keep the same channel, invitation
consumer and channel-local deduplication scope.
Normal denial, supersession and carried-proof checks still apply.

Retain every referenced snapshot without choosing one channel-wide current
revision, merging their authorized keys or rewriting old evidence. Importing
different valid Web revisions is not an integrity conflict by itself. Committed
packages keep their retained evidence and remain byte-for-byte fixed. A service
or key update supplies no retry or automatic dispatch authority.
Local and remote `did:peer:4` documents remain immutable under their canonical
DID; this rule does not allow replacing their encoded keys or route in place.


<a id="candidate-network-resolution-rules"></a>

## 2. Candidate network resolution rules

These rules require the constrained network resolver used for
[mediator resolution](relationships.md#mediator-resolution). They extend
channel authentication and preparation; they do not change mediator identity
or grant any new transport invocation. The candidate defaults are a 30-second
minimum retry interval, exponential backoff capped at 21600 seconds and
32 resolution attempts per active sequence.

<a id="recipient-resolution-freshness"></a>

#### Recipient-resolution freshness

This section owns recipient-resolution freshness. A `did:peer:4` recipient
uses its retained, validated long-form document and needs no fresh resolution.
For every other supported DID method, the preparer MUST resolve after the
new outbound intent commits and commit that fresh `peer.resolved` before the
package. Do this for each new message ID, including later sends in the same channel;
an earlier outbound's snapshot, a local TTL or a resolver's stale/offline cache
cannot satisfy the requirement. An online conditional revalidation that
confirms the same document is sufficient and produces a new resolution event.
If no package committed before interruption, repeat resolution on resume.
Unavailable resolution keeps the outbound retryable; it is not evidence of a
key change. Freshness is a producer ordering rule, not a clock comparison in
the portable fold.

Once a package commits, initial sending and retry use its exact bytes and
retained snapshot without re-resolution. Changing the package requires a new
message ID, even if the committed package has never been sent.
Recipient resolution uses the failure classification below, including
the outbound `peer-key-changed` result. A fresh resolution remains evidence for
current preparation, never authority to add a continuity link.

<a id="sender-authentication-freshness"></a>

#### Sender-authentication freshness

This section also owns sender-authentication freshness. A `did:peer:4` sender
authenticates against its validated long-form document, retained or supplied
with this disclosure. For every other supported method, whenever a delivery
enters or resumes authentication under [the local receive wait rules](relationships.md#deferred-delivery), the receiver MUST resolve
the presented sender DID and authenticate its authcrypt key against that
current document. Unopened-delivery waits follow the suspension rule below. Post-receipt
operation recovery uses saved authentication evidence. Online conditional revalidation is sufficient; a local
TTL or stale/offline cache is not. A retained
`peer.resolved` may be reused only when that freshly validated document's raw
CID equals its `documentCid` and its `localKeyName`, `peerPublicKey`, `did` and `presentedDid`
match the observation; otherwise commit new evidence before `message.in`.
A key absent from the current document fails [the receive gate](relationships.md#hard-pre-vault-gate) even when a historical
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
terminal [receive-gate](relationships.md#hard-pre-vault-gate) failures: pickup-ACK when mediated and create no
`message.in`. Only unavailable answers defer, within the inbound budget below.
For recipient resolution before preparation, definitive failure records
message-scoped terminal
`delivery.failed(code="peer-key-changed", packageId=null)` without preparation
or evidence purporting successful resolution, including for a first send;
unavailable answers keep the outbound retryable. Missing historical evidence follows
the separate recovery rule and is not a definitive new-resolution result.
Other completed unsuccessful resolution results are definitive for that
attempt; a policy refusal MUST NOT be disguised as transient unavailability.

The `peer-key-changed` code also covers definitive recipient-resolution
failure when no earlier peer key exists. User-facing text MUST NOT describe
every such result as an observed key replacement; use the bounded local
resolution diagnostic, or a neutral peer-resolution failure label when that
diagnostic is absent. This does not add a portable diagnostic payload.

<a id="inbound-sender-resolution-budget"></a>

#### Inbound sender-resolution budget

Once local receive prerequisites are
satisfied, the runtime MUST use finite per-attempt timeouts, a finite attempt
budget and local backoff with a finite cap for each delivery. It SHOULD use
[the prerequisite retry policy](relationships.md#retry-replacement-and-address-rollover)'s retry-interval, backoff-cap and attempt-count defaults, applied
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
all non-resolution deferral waits under [the local receive wait rules](relationships.md#deferred-delivery), including interruptions
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
sequence. Local receive prerequisite waits suspend an active sequence
without resetting its consumed attempts or active time. If sender resolution
already succeeded but receipt then waits for recoverable local receive state,
an evidence-change retry starts one fresh sequence to authenticate the current
sender again. Predecessor proof evidence is not such a prerequisite.
Loss of accounting, or loss of local wait state followed by
redelivery, also starts one fresh finite sequence when resolution is required;
a past or now-unknown retention deadline alone cannot terminate that retry.

Committed channel observations are outside this accounting: source-derived
operations and recovery check their sender authentication with retained snapshots.
Establishing a previously unverified link may separately require predecessor
resolution under [predecessor verification](#predecessor-resolution); it does not repeat
sender authentication or the receipt/pickup operation.
A new network delivery, including a duplicate, still authenticates under the
current-sender rule before it can add another observation.

<a id="exhaustion-and-non-resolution-deferral"></a>

#### Exhaustion and non-resolution deferral

When the budget or retention stop is reached without a definitive answer,
classify that delivery as terminal input under [the receive gate](relationships.md#hard-pre-vault-gate): pickup-ACK when
mediated, no `message.in`, contact or response effect, and at most a bounded
local diagnostic. Exhaustion does not prove a key change or permanently reject
the DID; the sender may make a new explicit attempt under ordinary sending
rules. It never authorizes automatic retry of a submitted message ID. A successful
resolution within budget instead proceeds through normal authentication and
durable receipt. Locked-vault, incomplete-recovery, recoverable local
key/document/route deferrals under
[the local receive wait rules](relationships.md#deferred-delivery) suspend this
accounting: do not schedule resolution calls or apply this
terminal path while the delivery remains in such a wait. This bounds an
unresolved authentication attempt, not the age, expiry or acceptance time of a
valid initial message.

<a id="predecessor-resolution"></a>

## 3. Predecessor verification and open retry policy

Durable receipt and pickup ACK remain independent of a carried proof. A future
Web predecessor lookup would require fresh method resolution, allowing online
conditional revalidation but no stale/offline fallback. Commit the exact
canonical document and its association with the already committed carrier;
the fold verifies the original JWT. If interrupted before that association
commits, repeat mutable-DID resolution on resume. After commit, use only that
exact evidence without another network fetch.

Unavailable resolution leaves proof pending. A definitive invalid document or
unauthorized signing key supplies no continuity. Never search unassociated
older revisions to bypass a current authorization failure. Retained valid
proof witnesses remain historical evidence after a key is removed; a proof
without such a witness cannot newly verify with the removed key.

Before this extension can become implementable, it must define predecessor
retry triggers, finite attempt and concurrency budgets, and when the original
carrier loses eligibility for automatic outputs. Sender-resolution accounting
below does not answer those post-receipt questions. Network recovery, reopen
and new carriers must not silently grant dispatch authority to older carriers.
No such lookup or retry sequence is required or permitted for phase-1 channel
proofs, which use only locally available numalgo-4 material.

<a id="deferred-conformance-cases"></a>

## 4. Deferred conformance cases

The identifiers retain their original owners. Links from the phase-1 lists
reserve these entries; none is a phase-1 conformance obligation. Any references
to current-document or network-resolution behavior below use this candidate
extension in addition to the shared receipt and evidence rules.

<a id="rz-2"></a>

### RZ-2

Each external Web operation retains exact document bytes; a later network revision can authorize new operations but cannot replace historical proof evidence.

<a id="rz-32"></a>

### RZ-32

A newly authorized same-DID key can authenticate input eligible for ordinary operations and ACKs. A removed key cannot authenticate new delivery merely because an earlier snapshot authorized it.

<a id="rz-40"></a>

### RZ-40

NXDOMAIN and no usable address-family data are definitive; one-family NODATA alone is not. SERVFAIL, timeout and TLS failure use bounded unavailability.

<a id="rz-41"></a>

### RZ-41

Per-delivery sender-resolution retries count before calls, schedule without redelivery, share accounting and stop at their finite budget or active-time retention bound. At a sequence's first attempt, a future known absolute deadline caps active time by its remaining interval, including after local-state reset; an advertised duration also caps active time. A past or unknown deadline supplies no absolute-deadline cap. Unknown retention still requires a finite budget.

<a id="rz-42"></a>

### RZ-42

Budget exhaustion pickup-ACKs terminal input without message.in. Locked-vault, local recovery and other non-resolution deferrals consume neither attempts nor active time, including when they interrupt a sequence. A wait that crosses an absolute deadline does not itself exhaust the retained sequence on resumption; its previously consumed attempts and active time remain counted. A permitted retry after loss of accounting, or a redelivery after loss of local wait state whether or not accounting survived, instead starts a fresh finite sequence under [shared accounting](#shared-accounting-and-lost-wait-state) when the sender method requires resolution. Neither path permits terminal ACK solely because the wait crossed the deadline.

<a id="rz-43"></a>

### RZ-43

A successful current resolution within budget permits normal durable receipt. Imported receipts use retained evidence without fresh network requests.

<a id="rz-45"></a>

### RZ-45

Resolution failure before any prior evidence uses neutral diagnostics, not an unsupported claim that a key was replaced. A successful authorized key update is not a failure.

<a id="rz-59"></a>

### RZ-59

did:web:Bob.Example and did:web:bob.example remain distinct endpoints; returned document ID mismatch cannot be repaired by URL/DNS normalization.

<a id="rz-61"></a>

### RZ-61

Authenticated did:web receipt commits and pickup-ACKs while continuity is incomplete. Recovery uses saved authentication; new network delivery uses its bounded fresh sequence.

<a id="ch-33"></a>

### CH-33

After a Web key update, a received replacement proof can use a new authorized authentication key through its exact message.fromPriorResolved document association. Unassociated old snapshots cannot bypass removal; a retained valid witness still verifies offline.

<a id="ch-34"></a>

### CH-34

Repeated identical proof with an updated successor document remains the same DID replacement; each carrier authenticates independently and no document CID elects a competing link.

<a id="ch-35"></a>

### CH-35

Document updates across local-only links do not split peer supersession/conflict context or break an otherwise complete join and cross-channel ACK path.

<a id="ve-105"></a>

### VE-105

Successful same-DID resolution with a newly authorized usable key permits preparation and receipt using their own exact evidence. Definitive resolution failure retains the scoped failure path; revoked keys cannot authenticate new delivery.

<a id="ve-106"></a>

### VE-106

Keys independently authorized by different valid Web revisions may authenticate the same channel input. Equal intent deduplicates and contradictory intent conflicts; another channel never merges execution.

<a id="ve-108"></a>

### VE-108

Preparation for each new non-numalgo-4 outbound performs
fresh resolution. Retry preserves the committed package and its evidence;
neither an old snapshot nor a local TTL bypasses the new-message ID rule.
Every new non-numalgo-4 inbound observation also requires current sender
authentication under [candidate resolution rules](#candidate-network-resolution-rules); a chain member absent
from the current document fails, and unavailable resolution defers
without pickup ACK only within that section's per-delivery budget.
Exhaustion is terminal input with pickup ACK and no `message.in`, without
timing out recoverable local key/route/evidence state.
Committed observations recover from their retained evidence without new
resolution or retroactive scope changes.

<a id="ve-131"></a>

### VE-131

Supported methods without canonicalization preserve exact DID strings; case/encoding/trailing-dot differences cannot collapse channels or proof context, and did:web document IDs must match exactly.

<a id="dd-58"></a>

### DD-58

A valid same-DID key/service update preserves the channel. An ACK carrier can authenticate with the new key and acknowledge an old-key package; exact historical package evidence is unchanged.

<a id="dd-59"></a>

### DD-59

Independently authorized keys across document revisions share channel-local input identity; an unauthorized key supplies neither source authority nor an authenticated intent conflict.

<a id="dd-60"></a>

### DD-60

A new non-numalgo-4 message ID resolves and commits current recipient evidence
before first preparation. Transient unavailability leaves it retryable;
definitive resolution failure is terminal under [candidate resolution rules](#candidate-network-resolution-rules). An unchanged online-revalidated document still creates new evidence.
Committed packages retry manually with exact bytes and retained snapshots. Whenever
an inbound delivery enters or resumes authentication, including duplicates,
it uses current sender resolution; unavailability defers without pickup ACK
only within this extension's per-delivery budget. Definitive DNS failures
and exhausted retries take the terminal pre-vault ACK path; redelivery
cannot reset the active sequence. Recoverable local prerequisite waits
consume no budget. Unopened local receive prerequisite waits use this extension's
suspension and fresh-sequence rule. Post-receipt operation recovery
consumes no sender-resolution attempts.
Reusing matching evidence requires a fresh document check. Recovery of
committed input uses its retained snapshot without another network lookup.

<a id="ch-30"></a>

### CH-30

Same-DID service updates preserve channel and input identity; a redelivered wire ID with equal intent creates no second execution or automatic response.

<a id="ch-31"></a>

### CH-31

A method-authorized same-DID key update permits new receipt and new-message preparation without from_prior. Historical snapshots remain unchanged.

<a id="ch-32"></a>

### CH-32

A key absent from the currently resolved sender document cannot authenticate new delivery; previously committed receipt still validates with its own snapshot on import.
