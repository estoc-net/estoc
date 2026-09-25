# Estoc channel address and contact policy 1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **phase 1; application-admission and rotation restrictions specified, implementation pending** — ordinary DIDComm channels, discovery and
early private-address allocation for one active writable vault runtime.
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
| Implement address policy | [Discovery](#out-of-band-discovery) → [Select a channel](#ordinary-sending-and-birth-selection) → [Early privacy and notification](#early-private-address-policy-and-notifications) → [Retry and manual resend](#retry-replacement-and-address-rollover) |

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
- [14. Retry and manual resend](#retry-replacement-and-address-rollover)
- [15. Execution and recovery](#execution-and-recovery)
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
when a mediator is used.

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
recipient routes through exact-successor confirmation. Existing messages keep
their fixed channels. A verified endpoint replacement prohibits new sends,
preparation, first dispatch and manual retries on that old endpoint within its
rotation context under [channels.md](channels.md#fixed-outbound-channel).
Key or route retirement independently prevents sending. Old-peer inputs remain
receivable, but cannot gain new admission or start source-derived work after
supersession becomes known, even if sent or received earlier. Retain prior
admitted history and committed operations without granting another dispatch.

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
for receipt when its DID/key mapping is valid and conflict-free and its bound
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

Sender authority comes from authenticated encryption. A separate inner signature
does not establish phase-1 channel authority or replace this authentication.

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
- MAY leave only a bounded local diagnostic, subject to the requirements below.

Direct transport has no pickup ACK. Malformed envelope crypto, wrong recipient,
an unsupported sender method, an unknown sender short form without its long
form and hard abuse/resource limits are examples of this gate. Supersession,
invitation and channel
policy are checked after receipt when consuming an invitation or starting new work.
A malformed or invalid string-valued `from_prior` is post-receipt proof evidence,
not malformed envelope crypto. It cannot change the authenticated sender used
for ingress limits or supply predecessor authority.

For an unknown current-sender short form, the receiver MUST expose a bounded
visible local diagnostic stating that sender material is unavailable and the
delivery was discarded. For terminal wrong-recipient input with no known local
recipient key mapping, it MUST likewise expose a bounded visible local
diagnostic stating that local recipient material is unavailable and the
delivery was discarded. These diagnostics MUST NOT present a claimed sender
as authenticated, assign the failure to a contact or assert that missing
history caused the failure. They neither send a response nor append application
state. Snapshot restore can cause these conditions under
[the restore rules](vault-events.md#restore).

<a id="integrity-checks-and-durable-receipt"></a>

### 9.3 Integrity checks and durable receipt

Commit the authenticated observation before source-derived work. Validate each
consumer under [operation eligibility](channels.md#operation-eligibility),
including durable application admission, carried proof and current policy
where required. Raw observation alone cannot update chat/profile/ACK state. Later rotation or
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
- the resolution event CID.

These are immutable operation snapshots, not a permanent channel key set.
The exact envelope identifies the selected recipient `kid`; it must name an
authorized key-agreement method for that selected key in the retained document.
Merely preparing an encrypted
package selects no peer authentication method for a future rotation proof.
Each receipt or package references the exact immutable document it used. Recovery
of a saved operation may retrieve missing bytes only when their canonical raw
CID matches its referenced document CID. Another document cannot substitute
for those bytes. A carried proof instead derives its issuer document locally
under [predecessor resolution](#predecessor-resolution).

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
saved authentication evidence without authenticating a new delivery.

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

<a id="evidence-change-retries"></a>

#### Evidence-change retries

For an unopened delivery waiting on local receive prerequisites, retry only
when its missing local material changes and then reapply sender authentication.
For a committed observation, newly available exact evidence schedules continuity
verification, admission reconciliation and operation recovery without another
receipt or pickup. Neither kind of evidence recovery grants a new automatic
dispatch action.

<a id="duplicate-authentication-and-historical-recovery"></a>

#### Duplicate authentication and historical recovery

A new delivery authenticates independently before adding an observation.
Recovery of a saved observation verifies its retained references; it never
replaces them with another receipt or document. The fold verifies any original
JWT from the saved carrier and retained immutable issuer material without
replaying the receive operation.

<a id="predecessor-resolution"></a>

#### Predecessor resolution for DID replacement

After durable receipt and without delaying pickup ACK, verify the carrier's
original JWT through [the continuity adapter](channels.md#continuity-integration).
Use the shared package's proof profile and canonical DID binding, including
equivalent issuer/`kid` DID spellings and subject/sender spellings. Preserve
document-independent rejection separately from missing material: malformed
claims, unsupported profile headers and `exp`/`nbf`, or a mismatched canonical
subject are invalid even without an issuer document. `inspectFromPrior` locates
material and already rejects `exp`, `nbf`, non-integer `iat` and invalid
`b64`/`crit` use. It still lacks the document-independent precheck of `alg`,
optional `typ`, canonical equivalence of the DID in `kid` with `iss`, distinct
canonical `sub` and `iss`, and canonical `sub` against the authenticated sender.
Keep that precheck extension in the package, without a second parser in the runtime. Decoding
supplies no signature or channel authority.

Resolve a long-form issuer locally from its validated encoded document using
[the fixed document representation](vault-events.md#peer-resolved). For a
short-form issuer, use a retained method-valid `peer.resolved` document whose
validated long form derives that short form. This immutable material may be
used across contexts, but each carrier independently authenticates its current
sender and verifies its own JWT. Do not rewrite signed bytes to change DID spellings.

If the issuer is a valid short form and no matching retained `peer.resolved`
document is available, keep the original carrier and show `pending-proof`.
Do not poll the network, expire the proof into invalidity, or keep the original
receive action waiting for that material. A later matching `peer.resolved`
schedules verification and admission reconciliation under
[channels.md](channels.md#application-admission); it grants no automatic ACK,
reply or notification for that historical carrier. If the material never
arrives, that carrier remains a pending diagnostic without application admission.
A new independently authenticated live carrier is evaluated separately.

`verifyFromPrior` checks the original signature against the authentication
method in the issuer's own long-form DID, and `bindFromPrior` checks the exact
carrier. The vault appends no verification event.
A bad signature or unauthorized key is invalid. Missing source/endpoint/history
references remain pending for their own reason. Invalid or pending proof never
undoes durable receipt or pickup ACK.

Import and recovery recompute the result from the carrier's retained JWT and
the same immutable material under [proof evidence](channels.md#peer-proof-evidence).
Missing referenced object bytes may be repaired only with matching canonical
bytes. Verification may use a disposable cache under
[local projections](vault-sqlite.md#local-state-and-projections); that cache grants no
authority absent its retained inputs and supplies no recovery dispatch action.

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
form until an admitted complete authenticated observation confirms knowledge of
that exact address under [channels.md](channels.md#continuity). A successor also includes
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
successor's long form. A receiver also accepts short-form issuer spelling when
a retained method-valid `peer.resolved` document matches it under section 10.1.
A long form retained only in other event data does not qualify. Without the
matching document, a proof that passes the checks not requiring it stays pending.
A receiver compares predecessor DID spellings and authentication-method IDs
under [vault-events.md section 6.4](vault-events.md#relationship-peertransitioned), using only the method's validated spelling
equivalence and the exact verification document. Exact wire spellings remain retained.
A successor may bind another route or mediation for privacy. Neither changing
transport preference nor choosing another service changes an existing DID.

<a id="early-private-address-policy-and-notifications"></a>

## 11. Early private-address policy and notifications

Public and private addresses use the same channel model. On eligible live
application input, local policy may prefer a fresh private local successor only
when a valid `did.disclosed` names the selected local DID. Use of a DID in
multiple channels, including channels created by a peer's rotation, does not
trigger this policy. Without such a disclosure, separating a reused address
requires manual rotation.
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
manual completion subject to current source eligibility. A superseded source
peer prevents creation of a missing notification intent. A replaced sender or
peer recipient also prohibits preparation and manual dispatch of an already
committed intent; retaining its history is not permission to send.

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
Its admitted complete authenticated carrier, including a pure ACK, can independently
confirm the exact successor address to which it was sent.
Retain both recipient routes through confirmation; retire a shared resource
only when no other channel or disclosure still needs it.

<a id="peer-address-changes"></a>

## 12. Peer address changes

Retain an independently authenticated successor receipt even when predecessor
evidence is missing. Derive its issuer document under
[predecessor resolution](#predecessor-resolution), then derive links, joins and
supersession under [continuity](channels.md#continuity). Show the resulting
[verification status](channels.md#verification-status). Superseded peer input
remains receivable but cannot acquire new application admission or start new
application work. Preserve previously admitted history and expose unadmitted
old-peer observations as ignored diagnostics under
[application admission](channels.md#application-admission). Ordinary chat,
profile, received ACK/error state and address confirmation require that
admission. Explicit old-address sending and retry are prohibited in the
affected context, without globally disabling a shared DID or deleting its keys.

<a id="remote-errors-and-integrity-failures"></a>

## 13. Remote errors and integrity failures

A Report Problem is a display diagnostic beside a uniquely correlated outbound
only when its carrier is an admitted complete source witness in the same channel
or a verified role-preserving successor channel, with the required protocol thread
correlation. Keep its body available for display. It does not prove submission
failure, retract a link or authorize replay. Its admitted complete carrier may
separately prove exact-address knowledge.

Missing source/verification evidence defers attribution; inconsistent evidence exposes
conflict. Do not assign an error to a contact by wire ID or name alone.

<a id="retry-replacement-and-address-rollover"></a>

## 14. Retry and manual resend

An initial live action may retry prerequisite resolution/registration before
its first transport call, subject to expiry and these recommended bounds:

```text
minimum prerequisite retry interval = 30 seconds
exponential backoff cap = 21600 seconds
network prerequisite attempt budget per active sequence = 32
```

These network bounds apply to mediation and transport prerequisites, not
phase-1 channel DID or predecessor-proof resolution, which is local. Pickup and
recipient reconciliation may retry normally;
they are not replay of a user message.

Message retries and new sends follow [dispatch authority](channels.md#fixed-outbound-channel):
a manual retry preserves the committed package; selecting a successor channel
requires a new message ID. Neither missing history nor a new send proves that
the original was undelivered. Business idempotency requires a protocol-defined
authenticated operation identity.

<a id="execution-and-recovery"></a>

## 15. Execution and recovery

Phase 1 permits one active executor. Import/restore reconstructs state but
grants no dispatch action for historical intents or automatic responses.

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


<a id="did-identity-and-relationship-birth-rz-1-rz-12"></a>

### DID identity and operation evidence (RZ-1–RZ-12)

- <a id="rz-1"></a> **RZ-1.** Peer-DID first disclosure validates its long form, canonical short form, fixed keys and bound route without DNS.
- <a id="rz-3"></a> **RZ-3.** No emitted message uses an Estoc rendezvous request, accept or decline type, or a wire contact ID.
- <a id="rz-4"></a> **RZ-4.** Public/public, public/pairwise and pairwise/pairwise pairs use the same channel receipt and operation-evidence rules.

- <a id="rz-5"></a> **RZ-5.** Channel identity preserves canonical local/peer roles: C(A,B) differs from C(B,A), and changing either endpoint changes the channel. Contacts and document references do not enter this pair.

- <a id="rz-6"></a> **RZ-6.** Validated Peer long/short spellings name one channel endpoint; shared keys, endpoints and labels do not alias distinct DIDs.

- <a id="rz-7"></a> **RZ-7.** Opposite first sends use one local/peer pair in each vault and distinct sender/recipient message directions; unsolicited receipt neither consumes an invitation nor creates a contact.

- <a id="rz-8"></a> **RZ-8.** Another independently authorized key in the same immutable document preserves sender/recipient/wire-ID identity without creating a contact.

- <a id="rz-9"></a> **RZ-9.** A live public channel can carry ordinary content before a reply or private allocation.

- <a id="rz-10"></a> **RZ-10.** Offline intent commits its fixed sender/recipient pair without DNS; first preparation resolves, validates and commits the exact peer evidence.

- <a id="rz-11"></a> **RZ-11.** Preparation validates the fixed-channel intent and exact immutable recipient document. Long/short spelling cannot create a second document or a union of authorized keys.

- <a id="rz-12"></a> **RZ-12.** One local DID with two different peer DIDs has two independent channels without exclusive local-DID ownership.

<a id="address-changes-and-ordinary-replies-rz-13-rz-25"></a>

### Address changes and ordinary replies (RZ-13–RZ-25)

- <a id="rz-13"></a> **RZ-13.** A local rotation in C(A0,B0) leaves C(A0,C0) and public disclosure of A0 unchanged.

- <a id="rz-14"></a> **RZ-14.** Either endpoint rotation creates another channel; old message and execution identities remain unchanged and graph discovery never merges them.

- <a id="rz-15"></a> **RZ-15.** Early privacy uses a normal local channel link, fresh UUIDv7 successor and frozen trigger/proof.

- <a id="rz-16"></a> **RZ-16.** A committed successor/local rotation decision survives crash with exact route, keys, JWT, iat and source; its link rebuilds and no notification dispatches automatically on reopen.

- <a id="rz-17"></a> **RZ-17.** Missing optional private allocation does not prevent an ordinary public-address reply or a separately eligible invitation consumption.

- <a id="rz-18"></a> **RZ-18.** Normal Trust Ping selects ping-response; response_requested false is still received and may get an independent Empty rotation notification.
- <a id="rz-19"></a> **RZ-19.** Content-first Basic Message remains its own application message without a rendezvous wrapper.
- <a id="rz-20"></a> **RZ-20.** A complete control source may supply authenticated ACK evidence, but creates no contact or recursive privacy notification. Invitation consumption remains a separate decision.

- <a id="rz-21"></a> **RZ-21.** Generic pure ACK has no ACK request. ACK, Ping reply and privacy notification use independent intents; the latter two have empty ack arrays.
- <a id="rz-22"></a> **RZ-22.** New successor messages carry frozen proof/long form until confirmation; committed packages remain exact after confirmation, including before their first send.

- <a id="rz-23"></a> **RZ-23.** Input at the exact successor confirms rotation; input at a predecessor does not. Explicit ACK naming a message remains separate.
- <a id="rz-24"></a> **RZ-24.** A local link needs exact predecessor confirmation; no second same-side link is authorized before its predecessor is known by the peer.

- <a id="rz-25"></a> **RZ-25.** Both live recipient routes remain during rotation overlap. Shared routes/addresses survive until unrelated users no longer need them.

<a id="peer-continuation-and-integrity-rz-26-rz-35"></a>

### Peer continuation and integrity (RZ-26–RZ-35)

- <a id="rz-26"></a> **RZ-26.** Successor proof at different local addresses needs the corresponding complete source/endpoint evidence or a verified join; no contact lookup is required.

- <a id="rz-27"></a> **RZ-27.** Complete opposite-side links with one exact predecessor pair justify the diagonal channel in either import order without synthetic observations.

- <a id="rz-28"></a> **RZ-28.** Forged proof, wrong sub, unrelated channel context, unauthorized signing key or mismatched predecessor resolution cannot authorize a link.

- <a id="rz-29"></a> **RZ-29.** Every repeated carrier independently authenticates against the successor's immutable document and verifies its original JWT. It may use the same immutable issuer material, but another carrier's authentication or proof result grants it no authority.

- <a id="rz-30"></a> **RZ-30.** Competing same-side successors, authorization cycles and contradictory identity evidence expose conflict without arrival-order winners; equivalent DID spellings do not split that context.

- <a id="rz-31"></a> **RZ-31.** Missing required source/endpoint records or issuer material defer derived continuity while authenticated receipt still commits and pickup-ACKs; UI distinguishes missing proof material from missing history. Invitation state is separate and cannot defer an otherwise complete link.

- <a id="rz-33"></a> **RZ-33.** Verified peer supersession refuses new old-peer application admission and work through its local-only context, prohibits preparation/dispatch to that peer including manual retries, preserves raw receipts and prior admitted history/decisions, and leaves unrelated public-DID contexts unaffected.

- <a id="rz-34"></a> **RZ-34.** A matching invitation.consumed assigns a one-use disclosure to its proof-free source's canonical peer; plain receipt, continuation and pthid alone do not.

- <a id="rz-35"></a> **RZ-35.** Same-channel consumption is idempotent; unavailable invitations refuse another consumer and imported incompatible consumers conflict. Crash/erasure never reopen consumption.

<a id="recipient-lifecycle-rz-36-rz-38"></a>

### Recipient lifecycle (RZ-36–RZ-38)

- <a id="rz-36"></a> **RZ-36.** A retired local DID permits no new invitation consumption or sending, but retained keys may receive on eligible routes without continuity history.

- <a id="rz-37"></a> **RZ-37.** A terminal route or mediation rejects input; temporary missing key/route/recovery prerequisites defer without pickup ACK.
- <a id="rz-38"></a> **RZ-38.** Wrong recipient DID or method fragment, authentication-purpose kid and unknown Peer short form are terminal before application state.

<a id="resolution-freshness-and-budgets-rz-39-rz-45"></a>

### Sender authentication and recipient evidence (RZ-39–RZ-45)

- <a id="rz-39"></a> **RZ-39.** Every new delivery, including a duplicate, authenticates its current sender. Recovery of already committed channel evidence does not re-resolve the sender to admit scope.

- <a id="rz-44"></a> **RZ-44.** Recipient preparation uses locally validated long-form evidence; a committed package never replaces its snapshot or channel, even if it has never been sent.

<a id="completion-contact-policy-and-phase-boundary-rz-46-rz-54"></a>

### Completion, contact policy and phase boundary (RZ-46–RZ-54)

- <a id="rz-46"></a> **RZ-46.** Queued, prepared and submitted messages retain their fixed channel after either endpoint rotates; a successor send has a new ID.

- <a id="rz-47"></a> **RZ-47.** Submission stops further preparation and retry; missing ACK and duplicate receipt never reopen it.

- <a id="rz-48"></a> **RZ-48.** Expiry and bounded prerequisite retries are independent of incoming age and rotation iat; transport retries require manual action.

- <a id="rz-49"></a> **RZ-49.** Contact channel selection is independent of invitation consumption; control-only channels need no invented contact.

- <a id="rz-50"></a> **RZ-50.** Contact membership changes no invitation consumer, verification evidence, continuation, message identity or ACK authorization.

- <a id="rz-51"></a> **RZ-51.** Deleting a contact changes display only; an explicit delete-and-block action writes channel denials without retiring shared resources.

- <a id="rz-52"></a> **RZ-52.** A remote problem report needs exact channel/path correlation and readable body; it changes no submission or continuity state.

- <a id="rz-53"></a> **RZ-53.** An unconfirmed successor with a terminal route cannot branch or roll back; temporary outage does not invoke this terminal limitation.
- <a id="rz-54"></a> **RZ-54.** Recovery reconstructs state for one active executor, grants no dispatch action for historical work and discloses no replica ID to peers.

<a id="receipt-recovery-and-evidence-fixtures-rz-55-rz-61"></a>

### Receipt recovery, method boundaries and evidence fixtures (RZ-55–RZ-64)

- <a id="rz-55"></a> **RZ-55.** Receipt precedes invitation consumption and other concrete source-derived work. Crash retains each committed prefix; only a complete consumption records a consumer, and no prefix dispatches automatically on reopen.

- <a id="rz-56"></a> **RZ-56.** Confirmation in an unrelated channel does not permit short-form disclosure or proof omission; validated equivalent predecessor spellings verify against the exact retained method evidence.

- <a id="rz-57"></a> **RZ-57.** The phase-1 adapter saves authenticated carriers with the unchanged proof while predecessor evidence is pending or the proof is invalid. Proof verification never delays pickup ACK. Definitive envelope/authentication failures are terminal pre-vault input; recoverable local receive prerequisites still wait. Restore validates local links, and proof-free input alone consumes no invitation.

- <a id="rz-58"></a> **RZ-58.** Long/short Peer spellings retain the same canonical document CID and cannot create another document revision by resolver transformation.

- <a id="rz-60"></a> **RZ-60.** Protocol-derived display data retains its exact source channel. A displayed peer name creates no contact and changes no petname; a contact can show several chains but transfers no authority or permission to share information. Body-dependent values disappear when their sources are erased; contact petnames remain independent.

- <a id="rz-62"></a> **RZ-62.** Both channel endpoints and every continuity predecessor use numalgo 4. An unsupported current sender fails the receive gate; an unsupported proof issuer grants no continuity and causes no network fetch while preserving otherwise authenticated receipt. Mediator Web resolution remains available independently.

- <a id="rz-63"></a> **RZ-63.** A well-formed short-form proof issuer with no matching retained peer.resolved document stays pending-proof after durable receipt and pickup ACK, even when its long form appears only in other event data. No timer or reopen starts network resolution or turns it invalid. A matching peer.resolved committed later triggers verification of the saved JWT without another receipt or automatic output. Wrong sub, malformed claims or an inconsistent kid are invalid even when issuer material is missing; an unknown current-sender short form still cannot authenticate receipt.

- <a id="rz-64"></a> **RZ-64.** After a local decision (A0,B0) to A1, a valid B0-to-B1 carrier received at A0 reuses that decision through the verified peer-only context. It selects neither A2 nor another notification; new user sends default to C(A1,B1). A local producer uses long-form issuer and kid in its frozen proof; a received short-form issuer verifies with a matching retained peer.resolved document without rewriting signed bytes.

<a id="disclosure-policy-and-restore-limits"></a>

### Disclosure policy and restore limits (RZ-65–RZ-68)

- <a id="rz-65"></a> **RZ-65.** After confirmed rotations (A0,B0) to A1 and (B0,A1) to B1 from disclosed A0 and B0, eligible application input at undisclosed A1 from B1 selects no further privacy rotation. Input from an unrelated C0 likewise cannot trigger automatic rotation merely by sharing A1; separating that reused address requires manual rotation. A disclosed predecessor still applies the policy independently in unrelated peer contexts, reusing any decision already selected in each context.

- <a id="rz-66"></a> **RZ-66.** A snapshot predating a peer's confirmed successor may lack that successor's long form. A new delivery from its unknown short form follows the terminal receive gate: pickup ACK when mediated, no message.in or response, and a bounded visible local diagnostic that does not authenticate or assign the claimed sender. Waiting or an old-channel send supplies no guaranteed repair; old-address traffic may also trigger a competing rotation as in [RZ-67](#rz-67). A later long-form disclosure can authenticate a new delivery but does not by itself restore missing continuity history or recover the discarded delivery.

- <a id="rz-67"></a> **RZ-67.** A snapshot retains disclosed A0 but predates Alice's (A0,B0) to A1 decision, whose proof Bob has verified. After restoring it, eligible live input from B0 at A0 may select A1' because the earlier decision is absent. A queued message can supply that input even when the snapshot has no prior B0-channel history. Bob retains both valid replacement proofs and exposes the fork as a conflict: no default send head in that context and no authority through its conflicted continuity. Otherwise eligible authenticated receipt still commits and pickup-ACKs, and recorded outcomes remain intact. Phase 1 has no operation to choose a branch or clear the conflict. Communication may be established independently from a fresh local DID without resolving the old context.

- <a id="rz-68"></a> **RZ-68.** A local DID created after a snapshot is absent after restoring that snapshot; the seed alone cannot reconstruct its UUIDv7 entity ID and key names. Once local recipient state is authoritative, a delivery with no known or recoverably pending recipient mapping follows the terminal wrong-recipient gate, with pickup ACK when mediated, no message.in or response, and a bounded visible diagnostic. Reconciliation removes recipient registrations outside the desired set; an unknown registered recipient produces a bounded visible registration/state-mismatch diagnostic without recreating a DID or asserting the cause of the mismatch.
