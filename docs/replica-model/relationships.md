# Estoc channel address and contact policy 1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **draft, phase 1** — ordinary DIDComm channels, discovery and
early private-address allocation for one active writable vault runtime.
Multi-replica mediation, vault synchronization and [mutable channel DIDs](did-web-channels.md) are deferred.
Phase-1 channel endpoints support only `did:peer:4`; mediator DID resolution
is independent of that restriction.

This document uses **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**
and **MAY** as described in BCP 14 when they appear in all capitals.

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
- [5. Channel pairs and contact identifiers](#symmetric-relationship-identity)
- [6. Out-of-band discovery](#out-of-band-discovery)
- [7. Address lifecycle](#address-lifecycle)
- [8. Ordinary sending and channel selection](#ordinary-sending-and-birth-selection)
- [9. Uniform receipt](#uniform-receipt)
- [10. DID profiles and resolution evidence](#did-profiles-and-resolution-evidence)
- [11. Early private-address policy and notifications](#early-private-address-policy-and-notifications)
- [12. Peer address changes](#peer-address-changes)
- [13. Remote errors and integrity failures](#remote-errors-and-integrity-failures)
- [14. Retry, manual resend and address rollover](#retry-replacement-and-address-rollover)
- [15. Phase-1 execution and deferred replication](#phase-1-execution-and-deferred-replication)
- [16. Privacy, abuse, interoperability and security](#privacy-abuse-interoperability-and-security)
- [17. Required conformance cases](#required-conformance-cases)

</details>
<!-- reading-guide:end -->

<a id="what-it-is-for"></a>

## 1. What it is for

A fixed channel records communication between two DIDs. Verified links connect
channels when one endpoint rotates. Each message stays in its actual channel.
[Channels](channels.md#model) owns that model.

Public/rendezvous and pairwise describe disclosure and allocation policy, not
different message schemas or receipt permissions. A shared DID can participate
in several channels; a local continuity decision does not change all of them.
Useful content may be the first message. Trust Ping is the no-content default.
Contacts organize channel histories without protocol authority.

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
- **Channel** — a fixed ordered pair of distinct canonical local and peer DIDs.
- **Invitation consumption** — a durable decision assigning a one-use OOB disclosure to the peer authenticated by an exact source receipt.
- **Continuity link** — a fold-derived, verified replacement of one endpoint in one channel context.
- **Contact** — local names, preferences and direct channel selections for display.
- **Application input** — authenticated input other than control input,
  Empty, Trust Ping ping-response or Report Problem for privacy-trigger purposes.
- **Rotation notification** — a dedicated Empty intent disclosing a selected local rotation.
- **Rotation confirmation** — complete authenticated input proving knowledge of
  the exact successor in its validated channel context; it is not a peer ACK.

<a id="invariants"></a>

## 4. Invariants

Address policy follows [channel identity](channels.md#channel-identity),
[continuity](channels.md#continuity), [operation eligibility](channels.md#operation-eligibility)
and [dispatch authority](channels.md#fixed-outbound-channel). Allocation,
disclosure and contact preferences do not alter those rules. Peers address DIDs;
phase 1 has one active executor.

<a id="10-symmetric-relationship-identity"></a>
<a id="symmetric-relationship-identity"></a>

## 5. Channel pairs and contact identifiers

Channels use [canonical local/peer DID pairs](channels.md#channel-identity);
contacts directly select those pairs.

<a id="101-contact-ids"></a>
<a id="contact-ids"></a>

### 5.1 Contact IDs

Contacts use UUIDv7 and are created or assigned only by explicit product policy.
Creation records a non-empty set of complete channel pairs under
[vault events](vault-events.md#contact-created), possibly before receipt or peer
resolution. A discovered peer DID therefore needs a local-DID choice first.

<a id="102-binding-and-contact-policy"></a>
<a id="binding-and-contact-policy"></a>

### 5.2 Operation and display policy

Opposite first sends can select the same channel without role arbitration.
Each operation retains its own verification evidence. Contact selections affect
display and send choices under [the contact fold](vault-events.md#contact-fold),
not protocol authority. Deletion that also blocks communication must append
concrete channel denials separately.

<a id="out-of-band-discovery"></a>

## 6. Out-of-band discovery

OOB, QR, directory, file, NFC or manual exchange discloses an ordinary address.
Reusable discovery SHOULD use a public-contact address. Record the disclosed
content as an OOB invitation or direct DID under [did.disclosed](vault-events.md#did-disclosed),
independently of its publication medium. An OOB ID supplies `pthid`, never
channel identity. One-use invitations are consumed automatically under
[channels.md](channels.md#invitation-consumed); many-use invitations and direct
disclosures have no exclusive consumer. Availability follows
[the invitation fold](vault-events.md#invitation-fold).

<a id="address-lifecycle"></a>

## 7. Address lifecycle

`did.created`, `did.disclosed` and `did.retired` retain their local key/route
semantics. Retirement blocks new sending, disclosure and invitation consumption. Exact
retained keys may receive while their routes remain eligible. Explicit route
or mediation retirement stops transport; temporary outage remains recoverable.

Rotation is a channel link, not global address retirement. Keep old and new
recipient routes through exact-successor confirmation. It changes selection
for newly created intents only. An existing fixed-channel message never moves
to the successor; explicit key/route retirement can make its retry impossible.
Old-peer inputs remain receivable. At creation of new work derived from
old-peer input, check current verified supersession under [channels.md](channels.md#continuity),
including when the input was received before that supersession became known.
Supersession alone neither prohibits an explicit user send to an eligible old
address nor blocks manual dispatch of an already committed intent.

<a id="ordinary-sending-and-birth-selection"></a>

## 8. Ordinary sending and channel selection

Before intent commit, select one exact eligible channel explicitly or through
[the contact's send choices](vault-events.md#contact-fold). Defaults follow the
unique verified head under [channel selection](channels.md#fixed-outbound-channel);
an explicit address choice can start a new channel without a handshake.
Existing intents keep their channels.

<a id="ordinary-sending-requirements"></a>

### 8.1 Common requirements

All messages follow DIDComm authentication, exact recipient-method checks and
[ordinary content/header rules](distributed-delivery.md). The [receipt gate](#hard-pre-vault-gate)
applies equally to first and later messages; ACK and Ping-response preferences
do not prevent receipt.

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
wrapper, extra wire contact field or preliminary handshake is required.
Content remains application content regardless of whether a rotation is carried.

<a id="select-addresses-and-commit-intent"></a>

### 8.4 Select addresses and commit intent

1. Select a live local DID and canonical peer DID, validating supplied Peer long forms.
2. Derive their fixed channel and direction, then check local send policy.
   Each preparation resolves its own peer evidence.
3. Commit content and `message.out` with this channel, sender and recipient.
   This offline action does no DNS, mediator or socket work.

<a id="prepare-and-send"></a>

### 8.5 Prepare and send

Follow [the send procedure](distributed-delivery.md#send-an-ordinary-message)
and [package preparation](distributed-delivery.md#preparing-a-package) within
the committed channel, under [dispatch authority](channels.md#fixed-outbound-channel).

<a id="uniform-receipt"></a>

## 9. Uniform receipt

<a id="deferred-delivery"></a>

### 9.1 Deferred delivery

Pre-receipt waits concern only the ability to identify the exact local
key-agreement method, recover local key/document/route state, safely open the
envelope, authenticate the current sender, or commit durable channel evidence.
Locked/incomplete recovery is not evidence that a recipient is foreign.
Current-sender authentication uses locally available validated numalgo-4
material under section 10.1; it does not start a network resolution sequence.

The [phase-1 adapter](channels.md#carried-proof-and-library-boundary) authenticates
the current sender without verifying `from_prior`. Missing predecessor material,
failed proof verification, invitation decisions or continuity history cannot
defer receipt or pickup ACK. Failed envelope authentication supplies no
authenticated observation: a recoverable prerequisite waits here, while a
definitive rejection follows section 9.2's terminal pickup-ACK path.

After durable `message.in`, each consumer waits only for its required evidence.
These upper-layer waits do not withhold pickup ACK. Recovery uses saved sender
evidence without restarting resolution; invitation recovery follows
[its own rules](channels.md#invitation-consumed).

Wait state for missing local receive prerequisites is runtime scheduling state.
Retry when its actual local receive prerequisite changes; unrelated evidence
does not retry it. Redelivery while that wait is retained does not restart
authentication. Loss of that local state re-enters ordinary authentication
against the required local material. Such waits have no client age cap;
network retry budgets do not apply to them. Mediator expiry
may remove that delivery but cannot erase portable channel or continuity
evidence already committed.

<a id="hard-pre-vault-gate"></a>

### 9.2 Hard pre-vault gate

Recipient classification begins before decryption once section 9.1 says local
key state is authoritative. An exact local key-agreement method is eligible
for receipt when its DID/key mapping is valid and conflict-free, its bound
route has no terminal dependency. DID retirement does not remove a retained
exact key from channel receipt eligibility; invitation use or display membership is not read. Missing
recoverable prerequisites defer under section 9.1. If no recipient `kid`
identifies an eligible or recoverably pending method, the delivery is terminal
wrong-recipient input: a mediated delivery MUST be pickup-ACKed and MUST create
no `message.in`, contact or response effect.

Input to an eligible retired local key MUST pass through ordinary
decryption, authentication and durable receipt. It does not require renewed
recipient registration. Channel denials and
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
contact or recipient capacity, absence of current-message `please_ack`,
or Trust Ping `response_requested == false`. Ordinary parser/transport limits
and concrete resource exhaustion still apply, without a separate bootstrap
floor or ceiling.

A safely classified hard rejection received through Message Pickup:

- MUST be pickup-ACKed;
- MUST NOT append `message.in`;
- MUST NOT create a contact or response effect; and
- MAY leave only a bounded local diagnostic.

Direct transport has no pickup ACK. Malformed envelope crypto, wrong recipient,
an unsupported sender method, an unknown sender short form without its long
form and hard abuse/resource limits are examples of this gate. Supersession,
invitation and channel
policy are checked after receipt when consuming an invitation or starting new work.
A malformed or invalid string-valued `from_prior` is post-receipt proof evidence,
not malformed envelope crypto. It cannot change the authenticated sender used
for ingress limits or supply predecessor authority.

<a id="integrity-checks-and-durable-receipt"></a>

### 9.3 Integrity checks and durable receipt

Commit the authenticated observation before source-derived work. Validate each
consumer under [operation eligibility](channels.md#operation-eligibility),
including carried proof and current policy where required. Later rotation or
blocking preserves earlier facts; duplicates follow
[the duplicate receipt rules](distributed-delivery.md#duplicate-receipt-handling).

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
is role-independent under section 9; sending and new invitation consumption require a live DID.

Before the first channel package is submitted, its sender MUST durably retain:

- the exact presented peer DID;
- the canonical peer DID;
- the exact RFC 8785 canonical resolved DID document under its raw DASL CID;
- the document's authorized authentication and key-agreement method lists;
- the selected peer key under `peer.resolved.peerPublicKey`; and
- the resolution event ID.

These are immutable operation snapshots, not a permanent channel key set.
The exact envelope identifies the selected recipient `kid`; it must name an
authorized key-agreement method for that selected key in the retained document.
Merely preparing an encrypted
package selects no peer authentication method for a future rotation proof.
Each message or proof records the exact immutable document it used. Recovery
of a saved operation may retrieve missing bytes only when their canonical raw
CID matches its referenced document CID. Another document cannot substitute
for those bytes.

<a id="resolver-security-and-supported-senders"></a>

#### Supported channel endpoints

Both local and remote application channel endpoints MUST use `did:peer:4`.
This includes the predecessor and successor of every continuity link. Public
disclosure does not require a different method or force a pairwise address.
An unsupported current sender fails the receive gate; an unsupported recipient
cannot form a phase-1 outbound intent. An unsupported proof issuer makes that
proof invalid for phase-1 continuity without invalidating an otherwise
authenticated carrier or starting a network lookup.

<a id="recipient-resolution-freshness"></a>

#### Recipient resolution

Resolve the recipient locally from its validated long form or a retained
long form matching its canonical short form. Before preparation, commit or
reuse exact `peer.resolved` evidence matching the selected peer key, presented
DID and local key context. A missing long form leaves preparation pending;
it is not evidence of a key change and starts no network lookup. Each new
package retains its own exact evidence reference. Initial dispatch and manual
retry use the committed package unchanged.

<a id="sender-authentication-freshness"></a>

#### Sender authentication

Every new network delivery, including a duplicate, authenticates its sender
against the validated immutable numalgo-4 document, supplied with the long-form
disclosure or retained locally. Commit or reuse matching exact evidence before
`message.in`. An unknown sender short form without its long form cannot
authenticate and follows the terminal receive gate. This differs from a known
local key/document dependency temporarily unavailable during recovery, which
waits under section 9.1. Recovery of an already committed observation uses its
saved authentication evidence without another network lookup.

<a id="mediator-resolution"></a>

#### Mediator and routing DID resolution

The channel method restriction does not apply to mediator or routing-service
DIDs. A mediator may use `did:web`; resolving it creates no local communication
DID and does not make it an eligible application channel peer. Resolve and
authenticate mediation/control traffic and routing keys under their transport
protocols independently of application channel evidence.

A Web resolver used by a client or mediator MUST be constrained against SSRF,
DNS rebinding, redirects to forbidden networks, unbounded responses and DID
mismatch, with bounded call timeouts. A policy-forbidden fetch is a definitive
failure and MUST NOT fall back to an unrestricted fetch. Preserve the exact
presented Web DID string; its returned document `id` MUST match byte-for-byte.
URL/DNS processing does not authorize case folding, percent-decoding, IDNA
mapping or trailing-dot normalization of DID identity. Use the document's
authorized key IDs rather than local key-name conventions. A mediator lookup
failure grants no application dispatch authority and does not prove that a
channel peer's immutable key changed. Live prerequisite retries follow section 14.

<a id="resolution-failure-classification"></a>
<a id="inbound-sender-resolution-budget"></a>
<a id="active-time-retention-limits"></a>
<a id="shared-accounting-and-lost-wait-state"></a>
<a id="exhaustion-and-non-resolution-deferral"></a>
<a id="key-changes-without-did-continuation"></a>

#### Deferred mutable channel resolution

Mutable channel document revisions, network failure classification and inbound
sender-resolution accounting belong only to the
[deferred channel extension](did-web-channels.md#candidate-network-resolution-rules).
They are not phase-1 channel requirements.

<a id="evidence-change-retries"></a>

#### Evidence-change retries

For an unopened delivery waiting on local receive prerequisites, retry only
when its missing local material changes and then reapply sender authentication.
For a committed observation, newly available exact evidence schedules continuity
verification or operation recovery without another receipt or pickup. Neither
kind of evidence recovery grants a new automatic dispatch action.

<a id="duplicate-authentication-and-historical-recovery"></a>

#### Duplicate authentication and historical recovery

A new delivery authenticates independently before adding an observation.
Recovery of a saved observation verifies its retained references; it never
replaces them with another receipt or document. Saved `message.fromPriorResolved`
associations let the fold reverify the original JWT without resolving a network
DID or replaying the receive operation.

<a id="predecessor-resolution"></a>

#### Predecessor resolution for DID replacement

After durable receipt and without delaying pickup ACK, first reuse a complete
proof witness for the exact carrier context and compact JWT under
[the continuity fold](channels.md#continuity), if one exists. Each new carrier
still requires its own sender authentication.

Otherwise use maintained library decoding APIs to check the claims that need
no predecessor document: compact JWS syntax, integer `iat`, `sub` equal to the
carrier's exact authenticated `from`, supported and distinct canonical `iss`
and `sub`, and a protected `kid` whose DID portion is byte-identical to `iss`.
Validate any supplied numalgo-4 long form before canonicalizing it. Failure is
invalid proof; decoding supplies no signature or channel authority.

Resolve a long-form issuer locally from its validated encoded document. For a
short-form issuer, use only a locally available long form whose validated hash
derives that short form. Resolution material may be reused across contexts,
but it is not another channel's proof witness: verify this carrier's original
JWT and retain its own source/document association. Do not rewrite the signed
JWT to change DID spellings.

If the issuer is a valid short form and its long form is unavailable, keep the
original carrier and show `pending-proof`. Do not poll the network, expire the
proof into invalidity, or keep the original receive action waiting for that
material. Later arrival of matching local material schedules verification;
it grants no automatic ACK, reply or notification for that historical carrier.
A new independently authenticated live carrier is evaluated separately.

With the committed carrier ID, commit the canonical document object and
`message.fromPriorResolved` naming its CID. The fold checks the original
signature and the document's authorized authentication method. Saving the
document does not assert success; a bad signature or unauthorized key is
invalid. Missing source/endpoint/history references remain pending for their
own reason. Invalid or pending proof never undoes durable receipt or pickup ACK.

Import and recovery use the exact saved document association. Missing object
bytes may be recovered only when their canonical CID matches; another document
cannot substitute. Retained valid witnesses remain usable under the ordinary
context and operation rules, and supply no recovery dispatch authority.

<a id="52-peer-did-numalgo-4-profile"></a>

<a id="peer-did-numalgo-4-profile"></a>

### 10.2 Peer DID numalgo-4 profile

Every local and remote phase-1 channel address is a Peer DID numalgo 4.
Both validated long and canonical short forms name one entity. Canonicalization
validates the long form and uses its derived short form. The retained document
follows [vault-events.md section 4.4](vault-events.md#peer-resolved)'s fixed
long-form representation, including when the presented DID is short. The
encoded document is immutable; changing its keys or bound service produces
another DID. Public and private disclosure use this same method.

First disclosure of any local address uses its long form, whether in OOB or
plaintext `from`. Within each exact channel context, a sender MUST use its long
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
document. Do not mix long and short forms in one package. A current-sender
short form with no known long-form document fails authentication and cannot
authorize new work.

A local producer MUST use the predecessor's exact first-disclosure long form
for `from_prior.iss` and its protected authentication `kid`; `sub` uses the
successor's long form. A receiver also accepts short-form issuer spelling for
verification when matching local long-form material is available; otherwise
the proof stays pending under section 10.1.
A receiver compares predecessor DID spellings and authentication-method IDs
under [vault-events.md section 6.4](vault-events.md#relationship-peertransitioned), using only the method's validated spelling
equivalence and the exact verification document. Exact wire spellings remain retained.
A successor may bind another route or mediation for privacy. Neither changing
transport preference nor choosing another service changes an existing DID.

<a id="early-private-address-policy-and-notifications"></a>

## 11. Early private-address policy and notifications

Public and private addresses use the same channel model. On eligible live
application input, local policy may prefer a fresh private local successor when
the selected local DID was publicly disclosed or is shared with another peer.
It records `did.rotationSelected` with the fixed `fromDidId`/`peerDid`, a UUIDv7
successor, exact source observation and frozen proof. Reuse an existing
decision from that local predecessor anywhere in its verified peer-only
rotation context under [channels.md](channels.md#did-rotationselected). A newly
verified peer replacement does not authorize another successor or notification;
reuse the original decision, frozen proof and notification selection. Group
membership is not a reason to rotate an unrelated channel.

Create or reuse the dedicated notification under
[the built-in operation rules](distributed-delivery.md#built-in-independent-operations),
preserving the decision's source, successor and proof. Existing replies neither
move to the successor nor suppress the notification; historical work requires
manual completion.

<a id="automatic-response-selection"></a>

### 11.1 Independent automatic intents

Eligible live input may independently produce an ACK, Ping response and rotation
notification under [delivery](distributed-delivery.md#built-in-independent-operations).
Optional private allocation or notification failure does not block an otherwise
eligible reply or ACK. Empty, ping-response and Report Problem never trigger
another privacy notification.

<a id="proof-and-ordinary-message-headers"></a>

### 11.2 Proof and ordinary message headers

A newly prepared successor-channel message carries the frozen proof and long
form until exact-successor confirmation. Its `from` equals `from_prior.sub` in
the validated wire spelling. The predecessor authentication method signs the
JWT with fixed rotation `iat`; a message timestamp cannot regenerate it.
A committed package remains byte-identical after confirmation.

<a id="registration-and-submission"></a>

### 11.3 Registration and submission

Verify the new recipient registration before disclosure, then follow
[the send procedure](distributed-delivery.md#send-an-ordinary-message).

<a id="confirmation-and-overlap"></a>

### 11.4 Confirmation and overlap

Use the exact-address, authenticated-peer and local-only/join context checks in
[channels.md](channels.md#continuity). Input at a predecessor confirms no
successor. An ACK's named message IDs alone confirm no address knowledge.
Its complete authenticated carrier, including a pure ACK, can independently
confirm the exact successor address to which it was sent.
Retain both recipient routes through confirmation; retire a shared resource
only when no other channel or disclosure still needs it.

<a id="peer-address-changes"></a>

## 12. Peer address changes

Retain an independently authenticated successor receipt even when predecessor
evidence is missing. Obtain its proof document under
[predecessor resolution](#predecessor-resolution), then derive links, joins and
supersession under [continuity](channels.md#continuity). Show the resulting
[verification status](channels.md#verification-status). Superseded peer input
remains receivable but cannot start new application work.

<a id="remote-errors-and-integrity-failures"></a>

## 13. Remote errors and integrity failures

A Report Problem is a display diagnostic beside a uniquely correlated outbound
only when its carrier has a complete source witness, the same channel or a
verified role-preserving successor path, and the required protocol thread
correlation. Keep its body available for display. It does not prove submission
failure, retract a link or authorize replay. A normal authenticated observation may
separately prove exact-address knowledge.

Missing source/verification evidence defers attribution; inconsistent evidence exposes
conflict. Do not assign an error to a contact by wire ID or name alone.

<a id="retry-replacement-and-address-rollover"></a>

## 14. Retry, manual resend and address rollover

An initial live action may retry prerequisite resolution/registration before
its first transport call, subject to expiry and these recommended bounds:

```text
minimum prerequisite retry interval = 30 seconds
exponential backoff cap = 21600 seconds
network prerequisite attempt budget per active sequence = 32
```

These network bounds apply to mediation and transport prerequisites, not
phase-1 channel DID or predecessor-proof resolution, which is local. Pickup,
recipient reconciliation and sync may retry normally;
they are not replay of a user message.

Message retries and new sends follow [dispatch authority](channels.md#fixed-outbound-channel):
a manual retry preserves the committed package; selecting a successor channel
requires a new message ID. Neither missing history nor a new send proves that
the original was undelivered. Business idempotency requires a protocol-defined
authenticated operation identity.

<a id="phase-1-execution-and-deferred-replication"></a>

## 15. Phase-1 execution and deferred replication

Phase 1 permits one active executor. Import/restore reconstructs state but
grants no dispatch action for historical intents or automatic responses.
Replicas may later synchronize receipts, proof evidence, local decisions and
contact selections, rebuilding links without
automatically taking over another replica's pending outbox. Multi-executor
automatic reactions require a separately specified coordination policy.

<a id="privacy-abuse-interoperability-and-security"></a>

## 16. Privacy, abuse, interoperability and security

Public/pairwise labels are disclosure policy. Peers receive ordinary DIDComm
messages and no contact or replica ID. Shared addresses can
correlate traffic; fresh pairwise addresses reduce that reuse.

Continuity applies to exact channel contexts and role-preserving paths. It
cannot transfer authority through display membership. Channel receipt never
implies application permission. Resource/parser limits remain in force.
Cross-channel reuse of a peer's wire ID is not deduplicated by this profile;
channel-local processing does not promise exactly-once business execution.
An unconfirmed local successor with a terminal route cannot silently branch or
roll back; explicit new communication is a new channel and new message.

<a id="required-conformance-cases"></a>

## 17. Required conformance cases

Entries marked Deferred preserve their case IDs but are not phase-1 requirements.


<a id="did-identity-and-relationship-birth-rz-1-rz-12"></a>

### DID identity and operation evidence (RZ-1–RZ-12)

1. <a id="rz-1"></a> Peer-DID first disclosure validates its long form, canonical short form, fixed keys and bound route without DNS.
2. <a id="rz-2"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-2).

3. <a id="rz-3"></a> No emitted message uses an Estoc rendezvous request, accept or decline type, or a wire contact ID.
4. <a id="rz-4"></a> Public/public, public/pairwise and pairwise/pairwise pairs use the same channel receipt and operation-evidence rules.

5. <a id="rz-5"></a> Channel identity preserves canonical local/peer roles: C(A,B) differs from C(B,A), and changing either endpoint changes the channel. Contacts and document references do not enter this pair.

6. <a id="rz-6"></a> Validated Peer long/short spellings name one channel endpoint; shared keys, endpoints and labels do not alias distinct DIDs.

7. <a id="rz-7"></a> Opposite first sends use one local/peer pair in each vault and distinct sender/recipient message directions; unsolicited receipt neither consumes an invitation nor creates a contact.

8. <a id="rz-8"></a> Another independently authorized key in the same immutable document preserves sender/recipient/wire-ID identity without creating a contact.

9. <a id="rz-9"></a> A live public channel can carry ordinary content before a reply or private allocation.

10. <a id="rz-10"></a> Offline intent commits its fixed sender/recipient pair without DNS; first preparation resolves, validates and commits the exact peer evidence.

11. <a id="rz-11"></a> Preparation validates the fixed-channel intent and exact immutable recipient document. Long/short spelling cannot create a second document or a union of authorized keys.

12. <a id="rz-12"></a> One local DID with two different peer DIDs has two independent channels without exclusive local-DID ownership.

<a id="address-changes-and-ordinary-replies-rz-13-rz-25"></a>

### Address changes and ordinary replies (RZ-13–RZ-25)

13. <a id="rz-13"></a> A local rotation in C(A0,B0) leaves C(A0,C0) and public disclosure of A0 unchanged.

14. <a id="rz-14"></a> Either endpoint rotation creates another channel; old message and execution identities remain unchanged and graph discovery never merges them.

15. <a id="rz-15"></a> Early privacy uses a normal local channel link, fresh UUIDv7 successor and frozen trigger/proof.

16. <a id="rz-16"></a> A committed successor/local rotation decision survives crash with exact route, keys, JWT, iat and source; its link rebuilds and no notification dispatches automatically on reopen.

17. <a id="rz-17"></a> Missing optional private allocation does not prevent an ordinary public-address reply or a separately eligible invitation consumption.

18. <a id="rz-18"></a> Normal Trust Ping selects ping-response; response_requested false is still received and may get an independent Empty rotation notification.
19. <a id="rz-19"></a> Content-first Basic Message remains its own application message without a rendezvous wrapper.
20. <a id="rz-20"></a> A complete control source may supply authenticated ACK evidence, but creates no contact or recursive privacy notification. Invitation consumption remains a separate decision.

21. <a id="rz-21"></a> Generic pure ACK has no ACK request. ACK, Ping reply and privacy notification use independent intents; the latter two have empty ack arrays.
22. <a id="rz-22"></a> New successor messages carry frozen proof/long form until confirmation; committed packages remain exact after confirmation, including before their first send.

23. <a id="rz-23"></a> Input at the exact successor confirms rotation; input at a predecessor does not. Explicit ACK naming a message remains separate.
24. <a id="rz-24"></a> A local link needs exact predecessor confirmation; no second same-side link is authorized before its predecessor is known by the peer.

25. <a id="rz-25"></a> Both live recipient routes remain during rotation overlap. Shared routes/addresses survive until unrelated users no longer need them.

<a id="peer-continuation-and-integrity-rz-26-rz-35"></a>

### Peer continuation and integrity (RZ-26–RZ-35)

26. <a id="rz-26"></a> Successor proof at different local addresses needs the corresponding complete source/endpoint evidence or a verified join; no contact lookup is required.

27. <a id="rz-27"></a> Complete opposite-side links with one exact predecessor pair justify the diagonal channel in either import order without synthetic observations.

28. <a id="rz-28"></a> Forged proof, wrong sub, unrelated channel context, unauthorized signing key or mismatched predecessor resolution cannot authorize a link.

29. <a id="rz-29"></a> Repeated proof can reuse a complete witness in the same permitted context; its new carrier independently authenticates against the successor's immutable document.

30. <a id="rz-30"></a> Competing same-side successors, authorization cycles and contradictory identity evidence expose conflict without arrival-order winners; equivalent DID spellings do not split that context.

31. <a id="rz-31"></a> Missing required source/endpoint/proof records defer derived continuity while authenticated receipt still commits and pickup-ACKs; UI distinguishes missing proof from missing history. Invitation state is separate and cannot defer an otherwise complete link.

32. <a id="rz-32"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-32).

33. <a id="rz-33"></a> Verified peer supersession refuses new old-peer work through its local-only context, preserves prior receipts and decisions, and leaves unrelated public-DID channels unaffected.

34. <a id="rz-34"></a> A matching invitation.consumed assigns a one-use disclosure to its proof-free source's canonical peer; plain receipt, continuation and pthid alone do not.

35. <a id="rz-35"></a> Same-channel consumption is idempotent; unavailable invitations refuse another consumer and imported incompatible consumers conflict. Crash/erasure never reopen consumption.

<a id="recipient-lifecycle-rz-36-rz-38"></a>

### Recipient lifecycle (RZ-36–RZ-38)

36. <a id="rz-36"></a> A retired local DID permits no new invitation consumption or sending, but retained keys may receive on eligible routes without continuity history.

37. <a id="rz-37"></a> A terminal route or mediation rejects input; temporary missing key/route/recovery prerequisites defer without pickup ACK.
38. <a id="rz-38"></a> Wrong recipient DID or method fragment, authentication-purpose kid and unknown Peer short form are terminal before application state.

<a id="resolution-freshness-and-budgets-rz-39-rz-45"></a>

### Resolution freshness and budgets (RZ-39–RZ-45)

39. <a id="rz-39"></a> Every new delivery, including a duplicate, authenticates its current sender. Recovery of already committed channel evidence does not re-resolve the sender to admit scope.

40. <a id="rz-40"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-40).

41. <a id="rz-41"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-41).

42. <a id="rz-42"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-42).

43. <a id="rz-43"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-43).

44. <a id="rz-44"></a> Recipient preparation uses locally validated long-form evidence; a committed package never replaces its snapshot or channel, even if it has never been sent.

45. <a id="rz-45"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-45).

<a id="completion-contact-policy-and-phase-boundary-rz-46-rz-54"></a>

### Completion, contact policy and phase boundary (RZ-46–RZ-54)

46. <a id="rz-46"></a> Queued, prepared and submitted messages retain their fixed channel after either endpoint rotates; a successor send has a new ID.

47. <a id="rz-47"></a> Submission stops further preparation and retry; missing ACK and duplicate receipt never reopen it.

48. <a id="rz-48"></a> Expiry and bounded prerequisite retries are independent of incoming age and rotation iat; transport retries require manual action.

49. <a id="rz-49"></a> Contact channel selection is independent of invitation consumption; control-only channels need no invented contact.

50. <a id="rz-50"></a> Contact membership changes no invitation consumer, verification evidence, continuation, message identity or ACK authorization.

51. <a id="rz-51"></a> Deleting a contact changes display only; an explicit delete-and-block action writes channel denials without retiring shared resources.

52. <a id="rz-52"></a> A remote problem report needs exact channel/path correlation and readable body; it changes no submission or continuity state.

53. <a id="rz-53"></a> An unconfirmed successor with a terminal route cannot branch or roll back; temporary outage does not invoke this terminal limitation.
54. <a id="rz-54"></a> Phase-1 operation needs no replica-mediation or vault-sync implementation and discloses no replica ID to peers.

<a id="receipt-recovery-and-evidence-fixtures-rz-55-rz-61"></a>

### Receipt recovery, method boundaries and evidence fixtures (RZ-55–RZ-64)

55. <a id="rz-55"></a> Receipt precedes invitation consumption and other concrete source-derived work. Crash retains each committed prefix; only a complete consumption records a consumer, and no prefix dispatches automatically on reopen.

56. <a id="rz-56"></a> Confirmation in an unrelated channel does not permit short-form disclosure or proof omission; validated equivalent predecessor spellings verify against the exact retained method evidence.

57. <a id="rz-57"></a> The phase-1 adapter saves authenticated carriers with the unchanged proof while predecessor evidence is pending or the proof is invalid. Proof verification never delays pickup ACK. Definitive envelope/authentication failures are terminal pre-vault input; recoverable local receive prerequisites still wait. Restore validates local links, and proof-free input alone consumes no invitation.

58. <a id="rz-58"></a> Long/short Peer spellings retain the same canonical document CID and cannot create another document revision by resolver transformation.

59. <a id="rz-59"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-59).

60. <a id="rz-60"></a> Protocol-derived display data retains its exact source channel. A displayed peer name creates no contact and changes no petname; a contact can show several chains but transfers no authority or permission to share information. Body-dependent values disappear when their sources are erased; contact petnames remain independent.

61. <a id="rz-61"></a> Deferred: [mutable channel DID behavior](did-web-channels.md#rz-61).

62. <a id="rz-62"></a> Both channel endpoints and every continuity predecessor use numalgo 4. An unsupported current sender fails the receive gate; an unsupported proof issuer grants no continuity and causes no network fetch while preserving otherwise authenticated receipt. Mediator Web resolution remains available independently.

63. <a id="rz-63"></a> A well-formed short-form proof issuer with no local long form stays pending-proof after durable receipt and pickup ACK. No timer or reopen starts network resolution or turns it invalid. Matching validated material later triggers verification of the saved JWT without another receipt or automatic output. Wrong sub, malformed claims or an inconsistent kid are invalid even when issuer material is missing; an unknown current-sender short form still cannot authenticate receipt.

64. <a id="rz-64"></a> After a local decision (A0,B0) to A1, a valid B0-to-B1 carrier received at A0 reuses that decision through the verified peer-only context. It selects neither A2 nor another notification; new user sends default to C(A1,B1). A local producer uses long-form issuer and kid in its frozen proof; a received short-form issuer can verify with matching local material without rewriting signed bytes.
