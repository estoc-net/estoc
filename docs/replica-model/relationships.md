# Estoc Relationship and Address Policy Profile 1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — ordinary DIDComm relationships, discovery and
early private-address allocation for one active writable vault runtime.
Multi-replica mediation and vault synchronization are deferred.

This document uses **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**
and **MAY** as described in BCP 14 when they appear in all capitals.

There is no Estoc rendezvous wire protocol, connection request, accept or
decline. Messages use ordinary DIDComm protocols. Relationship formation is
independent of whether either address was public or allocated for private use.
An address change uses standard `from_prior` inside an existing relationship.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Understand relationships | [Model](#what-it-is-for) → [Symmetric identity](#symmetric-relationship-identity) → [Peer address changes](#peer-address-changes) |
| Implement authentication and receipt | [Receipt gates](#uniform-receipt) → [Receive procedure](distributed-delivery.md#receive-a-message) → [Resolution and retry rules](#did-resolution-requirements) → [Peer DID profile](#peer-did-numalgo-4-profile) |
| Implement address policy | [Discovery](#out-of-band-discovery) → [Send and select birth](#ordinary-sending-and-birth-selection) → [Early privacy and notification](#early-private-address-policy-and-notifications) → [Retry and rollover](#retry-replacement-and-address-rollover) |

<details>
<summary>Contents</summary>

- [1. What it is for](#what-it-is-for)
- [2. Dependencies](#dependencies)
- [3. Terms](#terms)
- [4. Invariants](#invariants)
- [5. Symmetric relationship identity](#symmetric-relationship-identity)
- [6. Out-of-band discovery](#out-of-band-discovery)
- [7. Address lifecycle](#address-lifecycle)
- [8. Ordinary sending and birth selection](#ordinary-sending-and-birth-selection)
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

A channel is a fixed canonical address pair. A relationship is an explicitly
admitted root channel and the further channels justified by its two address
histories. [Channels and admission](channels.md) owns this separation.

```text
C00: A0 <-> B0       received independently; root admission establishes R
C10: A1 <-> B0       a local transition adds this channel to R
C11: A1 <-> B1       a peer transition adds this channel to R
```

Every accepted transition preserves R and its message/effect identity. Channel
observations remain immutable whether R is known, incomplete or conflicted.
Both ends may keep public addresses; public/pairwise allocation changes no
authentication rule. A shared address may participate in several relationships,
each with its own continuity evidence and permission to use channels.

Ordinary application messages and Trust Ping interoperate without an Estoc
relationship wire handshake. A first receipt enters an unassigned inbox unless
there is an explicit admission decision or a verified existing relationship.
Contact/address policy runs only after relationship acceptance.

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

- **Communication address** — a DID with supported authentication/key-agreement
  evidence and delivery information. Local addresses are seed-derived
  `did:peer:4` entities; external addresses may use other supported methods.
- **Public / rendezvous address** — an address disclosed for discovery. This
  is a policy description, not a core DID role.
- **Pairwise address** — a fresh address allocated for use in one relationship.
  The allocator avoids reuse; core relationship lookup always uses both ends.
- **Channel** — a fixed canonical DID pair under [channels.md](channels.md#channel-identity).
- **Birth addresses** — the explicitly admitted root channel pair used to derive `R`.
- **Relationship** — the stable symmetric `R`, its pinned initial evidence and
  its two address histories. Its local/peer orientation is a vault-local view.
- **Birth intent** — an ordinary outbound whose nullable `birth` metadata
  freezes a new address pair before network work. It is not a wire message type.
- **Root-address acceptance** — a committed root `message.scoped` under [vault-events.md section 5.8](vault-events.md#invitation-fold); plain receipt consumes no invitation.
- **Application input** — authenticated scoped input other than a control
  observation, Empty, Trust Ping `ping-response` or Report Problem. Excluding
  these types from privacy-response selection prevents reply cycles; it does
  not exclude their receipt, binding or scoped ACK processing.
- **Rotation notification** — an ordinary message disclosing a committed local
  transition. It is not a prerequisite for relationship formation.
- **Rotation confirmation** — authenticated scoped input addressed to the
  exact successor; explicit ACK receipt information remains separate.

<a id="invariants"></a>

## 4. Invariants

1. Channel identity is symmetric over its fixed canonical addresses; R identity
   is symmetric over its explicitly admitted root addresses.
2. Current DID/key authentication precedes durable authenticated receipt.
3. Channel receipt requires no relationship lookup or admission decision.
4. Unknown membership remains unassigned; lookup absence creates no R.
5. Verified directed transitions extend only their named R's channel set.
6. Competing branches or R claims conflict at admission/scope; receipt survives.
7. Receipt, root admission, contact assignment, scope and rotation are separate.
8. Public addresses can authenticate ordinary traffic under the same rules.
9. Fresh private allocation is local policy after relationship acceptance.
10. Submitted message IDs never automatically prepare or submit again.
11. Erasure and contact deletion preserve scope, effect and invitation identity.
12. Phase 1 has one active full runtime. Peers address DIDs, never replica IDs,
    channel IDs or vault-local relationship references.

<a id="10-symmetric-relationship-identity"></a>

<a id="symmetric-relationship-identity"></a>

## 5. Symmetric relationship identity

This section owns relationship and default privacy-allocation ID derivations.
Let A and B be the distinct canonical *explicitly admitted root DID strings*.
Channel creation alone is not admission; [channels.md section 4](channels.md#admission) defines the permitted decisions. For numalgo 4,
validate a supplied long form and use its short form. Other supported methods
use [section 10.2](#peer-did-numalgo-4-profile)'s canonicalization. Sort the two strings by unsigned UTF-8 byte
order; encode the resulting array with RFC 8785. No locale collation, Unicode
normalization, resolver-dependent aliasing or public-key sorting is implied.

```text
[lo, hi] = sortCanonicalDids([A, B])

relationshipId    = UUIDv5(
  estocNamespace("relationship"),
  RFC8785(["v1", lo, hi])
)

contactId         = UUIDv5(
  estocNamespace("relationship-contact"),
  RFC8785(["v1", relationshipId])
)

earlyPrivateDidId = UUIDv5(
  estocNamespace("relationship-local-did"),
  RFC8785(["v1", relationshipId, canonicalLocalBirthDid])
)
```

Both send directions derive the same R. The local birth address distinguishes
the two ends' default private entity IDs. A vault's seed separately determines
the keys. The private DID is an optional successor, not a birth-address input;
there is no circular derivation. Ordinary later rotations use fresh UUIDv7 IDs.

Identifier fixture (not a live resolver or JWT fixture):

```text
A                  = did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd
B                  = did:web:bob.example
relationshipId     = 35807a1e-3b8a-52f5-9580-29cd5265882e
contactId          = e0d4f3cf-e4d1-5774-b273-cbe08b2d26dd
earlyPrivateDidIdA = 4734b126-9706-5c8f-b971-91a5afb9c1d4
earlyPrivateDidIdB = 30d9a3a6-0e65-52a4-a822-591a683bb1e6
```

This second identifier-only fixture puts the higher-sorting endpoint first:

```text
A                  = did:web:zoe.example
B                  = did:web:amy.example
RFC8785(["v1", lo, hi]) = ["v1","did:web:amy.example","did:web:zoe.example"]
relationshipId     = 249fc438-75bc-53a9-904d-99d44edd6d23
contactId          = cbe762f9-132c-572d-bb0e-bc88efd1fb82
earlyPrivateDidIdA = 6d4670d0-42a0-5978-9030-072fd06f45f0
earlyPrivateDidIdB = 20d9f6a9-8383-5c09-8134-a52954217b3b
```

For each fixture, run the relationship derivation for both `[A, B]` and `[B, A]`
and require its published result. Keys selected from the same DID document do
not change it. A different canonical DID pair yields a different birth. Only the birth uses
this formula: A0-to-A1 and B0-to-B1 transitions preserve the original R, even
though deriving a new birth from `[A1, B1]` would give another value.

The model has one relationship for the same address pair; protocol threads
provide multiple conversations. Two independently selected fresh pairs need
not denote the same relationship merely because the humans are the same. A
pair already claimed by another R through rotation is an index conflict under
[vault-events.md section 6.6](vault-events.md#relationship-fold-and-address-index), not permission to merge protocol identities.

<a id="101-contact-ids"></a>

<a id="contact-ids"></a>

### 5.1 Contact IDs

Explicit user contacts use UUIDv7. Automatic contact creation for a relationship
uses `contactId` above, unless that R already has a contact assignment. Reuse
the selected assignment under the operation lock; do not infer cryptographic
identity from a display name, contact merge or globally shared public address.
The contact tombstone remains effective for that R after rotation or erasure.

<a id="102-binding-and-contact-policy"></a>

<a id="binding-and-contact-policy"></a>

### 5.2 Binding and contact policy

Root binding is explicit admission under [channels.md](channels.md#admission).
A user-authored send can freeze root addresses offline; an inbound decision
names an already committed authenticated channel observation. A disclosure
may authorize admission through its invitation policy. An absent lookup or
an unsolicited control message does not authorize a root.

Opposite explicit first sends over one pair derive the same R. Equivalent
bindings reuse the same pin; incompatible root document snapshots conflict.
The identity formula provides deterministic naming, not evidence that a
channel should be admitted as a new root.

Once admitted, policy may assign the explicitly selected contact or the
deterministic default contact. Contact tombstones remain effective. An
unassigned channel has no automatic contact, profile, reply or privacy action.
Control input in an already admitted relationship may process permitted ACKs
without creating a contact. Profiles follow accepted message scope and this
assignment; shared addresses or keys do not transfer profile authority.

<a id="out-of-band-discovery"></a>

## 6. Out-of-band discovery

OOB, QR, directory, file, NFC or manual exchange discloses an ordinary address.
Reusable discovery SHOULD use an address allocated for public contact rather
than reveal one used privately. This policy is enforced at disclosure, not by
introducing different receive or relationship types.

```json
{
  "type": "https://didcomm.org/out-of-band/2.0/invitation",
  "id": "019b2a57-a947-7502-8fee-4d80d949dbcb",
  "from": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
  "body": { "goal": "Write to Alice" }
}
```

An OOB identifier supplies `pthid` for an interaction following that invitation;
it is not a relationship ID. One-use disclosure is consumed at matching durable
root-address acceptance under [vault-events.md section 5.8](vault-events.md#invitation-fold), independent of
contact creation, rotation or response. Tombstones and erasure do not reopen it.
Repeated input by the same R reuses consumption; different consumers conflict.

<a id="address-lifecycle"></a>

## 7. Address lifecycle

All addresses use `did.created`, `did.disclosed` and `did.retired`. Keys, Peer
document and bound route are immutable. Retirement stops new sends, disclosure
and relationship births at that address. Existing relationships retain its
historical recipient membership while the route remains receive-eligible.
Route/mediation retirement and configuration conflicts are terminal; temporary
outages are recoverable. These rules do not inspect public/pairwise policy.

Rotation changes one relationship's current end. It does not retire a shared
address, replace another relationship's address, rewrite an invitation or edit
an existing route. Keep old and new recipient routes through confirmation;
retire resources only when no other relationship or disclosure requires them.

<a id="ordinary-sending-and-birth-selection"></a>

## 8. Ordinary sending and birth selection

[vault-events.md section 9.2](vault-events.md#message-out) owns the outbound schema. Every send freezes one
`relationshipId`. A contact or address selection API determines that R
under the operation lock before intent commit, using existing address histories
first. For a new pair, nullable `birth` freezes the local DID entity and exact
peer DID spelling, allowing an offline send before resolution. These birth
addresses identify R permanently; later packages use its current ends.

No first reply, admission, handoff or private DID is required to send ordinary
messages. A root public address is eligible on either side. The default local
initiator SHOULD allocate a fresh private sender before selecting a new pair;
the API may explicitly choose another live address. This is a sender-selection
policy, not a restriction on relationship formation or interoperability.

<a id="ordinary-sending-requirements"></a>

### 8.1 Common requirements

All messages follow DIDComm authentication, exact recipient-method checks and
the ordinary content/header rules in [distributed-delivery.md](distributed-delivery.md). There is no
initial-specific size, message-type, age or lifetime acceptance policy. Hard
parser/resource limits and integrity checks remain. Missing `please_ack` or
`response_requested == false` does not prevent durable receipt or binding.

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

1. Select a live local address and exact peer address, choosing a fresh private
   local address by default for a newly initiated relationship.
2. Look up their canonical pair in committed relationship histories and queued
   birth selections. Reuse a unique R; defer missing evidence and expose conflicts.
3. For a genuinely new pair, derive [section 5](#symmetric-relationship-identity)'s R and freeze `birth` metadata.
4. Commit content, `message.out` and any selected `relationship.contactAssigned`
   decision. This operation performs no DNS, resolver, mediator or socket work.

<a id="prepare-and-send"></a>

### 8.5 Prepare and send

1. Check submitted/expiry/conflict/lifecycle predicates before network work.
2. Resolve the selected peer under [section 10.1](#did-resolution-requirements) and retain `peer.resolved`.
3. Under the operation lock defined for receive and outbound binding operations
   in [vault-events.md section 6.1](vault-events.md#receipt-and-relationship-evidence), recheck the pair and, for an unbound birth,
   commit the common `relationship.bound`. If a reverse-direction incoming
   message has already bound that pair, reuse its
   binding and pin; a fresh resolution controls key selection under [section 10.1](#did-resolution-requirements) and does not propose a competing pin. Missing evidence defers and an
   existing binding/index conflict blocks preparation.
4. Prepare a package in R using its current ends, required spelling and proof.
5. Verify local recipient registration before first disclosure, submit, and
   commit `delivery.submitted` on acceptance.

Until submission, permitted repacks preserve message ID, intent and R. Birth metadata
does not prevent repacking after a verified local or peer rotation. After
submission no duplicate, lost ACK or later address change reopens the message ID.

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
supplies no authenticated observation or pickup ACK. Missing relationship
membership by itself is not a pre-receipt wait.

After durable `message.in`, missing binding, historical membership, invitation
decisions or scope evidence becomes upper-layer recovery work. It withholds
effects and ultimate ACKs, not pickup ACK. Recovery reads the saved evidence;
it does not restart sender resolution for an already committed observation.
Timeout, reconnect, a new wire ID and erased bodies create no relationship.

Local wait state for an unopened delivery is runtime scheduling state. Retry
when its actual cryptographic/local prerequisite changes; unrelated evidence
does not retry it. Redelivery while that wait is retained does not restart
authentication. Loss of that local state re-enters ordinary authentication
with one shared bounded sequence when resolution is required. Such waits have
no client age cap and consume no sender-resolution budget. Mediator expiry
may remove that delivery but cannot erase portable channel or relationship
evidence already committed.

<a id="hard-pre-vault-gate"></a>

### 9.2 Hard pre-vault gate

Recipient classification begins before decryption once section 9.1 says local
key state is authoritative. An exact local key-agreement method is eligible
for receipt when its DID/key mapping is valid and conflict-free, its bound
route has no terminal dependency. DID retirement does not remove a retained
exact key from channel receipt eligibility; relationship membership is not read. Missing
recoverable prerequisites defer under section 9.1. If no recipient `kid`
identifies an eligible or recoverably pending method, the delivery is terminal
wrong-recipient input: a mediated delivery MUST be pickup-ACKed and MUST create
no `message.in`, contact or response effect.

Input to an eligible retired local key MUST pass through ordinary
decryption, authentication and durable receipt. It does not require renewed
recipient registration. Scope derivation is unchanged; current tombstones and
the availability of a usable local sender under [distributed-delivery.md section 8.1](distributed-delivery.md#freezing-an-ack-target-set) still govern subsequent work. Its mediation stays in the required
receiving set under [vault-events.md section 5.6](vault-events.md#mediation-fold) while its bound route
remains configured, non-retired and conflict-free and the mediation is usable.
Contact tombstones still apply under [vault-events.md section 13.6](vault-events.md#delete-a-contact).

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
relationship or recipient capacity, absence of current-message `please_ack`,
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
limits are examples of this gate. Supersession, invitation and relationship
policy are checked after receipt at scope admission.

<a id="integrity-checks-and-durable-receipt"></a>

### 9.3 Integrity checks and durable receipt

[channels.md](channels.md#receipt) defines channel receipt. Authentication
finishes before the operation lock; under it, recheck recipient/route state,
commit/reuse the exact sender resolution, and commit channel observation and
objects with a fresh receipt ordinal. Pickup ACK follows that durable prefix.
There is no birth/binding lookup in this transaction.

After receipt, [message.scoped](channels.md#message-scoped) records acceptance
into one admitted R. The writer validates exact historical key authorization,
continuity, unique membership, contact tombstones and invitation availability.
A new logical input from a superseded peer is refused scope. A matching
duplicate of an input already scoped in R follows ordinary duplicate rules.
Refusal creates no contact, ultimate ACK or response effect; its channel
observation remains durable and can be erased by ordinary policy.

A carried proof needs its exact pinned predecessor, a complete channel
observation witness and a validated transition before scope. Missing evidence
leaves the receipt unassigned; it never selects a new R. A retired local DID
takes no new relationship or new send, while existing accepted input may
still support permitted cleanup and historical duplicate processing.

Current-peer eligibility is decided when scope commits. Import validates its
frozen historical paths, not a hypothetical receive-time view reconstructed
from timestamps. Later valid extensions do not invalidate accepted input or
its unfinished effects. Incompatible evidence conflicts and suppresses new
work without moving committed effects to another identity.

<a id="5-did-profiles-and-resolution-evidence"></a>

<a id="did-profiles-and-resolution-evidence"></a>

## 10. DID profiles and resolution evidence

<a id="51-common-requirements"></a>

<a id="did-resolution-requirements"></a>

### 10.1 Common requirements

<a id="local-methods-and-pinned-peer-documents"></a>

#### Local methods and pinned peer documents

A locally controlled communication DID MUST have its fixed key-agreement and
authentication methods, seed-derived keys, validated numalgo-4 document and one
immutable `boundRouteId` under [vault-events.md section 5.2](vault-events.md#did-identity-and-keys). That document must
support authenticated messages and signing `from_prior`. Recipient lifecycle
is role-independent under section 9; sending and new births require a live DID.

Before the first relationship package is submitted, its sender MUST durably retain:

- the exact presented peer DID;
- the canonical peer DID;
- the exact RFC 8785 canonical resolved DID document under its raw DASL CID;
- the selected authentication `kid`;
- the selected key-agreement `kid`; and
- the resolution event ID.

This is the root binding snapshot used later to verify
`from_prior`. A current resolver result MUST NOT silently replace it. A later
resolution may recover missing bytes only when the raw CID of its canonical
document bytes equals the pinned document CID.

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

For an external Web rendezvous target, the sender pins the exact Web
document revision before first submission and later verifies `from_prior`
against that snapshot even when the currently published document has changed.
Key IDs are taken from that exact authorized document, not synthesized from a
vault key-generation naming convention.

Remote senders may use either a public DID, including
`did:web`, or a Peer DID. The receiver verifies the sender's exact DID spelling
and authorized key-agreement method under its supported resolver; it MUST NOT
require the peer to create a pairwise DID. An unsupported sender method fails
authentication and is terminal under section 9.2; unavailable resolution
defers receipt without pickup ACK within this section's sender-resolution
budget under section 9.1. Numalgo-4 first-disclosure requirements apply only
when that method is used. A same-DID authenticated
reply from any key authorized by the pinned initial document needs no
`from_prior`; a different DID requires verified continuation evidence to join
the relationship.

<a id="recipient-resolution-freshness"></a>

#### Recipient-resolution freshness

This section owns recipient-resolution freshness. A `did:peer:4` recipient
uses its retained, validated long-form document and needs no fresh resolution.
For every other supported DID method, the preparer MUST resolve after the
new outbound intent commits and commit that fresh `peer.resolved` before its
first package. Do this for each new message ID, including later sends in the same relationship;
an earlier outbound's snapshot, a local TTL or a resolver's stale/offline cache
cannot satisfy the requirement. An online conditional revalidation that
confirms the same document is sufficient and produces a new resolution event.
If no first package committed before interruption, repeat resolution on resume.
Unavailable resolution keeps the outbound retryable; it is not evidence of a
key change. Freshness is a producer ordering rule, not a clock comparison in
the portable fold.

Once a package exists, retry does not re-resolve and uses its exact bytes.
Permitted repacking of that message ID reuses its retained snapshot, or the exact
carrying-inbound snapshot of a committed verified continuation to a new peer
end; it never obtains a fresh document merely to replace a pinned key or route.
First-package resolution uses the failure classification below, including
the outbound `peer-key-changed` result. A fresh resolution remains evidence for
current preparation, never authority to extend a relationship's chain.

<a id="sender-authentication-freshness"></a>

#### Sender-authentication freshness

This section also owns sender-authentication freshness. A `did:peer:4` sender
authenticates against its validated long-form document, retained or supplied
with this disclosure. For every other supported method, whenever a delivery
enters or resumes authentication under section 9.1, the receiver MUST resolve
the presented sender DID and authenticate its authcrypt key against that
current document. Unopened-delivery waits follow the suspension rule below. Post-receipt
relationship recovery uses saved authentication evidence. Online conditional revalidation is sufficient; a local
TTL or stale/offline cache is not. A retained
`peer.resolved` may be reused only when that freshly validated document's raw
CID equals its `documentCid` and its `localKeyName`, `peerPublicKey`, `did` and `presentedDid`
match the observation; otherwise commit new evidence before `message.in`.
A key absent from the current document fails section 9.2 even when it belongs
to `peerChain(R)`: the chain scopes already authenticated observations, it does
not authenticate new ones. Unavailable resolution defers without pickup ACK
only within the budget below; it cannot fall back to a stale snapshot.

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
or a new binding, including for a first send; unavailable answers keep
the outbound retryable. Missing retained historical evidence still follows
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

Committed channel observations are outside this accounting: relationship
admission/recovery reads their retained snapshots without network resolution.
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

For a committed channel observation, evidence changes schedule relationship
admission, transition verification or scope recovery. They do not repeat the
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
or scope. As with recipient freshness, this is a producer ordering rule, not
an event-time or fold-clock test. Historical `from_prior` verification still
uses its pinned predecessor snapshot independently of current sender
authentication.

<a id="key-changes-without-did-continuation"></a>

#### Key changes without DID continuation

A key change under the same canonical peer DID without verified continuation
is not continuation of an existing relationship. Phase 1 uses the following
policy; a fresh `peer.resolved` never extends `peerChain(R)`:

- For a new package to an existing relationship's peer DID, including a later
  send, select an authorized key already in `peerChain(R)` under
  [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity), with the canonical DID and key matching
  the same pinned or verified transition snapshot. If a successful fresh
  resolution offers no usable key with that evidence, or resolution fails
  definitively under the classification above, append message-scoped terminal
  `delivery.failed(code="peer-key-changed", packageId=null)` before preparation.
  Do not append an incompatible package or binding and
  do not mark the whole relationship conflicted. Resolution unavailability
  remains retryable. An already prepared package continues to use its
  exact retained snapshot; it does not re-resolve to replace its key.
- For an authenticated inbound addressed to any historical local address of `R`,
  whose canonical sender DID equals `currentPeerDid(R)` but whose key is outside
  `peerChain(R)` and which carries no `from_prior`, preserve the observation
  and exact resolution evidence but derive no execution scope. Process no ACK
  or effect. Surface a `peer-key-changed` diagnostic under
  [vault-events.md section 7.6](vault-events.md#contact-fold) instead of silently waiting for more evidence.
  A superseded sender node follows section 9.3's scope-admission rule.
  Missing binding/chain evidence defers scope. A carried proof follows
  [channels.md section 3.1](channels.md#receipt)'s authentication boundary:
  failed unpack cannot produce receipt, while an independently authenticated
  channel observation retains a known invalid continuity claim without scope
  or effects. It cannot use this no-proof path. Missing evidence or ambiguous
  relationship attribution is not a bad cryptographic signature.
- To restart without a valid peer rotation to a different DID, use an explicit
  new send using a fresh local communication DID, producing a new
  relationship and binding. Do not rewrite the old binding or replay its messages.
  A different selected transport key never changes the address-pair ID. A
  carried or committed continuation uses section 12; repeated DID strings do
  not replace the required authorization evidence.

Missing historical snapshot material is a deferred verification state, not
proof that a rotation is invalid.

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
plaintext `from`. Within each relationship, a root sender MUST use its long
form for every package until a complete authenticated channel observation
confirms that exact address against this relationship's validated prefix under
[vault-events.md section 6.5](vault-events.md#relationship-localtransitioned).
A successor uses its long form and the frozen
proof until its own confirmation in that relationship. Confirmation in another
relationship does not satisfy either condition, even for a shared public
address. Later messages in the confirmed relationship may use the short form;
they do not rewrite the retained predecessor spelling. Application `to`,
Routing `forward.next` and mediator registration use the canonical short form
once the peer document is known. Registration is verified before disclosure.

For authcrypt, plaintext `from` and the DID portion of protected `skid` are
byte-identical; decoded `apu` is the exact UTF-8 `skid` string. If the library
represents the sender only through `apu`, its DID portion still equals `from`.
The fragment identifies an authorized key-agreement method in that exact
document. Do not mix long and short forms in one package. A short form with no
known long-form document fails authentication; it does not create a relationship.

The predecessor's exact first-disclosure long form is used for `from_prior.iss`
and its protected authentication `kid`; `sub` uses the successor's long form.
A receiver compares predecessor DID spellings and authentication-method IDs
under [vault-events.md section 6.4](vault-events.md#relationship-peertransitioned), using only the method's validated spelling
equivalence and the pinned document. Exact wire spellings remain retained.
A successor may bind another route or mediation for privacy. Neither changing
transport preference nor choosing another service changes an existing DID.

<a id="early-private-address-policy-and-notifications"></a>

## 11. Early private-address policy and notifications

The core does not require private addresses. Estoc's default local policy is:
when an application input obtains valid committed scope in R whose current local address
is its birth address, prefer a fresh private successor if that address has
a committed `did.disclosed` with `as == "oob"` or `uses == "many"`, or occurs
in another relationship's local history. An already
private address needs no change. No policy requires the peer to rotate.

Under the operation lock, reuse any existing local transition. Otherwise select
one eligible committed application observation with no already selected natural,
pure-ACK or notification response, validate its exact-root
confirmation, and atomically commit a fresh successor and a normal
`relationship.localTransitioned` whose `triggerEventId` references that observation.
The allocation MAY use [section 5](#symmetric-relationship-identity)'s endpoint-specific deterministic ID under
[vault-events.md section 6.5](vault-events.md#relationship-localtransitioned); otherwise it uses a fresh UUIDv7.
Route, proof and trigger are frozen by this commit. A retry reuses them.
The public/reuse predicate is a producer policy choice evaluated there, not
a fold-time test that can invalidate a committed edge. If an old input already
has a response, reuse it and wait for a new eligible trigger or an explicit
local rotation; never rewrite its response to add a notification. A
manual policy may keep using the root, rotate later, or use a normal reply
before rotation; the relationship already exists in each case.

<a id="automatic-response-selection"></a>

### 11.1 Automatic response selection

A non-null local-transition trigger requires one deterministic notification
effect recoverable from that exact input, even if the process exits before
its response intent, subject to ordinary erasure and contact lifecycle. Select
an ordinary natural protocol response when it is
deterministic from the input, otherwise Empty. For Trust Ping, use
`ping-response` only when `response_requested` is not false; otherwise use
Empty for the address notification. Human-authored content may disclose the
same rotation in an ordinary send, but does not replace a required committed
trigger's idempotent automatic effect.

Use the trigger's relationship execution ID and the natural protocol tuple,
or [distributed-delivery.md section 8.2](distributed-delivery.md#deterministic-pure-ack)'s pure-ACK/Empty tuple. Merge eligible
requested ACK targets into this one response under that document's section
8.1. Do not create a second ACK-bearing response for the same execution. The
notification freezes `pleaseAck == [""]`; its `createdTime` is the trigger's
nullable creation time and its expiry is null. Its wire thread follows the
natural protocol, or the Empty profile. Rotation `iat` is independently sampled
once at the local edge, never copied from message creation time.

Empty, `ping-response`, Report Problem and other control input cannot trigger
another early-privacy notification. A generic pure ACK never requests an ACK.
Receipt of a notification may confirm a peer's transition and produce a
permitted ACK; it is not a recursive handoff request.

For the first [section-5](#symmetric-relationship-identity) fixture's R and wire ID
`019b4d12-090a-7c3b-92f7-ac2c51f50db4`, the Trust Ping notification vectors are:

```text
executionId = 148d31a6-66d0-5687-a1f1-2c2c75ac7817
handlerId   = https://didcomm.org/trust-ping/2.0
effectKind  = ping-response
ordinal     = 0
effectKey   = VXXR0fOxbJlvgykd90BsYKbbh4K85FsNhordsPbFw7Y
messageId   = 8e0d1442-50f3-57b6-a356-7939851af021
```

For Empty with the same execution:

```text
effectKey = HTh08t3qCpxpGnvXXQq7ClgPUIhSNi7d6uSkk27RAWA
messageId = 7e6a39e8-57fb-5cca-9460-edfc806a2297
```

<a id="proof-and-ordinary-message-headers"></a>

### 11.2 Proof and ordinary message headers

All local changes use [vault-events.md section 6.5](vault-events.md#relationship-localtransitioned)'s one JWT construction.
There is no initial-handoff proof variant. The package's sender is the current
local end, recipient the current peer end, and proof the current local edge's
exact JWT while unconfirmed. Ordinary content, Empty and Trust Ping use the
same spelling, authentication and confirmation rules.

<a id="registration-and-submission"></a>

### 11.3 Registration and submission

Persist the chosen successor/edge before recipient-registration and send work.
Verify its live mediated registration before first disclosure. Commit exact
package bytes before submission, then commit `delivery.submitted` on acceptance.
Lost notifications do not cause automatic resubmission after that boundary;
another ordinary message may carry the same unconfirmed proof.

<a id="confirmation-and-overlap"></a>

### 11.4 Confirmation and overlap

Authenticated input in R at the exact current successor confirms it. Input at
another local historical address does not. Until confirmation, every new
package from this end uses its long form and retained proof. Afterward, new
packages omit the proof; exact prepared packages are not rewritten. Predecessor
receipt routes overlap as specified in [vault-events.md section 6.5](vault-events.md#relationship-localtransitioned).
A manual rotation can solicit that input with the response-requesting ordinary
Trust Ping in [vault-events.md section 13.7](vault-events.md#rotate-a-local-relationship-address).

Address confirmation of the exact current successor follows
[vault-events.md section 6.5](vault-events.md#relationship-localtransitioned): the
observation's channel row must be complete, independently authorized by this
R's validated prefix, and free of the group contradictions defined there.
It does not require its own `message.scoped`. Ordinary messages, ACKs and
protocol errors use the same rule.

<a id="peer-address-changes"></a>

## 12. Peer address changes

Authenticate B1 and durably record C(A, B1) under the channel receipt rules.
For relationship continuation, use the carried `iss=B0` as a candidate hint,
then verify against the exact predecessor snapshot pinned by that R. Require
the original `sub`, sender spelling, authorized method and signature, and one
complete channel observation witness under [VE peer transitions](vault-events.md#relationship-peertransitioned).

Commit/reuse the relationship-scoped transition before `message.scoped` and
effects. Missing or conflicting history leaves the channel receipt unassigned
or refused. A proof is not a global DID alias and creates no new R.

Competing successors, cycles and incompatible pins conflict without an
arrival-order winner. Independent local and peer transitions commute. Once
the peer advances, a new old-peer logical input receives no scope; already
accepted inputs retain their frozen historical paths. These post-receipt rules
implement the application's treatment of superseded traffic under
[DIDComm DID Rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation).

<a id="remote-errors-and-integrity-failures"></a>

## 13. Remote errors and integrity failures

Relationship admission is a local decision with no new Estoc wire-level
admission/decline response. Integrity failures follow section 9; keeping a
public address does not itself refuse scope. Remote peers may send ordinary
protocol errors.

Report Problem uses its standard `pthid` correlation to the triggering
message's `thid`, or wire ID when absent, under
[DIDComm Problem Reports](https://identity.foundation/didcomm-messaging/spec/v2.1/#problem-reports).
Other protocols use their defined correlation. Validate the report in the same
R; explicit ACKs prove only receipt. A no-response error with no rotation or
ACK request is a control observation under [vault-events.md section 10.6](vault-events.md#inbound-message-and-execution-fold).
It creates no privacy reply or new contact. Its retained reason can appear
beside one uniquely correlated outbound; erasure removes that diagnostic.
It does not terminate R or reopen a submitted message ID. Its authenticated
observation may supply exact-address confirmation under
[vault-events.md section 6.5](vault-events.md#relationship-localtransitioned),
independently of its diagnostic, body availability or ACK contents. This
confirms address knowledge without asserting application acceptance or
generating a reply.

<a id="retry-replacement-and-address-rollover"></a>

## 14. Retry, replacement and address rollover

All outbound messages use bounded local retry before committed submission:

```text
minimum automatic retry interval = 30 seconds
exponential backoff cap = 21600 seconds
transport-attempt budget per wire ID per active runtime = 32
mandatory absolute stop = expires_time, when non-null
```

The sender SHOULD use these defaults or a stricter local policy. Count before
transport invocation, including unknown outcomes, with shared accounting per
message ID. Restart/restore may reset this local budget but never a committed
`delivery.submitted`. Expiry is immutable and stops new work at equality. No
durable pre-call reservation or lifetime attempt cap is implied. Unknown
outcomes reuse exact eligible packages; absent submission evidence does not
prove no transport call occurred.

A new explicit send uses a new message ID in the same R. It does not rederive R from
current keys or addresses. Permitted repacks change address/proof evidence
only along that R's verified chains while preserving intent. A submitted message ID
never reopens for missing ACK, lost confirmation, duplicate input or rotation.

A Peer DID's embedded keys/route cannot change in place. A new address with a
scoped rotation continues R; publishing a replacement discovery address does
not update existing relationships or old invitations by itself. Mediation
preference affects new route choices only. Vault-wide route migration remains
outside this per-relationship profile.

<a id="phase-1-execution-and-deferred-replication"></a>

## 15. Phase-1 execution and deferred replication

Phase 1 permits exactly one active writable full vault runtime. It may run in a
local application or on a server. It uses ordinary Coordinate Mediation and
account-scoped Message Pickup; no `replica_id` appears in peer or mediator wire
messages.

`replica-mediation/1.0` and `vault-sync/1.0` are deferred. Their absence MUST
NOT block local vault operation, rendezvous, pairwise communication, export or
seed recovery. The local `replica_id` remains the event author so replication
can be added later without changing event envelopes.

Concurrent writers, automatic-rotation coordination and per-replica pickup
are not phase-1 conformance claims; accidental divergent histories still have
the specified import conflict rules.

<a id="privacy-abuse-interoperability-and-security"></a>

## 16. Privacy, abuse, interoperability and security

Publicly disclosed addresses are correlatable within their audience. Fresh
pairwise allocation reduces address reuse, but the mediator may still correlate
addresses registered under one account. A new address may use another route;
neither a new DID nor a shared route proves a different human or contact.

The default allocator avoids reusing private addresses and public disclosure
avoids revealing them. Core authentication, relationship formation and rotation
do not inspect an address role. One local DID can occur in multiple R histories;
only ambiguous claims on the same address pair conflict. A scoped change never
globally links or retires all uses of a shared DID.

All otherwise valid input is received without initial age/type/lifetime policy.
Authentication, one-use invitation integrity, source rate limits and actual
storage/ingress exhaustion remain. Ordinary contact deletion and erasure remain
available. Current sender-resolution failure does not bypass authentication or
historical proof verification.

The UI MUST NOT describe a public/public or public/pairwise relationship as
incomplete merely because no rotation occurred. Rotation confirmation and ACK
receipt information are separate. An unconfirmed terminal successor still has
the explicit recovery limitation in [vault-events.md section 6.5](vault-events.md#relationship-localtransitioned); submitted
notification loss is recovered only by another explicit ordinary send, not
automatic resubmission of the completed message ID.

<a id="required-conformance-cases"></a>

## 17. Required conformance cases


<a id="did-identity-and-relationship-birth-rz-1-rz-12"></a>

### DID identity and relationship birth (RZ-1–RZ-12)

1. <a id="rz-1"></a> Peer-DID first disclosure validates its long form, canonical short form, fixed keys and bound route without DNS.
2. <a id="rz-2"></a> An external Web DID pins exact document bytes; a later network revision cannot replace historical proof evidence.
3. <a id="rz-3"></a> No emitted message uses an Estoc rendezvous request, accept or decline type, or a wire relationship ID.
4. <a id="rz-4"></a> Public/public, public/pairwise and pairwise/pairwise pairs use the same channel receipt and separate explicit admission rules.

5. <a id="rz-5"></a> Run both [section-5](#symmetric-relationship-identity) relationship fixtures in both directions and obtain each published R, including the higher-sorting A fixture. Distinct canonical pairs differ.
6. <a id="rz-6"></a> Peer long and short spellings normalize to one birth address. No shared key, endpoint, label or resolver alias merges distinct DIDs.
7. <a id="rz-7"></a> Opposite explicit first sends over one root pair admit the same R. Opposite unsolicited receipts alone create channels without creating R.

8. <a id="rz-8"></a> A different selected key within one pinned peer document does not change R or create a second contact.
9. <a id="rz-9"></a> Root public addresses can send ordinary content before a reply, private allocation or rotation confirmation.
10. <a id="rz-10"></a> Offline birth intent commits without DNS or a mediator. Resolution later creates the common binding before its first package.
11. <a id="rz-11"></a> An incoming binding that precedes preparation of an opposite queued birth is reused without replacing its pin. Fresh resolution selects an already authorized key or follows [section 10.1](#did-resolution-requirements)'s failure rule; imported incompatible binding pins conflict.
12. <a id="rz-12"></a> One shared address used with two different peers forms two explicitly
    admitted Rs without exclusive-local-DID ownership conflict.

<a id="address-changes-and-ordinary-replies-rz-13-rz-25"></a>

### Address changes and ordinary replies (RZ-13–RZ-25)

13. <a id="rz-13"></a> A0-to-A1 in R_AB leaves R_AC and public disclosure of A0 unchanged. Pairwise allocation avoids reuse as policy.
14. <a id="rz-14"></a> Birth R remains stable after either or both endpoints rotate; current-address derivation is never substituted.
15. <a id="rz-15"></a> Early privacy rotation uses the ordinary local-transition event, a fresh successor with an optionally deterministic endpoint-specific ID, and a frozen trigger.
16. <a id="rz-16"></a> A crash after successor/edge commit reuses the exact route, keys, JWT, iat and notification trigger.
17. <a id="rz-17"></a> Missing optional private allocation does not prevent binding or a normal public-address reply.
18. <a id="rz-18"></a> Normal Trust Ping selects ping-response; response_requested false is still received and may get an independent Empty rotation notification.
19. <a id="rz-19"></a> Content-first Basic Message remains its own application message without a rendezvous wrapper.
20. <a id="rz-20"></a> Empty, ping-response and Report Problem can bind and process eligible ACKs but create no contact or recursive privacy notification.
21. <a id="rz-21"></a> Generic pure ACK has no ACK request. A privacy notification and natural response share the execution's one ACK-bearing selection.
22. <a id="rz-22"></a> A notification carries the current successor's exact proof and long form; later proof-free messages use retained scoped transition evidence.
23. <a id="rz-23"></a> Input at the exact successor confirms rotation; input at a predecessor does not. Explicit ACK naming a message remains separate.
24. <a id="rz-24"></a> No second local edge is authorized before the peer knows its predecessor. A normal incoming root-address message supplies first-edge confirmation.
25. <a id="rz-25"></a> Both live recipient routes remain during rotation overlap. Shared routes/addresses survive until unrelated users no longer need them.

<a id="peer-continuation-and-integrity-rz-26-rz-35"></a>

### Peer continuation and integrity (RZ-26–RZ-35)

26. <a id="rz-26"></a> Receive a successor with proof at the original public address and at a private historical address: both locate and extend the same R.
27. <a id="rz-27"></a> Crossed A1-to-B0 and B1-to-A0 rotations update separate ends of one R and converge to A1/B1 in either fold order.
28. <a id="rz-28"></a> A forged proof, wrong sub, wrong recipient relationship, unauthorized signing key or incompatible pinned document cannot extend a chain.
29. <a id="rz-29"></a> Repeated proof reuses its transition and pinned successor document; later resolution cannot enlarge authorized keys.
30. <a id="rz-30"></a> Competing successors, cycles and an address pair claimed by distinct Rs are conflicts without automatic merge or event-order winner.
31. <a id="rz-31"></a> Missing binding/transition references defer relationship scope through partial import; authenticated channel receipt still commits and pickup-ACKs. An unresolved continuation creates no new R.

32. <a id="rz-32"></a> A current peer DID using an unpinned current key is retained as a no-scope diagnostic; no new R, ACK or effect is created. A superseded sender first follows section 9.3.
33. <a id="rz-33"></a> After B0-to-B1 commits in R, a new logical input from B0 to any local
    address in R is channel-receivable with pickup ACK but refused scope.
    A matching input already scoped in R follows duplicate handling without
    a new response obligation. A later B1-to-B2 never invalidates retained
    accepted B1 input; another R in which B0 remains current still admits
    authenticated B0 input normally.

34. <a id="rz-34"></a> A matching committed root scope consumes a one-use invitation before contact/rotation work. Plain receipt, a continuation or matching pthid alone consumes nothing.

35. <a id="rz-35"></a> Same-consumer invitation reuse is idempotent. An unavailable invitation refuses new consumer scope while retaining channel receipt; imported incompatible consumers conflict. Crash, deletion and erasure never reopen committed consumption.

<a id="recipient-lifecycle-rz-36-rz-38"></a>

### Recipient lifecycle (RZ-36–RZ-38)

36. <a id="rz-36"></a> A retired local DID takes no new relationship or send, but its retained exact key may receive channel observations while its route is eligible, independent of R history.

37. <a id="rz-37"></a> A terminal route or mediation rejects input; temporary missing key/route/recovery prerequisites defer without pickup ACK.
38. <a id="rz-38"></a> Wrong recipient DID or method fragment, authentication-purpose kid and unknown Peer short form are terminal before application state.

<a id="resolution-freshness-and-budgets-rz-39-rz-45"></a>

### Resolution freshness and budgets (RZ-39–RZ-45)

39. <a id="rz-39"></a> Every new delivery, including a duplicate, authenticates its current sender. Recovery of already committed channel evidence does not re-resolve the sender to admit scope.

40. <a id="rz-40"></a> NXDOMAIN and no usable address-family data are definitive; one-family NODATA alone is not. SERVFAIL, timeout and TLS failure use bounded unavailability.
41. <a id="rz-41"></a> Per-delivery sender-resolution retries count before calls, schedule without redelivery, share accounting and stop at their finite budget or active-time retention bound. At a sequence's first attempt, a future known absolute deadline caps active time by its remaining interval, including after local-state reset; an advertised duration also caps active time. A past or unknown deadline supplies no absolute-deadline cap. Unknown retention still requires a finite budget.
42. <a id="rz-42"></a> Budget exhaustion pickup-ACKs terminal input without message.in. Locked-vault, local recovery and other non-resolution deferrals consume neither attempts nor active time, including when they interrupt a sequence. A wait that crosses an absolute deadline does not itself exhaust the retained sequence on resumption; its previously consumed attempts and active time remain counted. A permitted retry after loss of accounting, or a redelivery after loss of local wait state whether or not accounting survived, instead starts a fresh finite sequence under [section 10.1](#did-resolution-requirements) when the sender method requires resolution. Neither path permits terminal ACK solely because the wait crossed the deadline.
43. <a id="rz-43"></a> A successful current resolution within budget permits normal durable receipt. Imported receipts use retained evidence without fresh network requests.
44. <a id="rz-44"></a> Fresh recipient resolution occurs for each new message ID when required; repacking follows pinned/verified evidence and never silently changes same-DID keys.
45. <a id="rz-45"></a> Resolution failure before any prior pin uses neutral diagnostics, not an unsupported claim that a key was replaced.

<a id="completion-contact-policy-and-phase-boundary-rz-46-rz-54"></a>

### Completion, contact policy and phase boundary (RZ-46–RZ-54)

46. <a id="rz-46"></a> Unsubmitted birth and ordinary intents both repack after rotation, preserving message ID, R, intent and automatic effect identity.
47. <a id="rz-47"></a> Committed submission stops all automatic repack/retry, including notification/ACK loss and duplicate receipt.
48. <a id="rz-48"></a> Expiry and local retry defaults remain independent of incoming message age, receipt acceptance and rotation iat.
49. <a id="rz-49"></a> Contact assignment is separate from binding. A control-only R has no contact; a selected existing contact wins local policy before automatic creation.
50. <a id="rz-50"></a> Conflicting contact assignments remain visible; display merges do not merge R, authorize rotation or change ACK scope.
51. <a id="rz-51"></a> Deleting a contact blocks new effects and cleans up late scoped input without retiring addresses still used by another relationship/disclosure.
52. <a id="rz-52"></a> A remote problem report is displayed only beside a uniquely correlated outbound while its body is available; it changes no submission or relationship state.
53. <a id="rz-53"></a> An unconfirmed successor with a terminal route cannot branch or roll back; temporary outage does not invoke this terminal limitation.
54. <a id="rz-54"></a> Phase-1 operation needs no replica-mediation or vault-sync implementation and discloses no replica ID to peers.

<a id="receipt-recovery-and-evidence-fixtures-rz-55-rz-61"></a>

### Receipt recovery and evidence fixtures (RZ-55–RZ-61)

55. <a id="rz-55"></a> Channel receipt commits before inbound binding and scope. Crash after
    receipt leaves recoverable channel evidence eligible for pickup ACK;
    crash after binding but before scope additionally leaves reusable pin
    evidence, without invitation consumption or ultimate ACK. Recovery uses
    saved authentication, not redelivery. The shared operation lock serializes
    admission lookup, pin reuse and scope commit against outbound admission.

56. <a id="rz-56"></a> A public root confirmed in R_AB still uses its long form in new R_BC until input confirms that exact root in R_BC. A predecessor pin whose presentedDid is short and a valid equivalent long-form iss/kid verify against the same pinned method; unrelated spellings or keys fail.
57. <a id="rz-57"></a> A carrier whose sender can independently authenticate is received on its fixed channel while missing predecessor history defers scope. Restore binding/prefix and verify the exact proof to scope it in the original R. If unpack cannot authenticate without cryptographic material, no receipt or pickup ACK is fabricated. A later proof-free channel receipt never implicitly creates R. See CH-3/4/12/13.

58. <a id="rz-58"></a> Long-form disclosure and later short-form lookup retain the same numalgo-4 document bytes and CID under [vault-events.md section 4.4](vault-events.md#peer-resolved), across resolver implementations and import. Neither lookup spelling nor optional resolver transformations create another binding/transition pin.
59. <a id="rz-59"></a> did:web:Bob.Example and did:web:bob.example remain distinct identity strings and birth-pair inputs. A returned document id matching only after host case folding fails; URL/DNS processing cannot rewrite either retained DID.
60. <a id="rz-60"></a> Validated message/profile evidence reaches a contact only through relationship.contactAssigned. Reusing a public address or key in another R does not share names or disclosure history; changing either end within one R preserves that history and its contact tombstone.
61. <a id="rz-61"></a> A did:web delivery that authenticates commits channel evidence and pickup-ACKs even while R evidence is missing. Repeated upper-layer recovery/import/reopen makes no current resolver calls. A genuinely new network delivery authenticates afresh with one bounded sequence; unopened cryptographic/local waits suspend active accounting without a client age cap.
